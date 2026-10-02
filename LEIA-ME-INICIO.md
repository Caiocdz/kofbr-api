# Como iniciar

1. Extraia o ZIP inteiro.
2. No Windows, execute **iniciar.bat**.
3. Abra **http://127.0.0.1:5000** se o navegador não abrir sozinho.

É necessário Python 3.10 ou superior. Na primeira execução, o script instala as dependências. A interface já está compilada: não precisa de Node.js para usar esta entrega.

Pelo terminal:

```bash
python -m pip install -r requirements.txt
python run.py
```

O histórico é salvo em `data/radar.sqlite3`. Preserve a pasta `data` ao atualizar o projeto. Para conectar o MySQL anterior e migrar seu histórico, consulte o README.md.
