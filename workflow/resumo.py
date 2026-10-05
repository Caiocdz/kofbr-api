"""Exportações por observação a partir da análise validada no quadro.

- Planilha completa com Classificação (`full_from_analysis`): a planilha ORIGINAL importada, intacta,
  com a coluna "Classificação" que saiu do quadro (validada pelo analista).
- Planilha resumida (`from_analysis`): uma linha por observação única, sem as repetições.
- `sheet_examples`: exemplos (relato, classe) salvos antes pela tela "Classificar planilha" (removida);
  continuam valendo no treino do modelo.
"""
import io
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from . import classify as fc

ORIGIN = {'analista': 'Analista (padronizada)', 'memoria': 'Memória de correções', 'regra': 'Catálogo',
          'componente': 'Catálogo', 'processo': 'Catálogo', 'aprendizado': 'Machine learning',
          'quadro': 'Validada no quadro', 'nenhum': '—'}


# ----------------------------------------------------------------------------- leitura

def _plain(text):
    text = re.sub(r'\s+', ' ', str(text or '')).strip().upper()
    return unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode()


def _header(row):
    cols = {}
    for i, value in enumerate(row or ()):
        h = re.sub(r'\s+', ' ', _plain(value)).strip()
        if not h:
            continue
        if 'text' not in cols and h.startswith('OBSERVA'):
            cols['text'] = i
        elif 'label' not in cols and h.startswith('CLASSIFICA'):
            cols['label'] = i
        elif 'machine' not in cols and (h.startswith('CHAVE DO PARADA') or h.startswith('CHAVE DA PARADA') or h == 'EQUIPAMENTO'):
            cols['machine'] = i
        elif 'line' not in cols and h == 'LINHA':
            cols['line'] = i
        elif 'unit' not in cols and h in ('CENTRO', 'UNIDADE'):
            cols['unit'] = i
        elif 'minutes' not in cols and h.startswith('MINUTOS'):
            cols['minutes'] = i
    return cols


# ----------------------------------------------------------------------------- planilha completa

FULL_COLUMN = 'Classificação'
FULL_FILLS = {'validada': 'E7F6EF', 'alta': 'E7F6EF', 'media': 'FFF6DC', 'baixa': 'FDECEE'}
FULL_NOTE = ('Classificação padronizada (FALHA DE <componente>).\n'
             'Verde: validada no quadro ou com confiança alta.\n'
             'Amarelo: sugerida pela ML ou pelo catálogo, vale conferir.\n'
             'Vermelho: sem modo de falha identificado, análise manual.')


def write_full(data, filename, marks):
    """A planilha ORIGINAL, intacta, com a coluna Classificação preenchida.

    marks = {aba: {linha: (classe, tom)}}. A coluna entra depois da última coluna do cabeçalho, então
    nenhuma coluna existente muda de letra (fórmulas, filtros e formatação continuam valendo). Se a aba
    já tem uma coluna Classificação vazia, ela é preenchida no lugar."""
    import openpyxl
    from copy import copy
    from openpyxl.comments import Comment
    from openpyxl.styles import PatternFill
    from openpyxl.utils import get_column_letter
    ext = Path(filename).suffix.lower()
    wb = openpyxl.load_workbook(io.BytesIO(data), keep_vba=ext == '.xlsm')
    for title, rows in marks.items():
        ws = wb[title] if title in wb.sheetnames else wb.worksheets[0]
        header_row, cols = 1, {}
        for r in range(1, 31):
            found = _header([c.value for c in ws[r]])
            if 'text' in found:
                header_row, cols = r, found
                break
        heads = [c.value for c in ws[header_row]]
        last = max((i + 1 for i, v in enumerate(heads) if v not in (None, '')), default=ws.max_column)
        sample = list(rows)[:300]
        if 'label' in cols and not any(ws.cell(n, cols['label'] + 1).value not in (None, '') for n in sample):
            col = cols['label'] + 1
        else:
            col = last + 1
            head = ws.cell(header_row, col)
            head.value = FULL_COLUMN
            model = ws.cell(header_row, cols.get('text', 0) + 1)
            for attr in ('font', 'fill', 'border', 'alignment', 'number_format', 'protection'):
                setattr(head, attr, copy(getattr(model, attr)))
        ws.cell(header_row, col).comment = Comment(FULL_NOTE, 'Gargalo')
        for number, (label, tone) in rows.items():
            cell = ws.cell(number, col)
            cell.value = label
            if tone in FULL_FILLS:
                cell.fill = PatternFill('solid', fgColor=FULL_FILLS[tone])
        ws.column_dimensions[get_column_letter(col)].width = 34
        if ws.auto_filter.ref:
            start = ws.auto_filter.ref.split(':')[0]
            ws.auto_filter.ref = f'{start}:{get_column_letter(max(col, last))}{ws.max_row}'
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue(), ('.xlsm' if ext == '.xlsm' else '.xlsx')


