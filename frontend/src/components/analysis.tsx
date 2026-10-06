"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  api,
  apiUrl,
  navigate,
  queryString,
  emptyQuery,
  fmt,
  dateLabel,
  downloadExcel,
  type Analysis,
  type Analytics,
  type Comparison,
  type Filters,
  type Query,
  periodTitle,
  STRATEGY,
  CATEGORIES,
  categoryColor,
  type CountMode,
  type Machine,
} from "@/lib/radar";
import {
  Icon,
  Loading,
  ErrorNotice,
  Heading,
  Stat,
  Period,
  CategoryFilter,
  CountToggle,
  Modal,
} from "./ui";
import { Charts, type JkView } from "./charts";
import {
  useManualConfig,
  ManualBuilder,
  KPI_CATALOG,
  kpiValue,
  type ManualConfig,
} from "./manual";

const emptyFilters: Filters = { units: [], lines: [], failures: [], days: [], machines: [], classes: [] };
function useData<T>(path: string) {
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>({ path: "" });
  useEffect(() => {
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal })
      .then((data) => setState({ path, data }))
      .catch((e) => {
        if (!controller.signal.aborted) setState({ path, error: e.message });
      });
    return () => controller.abort();
  }, [path]);
  return {
    data: state.path === path ? state.data : undefined,
    error: state.path === path ? state.error || "" : "",
    loading: state.path !== path || (!state.data && !state.error),
  };
}
function FilterFields({
  filters,
  value,
  onChange,
}: {
  filters: Filters;
  value: Query;
  onChange: (value: Query) => void;
}) {
  return (
    <>
      {(
        [
          ["unit", "Unidade", filters.units, "Todas as unidades"],
          ["line", "Linha", filters.lines, "Todas as linhas"],
          ["machine", "Equipamento", filters.machines || [], "Todos os equipamentos"],
          ["failure", "Tipo de parada", filters.failures, "Todos os tipos"],
        ] as const
      ).map(([key, label, options, all]) => (
        <label className="field" key={key}>
          <span>{label}</span>
          <select aria-label={label} value={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.value })}>
            <option value="">{all}</option>
            {options.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      ))}
    </>
  );
}
/** Padrões do descritivo: manutenção = P.EQ.LINHA (item 1.1) e, com mais de uma unidade fabril
    na base, a unidade principal (o crítico-crônico é relativo a uma unidade — item 3.3). */
function useMaintenanceDefault(
  filters: Filters | undefined,
  apply: (failure: string, unit: string) => void,
) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !filters) return;
    done.current = true;
    const maintenance = filters.failures.find((f) => f.toUpperCase() === "P.EQ.LINHA") || "";
    const unit = filters.main_unit || "";
    if (maintenance || unit) apply(maintenance, unit);
  }, [filters, apply]);
}
const headingOf = (q: Query) =>
  [q.line || "Todas as linhas", q.machine, q.unit].filter(Boolean).join(" · ");

function MetricStrip({ data, kpis }: { data: Analytics; kpis: string[] }) {
  if (!kpis.length) return null;
  return (
    <div className="stats-grid" style={{ "--kpis": kpis.length <= 4 ? kpis.length : 3 } as React.CSSProperties}>
      {kpis.map((id, i) => {
        const meta = KPI_CATALOG.find((k) => k.id === id);
        if (!meta) return null;
        const v = kpiValue(id, data);
        return (
          <Stat
            key={id}
            tone={i === 0 ? "dark" : "light"}
            index={i}
            label={meta.label}
            value={v.value}
            sub={v.sub}
            icon={meta.icon}
          />
        );
      })}
    </div>
  );
}
function CategoryNote({ data }: { data: Analytics }) {
  if (!data.category_filter?.length) return null;
  return (
    <div className="info-notice">
      <Icon name="target" />
      Mostrando {fmt(data.machines.length)} de {fmt(data.total_machines)} equipamentos ({data.category_filter.join(", ")}).
      Os cortes do Jack-Knife continuam sendo os do conjunto completo (Q médio e MTTR do conjunto).
    </div>
  );
}
const catClass = (c: string) =>
  c === "Crítico-crônico" ? "critical" : c === "Crítico" ? "warning" : c === "Crônico" ? "chronic" : "comfort";
