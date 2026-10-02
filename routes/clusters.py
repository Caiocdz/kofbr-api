import json
import threading
from flask import Blueprint, request, jsonify

from db import get_conn, now, unique_import_filter

clusters_bp = Blueprint("clusters", __name__)

# ---------------------------------------------------------------------------
# Estado dos jobs em memoria.
# _running_job_id: job de analise de padronizacao (dedup)
# _running_bulk_id: job de confirmacao em massa
# ---------------------------------------------------------------------------
_running_job_id = None
_running_bulk_id = None
_job_lock = threading.Lock()
_bulk_lock = threading.Lock()


def _run_dedup_background(job_id, threshold):
    """Funcao executada em thread separada para analise de padronizacao.
    Cada thread usa sua propria conexao (pymysql nao e thread-safe por conexao)."""
    global _running_job_id
    conn = get_conn()
    try:
        # Import local para evitar import circular caso dedup importe db
        from dedup import propose_clusters

        rows = conn.execute(
            """SELECT id, centro, linha, equipamento, tipo_parada, subchave_parada,
                      sistema, observacao_normalizada FROM records
               WHERE status = 'pending' AND canonical_failure_id IS NULL"""
        ).fetchall()
        records = [dict(r) for r in rows]

        if not records:
            conn.execute(
                """UPDATE dedup_jobs
                   SET status='done', finished_at=?, registros_analisados=0, propostas_criadas=0
                   WHERE id=?""",
                (now(), job_id),
            )
            conn.commit()
            return

        try:
            conn.execute("DELETE FROM clusters WHERE status = 'pending'")
            proposals = propose_clusters(records, distance_threshold=threshold)

            created = 0
            for p in proposals:
                conn.execute(
                    """INSERT INTO clusters (linha, equipamento, suggested_name,
                       member_record_ids, avg_similarity, status, created_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (
                        p["linha"], p["equipamento"], p["suggested_name"],
                        json.dumps(p["member_record_ids"]), p["avg_similarity"],
                        "pending", now(),
                    ),
                )
                created += 1

            conn.execute(
                """UPDATE dedup_jobs
                   SET status='done', finished_at=?,
                       registros_analisados=?, propostas_criadas=?
                   WHERE id=?""",
                (now(), len(records), created, job_id),
            )
            conn.commit()
        except Exception as exc:
            conn.rollback()
            conn.execute(
                "UPDATE dedup_jobs SET status='error', finished_at=?, erro=? WHERE id=?",
                (now(), str(exc)[:2000], job_id),
            )
            conn.commit()
    finally:
        conn.close()
        with _job_lock:
            _running_job_id = None


@clusters_bp.route("/api/dedup/run", methods=["POST"])
def run_dedup():
    """
    Dispara o motor de padronizacao de falhas em background e retorna imediatamente
    com um job_id para acompanhamento via GET /api/dedup/status/<job_id>.
    Parametros opcionais no body JSON: {"distance_threshold": 0.20}.
    """
    global _running_job_id
    body = request.get_json(silent=True) or {}
    try:
        threshold = float(body.get("distance_threshold", 0.20))
    except (TypeError, ValueError):
        return jsonify({"erro": "distance_threshold deve ser um numero entre 0 e 1"}), 400
    if not 0 <= threshold <= 1:
        return jsonify({"erro": "distance_threshold deve estar entre 0 e 1"}), 400

    with _job_lock:
        if _running_job_id is not None:
            return jsonify({
                "erro": "Ja existe uma analise em andamento",
                "job_id": _running_job_id,
            }), 409

        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO dedup_jobs (status, started_at) VALUES ('running', ?)",
            (now(),),
        )
        job_id = cur.lastrowid
        conn.commit()
        conn.close()

        _running_job_id = job_id

    thread = threading.Thread(
        target=_run_dedup_background, args=(job_id, threshold), daemon=True
    )
    thread.start()

    return jsonify({
        "job_id": job_id,
        "status": "running",
        "acompanhe_em": f"/api/dedup/status/{job_id}",
    }), 202


@clusters_bp.route("/api/dedup/status/<int:job_id>", methods=["GET"])
def dedup_status(job_id):
    """Retorna o status atual de um job de padronizacao."""
    conn = get_conn()
    job = conn.execute("SELECT * FROM dedup_jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    if not job:
        return jsonify({"erro": "Job nao encontrado"}), 404
    return jsonify(dict(job))


# ---------------------------------------------------------------------------
# Listagem de propostas com filtros e paginacao
# ---------------------------------------------------------------------------

@clusters_bp.route("/api/clusters", methods=["GET"])
def list_clusters():
    """Lista propostas de agrupamento com paginacao e filtros.

    Query params:
      status      — 'pending' (default), 'confirmed' ou 'rejected'
      page        — pagina (1-indexed, default 1)
      limit       — itens por pagina (default 20, max 100)
      linha       — filtro parcial por setor/linha (LIKE %valor%)
      equipamento — filtro parcial por peca/equipamento (LIKE %valor%)

    Retorna:
      { clusters: [...], total: N, page: P, pages: T, limit: L }
    """
    status = request.args.get("status", "pending")
    linha_filtro = (request.args.get("linha") or "").strip()
    equip_filtro = (request.args.get("equipamento") or "").strip()
    try:
        page = max(1, int(request.args.get("page", 1)))
        limit = max(1, min(100, int(request.args.get("limit", 20))))
    except (TypeError, ValueError):
        return jsonify({"erro": "page e limit devem ser inteiros positivos"}), 400

    offset = (page - 1) * limit

    # Monta WHERE dinamicamente com os filtros
    where_parts = ["status = ?"]
    params_count = [status]
    params_data = [status]

    if linha_filtro:
        where_parts.append("linha LIKE ?")
        params_count.append(f"%{linha_filtro}%")
        params_data.append(f"%{linha_filtro}%")

    if equip_filtro:
        where_parts.append("equipamento LIKE ?")
        params_count.append(f"%{equip_filtro}%")
        params_data.append(f"%{equip_filtro}%")

    where_sql = " AND ".join(where_parts)

    conn = get_conn()
    total_row = conn.execute(
        f"SELECT COUNT(*) as cnt FROM clusters WHERE {where_sql}", params_count
    ).fetchone()
    total = int(total_row["cnt"])

    rows = conn.execute(
        f"""SELECT * FROM clusters WHERE {where_sql}
           ORDER BY avg_similarity DESC
           LIMIT ? OFFSET ?""",
        params_data + [limit, offset],
    ).fetchall()
    conn.close()

    clusters = []
    for r in rows:
        d = dict(r)
        d["member_record_ids"] = json.loads(d["member_record_ids"])
        clusters.append(d)

    pages = max(1, (total + limit - 1) // limit)
    return jsonify({
        "clusters": clusters,
        "total": total,
        "page": page,
        "pages": pages,
        "limit": limit,
    })


@clusters_bp.route("/api/clusters/<int:cluster_id>", methods=["GET"])
def get_cluster(cluster_id):
    """Detalhe de uma proposta: mostra todos os registros-membro lado a lado."""
    conn = get_conn()
    cluster = conn.execute("SELECT * FROM clusters WHERE id = ?", (cluster_id,)).fetchone()
    if not cluster:
        conn.close()
        return jsonify({"erro": "Cluster nao encontrado"}), 404

    member_ids = json.loads(cluster["member_record_ids"])
    placeholders = ",".join("?" * len(member_ids))
    members = conn.execute(
        f"""SELECT id, linha, equipamento, turno, ordem, observacao_raw,
            observacao_normalizada, operador, minutos_parada, data_inicio
            FROM records WHERE id IN ({placeholders})""",
        member_ids,
    ).fetchall()
    conn.close()

    d = dict(cluster)
    d["member_record_ids"] = member_ids
    d["members"] = [dict(m) for m in members]
    return jsonify(d)


# ---------------------------------------------------------------------------
# Confirmar cluster individual
# ---------------------------------------------------------------------------

@clusters_bp.route("/api/clusters/<int:cluster_id>/confirm", methods=["POST"])
def confirm_cluster(cluster_id):
    """
    Confirmacao humana individual. Body JSON opcional:
      {
        "canonical_name": "Rolamento Quebrado",
        "record_ids": [12, 15, 19]
      }
    """
    body = request.get_json(silent=True) or {}
    conn = get_conn()
    cur = conn.cursor()

    cluster = cur.execute("SELECT * FROM clusters WHERE id = ?", (cluster_id,)).fetchone()
    if not cluster:
        conn.close()
        return jsonify({"erro": "Cluster nao encontrado"}), 404
    if cluster["status"] != "pending":
        conn.close()
        return jsonify({"erro": f"Cluster ja esta '{cluster['status']}'"}), 409

    all_member_ids = json.loads(cluster["member_record_ids"])

    raw_ids = body.get("record_ids", all_member_ids)
    try:
        record_ids = [int(rid) for rid in raw_ids]
    except (TypeError, ValueError):
        conn.close()
        return jsonify({"erro": "record_ids deve ser uma lista de inteiros"}), 400
    record_ids = [rid for rid in record_ids if rid in all_member_ids]
    if not record_ids:
        conn.close()
        return jsonify({"erro": "Nenhum record_id valido pertence a este cluster"}), 400

    canonical_name = str(body.get("canonical_name") or cluster["suggested_name"]).strip()
    if not canonical_name:
        conn.close()
        return jsonify({"erro": "Informe um nome canônico para confirmar"}), 400
    if len(canonical_name) > 255:
        conn.close()
        return jsonify({"erro": "O nome canônico pode ter no máximo 255 caracteres"}), 400

    try:
        cur.execute(
            "INSERT INTO canonical_failures (nome_canonico, linha, equipamento, created_at) VALUES (?,?,?,?)",
            (canonical_name, cluster["linha"], cluster["equipamento"], now()),
        )
        canonical_id = cur.lastrowid

        placeholders = ",".join("?" * len(record_ids))
        cur.execute(
            f"""UPDATE records SET canonical_failure_id = ?, status = 'confirmed'
                WHERE id IN ({placeholders})""",
            [canonical_id] + record_ids,
        )

        removed_from_other_proposals = 0
        other_clusters = cur.execute(
            "SELECT id, member_record_ids FROM clusters WHERE status = 'pending' AND id <> ?",
            (cluster_id,),
        ).fetchall()
        for other in other_clusters:
            other_ids = json.loads(other["member_record_ids"])
            remaining_ids = [rid for rid in other_ids if rid not in record_ids]
            if len(remaining_ids) == len(other_ids):
                continue
            removed_from_other_proposals += len(other_ids) - len(remaining_ids)
            if len(remaining_ids) < 2:
                cur.execute("DELETE FROM clusters WHERE id = ?", (other["id"],))
            else:
                cur.execute(
                    "UPDATE clusters SET member_record_ids = ? WHERE id = ?",
                    (json.dumps(remaining_ids), other["id"]),
                )

        leftover = [rid for rid in all_member_ids if rid not in record_ids]
        if leftover:
            cur.execute(
                "UPDATE clusters SET member_record_ids = ? WHERE id = ?",
                (json.dumps(leftover), cluster_id),
            )
        else:
            cur.execute(
                "UPDATE clusters SET status = 'confirmed', confirmed_at = ? WHERE id = ?",
                (now(), cluster_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({
        "canonical_failure_id": canonical_id,
        "nome_canonico": canonical_name,
        "registros_confirmados": record_ids,
        "registros_restantes_no_cluster": leftover,
        "registros_removidos_de_outras_propostas": removed_from_other_proposals,
    })


# ---------------------------------------------------------------------------
# Confirmar TUDO em massa (background)
# ---------------------------------------------------------------------------

def _run_confirm_all_background(bulk_job_id):
    """Thread de confirmacao em massa. Confirma todos os clusters 'pending'
    usando o suggested_name de cada um como nome canonico."""
    global _running_bulk_id
    conn = get_conn()
    total_confirmadas = 0
    try:
        clusters = conn.execute(
            "SELECT id, linha, equipamento, suggested_name, member_record_ids FROM clusters WHERE status = 'pending'"
        ).fetchall()

        for cluster in clusters:
            c = dict(cluster)
            member_ids = json.loads(c["member_record_ids"])
            if not member_ids:
                continue
            try:
                conn.execute(
                    "INSERT INTO canonical_failures (nome_canonico, linha, equipamento, created_at) VALUES (?,?,?,?)",
                    (c["suggested_name"], c["linha"], c["equipamento"], now()),
                )
                canonical_id = conn.execute("SELECT LAST_INSERT_ID() as lid").fetchone()["lid"]

                placeholders = ",".join("?" * len(member_ids))
                conn.execute(
                    f"UPDATE records SET canonical_failure_id = ?, status = 'confirmed' WHERE id IN ({placeholders})",
                    [canonical_id] + member_ids,
                )
                conn.execute(
                    "UPDATE clusters SET status = 'confirmed', bulk_job_id = ?, confirmed_at = ? WHERE id = ?",
                    (bulk_job_id, now(), c["id"]),
                )
                conn.commit()
                total_confirmadas += 1
            except Exception:
                conn.rollback()
                # ignora clusters com erro e continua os demais

        conn.execute(
            "UPDATE bulk_confirm_jobs SET status='done', finished_at=?, total_confirmadas=? WHERE id=?",
            (now(), total_confirmadas, bulk_job_id),
        )
        conn.commit()
    except Exception as exc:
        try:
            conn.rollback()
            conn.execute(
                "UPDATE bulk_confirm_jobs SET status='error', finished_at=?, erro=? WHERE id=?",
                (now(), str(exc)[:2000], bulk_job_id),
            )
            conn.commit()
        except Exception:
            pass
    finally:
        conn.close()
        with _bulk_lock:
            _running_bulk_id = None


@clusters_bp.route("/api/clusters/confirm-all", methods=["POST"])
def confirm_all():
    """Confirma todas as propostas pendentes em background.
    Retorna job_id para acompanhamento via GET /api/clusters/confirm-all/status/<job_id>.
    """
    global _running_bulk_id

    with _bulk_lock:
        if _running_bulk_id is not None:
            return jsonify({
                "erro": "Ja existe uma confirmacao em massa em andamento",
                "job_id": _running_bulk_id,
            }), 409

        conn = get_conn()
        # Conta quantas propostas serao confirmadas
        total_row = conn.execute(
            "SELECT COUNT(*) as cnt FROM clusters WHERE status = 'pending'"
        ).fetchone()
        total_pending = int(total_row["cnt"])

        if total_pending == 0:
            conn.close()
            return jsonify({"mensagem": "Nenhuma proposta pendente para confirmar."}), 200

        cur = conn.cursor()
        cur.execute(
            "INSERT INTO bulk_confirm_jobs (status, started_at) VALUES ('running', ?)",
            (now(),),
        )
        bulk_job_id = cur.lastrowid
        conn.commit()
        conn.close()

        _running_bulk_id = bulk_job_id

    thread = threading.Thread(
        target=_run_confirm_all_background, args=(bulk_job_id,), daemon=True
    )
    thread.start()

    return jsonify({
        "job_id": bulk_job_id,
        "total_propostas": total_pending,
        "status": "running",
        "acompanhe_em": f"/api/clusters/confirm-all/status/{bulk_job_id}",
    }), 202


@clusters_bp.route("/api/clusters/confirm-all/status/<int:job_id>", methods=["GET"])
def confirm_all_status(job_id):
    """Retorna o status atual de um job de confirmacao em massa."""
    conn = get_conn()
    job = conn.execute("SELECT * FROM bulk_confirm_jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    if not job:
        return jsonify({"erro": "Job nao encontrado"}), 404
    return jsonify(dict(job))


# ---------------------------------------------------------------------------
# Reverter confirmacao em massa
# ---------------------------------------------------------------------------

@clusters_bp.route("/api/clusters/revert-bulk/<int:bulk_job_id>", methods=["POST"])
def revert_bulk(bulk_job_id):
    """Desfaz um 'confirmar tudo': volta clusters para 'pending',
    remove canonical_failure_id dos registros e deleta os canonical_failures
    criados naquele lote.

    Retorna resumo do que foi revertido.
    """
    conn = get_conn()
    cur = conn.cursor()

    # Verifica se o job existe e foi concluido
    job = conn.execute(
        "SELECT * FROM bulk_confirm_jobs WHERE id = ?", (bulk_job_id,)
    ).fetchone()
    if not job:
        conn.close()
        return jsonify({"erro": "Job de confirmacao em massa nao encontrado"}), 404
    if dict(job)["status"] == "running":
        conn.close()
        return jsonify({"erro": "O job ainda esta em andamento. Aguarde terminar antes de reverter."}), 409

    try:
        # Busca todos os clusters confirmados neste lote
        clusters = cur.execute(
            "SELECT id, member_record_ids, suggested_name FROM clusters WHERE bulk_job_id = ? AND status = 'confirmed'",
            (bulk_job_id,),
        ).fetchall()

        if not clusters:
            conn.close()
            return jsonify({"mensagem": "Nenhum cluster encontrado para este lote.", "revertidos": 0}), 200

        total_registros = 0
        nomes_revertidos = []

        for c in clusters:
            c = dict(c)
            member_ids = json.loads(c["member_record_ids"])
            total_registros += len(member_ids)
            nomes_revertidos.append(c["suggested_name"])

            # Remove canonical_failure_id dos registros
            if member_ids:
                placeholders = ",".join("?" * len(member_ids))
                cur.execute(
                    f"UPDATE records SET canonical_failure_id = NULL, status = 'pending' WHERE id IN ({placeholders})",
                    member_ids,
                )

            # Volta cluster para pending
            cur.execute(
                "UPDATE clusters SET status = 'pending', bulk_job_id = NULL, confirmed_at = NULL WHERE id = ?",
                (c["id"],),
            )

        # Deleta canonical_failures criados via confirm-all (via join com clusters revertidos)
        # Como canonical_failures foram criados um por cluster, buscamos pelos registros que tinham
        # canonical_failure_id e agora foram resetados. Usamos abordagem direta: deleta
        # canonical_failures sem registros vinculados (orfaos).
        cur.execute(
            """DELETE cf FROM canonical_failures cf
               LEFT JOIN records r ON r.canonical_failure_id = cf.id
               WHERE r.id IS NULL"""
        )

        # Marca o job como revertido (usa 'error' como sinalizador de revertido
        # para nao reutilizar este job_id; ou simplesmente deletamos)
        cur.execute("DELETE FROM bulk_confirm_jobs WHERE id = ?", (bulk_job_id,))

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({
        "mensagem": f"Lote #{bulk_job_id} revertido com sucesso.",
        "clusters_revertidos": len(clusters),
        "registros_liberados": total_registros,
        "falhas_revertidas": nomes_revertidos[:50],  # primeiros 50 para nao explodir a resposta
    })


# ---------------------------------------------------------------------------
# Rejeitar cluster individual
# ---------------------------------------------------------------------------

@clusters_bp.route("/api/clusters/<int:cluster_id>/reject", methods=["POST"])
def reject_cluster(cluster_id):
    """Rejeita a proposta inteira (falso positivo). Os registros voltam a ficar
    'pending' individualmente, sem canonical_failure."""
    conn = get_conn()
    cur = conn.cursor()
    cluster = cur.execute("SELECT * FROM clusters WHERE id = ?", (cluster_id,)).fetchone()
    if not cluster:
        conn.close()
        return jsonify({"erro": "Cluster nao encontrado"}), 404

    cur.execute("UPDATE clusters SET status = 'rejected' WHERE id = ?", (cluster_id,))
    conn.commit()
    conn.close()
    return jsonify({"mensagem": "Cluster rejeitado. Os registros seguem pendentes individualmente."})


# ---------------------------------------------------------------------------
# Historico de agrupamentos confirmados
# ---------------------------------------------------------------------------

@clusters_bp.route("/api/clusters/<int:cluster_id>/remove-record", methods=["POST"])
def remove_record(cluster_id):
    """Remove um registro individual de um cluster, mantendo o registro 'pending' para futuras análises."""
    body = request.get_json(silent=True) or {}
    record_id = body.get("record_id")
    if not record_id:
        return jsonify({"erro": "Informe o record_id"}), 400

    try:
        record_id = int(record_id)
    except (TypeError, ValueError):
        return jsonify({"erro": "record_id invalido"}), 400

    conn = get_conn()
    cur = conn.cursor()

    cluster = cur.execute("SELECT * FROM clusters WHERE id = ?", (cluster_id,)).fetchone()
    if not cluster:
        conn.close()
        return jsonify({"erro": "Cluster nao encontrado"}), 404
    if cluster["status"] != "pending":
        conn.close()
        return jsonify({"erro": f"Cluster ja esta '{cluster['status']}'"}), 409

    all_member_ids = json.loads(cluster["member_record_ids"])
    if record_id not in all_member_ids:
        conn.close()
        return jsonify({"erro": "Registro nao pertence a este cluster"}), 400

    remaining_ids = [rid for rid in all_member_ids if rid != record_id]

    try:
        if len(remaining_ids) < 2:
            cur.execute("DELETE FROM clusters WHERE id = ?", (cluster_id,))
        else:
            cur.execute(
                "UPDATE clusters SET member_record_ids = ? WHERE id = ?",
                (json.dumps(remaining_ids), cluster_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({
        "mensagem": "Registro removido com sucesso",
        "registros_restantes": remaining_ids
    })


@clusters_bp.route("/api/clusters/history", methods=["GET"])
def clusters_history():
    """Lista agrupamentos ja confirmados (historico).

    Query params:
      page        — pagina (1-indexed, default 1)
      limit       — itens por pagina (default 20, max 100)
      linha       — filtro parcial por setor/linha
      equipamento — filtro parcial por peca/equipamento

    Retorna:
      { clusters: [...], total: N, page: P, pages: T, limit: L }
    Cada item inclui o canonical_name, contagem de registros e data de confirmacao.
    """
    linha_filtro = (request.args.get("linha") or "").strip()
    equip_filtro = (request.args.get("equipamento") or "").strip()
    try:
        page = max(1, int(request.args.get("page", 1)))
        limit = max(1, min(100, int(request.args.get("limit", 20))))
    except (TypeError, ValueError):
        return jsonify({"erro": "page e limit devem ser inteiros positivos"}), 400

    offset = (page - 1) * limit

    canonical_member = f"""EXISTS (
        SELECT 1
        FROM JSON_TABLE(
            c.member_record_ids,
            '$[*]' COLUMNS(record_id BIGINT PATH '$')
        ) AS members
        JOIN records r ON r.id = members.record_id
        WHERE {unique_import_filter('r')}
    )"""
    where_parts = ["c.status = 'confirmed'", canonical_member]
    params_count = []
    params_data = []

    if linha_filtro:
        where_parts.append("c.linha LIKE ?")
        params_count.append(f"%{linha_filtro}%")
        params_data.append(f"%{linha_filtro}%")

    if equip_filtro:
        where_parts.append("c.equipamento LIKE ?")
        params_count.append(f"%{equip_filtro}%")
        params_data.append(f"%{equip_filtro}%")

    where_sql = " AND ".join(where_parts)

    conn = get_conn()
    total_row = conn.execute(
        f"SELECT COUNT(*) as cnt FROM clusters c WHERE {where_sql}", params_count
    ).fetchone()
    total = int(total_row["cnt"])

    rows = conn.execute(
        f"""SELECT c.id, c.linha, c.equipamento, c.suggested_name,
                   c.avg_similarity, c.confirmed_at, c.bulk_job_id,
                   c.member_record_ids
            FROM clusters c
            WHERE {where_sql}
            ORDER BY c.confirmed_at DESC, c.id DESC
            LIMIT ? OFFSET ?""",
        params_data + [limit, offset],
    ).fetchall()
    conn.close()

    clusters = []
    for r in rows:
        d = dict(r)
        ids = json.loads(d["member_record_ids"])
        d["total_registros"] = len(ids)
        d.pop("member_record_ids")  # nao precisamos retornar a lista inteira no historico
        clusters.append(d)

    pages = max(1, (total + limit - 1) // limit)
    return jsonify({
        "clusters": clusters,
        "total": total,
        "page": page,
        "pages": pages,
        "limit": limit,
    })


@clusters_bp.route("/api/history/days", methods=["GET"])
def get_history_days():
    """Agrupa historico confirmado por dia, com filtros opcionais da tela inicial."""
    filters = {
        "centro": "r.centro",
        "turno": "r.turno",
        "linha": "c.linha",
        "tipo_parada": "r.tipo_parada",
    }
    conditions = ["c.status = 'confirmed'", "c.confirmed_at IS NOT NULL", unique_import_filter("r")]
    params = []
    for key, column in filters.items():
        value = (request.args.get(key) or "").strip()
        if value:
            conditions.append(f"TRIM({column}) = %s")
            params.append(value)
    conn = get_conn()
    rows = conn.execute('''
        SELECT DATE(c.confirmed_at) as data_analise, COUNT(DISTINCT c.id) as total_clusters
        FROM clusters c
        JOIN JSON_TABLE(
            c.member_record_ids,
            '$[*]' COLUMNS(record_id BIGINT PATH '$')
        ) AS members
        JOIN records r ON r.id = members.record_id
        WHERE ''' + " AND ".join(conditions) + '''
        GROUP BY DATE(c.confirmed_at)
        ORDER BY data_analise DESC
    ''', params).fetchall()
    conn.close()
    
    result = []
    for r in rows:
        d = r["data_analise"]
        if hasattr(d, "isoformat"):
            d = d.isoformat()
        elif hasattr(d, "strftime"):
            d = d.strftime("%Y-%m-%d")
        else:
            d = str(d)
        result.append({
            "data_analise": d,
            "total_clusters": r["total_clusters"]
        })
    return jsonify(result)

@clusters_bp.route("/api/history/filters", methods=["GET"])
def get_history_filters():
    """Retorna os valores unicos para preencher os dropdowns do historico de uma data."""
    date_str = request.args.get("date")
    if not date_str:
        return jsonify({"erro": "Data nao fornecida"}), 400
        
    conn = get_conn()
    rows = conn.execute('''
        SELECT DISTINCT c.linha, c.equipamento, r.tipo_parada, r.turno
        FROM clusters c
        JOIN JSON_TABLE(
            c.member_record_ids,
            '$[*]' COLUMNS(record_id BIGINT PATH '$')
        ) AS members
        JOIN records r ON r.id = members.record_id
        WHERE c.status = 'confirmed' AND DATE(c.confirmed_at) = %s
          AND ''' + unique_import_filter("r") + '''
    ''', (date_str,)).fetchall()
    conn.close()
    
    linhas = sorted({r["linha"] for r in rows if r["linha"]})
    equipamentos = sorted({r["equipamento"] for r in rows if r["equipamento"]})
    tipos = sorted({r["tipo_parada"] for r in rows if r["tipo_parada"]})
    turnos = sorted({r["turno"] for r in rows if r["turno"]})
    
    return jsonify({
        "linhas": linhas,
        "equipamentos": equipamentos,
        "erros": tipos,
        "turnos": turnos
    })


@clusters_bp.route("/api/history/by-date", methods=["GET"])
def get_history_by_date():
    """Retorna os clusters confirmados em uma data especifica (YYYY-MM-DD), paginado."""
    date_str = request.args.get("date")
    if not date_str:
        return jsonify({"erro": "Data nao fornecida"}), 400
        
    page = int(request.args.get("page", 1))
    limit = int(request.args.get("limit", 20))
    offset = (page - 1) * limit
    
    f_linha = request.args.get("linha")
    f_equip = request.args.get("equipamento")
    f_erro = request.args.get("tipo_parada")
    f_turno = request.args.get("turno")
    
    # Monta a query base com a view/join inline para permitir filtros
    base_query = """
        FROM (
            SELECT c.id, c.linha, c.equipamento, c.suggested_name, c.member_record_ids, c.confirmed_at,
                   r.tipo_parada, r.turno
            FROM clusters c
            LEFT JOIN records r ON r.id = JSON_EXTRACT(c.member_record_ids, '$[0]')
            WHERE c.status = 'confirmed' AND DATE(c.confirmed_at) = %s
              AND EXISTS (
                  SELECT 1
                  FROM JSON_TABLE(
                      c.member_record_ids,
                      '$[*]' COLUMNS(record_id BIGINT PATH '$')
                  ) AS canonical_members
                  JOIN records canonical_records ON canonical_records.id = canonical_members.record_id
                  WHERE ''' + unique_import_filter("canonical_records") + '''
              )
        ) as t
        WHERE 1=1
    """
    params = [date_str]
    
    if f_linha:
        base_query += " AND t.linha = %s"
        params.append(f_linha)
    if f_equip:
        base_query += " AND t.equipamento = %s"
        params.append(f_equip)
    if f_erro:
        base_query += " AND t.tipo_parada = %s"
        params.append(f_erro)
    if f_turno:
        base_query += " AND t.turno = %s"
        params.append(f_turno)
        
    conn = get_conn()
    
    count_row = conn.execute("SELECT COUNT(*) as total " + base_query, params).fetchone()
    total = count_row["total"]
    
    query = "SELECT * " + base_query + " ORDER BY t.confirmed_at DESC LIMIT %s OFFSET %s"
    rows = conn.execute(query, params + [limit, offset]).fetchall()
    conn.close()
    
    result = []
    for r in rows:
        d = dict(r)
        if d.get("confirmed_at") and hasattr(d["confirmed_at"], "isoformat"):
            d["confirmed_at"] = d["confirmed_at"].isoformat()
        elif d.get("confirmed_at") and hasattr(d["confirmed_at"], "strftime"):
            d["confirmed_at"] = d["confirmed_at"].strftime("%Y-%m-%d %H:%M:%S")
        
        try:
            m = json.loads(d["member_record_ids"])
            d["total_registros"] = len(m)
        except:
            d["total_registros"] = 0
        del d["member_record_ids"]
        result.append(d)
        
    return jsonify({
        "clusters": result,
        "total": total,
        "page": page,
        "pages": (total + limit - 1) // limit,
        "limit": limit
    })


# ---------------------------------------------------------------------------
# Excluir item do historico (reverter confirmacao individual)
# ---------------------------------------------------------------------------

@clusters_bp.route("/api/clusters/<int:cluster_id>/revert", methods=["POST"])
def revert_cluster(cluster_id):
    """Reverte a confirmacao de um cluster individual, voltando-o para 'pending'.
    Remove o canonical_failure_id dos registros e deleta canonical_failures orfaos.
    """
    conn = get_conn()
    cur = conn.cursor()

    cluster = cur.execute("SELECT * FROM clusters WHERE id = ?", (cluster_id,)).fetchone()
    if not cluster:
        conn.close()
        return jsonify({"erro": "Cluster nao encontrado"}), 404
    if cluster["status"] != "confirmed":
        conn.close()
        return jsonify({"erro": f"Cluster nao esta confirmado (status: '{cluster['status']}')"}), 409

    try:
        member_ids = json.loads(cluster["member_record_ids"])

        # Remove canonical_failure_id dos registros
        if member_ids:
            placeholders = ",".join("?" * len(member_ids))
            cur.execute(
                f"UPDATE records SET canonical_failure_id = NULL, status = 'pending' WHERE id IN ({placeholders})",
                member_ids,
            )

        # Volta cluster para pending
        cur.execute(
            "UPDATE clusters SET status = 'pending', bulk_job_id = NULL, confirmed_at = NULL WHERE id = ?",
            (cluster_id,),
        )

        # Deleta canonical_failures orfaos
        cur.execute(
            """DELETE cf FROM canonical_failures cf
               LEFT JOIN records r ON r.canonical_failure_id = cf.id
               WHERE r.id IS NULL"""
        )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({
        "mensagem": f"Cluster #{cluster_id} revertido com sucesso.",
        "registros_liberados": len(member_ids),
    })


# ---------------------------------------------------------------------------
# Canonical failures
# ---------------------------------------------------------------------------

@clusters_bp.route("/api/canonical-failures", methods=["GET"])
def list_canonical_failures():
    """Lista os modos de falha ja consolidados (taxonomia construida ate agora)."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT cf.*, COUNT(r.id) as total_registros
           FROM canonical_failures cf
           LEFT JOIN records r ON r.canonical_failure_id = cf.id
           GROUP BY cf.id ORDER BY total_registros DESC"""
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])
