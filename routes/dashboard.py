"""Endpoints analíticos: Pareto, Jack-Knife e KPIs do dashboard.

Todos os indicadores usam a tabela ``records``, que é a cópia fiel dos
apontamentos importados da planilha SAP. O filtro opcional ``data_analise``
representa a data de confirmação dos clusters e, por isso, limita o conjunto
aos registros confirmados naquela análise.
"""
from datetime import datetime

from flask import Blueprint, jsonify, request

from analytics import _classify_quadrant
from db import get_conn, unique_import_filter


dashboard_bp = Blueprint("dashboard", __name__)
VALID_SCOPES = {"all", "confirmed", "pending"}


def _median(values):
    values = sorted(values)
    size = len(values)
    if not size:
        return 0
    midpoint = size // 2
    return values[midpoint] if size % 2 else (values[midpoint - 1] + values[midpoint]) / 2


def _dashboard_filters():
    """Valida filtros e retorna a origem SQL única de todos os painéis.

    JSON_TABLE expande apenas os membros dos clusters da data selecionada.
    A implementação anterior usava JSON_CONTAINS para cada par de registro e
    cluster, o que tornava um filtro de dia impraticável com dezenas de milhares
    de clusters.
    """
    data_analise = (request.args.get("data_analise") or "").strip() or None
    data_inicio = (request.args.get("data_inicio") or "").strip() or None
    data_fim = (request.args.get("data_fim") or "").strip() or None
    scope = (request.args.get("status") or "all").strip().lower()
    if scope not in VALID_SCOPES:
        return None, jsonify({"erro": "status deve ser all, confirmed ou pending"}), 400
    if bool(data_inicio) != bool(data_fim) or (data_analise and (data_inicio or data_fim)):
        return None, jsonify({"erro": "Informe data_analise ou o par data_inicio/data_fim"}), 400
    unique_records = unique_import_filter("r")
    if data_analise:
        try:
            datetime.strptime(data_analise, "%Y-%m-%d")
        except ValueError:
            return None, jsonify({"erro": "data_analise deve estar no formato YYYY-MM-DD"}), 400

        # Uma data de análise só existe após confirmação; ``pending`` não faz
        # sentido nessa visão e retornar um erro é mais seguro que um zero ambíguo.
        if scope == "pending":
            return None, jsonify({"erro": "status=pending não pode ser combinado com data_analise"}), 400
        joins = """
            INNER JOIN (
                SELECT DISTINCT members.record_id
                FROM clusters c
                JOIN JSON_TABLE(
                    c.member_record_ids,
                    '$[*]' COLUMNS(record_id BIGINT PATH '$')
                ) AS members
                WHERE c.status = 'confirmed' AND DATE(c.confirmed_at) = ?
            ) AS selected_records ON selected_records.record_id = r.id
        """
        return {
            "joins": joins,
            "where": f"r.status = 'confirmed' AND {unique_records}",
            "params": [data_analise],
            "data_analise": data_analise,
            "scope": "confirmed",
        }, None, None

    if data_inicio and data_fim:
        try:
            start_date = datetime.strptime(data_inicio, "%Y-%m-%d").date()
            end_date = datetime.strptime(data_fim, "%Y-%m-%d").date()
        except ValueError:
            return None, jsonify({"erro": "data_inicio e data_fim devem estar no formato YYYY-MM-DD"}), 400
        if start_date > end_date:
            return None, jsonify({"erro": "data_inicio deve ser anterior ou igual a data_fim"}), 400
        if scope == "pending":
            return None, jsonify({"erro": "status=pending não pode ser combinado com intervalo de análise"}), 400
        joins = """INNER JOIN (
                SELECT DISTINCT members.record_id
                FROM clusters c
                JOIN JSON_TABLE(
                    c.member_record_ids,
                    '$[*]' COLUMNS(record_id BIGINT PATH '$')
                ) AS members
                WHERE c.status = 'confirmed' AND DATE(c.confirmed_at) BETWEEN ? AND ?
            ) AS selected_records ON selected_records.record_id = r.id"""
        return {
            "joins": joins,
            "where": f"r.status = 'confirmed' AND {unique_records}",
            "params": [data_inicio, data_fim],
            "data_analise": None,
            "scope": "confirmed",
        }, None, None

    where = "1=1" if scope == "all" else "r.status = ?"
    where = f"({where}) AND {unique_records}"
    params = [] if scope == "all" else [scope]
    return {
        "joins": "",
        "where": where,
        "params": params,
        "data_analise": None,
        "scope": scope,
    }, None, None


