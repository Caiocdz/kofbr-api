"use client";
import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import type React from "react";
import { type Analytics, type BreakdownRow, fmt, categoryColor, shortLine, prettyClass, SEM_MODO } from "@/lib/radar";
import { Icon, Modal } from "./ui";
import {
  type ParetoSpec,
  type JackSpec,
  ParetoChart,
  JackknifeChart,
  classify,
  svgToPng,
} from "./charts";

/* ======================= Configuração ======================= */
export type Dim = "machine" | "class" | "line" | "unit" | "failure" | "mode";
type Override = {
  exclude?: boolean;
  label?: string;
  value?: number;
  count?: number;
  minutes?: number;
};
type Extra = { key: string; label: string; value: number; count: number; minutes: number };
export type ParetoConfig = {
  enabled: boolean;
  title: string;
  groupBy: Dim;
  metric: "minutes" | "count" | "mttr";
  cut: number;
  top: number;
  highlight: "cut" | "top3";
  overrides: Record<string, Override>;
  extra: Extra[];
};
export type JackConfig = {
  enabled: boolean;
  title: string;
  groupBy: Dim;
  cutMode: "median" | "mean" | "manual";
  cutQ: number;
  cutT: number;
  scale: "linear" | "log";
  labels: boolean;
  overrides: Record<string, Override>;
  extra: Extra[];
};
export type ManualConfig = {
  dashboard: {
    kpis: string[];
    sections: { jackknife: boolean; pareto: boolean; table: boolean };
  };
  pareto: ParetoConfig;
  jackknife: JackConfig;
};

export const defaultManual: ManualConfig = {
  dashboard: {
    kpis: ["count", "minutes", "mttr", "machines"],
    sections: { jackknife: true, pareto: true, table: true },
  },
  pareto: {
    enabled: false,
    title: "",
    groupBy: "machine",
    metric: "minutes",
    cut: 80,
    top: 0,
    highlight: "cut",
    overrides: {},
    extra: [],
  },
  jackknife: {
    enabled: false,
    title: "",
    groupBy: "machine",
    cutMode: "median",
    cutQ: 0,
    cutT: 0,
    scale: "log",
    labels: false,
    overrides: {},
    extra: [],
  },
};

export function useManualConfig(storageKey: string) {
  const [config, setConfig] = useState<ManualConfig>(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          dashboard: { ...defaultManual.dashboard, ...parsed.dashboard },
          pareto: { ...defaultManual.pareto, ...parsed.pareto },
          jackknife: { ...defaultManual.jackknife, ...parsed.jackknife },
        };
      }
    } catch {
      /* armazenamento indisponível: segue com o padrão */
    }
    return defaultManual;
  });
  const update = (next: ManualConfig) => {
    setConfig(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* sem persistência neste navegador */
    }
  };
  return [config, update] as const;
}

/* ======================= Dados ======================= */
const dims: [Dim, string][] = [
  ["machine", "Equipamento"],
  ["class", "Classe de falha"],
  ["line", "Linha"],
  ["unit", "Unidade"],
  ["failure", "Tipo de parada"],
  ["mode", "Descrição consolidada"],
];
const dimLabel = Object.fromEntries(dims) as Record<Dim, string>;
type Group = { key: string; label: string; sub: string; count: number; minutes: number };

function group(rows: BreakdownRow[], dim: Dim): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    const [key, label, sub] =
      dim === "machine"
        ? [`${r.unit}\u001f${r.line}\u001f${r.machine}`, `${shortLine(r.line)}_${r.machine}`, r.unit]
        : dim === "class"
          ? [r.klass, prettyClass(r.klass), ""]
          : dim === "line"
          ? [`${r.unit}\u001f${r.line}`, r.line, r.unit]
          : dim === "unit"
            ? [r.unit, r.unit, ""]
            : dim === "failure"
              ? [r.failure, r.failure, ""]
              : [`${r.machine}\u001f${r.mode}`, r.mode || "Sem descrição", r.machine];
    const g = map.get(key) || { key, label, sub, count: 0, minutes: 0 };
    g.count += r.count;
    g.minutes += r.minutes;
    map.set(key, g);
  }
  return [...map.values()];
}
const metricInfo = {
  minutes: { label: "Tempo de parada", unit: "min" },
  count: { label: "Falhas (Q)", unit: "falhas" },
  mttr: { label: "MTTR", unit: "min" },
};
const metricOf = (g: { count: number; minutes: number }, metric: ParetoConfig["metric"]) =>
  metric === "count" ? g.count : metric === "mttr" ? (g.count ? g.minutes / g.count : 0) : g.minutes;

