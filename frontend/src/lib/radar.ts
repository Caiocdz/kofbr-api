export type View = "inicio" | "importar" | "quadro" | "analise" | "comparar" | "gerar" | "fluxo" | "desempenho";
export type Route = { view: View; id?: string; day?: string; step?: number };
export type Daily = {
  date: string;
  count: number;
  minutes: number;
  series: number[];
};
export type Analysis = {
  id: string;
  revision: number;
  name: string;
  filename: string;
  created_at: string;
  updated_at: string;
  ready: boolean;
  days: string[];
  daily: Daily[];
  records_count: number;
  groups_count: number;
  validated_count: number;
  held_count: number;
  warnings: string[];
  minutes: number;
  /** "ml" = análise do fluxo único (validação por relato); "quadro" = quadro kanban. */
  mode?: "ml" | "quadro";
  step?: number;
  validated_lines?: number;
};
export type Column = {
  id: string;
  name: string;
  unit: string;
  line: string;
  validated: boolean;
};
export type Card = {
  id: string;
  column_id: string;
  name: string;
  record_ids: number[];
  validated: boolean;
  held: boolean;
  count: number;
  minutes: number;
  types: string[];
  dates: string[];
  sample: string;
  auto_class: string;
  failure_class: string;
  class: string;
  confidence: Confidence;
  reason: string;
  agreement: number;
  source: string;
  detail: string;
  events: number;
  orders: string[];
  validated_by?: string;
  suggestion?: string;
  frozen?: boolean;
};
export type Confidence = "alta" | "media" | "baixa" | "manual";
export type Automation = {
  cards: Record<Confidence, number>;
  records: Record<Confidence, number>;
  auto_rate: number;
  high_rate: number;
  lines: number;
  failures: number;
  with_order: number;
  memory: number;
  manual_changes: number;
  pending_high: number;
  learning: Learning;
};
export type Learning = {
  ready: boolean;
  examples: number;
  classes: number;
  min_examples: number;
  trained_at: string | null;
  accuracy: number | null;
  training?: boolean;
  /** Evolução do acerto medido a cada treino (mais antigo primeiro). */
  history?: { at: string; accuracy: number; examples: number; classes: number }[];
  /** Exemplos necessários para medir o acerto (20% separados para teste). */
  measure_min?: number;
  /** Uma entrada por planilha finalizada: quanto a ML acertou nela (mais antiga primeiro). */
  sheets?: SheetReport[];
};
export type SheetReport = {
  id: string;
  name: string;
  records: number;
  cards: number;
  /** % dos apontamentos em que a classe sugerida na chegada foi mantida pelo analista. */
  hit_rate: number;
  corrections: number;
  /** % dos apontamentos que já chegaram classificados pelo que foi aprendido antes. */
  from_past: number;
  unclassified: number;
  estimated?: boolean;
  finished_at?: string;
  examples_before?: number;
  examples_after?: number;
  model_before?: number | null;
  model_after?: number | null;
  model_ready?: boolean;
  memory?: number;
  previous_hit_rate?: number | null;
};
export const CONFIDENCE: Record<Confidence, { label: string; hint: string; color: string }> = {
  alta: { label: "Confiança alta", hint: "Regra ou termo único do catálogo confirmado pelo aprendizado, ou relato já corrigido antes pelo analista.", color: "#1f8a63" },
  media: { label: "Confiança média", hint: "O relato cita mais de um item, teve correção de digitação ou o card mistura classes. Dê uma olhada.", color: "#e89a1c" },
  baixa: { label: "Revisar", hint: "Nem o catálogo nem o aprendizado reconheceram. Precisa do analista.", color: "#e0101f" },
  manual: { label: "Pelo analista", hint: "Classe escolhida por uma pessoa. Fica na memória para os próximos dias.", color: "#3a67c4" },
};
export type Board = Analysis & {
  columns: Column[];
  cards: Card[];
  classes: string[];
  unclassified_count: number;
  automation: Automation;
  finished_at?: string | null;
  /** Próximo passo do Desfazer (Ctrl+Z) / Refazer (Ctrl+Y). */
  undo?: { action: string; card: string | null; count: number } | null;
  redo?: { action: string; card: string | null; count: number } | null;
  /** Ordem manual das caixas por coluna: "falha:<classe>" | "maquina:<coluna>" → ids. */
  layout?: Record<string, string[]>;
  events: {
    action: string;
    at: string;
    card: string | null;
    column: string | null;
    revision: number;
    value?: string | number;
  }[];
};
export type SourceRecord = {
  id: number;
  data_inicio: string;
  source_row: number;
  source_sheet: string;
  centro: string;
  linha: string;
  equipamento: string;
  observacao_raw: string;
  minutos_parada: number;
  original: Record<string, string>;
};
export type Detail = { total: number; page: number; records: SourceRecord[] };
export type Machine = {
  key: string;
  unit: string;
  line: string;
  name: string;
  count: number;
  lines: number;
  minutes: number;
  mttr: number;
  percent: number;
  cumulative: number;
  category: string;
  short: string;
};
export type FailureItem = {
  key: string;
  name: string;
  label: string;
  count: number;
  lines: number;
  minutes: number;
  mttr: number;
  percent: number;
  cumulative: number;
  category: string;
  machines: { name: string; lines: number }[];
};
export type Metrics = {
  count: number;
  events: number;
  lines: number;
  with_order: number;
  minutes: number;
  mttr: number;
  machines: number;
  groups: number;
  days: number;
  analyses: number;
};
export type BreakdownRow = {
  unit: string;
  line: string;
  machine: string;
  failure: string;
  mode: string;
  klass: string;
  count: number;
  lines: number;
  minutes: number;
};
export const CATEGORIES = [
  "Crítico-crônico",
  "Crítico",
  "Crônico",
  "Conforto",
] as const;
export const categoryColor: Record<string, string> = {
  "Crítico-crônico": "#e0101f",
  Crítico: "#e89a1c",
  Crônico: "#3a67c4",
  Conforto: "#1f8a63",
};
export const categoryHint: Record<string, string> = {
  "Crítico-crônico": "Muitas ocorrências e reparo demorado",
  Crítico: "Poucas ocorrências, reparo demorado",
  Crônico: "Muitas ocorrências, reparo rápido",
  Conforto: "Poucas ocorrências, reparo rápido",
};
export type Analytics = {
  metrics: Metrics;
  machines: Machine[];
  q_threshold: number;
  mttr_threshold: number;
  rows: BreakdownRow[];
  failures: FailureItem[];
  f_q_threshold: number;
  f_mttr_threshold: number;
  categories: Record<string, number>;
  count_mode: CountMode;
  category_filter: string[];
  total_machines: number;
};
export type Filters = {
  units: string[];
  lines: string[];
  failures: string[];
  days: string[];
  machines: string[];
  classes: string[];
};
export type Query = {
  from: string;
  to: string;
  unit: string;
  line: string;
  failure: string;
  category: string;
  machine: string;
  count?: CountMode;
  ids?: string;
};
export type CountMode = "events" | "lines";
export const COUNT_MODES: Record<CountMode, { label: string; short: string; hint: string }> = {
  events: {
    label: "Falhas reais",
    short: "falhas",
    hint: "1 falha = 1 O.S. na mesma máquina. O SAP fatia uma parada longa em linhas de 1 h; aqui elas contam uma vez só. Sem O.S., horários encostados com o mesmo relato também viram uma falha.",
  },
  lines: {
    label: "Linhas do SAP",
    short: "linhas",
    hint: "Cada linha da planilha conta 1, como no SAP. Uma parada de 3 h vira 3 ocorrências — infla o Q e reduz o MTTR.",
  },
};
/** Ação sugerida para cada quadrante do Jack-Knife (descritivo / apresentação). */
export const STRATEGY: Record<string, { title: string; text: string; tools: string[] }> = {
  "Crítico-crônico": {
    title: "Atacar primeiro",
    text: "Quebra muito e demora para voltar. Abra análise de causa raiz e revise o plano de manutenção.",
    tools: ["RCA (causa raiz)", "FMEA", "Plano de ação"],
  },
  Crítico: {
    title: "Reduzir o tempo de reparo",
    text: "Quebra pouco, mas cada parada é longa. Garanta sobressalente, procedimento e diagnóstico rápido.",
    tools: ["FTA (árvore de falhas)", "Kit/sobressalente", "Procedimento de reparo"],
  },
  Crônico: {
    title: "Eliminar a recorrência",
    text: "Paradas curtas e frequentes. Ataque a causa repetitiva com preventiva e padrão de operação.",
    tools: ["RCM", "Preventiva/lubrificação", "Ajuste de padrão"],
  },
  Conforto: {
    title: "Monitorar",
    text: "Pouco impacto hoje. Acompanhe a tendência para não subir de quadrante.",
    tools: ["Monitoramento", "Inspeção de rota"],
  },
};
export type Comparison = {
  a: Analytics;
  b: Analytics;
  changes: (Machine & {
    before: number;
    after: number;
    delta: number;
    percentage: number | null;
    direction: string;
  })[];
  period_a: { from: string; to: string };
  period_b: { from: string; to: string };
  days_a: number;
  days_b: number;
};
export const emptyQuery: Query = {
  from: "",
  to: "",
  unit: "",
  line: "",
  failure: "",
  category: "",
  machine: "",
  count: "events",
};
export const fmt = (v: number, decimals = 0) =>
  Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: decimals });
