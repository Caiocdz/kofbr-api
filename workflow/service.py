"""Regras do quadro e indicadores: a mesma base para telas e exportação."""
from collections import defaultdict
from copy import deepcopy
from datetime import date, datetime, timedelta
from statistics import median
from uuid import uuid4
import re
from collections import Counter

from . import classify as fc
from . import learning


def catalog():
    """Catálogo de classes de falha salvo no banco (ou o padrão)."""
    from . import store
    try:
        saved = store.get_setting('failure_catalog')
    except Exception:
        saved = None
    return saved or fc.default_catalog()


def memory():
    """Memória de correções: relato normalizado → classe escolhida pelo analista."""
    from . import store
    try:
        return store.get_setting('class_memory') or {}
    except Exception:
        return {}


def learn(doc, card_ids, previous=None):
    """Grava na memória as classes que o analista definiu à mão.

    Na próxima importação, o mesmo relato (mesmo com outra O.S.) já chega
    classificado com confiança alta. Voltar ao automático esquece o que foi
    aprendido com aquele card."""
    from . import store
    mem = memory()
    records = {r['id']: r for r in doc['records']}
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    changed = 0
    for card in doc['cards']:
        if card['id'] not in card_ids:
            continue
        label = card.get('failure_class')
        for rid in card['record_ids']:
            key = fc.memory_key(records[rid].get('observacao_raw'))
            if not key:
                continue
            if label:
                old = mem.get(key) or {}
                mem[key] = {'label': label, 'count': old.get('count', 0) + 1 if old.get('label') == label else 1, 'at': now}
                changed += 1
            elif previous and (mem.get(key) or {}).get('label') == previous.get(card['id']):
                mem.pop(key, None)
                changed += 1
    if changed:
        store.set_setting('class_memory', mem)
    return changed


def record_detail(record, cat, mem=None, ml=False):
    base = fc.explain(record.get('observacao_raw'), record.get('equipamento'), cat, mem)
    if not ml:
        return base
    pair = (str(record.get('observacao_raw') or ''), str(record.get('equipamento') or ''))
    return learning.refine(base, learning.predict_many([pair]).get(pair), pair[0])


def record_class(record, cat, mem=None):
    return record_detail(record, cat, mem)['label']


def details_for(records, cat, mem=None, ml=False):
    """Classificação de todos os apontamentos pelo catálogo + memória (em lote).
    O quadro usa o modelo calibrado (apontamentos_ml) por cima disso, em card_info; o modelo antigo
    (learning.py, sem calibração) só entra com ml=True."""
    pairs = {r['id']: (str(r.get('observacao_raw') or ''), str(r.get('equipamento') or '')) for r in records}
    preds = learning.predict_many(list(pairs.values())) if ml else {}
    out = {}
    for r in records:
        base = fc.explain(r.get('observacao_raw'), r.get('equipamento'), cat, mem)
        out[r['id']] = learning.refine(base, preds.get(pairs[r['id']]), pairs[r['id']][0]) if ml else base
    return out


def card_auto(card, details):
    """Classe automática do card (voto da maioria) com confiança e motivo."""
    chosen_all = [details[i] for i in card['record_ids']]
    counts = Counter(d['label'] for d in chosen_all)
    # Classe mais frequente; empate resolvido pela classe identificada.
    label, votes = max(counts.items(), key=lambda kv: (kv[1], kv[0] not in fc.UNCLASSIFIED, kv[0]))
    chosen = [d for d in chosen_all if d['label'] == label]
    agreement = votes / len(chosen_all)
    if label in fc.UNCLASSIFIED:
        confidence = 'baixa'
    elif agreement < 0.75 or any(d['confidence'] != 'alta' for d in chosen):
        confidence = 'media'
    else:
        confidence = 'alta'
    reason = Counter(d['reason'] for d in chosen).most_common(1)[0][0]
    if agreement < 1:
        reason += f' {votes} de {len(chosen_all)} apontamentos apontam para esta classe.'
    detail = Counter(d['detail'] for d in chosen if d['detail']).most_common(1)
    suggestion = Counter(d['suggestion'] for d in chosen if d.get('suggestion')).most_common(1)
    return {'label': label, 'confidence': confidence, 'reason': reason, 'agreement': round(agreement, 3),
            'source': Counter(d['source'] for d in chosen).most_common(1)[0][0],
            'detail': detail[0][0] if detail else '', 'suggestion': suggestion[0][0] if suggestion else ''}


# Certeza do ML (%) para a confiança do card: só "alta" libera a validação em lote.
ML_HIGH, ML_MEDIUM = 85.0, 50.0


