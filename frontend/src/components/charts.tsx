"use client";
import { useRef, useState } from "react";
import {
  type Analytics,
  type Query,
  apiUrl,
  fmt,
  queryString,
  categoryColor,
  CATEGORIES,
} from "@/lib/radar";
import { Icon, Modal, ErrorNotice, Empty } from "./ui";
import {
  type ManualConfig,
  ManualBuilder,
  paretoItems,
  jackknifeItems,
  autoPareto,
  autoJackknife,
} from "./manual";

/* ---------- Tipos genéricos dos gráficos ---------- */
export type ParetoItem = {
  key: string;
  label: string;
  sub: string;
  value: number;
  count?: number;
};
export type ParetoSpec = {
  items: ParetoItem[];
  metricLabel: string;
  unit: string;
  cut: number;
  highlight: "cut" | "top3";
};
export type JackItem = {
  key: string;
  label: string;
  sub: string;
  count: number;
  mttr: number;
  category: string;
};
export type JackSpec = {
  items: JackItem[];
  qCut: number;
  tCut: number;
  scale: "linear" | "log";
  labels: boolean;
  numbered?: boolean;
};
export type JkView = "machines" | "failures";

export function classify(count: number, mttr: number, q: number, t: number) {
  const hq = count >= q,
    ht = mttr >= t;
  return hq && ht ? "Crítico-crônico" : ht ? "Crítico" : hq ? "Crônico" : "Conforto";
}

/** Quebra o rótulo do eixo em até duas linhas. */
function twoLines(label: string, size = 14) {
  if (label.length <= size) return [label, ""];
  const cut = label.lastIndexOf(" ", size) > 4 ? label.lastIndexOf(" ", size) : size;
  const rest = label.slice(cut).trim();
  return [label.slice(0, cut).trim(), rest.length > size ? `${rest.slice(0, size - 1)}…` : rest];
}