type ParetoRow = Group & { value: number; excluded: boolean; manual?: boolean };
function paretoRows(data: Analytics, c: ParetoConfig): ParetoRow[] {
  const base = group(data.rows, c.groupBy).map((g) => {
    const o = c.overrides[g.key] || {};
    return {
      ...g,
      label: o.label ?? g.label,
      value: o.value ?? metricOf(g, c.metric),
      excluded: !!o.exclude,
    };
  });
  const extra = c.extra.map((e) => ({
    key: e.key,
    label: e.label,
    sub: "manual",
    count: e.count,
    minutes: e.minutes,
    value: e.value,
    excluded: !!c.overrides[e.key]?.exclude,
    manual: true,
  }));
  return [...base, ...extra].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}
export function paretoItems(data: Analytics, c: ParetoConfig): ParetoSpec {
  const rows = paretoRows(data, c).filter((r) => !r.excluded && r.value > 0);
  return {
    items: (c.top ? rows.slice(0, c.top) : rows).map((r) => ({
      key: r.key,
      label: r.label,
      sub: r.sub,
      value: r.value,
      count: r.count,
    })),
    metricLabel: metricInfo[c.metric].label,
    unit: metricInfo[c.metric].unit,
    cut: c.cut,
    highlight: c.highlight,
  };
}

type JackRow = Group & { mttr: number; excluded: boolean; manual?: boolean };
function jackRows(data: Analytics, c: JackConfig): JackRow[] {
  const base = group(data.rows, c.groupBy).map((g) => {
    const o = c.overrides[g.key] || {};
    const count = o.count ?? g.count,
      minutes = o.minutes ?? g.minutes;
    return { ...g, label: o.label ?? g.label, count, minutes, mttr: count ? minutes / count : 0, excluded: !!o.exclude };
  });
  const extra = c.extra.map((e) => ({
    key: e.key,
    label: e.label,
    sub: "manual",
    count: e.count,
    minutes: e.minutes,
    mttr: e.count ? e.minutes / e.count : 0,
    excluded: !!c.overrides[e.key]?.exclude,
    manual: true,
  }));
  return [...base, ...extra].sort((a, b) => b.minutes - a.minutes);
}
const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b),
    m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
function jackCuts(rows: JackRow[], c: JackConfig) {
  const live = rows.filter((r) => !r.excluded && r.count > 0);
  if (c.cutMode === "manual") return { q: c.cutQ, t: c.cutT };
  const f = c.cutMode === "mean" ? mean : median;
  return { q: f(live.map((r) => r.count)), t: f(live.map((r) => r.mttr)) };
}
export function jackknifeItems(data: Analytics, c: JackConfig): JackSpec {
  const rows = jackRows(data, c);
  const { q, t } = jackCuts(rows, c);
  return {
    items: rows
      .filter((r) => !r.excluded && r.count > 0)
      .map((r) => ({ key: r.key, label: r.label, sub: r.sub, count: r.count, mttr: r.mttr, category: classify(r.count, r.mttr, q, t) })),
    qCut: q,
    tCut: t,
    scale: c.scale,
    labels: c.labels,
    numbered: true,
  };
}
export function autoPareto(data: Analytics): ParetoSpec {
  return {
    items: data.machines.map((m) => ({ key: m.key, label: m.short || m.name, sub: m.unit, value: m.minutes, count: m.count })),
    metricLabel: "Tempo de parada",
    unit: "min",
    cut: 80,
    highlight: "cut",
  };
}
export function autoJackknife(data: Analytics, view: "machines" | "failures" = "machines"): JackSpec {
  if (view === "failures")
    return {
      items: (data.failures || []).map((f) => ({ key: f.key, label: f.name, sub: "", count: f.count, mttr: f.mttr, category: f.category })),
      qCut: data.f_q_threshold,
      tCut: data.f_mttr_threshold,
      scale: "log",
      labels: false,
      numbered: true,
    };
  return {
    items: data.machines.map((m) => ({ key: m.key, label: m.short || m.name, sub: m.unit, count: m.count, mttr: m.mttr, category: m.category })),
    qCut: data.q_threshold,
    tCut: data.mttr_threshold,
    scale: "log",
    labels: false,
    numbered: true,
  };
}

