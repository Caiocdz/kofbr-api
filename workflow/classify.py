"""Classificação automática das falhas (coluna M · Observações).

Segue o descritivo do projeto: o texto livre do operador é reduzido à
manifestação essencial da falha, por exemplo "FALHA DE SENSOR" ou
"FALHA DE VÁLVULA DE ENCHIMENTO", desconsiderando o restante do relato.

Como funciona (100% local, sem IA generativa):
1. Normaliza o texto: maiúsculas, sem acentos, sem números de ordem (O.S.).
2. Procura no catálogo, nesta ordem de prioridade:
   - regras específicas (ex.: VÁLVULA + ENCHIMENTO/NÍVEL, ou válvula numa enchedora);
   - componentes (sensor, rolamento, eixo, motor, drive, parafuso…), o primeiro
     citado no texto vence e a classe é "FALHA DE <componente>": "rolamento
     quebrado" e "rolamento estourado" caem juntos em FALHA DE ROLAMENTO. A
     manifestação (quebra, espanamento, vazamento) fica só como detalhe;
   - processos/sistemas (enchimento, rotulagem, envolvimento, sincronismo…).
3. Texto vazio (ou só o número da ordem) → "SEM DESCRIÇÃO".
   Nada reconhecido → "SEM MODO DE FALHA IDENTIFICADO" (análise manual, item 1.4).

O catálogo é editável na tela do quadro e fica salvo no banco.
"""
import copy
import difflib
import json
import re
import unicodedata
from functools import lru_cache

SEM_DESCRICAO = 'SEM DESCRIÇÃO'
SEM_MODO = 'SEM MODO DE FALHA IDENTIFICADO'
UNCLASSIFIED = (SEM_DESCRICAO, SEM_MODO)