/* ---------- Pareto (item 2 do descritivo) ---------- */
export function ParetoChart({ spec }: { spec: ParetoSpec }) {
  const rows = spec.items;
  const total = rows.reduce((n, r) => n + r.value, 0);
  const cumulative = rows.reduce<number[]>((list, r) => {
    const prev = list.length ? list[list.length - 1] : 0;
    list.push(total ? Math.min(100, prev + (r.value * 100) / total) : 0);
    return list;
  }, []);
  const w = Math.max(640, rows.length * 78 + 110),
    h = 368,
    left = 56,
    right = w - 50,
    top = 40,
    bottom = 262;
  const max = Math.max(...rows.map((r) => r.value), 1) * 1.15;
  const slot = (right - left) / Math.max(rows.length, 1);
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  const cy = (v: number) => bottom - (v / 100) * (bottom - top);
  const strong = (i: number) =>
    spec.highlight === "top3" ? i < 3 : i === 0 || cumulative[i - 1] < spec.cut;
  const dense = rows.length > 16;
  if (!rows.length) return <p className="chart-empty">Nenhum item selecionado.</p>;
  return (
    <div className="chart-scroll">
      <svg
        role="img"
        aria-label={`Pareto de ${spec.metricLabel}`}
        className="data-chart"
        viewBox={`0 0 ${w} ${h}`}
        style={{ minWidth: w > 800 ? w : undefined }}
      >
        <text x={left} y="14" fontSize="10" fill="#8a8f98">
          {spec.metricLabel.toUpperCase()} ({spec.unit})
        </text>
        <text x={right} y="14" textAnchor="end" fontSize="10" fill="#8a8f98">
          % ACUMULADO
        </text>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={left} x2={right} y1={y((max * i) / 4)} y2={y((max * i) / 4)} stroke="#efecea" />
            <text x={left - 10} y={y((max * i) / 4) + 4} textAnchor="end" fontSize="10" fill="#8a8f98">
              {fmt((max * i) / 4)}
            </text>
            <text x={right + 10} y={cy(i * 25) + 4} fontSize="10" fill="#8a8f98">
              {i * 25}%
            </text>
          </g>
        ))}
        <line
          x1={left}
          x2={right}
          y1={cy(spec.cut)}
          y2={cy(spec.cut)}
          stroke="#e4002b"
          strokeOpacity="0.6"
          strokeDasharray="4 5"
        />
        <rect x={right + 4} y={cy(spec.cut) - 8} width="34" height="15" rx="4" fill="#fff" stroke="#e4002b" />
        <text x={right + 21} y={cy(spec.cut) + 3} textAnchor="middle" fontSize="9.5" fontWeight="800" fill="#e4002b">
          {fmt(spec.cut)}%
        </text>
        {rows.map((r, i) => {
          const bx = left + slot * i + slot * 0.18,
            bw = slot * 0.64,
            by = y(r.value),
            bh = Math.max(0, bottom - by);
          const [l1, l2] = twoLines(r.label, Math.max(8, Math.floor((slot - 6) / 5.6)));
          return (
            <g key={r.key}>
              <rect
                x={bx}
                y={by}
                width={bw}
                height={bh}
                rx="5"
                className="pareto-bar"
                style={{ animationDelay: `${i * 40}ms` }}
                fill={strong(i) ? "#c8001f" : "#e4002b"}
                fillOpacity={strong(i) ? 1 : 0.55}
              >
                <title>{`${r.label}${r.sub ? ` · ${r.sub}` : ""}\n${fmt(r.value, 2)} ${spec.unit}${r.count != null ? ` · ${r.count} falhas` : ""}\nAcumulado: ${fmt(cumulative[i], 1)}%`}</title>
              </rect>
              {!dense && (
                <g>
                  <rect x={bx + bw / 2 - 26} y={by - 19} width="52" height="15" rx="4" fill="#fff" stroke="#e5e1de" />
                  <text x={bx + bw / 2} y={by - 8} textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#1d1d1f">
                    {fmt(r.value, 1)}
                  </text>
                </g>
              )}
              {r.count != null && (
                <g>
                  <rect x={bx + bw / 2 - 18} y={bottom - 17} width="36" height="14" rx="7" fill="#1d1d1f" />
                  <text x={bx + bw / 2} y={bottom - 7} textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">
                    Q {fmt(r.count)}
                  </text>
                </g>
              )}
              <text x={left + slot * (i + 0.5)} y={bottom + 18} textAnchor="middle" fill="#2c2d31" fontSize="9.5">
                {l1}
              </text>
              <text x={left + slot * (i + 0.5)} y={bottom + 30} textAnchor="middle" fill="#2c2d31" fontSize="9.5">
                {l2}
              </text>
              {r.sub && (
                <text x={left + slot * (i + 0.5)} y={bottom + 43} textAnchor="middle" fill="#a29b97" fontSize="8.5">
                  {r.sub.slice(0, 16)}
                </text>
              )}
            </g>
          );
        })}
        <polyline
          points={rows.map((_, i) => `${left + slot * (i + 0.5)},${cy(cumulative[i])}`).join(" ")}
          fill="none"
          stroke="#1d1d1f"
          strokeWidth="2"
        />
        {rows.map((r, i) => (
          <g key={r.key}>
            <circle cx={left + slot * (i + 0.5)} cy={cy(cumulative[i])} r="3.5" fill="#fff" stroke="#1d1d1f" strokeWidth="2" />
            {!dense && (
              <text
                x={left + slot * (i + 0.5)}
                y={
                  Math.abs(cy(cumulative[i]) - (y(r.value) - 12)) < 18
                    ? cy(cumulative[i]) + 16
                    : cy(cumulative[i]) - 8
                }
                textAnchor="middle"
                fontSize="8.5"
                fontWeight="800"
                fill="#1d1d1f"
                stroke="#fff"
                strokeWidth="3"
                paintOrder="stroke"
              >
                {fmt(cumulative[i], 1)}%
              </text>
            )}
          </g>
        ))}
        <rect x={left} y={h - 16} width="9" height="9" rx="2" fill="#c8001f" />
        <text x={left + 15} y={h - 8} fontSize="10.5" fill="#565a63">
          {spec.metricLabel}
        </text>
        <rect x={left + 150} y={h - 17} width="26" height="11" rx="5.5" fill="#1d1d1f" />
        <text x={left + 163} y={h - 9} textAnchor="middle" fontSize="7.5" fontWeight="700" fill="#fff">
          Q
        </text>
        <text x={left + 182} y={h - 8} fontSize="10.5" fill="#565a63">
          Quantidade de falhas
        </text>
        <line x1={left + 318} x2={left + 338} y1={h - 12} y2={h - 12} stroke="#1d1d1f" strokeWidth="2" />
        <text x={left + 344} y={h - 8} fontSize="10.5" fill="#565a63">
          % acumulado
        </text>
      </svg>
    </div>
  );
}

