"""
Camada de acesso ao banco (MySQL, via PyMySQL).

Nota de migracao (vindo do prototipo em SQLite):
- MySQL usa '%s' como placeholder de parametro, SQLite usa '?'. Em vez de
  reescrever toda query em routes/*.py, a conexao devolvida por get_conn()
  e um wrapper fino (_CompatConnection/_CompatCursor) que aceita as MESMAS
  queries com '?' que ja estavam escritas e troca por '%s' por baixo dos
  panos antes de mandar pro driver. Isso significa que os arquivos em
  routes/ NAO precisaram ser reescritos por causa da troca de banco.
- pymysql.cursors.DictCursor ja devolve cada linha como dict (equivalente
  ao sqlite3.Row + row_factory de antes), entao `dict(row)` e `row["campo"]`
  continuam funcionando igual.
- O 'INSERT ... ON CONFLICT ... DO UPDATE' do SQLite (usado em
  radio_channels.py) NAO tem equivalente automatico aqui -- isso foi
  reescrito manualmente pra 'INSERT ... ON DUPLICATE KEY UPDATE', que e a
  sintaxe de upsert do MySQL.

Credenciais vem de variavel de ambiente (nunca hardcoded). Configure antes
de rodar, por exemplo:

    export KOFBR_DB_HOST=localhost
    export KOFBR_DB_PORT=3306
    export KOFBR_DB_USER=root
    export KOFBR_DB_PASSWORD=sua_senha
    export KOFBR_DB_NAME=kofbr

Importante: este arquivo nao foi testado contra um MySQL real no ambiente
onde eu desenvolvi (sem acesso a rede/instalacao local de MySQL). Revisei
a sintaxe manualmente, mas rode o init_db() e teste o fluxo de upload
assim que tiver um MySQL disponivel e me avise se algum erro aparecer.
"""
import os
import re
import json
from datetime import datetime

import pymysql
import pymysql.cursors
from fingerprints import SOURCE_FIELDS, fingerprint_records

# Regex para substituir '?' por '%s' apenas fora de strings SQL literais.
# Captura aspas simples e duplas (sem captura, grupo 0) ou '?' solto (grupo 1).
# Isso evita que um '?' dentro de LIKE 'valor?' seja substituido acidentalmente.
_PLACEHOLDER_RE = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|(\?)")

DB_HOST = os.environ.get("KOFBR_DB_HOST", "localhost")
DB_PORT = int(os.environ.get("KOFBR_DB_PORT", "3306"))
DB_USER = os.environ.get("KOFBR_DB_USER", "root")
DB_PASSWORD = os.environ.get("KOFBR_DB_PASSWORD", "root")
DB_NAME = os.environ.get("KOFBR_DB_NAME", "kofbr")
DB_CONNECT_TIMEOUT = int(os.environ.get("KOFBR_DB_CONNECT_TIMEOUT", "5"))
DB_READ_TIMEOUT = int(os.environ.get("KOFBR_DB_READ_TIMEOUT", "10"))
DB_WRITE_TIMEOUT = int(os.environ.get("KOFBR_DB_WRITE_TIMEOUT", "20"))


class _CompatCursor:
    """Cursor que aceita queries escritas com '?' (estilo SQLite) e traduz
    pra '%s' (estilo MySQL/PyMySQL) antes de executar."""

    def __init__(self, real_cursor):
        self._cursor = real_cursor

    def execute(self, query, params=None):
        query = _PLACEHOLDER_RE.sub(lambda m: "%s" if m.group(1) else m.group(0), query)
        self._cursor.execute(query, params or ())
        return self

    def executemany(self, query, seq_of_params):
        query = _PLACEHOLDER_RE.sub(lambda m: "%s" if m.group(1) else m.group(0), query)
        self._cursor.executemany(query, seq_of_params)
        return self

    def fetchone(self):
        return self._cursor.fetchone()

    def fetchall(self):
        return self._cursor.fetchall()

    @property
    def lastrowid(self):
        return self._cursor.lastrowid

    def close(self):
        self._cursor.close()


class _CompatConnection:
    """Wrapper sobre pymysql.Connection que imita o atalho
    `sqlite3.Connection.execute(...)` usado em varias rotas (upload.py,
    clusters.py, records.py, dashboard.py, radio_channels.py)."""

    def __init__(self, real_conn):
        self._conn = real_conn

    def cursor(self):
        return _CompatCursor(self._conn.cursor())

    def execute(self, query, params=None):
        cur = self.cursor()
        cur.execute(query, params)
        return cur

    def executescript(self, script):
        # usado so por init_db (nao e mais chamado depois da migracao,
        # mantido por compatibilidade caso algo ainda dependa dele)
        with self._conn.cursor() as cur:
            for statement in script.split(";"):
                statement = statement.strip()
                if statement:
                    cur.execute(statement)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()