def _source_metadata(filters):
    labels = {
        "all": "Apontamentos importados, considerando uma vez cada conteúdo de planilha",
        "confirmed": "Apontamentos confirmados, sem repetir conteúdo de planilha",
        "pending": "Apontamentos pendentes, sem repetir conteúdo de planilha",
    }

    return {
        "escopo": filters["scope"],
        "descricao": labels[filters["scope"]],
        "data_analise": filters["data_analise"],
    }


@dashboard_bp.route("/api/dashboard/filters", methods=["GET"])
def dashboard_filters():
    """Valores disponíveis nos filtros analíticos, sem duplicar importações."""
    unique_records = unique_import_filter("r")
    conn = get_conn()
    try:
        rows = conn.execute(
            f"""SELECT DISTINCT TRIM(centro) AS unidade, TRIM(linha) AS linha,
                       TRIM(tipo_parada) AS tipo_falha, TRIM(turno) AS turno
                FROM records r
                WHERE {unique_records}"""
        ).fetchall()
    finally:
        conn.close()
    values = [dict(row) for row in rows]
    return jsonify({
        "unidades": sorted({row["unidade"] for row in values if row["unidade"]}, key=str.casefold),
        "linhas": sorted({row["linha"] for row in values if row["linha"]}, key=str.casefold),
        "tipos_falha": sorted({row["tipo_falha"] for row in values if row["tipo_falha"]}, key=str.casefold),
        "turnos": sorted({row["turno"] for row in values if row["turno"]}, key=str.casefold),
    })


def _float(value):
    return float(value or 0)


@dashboard_bp.route("/api/dashboard/pareto", methods=["GET"])
def pareto():
    """Tempo de parada por linha e equipamento, calculado dos records SAP."""
    filters, error, status = _dashboard_filters()
    if error:
        return error, status
    linha = (request.args.get("linha") or "").strip()
    unidade = (request.args.get("centro") or "").strip()
    tipo_falha = (request.args.get("tipo_parada") or "").strip()
    where = filters["where"]
    params = list(filters["params"])
    if linha:
        where += " AND TRIM(r.linha) = ?"
        params.append(linha)
    if unidade:
        where += " AND TRIM(r.centro) = ?"
        params.append(unidade)
    if tipo_falha:
        where += " AND TRIM(r.tipo_parada) = ?"
        params.append(tipo_falha)

    conn = get_conn()
    try:
        rows = conn.execute(
            f"""
            SELECT
                COALESCE(NULLIF(TRIM(r.linha), ''), 'SEM LINHA') AS linha,
                COALESCE(NULLIF(TRIM(r.equipamento), ''), 'SEM EQUIPAMENTO') AS equipamento,
                COUNT(*) AS falhas,
                COALESCE(SUM(r.minutos_parada), 0) AS tempo_min
            FROM records r
            {filters['joins']}
            WHERE {where}
            GROUP BY
                COALESCE(NULLIF(TRIM(r.linha), ''), 'SEM LINHA'),
                COALESCE(NULLIF(TRIM(r.equipamento), ''), 'SEM EQUIPAMENTO')
            ORDER BY tempo_min DESC, linha ASC, equipamento ASC
            """,
            params,
        ).fetchall()
    finally:
        conn.close()

    total_minutes = sum(_float(row["tempo_min"]) for row in rows)
    accumulated = 0.0
    data = []
    for row in rows:
        minutes = round(_float(row["tempo_min"]), 2)
        percentage = round(minutes * 100 / total_minutes, 2) if total_minutes else 0
        accumulated = min(100.0, round(accumulated + percentage, 2))
        data.append({
            "linha": row["linha"],
            "equipamento": row["equipamento"],
            "tempo_min": minutes,
            "falhas": int(row["falhas"] or 0),
            "pct_total": percentage,
            "pct_acumulado": accumulated,
        })
    # Arredondamentos individuais podem deixar 99,99% na última linha.
    if data and total_minutes:
        data[-1]["pct_acumulado"] = 100.0
    return jsonify({
        "fonte": _source_metadata(filters),
        "total_registros": sum(item["falhas"] for item in data),
        "total_minutos_parada": round(total_minutes, 2),
        "dados": data,
    })


