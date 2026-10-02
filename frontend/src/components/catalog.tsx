"use client";
import { useEffect, useMemo, useState } from "react";
import { api, prettyClass } from "@/lib/radar";
import { Icon, Modal, Loading, ErrorNotice } from "./ui";

type Kind = "regra" | "componente" | "processo";
type Entry = { label: string; kind: Kind; terms: string[]; with?: string[]; machine?: string[] };
type Catalog = { version: number; classes: Entry[]; manifestations: Record<string, string[]> };

const kinds: [Kind, string, string][] = [
  ["regra", "Regra específica", "Prioridade máxima. Ex.: válvula + enchimento → Falha de válvula de enchimento."],
  ["componente", "Componente", "Item citado no texto. Vira “Falha de X”, ou “Quebra / Espanamento / Vazamento de X”."],
  ["processo", "Processo / sistema", "Usado quando o relato cita um processo (enchimento, rotulagem…)."],
];
const list = (v: string) =>
  v
    .split(/[,;\n]/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
const display = (e: Entry) => (e.kind === "componente" ? `FALHA DE ${e.label}` : e.label);

export default function CatalogEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [sample, setSample] = useState("FALHA NO SENSOR DE SAIDA DE PALETES ( 30008224349 )");
  const [machine, setMachine] = useState("");
  const [result, setResult] = useState("");
  useEffect(() => {
    api<{ catalog: Catalog; custom: boolean }>("/catalog")
      .then((r) => {
        setCatalog(r.catalog);
        setCustom(r.custom);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!catalog || !sample.trim()) return;
    const t = setTimeout(() => {
      api<{ results: { class: string }[] }>("/catalog/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalog, texts: [sample], machine }),
      })
        .then((r) => setResult(r.results[0]?.class || ""))
        .catch((e) => setResult(`Erro: ${e.message}`));
    }, 250);
    return () => clearTimeout(t);
  }, [catalog, sample, machine]);
  const shown = useMemo(
    () =>
      (catalog?.classes || [])
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => `${e.label} ${e.terms.join(" ")}`.toLowerCase().includes(search.toLowerCase())),
    [catalog, search],
  );
  const update = (i: number, patch: Partial<Entry>) =>
    setCatalog((c) => c && { ...c, classes: c.classes.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  async function save() {
    if (!catalog) return;
    setBusy(true);
    setError("");
    try {
      await api("/catalog", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(catalog) });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    try {
      const r = await api<{ catalog: Catalog; custom: boolean }>("/catalog", { method: "DELETE" });
      setCatalog(r.catalog);
      setCustom(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Catálogo de classes de falha" wide onClose={onClose}>
      {!catalog ? (
        error ? <ErrorNotice message={error} /> : <Loading />
      ) : (
        <div className="catalog">
          <p className="helper">
            O sistema lê a coluna M (Observações) e enquadra cada relato numa classe, desconsiderando o restante do texto
            (item 1.3 do descritivo). Ajuste os termos abaixo para ensinar novas variações de escrita. O que não se
            encaixar fica como <b>Sem modo de falha identificado</b> e aparece em destaque no quadro para análise manual.
            {custom ? " Este catálogo foi personalizado." : " Este é o catálogo padrão."}
          </p>
          <div className="catalog-test">
            <label className="field">
              <span>Testar um relato</span>
              <input value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Cole um texto da coluna M" />
            </label>
            <label className="field small">
              <span>Máquina (opcional)</span>
              <input value={machine} onChange={(e) => setMachine(e.target.value)} placeholder="ENCHEDORA…" />
            </label>
            <div className={`catalog-result ${result.startsWith("SEM") ? "warn" : ""}`}>
              <small>Classe</small>
              <b>{result ? prettyClass(result) : "—"}</b>
            </div>
          </div>
          <div className="catalog-bar">
            <label className="search-box">
              <Icon name="search" size={16} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar classe ou termo…" />
            </label>
            <span className="count-pill">{catalog.classes.length} classes</span>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => {
                setCatalog({ ...catalog, classes: [{ label: "NOVO COMPONENTE", kind: "componente", terms: [] }, ...catalog.classes] });
                setOpen(0);
                setSearch("");
              }}
            >
              <Icon name="plus" size={14} />
              Nova classe
            </button>
          </div>
          <div className="catalog-list">
            {shown.map(({ e, i }) => (
              <article key={i} className={`catalog-item ${open === i ? "open" : ""}`}>
                <button type="button" className="catalog-head" onClick={() => setOpen(open === i ? null : i)}>
                  <span className={`kind-tag ${e.kind}`}>{kinds.find((k) => k[0] === e.kind)?.[1]}</span>
                  <b>{prettyClass(display(e))}</b>
                  <small>{e.terms.slice(0, 5).join(", ").toLowerCase()}{e.terms.length > 5 ? "…" : ""}</small>
                  <Icon name="chevron" size={14} />
                </button>
                {open === i && (
                  <div className="catalog-body">
                    <label className="field">
                      <span>Nome {e.kind === "componente" ? "do componente" : "da classe"}</span>
                      <input value={e.label} onChange={(ev) => update(i, { label: ev.target.value.toUpperCase() })} />
                    </label>
                    <label className="field">
                      <span>Tipo</span>
                      <select value={e.kind} onChange={(ev) => update(i, { kind: ev.target.value as Kind })}>
                        {kinds.map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="b-note">{kinds.find((k) => k[0] === e.kind)?.[2]}</p>
                    <label className="field wide">
                      <span>Termos que identificam (separados por vírgula; vale o início da palavra)</span>
                      <textarea rows={2} defaultValue={e.terms.join(", ")} onBlur={(ev) => update(i, { terms: list(ev.target.value) })} />
                    </label>
                    {e.kind !== "componente" && (
                      <>
                        <label className="field wide">
                          <span>…e também precisa conter um destes (opcional)</span>
                          <textarea rows={2} defaultValue={(e.with || []).join(", ")} onBlur={(ev) => update(i, { with: list(ev.target.value) })} />
                        </label>
                        <label className="field wide">
                          <span>…ou a máquina (chave do parada) conter (opcional)</span>
                          <input defaultValue={(e.machine || []).join(", ")} onBlur={(ev) => update(i, { machine: list(ev.target.value) })} />
                        </label>
                      </>
                    )}
                    <button
                      type="button"
                      className="text-btn danger"
                      onClick={() => {
                        setCatalog({ ...catalog, classes: catalog.classes.filter((_, k) => k !== i) });
                        setOpen(null);
                      }}
                    >
                      <Icon name="trash" size={14} />
                      Remover classe
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          <ErrorNotice message={error} />
          <footer className="builder-footer">
            <button type="button" className="text-btn" disabled={busy} onClick={() => void reset()}>
              <Icon name="reset" size={15} />
              Restaurar catálogo padrão
            </button>
            <button type="button" className="btn secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
              <Icon name="check" size={16} />
              Salvar e reclassificar
            </button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
