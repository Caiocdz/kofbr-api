"use client";
/* Painel de revisão do quadro e lote seguro.

   Ideia: a ferramenta faz o trabalho repetitivo (agrupar, classificar, contar
   falhas por O.S.) e diz com que confiança fez cada coisa. O analista só gasta
   tempo no que a máquina não tem certeza — e cada correção vira memória, então
   amanhã sobra menos para revisar. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fmt,
  prettyClass,
  CONFIDENCE,
  type Board,
  type Card,
  type Confidence,
} from "@/lib/radar";
import { Icon, Modal, ErrorNotice } from "./ui";

export type Queue = "" | Confidence;

const ORDER: Confidence[] = ["alta", "media", "baixa", "manual"];

export function ConfidenceBadge({ card, compact = false }: { card: Card; compact?: boolean }) {
  const c = CONFIDENCE[card.confidence] || CONFIDENCE.media;
  return (
    <span
      className={`conf-badge conf-${card.confidence}`}
      title={`${c.label}: ${card.reason}${card.detail ? ` Manifestação: ${card.detail}.` : ""}`}
    >
      <i />
      {!compact && (card.confidence === "alta" ? "Alta" : card.confidence === "media" ? "Média" : card.confidence === "baixa" ? "Revisar" : "Analista")}
    </span>
  );
}

export type GroupBy = "falha" | "maquina";

const SHORT: Record<Confidence, string> = { alta: "Alta", media: "Média", baixa: "Revisar", manual: "Analista" };

/** Barra única do quadro: visão, filtro de confiança, busca, lote seguro e o menu "Mais". */
export function ReviewBar({
  board,
  queue,
  onQueue,
  onBatch,
  groupBy,
  onGroupBy,
  search,
  onSearch,
  busy,
  more,
}: {
  board: Board;
  queue: Queue;
  onQueue: (q: Queue) => void;
  onBatch: () => void;
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  search: string;
  onSearch: (v: string) => void;
  busy: boolean;
  more: ReactNode;
}) {
  const a = board.automation;
  return (
    <section className="review-bar" aria-label="Revisão do dia">
      <div className="segmented small group-toggle" role="radiogroup" aria-label="Agrupar colunas por">
        {(
          [
            ["falha", "Por falha"],
            ["maquina", "Por máquina"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={groupBy === k} className={groupBy === k ? "on" : ""} onClick={() => onGroupBy(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="queue-tabs" role="radiogroup" aria-label="Filtrar por confiança">
        <button role="radio" aria-checked={queue === ""} className={queue === "" ? "on" : ""} onClick={() => onQueue("")}>
          Todos
        </button>
        {ORDER.filter((k) => a.cards[k] > 0 || queue === k).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={queue === k}
            className={`q-${k} ${queue === k ? "on" : ""}`}
            onClick={() => onQueue(queue === k ? "" : k)}
            title={`${CONFIDENCE[k].label}: ${CONFIDENCE[k].hint}`}
          >
            <i />
            {SHORT[k]} <span>{fmt(a.cards[k])}</span>
          </button>
        ))}
      </div>
      <label className="search-box">
        <Icon name="search" size={16} />
        <input aria-label="Buscar no quadro" placeholder="Buscar equipamento ou relato…" value={search} onChange={(e) => onSearch(e.target.value)} />
      </label>
      <button className="btn small secondary" disabled={busy || !a.pending_high} onClick={onBatch} title="Valida de uma vez os cards de confiança alta, depois de conferir uma amostra">
        <Icon name="checks" size={15} />
        Validar confiança alta ({fmt(a.pending_high)})
      </button>
      {more}
    </section>
  );
}

/** Menu "Mais": guarda as ações e informações secundárias fora da tela principal. */
export function MoreMenu({ children }: { children: ReactNode }) {
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
    <div className="more-menu" ref={ref}>
      <button className="icon-btn" aria-label="Mais opções" aria-expanded={open} title="Mais opções" onClick={() => setOpen(!open)}>
        <Icon name="menu" size={18} />
      </button>
      {open && (
        <div className="more-menu-panel" role="menu" onClick={(e) => (e.target as HTMLElement).closest("[data-close]") && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Resumo da automação e do aprendizado, exibido dentro do menu "Mais". */
export function AutomationSummary({ board, onTrain, training }: { board: Board; onTrain: () => void; training: boolean }) {
  const a = board.automation;
  const l = a.learning;
  const total = board.records_count || 1;
  return (
    <div className="more-summary">
      <div className="auto-score" title="Apontamentos classificados sem ajuda (catálogo, memória ou aprendizado)">
        <b>{fmt(a.auto_rate, 1)}%</b>
        <span>classificado automaticamente</span>
      </div>
      <div className="auto-bar" role="img" aria-label="Distribuição dos apontamentos por confiança">
        {ORDER.map((k) =>
          a.records[k] ? (
            <i key={k} className={`seg-${k}`} style={{ width: `${(a.records[k] / total) * 100}%` }} title={`${CONFIDENCE[k].label}: ${fmt(a.records[k])} apontamentos`} />
          ) : null,
        )}
      </div>
      <div className="learn-line">
        <Icon name="brain" size={15} />
        <span>
          {l?.ready ? (
            <>
              Aprendizado: <b>{fmt(l.examples)}</b> exemplos{l.accuracy != null && <> · acerto ~<b>{fmt(l.accuracy)}%</b></>}
            </>
          ) : (
            <>
              Aprendizado: {fmt(l?.examples || 0)}/{l?.min_examples || 20} exemplos
            </>
          )}
        </span>
        <button type="button" className="text-btn small" disabled={training} onClick={onTrain}>
          {training ? "Treinando…" : "Treinar"}
        </button>
      </div>
    </div>
  );
}

function sample<T>(list: T[], n: number) {
  // Amostra estável (mesma a cada abertura) espalhada pela lista.
  if (list.length <= n) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
}

export function SafeBatchModal({
  board,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  board: Board;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
}) {
  const [checked, setChecked] = useState(false);
  const cards = useMemo(
    () =>
      board.cards
        .filter((c) => (c.confidence === "alta" || c.confidence === "manual") && !c.validated && !c.held)
        .sort((x, y) => y.minutes - x.minutes),
    [board],
  );
  const preview = sample(cards, 6);
  const records = cards.reduce((s, c) => s + c.count, 0);
  const rest = board.cards.filter((c) => !c.validated && !c.held).length - cards.length;
  return (
    <Modal title="Validar só o que tem confiança alta" onClose={onClose} wide>
      <div className="stack-form">
        <div className="confirm-summary">
          <div>
            <strong>{fmt(cards.length)}</strong>
            <span>cards de confiança alta</span>
          </div>
          <div>
            <strong>{fmt(records)}</strong>
            <span>apontamentos</span>
          </div>
          <div>
            <strong>{fmt(rest)}</strong>
            <span>continuam para você revisar</span>
          </div>
        </div>
        <p className="helper">
          Confira a amostra abaixo. Se estiver tudo certo, os cards de confiança alta são validados de uma vez. Os de
          confiança média e os de “Revisar” <b>não</b> entram — eles continuam no quadro esperando você.
        </p>
        <ul className="sample-list">
          {preview.map((c) => (
            <li key={c.id}>
              <span className={`class-chip ${c.failure_class ? "manual" : ""}`}>{prettyClass(c.class)}</span>
              <b>{c.sample || c.name}</b>
              <small>{c.reason}</small>
            </li>
          ))}
        </ul>
        <label className="check-label confirm-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          Conferi a amostra e concordo com as classes sugeridas.
        </label>
        <ErrorNotice message={error} />
        <button className="btn primary" disabled={busy || !checked || !cards.length} onClick={() => onConfirm(cards.map((c) => c.id))}>
          <Icon name="checks" size={17} />
          Validar {fmt(cards.length)} cards
        </button>
        <p className="helper">Fica registrado no histórico como validação em lote. Dá para desfazer card a card.</p>
      </div>
    </Modal>
  );
}
