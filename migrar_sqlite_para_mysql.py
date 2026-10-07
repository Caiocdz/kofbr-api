"""Copia o histórico da versão anterior (data/radar.sqlite3) para o MySQL configurado em .env.

Uso:  python migrar_sqlite_para_mysql.py [caminho/do/radar.sqlite3]

- Não altera o arquivo SQLite de origem.
- Pode ser executado mais de uma vez: o que já existe no MySQL (mesmo id) é mantido e não é duplicado.
- Depois de conferir os dados no sistema, o arquivo radar.sqlite3 pode ser apagado ou arquivado.
"""
import sqlite3
import sys
from pathlib import Path

import db
from workflow import store

TABLES = {  # tabela: chave primária
    'radar_analyses': 'id',
    'radar_settings': 'name',
    'radar_ml_examples': 'id',
    'radar_ml_items': 'id',
    'radar_failure_summary': 'id',
}


def migrate(path):
    path = Path(path)
    if not path.is_file():
        raise SystemExit(f'Arquivo não encontrado: {path}')
    store.initialize()
    source = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    source.row_factory = sqlite3.Row
    existing_tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    try:
        for table, key in TABLES.items():
            if table not in existing_tables:
                print(f'{table}: não existe na origem, pulando')
                continue
            with store.connection() as conn:
                present = {r[key] for r in conn.execute(f'SELECT {key} FROM {table}').fetchall()}
            copied = skipped = 0
            cursor = source.execute(f'SELECT * FROM {table}')
            columns = [d[0] for d in cursor.description]
            sql = f'INSERT INTO {table} ({", ".join(columns)}) VALUES ({", ".join(["?"] * len(columns))})'
            batch = []
            for row in cursor:
                if row[key] in present:
                    skipped += 1
                    continue
                batch.append(tuple(row))
                # Análises são grandes (documento + planilha original): uma por transação.
                if len(batch) >= (1 if table == 'radar_analyses' else 2000):
                    _flush(sql, batch)
                    copied += len(batch)
                    batch = []
            if batch:
                _flush(sql, batch)
                copied += len(batch)
            print(f'{table}: {copied} copiados, {skipped} já existiam')
    finally:
        source.close()
    print(f'Migração concluída para {db.describe()}. O arquivo {path.name} não foi alterado.')


def _flush(sql, rows):
    with store.connection() as conn:
        conn.cursor().executemany(sql, rows)


if __name__ == '__main__':
    default = Path(__file__).resolve().parent / 'data' / 'radar.sqlite3'
    migrate(sys.argv[1] if len(sys.argv) > 1 else default)