export const dateLabel = (v: string) =>
  v ? new Date(`${v.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR") : "—";
export const dateLong = (v: string) =>
  new Date(`${v}T12:00:00`).toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "long",
  });
export function apiUrl(path: string) {
  const base = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  if (base) return `${base}${path}`;
  if (typeof window !== "undefined" && window.location.port === "3000")
    return `${window.location.protocol}//${window.location.hostname}:5000${path}`;
  return path;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public existingId?: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/workspace${path}`), init);
  } catch {
    throw new Error(
      "Não foi possível conectar à API. Verifique se o Python está em execução.",
    );
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      json.erro || `Não foi possível concluir (${res.status}).`,
      res.status,
      json.existing_id,
    );
  return json;
}
export const queryString = (values: object) =>
  new URLSearchParams(
    Object.entries(values).filter(([, v]) => v != null && v !== ""),
  ).toString();
export function navigate(route: Route) {
  window.location.hash =
    route.view +
    (route.id ? `/${route.id}` : "") +
    (route.day ? `?dia=${route.day}` : route.step ? `?passo=${route.step}` : "");
}
export function readRoute(): Route {
  const [path, search] = window.location.hash.slice(1).split("?");
  const [view, id] = path.split("/");
  return {
    view: ["inicio", "importar", "quadro", "analise", "comparar", "gerar", "fluxo", "desempenho"].includes(view)
      ? (view as View)
      : "inicio",
    id,
    day: new URLSearchParams(search).get("dia") || undefined,
    step: Number(new URLSearchParams(search).get("passo")) || undefined,
  };
}
export function periodRange(
  mode: string,
  value: string,
): { from: string; to: string } {
  if (!value) return { from: "", to: "" };
  if (mode === "day") return { from: value, to: value };
  if (mode === "month") {
    const [y, m] = value.split("-").map(Number);
    return {
      from: `${value}-01`,
      to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
    };
  }
  if (mode === "year") return { from: `${value}-01-01`, to: `${value}-12-31` };
  if (mode === "week") {
    const [year, week] = value.split("-W").map(Number);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const monday = new Date(
      +jan4 -
        ((jan4.getUTCDay() + 6) % 7) * 86400000 +
        (week - 1) * 7 * 86400000,
    );
    return {
      from: monday.toISOString().slice(0, 10),
      to: new Date(+monday + 6 * 86400000).toISOString().slice(0, 10),
    };
  }
  return { from: "", to: "" };
}

export function downloadExcel(query: Partial<Query>) {
  const link = document.createElement("a");
  link.href = apiUrl(`/api/workspace/export/xlsx?${queryString(query)}`);
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export const SEM_MODO = "SEM MODO DE FALHA IDENTIFICADO";
export const SEM_DESCRICAO = "SEM DESCRIÇÃO";
export const prettyClass = (label: string) => {
  const t = (label || "").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const shortLine = (line: string) => {
  const m = /^\s*LINHA\s*0*(\d+)\s*$/i.exec(line || "");
  return m ? `L${m[1].padStart(2, "0")}` : line;
};
const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
/** "Janeiro de 2026 à Abril de 2026", "13/09/2026 – 15/09/2026" ou "13/09/2026". */
export function periodTitle(from: string, to: string, days: string[] = []) {
  const a = from || days[0] || "",
    b = to || days.at(-1) || "";
  if (!a) return "Todo o período";
  const label = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString("pt-BR");
  if (a === b) return label(a);
  const firstOfMonth = a.endsWith("-01");
  const [by, bm] = b.split("-").map(Number);
  const lastOfMonth = new Date(Date.UTC(by, bm, 0)).toISOString().slice(0, 10) === b;
  if (firstOfMonth && lastOfMonth) {
    const ma = `${MONTHS[Number(a.slice(5, 7)) - 1]} de ${a.slice(0, 4)}`,
      mb = `${MONTHS[bm - 1]} de ${by}`;
    return ma === mb ? ma : `${ma} à ${mb}`;
  }
  return `${label(a)} – ${label(b)}`;
}