/* ======================= Indicadores ======================= */
export const KPI_CATALOG: { id: string; label: string; icon: string }[] = [
  { id: "count", label: "Falhas (Q)", icon: "file" },
  { id: "minutes", label: "Tempo de parada", icon: "clock" },
  { id: "mttr", label: "MTTR", icon: "chart" },
  { id: "machines", label: "Equipamentos", icon: "machine" },
  { id: "critical", label: "Críticos-crônicos", icon: "target" },
  { id: "top3", label: "Concentração top 3", icon: "up" },
  { id: "worst", label: "Maior parada", icon: "info" },
  { id: "groups", label: "Descrições agrupadas", icon: "checks" },
  { id: "days", label: "Dias com apontamento", icon: "calendar" },
  { id: "topclass", label: "Falha que mais parou", icon: "target" },
  { id: "unclassified", label: "Sem modo identificado", icon: "info" },
];
export function kpiValue(id: string, data: Analytics) {
  const m = data.metrics;
  const total = data.machines.reduce((n, x) => n + x.minutes, 0);
  const top3 = data.machines.slice(0, 3).reduce((n, x) => n + x.minutes, 0);
  const worst = data.machines[0];
  const critical = data.machines.filter((x) => x.category === "Crítico-crônico").length;
  switch (id) {
    case "count":
      return {
        value: fmt(m.count),
        sub:
          data.count_mode === "lines"
            ? `linhas do SAP · ${fmt(m.events)} falhas reais`
            : `falhas reais · vieram de ${fmt(m.lines)} linhas do SAP`,
      };
    case "minutes":
      return { value: `${fmt(m.minutes / 60, 1)} h`, sub: `${fmt(m.minutes, 1)} minutos acumulados` };
    case "mttr":
      return { value: `${fmt(m.mttr, 1)} min`, sub: data.count_mode === "lines" ? "Tempo médio por linha do SAP" : "Tempo médio para reparar cada falha" };
    case "machines":
      return { value: fmt(m.machines), sub: `${m.days} dia(s) com apontamentos` };
    case "critical":
      return { value: fmt(critical), sub: `de ${fmt(data.machines.length)} equipamentos` };
    case "top3":
      return { value: `${fmt(total ? (top3 * 100) / total : 0, 1)}%`, sub: "da parada nos 3 maiores" };
    case "worst":
      return { value: worst ? worst.name : "—", sub: worst ? `${fmt(worst.minutes, 1)} min · ${worst.unit} / ${worst.line}` : "Sem dados" };
    case "groups":
      return { value: fmt(m.groups), sub: "Cards validados no quadro" };
    case "topclass": {
      const top = (data.failures || []).find((f) => f.key !== SEM_MODO) || data.failures?.[0];
      return top
        ? { value: top.name, sub: `${fmt(top.minutes, 1)} min · ${fmt(top.count)} falhas` }
        : { value: "—", sub: "Sem dados" };
    }
    case "unclassified": {
      const u = (data.failures || []).find((f) => f.key === SEM_MODO);
      return { value: fmt(u?.count || 0), sub: "falhas para análise manual" };
    }
    case "days":
      return { value: fmt(m.days), sub: "Datas distintas no filtro" };
    default:
      return { value: "—", sub: "" };
  }
}

