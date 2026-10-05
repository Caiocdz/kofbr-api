"""Aprendizado de máquina local (scikit-learn): a ferramenta aprende o contexto
com o que o analista já validou.

Como funciona
- Exemplos de treino: cada apontamento de um card VALIDADO (relato + máquina →
  classe final do card, seja a automática confirmada ou a escolhida pelo
  analista) e cada relato da memória de correções (peso maior).
- Modelo: TF-IDF de palavras (1-2 gramas) + TF-IDF de pedaços de palavras
  (3 a 5 letras, tolera erro de digitação: "rolamneto") + a máquina como contexto,
  com Regressão Logística (treinada por gradiente estocástico). Tudo roda no PC, sem internet e sem IA externa.
- Uso: quando o catálogo não reconhece o relato, o modelo sugere a classe pelo
  contexto (palavras vizinhas, máquina, jeito de escrever da equipe). Quando o
  catálogo acha uma classe, o modelo confirma (sobe a confiança) ou discorda
  (desce para média, para o analista olhar).
- Retreina sozinho depois de validações e correções; o modelo fica salvo em
  data/aprendizado.joblib.
"""
import hashlib
import json
import os
import threading
import time
from collections import Counter
from pathlib import Path

from . import classify as fc

MIN_EXAMPLES = 20
MODEL_WINS = 0.6   # certeza mínima para o modelo trocar a classe do catálogo
MATURE = 200      # ...e só depois de aprender com pelo menos 200 relatos validados
_lock = threading.Lock()
_state = {'model': None, 'fingerprint': None, 'info': None, 'cache': {}, 'training': False}


def _path():
    base = Path(os.environ.get('KOFBR_DATA_DIR', Path(__file__).resolve().parents[1] / 'data'))
    base.mkdir(parents=True, exist_ok=True)
    return base / 'aprendizado.joblib'


def _history_path():
    return _path().with_name('aprendizado_historico.json')


def history():
    """Evolução do acerto a cada treino: [{at, accuracy, examples, classes}] (mais antigo primeiro)."""
    try:
        data = json.loads(_history_path().read_text(encoding='utf-8'))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _record_history(info):
    """Guarda um ponto por versão do modelo (mesmos exemplos = mesmo ponto)."""
    if info.get('accuracy') is None:
        return
    items = history()
    point = {'at': info['trained_at'], 'accuracy': info['accuracy'], 'examples': info['examples'],
             'classes': info['classes'], 'version': info['version']}
    if items and items[-1].get('version') == point['version']:
        items[-1] = point
    else:
        items.append(point)
    try:
        _history_path().write_text(json.dumps(items[-40:], ensure_ascii=False), encoding='utf-8')
    except Exception:
        pass


def _text_only(doc):
    return ' '.join(w for w in doc.split() if not w.startswith('MAQ_'))


def _signal(text):
    """Palavras do relato que dizem algo sobre a falha (sem ordem, número e palavras genéricas)."""
    generic = {'ORDEM', 'MANUTENCAO', 'REALIZADO', 'REALIZADA', 'AJUSTE', 'AJUSTES', 'FALHA', 'PROBLEMA', 'MAQUINA',
               'PARADA', 'AGUARDANDO', 'ELETRICA', 'MECANICA', 'NA', 'NO', 'DE', 'DA', 'DO', 'EM', 'COM', 'E', 'N'}
    return [w for w in fc.normalize(text).split() if len(w) > 2 and not w.isdigit() and w not in generic]


def _doc(text, machine):
    # A máquina entra como palavra de contexto ("MAQ_ENCHEDORA").
    words = ' '.join(f'MAQ_{w}' for w in fc.normalize(machine).split() if len(w) > 2 and not w.isdigit())
    return f'{fc.normalize(text)} {words}'.strip()