def card_ml(card, records):
    """Classe do card segundo o modelo de ML e a chance (%) de estar correta:
    certeza média dos apontamentos que concordam × fração do card que concorda."""
    tagged = [records[i] for i in card['record_ids'] if records[i].get('ml_class')]
    if not tagged:
        return None
    label, votes = Counter(r['ml_class'] for r in tagged).most_common(1)[0]
    agreeing = [r for r in tagged if r['ml_class'] == label]
    mean = sum(r['ml_conf'] for r in agreeing) / votes
    detail = Counter(r['ml_detail'] for r in agreeing if r.get('ml_detail')).most_common(1)
    words = [w for w, _ in Counter(w for r in agreeing for w in r.get('ml_words') or []).most_common(3)]
    best = max(agreeing, key=lambda r: r['ml_conf'])
    return {'label': label, 'pct': round(mean * votes / len(card['record_ids']), 1), 'votes': votes,
            'detail': detail[0][0] if detail else '', 'words': words, 'example': best.get('ml_example') or ''}


def _why_ml(ml):
    """Motivo curto, para caber no card: as palavras que pesaram (ou o relato parecido)."""
    if ml['words']:
        return 'cita ' + ', '.join(f'"{w}"' for w in ml['words'])
    return f'parecido com "{ml["example"][:70]}"' if ml['example'] else ''


def class_pct(card, label, records):
    """% de acerto da classe `label` para o card, segundo o machine learning: média, entre os
    apontamentos que o modelo leu, da chance calibrada de cada um ser dessa classe. None sem ML."""
    read = [records[i] for i in card['record_ids'] if records[i].get('ml_probs') or records[i].get('ml_class')]
    if not read:
        return None

    def chance(r):
        if r.get('ml_probs'):
            return float(r['ml_probs'].get(label, 0.0))
        return float(r['ml_conf']) if r.get('ml_class') == label else 0.0
    return round(sum(chance(r) for r in read) / len(read), 1)


def level(pct):
    """Certeza do card a partir da % do ML: só "alta" (85%+) entra no lote de corretos."""
    return 'alta' if pct >= ML_HIGH else 'media' if pct >= ML_MEDIUM else 'baixa'


def card_info(card, details, records, use_ml=False):
    """Classe automática do card e a % de acerto dela segundo o machine learning.

    Padrão: o quadro agrupa por falha com o catálogo/memória e o ML só mede a chance de cada card
    estar certo (separa o que está correto do que o analista precisa revisar).
    use_ml=True (botão "Usar machine learning"): o ML refaz a classificação dos cards abertos."""
    info = card_auto(card, details) | {'ml_pct': None, 'why': ''}
    ml = card_ml(card, records)
    if info['source'] == 'memoria' and info['confidence'] == 'alta':
        # Relato que o analista já corrigiu antes: vale o que ele disse.
        return info | {'ml_pct': 100.0, 'why': 'corrigido antes por você'}
    catalog_label, n = info['label'], len(card['record_ids'])
    if use_ml and ml and ml['pct'] >= ML_MEDIUM:
        info |= {'label': ml['label'], 'source': 'ml', 'detail': ml['detail'] or info['detail'],
                 'agreement': round(ml['votes'] / n, 3)}
    label = info['label']
    pct = class_pct(card, label, records)
    if pct is None:
        # Sem modelo de ML: fica a classe e a confiança do catálogo.
        return info
    if label in fc.UNCLASSIFIED:
        pct = 0.0
    other = ml['label'] if ml and ml['label'] != label else ''
    reason = f'Machine learning: {pct:.0f}% de chance de ser {fc.pretty(label).lower()}.'
    if other:
        reason += f' O machine learning acha mais provável {fc.pretty(other).lower()} ({ml["pct"]:.0f}%).'
    if ml and ml['example'] and not other:
        reason += f' Parecido com relato já classificado: "{ml["example"][:120]}".'
    if catalog_label != label and catalog_label not in fc.UNCLASSIFIED:
        reason += f' O catálogo indica {fc.pretty(catalog_label).lower()}.'
    if other:
        why = f'ML sugere {fc.pretty(other).lower()}, {ml["pct"]:.0f}%'
    elif ml:
        why = 'validado antes por pessoa' if pct >= 100 else _why_ml(ml)
    else:
        why = ''
    return info | {'ml_pct': pct, 'confidence': level(pct), 'reason': reason, 'why': why,
                   'suggestion': other or (catalog_label if catalog_label != label and catalog_label not in fc.UNCLASSIFIED else '')}


def refresh_ml(doc):
    """Mantém as previsões do quadro em dia com o modelo: análises antigas ganham o ML e, a cada
    retreino (depois de validações), os cards ainda NÃO validados são reavaliados. Validado não muda."""
    if doc.get('mode') == 'ml':
        return False
    from . import apontamentos_ml as aml
    from . import importer
    current = aml.version()
    if not current or (doc.get('ml_version') == current and doc.get('ml_schema') == importer.ML_SCHEMA):
        return False
    records = {r['id']: r for r in doc['records']}
    open_ids = [i for c in doc['cards'] if not c['validated'] for i in c['record_ids']]
    if open_ids and not importer.ml_annotate([records[i] for i in open_ids]):
        return False
    doc['ml_version'], doc['ml_schema'] = current, importer.ML_SCHEMA
    return True