# kind: "regra" (classe fixa, prioridade máxima), "componente" (recebe o prefixo
# da manifestação) ou "processo" (classe fixa, usada se nenhum componente aparece).
# "terms": qualquer um dispara · "with": exige também um destes termos no texto ·
# "machine": alternativa ao "with", procurada no nome da máquina (chave do parada).
DEFAULT_CATALOG = {
    'version': 1,
    'manifestations': {
        'QUEBRA': ['QUEBR', 'ROMP', 'PARTI', 'TRINC', 'RASGAD', 'ESTOUR', 'ARREBENT'],
        'ESPANAMENTO': ['ESPAN'],
        'VAZAMENTO': ['VAZAMENT', 'VAZAND', 'VAZOU'],
    },
    'classes': [
        {'label': 'FALHA DE VÁLVULA MODULADORA', 'kind': 'regra', 'terms': ['VALVULA MODULADORA', 'VALVULAS MODULADORAS']},
        {'label': 'FALHA DE VÁLVULA DE ENCHIMENTO', 'kind': 'regra', 'terms': ['VALVULA', 'VAVULA', 'VALVULAS'],
         'with': ['ENCHIMENTO', 'NIVEL', 'AGULHA', 'ORING', 'O RING', 'PINO DE COMANDO', 'PINOS DE COMANDO', 'BORBOLETA'],
         'machine': ['ENCHEDORA', 'ENCHEDOR', 'FILLER']},
        {'label': 'FALHA DE CORTE DE FILME', 'kind': 'regra', 'terms': ['CORTE DO FILME', 'CORTE DE FILME', 'CORTE FILME', 'CORTADOR DO FILME', 'CORTADOR DE FILME'],
         'with': []},
        {'label': 'QUEDA DE GARRAFAS', 'kind': 'processo', 'terms': ['QUEDA', 'QUEDAS', 'CAIDA', 'CAINDO', 'TOMBAMENTO', 'TOMBANDO'],
         'with': ['GARRAF', 'PET', 'LATA', 'COPO']},
        {'label': 'FALHA NA FORMAÇÃO DE PACOTE', 'kind': 'processo', 'terms': ['PACOTE', 'PACOTES'],
         'with': ['FROUX', 'FORMACAO', 'FORMANDO', 'MAL FORMAD']},
        {'label': 'FALHA NA FORMAÇÃO DE CAMADA', 'kind': 'processo', 'terms': ['CAMADA', 'CAMADAS'],
         'with': ['FORMACAO', 'CONTAGEM', 'FORMAR', 'MA FORMACAO']},
        {'label': 'SENSOR', 'kind': 'componente', 'terms': ['SENSOR', 'SENSORES', 'FOTOCELULA', 'CELULA FOTOELETRICA', 'FOTOELETRIC']},
        {'label': 'FIM DE CURSO', 'kind': 'componente', 'terms': ['FIM DE CURSO', 'CHAVE FIM']},
        {'label': 'ROLAMENTO', 'kind': 'componente', 'terms': ['ROLAMENT', 'MANCAL', 'MANCAIS']},
        {'label': 'EIXO', 'kind': 'componente', 'terms': ['EIXO']},
        {'label': 'MOLA', 'kind': 'componente', 'terms': ['MOLA']},
        {'label': 'VENTOSA', 'kind': 'componente', 'terms': ['VENTOSA']},
        {'label': 'PINÇA', 'kind': 'componente', 'terms': ['PINCA']},
        {'label': 'PINO', 'kind': 'componente', 'terms': ['PINO']},
        {'label': 'IHM', 'kind': 'componente', 'terms': ['IHM', 'TELA TOUCH', 'PAINEL DE OPERACAO']},
        {'label': 'PARAFUSO', 'kind': 'componente', 'terms': ['PARAFUS', 'PORCA']},
        {'label': 'PATINS', 'kind': 'componente', 'terms': ['PATIN']},
        {'label': 'CORREIA', 'kind': 'componente', 'terms': ['CORREIA', 'CINTA']},
        {'label': 'CORRENTE', 'kind': 'componente', 'terms': ['CORRENTE DE TRANSMISSAO', 'CORRENTE']},
        {'label': 'ENGRENAGEM', 'kind': 'componente', 'terms': ['ENGRENAGE', 'REDUTOR', 'MOTORREDUTOR']},
        {'label': 'SERVOMOTOR', 'kind': 'componente', 'terms': ['SERVO']},
        {'label': 'MOTOR', 'kind': 'componente', 'terms': ['MOTOR']},
        {'label': 'DRIVE', 'kind': 'componente', 'terms': ['DRIVE']},
        {'label': 'INVERSOR', 'kind': 'componente', 'terms': ['INVERSOR']},
        {'label': 'ENCODER', 'kind': 'componente', 'terms': ['ENCODER']},
        {'label': 'DISJUNTOR', 'kind': 'componente', 'terms': ['DISJUNTOR', 'DIJUNTOR', 'DISJUNTO']},
        {'label': 'CLP', 'kind': 'componente', 'terms': ['CLP', 'PLC']},
        {'label': 'CABO / CONECTOR', 'kind': 'componente', 'terms': ['CABO', 'CONECTOR', 'CONEXAO ELETRICA']},
        {'label': 'CILINDRO / PISTÃO', 'kind': 'componente', 'terms': ['CILINDRO', 'PISTAO']},
        {'label': 'VÁLVULA', 'kind': 'componente', 'terms': ['VALVULA', 'VAVULA', 'ELETROVALVULA', 'SOLENOIDE']},
        {'label': 'BOMBA', 'kind': 'componente', 'terms': ['BOMBA']},
        {'label': 'DATADOR', 'kind': 'componente', 'terms': ['DATADOR', 'VIDEOJET', 'CODIFICADOR', 'CODIFICADORA', 'MARKEM']},
        {'label': 'DOSADOR', 'kind': 'componente', 'terms': ['DOSADOR', 'BICO DOSADOR']},
        {'label': 'ESTEIRA', 'kind': 'componente', 'terms': ['ESTEIRA', 'TRANSPORTADOR']},
        {'label': 'GUIA', 'kind': 'componente', 'terms': ['GUIA']},
        {'label': 'ESTRELA', 'kind': 'componente', 'terms': ['ESTRELA']},
        {'label': 'LÂMINA', 'kind': 'componente', 'terms': ['LAMINA', 'FACA']},
        {'label': 'MOLDE', 'kind': 'componente', 'terms': ['MOLDE']},
        {'label': 'BICO', 'kind': 'componente', 'terms': ['BICO']},
        {'label': 'BOIA', 'kind': 'componente', 'terms': ['BOIA']},
        {'label': 'PRESSOSTATO', 'kind': 'componente', 'terms': ['PRESSOSTATO']},
        {'label': 'RESISTÊNCIA', 'kind': 'componente', 'terms': ['RESISTENCIA', 'LAMPADA']},
        {'label': 'VEDAÇÃO', 'kind': 'componente', 'terms': ['ORING', 'O RING', 'VEDACAO', 'RETENTOR', 'GAXETA']},
        {'label': 'BARRA', 'kind': 'componente', 'terms': ['BARRA']},
        {'label': 'ESCOVA', 'kind': 'componente', 'terms': ['ESCOVA']},
        {'label': 'TALISCA', 'kind': 'componente', 'terms': ['TALISCA']},
        {'label': 'RASPADOR', 'kind': 'componente', 'terms': ['RASPADOR']},
        {'label': 'FREIO', 'kind': 'componente', 'terms': ['FREIO']},
        {'label': 'PORTA', 'kind': 'componente', 'terms': ['PORTA']},
        {'label': 'MAGAZINE', 'kind': 'componente', 'terms': ['MAGAZINE']},
        {'label': 'EMPURRADOR', 'kind': 'componente', 'terms': ['EMPURRADOR']},
        {'label': 'ELEVADOR', 'kind': 'componente', 'terms': ['ELEVADOR']},
        {'label': 'DISTRIBUIDOR', 'kind': 'componente', 'terms': ['DISTRIBUIDOR', 'DITRIBUIDOR']},
        {'label': 'FILME', 'kind': 'componente', 'terms': ['FILME', 'STRETCH']},
        {'label': 'CARTONEIRO', 'kind': 'componente', 'terms': ['CARTONEIRO', 'FOLHA SEPARADORA', 'PEGA FOLHA', 'FOLHA']},
        {'label': 'INTRODUTOR', 'kind': 'componente', 'terms': ['INTRODUTOR']},
        {'label': 'RÉGUA', 'kind': 'componente', 'terms': ['REGUA']},
        {'label': 'BOBINA', 'kind': 'componente', 'terms': ['BOBINA', 'DESBOBINADOR', 'ROLINHO']},
        {'label': 'HASTE', 'kind': 'componente', 'terms': ['HASTE']},
        {'label': 'MANGUEIRA', 'kind': 'componente', 'terms': ['MANGUEIRA', 'TUBO DE AR', 'CONEXAO']},
        {'label': 'COMPRESSOR', 'kind': 'componente', 'terms': ['COMPRESSOR']},
        {'label': 'FILTRO', 'kind': 'componente', 'terms': ['FILTRO']},
        {'label': 'RELÉ', 'kind': 'componente', 'terms': ['RELE', 'CONTATORA', 'CONTATOR']},
        {'label': 'MACAQUINHO', 'kind': 'componente', 'terms': ['MACAQUINHO', 'MACACO']},
        {'label': 'ARTICULADOR', 'kind': 'componente', 'terms': ['ARTICULADOR']},
        {'label': 'BUFFER', 'kind': 'componente', 'terms': ['BUFFER', 'FIFO']},
        {'label': 'FUNIL', 'kind': 'componente', 'terms': ['FUNIL']},
        {'label': 'VIBRADOR', 'kind': 'componente', 'terms': ['VIBRADOR']},
        {'label': 'GRAPA', 'kind': 'componente', 'terms': ['GRAPA']},
        {'label': 'CATRACA', 'kind': 'componente', 'terms': ['CATRACA']},
        {'label': 'MEMBRANA', 'kind': 'componente', 'terms': ['MEMBRANA', 'BORRACHA']},
        {'label': 'FALHA DE INSPEÇÃO', 'kind': 'processo', 'terms': ['INSPETOR', 'INSPECAO', 'INSPECIONAR', 'DETECTOR', 'METAL', 'REJEIT']},
        {'label': 'FALHA DE TAMPAS', 'kind': 'processo', 'terms': ['TAMPA', 'CAPSULA', 'CAPSULADOR', 'ROSQUEAMENTO']},
        {'label': 'FALHA DE NITROGÊNIO', 'kind': 'processo', 'terms': ['NITROGENIO', 'N2', 'DOSAGEM']},
        {'label': 'FALHA DE NÍVEL DO TANQUE', 'kind': 'processo', 'terms': ['NIVEL DO TANQUE', 'NIVEL TANQUE', 'TANQUE']},
        {'label': 'FALHA DE CARBONATAÇÃO / CO2', 'kind': 'processo', 'terms': ['CARBONATA', 'CO2']},
        {'label': 'FALHA DE LUBRIFICAÇÃO', 'kind': 'processo', 'terms': ['LUBRIFICA']},
        {'label': 'FALTA DE ÁGUA', 'kind': 'processo', 'terms': ['FALTA DE AGUA', 'SEM AGUA']},
        {'label': 'FALHA DE ENCHIMENTO', 'kind': 'processo', 'terms': ['ENCHIMENTO', 'NIVEL BAIXO', 'NIVEL ALTO']},
        {'label': 'FALHA DE ROTULAGEM', 'kind': 'processo', 'terms': ['ROTULAGEM', 'ROTULO', 'ROTULAND', 'ETIQUETA', 'DEMASIADA', 'COLEIRO', 'COLA']},
        {'label': 'FALHA DE ENVOLVIMENTO', 'kind': 'processo', 'terms': ['ENVOLVIMENTO', 'ENVOLVEDORA']},
        {'label': 'FALHA DE ESTIRAMENTO', 'kind': 'processo', 'terms': ['ESTIRAMENTO']},
        {'label': 'FALHA DE SELAGEM', 'kind': 'processo', 'terms': ['SELAGEM', 'SELADOR', 'SELO']},
        {'label': 'FALHA DE CODIFICAÇÃO', 'kind': 'processo', 'terms': ['CODIFICACAO', 'IMPRESSAO']},
        {'label': 'FALHA DE SOPRO / PRÉ-FORMA', 'kind': 'processo', 'terms': ['PRE FORMA', 'PREFORMA', 'SOPRO']},
        {'label': 'FALHA DE TEMPERATURA', 'kind': 'processo', 'terms': ['TEMPERATURA', 'FORNO', 'AQUECIMENTO']},
        {'label': 'FALHA DE VÁCUO', 'kind': 'processo', 'terms': ['VACUO']},
        {'label': 'FALHA DE AR COMPRIMIDO', 'kind': 'processo', 'terms': ['AR COMPRIMIDO', 'PRESSAO DE AR', 'BAIXA PRESSAO', 'PNEUMATIC']},
        {'label': 'FALHA DE SEGURANÇA', 'kind': 'processo', 'terms': ['SEGURANCA', 'EMERGENCIA', 'SIS', 'BARREIRA']},
        {'label': 'PERDA DE SINCRONISMO', 'kind': 'processo', 'terms': ['SINCRONISMO', 'SINCRONIS', 'REFERENCIA', 'PONTO ZERO', 'PONTO 0']},
        {'label': 'FALHA DE TRANSFERÊNCIA', 'kind': 'processo', 'terms': ['TRANSFERENCIA', 'TRANSICAO', 'TRANSPORTE']},
        {'label': 'FALHA DE COMUNICAÇÃO', 'kind': 'processo', 'terms': ['COMUNICACAO', 'REDE PROFIBUS', 'PROFINET']},
        {'label': 'FALHA ELÉTRICA', 'kind': 'processo', 'terms': ['CURTO CIRCUITO', 'FALHA ELETRICA', 'QUEIMAD', 'QUEIMOU', 'FUSIVEL']},
        {'label': 'TORQUE', 'kind': 'processo', 'terms': ['TORQUE']},
        {'label': 'ENROSCO', 'kind': 'processo', 'terms': ['ENROSC', 'ENRROSC', 'ENGASG', 'OBSTRU', 'ENTUP', 'ATOLAMENT']},
    ],
}