def get_conn():
    real_conn = pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
        connect_timeout=DB_CONNECT_TIMEOUT,
        read_timeout=DB_READ_TIMEOUT,
        write_timeout=DB_WRITE_TIMEOUT,
    )
    return _CompatConnection(real_conn)


def unique_import_filter(alias="r"):
    """SQL condition that keeps one earliest batch per source-content fingerprint."""
    return f"""(
        {alias}.upload_batch_id IS NULL
        OR {alias}.upload_batch_id IN (
            SELECT MIN(id) FROM upload_batches
            WHERE content_hash IS NOT NULL
            GROUP BY content_hash
        )
        OR {alias}.upload_batch_id IN (
            SELECT id FROM upload_batches WHERE content_hash IS NULL
        )
    )"""


# Uma instrucao DDL por item da lista -- MySQL nao tem um "executescript"
# nativo confiavel via PyMySQL, entao executamos uma de cada vez, na ordem
# certa (upload_batches e canonical_failures antes de records, por causa
# das foreign keys).
SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS upload_batches (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        filename        VARCHAR(255) NOT NULL,
        file_hash       VARCHAR(32),
        content_hash    CHAR(64),
        total_records   INT NOT NULL DEFAULT 0,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_upload_content_hash (content_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS canonical_failures (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        nome_canonico   VARCHAR(255) NOT NULL,
        linha           VARCHAR(100),
        equipamento     VARCHAR(255),
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_canonical_linha_equip (linha, equipamento)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS records (
        id                      INT AUTO_INCREMENT PRIMARY KEY,
        centro                  VARCHAR(100),
        data_inicio             DATETIME,
        linha                   VARCHAR(100),
        tipo_parada             VARCHAR(100),
        material                VARCHAR(100),
        ordem                   VARCHAR(50),
        descricao_material      VARCHAR(255),
        turno                   VARCHAR(20),
        intervalo               VARCHAR(50),
        equipamento             VARCHAR(255),
        subchave_parada         VARCHAR(255),
        sistema                 VARCHAR(255),
        observacao_raw          TEXT,
        observacao_normalizada  TEXT,
        operador                VARCHAR(150),
        canonical_failure_id    INT,
        pts_efic_perdidos       DECIMAL(12,2),
        pts_acumulados          DECIMAL(12,2),
        caixas_produzidas       DECIMAL(12,2),
        total_minutos           DECIMAL(12,2),
        minutos_parada          DECIMAL(12,2),
        status                  ENUM('pending', 'confirmed') NOT NULL DEFAULT 'pending',
        question_flag           TINYINT(1) NOT NULL DEFAULT 0,
        question_note           TEXT,
        upload_batch_id         INT,
        created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_records_canonical FOREIGN KEY (canonical_failure_id)
            REFERENCES canonical_failures(id) ON DELETE SET NULL,
        CONSTRAINT fk_records_batch FOREIGN KEY (upload_batch_id)
            REFERENCES upload_batches(id) ON DELETE SET NULL,
        INDEX idx_records_linha_equip (linha, equipamento),
        INDEX idx_records_status (status),
        INDEX idx_records_canonical (canonical_failure_id),
        INDEX idx_records_question (question_flag),
        INDEX idx_records_data_inicio (data_inicio),
        INDEX idx_records_linha_turno (linha, turno)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS clusters (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        linha               VARCHAR(100),
        equipamento         VARCHAR(255),
        suggested_name      VARCHAR(255),
        member_record_ids   JSON NOT NULL,
        avg_similarity      DECIMAL(5,3),
        status              ENUM('pending', 'confirmed', 'rejected') NOT NULL DEFAULT 'pending',
        bulk_job_id         INT,
        confirmed_at        DATETIME,
        created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_clusters_status (status),
        INDEX idx_clusters_linha_equip (linha, equipamento),
        INDEX idx_clusters_bulk_job (bulk_job_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS radio_channels (
        linha   VARCHAR(100) NOT NULL,
        turno   VARCHAR(20) NOT NULL,
        canal   VARCHAR(20) NOT NULL,
        PRIMARY KEY (linha, turno)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS dedup_jobs (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        status               ENUM('running', 'done', 'error') NOT NULL DEFAULT 'running',
        started_at           DATETIME NOT NULL,
        finished_at          DATETIME,
        registros_analisados INT,
        propostas_criadas    INT,
        erro                 TEXT,
        INDEX idx_dedup_jobs_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS bulk_confirm_jobs (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        status            ENUM('running', 'done', 'error') NOT NULL DEFAULT 'running',
        started_at        DATETIME NOT NULL,
        finished_at       DATETIME,
        total_confirmadas INT,
        erro              TEXT,
        INDEX idx_bulk_confirm_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
]


def init_db():
    """Cria o banco 'kofbr' (se o usuario tiver permissao de CREATE DATABASE)
    e todas as tabelas. Se o DBA ja tiver criado o banco e so liberado
    permissao dentro dele, a criacao do banco abaixo simplesmente e ignorada
    (IF NOT EXISTS) e segue pra criar as tabelas."""
    admin_conn = pymysql.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD,
        charset="utf8mb4",
        connect_timeout=DB_CONNECT_TIMEOUT,
        read_timeout=DB_READ_TIMEOUT,
        write_timeout=DB_WRITE_TIMEOUT,
    )
    try:
        with admin_conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS {DB_NAME} "
                f"CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        admin_conn.commit()
    finally:
        admin_conn.close()

    conn = get_conn()
    try:
        cur = conn.cursor()
        for statement in SCHEMA_STATEMENTS:
            cur.execute(statement)
        # Migracao segura: adiciona colunas novas em bancos ja existentes.
        # ALTER TABLE ... ADD COLUMN IF NOT EXISTS nao existe em MySQL < 8.0,
        # entao verificamos via INFORMATION_SCHEMA antes de alterar.
        _safe_add_column(cur, "clusters", "bulk_job_id",
                         "INT DEFAULT NULL AFTER avg_similarity")
        _safe_add_column(cur, "clusters", "confirmed_at",
                         "DATETIME DEFAULT NULL AFTER bulk_job_id")
        _safe_add_column(cur, "upload_batches", "file_hash",
                         "VARCHAR(32) DEFAULT NULL AFTER filename")
        _safe_add_column(cur, "upload_batches", "content_hash",
                         "CHAR(64) DEFAULT NULL AFTER file_hash")
        _safe_add_index(cur, "upload_batches", "idx_upload_content_hash", "content_hash")
        _backfill_upload_content_hashes(conn)
        conn.commit()
    finally:
        conn.close()


def _safe_add_column(cur, table, column, definition):
    """Adiciona uma coluna em uma tabela somente se ela ainda nao existe.
    Compativel com MySQL 5.7+ (que nao tem ALTER TABLE ... IF NOT EXISTS)."""
    cur.execute(
        """
        SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND COLUMN_NAME = %s
        """,
        (DB_NAME, table, column),
    )
    row = cur.fetchone()
    # DictCursor devolve dict; cursor raw devolve tuple -- compatibiliza:
    exists = row["cnt"] if isinstance(row, dict) else row[0]
    if not exists:
        cur.execute(f"ALTER TABLE `{table}` ADD COLUMN `{column}` {definition}")


def _safe_add_index(cur, table, index, columns):
    cur.execute(
        """
        SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND INDEX_NAME = %s
        """,
        (DB_NAME, table, index),
    )
    row = cur.fetchone()
    exists = row["cnt"] if isinstance(row, dict) else row[0]
    if not exists:
        cur.execute(f"ALTER TABLE `{table}` ADD INDEX `{index}` (`{columns}`)")


def _backfill_upload_content_hashes(conn):
    """Fingerprint legacy batches once, without removing or rewriting any records."""
    columns = ", ".join(SOURCE_FIELDS)
    batches = conn.execute(
        "SELECT id FROM upload_batches WHERE content_hash IS NULL ORDER BY id"
    ).fetchall()
    for batch in batches:
        records = conn.execute(
            f"SELECT {columns} FROM records WHERE upload_batch_id = ? ORDER BY id",
            (batch["id"],),
        ).fetchall()
        if not records:
            continue
        content_hash = fingerprint_records(records)
        conn.execute(
            "UPDATE upload_batches SET content_hash = ? WHERE id = ?",
            (content_hash, batch["id"]),
        )


def now():
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


if __name__ == "__main__":
    init_db()
    print(f"Banco '{DB_NAME}' inicializado em {DB_HOST}:{DB_PORT}")
