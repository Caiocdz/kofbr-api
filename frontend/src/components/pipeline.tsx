"use client";
/* Fluxo único (human-in-the-loop):
   1 Upload → 2 Processamento e predição (ML) → 3 Validação humana → 4 Agrupamento por falha → 5 Dashboard.
   A validação é por relato único: marcar um relato vale para todas as linhas dele na planilha. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiUrl, fmt, navigate, prettyClass, queryString, type Analysis } from "@/lib/radar";
import { Icon, Heading, ErrorNotice, Loading, Modal } from "./ui";
import { ModelQuality, pct, BANDS, type Band, type ModelInfo } from "./ml-shared";
import { ParetoChart } from "./charts";
import { Dashboard } from "./analysis";

const STEPS = ["Upload", "Processamento", "Validação", "Agrupamento", "Dashboard"];
type Job = {
  id: string;
  filename: string;
  step: number;
  steps: string[];
  detail: string;
  done: boolean;
  error: string;
  existing_id: string;
  analysis_id: string;
  seconds: number;
};
type Progress = {
  relatos: number;
  linhas: number;
  validados: number;
  linhas_validadas: number;
  corrigidos: number;
  alta_pendente: number;
  percent_linhas: number;
};
type Info = {
  id: string;
  name: string;
  filename: string;
  created_at: string;
  rows: number;
  skipped: { linha: number; motivo: string }[];
  warnings: string[];
  model: { accuracy?: number; margin?: number };
  progress: Progress;
  ready: boolean;
  step: number;
  download: string;
};
type Item = {
  relato_norm: string;
  relato: string;
  n_linhas: number;
  minutos: number;
  classe: string;
  detalhe: string | null;
  confianca: number | null;
  faixa: Band | "Analista";
  top3: { classe: string; confianca: number }[];
  status: "pendente" | "correta" | "corrigida";
  classe_final: string | null;
  detalhe_final: string | null;
};
type Decision = { resultado: "correta" | "errada"; classe: string; detalhe: string };
type FailureRow = {
  classe: string;
  linhas: number;
  falhas_reais: number;
  minutos: number;
  mttr: number;
  percentual: number;
  acumulado: number;
  linhas_validadas: number;
};

function Stepper({ current, info, onGo }: { current: number; info?: Info; onGo: (step: number) => void }) {
  const reachable = (n: number) => n === 1 || (!!info && (n <= 4 || info.ready));
  return (
    <ol className="pipe-steps" aria-label="Etapas do fluxo">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n === current ? "current" : n < current ? "done" : "";
        return (
          <li key={label} className={state}>
            <button type="button" disabled={!reachable(n) || n === current} onClick={() => onGo(n)} aria-current={n === current ? "step" : undefined}>
              <span className="pipe-num">{n < current ? <Icon name="check" size={14} /> : n}</span>
              <span>{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- Passo 1: upload ---------- */
