from flask import Blueprint, request, jsonify

from db import get_conn, now

records_bp = Blueprint("records", __name__)


@records_bp.route("/api/records", methods=["GET"])
def list_records():
    """Lista registros com filtros basicos (linha, equipamento, status)."""
    conn = get_conn()
    query = "SELECT * FROM records WHERE 1=1"
    params = []
    for field in ("linha", "equipamento", "status", "turno"):
        val = request.args.get(field)
        if val:
            query += f" AND {field} = ?"
            params.append(val)
    query += " ORDER BY id DESC LIMIT ?"
    params.append(int(request.args.get("limit", 100)))

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@records_bp.route("/api/records/<int:record_id>", methods=["GET"])
def get_record(record_id):
    """
    Detalhe de um registro, incluindo:
    - quem inseriu (campo 'operador', quando a exportacao do SAP traz essa
      coluna -- no arquivo de exemplo do time da Tais essa coluna NAO vem,
      entao o campo pode retornar null; ver observacao no README)
    - canal de radio sugerido pra linha/turno daquele registro
    """
    conn = get_conn()
    rec = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
    if not rec:
        conn.close()
        return jsonify({"erro": "Registro nao encontrado"}), 404

    canal = conn.execute(
        "SELECT canal FROM radio_channels WHERE linha = ? AND turno = ?",
        (rec["linha"], rec["turno"]),
    ).fetchone()
    conn.close()

    d = dict(rec)
    d["canal_radio_sugerido"] = canal["canal"] if canal else None
    if not rec["operador"]:
        d["aviso_operador"] = (
            "Esta exportacao do SAP nao trouxe identificacao do operador. "
            "Confirmar com a area se o campo existe no SAP e pode ser incluido no relatorio."
        )
    return jsonify(d)


@records_bp.route("/api/records/<int:record_id>/question", methods=["POST"])
def question_record(record_id):
    """
    Botao 'Questionar'. Nao envia nada por radio automaticamente (o time
    disse que quem sintoniza e a pessoa, no radio fisico dela) -- aqui a
    API so registra a duvida e devolve os dados pra pessoa saber com quem
    falar e em qual canal.
    Body JSON opcional: {"nota": "texto da duvida"}
    """
    body = request.get_json(silent=True) or {}
    nota = body.get("nota", "")

    conn = get_conn()
    rec = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
    if not rec:
        conn.close()
        return jsonify({"erro": "Registro nao encontrado"}), 404

    conn.execute(
        "UPDATE records SET question_flag = 1, question_note = ? WHERE id = ?",
        (nota, record_id),
    )
    conn.commit()

    canal = conn.execute(
        "SELECT canal FROM radio_channels WHERE linha = ? AND turno = ?",
        (rec["linha"], rec["turno"]),
    ).fetchone()
    conn.close()

    return jsonify({
        "registro_id": record_id,
        "marcado_como_questionado": True,
        "nota": nota,
        "linha": rec["linha"],
        "turno": rec["turno"],
        "operador": rec["operador"],
        "canal_radio_sugerido": canal["canal"] if canal else "nao cadastrado",
        "instrucao": "Sintonize o canal indicado no radio para falar com o turno responsavel.",
    })


@records_bp.route("/api/records/questioned", methods=["GET"])
def list_questioned():
    """Lista todos os registros marcados como 'questionados', pendentes de resposta."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM records WHERE question_flag = 1 ORDER BY id DESC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])
