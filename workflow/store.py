"""Persistência atômica. SQLite local ou o MySQL já configurado no projeto."""
import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


def driver():
    return os.environ.get('KOFBR_WORKFLOW_DB', 'sqlite').lower()


@contextmanager
def connection():
    if driver() == 'mysql':
        from db import get_conn
        conn = get_conn()
    elif driver() == 'sqlite':
        path = Path(os.environ.get('KOFBR_DATA_DIR', Path(__file__).resolve().parents[1] / 'data'))
        path.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path / 'radar.sqlite3', timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA foreign_keys=ON')
    else:
        raise ValueError('KOFBR_WORKFLOW_DB deve ser sqlite ou mysql')
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def initialize():
    with connection() as conn:
        text_type, blob_type = ('LONGTEXT', 'LONGBLOB') if driver() == 'mysql' else ('TEXT', 'BLOB')
        conn.execute(f'''CREATE TABLE IF NOT EXISTS radar_analyses (
            id VARCHAR(36) PRIMARY KEY,
            content_hash VARCHAR(64) NOT NULL UNIQUE,
            revision INTEGER NOT NULL,
            document {text_type} NOT NULL,
            source_file {blob_type},
            created_at VARCHAR(32) NOT NULL
        )''')
        conn.execute(f'''CREATE TABLE IF NOT EXISTS radar_settings (
            name VARCHAR(64) PRIMARY KEY,
            value {text_type} NOT NULL
        )''')
        # Relatos revisados pelo analista na tela "Revisar previsões" (treino do preenchimento por ML).
        conn.execute(f'''CREATE TABLE IF NOT EXISTS radar_ml_examples (
            id VARCHAR(40) PRIMARY KEY,
            relato {text_type} NOT NULL,
            relato_norm {text_type} NOT NULL,
            classe VARCHAR(160) NOT NULL,
            detalhe {text_type},
            origem VARCHAR(255),
            created_at VARCHAR(32) NOT NULL
        )''')
        # Fluxo único: uma linha por relato único de cada análise (previsão do ML + validação humana).
        conn.execute(f'''CREATE TABLE IF NOT EXISTS radar_ml_items (
            id VARCHAR(40) PRIMARY KEY,
            analysis_id VARCHAR(36) NOT NULL,
            relato_norm {text_type} NOT NULL,
            relato {text_type} NOT NULL,
            n_linhas INTEGER NOT NULL,
            minutos DOUBLE PRECISION NOT NULL,
            classe VARCHAR(160) NOT NULL,
            detalhe {text_type},
            confianca DOUBLE PRECISION,
            faixa VARCHAR(16) NOT NULL,
            top3 {text_type},
            status VARCHAR(16) NOT NULL,
            classe_final VARCHAR(160),
            detalhe_final {text_type},
            updated_at VARCHAR(32)
        )''')
        # Passo 4: ocorrências agrupadas por falha (classe validada ou prevista).
        conn.execute('''CREATE TABLE IF NOT EXISTS radar_failure_summary (
            id VARCHAR(40) PRIMARY KEY,
            analysis_id VARCHAR(36) NOT NULL,
            classe VARCHAR(160) NOT NULL,
            linhas INTEGER NOT NULL,
            falhas_reais INTEGER NOT NULL,
            minutos DOUBLE PRECISION NOT NULL,
            mttr DOUBLE PRECISION NOT NULL,
            percentual DOUBLE PRECISION NOT NULL,
            acumulado DOUBLE PRECISION NOT NULL,
            linhas_validadas INTEGER NOT NULL,
            updated_at VARCHAR(32) NOT NULL
        )''')
    for name, table in (('ix_ml_items_analysis', 'radar_ml_items'), ('ix_failure_summary_analysis', 'radar_failure_summary')):
        try:  # MySQL não aceita "IF NOT EXISTS" em índices: se já existir, segue em frente
            with connection() as conn:
                conn.execute(f'CREATE INDEX {name} ON {table} (analysis_id)')
        except Exception:
            pass


def insert(doc, fingerprint, source):
    with connection() as conn:
        existing = conn.execute('SELECT id FROM radar_analyses WHERE content_hash = ?', (fingerprint,)).fetchone()
        if existing:
            return existing['id'], False
        conn.execute('INSERT INTO radar_analyses VALUES (?, ?, ?, ?, ?, ?)',
                     (doc['id'], fingerprint, doc['revision'], json.dumps(doc, ensure_ascii=False), source, doc['created_at']))
    return doc['id'], True