_ORDER = re.compile(r'\b\d{5,}\b')
_NOISE = re.compile(r'\b(ORDEM|OS|O S|NOTA|N|NO|NUMERO DA ORDEM|AGUARDANDO|MIN)\b')
_PUNCT = re.compile(r'[^A-Z0-9 ]')
_SPACES = re.compile(r'\s+')


def normalize(text):
    text = unicodedata.normalize('NFKD', str(text or '').upper()).encode('ascii', 'ignore').decode()
    text = _ORDER.sub(' ', text.replace('º', ' ').replace('°', ' '))
    text = _PUNCT.sub(' ', text)
    return _SPACES.sub(' ', text).strip()


def _meaningful(text):
    """Há relato além do número da ordem e de palavras de preenchimento?"""
    rest = _SPACES.sub(' ', _NOISE.sub(' ', re.sub(r'\b\d+\b', ' ', text))).strip()
    return len(rest) >= 3


def _pattern(term):
    # Termo como prefixo de palavra: "ROLAMENT" casa ROLAMENTO e ROLAMENTOS.
    return re.compile(r'\b' + re.escape(normalize(term)).replace(r'\ ', r'\s+'))


class Classifier:
    def __init__(self, catalog):
        self.catalog = catalog
        self.classes = []
        for item in catalog.get('classes', []):
            terms = [t for t in item.get('terms', []) if normalize(t)]
            if not item.get('label') or not terms:
                continue
            self.classes.append({
                'label': item['label'].strip().upper(), 'kind': item.get('kind', 'componente'),
                'terms': [_pattern(t) for t in terms],
                'with': [_pattern(t) for t in item.get('with', []) if normalize(t)],
                'machine': [_pattern(t) for t in item.get('machine', []) if normalize(t)],
            })
        self.manifestations = {k: [_pattern(t) for t in v] for k, v in catalog.get('manifestations', {}).items()}
        vocab = set()
        for item in catalog.get('classes', []):
            for t in item.get('terms', []) + item.get('with', []):
                vocab.update(w for w in normalize(t).split() if len(w) >= 6)
        self.vocab = sorted(vocab)

    def _fix_typos(self, text):
        out = []
        for word in text.split():
            if len(word) >= 6 and not any(word.startswith(v) for v in self.vocab):
                best, score = None, 0.84
                for v in self.vocab:
                    if v[0] != word[0] or abs(len(v) - len(word)) > 3:
                        continue
                    r = max(difflib.SequenceMatcher(None, word, v).ratio(),
                            difflib.SequenceMatcher(None, word[:len(v)], v).ratio())
                    if r >= score:
                        best, score = v, r
                word = best or word
            out.append(word)
        return ' '.join(out)

    def _first(self, patterns, text):
        positions = [m.start() for p in patterns for m in [p.search(text)] if m]
        return min(positions) if positions else None

    def classify(self, text, machine=''):
        return self.explain(text, machine)['label']

    def explain(self, text, machine=''):
        """Classe + confiança + motivo, para o analista entender e revisar.

        alta  → regra específica, ou um único item do catálogo encontrado
        média → mais de um candidato no texto, ou termo achado por correção de digitação
        baixa → nada reconhecido (fila de revisão humana)
        """
        norm = normalize(text)
        if not norm or not _meaningful(norm):
            return {'label': SEM_DESCRICAO, 'confidence': 'baixa', 'source': 'nenhum',
                    'reason': 'Relato vazio ou só com o número da ordem.', 'detail': ''}
        fixed = self._fix_typos(norm)
        typo = fixed != norm
        machine_norm = normalize(machine)
        found = {'regra': [], 'componente': [], 'processo': []}
        for item in self.classes:
            pos = self._first(item['terms'], fixed)
            if pos is None:
                continue
            if item['with'] or item['machine']:
                ok = (item['with'] and self._first(item['with'], fixed) is not None) or \
                     (item['machine'] and self._first(item['machine'], machine_norm) is not None)
                if not ok:
                    continue
            found.setdefault(item['kind'], []).append((pos, item))
        def note(item):
            # Só avisa a correção quando ela foi necessária para achar o termo.
            return ' (com correção de digitação)' if typo and self._first(item['terms'], norm) is None else ''
        if found['regra']:
            pos, item = min(found['regra'], key=lambda x: x[0])
            typo_note = note(item)
            return {'label': item['label'], 'confidence': 'media' if typo_note else 'alta', 'source': 'regra',
                    'reason': f'Regra específica do catálogo: {self._term(item, fixed, norm)}{typo_note}.', 'detail': ''}
        # Vale o item citado primeiro no relato; em empate, o componente.
        pool = [(pos, 0 if item['kind'] == 'componente' else 1, item) for pos, item in found['componente'] + found['processo']]
        if not pool:
            return {'label': SEM_MODO, 'confidence': 'baixa', 'source': 'nenhum',
                    'reason': 'Nenhum termo do catálogo no relato.', 'detail': ''}
        pos, _, item = min(pool, key=lambda x: (x[0], x[1]))
        others = sorted({it['label'] for _, _, it in pool if it is not item})
        typo_note = note(item)
        conf = 'media' if typo_note or others else 'alta'
        extra = f"; também cita {', '.join(o.lower() for o in others[:3])}" if others else ''
        if item['kind'] != 'componente':
            return {'label': item['label'], 'confidence': conf, 'source': 'processo',
                    'reason': f'Processo citado: {self._term(item, fixed, norm)}{extra}{typo_note}.', 'detail': ''}
        comps = sorted(p for p, _ in found['componente'])
        detail = self._manifestation(fixed, pos, comps)
        return {'label': f"FALHA DE {item['label']}", 'confidence': conf, 'source': 'componente',
                'reason': f"Componente citado: {self._term(item, fixed, norm)}{extra}{typo_note}.",
                'detail': '' if detail == 'FALHA' else detail.lower()}

    def _term(self, item, text, original=None):
        # Devolve a palavra como o operador escreveu (o texto corrigido tem as mesmas posições de palavra).
        words = (original or text).split()
        for p in item['terms']:
            m = p.search(text)
            if m:
                first = text[:m.start()].count(' ')
                last = first + m.group(0).count(' ')
                return ' '.join(words[first:last + 1]).lower()
        return item['label'].lower()

    def _manifestation(self, text, pos, comps):
        # A manifestação (quebra, espanamento, vazamento) é do componente mais
        # próximo a ela no texto, e só vale se estiver bem perto (~3 palavras).
        for name, patterns in self.manifestations.items():
            for pattern in patterns:
                for m in pattern.finditer(text):
                    nearest = min(comps, key=lambda c: (abs(c - m.start()), c < m.start()))
                    if nearest == pos and abs(pos - m.start()) <= 22:
                        return name
        return 'FALHA'

    def labels(self):
        out = []
        for item in self.classes:
            if item['kind'] == 'componente':
                out.append(f"FALHA DE {item['label']}")
            else:
                out.append(item['label'])
        return sorted(set(out)) + list(UNCLASSIFIED)


