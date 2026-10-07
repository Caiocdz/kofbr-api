"""
Motor de deduplicacao/normalizacao de descricoes de falha.

Importante: nao usa nenhum modelo de IA generativa/agente externo
(atende a restricao "so Copilot" da KOF). A similaridade semantica
aproximada e obtida por:

  1. Normalizacao de texto (maiusculas, remove numeros de ordem, pontuacao)
  2. Dicionario de sinonimos tecnicos (configuravel) -> resolve casos tipo
     "rolamento estourado" vs "rolamento quebrado"
  3. Correcao aproximada de erros de ortografia via difflib (stdlib),
     comparando cada token com um vocabulario de termos conhecidos
  4. Vetorizacao TF-IDF (scikit-learn, roda 100% local) + similaridade
     de cosseno para agrupar (clustering aglomerativo)

O resultado e uma PROPOSTA de agrupamento -- nunca aplicada
automaticamente. Precisa ser confirmada por um humano (ver routes/clusters.py).

Agrupamento sem limite de membros, com compressão de descrições idênticas
antes da comparação. Não há cortes arbitrários entre lotes de registros.
"""
import re
import difflib
from functools import lru_cache


# ---------------------------------------------------------------------------
# 1) Dicionario de sinonimos tecnicos. Facil de estender conforme o time
#    de manutencao for mapeando mais variacoes de vocabulario usadas no chao
#    de fabrica. Chave = forma canonica, valores = variacoes observadas.
# ---------------------------------------------------------------------------
SYNONYM_GROUPS = {
    "QUEBRADO": ["QUEBRADO", "QUEBROU", "ESTOURADO", "ESTOUROU", "PARTIDO",
                 "TRINCADO", "ROMPIDO", "ARREBENTADO"],
    "DESGASTADO": ["DESGASTADO", "GASTO", "DESGASTE"],
    "TRAVADO": ["TRAVADO", "TRAVANDO", "EMPERRADO", "EMPERRANDO", "PRESO"],
    "VAZAMENTO": ["VAZAMENTO", "VAZANDO", "VAZOU"],
    "SENSOR": ["SENSOR", "SENSORES", "CELULA FOTOELETRICA", "FOTOCELULA"],
    "ROLAMENTO": ["ROLAMENTO", "ROLAMENTOS", "MANCAL", "MANCAIS"],
    "ESTEIRA": ["ESTEIRA", "CORREIA", "TRANSPORTADOR"],
    "DESALINHADO": ["DESALINHADO", "DESALINHAMENTO", "FORA DE POSICAO",
                     "DESLOCADO", "DESLOCAMENTO"],
    "FALHA_ELETRICA": ["CURTO CIRCUITO", "CURTO-CIRCUITO", "QUEIMOU",
                        "QUEIMADO", "FALHA ELETRICA"],
    "PACOTE_FROUXO": ["PACOTE FROUXO", "PACOTES FROUXOS", "MAL FORMADO",
                       "MAL FORMADOS", "FORMACAO RUIM"],
    "OBSTRUCAO": ["ENTUPIMENTO", "ENTUPIDO", "OBSTRUIDO", "OBSTRUCAO",
                   "ENROSCO", "ENROSCADO"],
}

# indice reverso: variacao -> forma canonica (tudo em maiusculo)
_VARIATION_TO_CANON = {}
for canon, variations in SYNONYM_GROUPS.items():
    for v in variations:
        _VARIATION_TO_CANON[v.upper()] = canon

# vocabulario "conhecido" usado na correcao aproximada de ortografia
_KNOWN_VOCAB = sorted(set(_VARIATION_TO_CANON.keys()) |
                      {w for phrase in _VARIATION_TO_CANON for w in phrase.split()})

STOPWORDS = {
    "DE", "DA", "DO", "DOS", "DAS", "NO", "NA", "NOS", "NAS", "EM", "COM",
    "E", "OU", "A", "O", "AS", "OS", "AO", "PARA", "POR", "DEVIDO", "QUE",
}