def examples(documents, memory, card_class, extra=None):
    """(texto, máquina, classe, peso) a partir do que já foi validado por pessoas.
    `extra`: (texto, classe) das planilhas classificadas pelos analistas (tela "Planilha resumida")."""
    out = {}
    for text, label in extra or ():
        key = fc.memory_key(text)
        if key and label and label not in fc.UNCLASSIFIED:
            out[(key, '+')] = (text, '', label, 2)
    for doc in documents:
        records = {r['id']: r for r in doc['records']}
        columns = {c['id']: c for c in doc['columns']}
        for card in doc['cards']:
            if not card.get('validated') or card.get('held'):
                continue
            label = card_class(doc, card)
            if not label or label in fc.UNCLASSIFIED:
                continue
            machine = columns.get(card['column_id'], {}).get('name', '')
            weight = 3 if card.get('failure_class') else 1
            for rid in card['record_ids']:
                text = records[rid].get('observacao_raw')
                if not fc.memory_key(text):
                    continue
                key = (fc.memory_key(text), fc.normalize(machine))
                out[key] = (text, machine, label, max(weight, out.get(key, (0, 0, 0, 0))[3]))
    for key, item in (memory or {}).items():
        if item.get('label') and item['label'] not in fc.UNCLASSIFIED:
            out[(key, '*')] = (key, '', item['label'], 3)
    return list(out.values())


def _fingerprint(rows):
    return hashlib.sha1(json.dumps(sorted(rows), ensure_ascii=False, default=str).encode()).hexdigest()


def _build():
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import SGDClassifier
    from sklearn.pipeline import make_pipeline, make_union
    features = make_union(
        TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True, token_pattern=r'(?u)\b\w+\b'),
        # Pedaços de palavra só do relato (a máquina não entra aqui para não dominar).
        TfidfVectorizer(analyzer='char_wb', ngram_range=(3, 5), min_df=1, sublinear_tf=True, preprocessor=_text_only),
    )
    # Regressão logística treinada por gradiente estocástico: mesma ideia, ~10x mais rápida.
    return make_pipeline(features, SGDClassifier(loss='log_loss', alpha=1e-5, max_iter=60, tol=1e-4, random_state=0, n_jobs=-1))


def train(rows, force=False):
    """Treina (ou reaproveita) o modelo para estes exemplos."""
    fingerprint = _fingerprint(rows)
    if not force and _state['fingerprint'] == fingerprint and _state['model'] is not None:
        return _state['info']
    labels = Counter(r[2] for r in rows)
    # Classe com um único exemplo não se generaliza (o relato exato já está na memória) e cada
    # classe custa um classificador a mais: com as planilhas das unidades são centenas delas.
    if len(rows) >= 200:
        rows = [r for r in rows if labels[r[2]] >= 2]
        labels = Counter(r[2] for r in rows)
    if len(rows) < MIN_EXAMPLES or len(labels) < 2:
        with _lock:
            _state.update(model=None, fingerprint=fingerprint, cache={}, info={
                'ready': False, 'examples': len(rows), 'classes': len(labels), 'min_examples': MIN_EXAMPLES,
                'trained_at': None, 'accuracy': None, 'version': fingerprint[:8]})
        return _state['info']
    started = time.time()
    X = [_doc(t, m) for t, m, _, _ in rows]
    y = [lab for _, _, lab, _ in rows]
    w = [wt for _, _, _, wt in rows]
    accuracy = None
    if len(rows) >= 60:
        # Acerto estimado: treina com 80% e mede nos 20% que o modelo não viu.
        import random
        idx = list(range(len(rows)))
        random.Random(7).shuffle(idx)
        cut = int(len(idx) * 0.8)
        tr, te = idx[:cut], idx[cut:]
        if len({y[i] for i in tr}) >= 2:
            probe = _build()
            probe.fit([X[i] for i in tr], [y[i] for i in tr], sgdclassifier__sample_weight=[w[i] for i in tr])
            pred = probe.predict([X[i] for i in te])
            accuracy = round(sum(p == y[i] for p, i in zip(pred, te)) * 100 / len(te), 1)
    model = _build()
    model.fit(X, y, sgdclassifier__sample_weight=w)
    info = {'ready': True, 'examples': len(rows), 'classes': len(labels), 'min_examples': MIN_EXAMPLES,
            'trained_at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'accuracy': accuracy, 'version': fingerprint[:8],
            'seconds': round(time.time() - started, 2),
            'top_classes': [{'label': k, 'examples': v} for k, v in labels.most_common(8)]}
    with _lock:
        _state.update(model=model, fingerprint=fingerprint, info=info, cache={})
    _record_history(info)
    try:
        import joblib
        joblib.dump({'model': model, 'fingerprint': fingerprint, 'info': info}, _path())
    except Exception:
        pass
    return info


