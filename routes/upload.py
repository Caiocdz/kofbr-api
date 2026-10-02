import os
import tempfile
import hashlib
from flask import Blueprint, request, jsonify

from db import get_conn, now
from parsing import parse_sap_spreadsheet
from dedup import normalize_observation
from fingerprints import fingerprint_records

upload_bp = Blueprint("upload", __name__)


@upload_bp.route("/api/upload", methods=["POST"])
def upload_spreadsheet():
    """
    Recebe a planilha exportada do SAP (multipart/form-data, campo 'file').
    Faz o parsing, normaliza as observacoes e grava tudo como status='pending'
    (ou seja: ainda NAO passou pela deduplicacao/confirmacao humana).
    """
    if "file" not in request.files:
        return jsonify({"erro": "Envie o arquivo no campo 'file' (multipart/form-data)"}), 400

    f = request.files["file"]
    if f.filename == "":
        return jsonify({"erro": "Nenhum arquivo selecionado"}), 400
    if not f.filename.lower().endswith((".xlsx", ".xlsm")):
        return jsonify({"erro": "Formato invalido. Envie .xlsx ou .xlsm"}), 400

    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        f.save(tmp.name)
        tmp_path = tmp.name

    # Check MD5 hash
    md5_hash = hashlib.md5()
    with open(tmp_path, "rb") as bf:
        for chunk in iter(lambda: bf.read(4096), b""):
            md5_hash.update(chunk)
    file_md5 = md5_hash.hexdigest()

    force = request.form.get("force") == "true" or request.args.get("force") == "true"
    
    conn = get_conn()
    cur = conn.cursor()

    if not force:
        cur.execute("SELECT id FROM upload_batches WHERE file_hash = ?", (file_md5,))
        if cur.fetchone():
            conn.close()
            os.unlink(tmp_path)
            return jsonify({"erro": "DUPLICATE_FILE", "mensagem": "Essa planilha já foi carregada anteriormente."}), 409

    try:
        records, warnings = parse_sap_spreadsheet(tmp_path)
    except Exception as e:
        conn.close()
        os.unlink(tmp_path)
        return jsonify({"erro": f"Falha ao ler a planilha: {e}"}), 400
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    if not records:
        conn.close()
        return jsonify({"erro": "Nenhum registro encontrado na planilha", "avisos": warnings}), 400

    content_hash = fingerprint_records(records)
    if not force:
        duplicate = conn.execute(
            "SELECT id FROM upload_batches WHERE content_hash = ? LIMIT 1",
            (content_hash,),
        ).fetchone()
        if duplicate:
            conn.close()
            return jsonify({
                "erro": "DUPLICATE_CONTENT",
                "mensagem": (
                    "Os mesmos apontamentos já foram importados, mesmo que o arquivo "
                    "tenha outra configuração interna. Deseja continuar mesmo assim?"
                ),
                "lote_existente_id": duplicate["id"],
            }), 409

    cur.execute(
        "INSERT INTO upload_batches (filename, file_hash, content_hash, total_records, created_at) VALUES (?, ?, ?, ?, ?)",
        (f.filename, file_md5, content_hash, len(records), now()),
    )
    batch_id = cur.lastrowid

    inserted = 0
    now_str = now()
    
    params_list = []
    for rec in records:
        obs_norm = normalize_observation(rec.get("observacao_raw") or "")
        params_list.append((
            rec.get("centro"), rec.get("data_inicio"), rec.get("linha"),
            rec.get("tipo_parada"), rec.get("material"), rec.get("ordem"),
            rec.get("descricao_material"), rec.get("turno"), rec.get("intervalo"),
            rec.get("equipamento"), rec.get("subchave_parada"), rec.get("sistema"),
            rec.get("observacao_raw"), obs_norm, rec.get("operador"),
            rec.get("pts_efic_perdidos"), rec.get("pts_acumulados"),
            rec.get("caixas_produzidas"), rec.get("total_minutos"),
            rec.get("minutos_parada"), "pending", batch_id, now_str,
        ))

    if params_list:
        cur.executemany(
            """
            INSERT INTO records (
                centro, data_inicio, linha, tipo_parada, material, ordem,
                descricao_material, turno, intervalo, equipamento,
                subchave_parada, sistema, observacao_raw, observacao_normalizada,
                operador, pts_efic_perdidos, pts_acumulados, caixas_produzidas,
                total_minutos, minutos_parada, status, upload_batch_id, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            params_list
        )
        inserted = len(params_list)

    conn.commit()
    conn.close()

    has_operador = any(r.get("operador") for r in records)

    return jsonify({
        "batch_id": batch_id,
        "arquivo": f.filename,
        "registros_importados": inserted,
        "avisos": warnings,
        "coluna_operador_encontrada": has_operador,
        "proximo_passo": "POST /api/dedup/run para gerar as propostas de agrupamento",
    }), 201


@upload_bp.route("/api/batches", methods=["GET"])
def list_batches():
    """Retorna o historico de planilhas importadas."""
    conn = get_conn()
    rows = conn.execute("SELECT * FROM upload_batches ORDER BY created_at DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

