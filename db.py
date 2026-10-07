"""
Conexão com o MySQL (PyMySQL). Todo o sistema grava aqui: não há banco dentro da pasta do projeto.

Configuração (nesta ordem de prioridade):
1. variáveis de ambiente KOFBR_DB_HOST, KOFBR_DB_PORT, KOFBR_DB_USER, KOFBR_DB_PASSWORD, KOFBR_DB_NAME;
2. arquivo `.env` na pasta do projeto (mesmas chaves, uma por linha: CHAVE=valor — veja `.env.example`);
3. padrão: localhost:3306, usuário root, senha root, banco kofbr.

O banco é criado automaticamente na primeira execução (CREATE DATABASE IF NOT EXISTS) com utf8mb4.

As queries da aplicação usam '?' (estilo DB-API qmark); o wrapper _CompatConnection/_CompatCursor troca
por '%s' (estilo do PyMySQL) fora de literais de string antes de mandar ao driver. Linhas voltam como dict
(DictCursor), então `row["campo"]` e `dict(row)` funcionam.
"""
import os
import re
from datetime import datetime
from pathlib import Path

import pymysql
import pymysql.cursors
from fingerprints import SOURCE_FIELDS, fingerprint_records

# Regex para substituir '?' por '%s' apenas fora de strings SQL literais.
# Captura aspas simples e duplas (sem captura, grupo 0) ou '?' solto (grupo 1).
# Isso evita que um '?' dentro de LIKE 'valor?' seja substituido acidentalmente.
_PLACEHOLDER_RE = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|(\?)")

ROOT = Path(__file__).resolve().parent


def _load_env_file():
    """Lê o `.env` do projeto (se existir) sem sobrescrever variáveis já definidas no sistema."""
    path = ROOT / '.env'
    if not path.is_file():
        return
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file()


def settings():
    """Lido a cada conexão: permite trocar o banco por variável de ambiente (usado nos testes)."""
    env = os.environ.get
    return {
        'host': env('KOFBR_DB_HOST', 'localhost'),
        'port': int(env('KOFBR_DB_PORT', '3306')),
        'user': env('KOFBR_DB_USER', 'root'),
        'password': env('KOFBR_DB_PASSWORD', 'root'),
        'database': env('KOFBR_DB_NAME', 'kofbr'),
        'connect_timeout': int(env('KOFBR_DB_CONNECT_TIMEOUT', '5')),
        # Documentos de análise e planilhas originais chegam a dezenas de MB: prazos e pacote generosos.
        'read_timeout': int(env('KOFBR_DB_READ_TIMEOUT', '300')),
        'write_timeout': int(env('KOFBR_DB_WRITE_TIMEOUT', '300')),
    }


def describe():
    cfg = settings()
    return f"{cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['database']}"


MAX_PACKET = 512 * 1024 * 1024


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

    @property
    def rowcount(self):
        return self._cursor.rowcount

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


def _connect(database=True):
    cfg = settings()
    if not database:
        cfg.pop('database')
    return pymysql.connect(
        **cfg,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
        max_allowed_packet=MAX_PACKET,
    )


def get_conn():
    return _CompatConnection(_connect())


def ensure_database():
    """Cria o banco (se o usuário puder) e tenta liberar pacotes grandes no servidor.

    Se o DBA já criou o banco e só deu permissão dentro dele, o CREATE é ignorado/recusado e seguimos."""
    name = settings()['database']
    if not re.fullmatch(r'[A-Za-z0-9_$]+', name):
        raise ValueError('KOFBR_DB_NAME deve ter apenas letras, números, _ ou $.')
    conn = _connect(database=False)
    try:
        with conn.cursor() as cur:
            try:
                cur.execute(f"CREATE DATABASE IF NOT EXISTS `{name}` "
                            "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            except pymysql.err.MySQLError:
                pass
            # O documento de uma planilha grande + o arquivo original passam do padrão do MySQL (16–64 MB).
            cur.execute("SELECT @@GLOBAL.max_allowed_packet AS v")
            if int(cur.fetchone()['v']) < 256 * 1024 * 1024:
                for scope in ('PERSIST', 'GLOBAL'):  # PERSIST (MySQL 8) sobrevive ao reinício do serviço
                    try:
                        cur.execute(f"SET {scope} max_allowed_packet = %s", (256 * 1024 * 1024,))
                        break
                    except pymysql.err.MySQLError:
                        continue  # sem privilégio: planilhas muito grandes podem falhar; ver README
        conn.commit()
    finally:
        conn.close()


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
    """Cria o banco e as tabelas do fluxo antigo (/api/upload, /api/clusters...)."""
    ensure_database()
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
        (settings()["database"], table, column),
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
        (settings()["database"], table, index),
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
    from workflow import store
    store.initialize()
    print(f"Banco inicializado: {describe()}")
