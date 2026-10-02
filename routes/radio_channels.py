from flask import Blueprint, request, jsonify
from db import get_conn

radio_bp = Blueprint("radio", __name__)


@radio_bp.route("/api/radio-channels", methods=["GET"])
def list_channels():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM radio_channels ORDER BY linha, turno").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@radio_bp.route("/api/radio-channels", methods=["POST"])
def upsert_channel():
    """
    Cadastra/atualiza o canal de radio de uma linha+turno.
    Body: {"linha": "LINHA003", "turno": "2", "canal": "4"}
    Isso e config, nao dado de producao -- pensado pra ser preenchido uma vez
    pelo time (ou importado de uma tabela oficial, se existir).
    """
    body = request.get_json(silent=True) or {}
    linha, turno, canal = body.get("linha"), body.get("turno"), body.get("canal")
    if not all([linha, turno, canal]):
        return jsonify({"erro": "Informe linha, turno e canal"}), 400

    conn = get_conn()
    conn.execute(
        """INSERT INTO radio_channels (linha, turno, canal) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE canal = VALUES(canal)""",
        (str(linha), str(turno), str(canal)),
    )
    conn.commit()
    conn.close()
    return jsonify({"linha": linha, "turno": turno, "canal": canal})