# Documentos do fluxo único chegam a dezenas de MB: ficam em memória por (id, revisão) para não
# reler o JSON a cada requisição. Esses documentos não são alterados depois do upload.
_cache = {}


def _cached(conn, analysis_id, revision):
    hit = _cache.get(analysis_id)
    if hit and hit[0] == revision:
        return hit[1]
    row = conn.execute('SELECT document FROM radar_analyses WHERE id = ?', (analysis_id,)).fetchone()
    doc = json.loads(row['document'])
    if doc.get('mode') == 'ml':
        _cache[analysis_id] = (revision, doc)
    return doc


def all_documents():
    with connection() as conn:
        rows = conn.execute('SELECT id, revision FROM radar_analyses ORDER BY created_at DESC, id').fetchall()
        return [_cached(conn, row['id'], row['revision']) for row in rows]


def get(analysis_id):
    with connection() as conn:
        row = conn.execute('SELECT revision FROM radar_analyses WHERE id = ?', (analysis_id,)).fetchone()
        return _cached(conn, analysis_id, row['revision']) if row else None


def source(analysis_id):
    with connection() as conn:
        row = conn.execute('SELECT source_file FROM radar_analyses WHERE id = ?', (analysis_id,)).fetchone()
    return row['source_file'] if row else None


def save(doc, expected_revision):
    with connection() as conn:
        cur = conn.execute('UPDATE radar_analyses SET document = ?, revision = ? WHERE id = ? AND revision = ?',
                           (json.dumps(doc, ensure_ascii=False), doc['revision'], doc['id'], expected_revision))
        changed = cur.rowcount if hasattr(cur, 'rowcount') else cur._cursor.rowcount
        return changed == 1


def get_setting(name):
    with connection() as conn:
        row = conn.execute('SELECT value FROM radar_settings WHERE name = ?', (name,)).fetchone()
    return json.loads(row['value']) if row else None


def set_setting(name, value):
    payload = json.dumps(value, ensure_ascii=False)
    with connection() as conn:
        if conn.execute('SELECT name FROM radar_settings WHERE name = ?', (name,)).fetchone():
            conn.execute('UPDATE radar_settings SET value = ? WHERE name = ?', (payload, name))
        else:
            conn.execute('INSERT INTO radar_settings VALUES (?, ?)', (name, payload))


def delete_setting(name):
    with connection() as conn:
        conn.execute('DELETE FROM radar_settings WHERE name = ?', (name,))


def ml_examples():
    with connection() as conn:
        rows = conn.execute('SELECT relato, relato_norm, classe, detalhe, origem, created_at FROM radar_ml_examples').fetchall()
    return [dict(row) for row in rows]


def save_ml_examples(items):
    """Grava (ou substitui) a revisão do analista para cada relato."""
    from datetime import datetime
    now = datetime.now().astimezone().isoformat()
    with connection() as conn:
        for item in items:
            key = hashlib.sha1(item['relato_norm'].encode()).hexdigest()
            conn.execute('DELETE FROM radar_ml_examples WHERE id = ?', (key,))
            conn.execute('INSERT INTO radar_ml_examples VALUES (?, ?, ?, ?, ?, ?, ?)',
                         (key, item['relato'], item['relato_norm'], item['classe'], item.get('detalhe') or '',
                          item.get('origem') or '', now))


# ---------- Fluxo único: itens (relatos) e resumo por falha ----------
ITEM_FIELDS = ('relato_norm', 'relato', 'n_linhas', 'minutos', 'classe', 'detalhe', 'confianca', 'faixa', 'top3',
               'status', 'classe_final', 'detalhe_final', 'updated_at')
_ITEM_COLUMNS = ', '.join(ITEM_FIELDS)
# Pendentes primeiro, depois a menor confiança e os relatos com mais linhas na planilha.
_ITEM_ORDER = ("CASE status WHEN 'pendente' THEN 0 ELSE 1 END, "
               "CASE faixa WHEN 'Baixa' THEN 0 WHEN 'Média' THEN 1 WHEN 'Alta' THEN 2 ELSE 3 END, "
               "COALESCE(confianca, 100), n_linhas DESC, relato_norm")


def _item_id(analysis_id, key):
    return hashlib.sha1(f'{analysis_id}|{key}'.encode()).hexdigest()


def _item(row):
    item = dict(row)
    item['top3'] = json.loads(item['top3'] or '[]')
    return item