_ORDER_NUM_RE = re.compile(r"\b\d{5,}\b")          # numeros de ordem SAP (5+ digitos)
_PARENS_RE = re.compile(r"\(([^)]*)\)")
_PUNCT_RE = re.compile(r"[^\wÀ-ÿ\s]")
_MULTISPACE_RE = re.compile(r"\s+")


def _strip_order_numbers(text: str) -> str:
    # remove numeros de ordem tipo "30008216805", tanto soltos quanto entre parenteses
    text = _PARENS_RE.sub(lambda m: "" if _ORDER_NUM_RE.search(m.group(1)) else m.group(0), text)
    text = _ORDER_NUM_RE.sub("", text)
    return text


def _fuzzy_correct_token(token: str, cutoff: float = 0.88) -> str:
    """Corrige pequenos erros de ortografia comparando com o vocabulario
    conhecido (difflib, stdlib -- nenhuma chamada externa).

    Cutoff 0.88 (era 0.82) para reduzir falsos positivos com nomes de
    equipamentos que se parecem fonicamente com termos do dicionario.
    Tokens curtos (< 5 chars) sao ignorados para evitar substituicoes
    acidentais em siglas e codigos.
    """
    if token in _KNOWN_VOCAB or len(token) < 5:
        return token
    match = difflib.get_close_matches(token, _KNOWN_VOCAB, n=1, cutoff=cutoff)
    return match[0] if match else token


@lru_cache(maxsize=16384)
def normalize_observation(raw_text: str) -> str:
    """Pipeline completo de normalizacao de uma observacao livre."""
    if not raw_text:
        return ""
    text = raw_text.upper()
    text = _strip_order_numbers(text)
    text = _PUNCT_RE.sub(" ", text)
    text = _MULTISPACE_RE.sub(" ", text).strip()

    tokens = [t for t in text.split(" ") if t and t not in STOPWORDS]
    corrected = [_fuzzy_correct_token(t) for t in tokens]

    # aplica sinonimos por token e tambem tenta por frases de 2-3 palavras
    joined = " ".join(corrected)
    for variation, canon in sorted(_VARIATION_TO_CANON.items(), key=lambda x: -len(x[0])):
        joined = re.sub(r"\b" + re.escape(variation) + r"\b", canon, joined)

    joined = _MULTISPACE_RE.sub(" ", joined).strip()
    return joined


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------
CONTEXT_FIELDS = (
    "centro", "linha", "equipamento", "tipo_parada", "subchave_parada", "sistema",
)


def _context_value(value):
    """Normaliza valores estruturados usados para separar contextos."""
    return _MULTISPACE_RE.sub(" ", str(value or "").upper()).strip()


def _context_key(record):
    """Um grupo so pode conter apontamentos do mesmo contexto operacional.

    Linha e equipamento sao obrigatorios porque, sem eles, uma celula vazia
    na planilha viraria um balde gigante de falsos positivos. Os demais
    campos, quando preenchidos, tambem precisam ser iguais.
    """
    linha = _context_value(record.get("linha"))
    equipamento = _context_value(record.get("equipamento"))
    if not linha or not equipamento:
        return None
    return tuple(_context_value(record.get(field)) for field in CONTEXT_FIELDS)


def propose_clusters(records, distance_threshold: float = 0.20,
                     min_cluster_size: int = 2, max_bucket_size=None):
    """Compatibilidade com a API anterior, sem dividir grupos em lotes.

    O argumento max_bucket_size continua aceito para clientes antigos, mas
    não limita os membros. O mesmo motor sem cortes do novo quadro é usado.
    """
    from workflow.importer import group_records
    prepared = []
    for record in records:
        if _context_key(record) is None:
            continue
        prepared.append({**{k: "" for k in CONTEXT_FIELDS}, **record})
    if not prepared:
        return []
    columns, cards = group_records(prepared, min_similarity=1-distance_threshold)
    by_column = {column["id"]: column for column in columns}
    return [{"linha": by_column[card["column_id"]]["line"],
             "equipamento": by_column[card["column_id"]]["name"],
             "suggested_name": card["name"],
             "member_record_ids": card["record_ids"],
             "avg_similarity": card["avg_similarity"]}
            for card in cards if len(card["record_ids"]) >= min_cluster_size]
