"""Stable fingerprints for comparing imported spreadsheet content."""

import hashlib
import json
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


SOURCE_FIELDS = (
    "centro",
    "data_inicio",
    "linha",
    "tipo_parada",
    "material",
    "ordem",
    "descricao_material",
    "turno",
    "intervalo",
    "equipamento",
    "subchave_parada",
    "sistema",
    "observacao_raw",
    "operador",
    "pts_efic_perdidos",
    "pts_acumulados",
    "caixas_produzidas",
    "total_minutos",
    "minutos_parada",
)

NUMERIC_FIELDS = frozenset({
    "pts_efic_perdidos",
    "pts_acumulados",
    "caixas_produzidas",
    "total_minutos",
    "minutos_parada",
})


def _normalize_value(field, value):
    if value is None:
        return None
    if field == "data_inicio":
        if isinstance(value, datetime):
            return value.strftime("%Y-%m-%d %H:%M:%S")
        if isinstance(value, date):
            return value.strftime("%Y-%m-%d")
        return str(value).strip().replace("T", " ")
    if field in NUMERIC_FIELDS:
        try:
            number = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError):
            return str(value).strip()
        return format(number, ".2f")
    return str(value).strip()


def fingerprint_records(records):
    """Hash the source rows as a multiset so row order and XLSX metadata do not matter."""
    row_fingerprints = []
    for record in records:
        values = [_normalize_value(field, record.get(field)) for field in SOURCE_FIELDS]
        canonical = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
        row_fingerprints.append(hashlib.sha256(canonical.encode("utf-8")).digest())

    row_fingerprints.sort()
    content_hash = hashlib.sha256()
    for row_fingerprint in row_fingerprints:
        content_hash.update(row_fingerprint)
    return content_hash.hexdigest()
