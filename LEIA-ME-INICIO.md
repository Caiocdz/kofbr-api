# Como iniciar

1. Extraia o ZIP inteiro.
2. Deixe o **MySQL** ligado. O sistema usa `localhost:3306`, usuário `root`, senha `root`, banco `kofbr`
   (o banco e as tabelas são criados sozinhos). Para mudar, edite o arquivo **.env** desta pasta.
3. No Windows, execute **iniciar.bat**.
4. Abra **http://127.0.0.1:5000** se o navegador não abrir sozinho.

É necessário Python 3.10 ou superior. Na primeira execução, o script instala as dependências. A interface já está compilada: não precisa de Node.js para usar esta entrega.

Pelo terminal:

```bash
python -m pip install -r requirements.txt
python run.py
```

Todo o histórico fica no MySQL. Se você usava a versão anterior (histórico em `data/radar.sqlite3`), rode uma vez
`python migrar_sqlite_para_mysql.py` para levar tudo para o MySQL. Detalhes no README.md.