def _tone(label, confidence):
    if label in fc.UNCLASSIFIED:
        return 'baixa'
    return confidence or 'media'


def full_from_analysis(doc, source):
    """Planilha completa da análise: cada linha do SAP com a classe do card em que ela ficou no quadro."""
    from . import service
    board = service.board(doc)
    by_record = {}
    for card in board['cards']:
        # "Sem modo de falha" fica vermelho mesmo validado: é o que pede análise manual.
        tone = 'baixa' if card['class'] in fc.UNCLASSIFIED else 'validada' if card['validated'] else _tone(card['class'], card['confidence'])
        for rid in card['record_ids']:
            by_record[rid] = (card['class'], tone)
    stem = Path(doc.get('filename') or doc.get('name') or 'analise').stem
    if source and not str(doc.get('filename') or '').lower().endswith('.csv'):
        marks = defaultdict(dict)
        for r in doc['records']:
            if r['id'] in by_record and r.get('source_row'):
                marks[r.get('source_sheet') or ''][r['source_row']] = by_record[r['id']]
        data, ext = write_full(source, doc.get('filename') or 'x.xlsx', marks)
        return data, f'{stem} - com classificação{ext}'
    # CSV ou importação antiga sem o arquivo guardado: remonta a planilha com as células originais.
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Apontamentos'
    records = sorted(doc['records'], key=lambda r: (r.get('source_sheet') or '', r.get('source_row') or 0))
    heads = [k.split(' · ', 1)[-1] for k in (records[0].get('original') or {})] if records else []
    ws.append(heads + [FULL_COLUMN])
    for c in ws[1]:
        c.font, c.fill = Font(bold=True, color='FFFFFF'), PatternFill('solid', fgColor=RED)
    for r in records:
        label, tone = by_record.get(r['id'], ('', ''))
        ws.append(list((r.get('original') or {}).values()) + [label])
        if tone in FULL_FILLS:
            ws.cell(ws.max_row, len(heads) + 1).fill = PatternFill('solid', fgColor=FULL_FILLS[tone])
    ws.freeze_panes = 'A2'
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue(), f'{stem} - com classificação.xlsx'


# ----------------------------------------------------------------------------- agrupamento

def sheet_examples():
    from . import store
    return [(v['text'], v['label']) for v in (store.get_setting('sheet_examples') or {}).values()]


# ----------------------------------------------------------------------------- planilha de saída

RED = 'E0101F'


def _variations(g, limit=3):
    others = [t for t, _ in g['texts'].most_common() if t != g['text']]
    if not others:
        return ''
    extra = len(others) - limit
    return ' | '.join(o[:120] for o in others[:limit]) + (f' | +{extra}' if extra > 0 else '')


def _join(counter, limit=4):
    items = [k for k, _ in counter.most_common()]
    return ', '.join(items[:limit]) + (f' +{len(items) - limit}' if len(items) > limit else '')


