"use client";
/* Gerar planilha de apontamentos: o modelo de ML preenche a coluna
   "Classificação Manual Analista" (classe padronizada + detalhe sugerido),
   mostra quanto dá para confiar nele (acurácia medida nos 20% de teste) e
   deixa o analista revisar as previsões — cada revisão volta para o treino. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiUrl, fmt, queryString } from "@/lib/radar";
import { Icon, Heading, ErrorNotice, Loading } from "./ui";
import { BANDS, Cleaning, ModelQuality, pct, type Band, type Faixa, type ModelInfo } from "./ml-shared";

type Prediction = {
  classe: string;
  detalhe: string;
  confianca: number | null;
  faixa: Faixa;
};
type Result = {
  id: string;
  filename: string;
  sheet: string;
  rows: number;
  filled: number;
  unique: number;
  counts: Record<Faixa | "Preenchida" | "Sem relato", number>;
  expected_accuracy: number | null;
  preview: (Prediction & { linha: number; relato: string; alternativas: { classe: string; confianca: number }[] })[];
  model: ModelInfo;
};
type RunSummary = {
  id: string;
  filename: string;
  created_at: string;
  rows: number;
  unique: number;
  reviewed: number;
  pending_low: number;
};
type Item = Prediction & {
  key: string;
  relato: string;
  n_linhas: number;
  linhas: number[];
  status: "pendente" | "confirmado" | "corrigido" | "revisado";
  top3: { classe: string; confianca: number }[];
};
type Draft = { acao: "confirmar" | "corrigir"; classe: string; detalhe: string };

const cap = (s: string) => (s ? s[0] + s.slice(1).toLowerCase() : s);

function Generate({ ready, onDone, onReview }: { ready: boolean; onDone: (r: Result) => void; onReview: (id: string) => void }) {
  const [file, setFile] = useState<File>();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result>();
  const [filter, setFilter] = useState<"" | Faixa>("");
  const ref = useRef<HTMLInputElement>(null);
  function choose(candidate?: File) {
    if (!candidate || busy) return;
    setError("");
    if (!/\.(xlsx|xlsm)$/i.test(candidate.name)) return setError("Selecione uma planilha .xlsx ou .xlsm.");
    if (candidate.size > 50 * 1024 * 1024) return setError("O arquivo excede 50 MB.");
    setFile(candidate);
    setResult(undefined);
  }
  async function process() {
    if (!file) return;
    setBusy(true);
    setError("");
    const body = new FormData();
    body.append("file", file);
    try {
      const r = await api<Result>("/ml/fill", { method: "POST", body });
      setResult(r);
      setFilter("");
      onDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const rows = result?.preview.filter((r) => !filter || r.faixa === filter) || [];
  const download = result && apiUrl(`/api/workspace/ml/fill/${result.id}?nome=${encodeURIComponent(result.filename)}`);
  return (
    <>
      <section className="panel import-main">
        <button
          type="button"
          className={`drop-zone ${drag ? "over" : ""} ${file ? "selected" : ""}`}
          disabled={busy}
          onClick={() => ref.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            choose(e.dataTransfer.files[0]);
          }}
        >
          <span className="upload-glyph">
            <Icon name={file ? "file" : "upload"} size={32} />
          </span>
          <b>{file ? file.name : "Arraste a planilha de apontamentos"}</b>
          <span>
            {file
              ? `${(file.size / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} MB · pronta para classificar`
              : "ou clique para procurar no computador"}
          </span>
          <small>XLSX ou XLSM · precisa da coluna “Observações” · até 50 MB</small>
        </button>
        <input
          ref={ref}
          className="sr-only"
          type="file"
          accept=".xlsx,.xlsm"
          aria-label="Selecionar planilha"
          onChange={(e) => choose(e.target.files?.[0])}
          disabled={busy}
        />
        <ErrorNotice message={error} />
        <button className="btn primary import-submit" disabled={!file || busy || !ready} onClick={() => void process()}>
          {busy ? (
            <>
              <span className="spinner" />
              Classificando…
            </>
          ) : (
            <>
              Gerar planilha classificada <Icon name="arrow" size={18} />
            </>
          )}
        </button>
        {busy && (
          <div className="import-working" role="status">
            <div className="processing-line" />
            <p>Lendo os relatos e preenchendo a classificação. Planilhas grandes (90 mil linhas) levam cerca de 1 minuto.</p>
          </div>
        )}
      </section>

      {result && (
        <section className="panel ml-result" aria-label="Resultado">
          <header className="ml-result-head">
            <div>
              <span className="eyebrow">RESULTADO · ABA {result.sheet.toUpperCase()}</span>
              <h2>
                {fmt(result.filled)} de {fmt(result.rows)} linhas classificadas
              </h2>
              <p>
                {fmt(result.unique)} relatos diferentes · acerto estimado nesta planilha: <b>{pct(result.expected_accuracy)}</b>
                <small> (acerto de cada faixa no teste × linhas em cada faixa)</small>
              </p>
            </div>
            <div className="ml-result-actions">
              <button className="btn secondary" onClick={() => onReview(result.id)}>
                <Icon name="checks" size={17} />
                Revisar agora
              </button>
              <a className="btn primary" href={download} download={result.filename}>
                <Icon name="download" size={17} />
                Baixar planilha
              </a>
            </div>
          </header>
          <div className="ml-dist" role="img" aria-label="Linhas por faixa de confiança">
            {(["Analista", ...BANDS] as Faixa[]).map((b) =>
              result.counts[b] ? (
                <i key={b} className={`band-${b}`} style={{ flexGrow: result.counts[b] }} title={`${b}: ${fmt(result.counts[b])} linhas`} />
              ) : null,
            )}
          </div>
          <div className="queue-tabs ml-filter" role="radiogroup" aria-label="Filtrar prévia por confiança">
            <button role="radio" aria-checked={!filter} className={!filter ? "on" : ""} onClick={() => setFilter("")}>
              Todas <span>{fmt(result.rows)}</span>
            </button>
            {(["Analista", ...BANDS] as Faixa[])
              .filter((b) => result.counts[b] > 0)
              .map((b) => (
                <button key={b} role="radio" aria-checked={filter === b} className={filter === b ? "on" : ""} onClick={() => setFilter(filter === b ? "" : b)}>
                  <i className={`dot band-${b}`} />
                  {b} <span>{fmt(result.counts[b])}</span>
                </button>
              ))}
            {result.counts["Preenchida"] > 0 && <span className="helper">{fmt(result.counts["Preenchida"])} já estavam preenchidas (mantidas)</span>}
          </div>
          <div className="table-scroll ml-table">
            <table>
              <thead>
                <tr>
                  <th>Linha</th>
                  <th>Observações</th>
                  <th>Classificação Manual Analista</th>
                  <th>Detalhe sugerido</th>
                  <th>Confiança</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.linha}>
                    <td className="seq">{r.linha}</td>
                    <td className="ml-text">{r.relato}</td>
                    <td
                      className="ml-text"
                      title={r.alternativas.length ? `Outras opções: ${r.alternativas.map((a) => `${a.classe} (${fmt(a.confianca, 1)}%)`).join("; ")}` : undefined}
                    >
                      <b>{r.classe || "—"}</b>
                    </td>
                    <td className="ml-text">{r.detalhe || "—"}</td>
                    <td>
                      <span className={`ml-band band-${r.faixa}`}>
                        <i />
                        {r.confianca == null ? r.faixa : `${fmt(r.confianca, 0)}%`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="helper">
            Prévia das primeiras {fmt(result.preview.length)} linhas. A planilha completa vem com a classe (cor por faixa),
            “Detalhe sugerido”, “Confiança do modelo (%)” e “Faixa de confiança”.
          </p>
        </section>
      )}
    </>
  );
}

function ReviewRow({
  item,
  draft,
  details,
  onDraft,
}: {
  item: Item;
  draft?: Draft;
  details: Record<string, string[]>;
  onDraft: (d: Draft | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const done = item.status !== "pendente";
  const classe = draft?.classe ?? item.classe;
  const detalhe = draft?.detalhe ?? item.detalhe;
  const listId = `det-${item.key.slice(0, 40).replace(/\W/g, "_")}`;
  return (
    <li className={`ml-review-row ${draft ? `draft-${draft.acao}` : ""} ${done && !draft ? "done" : ""}`}>
      <div className="ml-review-text">
        <p>{item.relato}</p>
        <small>
          {fmt(item.n_linhas)} {item.n_linhas === 1 ? "linha" : "linhas"} na planilha
          {done && !draft && ` · ${item.status === "corrigido" ? "corrigido" : "confirmado"} pelo analista`}
        </small>
      </div>
      <div className="ml-review-pred">
        <span className={`ml-band band-${draft ? "Analista" : item.faixa}`}>
          <i />
          {draft ? (draft.acao === "confirmar" ? "Confirmado" : "Corrigido") : item.confianca == null ? item.faixa : `${fmt(item.confianca, 0)}%`}
        </span>
        {editing ? (
          <div className="ml-edit">
            <input list="ml-classes" aria-label="Classe correta" value={classe} autoFocus onChange={(e) => onDraft({ acao: "corrigir", classe: e.target.value, detalhe })} placeholder="FALHA DE …" />
            <input list={listId} aria-label="Detalhe" value={detalhe} onChange={(e) => onDraft({ acao: "corrigir", classe, detalhe: e.target.value })} placeholder="Detalhe (opcional)" />
            <datalist id={listId}>
              {(details[classe.trim().toUpperCase()] || []).map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>
        ) : (
          <>
            <b>{classe}</b>
            {detalhe && <small>{detalhe}</small>}
          </>
        )}
        {!editing && !done && item.top3.length > 1 && (
          <div className="ml-alts">
            {item.top3.slice(1).map((a) => (
              <button key={a.classe} type="button" title="Usar esta classe" onClick={() => onDraft({ acao: "corrigir", classe: a.classe, detalhe: "" })}>
                {cap(a.classe)} · {fmt(a.confianca, 0)}%
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="ml-review-actions">
        <button
          type="button"
          className={`mg-check ${draft?.acao === "confirmar" ? "complete" : ""}`}
          title="A previsão está certa"
          aria-label={`Confirmar: ${item.relato}`}
          onClick={() => {
            setEditing(false);
            onDraft(draft?.acao === "confirmar" ? null : { acao: "confirmar", classe: item.classe, detalhe: item.detalhe });
          }}
        >
          <Icon name="check" size={14} />
        </button>
        <button
          type="button"
          className={`icon-btn ${editing ? "on" : ""}`}
          title="Corrigir a classe"
          aria-label={`Corrigir: ${item.relato}`}
          onClick={() => {
            setEditing(!editing);
            if (!editing && !draft) onDraft({ acao: "corrigir", classe: item.classe, detalhe: item.detalhe });
          }}
        >
          <Icon name="pencil" size={14} />
        </button>
        {draft && (
          <button type="button" className="icon-btn" title="Desfazer" aria-label="Desfazer" onClick={() => { setEditing(false); onDraft(null); }}>
            <Icon name="reset" size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

function Review({ runId, onRun, onSaved }: { runId: string; onRun: (id: string) => void; onSaved: () => void }) {
  const [runs, setRuns] = useState<RunSummary[]>();
  const [data, setData] = useState<{ run: RunSummary; total: number; page: number; size: number; items: Item[] }>();
  const [options, setOptions] = useState<{ classes: string[]; details: Record<string, string[]> }>({ classes: [], details: {} });
  const [filters, setFilters] = useState({ faixa: "", status: "pendente", q: "", page: 1 });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    api<RunSummary[]>("/ml/runs")
      .then((list) => {
        setRuns(list);
        if (!runId && list[0]) onRun(list[0].id);
      })
      .catch((e) => setError(e.message));
    api<{ classes: string[]; details: Record<string, string[]> }>("/ml/classes").then(setOptions).catch(() => {});
  }, [runId, onRun]);
  const load = useCallback(async () => {
    if (!runId) return;
    setError("");
    try {
      setData(await api(`/ml/runs/${runId}/items?${queryString(filters)}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId, filters]);
  useEffect(() => {
    const t = setTimeout(() => void load(), filters.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, filters.q]);
  const pending = Object.entries(drafts).filter(([, d]) => d.classe.trim());
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ saved: number; run: RunSummary }>(`/ml/runs/${runId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: pending.map(([key, d]) => ({ key, ...d })) }),
      });
      setDrafts({});
      setNotice(`${fmt(r.saved)} relato(s) salvos e adicionados ao treino. O modelo será atualizado em instantes.`);
      setRuns((list) => list?.map((x) => (x.id === r.run.id ? r.run : x)));
      onSaved();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!runs) return <Loading />;
  if (!runs.length)
    return (
      <section className="panel ml-result">
        <p className="helper">Nenhuma planilha gerada ainda. Gere uma planilha na aba “Gerar planilha” para revisar as previsões.</p>
      </section>
    );
  const run = data?.run || runs.find((r) => r.id === runId);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  return (
    <section className="panel ml-result ml-review" aria-label="Revisar previsões">
      <header className="ml-result-head">
        <label className="ml-run-select">
          <span className="eyebrow">PLANILHA</span>
          <select value={runId} onChange={(e) => { setDrafts({}); onRun(e.target.value); }}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.filename} · {new Date(r.created_at).toLocaleString("pt-BR")}
              </option>
            ))}
          </select>
        </label>
        {run && (
          <a className="btn secondary small" href={apiUrl(`/api/workspace/ml/fill/${run.id}?nome=${encodeURIComponent(run.filename)}`)}>
            <Icon name="download" size={15} />
            Baixar com as revisões
          </a>
        )}
      </header>
      {run && (
        <div className="ml-progress">
          <div className="progress-track">
            <i style={{ width: `${(run.reviewed / Math.max(run.unique, 1)) * 100}%` }} />
          </div>
          <small>
            {fmt(run.reviewed)} de {fmt(run.unique)} relatos revisados · {fmt(run.pending_low)} pendentes de confiança média ou baixa
          </small>
        </div>
      )}
      <div className="ml-review-filters">
        <div className="queue-tabs ml-filter" role="radiogroup" aria-label="Status">
          {(
            [
              ["pendente", "Pendentes"],
              ["", "Todos"],
              ["corrigido", "Corrigidos"],
              ["confirmado", "Confirmados"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={filters.status === k} className={filters.status === k ? "on" : ""} onClick={() => setFilters({ ...filters, status: k, page: 1 })}>
              {label}
            </button>
          ))}
        </div>
        <div className="queue-tabs ml-filter" role="radiogroup" aria-label="Faixa">
          {(["", ...BANDS] as ("" | Band)[]).map((b) => (
            <button key={b || "all"} role="radio" aria-checked={filters.faixa === b} className={filters.faixa === b ? "on" : ""} onClick={() => setFilters({ ...filters, faixa: b, page: 1 })}>
              {b && <i className={`dot band-${b}`} />}
              {b || "Qualquer faixa"}
            </button>
          ))}
        </div>
        <label className="search-box">
          <Icon name="search" size={16} />
          <input aria-label="Buscar relato ou classe" placeholder="Buscar relato ou classe…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value, page: 1 })} />
        </label>
      </div>
      {notice && (
        <p className="ml-saved" role="status">
          <Icon name="check" size={15} /> {notice}
        </p>
      )}
      <ErrorNotice message={error} />
      <datalist id="ml-classes">
        {options.classes.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {!data ? (
        <Loading />
      ) : data.items.length ? (
        <ul className="ml-review-list">
          {data.items.map((item) => (
            <ReviewRow
              key={item.key}
              item={item}
              draft={drafts[item.key]}
              details={options.details}
              onDraft={(d) =>
                setDrafts((all) => {
                  const next = { ...all };
                  if (d) next[item.key] = d;
                  else delete next[item.key];
                  return next;
                })
              }
            />
          ))}
        </ul>
      ) : (
        <p className="helper">Nada para revisar com esses filtros.</p>
      )}
      {data && pages > 1 && (
        <div className="ml-pager">
          <button className="icon-btn" aria-label="Página anterior" disabled={data.page <= 1} onClick={() => setFilters({ ...filters, page: data.page - 1 })}>
            <Icon name="left" size={16} />
          </button>
          <span>
            Página {data.page} de {pages} · {fmt(data.total)} relatos
          </span>
          <button className="icon-btn" aria-label="Próxima página" disabled={data.page >= pages} onClick={() => setFilters({ ...filters, page: data.page + 1 })}>
            <Icon name="right" size={16} />
          </button>
        </div>
      )}
      <footer className="ml-save-bar">
        <span>
          {pending.length
            ? `${fmt(pending.length)} revisão(ões) para salvar. Cada uma vira exemplo de treino e corrige todas as linhas do relato.`
            : "Confirme (✓) o que está certo e corrija (lápis) o que está errado."}
        </span>
        <button className="btn primary" disabled={busy || !pending.length} onClick={() => void save()}>
          {busy ? <span className="spinner" /> : <Icon name="check" size={16} />}
          Salvar ({fmt(pending.length)})
        </button>
      </footer>
    </section>
  );
}

export default function MlFill() {
  const [tab, setTab] = useState<"gerar" | "revisar">("gerar");
  const [runId, setRunId] = useState("");
  const [info, setInfo] = useState<ModelInfo>();
  const [infoError, setInfoError] = useState("");
  const [training, setTraining] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const i = await api<ModelInfo>("/ml/status");
      if (i.ready) setInfo(i);
      else setInfoError(i.erro || "Modelo indisponível.");
    } catch (e) {
      setInfoError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    let active = true;
    api<ModelInfo>("/ml/status")
      .then((i) => active && (i.ready ? setInfo(i) : setInfoError(i.erro || "Modelo indisponível.")))
      .catch((e) => active && setInfoError(e.message));
    return () => {
      active = false;
    };
  }, []);
  // Depois de salvar revisões, acompanha o retreino em segundo plano até terminar.
  const waiting = !!info && (info.pending || info.training);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [waiting, refresh]);

  async function retrain() {
    setTraining(true);
    setInfoError("");
    try {
      setInfo(await api<ModelInfo>("/ml/train", { method: "POST" }));
    } catch (e) {
      setInfoError((e as Error).message);
    } finally {
      setTraining(false);
    }
  }
  const openReview = useCallback((id: string) => {
    setRunId(id);
    setTab("revisar");
  }, []);
  return (
    <>
      <Heading
        eyebrow="ML / PREENCHIMENTO AUTOMÁTICO"
        title="Gerar planilha de apontamentos"
        text="Envie a planilha sem a coluna “Classificação Manual Analista”: o modelo preenche, você revisa o que ele errou e ele aprende com isso."
      />
      <div className="segmented ml-tabs" role="tablist" aria-label="Etapas">
        <button role="tab" aria-selected={tab === "gerar"} className={tab === "gerar" ? "on" : ""} onClick={() => setTab("gerar")}>
          Gerar planilha
        </button>
        <button role="tab" aria-selected={tab === "revisar"} className={tab === "revisar" ? "on" : ""} onClick={() => setTab("revisar")}>
          Revisar previsões
        </button>
      </div>
      <div className="ml-layout">
        <div className="ml-main">
          {tab === "gerar" ? (
            <Generate ready={!!info} onDone={(r) => setInfo(r.model)} onReview={openReview} />
          ) : (
            <Review runId={runId} onRun={setRunId} onSaved={() => void refresh()} />
          )}
        </div>
        <aside>
          {info ? (
            <>
              <ModelQuality info={info} onRetrain={() => void retrain()} training={training} />
              <Cleaning c={info.cleaning} />
            </>
          ) : infoError ? (
            <section className="panel ml-quality">
              <ErrorNotice message={infoError} retry={() => void retrain()} />
            </section>
          ) : (
            <section className="panel ml-quality">
              <Loading />
              <p className="helper">Tratando os dados e treinando o modelo (80/20)…</p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
