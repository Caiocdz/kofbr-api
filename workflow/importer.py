"""Leitura rigorosa e agrupamento sem limite de membros ou cortes por lote."""
import csv
import hashlib
import io
import json
import math
from collections import defaultdict
from datetime import date, datetime
from uuid import uuid4

import numpy as np
import openpyxl
from openpyxl.utils.datetime import from_excel
from sklearn.feature_extraction.text import TfidfVectorizer

from dedup import normalize_observation, CONTEXT_FIELDS
from parsing import COLUMN_ALIASES, _norm_header, _to_float

ALIASES = {**COLUMN_ALIASES, 'UNIDADE': 'centro', 'DATA': 'data_inicio', 'DATA INICIO': 'data_inicio',
           'EQUIPAMENTO': 'equipamento', 'MAQUINA': 'equipamento', 'PECA': 'equipamento',
           'TIPO DE FALHA': 'tipo_parada', 'TIPO FALHA': 'tipo_parada', 'DESCRICAO': 'observacao_raw',
           'FALHA': 'observacao_raw', 'MINUTOS': 'minutos_parada', 'TEMPO DE PARADA': 'minutos_parada'}
REQUIRED = {'data_inicio': 'Data', 'linha': 'Linha', 'equipamento': 'Equipamento',
            'observacao_raw': 'Observações', 'minutos_parada': 'Minutos de parada'}