def final_class(card, auto_label):
    """Classe que vale para os indicadores: a do analista, a congelada na validação ou a automática."""
    return card.get('failure_class') or (card.get('validated_class') if card.get('validated') else None) or auto_label


def training_rows():
    """Exemplos para o aprendizado: tudo o que pessoas já validaram."""
    from . import store
    cat, mem = catalog(), memory()

    def label(doc, card):
        if card.get('failure_class') or card.get('validated_class'):
            return card.get('failure_class') or card.get('validated_class')
        records = {r['id']: r for r in doc['records']}
        details = {i: fc.explain(records[i].get('observacao_raw'), records[i].get('equipamento'), cat, mem)
                   for i in card['record_ids']}
        return card_info(card, details, records, doc.get('use_ml'))['label']
    return learning.examples(store.all_documents(), mem, label)


def teach_ml(before, after):
    """Cada card que passa a valer como validado (ou muda de classe depois de validado) vira exemplo
    de treino do modelo de ML (radar_ml_examples, peso 3): a próxima planilha já chega mais certa."""
    from . import apontamentos_ml as aml
    from . import store
    old = {c['id']: (c['validated'] and not c['held'], final_class(c, None)) for c in before['cards']}
    records = {r['id']: r for r in after['records']}
    examples = {}
    for c in after['cards']:
        label = final_class(c, None) if c['validated'] and not c['held'] else None
        if not label or label in fc.UNCLASSIFIED or old.get(c['id']) == (True, label):
            continue
        for rid in c['record_ids']:
            text = records[rid].get('observacao_raw') or ''
            key = aml.normalize_text(text)
            if aml.has_content(key):
                examples[key] = {'relato': text, 'relato_norm': key, 'classe': aml.class_label(label),
                                 'detalhe': records[rid].get('ml_detail') or '', 'origem': after['filename']}
    if examples:
        store.save_ml_examples(list(examples.values()))
        aml.retrain_soon()
    return len(examples)


def card_auto_class(card, records, cat, mem=None, use_ml=False):
    return card_info(card, details_for([records[i] for i in card['record_ids']], cat, mem), records, use_ml)['label']


# --- Falha real × linha do SAP -------------------------------------------------
# O SAP fatia uma parada longa em linhas de 1 h. Para confiabilidade, uma falha é
# um evento: mesma O.S. (número de 9 a 12 dígitos no relato) na mesma máquina.
# Sem O.S., linhas da mesma máquina, mesmo dia, mesmo relato e intervalos
# encostados (13:00-14:00 → 14:00-15:00) também são a mesma falha.
_OS = re.compile(r'(?<!\d)(\d{9,12})(?!\d)')
_INTERVAL = re.compile(r'(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})')


def order_number(text):
    m = _OS.search(str(text or ''))
    return m.group(1) if m else ''


def _interval(text):
    m = _INTERVAL.search(str(text or ''))
    if not m:
        return None
    a, b = int(m.group(1))*60 + int(m.group(2)), int(m.group(3))*60 + int(m.group(4))
    return a, (b if b > a else b + 1440)


def event_map(doc):
    """record_id → (event_id, O.S.)."""
    out = {}
    loose = defaultdict(list)
    for r in doc['records']:
        os_ = order_number(r.get('observacao_raw'))
        machine = '|'.join(_norm(r.get(k)) for k in ('centro', 'linha', 'equipamento'))
        if r.get('sem_contexto'):
            # Máquina desconhecida: não dá para afirmar que é a mesma falha de outra linha.
            out[r['id']] = (f"{doc['id']}:{r['id']}", os_)
            continue
        if os_:
            out[r['id']] = (f'os:{machine}|{os_}', os_)
        else:
            loose[(machine, r['data_inicio'], r.get('observacao_normalizada') or f"__{r['id']}")].append(r)
    for key, rows in loose.items():
        rows.sort(key=lambda r: (_interval(r.get('intervalo')) or (9999, 9999), r['id']))
        current, end = None, None
        for r in rows:
            span = _interval(r.get('intervalo'))
            if current and span and end is not None and span[0] == end % 1440 and not key[2].startswith('__'):
                end = span[1]
            else:
                current, end = f"{doc['id']}:{r['id']}", span[1] if span else None
            out[r['id']] = (current, '')
    return out


