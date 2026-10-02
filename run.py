"""Abre o site e serve a interface pronta junto com a API Python."""
import os
import threading
import webbrowser
from pathlib import Path


def main():
    from app import create_app
    from waitress import serve
    if not (Path(__file__).parent / 'frontend' / 'out' / 'index.html').exists():
        raise SystemExit('Interface não compilada. Execute: cd frontend && npm ci && npm run build')
    app = create_app()
    # Aprendizado: carrega o modelo salvo e retreina em segundo plano com o histórico validado.
    from workflow import learning, service
    learning.load()
    learning.retrain_in_background(service.training_rows, delay=1.0)
    host = os.environ.get('KOFBR_HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', '5000'))
    url = f'http://127.0.0.1:{port}'
    print(f'Gargalo disponível em {url}\nMantenha este terminal aberto. Ctrl+C para encerrar.', flush=True)
    if os.environ.get('KOFBR_NO_BROWSER') != '1':
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    serve(app, host=host, port=port, threads=6, max_request_body_size=50*1024*1024)


if __name__ == '__main__':
    main()