/* ======================= Montador ======================= */
type Tab = "dashboard" | "pareto" | "jackknife";

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="b-step">
      <span className="b-num">{n}</span>
      <div>
        <b>{title}</b>
        {hint && <p>{hint}</p>}
        <div className="b-control">{children}</div>
      </div>
    </div>
  );
}
function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented wrap">
      {options.map(([v, l]) => (
        <button type="button" key={v} className={value === v ? "on" : ""} aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <i />
      {label}
    </button>
  );
}
const num = (v: string) => (v === "" ? 0 : Math.max(0, Number(v.replace(",", ".")) || 0));

export function ManualBuilder({
  data,
  tab: initial,
  config,
  onApply,
  onClose,
}: {
  data: Analytics;
  tab: Tab;
  config: ManualConfig;
  onApply: (config: ManualConfig) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initial);
  const [draft, setDraft] = useState<ManualConfig>(() => ({
    ...config,
    ...(initial !== "dashboard" ? { [initial]: { ...config[initial], enabled: true } } : {}),
  }));
  const preview = useRef<HTMLDivElement>(null);
  // Handlers estáveis (não mudam a cada render) para as linhas memorizadas da tabela.
  const setP = useCallback(
    (patch: Partial<ParetoConfig> | ((p: ParetoConfig) => Partial<ParetoConfig>)) =>
      setDraft((d) => ({ ...d, pareto: { ...d.pareto, ...(typeof patch === "function" ? patch(d.pareto) : patch) } })),
    [],
  );
  const setJ = useCallback(
    (patch: Partial<JackConfig> | ((j: JackConfig) => Partial<JackConfig>)) =>
      setDraft((d) => ({ ...d, jackknife: { ...d.jackknife, ...(typeof patch === "function" ? patch(d.jackknife) : patch) } })),
    [],
  );
  const override = useCallback(
    (kind: "pareto" | "jackknife", key: string, patch: Override) =>
      setDraft((d) => ({
        ...d,
        [kind]: { ...d[kind], overrides: { ...d[kind].overrides, [key]: { ...d[kind].overrides[key], ...patch } } },
      })),
    [],
  );
  const editExtra = useCallback(
    (kind: "pareto" | "jackknife", key: string, patch: Partial<Extra> | null) =>
      setDraft((d) => ({
        ...d,
        [kind]: {
          ...d[kind],
          extra:
            patch === null
              ? d[kind].extra.filter((x) => x.key !== key)
              : d[kind].extra.map((x) => (x.key === key ? { ...x, ...patch } : x)),
        },
      })),
    [],
  );
  const setAll = useCallback(
    (kind: "pareto" | "jackknife", keys: string[], include: boolean) =>
      setDraft((d) => {
        const overrides = { ...d[kind].overrides };
        for (const k of keys) overrides[k] = { ...overrides[k], exclude: !include };
        return { ...d, [kind]: { ...d[kind], overrides } };
      }),
    [],
  );
  const p = draft.pareto,
    j = draft.jackknife;
  // Tabela usa o estado atual; o gráfico usa uma cópia "adiada" para não travar a digitação.
  const later = useDeferredValue(draft);
  const pRows = useMemo(() => (tab === "pareto" ? paretoRows(data, p) : []), [data, p, tab]);
  const jRows = useMemo(() => (tab === "jackknife" ? jackRows(data, j) : []), [data, j, tab]);
  const pSpec = useMemo(() => paretoItems(data, later.pareto), [data, later.pareto]);
  const jSpec = useMemo(() => jackknifeItems(data, later.jackknife), [data, later.jackknife]);
  const pTotal = useMemo(() => pRows.reduce((n, r) => n + (r.excluded || r.value <= 0 ? 0 : r.value), 0), [pRows]);
  const cuts = useMemo(() => jackCuts(jRows, j), [jRows, j]);
  const autoCuts = useMemo(() => jackCuts(jRows, { ...j, cutMode: "median" }), [jRows, j]);
  const paretoChart = useMemo(() => <ParetoChart spec={pSpec} />, [pSpec]);
  const jackChart = useMemo(() => <JackknifeChart spec={jSpec} />, [jSpec]);
  const stale = later !== draft;

  return (
    <Modal title="Modo manual · monte do seu jeito" wide onClose={onClose}>
      <div className="builder">
        <div className="builder-top">
          <Seg<Tab>
            value={tab}
            onChange={setTab}
            options={[
              ["dashboard", "Dashboard"],
              ["pareto", "Pareto"],
              ["jackknife", "Jack-Knife"],
            ]}
          />
          <p className="helper">
            Os dados de partida são os apontamentos validados do filtro atual. Nada é alterado na base: as edições valem só para os gráficos.
          </p>
        </div>

        {tab === "dashboard" && (
          <div className="builder-body">
            <aside className="builder-steps">
              <Step n={1} title="Escolha os indicadores" hint="Selecione até 6 cartões para o topo do dashboard. A ordem segue a ordem dos cliques.">
                <div className="kpi-picks">
                  {KPI_CATALOG.map((k) => {
                    const on = draft.dashboard.kpis.includes(k.id);
                    return (
                      <button
                        type="button"
                        key={k.id}
                        className={`kpi-pick ${on ? "on" : ""}`}
                        aria-pressed={on}
                        disabled={!on && draft.dashboard.kpis.length >= 6}
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            dashboard: {
                              ...d.dashboard,
                              kpis: on ? d.dashboard.kpis.filter((x) => x !== k.id) : [...d.dashboard.kpis, k.id],
                            },
                          }))
                        }
                      >
                        <Icon name={on ? "check" : k.icon} size={14} />
                        {k.label}
                      </button>
                    );
                  })}
                </div>
              </Step>
              <Step n={2} title="Escolha os blocos" hint="Mostre ou oculte gráficos e a tabela de indicadores.">
                <div className="switch-list">
                  {(
                    [
                      ["jackknife", "Jack-Knife"],
                      ["pareto", "Pareto"],
                      ["table", "Tabela por equipamento"],
                    ] as const
                  ).map(([k, l]) => (
                    <Switch
                      key={k}
                      label={l}
                      on={draft.dashboard.sections[k]}
                      onChange={(v) => setDraft((d) => ({ ...d, dashboard: { ...d.dashboard, sections: { ...d.dashboard.sections, [k]: v } } }))}
                    />
                  ))}
                </div>
              </Step>
              <Step n={3} title="Ajuste os gráficos" hint="Use as abas Pareto e Jack-Knife para montar cada gráfico passo a passo.">
                <div className="b-inline">
                  <button type="button" className="btn secondary small" onClick={() => setTab("pareto")}>
                    Montar Pareto <Icon name="arrow" size={14} />
                  </button>
                  <button type="button" className="btn secondary small" onClick={() => setTab("jackknife")}>
                    Montar Jack-Knife <Icon name="arrow" size={14} />
                  </button>
                </div>
              </Step>
            </aside>
            <section className="builder-preview">
              <span className="b-label">Prévia dos indicadores</span>
              <div className="kpi-preview">
                {draft.dashboard.kpis.map((id, i) => {
                  const meta = KPI_CATALOG.find((k) => k.id === id)!;
                  const v = kpiValue(id, data);
                  return (
                    <article key={id} className={`stat ${i === 0 ? "stat-dark" : "stat-light"}`}>
                      <div className="stat-top">
                        <span>{meta.label}</span>
                        <span className="stat-icon">
                          <Icon name={meta.icon} size={15} />
                        </span>
                      </div>
                      <strong>{v.value}</strong>
                      <small>{v.sub}</small>
                    </article>
                  );
                })}
                {!draft.dashboard.kpis.length && <p className="helper">Nenhum indicador selecionado.</p>}
              </div>
              <div className="layout-preview">
                {draft.dashboard.sections.jackknife && <span>Jack-Knife</span>}
                {draft.dashboard.sections.pareto && <span>Pareto</span>}
                {draft.dashboard.sections.table && <span className="full">Tabela por equipamento</span>}
              </div>
            </section>
          </div>
        )}

        {tab === "pareto" && (
          <div className="builder-body">
            <aside className="builder-steps">
              <Switch label="Usar esta versão no dashboard" on={p.enabled} onChange={(v) => setP({ enabled: v })} />
              <Step n={1} title="O que agrupar" hint="Cada barra do Pareto representa um item deste agrupamento.">
                <Seg<Dim> value={p.groupBy} onChange={(v) => setP({ groupBy: v, overrides: {} })} options={dims} />
              </Step>
              <Step n={2} title="Qual medida ordenar" hint="As barras ficam em ordem decrescente desta medida.">
                <Seg
                  value={p.metric}
                  onChange={(v) => setP({ metric: v, overrides: {} })}
                  options={[
                    ["minutes", "Tempo de parada"],
                    ["count", "Falhas (Q)"],
                    ["mttr", "MTTR"],
                  ]}
                />
              </Step>
              <Step n={3} title="Linha de corte do acumulado" hint={`Itens até ${fmt(p.cut)}% do acumulado ficam em destaque (regra 80/20).`}>
                <div className="range-row">
                  <input type="range" min={50} max={95} step={5} value={p.cut} onChange={(e) => setP({ cut: Number(e.target.value) })} aria-label="Linha de corte" />
                  <b>{p.cut}%</b>
                </div>
                <Seg
                  value={p.highlight}
                  onChange={(v) => setP({ highlight: v })}
                  options={[
                    ["cut", "Destacar até o corte"],
                    ["top3", "Destacar top 3"],
                  ]}
                />
              </Step>
              <Step n={4} title="Quantos itens mostrar">
                <div className="range-row">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(pRows.length, 3)}
                    value={p.top}
                    onChange={(e) => setP({ top: Number(e.target.value) })}
                    aria-label="Quantidade de itens"
                  />
                  <b>{p.top ? `Top ${p.top}` : "Todos"}</b>
                </div>
              </Step>
              <Step n={5} title="Título do gráfico">
                <input value={p.title} placeholder="Pareto" maxLength={80} onChange={(e) => setP({ title: e.target.value })} />
              </Step>
            </aside>
            <section className="builder-preview" ref={preview}>
              <span className="b-label">Prévia · {p.title || "Pareto"}</span>
              <div className={`b-chart ${stale ? "updating" : ""}`}>{paretoChart}</div>
              <DataTable
                title="6. Revise os dados"
                hint="Desmarque itens, renomeie ou corrija valores. Também é possível incluir um item que não está na planilha."
                total={pRows.length}
                included={pRows.filter((r) => !r.excluded).length}
                onAll={(include) => setAll("pareto", pRows.map((r) => r.key), include)}
                onReset={() => setP({ overrides: {}, extra: [] })}
                onAdd={() =>
                  setP((cur) => ({ extra: [...cur.extra, { key: `extra-${Date.now()}`, label: "Novo item", value: 0, count: 0, minutes: 0 }] }))
                }
                head={[dimLabel[p.groupBy], metricInfo[p.metric].label, "%", ""]}
              >
                {pRows.map((r) => (
                  <ParetoRowView
                    key={r.key}
                    rowKey={r.key}
                    label={r.label}
                    sub={r.sub}
                    value={r.value}
                    excluded={r.excluded}
                    manual={!!r.manual}
                    pct={r.excluded || !pTotal ? "—" : `${fmt((r.value * 100) / pTotal, 1)}%`}
                    override={override}
                    editExtra={editExtra}
                  />
                ))}
              </DataTable>
            </section>
          </div>
        )}

        {tab === "jackknife" && (
          <div className="builder-body">
            <aside className="builder-steps">
              <Switch label="Usar esta versão no dashboard" on={j.enabled} onChange={(v) => setJ({ enabled: v })} />
              <Step n={1} title="O que comparar" hint="Cada ponto do Jack-Knife é um item deste agrupamento.">
                <Seg<Dim> value={j.groupBy} onChange={(v) => setJ({ groupBy: v, overrides: {} })} options={dims} />
              </Step>
              <Step n={2} title="Eixos" hint="Quantidade de falhas (Q) no eixo X e MTTR (minutos ÷ falhas) no eixo Y.">
                <Seg
                  value={j.scale}
                  onChange={(v) => setJ({ scale: v })}
                  options={[
                    ["linear", "Escala linear"],
                    ["log", "Escala logarítmica"],
                  ]}
                />
              </Step>
              <Step n={3} title="Linhas de corte" hint="Definem os quatro quadrantes: crítico, crônico, crítico-crônico e conforto.">
                <Seg
                  value={j.cutMode}
                  onChange={(v) =>
                    setJ({ cutMode: v, ...(v === "manual" && !j.cutQ && !j.cutT ? { cutQ: Number(autoCuts.q.toFixed(1)), cutT: Number(autoCuts.t.toFixed(1)) } : {}) })
                  }
                  options={[
                    ["median", "Mediana"],
                    ["mean", "Média"],
                    ["manual", "Valor manual"],
                  ]}
                />
                {j.cutMode === "manual" ? (
                  <div className="b-inline">
                    <label className="mini-field">
                      <span>Frequência (X)</span>
                      <input inputMode="decimal" value={j.cutQ} onChange={(e) => setJ({ cutQ: num(e.target.value) })} />
                    </label>
                    <label className="mini-field">
                      <span>MTTR em min (Y)</span>
                      <input inputMode="decimal" value={j.cutT} onChange={(e) => setJ({ cutT: num(e.target.value) })} />
                    </label>
                  </div>
                ) : (
                  <p className="b-note">
                    Cortes atuais: {fmt(cuts.q, 1)} falhas · {fmt(cuts.t, 1)} min de MTTR
                  </p>
                )}
              </Step>
              <Step n={4} title="Rótulos">
                <Switch label="Mostrar o nome de cada ponto" on={j.labels} onChange={(v) => setJ({ labels: v })} />
              </Step>
              <Step n={5} title="Título do gráfico">
                <input value={j.title} placeholder="Jack-Knife" maxLength={80} onChange={(e) => setJ({ title: e.target.value })} />
              </Step>
            </aside>
            <section className="builder-preview" ref={preview}>
              <span className="b-label">Prévia · {j.title || "Jack-Knife"}</span>
              <div className={`b-chart ${stale ? "updating" : ""}`}>{jackChart}</div>
              <DataTable
                title="6. Revise os dados"
                hint="O MTTR e a classe são recalculados conforme você edita falhas e minutos."
                total={jRows.length}
                included={jRows.filter((r) => !r.excluded).length}
                onAll={(include) => setAll("jackknife", jRows.map((r) => r.key), include)}
                onReset={() => setJ({ overrides: {}, extra: [] })}
                onAdd={() =>
                  setJ((cur) => ({ extra: [...cur.extra, { key: `extra-${Date.now()}`, label: "Novo item", value: 0, count: 1, minutes: 0 }] }))
                }
                head={[dimLabel[j.groupBy], "Falhas (Q)", "Minutos", "MTTR", "Classe", ""]}
              >
                {jRows.map((r) => (
                  <JackRowView
                    key={r.key}
                    rowKey={r.key}
                    label={r.label}
                    sub={r.sub}
                    count={r.count}
                    minutes={r.minutes}
                    mttr={r.mttr}
                    excluded={r.excluded}
                    manual={!!r.manual}
                    category={classify(r.count, r.mttr, cuts.q, cuts.t)}
                    override={override}
                    editExtra={editExtra}
                  />
                ))}
              </DataTable>
            </section>
          </div>
        )}

        <footer className="builder-footer">
          <button type="button" className="text-btn" onClick={() => setDraft(defaultManual)}>
            <Icon name="reset" size={15} />
            Restaurar tudo para o automático
          </button>
          {tab !== "dashboard" && (
            <button type="button" className="btn secondary small" onClick={() => svgToPng(preview.current?.querySelector(".b-chart svg") as SVGSVGElement | null, `${tab}-manual`)}>
              <Icon name="download" size={14} />
              Baixar PNG
            </button>
          )}
          <button type="button" className="btn secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={() => onApply(draft)}>
            <Icon name="check" size={16} />
            Aplicar no dashboard
          </button>
        </footer>
      </div>
    </Modal>
  );
}