/* ---------- Crítico-crônico / Jack-Knife (item 3 do descritivo) ---------- */
export function JackknifeChart({ spec }: { spec: JackSpec }) {
  const left = 64,
    right = 600,
    top = 34,
    bottom = 262;
  const items = spec.items;
  const log = spec.scale === "log";
  const maxQ = Math.max(...items.map((m) => m.count), spec.qCut, 1) * (log ? 2.2 : 1.3),
    maxT = Math.max(...items.map((m) => m.mttr), spec.tCut, 1) * (log ? 2.2 : 1.3);
  const minQ = log ? Math.max(0.5, Math.min(...items.map((m) => m.count), spec.qCut || 1) * 0.5) : 0;
  const minT = log ? Math.max(0.5, Math.min(...items.map((m) => m.mttr), spec.tCut || 1) * 0.5) : 0;
  const scale = (v: number, lo: number, hi: number) =>
    log
      ? (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo) || 1)
      : v / hi;
  const x = (q: number) => left + scale(q, minQ, maxQ) * (right - left),
    y = (t: number) => bottom - scale(t, minT, maxT) * (bottom - top);
  const cutX = x(spec.qCut),
    cutY = y(spec.tCut);
  const ticks = (lo: number, hi: number) =>
    log
      ? [1, 10, 100, 1000, 10000].filter((v) => v >= lo * 0.99 && v <= hi * 1.01)
      : [0, 1, 2, 3, 4].map((i) => (hi * i) / 4);
  // Curva de tempo total igual ao dos cortes (Q × MTTR constante).
  const k = spec.qCut * spec.tCut;
  const iso = Array.from({ length: 40 }, (_, i) => {
    const q = log ? minQ * Math.pow(maxQ / minQ, i / 39) : Math.max(0.05, (maxQ * (i + 1)) / 40);
    return [q, k / q] as const;
  }).filter(([, t]) => t >= (log ? minT : 0) && t <= maxT);
  if (!items.length) return <p className="chart-empty">Nenhum item selecionado.</p>;
  return (
    <svg
      role="img"
      aria-label="Crítico-crônico: número de falhas e MTTR, com quatro quadrantes"
      className="data-chart"
      viewBox="0 0 640 352"
    >
      <rect x={left} y={top} width={cutX - left} height={cutY - top} fill="#fdf6ea" />
      <rect x={cutX} y={top} width={right - cutX} height={cutY - top} fill="#fdedef" />
      <rect x={left} y={cutY} width={cutX - left} height={bottom - cutY} fill="#eef8f3" />
      <rect x={cutX} y={cutY} width={right - cutX} height={bottom - cutY} fill="#eef3fc" />
      {ticks(minT, maxT).map((v, i) => (
        <g key={`t${i}`}>
          <line x1={left} x2={right} y1={y(v)} y2={y(v)} stroke="#ffffff" />
          <text x={left - 10} y={y(v) + 4} fontSize="10" fill="#8a8f98" textAnchor="end">
            {fmt(v, log ? 0 : 1)}
          </text>
        </g>
      ))}
      {ticks(minQ, maxQ).map((v, i) => (
        <text key={`q${i}`} x={x(v)} y={bottom + 18} textAnchor="middle" fontSize="10" fill="#8a8f98">
          {fmt(v, log ? 0 : 1)}
        </text>
      ))}
      {iso.length > 1 && (
        <polyline
          points={iso.map(([q, t]) => `${x(q)},${y(t)}`).join(" ")}
          fill="none"
          stroke="#8a8f98"
          strokeWidth="1"
          strokeDasharray="2 4"
        >
          <title>Tempo total de parada igual ao dos cortes (Q × MTTR)</title>
        </polyline>
      )}
      <text x={left + 6} y={top + 13} fontSize="9.5" fontWeight="800" fill="#c27a12">CRÍTICO</text>
      <text x={right - 6} y={top + 13} textAnchor="end" fontSize="9.5" fontWeight="800" fill="#b8001f">CRÍTICO-CRÔNICO</text>
      <text x={left + 6} y={bottom - 6} fontSize="9.5" fontWeight="800" fill="#1f8a63">CONFORTO</text>
      <text x={right - 6} y={bottom - 6} textAnchor="end" fontSize="9.5" fontWeight="800" fill="#3a67c4">CRÔNICO</text>
      <line x1={cutX} x2={cutX} y1={top} y2={bottom} stroke="#2c2d31" strokeWidth="1.2" />
      <line x1={left} x2={right} y1={cutY} y2={cutY} stroke="#2c2d31" strokeWidth="1.2" />
      {/* Valores dos cortes, como no exemplo do descritivo */}
      <g>
        <rect x={cutX - 18} y={top - 17} width="36" height="15" rx="4" fill="#fff" stroke="#e4002b" />
        <text x={cutX} y={top - 6} textAnchor="middle" fontSize="9.5" fontWeight="800" fill="#e4002b">
          {fmt(spec.qCut, 1)}
        </text>
        <rect x={right + 3} y={cutY - 8} width="34" height="15" rx="4" fill="#fff" stroke="#e4002b" />
        <text x={right + 20} y={cutY + 3} textAnchor="middle" fontSize="9.5" fontWeight="800" fill="#e4002b">
          {fmt(spec.tCut, 1)}
        </text>
      </g>
      <text x={left} y="12" fontSize="10" fill="#8a8f98">
        MTTR (MIN){log ? " · ESCALA LOG" : ""}
      </text>
      <text x={(left + right) / 2} y="300" textAnchor="middle" fontSize="11" fill="#565a63">
        Nº de falhas{log ? " (escala log)" : ""}
      </text>
      {items.map((m, i) => (
        <g
          key={m.key}
          tabIndex={0}
          aria-label={`${i + 1}. ${m.label}${m.sub ? `, ${m.sub}` : ""}: ${m.count} falhas, MTTR ${fmt(m.mttr, 2)} minutos, ${m.category}`}
        >
          <circle
            cx={x(m.count)}
            cy={y(m.mttr)}
            r={spec.numbered ? 9 : 7}
            className="jk-dot"
            style={{ animationDelay: `${Math.min(i, 30) * 25}ms` }}
            fill={categoryColor[m.category]}
            stroke="white"
            strokeWidth="1.5"
          />
          {spec.numbered && (
            <text
              x={x(m.count)}
              y={y(m.mttr) + 3.5}
              textAnchor="middle"
              fontSize="9"
              fontWeight="800"
              fill="#fff"
              pointerEvents="none"
            >
              {i + 1}
            </text>
          )}
          <title>{`${i + 1}. ${m.label}${m.sub ? ` · ${m.sub}` : ""}\n${m.count} falhas · MTTR ${fmt(m.mttr, 2)} min\n${m.category}`}</title>
          {spec.labels && (
            <text x={x(m.count) + 12} y={y(m.mttr) + (i % 2 ? 13 : -9)} fill="#2c2d31" fontSize="10">
              {m.label.slice(0, 22)}
            </text>
          )}
        </g>
      ))}
      {CATEGORIES.map((label, i) => (
        <g key={label}>
          <circle cx={64 + i * 140} cy="336" r="4" fill={categoryColor[label]} />
          <text x={74 + i * 140} y="340" fontSize="10" fill="#565a63">
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* Exporta o SVG em PNG pelo navegador (usado nos gráficos manuais). */
export function svgToPng(svg: SVGSVGElement | null | undefined, name: string) {
  if (!svg) return;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const box = svg.viewBox.baseVal;
  clone.setAttribute("width", String(box.width));
  clone.setAttribute("height", String(box.height));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.style.fontFamily = "Arial, sans-serif";
  clone.querySelectorAll("rect.pareto-bar, circle.jk-dot").forEach((el) => {
    el.removeAttribute("class");
    el.removeAttribute("style");
  });
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = box.width * 2.5;
    canvas.height = box.height * 2.5;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const link = document.createElement("a");
    link.download = `${name}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };
  img.src = src;
}

type Kind = "pareto" | "jackknife";

export function Charts({
  data,
  query,
  manual,
  onManual,
  heading,
  period,
  view: viewProp,
  onView,
}: {
  data: Analytics;
  query: Query;
  manual: ManualConfig;
  onManual: (config: ManualConfig) => void;
  /** Linha analisada (ou "Todas as linhas"), para o cabeçalho dos gráficos. */
  heading: string;
  /** Período de análise, por extenso. */
  period: string;
  view?: JkView;
  onView?: (view: JkView) => void;
}) {
  const [expanded, setExpanded] = useState<Kind | null>(null);
  const [builder, setBuilder] = useState<Kind | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");
  const [ownView, setOwnView] = useState<JkView>("machines");
  const view = viewProp ?? ownView;
  const setView = onView ?? setOwnView;
  const paretoRef = useRef<HTMLDivElement>(null);
  const jackRef = useRef<HTMLDivElement>(null);
  const refs = { pareto: paretoRef, jackknife: jackRef };
  const isManual = (kind: Kind) => manual[kind].enabled;
  const paretoSpec = isManual("pareto") ? paretoItems(data, manual.pareto) : autoPareto(data);
  const jackSpec = isManual("jackknife") ? jackknifeItems(data, manual.jackknife) : autoJackknife(data, view);
  async function download(chart: Kind, format: string) {
    setError("");
    if (isManual(chart) || (chart === "jackknife" && view === "failures")) {
      svgToPng(refs[chart].current?.querySelector("svg"), `${chart}-${chart === "jackknife" ? view : "manual"}`);
      return;
    }
    setExporting(`${chart}-${format}`);
    try {
      const response = await fetch(apiUrl(`/api/workspace/export?${queryString({ ...query, chart, format })}`));
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.erro || "Falha na exportação.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${chart}-${query.from || "periodo"}.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting("");
    }
  }
  if (!data.machines.length)
    return (
      <Empty
        title="Nenhum apontamento neste filtro"
        text="Altere o período, a unidade, a linha, o equipamento, o tipo de parada ou a criticidade para consultar os dados."
      />
    );
  const visible = (["pareto", "jackknife"] as const).filter((k) => manual.dashboard.sections[k]);
  const render = (kind: Kind) =>
    kind === "pareto" ? <ParetoChart spec={paretoSpec} /> : <JackknifeChart spec={jackSpec} />;
  const titles: Record<Kind, string> = {
    pareto: (isManual("pareto") && manual.pareto.title) || "Pareto de falhas",
    jackknife:
      (isManual("jackknife") && manual.jackknife.title) ||
      `Crítico-crônico · ${view === "machines" ? "máquinas" : "falhas"}`,
  };
  const pdfAllowed = (kind: Kind) => !isManual(kind) && !(kind === "jackknife" && view === "failures");
  return (
    <>
      <ErrorNotice message={error} />
      {visible.length > 0 && (
        <div className="charts-stack">
          {visible.map((kind) => (
            <section className={`chart-panel ${isManual(kind) ? "is-manual" : ""}`} key={kind}>
              <header>
                <div>
                  <span className="chart-kicker">
                    {kind === "jackknife" ? "IMPACTO (CRÍTICO) × FREQUÊNCIA (CRÔNICO)" : "MÁQUINA MAIS CRÍTICA · TEMPO DE PARADA"}
                    {isManual(kind) && <em className="manual-tag">MANUAL</em>}
                  </span>
                  <h2>{titles[kind]}</h2>
                  <p className="chart-context">
                    <b>{heading}</b> · {period}
                  </p>
                </div>
                <div className="chart-actions">
                  {kind === "jackknife" && !isManual(kind) && (
                    <div className="segmented small" role="radiogroup" aria-label="Pontos do crítico-crônico">
                      {(
                        [
                          ["machines", "Máquinas"],
                          ["failures", "Falhas"],
                        ] as const
                      ).map(([k, l]) => (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={view === k}
                          className={view === k ? "on" : ""}
                          onClick={() => setView(k)}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    className="pencil-btn"
                    title="Fazer este gráfico manualmente"
                    aria-label={`Fazer ${kind} manualmente`}
                    onClick={() => setBuilder(kind)}
                  >
                    <Icon name="pencil" size={15} />
                    <span>Manual</span>
                  </button>
                  {(pdfAllowed(kind) ? ["png", "pdf"] : ["png"]).map((format) => (
                    <button
                      key={format}
                      className="export-btn"
                      title={`Exportar ${kind} em ${format.toUpperCase()}`}
                      aria-label={`Exportar ${kind} em ${format.toUpperCase()}`}
                      disabled={!!exporting}
                      onClick={() => void download(kind, format)}
                    >
                      {exporting === `${kind}-${format}` ? (
                        <span className="spinner small" />
                      ) : (
                        <Icon name={format === "pdf" ? "file" : "download"} size={15} />
                      )}
                      <span>{format.toUpperCase()}</span>
                    </button>
                  ))}
                  <button className="icon-btn" aria-label={`Ampliar ${kind}`} onClick={() => setExpanded(kind)}>
                    <Icon name="expand" size={16} />
                  </button>
                </div>
              </header>
              <div
                ref={refs[kind]}
                className="chart-click"
                role="button"
                tabIndex={0}
                aria-label={`Abrir gráfico ${kind} ampliado`}
                onClick={() => setExpanded(kind)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpanded(kind);
                  }
                }}
              >
                {render(kind)}
              </div>
              <footer>
                <Icon name="info" size={14} />
                {isManual(kind) ? (
                  <>
                    Versão montada manualmente.
                    <button
                      className="text-btn small back-auto"
                      onClick={() => onManual({ ...manual, [kind]: { ...manual[kind], enabled: false } })}
                    >
                      <Icon name="reset" size={13} />
                      Voltar ao automático
                    </button>
                  </>
                ) : kind === "jackknife" ? (
                  `Cortes: Q médio ${fmt(jackSpec.qCut, 1)} falhas · MTTR ${fmt(jackSpec.tCut, 1)} min (tempo total ÷ falhas). Os números dos pontos são a sequência da tabela abaixo.`
                ) : (
                  "Máquinas ordenadas pelo tempo de parada (colunas S/Q). Q no pé da coluna = quantidade de falhas."
                )}
                <span>Clique para ampliar</span>
              </footer>
            </section>
          ))}
        </div>
      )}
      {expanded && (
        <Modal title={`${titles[expanded]} · ${heading} · ${period}`} wide onClose={() => setExpanded(null)}>
          {render(expanded)}
          <p className="helper">
            Passe sobre um ponto ou uma barra para conferir os valores.
            {isManual(expanded)
              ? " Este gráfico foi montado manualmente."
              : " Linhas de corte do crítico-crônico: Q médio e MTTR do conjunto filtrado (tempo total ÷ nº de falhas), como no descritivo."}
          </p>
        </Modal>
      )}
      {builder && (
        <ManualBuilder
          data={data}
          tab={builder}
          config={manual}
          onApply={(config) => {
            onManual(config);
            setBuilder(null);
          }}
          onClose={() => setBuilder(null)}
        />
      )}
    </>
  );
}