def _norm(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip().upper()


def short_line(line):
    """LINHA003 → L03 (como nas tabelas do descritivo)."""
    m = re.fullmatch(r'\s*LINHA\s*0*(\d+)\s*', str(line or ''), re.I)
    return f'L{int(m.group(1)):02d}' if m else str(line or '')


def ready(doc):
    if doc.get('mode') == 'ml':
        # Fluxo único: o Dashboard libera depois do primeiro "Salvar" da validação.
        from . import pipeline
        return pipeline.is_ready(doc)
    return bool(doc['cards']) and all(c['validated'] and not c['held'] for c in doc['cards'])


def summary(doc):
    by_day = defaultdict(lambda: defaultdict(float))
    count = Counter()
    for r in doc['records']:
        by_day[r['data_inicio']][r['equipamento']] += r['minutos_parada']
        count[r['data_inicio']] += 1
    days = sorted(by_day)
    daily = [{'date': day, 'count': count[day], 'minutes': round(sum(by_day[day].values()), 2),
              'series': sorted(by_day[day].values(), reverse=True)[:9]} for day in days]
    base = {k: doc[k] for k in ('id', 'revision', 'name', 'filename', 'created_at', 'updated_at')} | {
        'days': days, 'daily': daily, 'records_count': len(doc['records']), 'warnings': doc['warnings'],
        'minutes': round(sum(r['minutos_parada'] for r in doc['records']), 2), 'mode': doc.get('mode', 'quadro')}
    if doc.get('mode') == 'ml':
        from . import store
        p = store.ml_items_progress(doc['id'])
        return base | {'ready': p['validados'] > 0, 'groups_count': p['relatos'], 'validated_count': p['validados'],
                       'held_count': 0, 'validated_lines': p['linhas_validadas'], 'step': 5 if p['validados'] else 3}
    return base | {'ready': ready(doc), 'groups_count': len(doc['cards']),
                   'validated_count': sum(c['validated'] and not c['held'] for c in doc['cards']),
                   'held_count': sum(c['held'] for c in doc['cards'])}


def board(doc):
    records = {r['id']: r for r in doc['records']}
    columns = {c['id']: c for c in doc['columns']}
    cat, mem = catalog(), memory()
    events = event_map(doc)
    details = details_for(doc['records'], cat, mem)
    cards = []
    for c in doc['cards']:
        info = card_info(c, details, records, doc.get('use_ml'))
        auto = info['label']
        frozen = c.get('validated') and c.get('validated_class') and not c.get('failure_class')
        shown = final_class(c, auto)
        # A % no canto do card é sempre a da falha que aparece nele (inclusive a escolhida pelo analista).
        if shown != auto:
            pct = class_pct(c, shown, records)
            info['ml_pct'] = None if pct is None else 0.0 if shown in fc.UNCLASSIFIED else pct
        cards.append(c | {
            'confidence': 'manual' if c.get('failure_class') else info['confidence'],
            'reason': f"Definida pelo analista (automático sugeria {fc.pretty(auto)})." if c.get('failure_class') else info['reason'],
            'agreement': info['agreement'], 'source': 'analista' if c.get('failure_class') else info['source'],
            'ml_pct': info['ml_pct'], 'grouped_by': c.get('grouped_by', 'texto'),
            'why': 'definida por você' if c.get('failure_class') else info['why'],
            'machine': f"{columns[c['column_id']]['name']} · {columns[c['column_id']]['line']}" if c['column_id'] in columns else '',
            'detail': info['detail'], 'suggestion': info['suggestion'],
            'events': len({events[i][0] for i in c['record_ids']}),
            'orders': sorted({events[i][1] for i in c['record_ids'] if events[i][1]})[:20],
            'count': len(c['record_ids']),
            'minutes': round(sum(records[i]['minutos_parada'] for i in c['record_ids']), 2),
            'types': sorted({records[i]['tipo_parada'] for i in c['record_ids']}),
            'dates': sorted({records[i]['data_inicio'] for i in c['record_ids']}),
            'sample': records[c['record_ids'][0]]['observacao_raw'],
            'auto_class': auto,
            'failure_class': c.get('failure_class') or '',
            'class': final_class(c, auto),
            'frozen': bool(frozen),
        })
    labels = set(fc.classifier_for(cat).labels()) | {c['class'] for c in cards} | {v['label'] for v in mem.values()}
    return summary(doc) | {'use_ml': bool(doc.get('use_ml')), 'columns': doc['columns'], 'events': doc['events'][-100:], 'cards': cards,
                           'classes': sorted(labels - set(fc.UNCLASSIFIED)) + list(fc.UNCLASSIFIED),
                           'unclassified_count': sum(c['class'] == fc.SEM_MODO for c in cards),
                           'automation': automation(doc, cards, events, mem) | {'learning': learning.info()}}


def automation(doc, cards, events, mem):
    """Painel de automação: quanto a ferramenta resolveu sozinha e quanto o analista revisou."""
    by_conf = Counter(c['confidence'] for c in cards)
    rec_conf = Counter()
    for c in cards:
        rec_conf[c['confidence']] += c['count']
    total = len(doc['records']) or 1
    auto_ok = sum(rec_conf[k] for k in ('alta', 'media'))
    return {'cards': {k: by_conf.get(k, 0) for k in ('alta', 'media', 'baixa', 'manual')},
            'records': {k: rec_conf.get(k, 0) for k in ('alta', 'media', 'baixa', 'manual')},
            'auto_rate': round(auto_ok * 100 / total, 1),
            'high_rate': round(rec_conf.get('alta', 0) * 100 / total, 1),
            'lines': len(doc['records']), 'failures': len({e for e, _ in events.values()}),
            'with_order': sum(1 for _, o in events.values() if o),
            'memory': len(mem), 'manual_changes': sum(e['action'] in ('set_class', 'set_classes') for e in doc['events']),
            'pending_high': sum(1 for c in cards if c['confidence'] in ('alta', 'manual') and not c['validated'] and not c['held'])}


def mutate(doc, body):
    doc = deepcopy(doc)
    action = body.get('action')
    cards = {c['id']: c for c in doc['cards']}
    columns = {c['id']: c for c in doc['columns']}
    card = cards.get(body.get('card_id'))
    column = columns.get(body.get('column_id'))
    if action in {'validate_card', 'hold', 'move', 'rename_card', 'split_card', 'set_class', 'reorder'} and not card:
        raise ValueError('Card não encontrado.')
    if action in {'validate_column', 'delete_column', 'move'} and not column:
        raise ValueError('Coluna não encontrada.')
    if action == 'validate_card':
        if card['held']:
            raise ValueError('Mova o card de revisão para uma coluna antes de validar.')
        card['validated'] = not card['validated']
    elif action == 'validate_column':
        for item in cards.values():
            if item['column_id'] == column['id'] and not item['held']:
                item['validated'] = True
        column['validated'] = True
    elif action == 'set_class':
        # Classificação manual da falha (item 1.4): vazio volta ao automático.
        label = re.sub(r'\s+', ' ', str(body.get('failure_class') or '')).strip().upper()[:120]
        # Corrigir é decidir: o card escolhido pelo analista já fica validado (e ensina o ML).
        if label:
            card['failure_class'] = label
            card['validated'], card['held'] = True, False
        else:
            card.pop('failure_class', None)
            card['validated'] = False
    elif action == 'reorder':
        # Arrastar entre dois cards da mesma falha: só muda a posição (feito abaixo).
        if not (body.get('before_id') or body.get('after_id')):
            raise ValueError('Informe onde soltar o card.')
    elif action == 'set_classes':
        # Lote de classes definidas pelo analista.
        items = body.get('items') or []
        if not isinstance(items, list) or not items:
            raise ValueError('Nenhuma sugestão selecionada.')
        for it in items[:500]:
            target = cards.get(str((it or {}).get('card_id')))
            label = re.sub(r'\s+', ' ', str((it or {}).get('failure_class') or '')).strip().upper()[:120]
            if target and label:
                target['failure_class'] = label
                target['validated'] = False
    elif action == 'validate_confident':
        # Lote seguro: só cards de confiança alta (ou já classificados pelo analista).
        if body.get('confirm') is not True:
            raise ValueError('Confirme que revisou a amostra antes de validar em lote.')
        ok = set(body.get('card_ids') or [])
        if not ok:
            raise ValueError('Nenhum card de confiança alta pendente.')
        for item in cards.values():
            if item['id'] in ok and not item['held']:
                item['validated'] = True
                item['validated_by'] = 'lote-alta-confianca'
    elif action == 'validate_cards':
        # Validar uma coluna da visão por falha (os cards de uma classe).
        ids = set(body.get('card_ids') or [])
        if not ids:
            raise ValueError('Nenhum card para validar.')
        for item in cards.values():
            if item['id'] in ids and not item['held']:
                item['validated'] = True
    elif action == 'validate_all':
        # Confirmação humana explícita: a interface exige que a pessoa digite CONFIRMAR.
        if str(body.get('confirm') or '').strip().upper() != 'CONFIRMAR':
            raise ValueError('Digite CONFIRMAR para validar todos os cards.')
        if any(c['held'] for c in cards.values()):
            raise ValueError('Resolva os itens do sino antes de confirmar tudo.')
        for item in cards.values():
            item['validated'] = True
        for col in columns.values():
            col['validated'] = True
    elif action == 'use_ml':
        # Opcional: o machine learning refaz a classificação dos cards ainda não validados (desligar volta ao catálogo).
        doc['use_ml'] = bool(body.get('on'))
    elif action == 'hold':
        card['held'], card['validated'] = True, False
    elif action == 'move':
        was_validated = column['validated']
        card['column_id'], card['held'], card['validated'] = column['id'], False, was_validated
    elif action == 'add_column':
        fields = {k: str(body.get(k) or '').strip()[:200] for k in ('name', 'unit', 'line')}
        if not all(fields.values()):
            raise ValueError('Preencha nome da peça, unidade e linha.')
        if any(all(c[k].casefold() == fields[k].casefold() for k in fields) for c in columns.values()):
            raise ValueError('Já existe uma coluna para essa peça, unidade e linha.')
        doc['columns'].append({'id': str(uuid4()), **fields, 'validated': False})
    elif action == 'delete_column':
        if any(c['column_id'] == column['id'] and not c['held'] for c in cards.values()):
            raise ValueError('Somente colunas vazias podem ser excluídas.')
        doc['columns'] = [c for c in doc['columns'] if c['id'] != column['id']]
    elif action == 'rename_card':
        name = str(body.get('name') or '').strip()[:500]
        if not name:
            raise ValueError('Informe uma descrição.')
        card['name'], card['validated'] = name, False
    elif action == 'split_card':
        if len(card['record_ids']) < 2:
            raise ValueError('Esse card já contém um único apontamento.')
        records = {r['id']: r for r in doc['records']}
        doc['cards'].remove(card)
        for rid in card['record_ids']:
            doc['cards'].append({**card, 'id': str(uuid4()), 'record_ids': [rid], 'validated': False,
                                 'name': records[rid]['observacao_raw'] or 'Descrição não informada'})
    else:
        raise ValueError('Ação desconhecida.')
    if action in ('reorder', 'set_class'):
        _place(doc, card, body)
    _freeze_classes(doc)
    for col in doc['columns']:
        members = [c for c in doc['cards'] if c['column_id'] == col['id'] and not c['held']]
        if members:
            col['validated'] = all(c['validated'] for c in members)
    doc['revision'] += 1
    doc['updated_at'] = datetime.now().astimezone().isoformat()
    doc['events'].append({'action': action, 'at': doc['updated_at'], 'card': card['name'] if card else None,
                          'column': column['name'] if column else body.get('name'), 'revision': doc['revision'],
                          **({'value': card.get('failure_class') or 'automática'} if action == 'set_class' else {}),
                          **({'value': len(body.get('items') or [])} if action == 'set_classes' else {}),
                          **({'value': len(body.get('card_ids') or [])} if action == 'validate_confident' else {}),
                          **({'value': 'ligado' if doc.get('use_ml') else 'desligado'} if action == 'use_ml' else {})})
    return doc


def _place(doc, card, body):
    """Põe o card logo antes (before_id) ou logo depois (after_id) de outro: a ordem do quadro é a da lista."""
    target = str(body.get('before_id') or body.get('after_id') or '')
    if not target or target == card['id']:
        return
    if not any(c['id'] == target for c in doc['cards']):
        raise ValueError('Card de destino não encontrado. Atualize o quadro.')
    doc['cards'].remove(card)
    index = next(i for i, c in enumerate(doc['cards']) if c['id'] == target)
    doc['cards'].insert(index if body.get('before_id') else index + 1, card)


def _freeze_classes(doc):
    """Ao validar, a classe que o analista viu fica gravada no card: mudanças
    futuras no catálogo ou no aprendizado não alteram o que já foi validado."""
    todo = [c for c in doc['cards'] if c['validated'] and not c['held'] and not c.get('failure_class') and not c.get('validated_class')]
    for c in doc['cards']:
        if not c['validated'] or c.get('failure_class'):
            c.pop('validated_class', None)
    if not todo:
        return
    records = {r['id']: r for r in doc['records']}
    needed = [records[i] for c in todo for i in c['record_ids']]
    details = details_for(needed, catalog(), memory())
    for c in todo:
        c['validated_class'] = card_info(c, details, records, doc.get('use_ml'))['label']


def reduced_records(doc, cat=None, mem=None):
    if doc.get('mode') == 'ml':
        from . import pipeline
        yield from pipeline.records_with_classes(doc)
        return
    cat = cat or catalog()
    mem = memory() if mem is None else mem
    columns = {c['id']: c for c in doc['columns']}
    records = {r['id']: r for r in doc['records']}
    events = event_map(doc)
    pending = [records[i] for c in doc['cards'] if c['validated'] and not c['held']
               and not c.get('failure_class') and not c.get('validated_class') for i in c['record_ids']]
    details = details_for(pending, cat, mem) if pending else {}
    for card in doc['cards']:
        if not card['validated'] or card['held']:
            continue
        col = columns[card['column_id']]
        manual = card.get('failure_class') or card.get('validated_class')
        for rid in card['record_ids']:
            rec = records[rid]
            yield {**rec, 'equipamento': col['name'], 'linha': col['line'], 'centro': col['unit'],
                   'failure_mode': card['name'], 'group_id': card['id'], 'analysis_id': doc['id'],
                   'failure_class': manual or details[rid]['label'],
                   'event_id': events[rid][0], 'os': events[rid][1]}


def select_records(documents, args, prefix=''):
    start, end = args.get(prefix+'from'), args.get(prefix+'to')
    if bool(start) != bool(end):
        raise ValueError('Informe o início e o fim do período.')
    if start:
        date.fromisoformat(start)
        date.fromisoformat(end)
        if start > end:
            raise ValueError('O início deve ser anterior ou igual ao fim.')
    ids = set(filter(None, args.get('ids', '').split(',')))
    selected = [d for d in documents if ready(d) and (not ids or d['id'] in ids)]
    records = []
    cat, mem = catalog(), memory()
    for doc in selected:
        for row in reduced_records(doc, cat, mem):
            if start and not start <= row['data_inicio'] <= end:
                continue
            if any(args.get(param) and row[field] != args.get(param) for param, field in
                   [('unit', 'centro'), ('line', 'linha'), ('failure', 'tipo_parada'), ('machine', 'equipamento'),
                    ('fclass', 'failure_class')]):
                continue
            records.append(row)
    return records


CATEGORIES = ('Crítico-crônico', 'Crítico', 'Crônico', 'Conforto')


def categories_from(args):
    """Filtro de criticidade e recorrência (classes do Jack-Knife)."""
    raw = [c.strip() for c in str(args.get('category') or '').split(',') if c.strip()]
    invalid = [c for c in raw if c not in CATEGORIES]
    if invalid:
        raise ValueError(f'Classificação desconhecida: {invalid[0]}.')
    return set(raw)


def _machine_key(r):
    return '\x1f'.join((r['centro'], r['linha'], r['equipamento']))


COUNT_MODES = ('events', 'lines')


def count_mode(args):
    mode = str(args.get('count') or 'events')
    if mode not in COUNT_MODES:
        raise ValueError('Contagem deve ser "events" (falhas) ou "lines" (linhas do SAP).')
    return mode


def _counter(mode):
    """Q (quantidade) de um conjunto de registros: falhas distintas ou linhas do SAP."""
    if mode == 'lines':
        return len
    return lambda rows: len({r.get('event_id') or (r.get('analysis_id'), r['id']) for r in rows})


def _cat(hq, ht):
    return 'Crítico-crônico' if hq and ht else 'Crítico' if ht else 'Crônico' if hq else 'Conforto'


def _compute(records, thresholds=None, mode='events'):
    count = _counter(mode)
    by_machine = defaultdict(list)
    for r in records:
        by_machine[(r['centro'], r['linha'], r['equipamento'])].append(r)
    machines = []
    for k, rows in by_machine.items():
        q, minutes = count(rows), sum(r['minutos_parada'] for r in rows)
        machines.append({'key': '\x1f'.join(k), 'unit': k[0], 'line': k[1], 'name': k[2], 'count': q,
                         'lines': len(rows), 'minutes': round(minutes, 2), 'mttr': round(minutes/q, 2) if q else 0})
    machines.sort(key=lambda m: (-m['minutes'], m['key']))
    minutes = sum(r['minutos_parada'] for r in records)
    if thresholds:
        q_cut, t_cut = thresholds
    else:
        q_cut = median([m['count'] for m in machines]) if machines else 0
        t_cut = median([m['mttr'] for m in machines]) if machines else 0
    cumulative = 0.0
    for item in machines:
        cumulative += item['minutes']
        item['percent'] = item['minutes']*100/minutes if minutes else 0
        item['cumulative'] = min(100, cumulative*100/minutes) if minutes else 0
        item['category'] = _cat(item['count'] >= q_cut, item['mttr'] >= t_cut)
    if machines and minutes:
        machines[-1]['cumulative'] = 100
    # Base agregada para os gráficos manuais: permite reagrupar por qualquer dimensão.
    groups = defaultdict(list)
    for r in records:
        groups[(r['centro'], r['linha'], r['equipamento'], r['tipo_parada'], r.get('failure_mode') or '',
                r.get('failure_class') or fc.SEM_MODO)].append(r)
    rows = [{'unit': k[0], 'line': k[1], 'machine': k[2], 'failure': k[3], 'mode': k[4], 'klass': k[5],
             'count': count(v), 'lines': len(v), 'minutes': round(sum(r['minutos_parada'] for r in v), 2)}
            for k, v in sorted(groups.items())]
    failures = _failures(records, count)
    for m in machines:
        m['short'] = f"{short_line(m['line'])}_{m['name']}"
    total = count(records)
    events = _counter('events')(records)
    return {'machines': machines, 'q_threshold': q_cut, 'mttr_threshold': t_cut, 'rows': rows, **failures,
            'count_mode': mode,
            'metrics': {'count': total, 'events': events, 'lines': len(records),
                        'with_order': len({r['event_id'] for r in records if r.get('os')}),
                        'minutes': round(minutes, 2), 'mttr': round(minutes/total, 2) if total else 0,
                        'machines': len(machines), 'groups': len({r['group_id'] for r in records}),
                        'days': len({r['data_inicio'] for r in records}), 'analyses': len({r['analysis_id'] for r in records})}}


def _failures(records, count=len):
    """Tabela de falhas (classificação da coluna M) para Pareto/Jack-Knife por falha."""
    by_class = defaultdict(list)
    for r in records:
        by_class[r.get('failure_class') or fc.SEM_MODO].append(r)
    total_min = sum(r['minutos_parada'] for r in records)
    items = []
    for k, rows in by_class.items():
        q, minutes = count(rows), sum(r['minutos_parada'] for r in rows)
        top = Counter(r['equipamento'] for r in rows).most_common(3)
        items.append({'key': k, 'name': fc.pretty(k), 'label': k, 'count': q, 'lines': len(rows),
                      'minutes': round(minutes, 2), 'mttr': round(minutes / q, 2) if q else 0,
                      'machines': [{'name': n, 'lines': c} for n, c in top]})
    items.sort(key=lambda m: (-m['minutes'], m['key']))
    q_cut = median([m['count'] for m in items]) if items else 0
    t_cut = median([m['mttr'] for m in items]) if items else 0
    cumulative = 0.0
    for m in items:
        cumulative += m['minutes']
        m['percent'] = m['minutes'] * 100 / total_min if total_min else 0
        m['cumulative'] = min(100, cumulative * 100 / total_min) if total_min else 0
        m['category'] = _cat(m['count'] >= q_cut, m['mttr'] >= t_cut)
    return {'failures': items, 'f_q_threshold': q_cut, 'f_mttr_threshold': t_cut}


def compute(records, categories=None, mode='events'):
    """Indicadores do conjunto. Com filtro de criticidade, a classificação usa os
    cortes (medianas) do conjunto completo e os totais passam a considerar só as
    máquinas das classes escolhidas."""
    base = _compute(records, mode=mode)
    base['categories'] = {c: sum(m['category'] == c for m in base['machines']) for c in CATEGORIES}
    base['category_filter'] = sorted(categories or [], key=CATEGORIES.index)
    base['total_machines'] = len(base['machines'])
    if not categories:
        return base
    keys = {m['key'] for m in base['machines'] if m['category'] in categories}
    result = _compute([r for r in records if _machine_key(r) in keys], (base['q_threshold'], base['mttr_threshold']), mode)
    return result | {k: base[k] for k in ('categories', 'category_filter', 'total_machines')}


def options(documents):
    cat, mem = catalog(), memory()
    rows = [r for d in documents for r in reduced_records(d, cat, mem)]
    return {key: sorted({r[field] for r in rows}) for key, field in
            [('units', 'centro'), ('lines', 'linha'), ('failures', 'tipo_parada'), ('days', 'data_inicio'),
             ('machines', 'equipamento'), ('classes', 'failure_class')]}


def compare(documents, args):
    if not args.get('from') or not args.get('to'):
        raise ValueError('Selecione o período B.')
    b_rows = select_records(documents, args)
    start, end = date.fromisoformat(args['from']), date.fromisoformat(args['to'])
    days = (end - start).days + 1
    previous = dict(args)
    previous['from'] = args.get('a_from') or (start - timedelta(days=days)).isoformat()
    previous['to'] = args.get('a_to') or (start - timedelta(days=1)).isoformat()
    a_rows = select_records(documents, previous)
    categories, mode = categories_from(args), count_mode(args)
    a, b = compute(a_rows, categories, mode), compute(b_rows, categories, mode)
    # União de chaves inclui equipamentos que caíram a zero no período B.
    amap, bmap = ({m['key']: m for m in result['machines']} for result in (a, b))
    changes = []
    for key in sorted(amap.keys() | bmap.keys()):
        ma, mb = amap.get(key), bmap.get(key)
        ca, cb = (ma or {}).get('count', 0), (mb or {}).get('count', 0)
        changes.append({**(mb or ma), 'before': ca, 'after': cb, 'delta': cb-ca,
                        'percentage': round((cb-ca)*100/ca, 2) if ca else None,
                        'direction': 'new' if not ca else 'down' if cb < ca else 'up' if cb > ca else 'same'})
    changes.sort(key=lambda c: (-abs(c['delta']), c['key']))
    return {'a': a, 'b': b, 'changes': changes, 'period_a': {'from': previous['from'], 'to': previous['to']},
            'period_b': {'from': args['from'], 'to': args['to']},
            'days_a': (date.fromisoformat(previous['to']) - date.fromisoformat(previous['from'])).days + 1, 'days_b': days}