@dashboard_bp.route("/api/dashboard/jackknife", methods=["GET"])
def jackknife():
    """Matriz crítico-crônico por equipamento ou por modo de falha."""
    filters, error, status = _dashboard_filters()
    if error:
        return error, status
    linha = (request.args.get("linha") or "").strip()
    equipamento = (request.args.get("equipamento") or "").strip()
    unidade = (request.args.get("centro") or "").strip()
    tipo_falha = (request.args.get("tipo_parada") or "").strip()
    where = filters["where"]
    params = list(filters["params"])
    if unidade:
        where += " AND TRIM(r.centro) = ?"
        params.append(unidade)
    if tipo_falha:
        where += " AND TRIM(r.tipo_parada) = ?"
        params.append(tipo_falha)

    if equipamento:
        query = """
            SELECT
                COALESCE(NULLIF(TRIM(cf.nome_canonico), ''),
                         NULLIF(TRIM(r.observacao_normalizada), ''),
                         'SEM MODO DE FALHA IDENTIFICADO') AS label,
                COUNT(*) AS Q,
                COALESCE(SUM(r.minutos_parada), 0) AS T
            FROM records r
            LEFT JOIN canonical_failures cf ON cf.id = r.canonical_failure_id
        """
        where += " AND TRIM(r.linha) = ? AND TRIM(r.equipamento) = ?"
        params.extend([linha, equipamento])
        group_by = "label"
    else:
        query = """
            SELECT
                COALESCE(NULLIF(TRIM(r.linha), ''), 'SEM LINHA') AS linha,
                COALESCE(NULLIF(TRIM(r.equipamento), ''), 'SEM EQUIPAMENTO') AS label,
                COUNT(*) AS Q,
                COALESCE(SUM(r.minutos_parada), 0) AS T
            FROM records r
        """
        if linha:
            where += " AND TRIM(r.linha) = ?"
            params.append(linha)
        group_by = "linha, label"

    conn = get_conn()
    try:
        rows = conn.execute(
            f"{query} {filters['joins']} WHERE {where} GROUP BY {group_by}", params
        ).fetchall()
    finally:
        conn.close()

    points = []
    for row in rows:
        quantity = int(row["Q"] or 0)
        total = round(_float(row["T"]), 2)
        point = {"T": total, "Q": quantity, "MTTR": round(total / quantity, 2) if quantity else 0}
        if equipamento:
            point["modo_falha"] = row["label"]
        else:
            point["linha"] = row["linha"]
            point["equipamento"] = row["label"]
        points.append(point)

    q_threshold = _median([point["Q"] for point in points])
    mttr_threshold = _median([point["MTTR"] for point in points])
    for point in points:
        point["categoria"] = _classify_quadrant(
            point["Q"], point["MTTR"], q_threshold, mttr_threshold
        )
    points.sort(key=lambda point: (-point["T"], point.get("equipamento", point.get("modo_falha", ""))))

    result = {
        "fonte": _source_metadata(filters),
        "points": points,
        "q_threshold": q_threshold,
        "mttr_threshold": mttr_threshold,
        "nivel": "modo_de_falha" if equipamento else "equipamento",
    }
    if equipamento:
        result.update({"linha": linha, "equipamento": equipamento})
    return jsonify(result)


