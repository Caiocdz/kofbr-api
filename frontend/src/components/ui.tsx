"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import {
  periodRange,
  CATEGORIES,
  categoryColor,
  categoryHint,
  COUNT_MODES,
  type CountMode,
} from "@/lib/radar";

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const p: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
    home: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    compare: (
      <>
        <path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    layers: <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />,
    bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2.5" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
    bot: (
      <>
        <rect x="4" y="8" width="16" height="11" rx="3" />
        <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.2h5" />
      </>
    ),
    brain: (
      <>
        <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3 3 3 0 0 0 3-3V7a3 3 0 0 0-3-3Z" />
        <path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3 3 3 0 0 1-3-3" />
      </>
    ),
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      </>
    ),
    search: (
      <>
        <circle cx="10.8" cy="10.8" r="6.8" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z" />,
    chart: (
      <>
        <path d="M4 3v17h17M8 16v-5m5 5V7m5 9v-7" />
      </>
    ),
    scatter: (
      <>
        <path d="M4 3v17h17" />
        <circle cx="9" cy="14" r="1.5" />
        <circle cx="14" cy="10" r="1.5" />
        <circle cx="18" cy="6" r="1.5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 10h18" />
      </>
    ),
    file: (
      <>
        <path d="M13 3H5v18h14V9zM13 3v6h6M8 13h8m-8 4h6" />
      </>
    ),
    filter: <path d="M4 6h16M7 12h10m-7 6h4" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    trash: <path d="M3 6h18M8 6V3h8v3m3 0-1 14H6L5 6m4 4v6m6-6v6" />,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10h.01" />
      </>
    ),
    grip: (
      <>
        <path
          d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"
          strokeWidth="3"
        />
      </>
    ),
    machine: (
      <>
        <rect x="3" y="6" width="18" height="14" rx="2" />
        <path d="M7 6V3h10v3M7 11h10m-10 5h4m6 0h.01" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    chevron: <path d="m7 10 5 5 5-5" />,
    left: <path d="m15 5-7 7 7 7" />,
    right: <path d="m9 5 7 7-7 7" />,
    pencil: (
      <>
        <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
        <path d="m13.5 6.5 4 4" />
      </>
    ),
    sheet: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M3 9h18M3 15h18M9 9v12" />
      </>
    ),
    checks: (
      <>
        <path d="m2 12 4 4 8-9M10 16l1 1 10-11" />
      </>
    ),
    sliders: (
      <path d="M4 6h10m4 0h2M4 12h4m4 0h8M4 18h12m4 0h0M16 4v4M10 10v4M18 16v4" />
    ),
    up: <path d="M12 19V5m-6 6 6-6 6 6" />,
    down: <path d="M12 5v14m-6-6 6 6 6-6" />,
    reset: <path d="M4 4v6h6M4.5 15a8 8 0 1 0 1.9-8.3L4 10" />,
    target: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" />
      </>
    ),
    refresh: (
      <path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 14-2l1 6M4 12l1 6a8 8 0 0 0 14-2" />
    ),
    undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
    redo: <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
    merge: <path d="M8 6h8M8 12h8M8 18h8M4 6v12" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {p[name] || p.file}
    </svg>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      if (e.key === "Tab") {
        const elements = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href],input,select,textarea,[tabindex="0"]',
          ) || [],
        );
        const first = elements[0],
          last = elements.at(-1);
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal ${wide ? "modal-wide" : ""}`}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" aria-label="Fechar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
export function ErrorNotice({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return message ? (
    <div className="error-notice" role="alert">
      <Icon name="info" />
      <span>{message}</span>
      {retry && <button onClick={retry}>Tentar novamente</button>}
    </div>
  ) : null;
}
export function Loading({ label = "Carregando dados…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        <span className="empty-folder" />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Heading({
  eyebrow,
  title,
  text,
  action,
}: {
  eyebrow: string;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action}
    </div>
  );
}
export function Stat({
  label,
  value,
  sub,
  icon,
  tone = "light",
  index = 0,
}: {
  label: string;
  value: string;
  sub: string;
  icon: string;
  tone?: "light" | "dark" | "red";
  index?: number;
}) {
  return (
    <article
      className={`stat stat-${tone}`}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">
          <Icon name={icon} size={17} />
        </span>
      </div>
      <strong>{value}</strong>
      <small>{sub}</small>
    </article>
  );
}
const modes = [
  ["range", "Intervalo"],
  ["day", "Dia"],
  ["week", "Semana"],
  ["month", "Mês"],
  ["year", "Ano"],
] as const;
export function Period({
  from,
  to,
  onChange,
  label = "Período",
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  label?: string;
}) {
  const [mode, setMode] = useState("range");
  const [local, setLocal] = useState({ value: "", range: "" });
  const rangeKey = `${from}/${to}`;
  const fallback =
    mode === "day" && from === to
      ? from
      : mode === "month"
        ? from.slice(0, 7)
        : mode === "year"
          ? from.slice(0, 4)
          : "";
  const value = local.range === rangeKey ? local.value : fallback;
  return (
    <div className="period-control">
      <div className="period-mode">
        <span>{label}</span>
        <div
          className="segmented"
          role="radiogroup"
          aria-label={`${label}: seleção`}
        >
          {modes.map(([key, text]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={mode === key}
              className={mode === key ? "on" : ""}
              onClick={() => {
                if (mode === key) return;
                setMode(key);
                setLocal({ value: "", range: "/" });
                onChange({ from: "", to: "" });
              }}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {mode === "range" ? (
        <>
          <label>
            <span>De</span>
            <input
              type="date"
              aria-label={`${label}: de`}
              value={from}
              max={to || undefined}
              onChange={(e) => onChange({ from: e.target.value, to })}
            />
          </label>
          <label>
            <span>Até</span>
            <input
              type="date"
              aria-label={`${label}: até`}
              value={to}
              min={from || undefined}
              onChange={(e) => onChange({ from, to: e.target.value })}
            />
          </label>
        </>
      ) : (
        <label className="period-value">
          <span>{mode === "year" ? "Ano" : "Selecione"}</span>
          <input
            aria-label={`${label}: valor`}
            type={mode === "year" ? "number" : mode === "day" ? "date" : mode}
            min={mode === "year" ? "1900" : undefined}
            max={mode === "year" ? "2200" : undefined}
            placeholder={mode === "year" ? "2026" : undefined}
            value={value}
            onChange={(e) => {
              const next = e.target.value;
              if (next && (mode !== "year" || /^\d{4}$/.test(next))) {
                const range = periodRange(mode, next);
                setLocal({ value: next, range: `${range.from}/${range.to}` });
                onChange(range);
              } else {
                setLocal({ value: next, range: "/" });
                onChange({ from: "", to: "" });
              }
            }}
          />
        </label>
      )}
    </div>
  );
}

export function CategoryFilter({
  value,
  onChange,
  counts,
}: {
  value: string;
  onChange: (value: string) => void;
  counts?: Record<string, number>;
}) {
  const selected = value ? value.split(",") : [];
  const toggle = (c: string) => {
    const next = selected.includes(c)
      ? selected.filter((v) => v !== c)
      : [...selected, c];
    onChange(CATEGORIES.filter((k) => next.includes(k)).join(","));
  };
  return (
    <div className="category-filter" role="group" aria-label="Criticidade e recorrência">
      <span className="category-filter-label">
        <Icon name="target" size={15} />
        Criticidade e recorrência
      </span>
      <div className="category-chips">
        <button
          type="button"
          className={`cat-chip all ${selected.length ? "" : "on"}`}
          aria-pressed={!selected.length}
          onClick={() => onChange("")}
        >
          Todas
        </button>
        {CATEGORIES.map((c) => (
          <button
            type="button"
            key={c}
            title={categoryHint[c]}
            aria-pressed={selected.includes(c)}
            className={`cat-chip ${selected.includes(c) ? "on" : ""}`}
            style={{ "--cat": categoryColor[c] } as React.CSSProperties}
            onClick={() => toggle(c)}
          >
            <i />
            {c}
            {counts && <b>{counts[c] ?? 0}</b>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Como contar o Q: falhas reais (O.S.) × linhas do SAP — explicado na tela. */
export function CountToggle({
  value,
  onChange,
  metrics,
}: {
  value: CountMode;
  onChange: (value: CountMode) => void;
  metrics?: { lines: number; events: number; with_order: number };
}) {
  return (
    <div className="count-toggle" role="group" aria-label="Como contar as falhas">
      <span className="category-filter-label">
        <Icon name="layers" size={15} />
        Como contar o Q
      </span>
      <div className="count-options">
        {(Object.keys(COUNT_MODES) as CountMode[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={value === k}
            className={`count-option ${value === k ? "on" : ""}`}
            onClick={() => onChange(k)}
          >
            <b>
              {COUNT_MODES[k].label}
              {k === "events" && <em>recomendado</em>}
            </b>
            <small>{COUNT_MODES[k].hint}</small>
          </button>
        ))}
      </div>
      {metrics && (
        <p className="count-explain">
          <Icon name="info" size={14} />
          Neste filtro: <b>{metrics.lines.toLocaleString("pt-BR")} linhas do SAP</b> ={" "}
          <b>{metrics.events.toLocaleString("pt-BR")} falhas reais</b>
          {metrics.with_order ? ` (${metrics.with_order.toLocaleString("pt-BR")} identificadas pela O.S.)` : ""}. O tempo de
          parada (T) é o mesmo nos dois modos; mudam o Q e o MTTR.
        </p>
      )}
    </div>
  );
}