type DocItem = { key: string; name: string; sub: string; minutes: number; count: number; lines: number; mttr: number; category: string };
/** Linhas no formato da apresentação: T, Q, MTTR, T.T.A (tempo acumulado), % acumulado e 80%. */
function DocRows({ items, minRows, onPick }: { items: DocItem[]; minRows: number; onPick?: (key: string) => void }) {
  const total = items.reduce((n, m) => n + m.minutes, 0) || 1;
  const rows = items.reduce<(DocItem & { tta: number; pct: number })[]>((out, m) => {
    const tta = (out.at(-1)?.tta || 0) + m.minutes;
    out.push({ ...m, tta, pct: (tta / total) * 100 });
    return out;
  }, []);
  return (
    <tbody>
      {Array.from({ length: Math.max(minRows, rows.length) }, (_, i) => {
        const m = rows[i];
        const in80 = m && m.pct <= 80 + 1e-9;
        return (
          <tr
            key={m?.key || `blank-${i}`}
            className={`${m ? "" : "blank"} ${m && onPick ? "pickable" : ""} ${in80 ? "in80" : ""}`}
            onClick={m && onPick ? () => onPick(m.key) : undefined}
            tabIndex={m && onPick ? 0 : undefined}
            onKeyDown={m && onPick ? (e) => e.key === "Enter" && onPick(m.key) : undefined}
            title={m && onPick ? "Ver os modos de falha desta máquina" : undefined}
          >
            <td className="seq">{i + 1}</td>
            <td>
              {m && (
                <>
                  <b>{m.name}</b>
                  {m.sub && <small> · {m.sub}</small>}
                  {onPick && <Icon name="right" size={12} />}
                </>
              )}
            </td>
            <td>{m && fmt(m.minutes, 1)}</td>
            <td title={m && m.lines !== m.count ? `${fmt(m.lines)} linhas do SAP` : undefined}>{m && fmt(m.count)}</td>
            <td>{m && fmt(m.mttr, 1)}</td>
            <td>{m && fmt(m.tta, 1)}</td>
            <td>{m && `${fmt(m.pct)}%`}</td>
            <td className="c80">{m && in80 ? fmt(m.minutes, 1) : ""}</td>
            <td>
              {m && (
                <span className={`category ${catClass(m.category)}`}>
                  <i />
                  {m.category.toUpperCase()}
                </span>
              )}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
function DocHead({ first }: { first: string }) {
  return (
    <thead>
      <tr>
        <th />
        <th>{first}</th>
        <th title="Tempo total de parada">T (min)</th>
        <th title="Quantidade de falhas">Q</th>
        <th title="Tempo médio de reparo = T ÷ Q">MTTR</th>
        <th title="Tempo total acumulado (soma de T até esta linha)">T.T.A</th>
        <th title="% acumulado do tempo total">%</th>
        <th title="T dos itens que somam até 80% do tempo (foco do Pareto)">80%</th>
        <th>Categoria</th>
      </tr>
    </thead>
  );
}
function DocTables({
  data,
  view,
  onView,
  query,
}: {
  data: Analytics;
  view: JkView;
  onView: (v: JkView) => void;
  query: Query;
}) {
  const [drill, setDrill] = useState<Machine | null>(null);
  const items: DocItem[] =
    view === "machines"
      ? data.machines.map((m) => ({ key: m.key, name: m.short || m.name, sub: m.unit, minutes: m.minutes, count: m.count, lines: m.lines, mttr: m.mttr, category: m.category }))
      : (data.failures || []).map((f) => ({ key: f.key, name: f.name, sub: "", minutes: f.minutes, count: f.count, lines: f.lines, mttr: f.mttr, category: f.category }));
  return (
    <section className="panel doc-table-panel">
      <header className="panel-heading wrap">
        <div>
          <h2>{view === "machines" ? "Tabela de máquinas" : "Tabela de falhas"}</h2>
          <p>
            Sequência igual à numeração dos pontos do crítico-crônico, ordenada pelo tempo total de parada. A faixa
            destacada é onde estão 80% do tempo parado.
            {view === "machines" ? " Clique numa máquina para ver os modos de falha dela." : " As falhas seguem a classificação da coluna M."}
          </p>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Tabela">
          {(
            [
              ["machines", "Máquinas"],
              ["failures", "Falhas"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? "on" : ""} onClick={() => onView(k)}>
              {l}
            </button>
          ))}
        </div>
      </header>
      <div className="table-scroll doc-table-scroll">
        <table className="doc-table">
          <DocHead first={view === "machines" ? "EQUIPAMENTOS" : "FALHAS"} />
          <DocRows
            items={items}
            minRows={40}
            onPick={view === "machines" ? (key) => setDrill(data.machines.find((m) => m.key === key) || null) : undefined}
          />
        </table>
      </div>
      {drill && <MachineDrill machine={drill} query={query} onClose={() => setDrill(null)} />}
    </section>
  );
}

/** Desdobramento máquina → modos de falha (como na apresentação), com a ação sugerida. */
function MachineDrill({ machine, query, onClose }: { machine: Machine; query: Query; onClose: () => void }) {
  const path = `/analytics?${queryString({ ...query, category: "", unit: machine.unit, line: machine.line, machine: machine.name })}`;
  const result = useData<Analytics>(path);
  const strategy = STRATEGY[machine.category];
  const items: DocItem[] = (result.data?.failures || []).map((f) => ({
    key: f.key, name: f.name, sub: "", minutes: f.minutes, count: f.count, lines: f.lines, mttr: f.mttr, category: f.category,
  }));
  return (
    <Modal title={machine.short || machine.name} onClose={onClose} wide>
      <div className="drill">
        <div className="drill-head" style={{ "--cat": categoryColor[machine.category] } as React.CSSProperties}>
          <div>
            <span className={`category ${catClass(machine.category)}`}>
              <i />
              {machine.category.toUpperCase()}
            </span>
            <p>
              {fmt(machine.minutes, 1)} min parados · Q {fmt(machine.count)} · MTTR {fmt(machine.mttr, 1)} min ·{" "}
              {machine.unit} / {machine.line}
            </p>
          </div>
          {strategy && (
            <div className="drill-strategy">
              <b>
                <Icon name="target" size={15} />
                Ação sugerida: {strategy.title}
              </b>
              <p>{strategy.text}</p>
              <div>
                {strategy.tools.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
          )}
        </div>
        <ErrorNotice message={result.error} />
        {result.loading ? (
          <Loading label="Abrindo modos de falha…" />
        ) : (
          <div className="table-scroll">
            <table className="doc-table">
              <DocHead first={machine.short || machine.name} />
              <DocRows items={items} minRows={0} />
            </table>
          </div>
        )}
        <p className="helper">
          A categoria de cada modo usa os cortes desta máquina (Q médio e MTTR da máquina). Comece pelos modos dentro dos 80% (coluna destacada).
        </p>
      </div>
    </Modal>
  );
}

/** O que fazer com cada quadrante do Jack-Knife. */
function StrategyPanel({ data, onPick }: { data: Analytics; onPick: (category: string) => void }) {
  if (!data.machines.length) return null;
  return (
    <section className="panel strategy-panel">
      <header className="panel-heading">
        <div>
          <h2>Próximo passo por quadrante</h2>
          <p>Sugestão de ferramenta de confiabilidade para cada grupo do Jack-Knife. A decisão é do analista.</p>
        </div>
      </header>
      <div className="strategy-grid">
        {CATEGORIES.map((c) => {
          const list = data.machines.filter((m) => m.category === c);
          const s = STRATEGY[c];
          return (
            <article key={c} style={{ "--cat": categoryColor[c] } as React.CSSProperties}>
              <header>
                <i />
                <b>{c}</b>
                <span>{fmt(list.length)}</span>
              </header>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              <div className="strategy-tools">
                {s.tools.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              {list.length > 0 && (
                <ul>
                  {list.slice(0, 3).map((m) => (
                    <li key={m.key}>
                      <b>{m.short || m.name}</b>
                      <small>{fmt(m.minutes, 0)} min</small>
                    </li>
                  ))}
                </ul>
              )}
              {list.length > 0 && (
                <button type="button" className="text-btn small" onClick={() => onPick(c)}>
                  Filtrar só {c.toLowerCase()} <Icon name="arrow" size={13} />
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* ============================ Dashboard ============================ */
/** "Exportar Excel": o resumo SAP (Pareto/Jack-Knife) ou a planilha resumida por observação. */
function ExportMenu({ onSummary, resumoHref, fullHref }: { onSummary: () => void; resumoHref: string; fullHref: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="export-menu" ref={ref}>
      <button className="btn excel" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="sheet" size={16} />
        Exportar Excel
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <div className="export-menu-panel" role="menu">
          {fullHref && (
            <a role="menuitem" className="main" href={fullHref} download onClick={() => setOpen(false)}>
              <Icon name="sheet" size={16} />
              <span>
                <b>Planilha completa com Classificação</b>
                <small>A planilha importada, com todas as linhas e colunas, mais a coluna Classificação que saiu do quadro</small>
              </span>
            </a>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSummary();
            }}
          >
            <Icon name="chart" size={16} />
            <span>
              <b>Resumo da análise</b>
              <small>Layout SAP com Pareto e crítico-crônico do filtro atual</small>
            </span>
          </button>
          {resumoHref && (
            <a role="menuitem" href={resumoHref} download onClick={() => setOpen(false)}>
              <Icon name="sheet" size={16} />
              <span>
                <b>Planilha resumida por observação</b>
                <small>Uma linha por observação única, sem repetições, com a classificação validada</small>
              </span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function Dashboard({ analysis, day }: { analysis: Analysis; day?: string }) {
  const [draft, setDraft] = useState<Query>({ ...emptyQuery, ids: analysis.id, from: day || "", to: day || "" });
  const [query, setQuery] = useState(draft);
  const [formError, setFormError] = useState("");
  const [manual, setManual] = useManualConfig("gargalo-manual-dashboard");
  const [builder, setBuilder] = useState(false);
  const [view, setView] = useState<JkView>("machines");
  const result = useData<Analytics>(`/analytics?${queryString(query)}`);
  const filters = useData<Filters>(`/filters?ids=${analysis.id}`);
  const applyMaintenance = useCallback((failure: string, unit: string) => {
    setDraft((d) => ({ ...d, failure, unit: d.unit || unit }));
    setQuery((q) => ({ ...q, failure, unit: q.unit || unit }));
  }, []);
  useMaintenanceDefault(filters.data, applyMaintenance);
  const period = periodTitle(query.from, query.to, analysis.days);
  const dirty = JSON.stringify({ ...draft, category: "", count: "" }) !== JSON.stringify({ ...query, category: "", count: "" });
  const setCategory = (category: string) => {
    setDraft((d) => ({ ...d, category }));
    setQuery((q) => ({ ...q, category }));
  };
  const setCount = (count: CountMode) => {
    setDraft((d) => ({ ...d, count }));
    setQuery((q) => ({ ...q, count }));
  };
  return (
    <>
      <button
        className="text-btn back-link"
        onClick={() =>
          navigate(analysis.mode === "ml" ? { view: "fluxo", id: analysis.id, step: 3 } : { view: "quadro", id: analysis.id })
        }
      >
        <Icon name="back" size={17} />
        {analysis.mode === "ml" ? "Voltar à validação" : "Voltar ao quadro de validação"}
      </button>
      <Heading
        eyebrow="03 / EXPLORAR RESULTADOS"
        title="Da informação à decisão."
        text={`${analysis.filename} · ${query.from ? `${dateLabel(query.from)} a ${dateLabel(query.to)}` : "Todo o período da planilha"}`}
        action={
          <div className="heading-actions">
            <span className="badge good">
              <Icon name="shield" size={15} />
              Base validada
            </span>
            <button className="btn secondary" onClick={() => setBuilder(true)} title="Montar o dashboard manualmente">
              <Icon name="pencil" size={16} />
              Montar dashboard
            </button>
            <ExportMenu
              onSummary={() => downloadExcel(query)}
              resumoHref={analysis.mode === "ml" ? "" : apiUrl(`/api/workspace/analyses/${analysis.id}/resumo.xlsx`)}
              fullHref={analysis.mode === "ml" ? "" : apiUrl(`/api/workspace/analyses/${analysis.id}/completa`)}
            />
          </div>
        }
      />
      <form
        className="filter-panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (Boolean(draft.from) !== Boolean(draft.to) || draft.from > draft.to) {
            setFormError("Informe um intervalo completo e válido.");
            return;
          }
          setFormError("");
          setQuery({ ...draft });
        }}
      >
        <div className="filter-panel-top">
          <span>
            <Icon name="filter" size={16} />
            Refinar análise
          </span>
          <button type="button" className="text-btn" onClick={() => setDraft({ ...emptyQuery, ids: analysis.id, count: query.count })}>
            Limpar filtros
          </button>
        </div>
        <div className="filters-row">
          <FilterFields filters={filters.data || emptyFilters} value={draft} onChange={setDraft} />
          <Period from={draft.from} to={draft.to} onChange={(range) => setDraft({ ...draft, ...range })} />
          <button className="btn primary" type="submit">
            <Icon name="filter" size={16} />
            Aplicar{dirty && <i className="dirty-dot" />}
          </button>
        </div>
        <CategoryFilter value={query.category} onChange={setCategory} counts={result.data?.categories} />
        <CountToggle value={query.count || "events"} onChange={setCount} metrics={result.data?.metrics} />
      </form>
      <ErrorNotice message={formError || result.error || filters.error} />
      {result.loading ? (
        <Loading label="Calculando indicadores…" />
      ) : (
        result.data && (
          <>
            <CategoryNote data={result.data} />
            <MetricStrip data={result.data} kpis={manual.dashboard.kpis} />
            <Charts
              data={result.data}
              query={query}
              manual={manual}
              onManual={setManual}
              heading={headingOf(query)}
              period={period}
              view={view}
              onView={setView}
            />
            {manual.dashboard.sections.table && <DocTables data={result.data} view={view} onView={setView} query={query} />}
            <StrategyPanel data={result.data} onPick={setCategory} />
          </>
        )
      )}
      <div className="data-footnote">
        <Icon name="info" size={17} />
        <p>
          {query.count === "lines"
            ? "Contando cada linha do SAP como uma ocorrência (como na planilha)."
            : "Contando falhas reais: linhas do SAP com a mesma O.S. na mesma máquina valem 1 falha."}{" "}
          O tempo total é sempre a soma dos minutos de todas as linhas. As datas são as dos apontamentos originais.
        </p>
        <a href={apiUrl(`/api/workspace/analyses/${analysis.id}/source`)}>
          <Icon name="download" size={15} />
          Planilha original
        </a>
      </div>
      {builder && result.data && (
        <ManualBuilder
          data={result.data}
          tab="dashboard"
          config={manual}
          onApply={(c: ManualConfig) => {
            setManual(c);
            setBuilder(false);
          }}
          onClose={() => setBuilder(false)}
        />
      )}
    </>
  );
}

/* ============================ Comparar ============================ */
type Preset = "7d" | "week" | "month" | "30d" | "custom";
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5) + 1;
function presetRanges(preset: Preset, anchor: string) {
  if (preset === "7d" || preset === "30d") {
    const n = preset === "7d" ? 7 : 30;
    const bFrom = addDays(anchor, -(n - 1));
    return { a: { from: addDays(bFrom, -n), to: addDays(bFrom, -1) }, b: { from: bFrom, to: anchor } };
  }
  if (preset === "week") {
    const dow = (new Date(`${anchor}T12:00:00Z`).getUTCDay() + 6) % 7;
    const monday = addDays(anchor, -dow);
    return { a: { from: addDays(monday, -7), to: addDays(monday, -1) }, b: { from: monday, to: addDays(monday, 6) } };
  }
  const [y, m] = anchor.split("-").map(Number);
  const first = `${anchor.slice(0, 7)}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const prevLast = addDays(first, -1);
  return { a: { from: `${prevLast.slice(0, 7)}-01`, to: prevLast }, b: { from: first, to: last } };
}
const presets: [Preset, string, string][] = [
  ["7d", "Últimos 7 dias", "× 7 dias anteriores"],
  ["week", "Esta semana", "× semana anterior"],
  ["month", "Este mês", "× mês anterior"],
  ["30d", "Últimos 30 dias", "× 30 dias anteriores"],
  ["custom", "Personalizado", "escolha as datas"],
];
const pct = (a: number, b: number) => (a ? ((b - a) * 100) / a : null);

function Delta({ a, b, unit = "", decimals = 0 }: { a: number; b: number; unit?: string; decimals?: number }) {
  const p = pct(a, b);
  const dir = b > a ? "up" : b < a ? "down" : "same";
  return (
    <span className={`delta ${dir}`}>
      <Icon name={dir === "up" ? "up" : dir === "down" ? "down" : "arrow"} size={13} />
      {p === null ? `${b > a ? "+" : ""}${fmt(b - a, decimals)}${unit}` : `${p > 0 ? "+" : ""}${fmt(p, 1)}%`}
    </span>
  );
}

function Diverging({ changes }: { changes: Comparison["changes"] }) {
  const rows = changes.filter((c) => c.delta !== 0).slice(0, 10);
  if (!rows.length) return <p className="helper pad">Nenhum equipamento mudou de quantidade entre os períodos.</p>;
  const max = Math.max(...rows.map((r) => Math.abs(r.delta)), 1);
  return (
    <div className="diverging">
      <div className="div-axis">
        <span>
          <Icon name="down" size={12} /> Menos ocorrências (melhorou)
        </span>
        <span>
          Mais ocorrências (piorou) <Icon name="up" size={12} />
        </span>
      </div>
      {rows.map((r, i) => (
        <div className="div-row" key={r.key} style={{ animationDelay: `${i * 40}ms` }}>
          <span className="div-label">
            <b>{r.name}</b>
            <small>
              {r.unit} / {r.line}
            </small>
          </span>
          <span className="div-track">
            <span className="div-half left">
              {r.delta < 0 && (
                <i className="bar down" style={{ width: `${(Math.abs(r.delta) / max) * 100}%` }}>
                  <em>{fmt(r.delta)}</em>
                </i>
              )}
            </span>
            <span className="div-half right">
              {r.delta > 0 && (
                <i className="bar up" style={{ width: `${(r.delta / max) * 100}%` }}>
                  <em>+{fmt(r.delta)}</em>
                </i>
              )}
            </span>
          </span>
          <span className="div-values">
            {fmt(r.before)} → {fmt(r.after)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Compare({ analyses }: { analyses: Analysis[] }) {
  const ready = analyses.filter((a) => a.ready);
  const days = ready.flatMap((a) => a.days).sort();
  const anchor = days.at(-1) || new Date().toISOString().slice(0, 10);
  const [preset, setPreset] = useState<Preset>("7d");
  const [custom, setCustom] = useState(() => presetRanges("7d", anchor));
  const [filters, setFilters] = useState<Query>({ ...emptyQuery });
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<"b" | "a">("b");
  const [tab, setTab] = useState<"all" | "up" | "down" | "new" | "same">("all");
  const [search, setSearch] = useState("");
  const [manual, setManual] = useManualConfig("gargalo-manual-compare");
  const [jkView, setJkView] = useState<JkView>("machines");
  const ranges = preset === "custom" ? custom : presetRanges(preset, anchor);
  const invalid =
    !ranges.a.from || !ranges.a.to || !ranges.b.from || !ranges.b.to || ranges.a.from > ranges.a.to || ranges.b.from > ranges.b.to;
  const path = invalid
    ? ""
    : `/compare?${queryString({
        ...filters,
        from: ranges.b.from,
        to: ranges.b.to,
        a_from: ranges.a.from,
        a_to: ranges.a.to,
        ids: selected.join(","),
      })}`;
  const result = useData<Comparison>(path || "/compare?from=&to=");
  const options = useData<Filters>("/filters");
  const applyMaintenance = useCallback((failure: string, unit: string) => setFilters((f) => ({ ...f, failure, unit: f.unit || unit })), []);
  useMaintenanceDefault(options.data, applyMaintenance);
  const data = path ? result.data : undefined;
  const counts = useMemo(() => {
    const c = { all: 0, up: 0, down: 0, new: 0, same: 0 };
    for (const x of data?.changes || []) {
      c.all++;
      c[x.direction as "up" | "down" | "same" | "new"]++;
    }
    return c;
  }, [data]);
  const shown = (data?.changes || []).filter(
    (c) =>
      (tab === "all" || c.direction === tab) &&
      `${c.name} ${c.unit} ${c.line}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const dA = daysBetween(ranges.a.from, ranges.a.to),
    dB = daysBetween(ranges.b.from, ranges.b.to);
  const ma = data?.a.metrics,
    mb = data?.b.metrics;
  const change = ma && mb ? pct(ma.count, mb.count) : null;
  const unitWord = filters.count === "lines" ? "linhas do SAP" : "falhas";
  const refineCount = [filters.unit, filters.line, filters.machine, filters.failure, filters.category].filter(Boolean).length + (selected.length ? 1 : 0);
  return (
    <>
      <Heading
        eyebrow="COMPARAR PERÍODOS"
        title="O que mudou na operação?"
        text="Escolha dois períodos e veja, em segundos, se as ocorrências subiram ou caíram, e em quais equipamentos."
        action={
          <span className="badge neutral">
            <Icon name="calendar" size={15} />
            Dados até {dateLabel(anchor)}
          </span>
        }
      />

      <section className="cmp-setup">
        <div className="cmp-step">
          <span className="b-num">1</span>
          <b>Escolha a comparação</b>
        </div>
        <div className="preset-grid" role="radiogroup" aria-label="Tipo de comparação">
          {presets.map(([key, title, sub]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={preset === key}
              className={`preset ${preset === key ? "on" : ""}`}
              onClick={() => {
                if (key === "custom") setCustom(ranges);
                setPreset(key);
              }}
            >
              <b>{title}</b>
              <small>{sub}</small>
            </button>
          ))}
        </div>

        <div className="cmp-step">
          <span className="b-num">2</span>
          <b>Confira os períodos</b>
          <small>A é a referência (antes). B é o período avaliado (depois).</small>
        </div>
        <div className="period-pair">
          {(["a", "b"] as const).map((k) => (
            <div key={k} className={`period-card ${k}`}>
              <span className={`period-letter ${k === "b" ? "accent" : ""}`}>{k.toUpperCase()}</span>
              <div className="period-card-body">
                <small>{k === "a" ? "Antes · referência" : "Depois · em análise"}</small>
                {preset === "custom" ? (
                  <div className="period-inputs">
                    <input
                      type="date"
                      aria-label={`Período ${k.toUpperCase()}: de`}
                      value={custom[k].from}
                      max={custom[k].to || undefined}
                      onChange={(e) => setCustom({ ...custom, [k]: { ...custom[k], from: e.target.value } })}
                    />
                    <span>até</span>
                    <input
                      type="date"
                      aria-label={`Período ${k.toUpperCase()}: até`}
                      value={custom[k].to}
                      min={custom[k].from || undefined}
                      onChange={(e) => setCustom({ ...custom, [k]: { ...custom[k], to: e.target.value } })}
                    />
                  </div>
                ) : (
                  <b>
                    {dateLabel(ranges[k].from)} — {dateLabel(ranges[k].to)}
                  </b>
                )}
                <em>{invalid ? "—" : `${k === "a" ? dA : dB} dias`}</em>
              </div>
            </div>
          ))}
          <span className="period-arrow" aria-hidden="true">
            <Icon name="arrow" size={18} />
          </span>
        </div>

        <details className="cmp-refine">
          <summary>
            <span className="b-num small">3</span>
            Refinar (opcional) · unidade, linha, equipamento, tipo de parada, criticidade e arquivos
            {refineCount > 0 && <span className="count-pill">{refineCount} ativo(s)</span>}
          </summary>
          <div className="filters-row">
            <FilterFields filters={options.data || emptyFilters} value={filters} onChange={setFilters} />
            {refineCount > 0 && (
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  setFilters({ ...emptyQuery });
                  setSelected([]);
                }}
              >
                Limpar refinamento
              </button>
            )}
          </div>
          <CategoryFilter
            value={filters.category}
            onChange={(category) => setFilters({ ...filters, category })}
            counts={data?.b.categories}
          />
          <CountToggle value={filters.count || "events"} onChange={(count) => setFilters({ ...filters, count })} />
          <div className="file-picks">
            <span className="category-filter-label">
              <Icon name="file" size={15} />
              Arquivos considerados
            </span>
            <div className="category-chips">
              <button type="button" className={`cat-chip all ${selected.length ? "" : "on"}`} onClick={() => setSelected([])}>
                Todos os validados
              </button>
              {ready.map((a) => (
                <button
                  type="button"
                  key={a.id}
                  aria-pressed={selected.includes(a.id)}
                  className={`cat-chip file ${selected.includes(a.id) ? "on" : ""}`}
                  onClick={() => setSelected(selected.includes(a.id) ? selected.filter((v) => v !== a.id) : [...selected, a.id])}
                >
                  {a.filename}
                </button>
              ))}
            </div>
          </div>
        </details>
      </section>

      {invalid && <ErrorNotice message="Escolha datas válidas para A e B: o início deve vir antes do fim." />}
      <ErrorNotice message={path ? result.error || options.error : ""} />
      {path && result.loading ? (
        <Loading label="Comparando os períodos…" />
      ) : (
        data &&
        ma &&
        mb && (
          <>
            <section
              className={`verdict ${change === null || change === 0 ? "neutral" : change > 0 ? "worse" : "better"}`}
            >
              <span className="verdict-icon">
                <Icon name={change === null ? "info" : change > 0 ? "up" : change < 0 ? "down" : "arrow"} size={26} />
              </span>
              <div>
                <small>Resultado da comparação</small>
                <h2>
                  {!ma.count && !mb.count
                    ? "Nenhum registro validado nos dois períodos."
                    : change === null
                      ? `O período A não tem registros; B soma ${fmt(mb.count)} ${unitWord}.`
                      : change === 0
                        ? `As ${unitWord} ficaram estáveis.`
                        : `As ${unitWord} ${change > 0 ? "subiram" : "caíram"} ${fmt(Math.abs(change), 1)}%.`}
                </h2>
                <p>
                  De {fmt(ma.count)} para {fmt(mb.count)} {unitWord} · {counts.up} equipamento(s) pioraram,{" "}
                  {counts.down} melhoraram{counts.new ? ` e ${counts.new} apareceram só em B` : ""}.
                  {dA !== dB && ` Atenção: A tem ${dA} dias e B tem ${dB}.`}
                </p>
              </div>
              <button
                className="btn excel"
                onClick={() => downloadExcel({ ...filters, from: ranges.b.from, to: ranges.b.to, ids: selected.join(",") })}
              >
                <Icon name="sheet" size={16} />
                Excel do período B
              </button>
            </section>

            <div className="kpi-compare">
              {(
                [
                  [unitWord === "falhas" ? "Falhas (Q)" : "Linhas do SAP", ma.count, mb.count, "", 0],
                  ["Tempo de parada", ma.minutes / 60, mb.minutes / 60, " h", 1],
                  ["MTTR", ma.mttr, mb.mttr, " min", 1],
                  ["Equipamentos com falha", ma.machines, mb.machines, "", 0],
                ] as const
              ).map(([label, a, b, unit, dec], i) => (
                <article key={label} className="kc" style={{ animationDelay: `${i * 60}ms` }}>
                  <span className="kc-label">{label}</span>
                  <div className="kc-values">
                    <span className="kc-a">
                      <i>A</i>
                      {fmt(a, dec)}
                      {unit}
                    </span>
                    <Icon name="arrow" size={15} />
                    <strong>
                      {fmt(b, dec)}
                      <em>{unit}</em>
                    </strong>
                  </div>
                  <Delta a={a} b={b} unit={unit} decimals={dec} />
                </article>
              ))}
            </div>

            <section className="panel">
              <header className="panel-heading">
                <div>
                  <h2>Onde mudou</h2>
                  <p>Os 10 equipamentos com maior variação de ocorrências entre A e B.</p>
                </div>
              </header>
              <Diverging changes={data.changes} />
            </section>

            <section className="panel">
              <header className="panel-heading wrap">
                <div>
                  <h2>Todos os equipamentos</h2>
                  <p>Variação = (B − A) ÷ A × 100. “Melhorou” e “piorou” se referem só à contagem registrada.</p>
                </div>
                <label className="search-box">
                  <Icon name="search" size={16} />
                  <input
                    aria-label="Buscar equipamento"
                    placeholder="Buscar equipamento…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </header>
              <div className="change-tabs" role="tablist">
                {(
                  [
                    ["all", "Todos"],
                    ["up", "Pioraram"],
                    ["down", "Melhoraram"],
                    ["new", "Novos em B"],
                    ["same", "Sem variação"],
                  ] as const
                ).map(([k, l]) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={tab === k}
                    className={`${tab === k ? "on" : ""} t-${k}`}
                    onClick={() => setTab(k)}
                  >
                    {l}
                    <b>{counts[k]}</b>
                  </button>
                ))}
              </div>
              <div className="table-scroll">
                <table className="comparison-table">
                  <thead>
                    <tr>
                      <th>Equipamento</th>
                      <th>Unidade / linha</th>
                      <th>A</th>
                      <th>B</th>
                      <th>Diferença</th>
                      <th>Variação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((m) => (
                      <tr key={m.key}>
                        <td>
                          <b>{m.name}</b>
                        </td>
                        <td>
                          {m.unit} / {m.line}
                        </td>
                        <td>{fmt(m.before)}</td>
                        <td>{fmt(m.after)}</td>
                        <td>
                          {m.delta > 0 ? "+" : ""}
                          {fmt(m.delta)}
                        </td>
                        <td>
                          <span className={`change-value ${m.direction}`}>
                            {m.percentage === null ? "Novo em B" : `${m.percentage > 0 ? "+" : ""}${fmt(m.percentage, 1)}%`}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {!shown.length && (
                      <tr>
                        <td colSpan={6}>Nenhum equipamento nesta seleção.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="section-heading">
              <div>
                <h2>Gráficos do período</h2>
                <p>Jack-Knife e Pareto recalculados com todos os registros do período escolhido.</p>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Período dos gráficos">
                {(["a", "b"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={view === k}
                    className={view === k ? "on" : ""}
                    onClick={() => setView(k)}
                  >
                    Período {k.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <Charts
              data={data[view]}
              query={{ ...filters, from: ranges[view].from, to: ranges[view].to, ids: selected.join(",") }}
              manual={manual}
              onManual={setManual}
              heading={headingOf(filters)}
              period={`Período ${view.toUpperCase()} · ${periodTitle(ranges[view].from, ranges[view].to)}`}
              view={jkView}
              onView={setJkView}
            />
            {data[view].machines.length > 0 && (
              <DocTables
                data={data[view]}
                view={jkView}
                onView={setJkView}
                query={{ ...filters, from: ranges[view].from, to: ranges[view].to, ids: selected.join(",") }}
              />
            )}
          </>
        )
      )}
    </>
  );
}