@dashboard_bp.route("/api/dashboard/summary", methods=["GET"])
def summary():
    """KPIs consistentes com o mesmo conjunto de dados dos dois gráficos."""
    filters, error, status = _dashboard_filters()
    if error:
        return error, status
    conn = get_conn()
    try:
        stats = conn.execute(
            f"""
            SELECT
                COUNT(*) AS total_apontamentos,
                COALESCE(SUM(r.status = 'pending'), 0) AS pendentes,
                COALESCE(SUM(r.status = 'confirmed'), 0) AS confirmados,
                COALESCE(SUM(r.question_flag = 1), 0) AS questionados,
                COUNT(DISTINCT NULLIF(TRIM(r.linha), '')) AS linhas_distintas,
                COUNT(DISTINCT NULLIF(TRIM(r.equipamento), '')) AS equipamentos_distintos,
                COALESCE(SUM(r.minutos_parada), 0) AS total_minutos_parada
            FROM records r
            {filters['joins']}
            WHERE {filters['where']}
            """,
            filters["params"],
        ).fetchone()
        lines = conn.execute(
            f"""
            SELECT DISTINCT TRIM(r.linha) AS linha
            FROM records r
            {filters['joins']}
            WHERE {filters['where']} AND NULLIF(TRIM(r.linha), '') IS NOT NULL
            ORDER BY linha
            """,
            filters["params"],
        ).fetchall()
        if filters["data_analise"]:
            cluster_counts = conn.execute(
                f"""SELECT COUNT(DISTINCT c.id) AS confirmados
                   FROM clusters c
                   JOIN JSON_TABLE(
                       c.member_record_ids,
                       '$[*]' COLUMNS(record_id BIGINT PATH '$')
                   ) AS members
                   JOIN records r ON r.id = members.record_id
                   WHERE c.status = 'confirmed' AND DATE(c.confirmed_at) = ?
                     AND {unique_import_filter('r')}""",
                [filters["data_analise"]],
            ).fetchone()
            clusters_confirmed, clusters_pending, analyzed_days = (
                int(cluster_counts["confirmados"] or 0), 0, 1,
            )
        else:
            cluster_counts = conn.execute(
                f"""SELECT
                    COUNT(DISTINCT CASE WHEN c.status = 'confirmed' THEN c.id END) AS confirmados,
                    COUNT(DISTINCT CASE WHEN c.status = 'pending' THEN c.id END) AS pendentes,
                    COUNT(DISTINCT CASE WHEN c.status = 'confirmed' THEN DATE(c.confirmed_at) END) AS dias
                   FROM clusters c
                   JOIN JSON_TABLE(
                       c.member_record_ids,
                       '$[*]' COLUMNS(record_id BIGINT PATH '$')
                   ) AS members
                   JOIN records r ON r.id = members.record_id
                   WHERE {unique_import_filter('r')}"""
            ).fetchone()
            clusters_confirmed = int(cluster_counts["confirmados"] or 0)
            clusters_pending = int(cluster_counts["pendentes"] or 0)
            analyzed_days = int(cluster_counts["dias"] or 0)
    finally:
        conn.close()

    return jsonify({
        "fonte": _source_metadata(filters),
        "total_apontamentos": int(stats["total_apontamentos"] or 0),
        "pendentes": int(stats["pendentes"] or 0),
        "confirmados": int(stats["confirmados"] or 0),
        "questionados": int(stats["questionados"] or 0),
        "linhas_distintas": int(stats["linhas_distintas"] or 0),
        "equipamentos_distintos": int(stats["equipamentos_distintos"] or 0),
        "total_minutos_parada": round(_float(stats["total_minutos_parada"]), 2),
        "clusters_confirmados": clusters_confirmed,
        "clusters_pendentes": clusters_pending,
        "dias_analisados": analyzed_days,
        "linhas": [row["linha"] for row in lines],
    })