def build_workbook(groups, meta, with_context=False):
    import openpyxl
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    wb = openpyxl.Workbook()
    head_fill, head_font = PatternFill('solid', fgColor=RED), Font(bold=True, color='FFFFFF')
    thin = Border(bottom=Side(style='thin', color='EEEEEE'))
    tone = {'alta': 'E7F6EF', 'media': 'FFF6DC', 'baixa': 'FDECEE'}

    def table(ws, headers, widths, rows, colored=None):
        ws.append(headers)
        for c in range(1, len(headers) + 1):
            cell = ws.cell(1, c)
            cell.fill, cell.font = head_fill, head_font
            cell.alignment = Alignment(vertical='center', wrap_text=True)
        ws.row_dimensions[1].height = 30
        for row in rows:
            ws.append(row)
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
        for r in ws.iter_rows(min_row=2):
            for cell in r:
                cell.alignment = Alignment(vertical='top', wrap_text=True)
                cell.border = thin
        ws.freeze_panes = 'A2'
        ws.auto_filter.ref = ws.dimensions
        if colored:
            col, values = colored
            for i, v in enumerate(values, 2):
                if v in tone:
                    ws.cell(i, col).fill = PatternFill('solid', fgColor=tone[v])

    ordered = sorted(groups, key=lambda g: (-g['count'], g['class'] or '', g['text']))
    ws = wb.active
    ws.title = 'Resumo'
    headers = ['Nº', 'Observação', 'Ocorrências', 'Classificação', 'Origem da classificação', 'Confiança']
    widths = [6, 70, 12, 36, 24, 11]
    if with_context:
        headers += ['Equipamentos', 'Linhas', 'Minutos de parada']
        widths += [30, 16, 12]
    headers += ['Classificação original do analista', 'Variações agrupadas']
    widths += [32, 60]
    conf = {'alta': 'Alta', 'media': 'Média', 'baixa': 'Revisar'}
    rows = []
    for i, g in enumerate(ordered, 1):
        row = [i, g['text'] or '(em branco)', g['count'], g['class'], ORIGIN.get(g['source'], g['source']),
               conf.get(g['confidence'], '')]
        if with_context:
            row += [_join(g['machines']), _join(g['lines']), round(g['minutes'], 1)]
        row += [g['analyst'], _variations(g)]
        rows.append(row)
    table(ws, headers, widths, rows, colored=(6, [g['confidence'] for g in ordered]))

    by_class = defaultdict(lambda: {'unique': 0, 'count': 0, 'minutes': 0.0, 'sources': Counter()})
    for g in groups:
        b = by_class[g['class']]
        b['unique'] += 1
        b['count'] += g['count']
        b['minutes'] += g['minutes']
        b['sources'][ORIGIN.get(g['source'], g['source'])] += g['count']
    total = sum(g['count'] for g in groups) or 1
    ws2 = wb.create_sheet('Por classificação')
    rows2 = [[k, v['unique'], v['count'], round(v['count'] * 100 / total, 1), v['sources'].most_common(1)[0][0]]
             + ([round(v['minutes'], 1)] if with_context else [])
             for k, v in sorted(by_class.items(), key=lambda kv: -kv[1]['count'])]
    table(ws2, ['Classificação', 'Observações únicas', 'Ocorrências', '% das ocorrências', 'Origem predominante']
          + (['Minutos de parada'] if with_context else []), [40, 18, 14, 16, 26, 16], rows2)

    ws3 = wb.create_sheet('Como foi feito')
    ws3.column_dimensions['A'].width = 52
    ws3.column_dimensions['B'].width = 70
    title = ws3.cell(1, 1, 'Planilha resumida · Gargalo — Radar de Confiabilidade')
    title.font = Font(bold=True, size=14, color=RED)
    for i, (k, v) in enumerate(meta, 3):
        ws3.cell(i, 1, k).font = Font(bold=True)
        ws3.cell(i, 2, v).alignment = Alignment(wrap_text=True, vertical='top')
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def stats(groups, rows_read, info):
    by_source = Counter()
    for g in groups:
        by_source[g['source']] += g['count']
    filled = [g for g in groups if not g['analyst'] or g['source'] != 'analista']
    return {
        'rows': rows_read,
        'unique': len(groups),
        'duplicates': rows_read - len(groups),
        'blank': sum(g['count'] for g in groups if not g['key']),
        'analyst': sum(1 for g in groups if g['source'] == 'analista'),
        'filled': sum(1 for g in filled if g['class'] not in fc.UNCLASSIFIED),
        'unclassified': sum(1 for g in groups if g['class'] in fc.UNCLASSIFIED),
        'by_source': {ORIGIN.get(k, k): v for k, v in by_source.most_common()},
        'classes': len({g['class'] for g in groups}),
        'model_accuracy': (info or {}).get('accuracy'),
        'model_examples': (info or {}).get('examples'),
    }