def insert_ml_items(analysis_id, items):
    placeholders = ', '.join(['?'] * (len(ITEM_FIELDS) + 2))
    rows = [(_item_id(analysis_id, i['relato_norm']), analysis_id,
             *[json.dumps(i[f], ensure_ascii=False) if f == 'top3' else i.get(f) for f in ITEM_FIELDS]) for i in items]
    with connection() as conn:
        conn.cursor().executemany(
            f'INSERT INTO radar_ml_items (id, analysis_id, {_ITEM_COLUMNS}) VALUES ({placeholders})', rows)


def ml_items(analysis_id):
    with connection() as conn:
        rows = conn.execute(f'SELECT {_ITEM_COLUMNS} FROM radar_ml_items WHERE analysis_id = ?', (analysis_id,)).fetchall()
    return [_item(r) for r in rows]


def ml_items_by_keys(analysis_id, keys):
    ids = [_item_id(analysis_id, k) for k in keys]
    out = []
    with connection() as conn:
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            out += conn.execute(f'SELECT {_ITEM_COLUMNS} FROM radar_ml_items WHERE id IN ({", ".join(["?"] * len(chunk))})',
                                chunk).fetchall()
    return [_item(r) for r in out]


def ml_items_page(analysis_id, faixa='', status='', q='', page=1, size=100):
    where, params = ['analysis_id = ?'], [analysis_id]
    if faixa:
        where.append('faixa = ?')
        params.append(faixa)
    if status:
        where.append('status = ?')
        params.append(status)
    if q:
        where.append("(LOWER(relato) LIKE ? OR LOWER(classe) LIKE ? OR LOWER(COALESCE(classe_final, '')) LIKE ?)")
        params += [f'%{q.lower()}%'] * 3
    clause = ' AND '.join(where)
    with connection() as conn:
        total = conn.execute(f'SELECT COUNT(*) AS n FROM radar_ml_items WHERE {clause}', params).fetchone()['n']
        rows = conn.execute(f'SELECT {_ITEM_COLUMNS} FROM radar_ml_items WHERE {clause} ORDER BY {_ITEM_ORDER} '
                            'LIMIT ? OFFSET ?', params + [size, (max(page, 1) - 1) * size]).fetchall()
    return int(total), [_item(r) for r in rows]


def ml_items_progress(analysis_id):
    with connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS relatos, COALESCE(SUM(n_linhas), 0) AS linhas, "
            "COALESCE(SUM(CASE WHEN status <> 'pendente' THEN 1 ELSE 0 END), 0) AS validados, "
            "COALESCE(SUM(CASE WHEN status <> 'pendente' THEN n_linhas ELSE 0 END), 0) AS linhas_validadas, "
            "COALESCE(SUM(CASE WHEN status = 'corrigida' THEN 1 ELSE 0 END), 0) AS corrigidos, "
            "COALESCE(SUM(CASE WHEN status = 'pendente' AND faixa = 'Alta' THEN 1 ELSE 0 END), 0) AS alta_pendente "
            "FROM radar_ml_items WHERE analysis_id = ?", (analysis_id,)).fetchone()
    return {k: int(row[k]) for k in ('relatos', 'linhas', 'validados', 'linhas_validadas', 'corrigidos', 'alta_pendente')}


def update_ml_items(analysis_id, updates):
    """updates: [{relato_norm, status, classe_final, detalhe_final, updated_at}]"""
    with connection() as conn:
        conn.cursor().executemany(
            'UPDATE radar_ml_items SET status = ?, classe_final = ?, detalhe_final = ?, updated_at = ? WHERE id = ?',
            [(u['status'], u['classe_final'], u['detalhe_final'], u['updated_at'], _item_id(analysis_id, u['relato_norm']))
             for u in updates])


def save_failure_summary(analysis_id, rows):
    with connection() as conn:
        conn.execute('DELETE FROM radar_failure_summary WHERE analysis_id = ?', (analysis_id,))
        conn.cursor().executemany(
            'INSERT INTO radar_failure_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [(_item_id(analysis_id, r['classe']), analysis_id, r['classe'], r['linhas'], r['falhas_reais'], r['minutos'],
              r['mttr'], r['percentual'], r['acumulado'], r['linhas_validadas'], r['updated_at']) for r in rows])


def failure_summary(analysis_id):
    with connection() as conn:
        rows = conn.execute('SELECT classe, linhas, falhas_reais, minutos, mttr, percentual, acumulado, linhas_validadas, '
                            'updated_at FROM radar_failure_summary WHERE analysis_id = ? ORDER BY minutos DESC, classe',
                            (analysis_id,)).fetchall()
    return [dict(r) for r in rows]