_cache = {'key': None, 'classifier': None}


def classifier_for(catalog):
    key = json.dumps(catalog, sort_keys=True, ensure_ascii=False)
    if _cache['key'] != key:
        _cache['key'], _cache['classifier'] = key, Classifier(catalog)
        _explain_cached.cache_clear()
    return _cache['classifier']


@lru_cache(maxsize=65536)
def _explain_cached(text, machine):
    return _cache['classifier'].explain(text, machine)


def explain(text, machine, catalog, memory=None):
    """Explicação completa. A memória (correções do analista) vence o catálogo."""
    if memory:
        key = memory_key(text)
        hit = memory.get(key) if key else None
        if hit:
            return {'label': hit['label'], 'confidence': 'alta', 'source': 'memoria', 'detail': '',
                    'reason': f"Mesmo relato já corrigido pelo analista ({hit.get('count', 1)}x)."}
    classifier_for(catalog)
    return dict(_explain_cached(str(text or ''), str(machine or '')))


def classify(text, machine, catalog, memory=None):
    return explain(text, machine, catalog, memory)['label']


def memory_key(text):
    """Chave da memória: relato normalizado, sem O.S., acentos e pontuação."""
    norm = normalize(text)
    return norm if norm and _meaningful(norm) else ''


def default_catalog():
    return copy.deepcopy(DEFAULT_CATALOG)


def pretty(label):
    """Rótulo de exibição: 'FALHA DE SENSOR' → 'Falha de sensor'."""
    text = (label or '').strip().lower()
    return text[:1].upper() + text[1:]