def _meta(filename, st):
    return [
        ('Arquivo', filename),
        ('Gerado em', datetime.now().strftime('%d/%m/%Y %H:%M')),
        ('Linhas lidas', st['rows']),
        ('Observações únicas (linhas do Resumo)', st['unique']),
        ('Repetições agrupadas', f"{st['duplicates']} linha(s) — mesmo relato, mesmo sem acento, pontuação ou número de O.S./nota"),
        ('Classificadas pelo analista (padronizadas)', st['analyst']),
        ('Preenchidas pela ferramenta', f"{st['filled']} (memória de correções, catálogo de falhas ou machine learning)"),
        ('Sem modo de falha identificado / sem descrição', f"{st['unclassified']} — precisam de análise manual (previsto no item 1.4 do descritivo)"),
        ('Acerto do modelo (teste cego)', f"{st['model_accuracy']}%" if st['model_accuracy'] is not None else 'calibrando (mínimo de 60 exemplos)'),
        ('Padrão da classificação', 'FALHA DE <componente> — a manifestação da falha, sem o restante do relato (descritivo, item 1.3)'),
        ('Origem da classificação', 'Analista (padronizada): rótulo da planilha enquadrado no padrão · Memória: correção feita '
                                    'antes no quadro · Catálogo: termo do catálogo de falhas · Machine learning: aprendido com '
                                    'planilhas finalizadas e com as classificações dos analistas'),
    ]


# ----------------------------------------------------------------------------- entradas

def from_analysis(doc):
    """Análise validada do quadro → resumo (a classe é a validada pelo analista; nada é reclassificado)."""
    from . import service
    board = service.board(doc)
    records = {r['id']: r for r in doc['records']}
    rows = []
    for card in board['cards']:
        source = 'analista' if card['failure_class'] else ('quadro' if card['validated'] else card['source'])
        for rid in card['record_ids']:
            r = records[rid]
            rows.append({'text': r.get('observacao_raw') or '', 'label': '', 'machine': r.get('equipamento') or '',
                         'line': r.get('linha') or '', 'unit': r.get('centro') or '',
                         'minutes': r.get('minutos_parada') or 0, 'class': card['class'], 'source': source,
                         'confidence': 'alta' if card['validated'] else card['confidence']})
    # Mesmo relato com classes diferentes (máquinas diferentes) fica em linhas separadas.
    groups, index = [], {}
    for r in rows:
        key = (fc.memory_key(r['text']) or fc.normalize(r['text']), r['class'])
        if key not in index:
            index[key] = len(groups)
            groups.append({'key': key[0], 'texts': Counter(), 'labels': Counter(), 'machines': Counter(), 'lines': Counter(),
                           'units': Counter(), 'count': 0, 'minutes': 0.0, 'class': r['class'], 'sources': Counter(),
                           'confs': Counter()})
        g = groups[index[key]]
        g['texts'][r['text']] += 1
        g['machines'][r['machine']] += 1 if r['machine'] else 0
        g['lines'][r['line']] += 1 if r['line'] else 0
        g['count'] += 1
        g['minutes'] += r['minutes']
        g['sources'][r['source']] += 1
        g['confs'][r['confidence']] += 1
    for g in groups:
        g['text'] = g['texts'].most_common(1)[0][0]
        g['analyst'] = fc.pretty(g['class']) if g['sources'].get('analista') else ''
        g['source'] = g['sources'].most_common(1)[0][0]
        g['confidence'] = g['confs'].most_common(1)[0][0]
        g['machines'] = +g['machines']
        g['lines'] = +g['lines']
    st = stats(groups, len(rows), None)
    st['filled'] = sum(1 for g in groups if g['source'] != 'analista' and g['class'] not in fc.UNCLASSIFIED)
    meta = _meta(doc.get('filename') or doc.get('name'), st)
    meta[8] = ('Classificação', 'Validada pelo analista no quadro (a classe congelada na validação não muda depois)')
    name = f"{Path(doc.get('filename') or doc.get('name') or 'analise').stem} - resumida.xlsx"
    return build_workbook(groups, meta, with_context=True), name