type RowHandlers = {
  override: (kind: "pareto" | "jackknife", key: string, patch: Override) => void;
  editExtra: (kind: "pareto" | "jackknife", key: string, patch: Partial<Extra> | null) => void;
};

const ParetoRowView = memo(function ParetoRowView({
  rowKey,
  label,
  sub,
  value,
  excluded,
  manual,
  pct,
  override,
  editExtra,
}: { rowKey: string; label: string; sub: string; value: number; excluded: boolean; manual: boolean; pct: string } & RowHandlers) {
  return (
    <tr className={excluded ? "off" : ""}>
      <td>
        <input type="checkbox" checked={!excluded} aria-label={`Incluir ${label}`} onChange={(e) => override("pareto", rowKey, { exclude: !e.target.checked })} />
      </td>
      <td>
        <input
          className="cell-input"
          value={label}
          aria-label="Nome do item"
          onChange={(e) => (manual ? editExtra("pareto", rowKey, { label: e.target.value }) : override("pareto", rowKey, { label: e.target.value }))}
        />
        {sub && <small>{sub}</small>}
      </td>
      <td>
        <input
          className="cell-input num"
          inputMode="decimal"
          value={Number(value.toFixed(2))}
          aria-label="Valor"
          onChange={(e) =>
            manual ? editExtra("pareto", rowKey, { value: num(e.target.value) }) : override("pareto", rowKey, { value: num(e.target.value) })
          }
        />
      </td>
      <td>{pct}</td>
      <td>
        {manual && (
          <button type="button" className="icon-btn" aria-label="Remover item" onClick={() => editExtra("pareto", rowKey, null)}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </td>
    </tr>
  );
});

const JackRowView = memo(function JackRowView({
  rowKey,
  label,
  sub,
  count,
  minutes,
  mttr,
  excluded,
  manual,
  category,
  override,
  editExtra,
}: {
  rowKey: string;
  label: string;
  sub: string;
  count: number;
  minutes: number;
  mttr: number;
  excluded: boolean;
  manual: boolean;
  category: string;
} & RowHandlers) {
  const set = (patch: Partial<Extra> & Override) =>
    manual ? editExtra("jackknife", rowKey, patch) : override("jackknife", rowKey, patch);
  return (
    <tr className={excluded ? "off" : ""}>
      <td>
        <input type="checkbox" checked={!excluded} aria-label={`Incluir ${label}`} onChange={(e) => override("jackknife", rowKey, { exclude: !e.target.checked })} />
      </td>
      <td>
        <input className="cell-input" value={label} aria-label="Nome do item" onChange={(e) => set({ label: e.target.value })} />
        {sub && <small>{sub}</small>}
      </td>
      <td>
        <input className="cell-input num" inputMode="numeric" value={count} aria-label="Falhas" onChange={(e) => set({ count: num(e.target.value) })} />
      </td>
      <td>
        <input
          className="cell-input num"
          inputMode="decimal"
          value={Number(minutes.toFixed(2))}
          aria-label="Minutos"
          onChange={(e) => set({ minutes: num(e.target.value) })}
        />
      </td>
      <td>{fmt(mttr, 1)}</td>
      <td>
        {!excluded && (
          <span className="cat-dot" style={{ "--cat": categoryColor[category] } as React.CSSProperties}>
            {category}
          </span>
        )}
      </td>
      <td>
        {manual && (
          <button type="button" className="icon-btn" aria-label="Remover item" onClick={() => editExtra("jackknife", rowKey, null)}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </td>
    </tr>
  );
});

function DataTable({
  title,
  hint,
  head,
  children,
  total,
  included,
  onAll,
  onReset,
  onAdd,
}: {
  title: string;
  hint: string;
  head: string[];
  children: React.ReactNode;
  total: number;
  included: number;
  onAll: (include: boolean) => void;
  onReset: () => void;
  onAdd: () => void;
}) {
  const all = total > 0 && included === total,
    none = included === 0;
  return (
    <div className="b-table">
      <header>
        <div>
          <b>{title}</b>
          <p>{hint}</p>
        </div>
        <div className="b-inline">
          <button type="button" className="text-btn small" onClick={onReset}>
            <Icon name="reset" size={13} />
            Restaurar dados
          </button>
          <button type="button" className="btn secondary small" onClick={onAdd}>
            <Icon name="plus" size={14} />
            Adicionar item
          </button>
        </div>
      </header>
      <div className="b-select-bar">
        <span>
          <b>{fmt(included)}</b> de {fmt(total)} itens no gráfico
        </span>
        <button type="button" className="sel-btn" disabled={all} onClick={() => onAll(true)}>
          <Icon name="checks" size={13} />
          Marcar tudo
        </button>
        <button type="button" className="sel-btn" disabled={none} onClick={() => onAll(false)}>
          <Icon name="close" size={13} />
          Desmarcar tudo
        </button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label={all ? "Desmarcar tudo" : "Marcar tudo"}
                  title={all ? "Desmarcar tudo" : "Marcar tudo"}
                  checked={all}
                  ref={(el) => {
                    if (el) el.indeterminate = !all && !none;
                  }}
                  onChange={() => onAll(!all)}
                />
              </th>
              {head.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}