function Upload({ onJob }: { onJob: (job: Job) => void }) {
  const [file, setFile] = useState<File>();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  function choose(candidate?: File) {
    if (!candidate || busy) return;
    setError("");
    if (!/\.(xlsx|xlsm)$/i.test(candidate.name)) return setError("Selecione a planilha completa em .xlsx ou .xlsm.");
    if (candidate.size > 50 * 1024 * 1024) return setError("O arquivo excede 50 MB.");
    setFile(candidate);
  }
  async function send() {
    if (!file) return;
    setBusy(true);
    setError("");
    const body = new FormData();
    body.append("file", file);
    try {
      onJob(await api<Job>("/pipeline", { method: "POST", body }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="pipe-grid">
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
          <b>{file ? file.name : "Arraste a planilha completa de apontamentos"}</b>
          <span>
            {file
              ? `${(file.size / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} MB · pronta para processar`
              : "ou clique para procurar no computador"}
          </span>
          <small>XLSX ou XLSM no layout do SAP · até 50 MB</small>
        </button>
        <input ref={ref} className="sr-only" type="file" accept=".xlsx,.xlsm" aria-label="Selecionar planilha" onChange={(e) => choose(e.target.files?.[0])} />
        <ErrorNotice message={error} />
        <button className="btn primary import-submit" disabled={!file || busy} onClick={() => void send()}>
          {busy ? (
            <>
              <span className="spinner" /> Enviando…
            </>
          ) : (
            <>
              Processar planilha <Icon name="arrow" size={18} />
            </>
          )}
        </button>
      </section>
      <aside className="import-aside">
        <span className="eyebrow">COMO FUNCIONA</span>
        <ol className="process-list">
          {[
            ["Processamento", "O modelo lê a coluna “Observações” e prevê a falha de cada linha."],
            ["Validação", "Você marca cada previsão como correta ou errada e corrige o que precisar."],
            ["Agrupamento", "Ao salvar, as ocorrências são contadas por tipo de falha."],
            ["Dashboard", "Pareto, Jack-Knife e tabelas com as falhas validadas."],
          ].map(([title, text], i) => (
            <li key={title}>
              <span>{i + 2}</span>
              <div>
                <b>{title}</b>
                <p>{text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="helper">
          Cada validação vira exemplo de treino: o modelo melhora a cada planilha. A planilha original volta com a
          coluna “Classificação Manual Analista” preenchida.
        </p>
      </aside>
    </div>
  );
}

/* ---------- Passo 2: processamento (job) e resumo ---------- */
function Processing({ job, onDone }: { job: Job; onDone: (analysisId: string) => void }) {
  const [state, setState] = useState(job);
  const [error, setError] = useState("");
  useEffect(() => {
    if (state.done) return;
    const t = setTimeout(async () => {
      try {
        const next = await api<Job>(`/pipeline/jobs/${job.id}`);
        setState(next);
        if (next.done && !next.error) onDone(next.analysis_id);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [state, job.id, onDone]);
  return (
    <section className="panel pipe-panel" aria-live="polite">
      <header className="pipe-panel-head">
        <div>
          <span className="eyebrow">PROCESSANDO · {state.filename.toUpperCase()}</span>
          <h2>{state.error ? "O processamento parou" : state.done ? "Planilha processada" : "Lendo e classificando a planilha…"}</h2>
          <p className="helper">Planilhas completas (~90 mil linhas) levam cerca de 1 minuto. Pode deixar esta tela aberta.</p>
        </div>
        <span className="pipe-timer">{fmt(state.seconds, 0)} s</span>
      </header>
      <ol className="pipe-job">
        {state.steps.map((label, i) => {
          const status = state.error && i === state.step ? "error" : i < state.step || (state.done && !state.error) ? "done" : i === state.step ? "running" : "";
          return (
            <li key={label} className={status}>
              <span className="pipe-dot">{status === "done" ? <Icon name="check" size={13} /> : status === "error" ? "!" : i + 1}</span>
              <span>
                {label}
                {i === state.step && state.detail && <small> · {state.detail}</small>}
              </span>
              {status === "running" && <span className="spinner" />}
            </li>
          );
        })}
      </ol>
      <ErrorNotice message={state.error || error} />
      {state.existing_id && (
        <button className="btn secondary" onClick={() => navigate({ view: "fluxo", id: state.existing_id, step: 3 })}>
          Abrir a análise existente <Icon name="arrow" size={16} />
        </button>
      )}
      {state.error && (
        <button className="btn secondary" onClick={() => navigate({ view: "fluxo" })}>
          Enviar outra planilha
        </button>
      )}
    </section>
  );
}

function Recap({ info, model, onNext, onRetrain, training }: { info: Info; model?: ModelInfo; onNext: () => void; onRetrain: () => void; training: boolean }) {
  return (
    <div className="pipe-grid">
      <section className="panel pipe-panel">
        <span className="eyebrow">PLANILHA PROCESSADA</span>
        <h2>{info.filename}</h2>
        <div className="pipe-kpis">
          <div>
            <strong>{fmt(info.rows)}</strong>
            <span>linhas lidas</span>
          </div>
          <div>
            <strong>{fmt(info.progress.relatos)}</strong>
            <span>relatos diferentes para validar</span>
          </div>
          <div>
            <strong>{fmt(info.skipped.length)}</strong>
            <span>linhas ignoradas</span>
          </div>
        </div>
        {info.skipped.length > 0 && (
          <details className="warnings" open={info.skipped.length <= 5}>
            <summary>
              <Icon name="info" size={15} /> Linhas ignoradas (ficam marcadas na planilha gerada)
            </summary>
            {info.skipped.slice(0, 50).map((s) => (
              <p key={s.linha}>
                Linha {s.linha}: {s.motivo}.
              </p>
            ))}
          </details>
        )}
        <p className="helper">
          A mesma frase com números de O.S. diferentes conta como um relato só: validar uma vez vale para todas as
          linhas dela.
        </p>
        <div className="pipe-actions">
          <a className="btn secondary" href={apiUrl(`/api/workspace/pipeline/${info.id}/download`)}>
            <Icon name="download" size={16} /> Baixar planilha com as previsões
          </a>
          <button className="btn primary" onClick={onNext}>
            Validar previsões <Icon name="arrow" size={16} />
          </button>
        </div>
      </section>
      <aside>{model ? <ModelQuality info={model} onRetrain={onRetrain} training={training} /> : <Loading />}</aside>
    </div>
  );
}

/* ---------- Passo 3: validação humana ---------- */
function ValidateRow({
  item,
  decision,
  details,
  onDecide,
}: {
  item: Item;
  decision?: Decision;
  details: Record<string, string[]>;
  onDecide: (d: Decision | null) => void;
}) {
  const saved = item.status !== "pendente";
  const wrong = decision?.resultado === "errada";
  const listId = `pd-${item.relato_norm.slice(0, 32).replace(/\W/g, "_")}`;
  const shownClass = item.classe_final || item.classe;
  return (
    <tr className={`pipe-row ${decision ? `is-${decision.resultado}` : saved ? `saved-${item.status}` : ""}`}>
      <td className="pipe-text">
        <p>{item.relato}</p>
        <small>
          {fmt(item.n_linhas)} {item.n_linhas === 1 ? "linha" : "linhas"} · {fmt(item.minutos, 0)} min
        </small>
      </td>
      <td className="pipe-pred">
        <b>{shownClass}</b>
        {(item.detalhe_final || item.detalhe) && <small>{item.detalhe_final || item.detalhe}</small>}
        {saved && !decision && <em>{item.status === "correta" ? "Validada como correta" : `Corrigida (previsão: ${item.classe})`}</em>}
      </td>
      <td>
        <span className={`ml-band band-${item.faixa}`}>
          <i />
          {item.confianca == null ? item.faixa : `${fmt(item.confianca, 0)}%`}
        </span>
      </td>
      <td className="pipe-decide">
        <div className="pipe-toggle" role="radiogroup" aria-label={`Previsão para: ${item.relato}`}>
          <button
            type="button"
            role="radio"
            aria-checked={decision?.resultado === "correta"}
            className={`ok ${decision?.resultado === "correta" ? "on" : ""}`}
            onClick={() => onDecide(decision?.resultado === "correta" ? null : { resultado: "correta", classe: item.classe, detalhe: item.detalhe || "" })}
          >
            <Icon name="check" size={13} /> Correta
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={wrong}
            className={`bad ${wrong ? "on" : ""}`}
            onClick={() => onDecide(wrong ? null : { resultado: "errada", classe: "", detalhe: "" })}
          >
            <Icon name="close" size={13} /> Errada
          </button>
        </div>
        {wrong && (
          <div className="pipe-fix">
            <input
              list="pipe-classes"
              autoFocus
              aria-label="Classificação correta"
              placeholder="Classificação correta (FALHA DE …)"
              value={decision.classe}
              onChange={(e) => onDecide({ ...decision, classe: e.target.value })}
            />
            <input
              list={listId}
              aria-label="Detalhe (opcional)"
              placeholder="Detalhe (opcional)"
              value={decision.detalhe}
              onChange={(e) => onDecide({ ...decision, detalhe: e.target.value })}
            />
            <datalist id={listId}>
              {(details[decision.classe.trim().toUpperCase()] || []).map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            {item.top3.length > 1 && (
              <div className="ml-alts">
                {item.top3.slice(1).map((a) => (
                  <button key={a.classe} type="button" onClick={() => onDecide({ ...decision, classe: a.classe })}>
                    {prettyClass(a.classe)} · {fmt(a.confianca, 0)}%
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function HighBatch({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [data, setData] = useState<{ total: number; linhas: number; sample: Item[] }>();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ total: number; linhas: number; sample: Item[] }>(`/pipeline/${id}/high`).then(setData).catch((e) => setError(e.message));
  }, [id]);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api(`/pipeline/${id}/accept-high`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Validar a confiança alta em lote" onClose={onClose} wide>
      {!data ? (
        <>
          <ErrorNotice message={error} />
          {!error && <Loading />}
        </>
      ) : (
        <div className="stack-form">
          <div className="confirm-summary">
            <div>
              <strong>{fmt(data.total)}</strong>
              <span>relatos de confiança alta pendentes</span>
            </div>
            <div>
              <strong>{fmt(data.linhas)}</strong>
              <span>linhas da planilha</span>
            </div>
          </div>
          <p className="helper">
            No teste, a confiança alta acerta cerca de 3 em cada 4 previsões. Confira a amostra; se estiver de acordo, todas
            são marcadas como <b>corretas</b>. Média e Baixa continuam esperando você.
          </p>
          <ul className="sample-list">
            {data.sample.map((i) => (
              <li key={i.relato_norm}>
                <span className="class-chip">{prettyClass(i.classe)}</span>
                <b>{i.relato}</b>
                <small>
                  {fmt(i.n_linhas)} linha(s) · {fmt(i.confianca ?? 0, 0)}%
                </small>
              </li>
            ))}
          </ul>
          <label className="check-label confirm-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            Conferi a amostra e concordo com as classes previstas.
          </label>
          <ErrorNotice message={error} />
          <button className="btn primary" disabled={busy || !checked || !data.total} onClick={() => void confirm()}>
            {busy ? <span className="spinner" /> : <Icon name="checks" size={17} />}
            Validar {fmt(data.total)} relatos
          </button>
        </div>
      )}
    </Modal>
  );
}

function Validation({ info, onSaved, onNext }: { info: Info; onSaved: () => void; onNext: () => void }) {
  const [filters, setFilters] = useState({ status: "pendente", faixa: "", q: "", page: 1 });
  const [data, setData] = useState<{ total: number; page: number; size: number; items: Item[]; progress: Progress }>();
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [options, setOptions] = useState<{ classes: string[]; details: Record<string, string[]> }>({ classes: [], details: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [batch, setBatch] = useState(false);
  const load = useCallback(async () => {
    setError("");
    try {
      setData(await api(`/pipeline/${info.id}/items?${queryString(filters)}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [info.id, filters]);
  useEffect(() => {
    const t = setTimeout(() => void load(), filters.q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, filters.q]);
  useEffect(() => {
    api<{ classes: string[]; details: Record<string, string[]> }>("/ml/classes").then(setOptions).catch(() => undefined);
  }, []);
  const pending = Object.entries(decisions).filter(([, d]) => d.resultado === "correta" || d.classe.trim());
  const incomplete = Object.values(decisions).some((d) => d.resultado === "errada" && !d.classe.trim());
  const p = data?.progress || info.progress;
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ saved: number; progress: Progress }>(`/pipeline/${info.id}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: pending.map(([key, d]) => ({ key, ...d })) }),
      });
      setDecisions({});
      setNotice(`${fmt(r.saved)} relato(s) salvos. Ocorrências reagrupadas por falha e enviadas para o treino do modelo.`);
      onSaved();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const markPage = () =>
    setDecisions((all) => {
      const next = { ...all };
      for (const i of data?.items || []) if (i.status === "pendente" && !next[i.relato_norm]) next[i.relato_norm] = { resultado: "correta", classe: i.classe, detalhe: i.detalhe || "" };
      return next;
    });
  return (
    <section className="panel pipe-panel" aria-label="Validação humana">
      <header className="pipe-panel-head">
        <div>
          <span className="eyebrow">VALIDE AS PREVISÕES DO MODELO</span>
          <h2>
            {fmt(p.validados)} de {fmt(p.relatos)} relatos validados
          </h2>
          <p className="helper">
            {pct(p.percent_linhas)} das linhas da planilha · {fmt(p.corrigidos)} corrigidos. Comece pelos de menor
            confiança: são os que mais erram.
          </p>
        </div>
        <div className="pipe-actions">
          <button className="btn secondary small" disabled={!p.alta_pendente || busy} onClick={() => setBatch(true)}>
            <Icon name="checks" size={15} /> Confiança alta em lote ({fmt(p.alta_pendente)})
          </button>
          <button className="btn primary small" disabled={!p.validados} onClick={onNext} title={p.validados ? "" : "Salve pelo menos uma validação"}>
            Ver agrupamento <Icon name="arrow" size={15} />
          </button>
        </div>
      </header>
      <div className="ml-progress">
        <div className="progress-track">
          <i style={{ width: `${(p.validados / Math.max(p.relatos, 1)) * 100}%` }} />
        </div>
      </div>
      <div className="ml-review-filters">
        <div className="queue-tabs ml-filter" role="radiogroup" aria-label="Status">
          {(
            [
              ["pendente", "Pendentes"],
              ["", "Todos"],
              ["correta", "Corretas"],
              ["corrigida", "Corrigidas"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={filters.status === k} className={filters.status === k ? "on" : ""} onClick={() => setFilters({ ...filters, status: k, page: 1 })}>
              {label}
            </button>
          ))}
        </div>
        <div className="queue-tabs ml-filter" role="radiogroup" aria-label="Confiança">
          {(["", ...BANDS] as ("" | Band)[]).map((b) => (
            <button key={b || "all"} role="radio" aria-checked={filters.faixa === b} className={filters.faixa === b ? "on" : ""} onClick={() => setFilters({ ...filters, faixa: b, page: 1 })}>
              {b && <i className={`dot band-${b}`} />}
              {b || "Qualquer confiança"}
            </button>
          ))}
        </div>
        <label className="search-box">
          <Icon name="search" size={16} />
          <input aria-label="Buscar observação ou classe" placeholder="Buscar observação ou classe…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value, page: 1 })} />
        </label>
      </div>
      {notice && (
        <p className="ml-saved" role="status">
          <Icon name="check" size={15} /> {notice}
        </p>
      )}
      <ErrorNotice message={error} />
      <datalist id="pipe-classes">
        {options.classes.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {!data ? (
        <Loading />
      ) : data.items.length ? (
        <div className="table-scroll pipe-table">
          <table>
            <thead>
              <tr>
                <th>Observações</th>
                <th>Previsão do modelo</th>
                <th>Confiança</th>
                <th>
                  A previsão está…{" "}
                  <button type="button" className="text-btn small" onClick={markPage} title="Marca como corretas as pendentes desta página que você ainda não marcou">
                    marcar página como correta
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <ValidateRow
                  key={item.relato_norm}
                  item={item}
                  decision={decisions[item.relato_norm]}
                  details={options.details}
                  onDecide={(d) =>
                    setDecisions((all) => {
                      const next = { ...all };
                      if (d) next[item.relato_norm] = d;
                      else delete next[item.relato_norm];
                      return next;
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="helper">Nada para validar com esses filtros.</p>
      )}
      {data && pages > 1 && (
        <div className="ml-pager">
          <button className="icon-btn" aria-label="Página anterior" disabled={data.page <= 1} onClick={() => setFilters({ ...filters, page: data.page - 1 })}>
            <Icon name="left" size={16} />
          </button>
          <span>
            Página {fmt(data.page)} de {fmt(pages)} · {fmt(data.total)} relatos
          </span>
          <button className="icon-btn" aria-label="Próxima página" disabled={data.page >= pages} onClick={() => setFilters({ ...filters, page: data.page + 1 })}>
            <Icon name="right" size={16} />
          </button>
        </div>
      )}
      <footer className="ml-save-bar">
        <span>
          {incomplete
            ? "Informe a classificação correta dos relatos marcados como errados."
            : pending.length
              ? `${fmt(pending.length)} validação(ões) para salvar. Troque de página à vontade: as marcações ficam guardadas até salvar.`
              : "Marque cada previsão como Correta ou Errada e clique em Salvar."}
        </span>
        <button className="btn primary" disabled={busy || !pending.length || incomplete} onClick={() => void save()}>
          {busy ? <span className="spinner" /> : <Icon name="check" size={16} />}
          Salvar ({fmt(pending.length)})
        </button>
      </footer>
      {batch && (
        <HighBatch
          id={info.id}
          onClose={() => setBatch(false)}
          onDone={() => {
            setBatch(false);
            setNotice("Relatos de confiança alta validados como corretos. Ocorrências reagrupadas por falha.");
            onSaved();
            void load();
          }}
        />
      )}
    </section>
  );
}

/* ---------- Passo 4: agrupamento por falha ---------- */
function useSummary(id: string, version: number) {
  const [rows, setRows] = useState<FailureRow[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ failures: FailureRow[] }>(`/pipeline/${id}/summary`)
      .then((r) => active && setRows(r.failures))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [id, version]);
  return { rows, error };
}

function Grouping({ info, rows, error, onNext }: { info: Info; rows?: FailureRow[]; error: string; onNext: () => void }) {
  const totals = useMemo(
    () => (rows || []).reduce((t, r) => ({ linhas: t.linhas + r.linhas, falhas: t.falhas + r.falhas_reais, minutos: t.minutos + r.minutos }), { linhas: 0, falhas: 0, minutos: 0 }),
    [rows],
  );
  return (
    <section className="panel pipe-panel" aria-label="Agrupamento por falha">
      <header className="pipe-panel-head">
        <div>
          <span className="eyebrow">OCORRÊNCIAS AGRUPADAS POR FALHA</span>
          <h2>
            {fmt(rows?.length || 0)} tipos de falha · {fmt(totals.linhas)} ocorrências
          </h2>
          <p className="helper">
            Usa a classificação validada; nos relatos ainda não validados ({pct(100 - info.progress.percent_linhas)} das
            linhas), usa a previsão do modelo. Recalculado a cada “Salvar”.
          </p>
        </div>
        <div className="pipe-actions">
          <button className="btn primary" disabled={!info.ready} onClick={onNext}>
            Ver dashboard <Icon name="arrow" size={16} />
          </button>
        </div>
      </header>
      <ErrorNotice message={error} />
      {!rows ? (
        <Loading />
      ) : (
        <div className="table-scroll pipe-table pipe-summary">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Falha</th>
                <th>Ocorrências (linhas)</th>
                <th>Falhas reais</th>
                <th>Minutos</th>
                <th>MTTR</th>
                <th>% do tempo</th>
                <th>% acumulado</th>
                <th>Validado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.classe} className={r.acumulado <= 80 ? "top80" : ""}>
                  <td className="seq">{i + 1}</td>
                  <td>
                    <b>{prettyClass(r.classe)}</b>
                  </td>
                  <td>{fmt(r.linhas)}</td>
                  <td>{fmt(r.falhas_reais)}</td>
                  <td>{fmt(r.minutos, 0)}</td>
                  <td>{fmt(r.mttr, 1)}</td>
                  <td>{fmt(r.percentual, 1)}%</td>
                  <td>{fmt(r.acumulado, 1)}%</td>
                  <td>
                    <div className="ml-meter">
                      <i className="band-Alta" style={{ width: `${(r.linhas_validadas / Math.max(r.linhas, 1)) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------- Passo 5: dashboard ---------- */
function Charts5({ info, rows, analysis }: { info: Info; rows?: FailureRow[]; analysis?: Analysis }) {
  const spec = useMemo(
    () => ({
      // Pareto: em ordem decrescente de ocorrências.
      items: [...(rows || [])]
        .sort((a, b) => b.linhas - a.linhas || a.classe.localeCompare(b.classe))
        .slice(0, 15)
        .map((r) => ({ key: r.classe, label: prettyClass(r.classe), sub: `${fmt(r.falhas_reais)} falhas reais`, value: r.linhas, count: r.falhas_reais })),
      metricLabel: "Ocorrências",
      unit: "linhas",
      cut: 80,
      highlight: "cut" as const,
    }),
    [rows],
  );
  return (
    <>
      <section className="panel pipe-panel">
        <header className="pipe-panel-head">
          <div>
            <span className="eyebrow">OCORRÊNCIAS POR FALHA · 15 MAIORES</span>
            <h2>{info.filename}</h2>
            <p className="helper">
              {pct(info.progress.percent_linhas)} das linhas validadas pelo analista; o restante usa a previsão do modelo.
            </p>
          </div>
          <a className="btn secondary small" href={apiUrl(`/api/workspace/pipeline/${info.id}/download`)} title="Pode levar ~30 s na planilha completa">
            <Icon name="download" size={15} /> Planilha completa com as classificações
          </a>
        </header>
        {rows ? <div className="chart-scroll">{<ParetoChart spec={spec} />}</div> : <Loading />}
      </section>
      {analysis ? <Dashboard key={`${analysis.id}-${analysis.revision}-${info.progress.validados}`} analysis={analysis} /> : <Loading />}
    </>
  );
}

export default function Pipeline({ id, step, analyses, onUpdate }: { id?: string; step?: number; analyses: Analysis[]; onUpdate: () => void }) {
  const [job, setJob] = useState<Job>();
  const [info, setInfo] = useState<Info>();
  const [model, setModel] = useState<ModelInfo>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [training, setTraining] = useState(false);
  const loadInfo = useCallback(async () => {
    if (!id) return;
    try {
      setInfo(await api<Info>(`/pipeline/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  // A página remonta este componente quando o id muda (key), então basta carregar uma vez por id.
  useEffect(() => {
    let active = true;
    if (id)
      api<Info>(`/pipeline/${id}`)
        .then((i) => active && setInfo(i))
        .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    api<ModelInfo>("/ml/status").then((m) => m.ready && setModel(m)).catch(() => undefined);
  }, []);
  const summary = useSummary(id || "", version);
  const current = !id ? (job ? 2 : 1) : step || info?.step || 3;
  function go(n: number) {
    if (n === 1) {
      setJob(undefined);
      navigate({ view: "fluxo" });
    } else if (id) navigate({ view: "fluxo", id, step: n });
  }
  async function retrain() {
    setTraining(true);
    try {
      setModel(await api<ModelInfo>("/ml/train", { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTraining(false);
    }
  }
  const onDone = useCallback(
    (analysisId: string) => {
      onUpdate();
      navigate({ view: "fluxo", id: analysisId, step: 2 });
    },
    [onUpdate],
  );
  const saved = () => {
    void loadInfo();
    setVersion((v) => v + 1);
    onUpdate();
  };
  const analysis = analyses.find((a) => a.id === id);
  return (
    <>
      <Heading
        eyebrow="NOVA ANÁLISE · FLUXO ÚNICO"
        title={info ? info.name : "Da planilha ao dashboard."}
        text="Envie a planilha completa: o modelo classifica cada observação, você valida e os gráficos saem das falhas validadas."
      />
      <Stepper current={current} info={info} onGo={go} />
      <ErrorNotice message={error} />
      {!id && !job && <Upload onJob={setJob} />}
      {!id && job && <Processing job={job} onDone={onDone} />}
      {id && !info && !error && <Loading />}
      {id && info && current === 2 && <Recap info={info} model={model} onNext={() => go(3)} onRetrain={() => void retrain()} training={training} />}
      {id && info && current === 3 && <Validation info={info} onSaved={saved} onNext={() => go(4)} />}
      {id && info && current === 4 && <Grouping info={info} rows={summary.rows} error={summary.error} onNext={() => go(5)} />}
      {id && info && current === 5 &&
        (info.ready ? (
          <Charts5 info={info} rows={summary.rows} analysis={analysis} />
        ) : (
          <section className="panel pipe-panel">
            <p className="helper">Salve pelo menos uma validação no passo 3 para liberar o dashboard.</p>
            <button className="btn primary" onClick={() => go(3)}>
              Ir para a validação
            </button>
          </section>
        ))}
    </>
  );
}
