"""Copia o histórico MySQL anterior para o novo quadro; não altera a origem.

Execute depois de configurar KOFBR_DB_HOST, PORT, USER, PASSWORD e NAME.
KOFBR_WORKFLOW_DB escolhe o destino (sqlite ou mysql).
"""
from workflow import store, importer
from db import get_conn


def migrate():
    store.initialize()
    source = get_conn()
    try:
        batches = source.execute('SELECT * FROM upload_batches ORDER BY id').fetchall()
        copied = skipped = 0
        for batch in batches:
            rows = source.execute('''SELECT r.*, cf.nome_canonico AS consolidated_name
                                     FROM records r LEFT JOIN canonical_failures cf ON cf.id=r.canonical_failure_id
                                     WHERE r.upload_batch_id = ? ORDER BY r.id''', (batch['id'],)).fetchall()
            if not rows:
                continue
            records = []
            for i, row in enumerate(rows, 1):
                record = dict(row)
                record['original'] = {k: str(v) if v is not None else '' for k, v in record.items()}
                record['data_inicio'] = importer.iso_date(record['data_inicio'])
                record['minutos_parada'] = float(record['minutos_parada'] or 0)
                for key in set(importer.ALIASES.values())-{'data_inicio', 'minutos_parada'}:
                    record[key] = str(record.get(key) or '').strip()
                record.update(id=i, source_row=i+1, source_sheet='Histórico MySQL')
                # Serialize only mapped source fields and necessary audit data.
                record = {k: record[k] for k in set(importer.ALIASES.values())|{'id', 'source_row', 'source_sheet', 'original'}}
                record['observacao_normalizada'] = importer.normalize_observation(record.get('observacao_raw', ''))
                records.append(record)
            doc = importer.new_document(records, batch['filename'], ['Histórico migrado do MySQL. O arquivo Excel original não estava armazenado na versão anterior.'])
            # Preserve confirmations, but conservatively re-review mixed or questioned groups.
            original_by_id = {i: dict(row) for i, row in enumerate(rows, 1)}
            for card in doc['cards']:
                members = [original_by_id[i] for i in card['record_ids']]
                card['validated'] = all(r.get('status') == 'confirmed' for r in members)
                card['held'] = any(r.get('status') == 'questioned' for r in members)
                names = {r.get('consolidated_name') for r in members if r.get('consolidated_name')}
                if len(names) == 1:
                    card['name'] = names.pop()
                if len(names) > 1:
                    card['validated'] = False
            for column in doc['columns']:
                members = [c for c in doc['cards'] if c['column_id'] == column['id']]
                column['validated'] = bool(members) and all(c['validated'] and not c['held'] for c in members)
            _, created = store.insert(doc, importer.content_hash(records), None)
            copied += created
            skipped += not created
        print(f'Migração concluída: {copied} análises copiadas; {skipped} já existentes. Origem preservada.')
    finally:
        source.close()


if __name__ == '__main__':
    migrate()