def load():
    """Carrega o modelo salvo (início do servidor)."""
    if _state['model'] is not None or _state['info'] is not None:
        return
    try:
        import joblib
        saved = joblib.load(_path())
        _state.update(model=saved['model'], fingerprint=saved['fingerprint'], info=saved['info'], cache={})
    except Exception:
        pass


def info():
    load()
    base = _state['info'] or {'ready': False, 'examples': 0, 'classes': 0, 'min_examples': MIN_EXAMPLES,
                              'trained_at': None, 'accuracy': None, 'version': None}
    return base | {'history': history(), 'measure_min': 60}


def predict_many(pairs):
    """{(texto, máquina): (classe, probabilidade)} em lote (rápido)."""
    load()
    model = _state['model']
    if model is None:
        return {}
    cache = _state['cache']
    todo = [p for p in dict.fromkeys(pairs) if p not in cache and fc.memory_key(p[0])]
    if todo:
        proba = model.predict_proba([_doc(t, m) for t, m in todo])
        classes = model.classes_
        for pair, row in zip(todo, proba):
            best = int(row.argmax())
            cache[pair] = (str(classes[best]), float(row[best]))
    return {p: cache[p] for p in pairs if p in cache}


def refine(base, prediction, text=''):
    """Junta a resposta do catálogo com a do modelo aprendido."""
    if not prediction or base['source'] == 'memoria' or base['label'] == fc.SEM_DESCRICAO:
        return base
    label, p = prediction
    pct = f'{p * 100:.0f}%'
    if base['label'] == fc.SEM_MODO:
        if p >= 0.6 and len(_signal(text)) >= 1:
            return {**base, 'label': label, 'confidence': 'alta' if p >= 0.92 else 'media', 'source': 'aprendizado',
                    'reason': f'O catálogo não reconheceu; o aprendizado reconheceu pelo contexto de relatos já validados ({pct} de certeza).'}
        return base
    if label == base['label']:
        if base['confidence'] == 'media' and p >= 0.7:
            return {**base, 'confidence': 'alta', 'reason': base['reason'] + f' O aprendizado confirma ({pct}).'}
        return base
    # Modelo maduro e confiante vence o catálogo. Medido num teste cego com 1.020 relatos de Marília
    # (padrão do descritivo): catálogo 75%, lógica antiga 78%, modelo vencendo com 60%+ de certeza 87%.
    if p >= MODEL_WINS and (_state['info'] or {}).get('examples', 0) >= MATURE:
        return {**base, 'label': label, 'confidence': 'alta' if p >= 0.9 else 'media', 'source': 'aprendizado',
                'suggestion': base['label'],
                'reason': f'O aprendizado reconheceu pelo histórico validado ({pct} de certeza); '
                          f'o catálogo sugeria {fc.pretty(base["label"]).lower()}.'}
    if p >= 0.75:
        return {**base, 'confidence': 'media', 'suggestion': label,
                'reason': base['reason'] + f' Pelo histórico validado, parece {fc.pretty(label).lower()} ({pct}).'}
    return base


_timer = {'t': None}


def retrain_in_background(build_rows, delay=20.0):
    """Retreina sem travar a tela: espera o analista parar de clicar por ~20 s
    (cada nova validação adia o treino) e treina numa thread separada."""
    def run():
        if _state['training']:
            return
        _state['training'] = True
        try:
            train(build_rows())
        except Exception:
            pass
        finally:
            _state['training'] = False
    if _timer['t']:
        _timer['t'].cancel()
    _timer['t'] = threading.Timer(delay, run)
    _timer['t'].daemon = True
    _timer['t'].start()


def reset():
    with _lock:
        _state.update(model=None, fingerprint=None, info=None, cache={}, training=False)
    for path in (_path(), _history_path()):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
