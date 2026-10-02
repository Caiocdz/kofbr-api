"""
Calculos que alimentam os dois graficos do desafio:

1. Pareto de falhas por Linha & Equipamento (como no print 'ALVO')
2. Jack-Knife / Critico-Cronico:
     - nivel 1: por equipamento dentro de uma linha (MTTR x numero de falhas)
     - nivel 2 (drill-down): por MODO DE FALHA dentro de um equipamento --
       aqui e onde a deduplicacao (canonical_failure) importa de verdade,
       porque sem ela a mesma falha escrita de formas diferentes apareceria
       como varias linhas na tabela em vez de uma so.
"""
from collections import defaultdict


def compute_pareto(records, group_by="equipamento"):
    """
    records: lista de dicts com {linha, equipamento, minutos_parada}
    Agrupa por (linha, equipamento) por padrao -- pode agrupar so por
    equipamento se quiser visao cross-linha.
    Retorna lista ordenada por Tempo desc, com % e % acumulado (padrao Pareto).
    """
    totals = defaultdict(lambda: {"tempo": 0.0, "falhas": 0})

    for r in records:
        minutos = r.get("minutos_parada") or 0
        if group_by == "equipamento":
            key = (r.get("linha"), r.get("equipamento"))
        else:
            key = (r.get("linha"),)
        totals[key]["tempo"] += minutos
        totals[key]["falhas"] += 1

    grand_total = sum(v["tempo"] for v in totals.values()) or 1.0

    rows = []
    for key, agg in totals.items():
        if group_by == "equipamento":
            linha, equipamento = key
        else:
            linha, equipamento = key[0], None
        rows.append({
            "linha": linha,
            "equipamento": equipamento,
            "tempo_min": round(agg["tempo"], 2),
            "falhas": agg["falhas"],
            "pct_total": round(100 * agg["tempo"] / grand_total, 2),
        })

    rows.sort(key=lambda r: -r["tempo_min"])

    acumulado = 0.0
    for r in rows:
        acumulado += r["pct_total"]
        r["pct_acumulado"] = round(acumulado, 2)

    return rows


def _median(values):
    s = sorted(values)
    n = len(s)
    if n == 0:
        return 0
    mid = n // 2
    if n % 2 == 1:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2


def _classify_quadrant(q, mttr, q_threshold, mttr_threshold):
    """
    Eixo X = frequencia (Q, numero de falhas) -> ALTA freq = CRONICO
    Eixo Y = impacto (MTTR)                    -> ALTO impacto = CRITICO
    """
    alta_freq = q >= q_threshold
    alto_impacto = mttr >= mttr_threshold

    if alta_freq and alto_impacto:
        return "CRITICO-CRONICO"
    if alto_impacto and not alta_freq:
        return "CRITICO"
    if alta_freq and not alto_impacto:
        return "CRONICO"
    return "CONFORTO"


def compute_jackknife_by_equipamento(records):
    """
    Nivel 1: um ponto por (linha, equipamento).
    T = soma dos minutos de parada ; Q = numero de falhas ; MTTR = T / Q
    Classifica em CRITICO / CRONICO / CRITICO-CRONICO / CONFORTO usando a
    mediana de Q e a mediana de MTTR do proprio conjunto como linhas de corte
    (o mesmo principio visual do grafico Jack-Knife: os limiares dividem o
    plano em 4 quadrantes).
    """
    agg = defaultdict(lambda: {"tempo": 0.0, "falhas": 0})
    for r in records:
        key = (r.get("linha"), r.get("equipamento"))
        agg[key]["tempo"] += r.get("minutos_parada") or 0
        agg[key]["falhas"] += 1

    points = []
    for (linha, equipamento), v in agg.items():
        q = v["falhas"]
        mttr = v["tempo"] / q if q else 0
        points.append({"linha": linha, "equipamento": equipamento,
                        "T": round(v["tempo"], 2), "Q": q, "MTTR": round(mttr, 2)})

    if not points:
        return {"points": [], "q_threshold": 0, "mttr_threshold": 0}

    q_threshold = _median([p["Q"] for p in points])
    mttr_threshold = _median([p["MTTR"] for p in points])

    for p in points:
        p["categoria"] = _classify_quadrant(p["Q"], p["MTTR"], q_threshold, mttr_threshold)

    points.sort(key=lambda p: -p["T"])
    return {"points": points, "q_threshold": q_threshold, "mttr_threshold": mttr_threshold}


def compute_jackknife_by_modo_falha(records, linha, equipamento):
    """
    Nivel 2 (drill-down dentro de um equipamento): um ponto por MODO DE FALHA.
    Usa canonical_failure_id quando existe (registro ja confirmado/deduplicado);
    cai para observacao_normalizada quando ainda nao foi confirmado, e para
    'SEM MODO DE FALHA IDENTIFICADO' quando a observacao esta vazia --
    exatamente a categoria que aparece nos exemplos do time da Tais.
    """
    filtered = [r for r in records if r.get("linha") == linha and r.get("equipamento") == equipamento]

    agg = defaultdict(lambda: {"tempo": 0.0, "falhas": 0})
    for r in filtered:
        label = (r.get("canonical_failure_name")
                 or r.get("observacao_normalizada")
                 or "SEM MODO DE FALHA IDENTIFICADO")
        agg[label]["tempo"] += r.get("minutos_parada") or 0
        agg[label]["falhas"] += 1

    points = []
    for label, v in agg.items():
        q = v["falhas"]
        mttr = v["tempo"] / q if q else 0
        points.append({"modo_falha": label, "T": round(v["tempo"], 2),
                        "Q": q, "MTTR": round(mttr, 2)})

    if not points:
        return {"points": [], "q_threshold": 0, "mttr_threshold": 0}

    q_threshold = _median([p["Q"] for p in points])
    mttr_threshold = _median([p["MTTR"] for p in points])
    for p in points:
        p["categoria"] = _classify_quadrant(p["Q"], p["MTTR"], q_threshold, mttr_threshold)

    points.sort(key=lambda p: -p["T"])
    return {"points": points, "q_threshold": q_threshold, "mttr_threshold": mttr_threshold}
