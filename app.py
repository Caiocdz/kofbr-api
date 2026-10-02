import os

from flask import Flask, jsonify, render_template, send_from_directory
from flask_cors import CORS
import pymysql

from db import get_conn
from workflow.routes import bp as workspace_bp
from workflow import store
from routes.upload import upload_bp
from routes.clusters import clusters_bp
from routes.records import records_bp
from routes.radio_channels import radio_bp
from routes.dashboard import dashboard_bp


def create_app():
    app = Flask(__name__)
    CORS(app, resources={r"/api/*": {"origins": ["http://localhost:3000", "http://127.0.0.1:3000"]}})
    store.initialize()
    app.register_blueprint(workspace_bp)
    app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB, planilhas de apontamento podem ser grandes

    app.register_blueprint(upload_bp)
    app.register_blueprint(clusters_bp)
    app.register_blueprint(records_bp)
    app.register_blueprint(radio_bp)
    app.register_blueprint(dashboard_bp)

    @app.errorhandler(pymysql.err.OperationalError)
    def database_unavailable(error):
        error_code = error.args[0] if error.args else None
        app.logger.warning("Falha operacional no MySQL (código %s)", error_code)
        message = (
            "O MySQL não respondeu dentro do prazo configurado. Verifique o serviço e tente novamente."
            if error_code in {2003, 2006, 2013, 2055}
            else "O MySQL retornou um erro operacional. Verifique a conexão e o schema do banco."
        )
        return jsonify({
            "erro": message,
            "codigo": error_code,
        }), 503

    @app.route("/")
    def index():
        out_dir = os.path.join(app.root_path, "frontend", "out")
        if os.path.isfile(os.path.join(out_dir, "index.html")):
            return send_from_directory(out_dir, "index.html")
        return render_template("index.html")

    @app.errorhandler(413)
    def too_large(error):
        return jsonify(erro="O arquivo excede o limite de 50 MB."), 413

    @app.route("/api/health")
    def health():
        return jsonify({
            "status": "ok",
            "servico": "KOFBR - API de normalizacao de apontamentos de falha",
            "endpoints": {
                "upload": "POST /api/upload",
                "rodar_dedup": "POST /api/dedup/run",
                "listar_clusters": "GET /api/clusters",
                "detalhe_cluster": "GET /api/clusters/<id>",
                "confirmar_cluster": "POST /api/clusters/<id>/confirm",
                "rejeitar_cluster": "POST /api/clusters/<id>/reject",
                "modos_falha_consolidados": "GET /api/canonical-failures",
                "listar_registros": "GET /api/records",
                "detalhe_registro": "GET /api/records/<id>",
                "questionar_registro": "POST /api/records/<id>/question",
                "registros_questionados": "GET /api/records/questioned",
                "canais_radio": "GET/POST /api/radio-channels",
                "pareto": "GET /api/dashboard/pareto",
                "jackknife": "GET /api/dashboard/jackknife",
                "saude_banco": "GET /api/health/db",
            },
        })

    @app.route("/api/health/db")
    def database_health():
        conn = get_conn()
        try:
            conn.execute("SELECT 1 AS ok").fetchone()
        finally:
            conn.close()
        return jsonify({"status": "ok", "banco": "conectado"})

    @app.route("/login")
    def login():
        out_dir = os.path.join(app.root_path, "frontend", "out")
        return send_from_directory(out_dir, "login.html")

    @app.route("/<path:filename>")
    def next_static(filename):
        out_dir = os.path.join(app.root_path, "frontend", "out")
        if os.path.exists(os.path.join(out_dir, filename)):
            return send_from_directory(out_dir, filename)
        return "Not found", 404

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host=os.environ.get("KOFBR_HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)), debug=os.environ.get("FLASK_DEBUG") == "1")