def iso_date(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()[:10]
    if isinstance(value, (int, float)) and 1 <= value <= 100000:
        return from_excel(value).date().isoformat()
    text = str(value or '').strip()
    for pattern in ('%Y-%m-%d', '%d/%m/%Y', '%d/%m/%y', '%d-%m-%Y', '%Y/%m/%d'):
        try:
            return datetime.strptime(text.split('T')[0].split(' ')[0], pattern).date().isoformat()
        except ValueError:
            pass
    raise ValueError('data inválida')


def parse_file(data, filename, strict=True, keep_original=True, skipped=None):
    """Lê a planilha. strict=True recusa o arquivo inteiro se houver linha inválida (tela Importar);
    strict=False pula a linha e a registra em `skipped` como (linha, motivo) — fluxo único.
    keep_original=False não guarda as células originais (planilhas grandes)."""
    workbook = None
    if filename.lower().endswith('.csv'):
        text = data.decode('utf-8-sig')
        try:
            dialect = csv.Sniffer().sniff(text[:8192], delimiters=';,\t')
        except csv.Error:
            dialect = csv.excel
        sheets = [('CSV', list(csv.reader(io.StringIO(text), dialect)))]
    else:
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        sheets = [(s.title, s.iter_rows(values_only=True)) for s in workbook.worksheets]
    try:
        best_missing = set(REQUIRED)
        for title, sheet in sheets:
            rows = iter(sheet)
            mapping = None
            headers = []
            for row_number, row in enumerate(rows, 1):
                candidate = {i: ALIASES[_norm_header(v)] for i, v in enumerate(row) if _norm_header(v) in ALIASES}
                missing = set(REQUIRED) - set(candidate.values())
                if len(missing) < len(best_missing):
                    best_missing = missing
                if not missing:
                    mapping, headers = candidate, row
                    break
                if row_number >= 30:
                    break
            if mapping is None:
                continue
            if len(mapping.values()) != len(set(mapping.values())):
                raise ValueError('Há duas colunas com o mesmo significado. Renomeie ou remova a coluna duplicada.')
            records, errors, warnings = [], [], []
            for number, row in enumerate(rows, row_number + 1):
                if not any(v is not None and str(v).strip() for v in row):
                    continue
                rec = {field: row[i] if i < len(row) else None for i, field in mapping.items()}
                try:
                    rec['data_inicio'] = iso_date(rec.get('data_inicio'))
                    minutes = _to_float(rec.get('minutos_parada'))
                    if minutes is None or not math.isfinite(minutes) or minutes < 0:
                        raise ValueError('minutos de parada devem ser um número maior ou igual a zero')
                    rec['minutos_parada'] = minutes
                    for field in set(ALIASES.values()) - {'data_inicio', 'minutos_parada'}:
                        rec[field] = str(rec.get(field) or '').strip()
                    if not rec['linha'] or not rec['equipamento']:
                        raise ValueError('linha e equipamento são obrigatórios')
                    rec['centro'] = rec['centro'] or 'Não informada'
                    rec['tipo_parada'] = rec['tipo_parada'] or 'Não informado'
                    rec['id'] = len(records) + 1
                    rec['source_row'] = number
                    rec['source_sheet'] = title
                    if keep_original:
                        rec['original'] = {f'{i+1} · {str(h or "Coluna")}': str(row[i]) if i < len(row) and row[i] is not None else '' for i, h in enumerate(headers)}
                    rec['observacao_normalizada'] = normalize_observation(_norm_header(rec['observacao_raw']))
                    records.append(rec)
                except ValueError as exc:
                    if not strict:
                        if skipped is not None:
                            skipped.append((number, str(exc)))
                        continue
                    if len(errors) < 20:
                        errors.append(f'Linha {number}: {exc}.')
            if skipped:
                warnings.append(f'{len(skipped)} linha(s) ignorada(s) por dados inválidos: '
                                + '; '.join(f'linha {n} ({why})' for n, why in skipped[:10])
                                + ('…' if len(skipped) > 10 else '') + '.')
            if errors:
                raise ValueError('Corrija a planilha antes de importar. ' + ' '.join(errors))
            if not records:
                raise ValueError('A planilha não contém apontamentos.')
            if any(not r['observacao_raw'] for r in records):
                warnings.append('Registros sem descrição foram mantidos como cards individuais para revisão.')
            for field, label in [('centro', 'Unidade'), ('tipo_parada', 'Tipo de falha')]:
                if field not in mapping.values():
                    warnings.append(f'Coluna {label} ausente: identificada como não informada.')
            return records, warnings
        raise ValueError('Cabeçalhos não encontrados. Faltam: ' + ', '.join(REQUIRED[x] for x in sorted(best_missing)))
    finally:
        if workbook:
            workbook.close()


def content_hash(records):
    fields = sorted(set(ALIASES.values()))
    # Ordem das linhas, nome do arquivo e metadados do Excel não alteram a identidade.
    lines = sorted(json.dumps([r.get(k) for k in fields], ensure_ascii=False, default=str) for r in records)
    return hashlib.sha256('\n'.join(lines).encode()).hexdigest()


def group_records(records, min_similarity=0.80):
    buckets = defaultdict(list)
    for rec in records:
        key = tuple(_norm_header(rec.get(k)) for k in CONTEXT_FIELDS)
        buckets[key].append(rec)
    cards = []
    columns, col_map = [], {}
    for bucket in buckets.values():
        first = bucket[0]
        col_key = tuple(_norm_header(first[k]) for k in ('centro', 'linha', 'equipamento'))
        if col_key not in col_map:
            col_id = str(uuid4())
            col_map[col_key] = col_id
            columns.append({'id': col_id, 'name': first['equipamento'], 'unit': first['centro'], 'line': first['linha'], 'validated': False})
        col_id = col_map[col_key]
        exact = defaultdict(list)
        for rec in bucket:
            # Uma observação vazia nunca é evidência de redundância.
            exact[rec['observacao_normalizada'] or f'__empty_{rec["id"]}'].append(rec)
        texts = sorted(exact)
        groups = []
        matrix = None
        if len(texts) > 1:
            matrix = TfidfVectorizer(ngram_range=(1, 2), token_pattern=r'(?u)\b\w+\b').fit_transform(texts)
            # Similaridade de todos contra todos calculada uma vez (mesmo resultado, ~100x mais rápido
            # que fatiar a matriz esparsa a cada comparação). Em máquinas com muitos relatos distintos
            # a matriz densa ficaria grande demais: aí continua o cálculo por linha.
            dense = (matrix @ matrix.T).toarray() if len(texts) <= 4000 else None
            token_groups = defaultdict(set)
            for index, text in enumerate(texts):
                tokens = set(text.split())
                candidates = set().union(*(token_groups[t] for t in tokens)) if tokens else set()
                match = None
                negation = tokens.intersection({'NAO', 'SEM', 'NUNCA'})
                for gi in sorted(candidates):
                    members = groups[gi]
                    if any(set(texts[j].split()).intersection({'NAO', 'SEM', 'NUNCA'}) != negation for j in members):
                        continue
                    similarities = (dense[index, members] if dense is not None
                                    else (matrix[index] @ matrix[members].T).toarray().ravel())
                    if len(similarities) and float(similarities.min()) >= min_similarity:
                        match = gi
                        break
                if match is None:
                    match = len(groups)
                    groups.append([])
                groups[match].append(index)
                for token in tokens:
                    token_groups[token].add(match)
        else:
            groups = [[0]]
        for group in groups:
            members = [r for i in group for r in exact[texts[i]]]
            average = 1.0
            if len(group) > 1:
                weights = np.array([len(exact[texts[i]]) for i in group])[:, None]
                vector_sum = matrix[group].multiply(weights).sum(axis=0)
                n = len(members)
                average = float((np.square(vector_sum).sum() - n) / (n * (n - 1)))
            label = min((texts[i] for i in group), key=lambda t: (-len(exact[t]), len(t), t))
            cards.append({'id': str(uuid4()), 'column_id': col_id, 'name': label.title() if not label.startswith('__empty_') else 'Descrição não informada',
                          'record_ids': [r['id'] for r in members], 'avg_similarity': round(average, 4), 'validated': False, 'held': False})
    return columns, sorted(cards, key=lambda c: (-len(c['record_ids']), c['name']))


def new_document(records, filename, warnings):
    columns, cards = group_records(records)
    return {'id': str(uuid4()), 'revision': 1, 'name': filename.rsplit('.', 1)[0], 'filename': filename,
            'created_at': datetime.now().astimezone().isoformat(), 'updated_at': datetime.now().astimezone().isoformat(),
            'records': records, 'columns': columns, 'cards': cards, 'warnings': warnings, 'events': []}
