"use client";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  api,
  apiUrl,
  navigate,
  fmt,
  dateLabel,
  prettyClass,
  SEM_MODO,
  SEM_DESCRICAO,
  type Board,
  type Card,
  type Column,
  type Confidence,
  type Detail,
  type SheetReport,
} from "@/lib/radar";
import { Icon, Modal, Loading, ErrorNotice } from "./ui";
import CatalogEditor from "./catalog";
import { ConfidenceBadge, MoreMenu, SafeBatchModal, type GroupBy, type Queue } from "./automation";

/** Coluna do quadro: uma máquina (visão por máquina) ou uma classe de falha (visão por falha). */
type ViewColumn = Column & { context: string; kind: GroupBy; local?: boolean };

/** Nome das ações no histórico, no Desfazer e nos avisos. */
const ACTION_LABEL: Record<string, string> = {
  validate_column: "Coluna validada",
  validate_card: "Validação de card",
  validate_all: "Todos os cards confirmados",
  set_class: "Troca de falha",
  set_classes: "Troca de falha em lote",
  validate_cards: "Validação de vários cards",
  validate_confident: "Lote de confiança alta",
  hold: "Card enviado ao sino",
  move: "Card movido",
  add_column: "Coluna criada",
  delete_column: "Coluna excluída",
  rename_card: "Descrição editada",
  split_card: "Registros desagrupados",
  merge_cards: "Relatos agrupados",
  reorder: "Ordem das caixas",
  undo: "Ação desfeita",
  redo: "Ação refeita",
};

/** Semáforo da machine learning: verde = confiável, amarelo = conferir, vermelho = revisar. */
const TONE: Record<Confidence, string> = { alta: "ok", media: "warn", baixa: "bad", manual: "man" };
const RANK: Record<string, number> = { baixa: 3, media: 2, manual: 1, alta: 0 };
const LIGHTS: { key: Confidence; label: string; hint: string }[] = [
  { key: "alta", label: "Confiáveis", hint: "A ML e o catálogo concordam. Pode validar em lote." },
  { key: "media", label: "Conferir", hint: "A ML tem dúvida ou o relato cita mais de um item." },
  { key: "baixa", label: "Revisar", hint: "Nem o catálogo nem a ML reconheceram. Precisa de você." },
];

function Move({
  columns,
  busy,
  onMove,
}: {
  columns: (Column & { context?: string })[];
  busy: boolean;
  onMove: (id: string) => void;
}) {
  const [target, setTarget] = useState("");
  return (
    <div className="move-form">
      <select aria-label="Coluna de destino" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Escolher coluna…</option>
        {columns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} · {c.context ?? `${c.unit} / ${c.line}`}
            {c.validated ? " · validada" : ""}
          </option>
        ))}
      </select>
      <button className="btn small primary" disabled={!target || busy} onClick={() => onMove(target)}>
        Mover card <Icon name="arrow" size={14} />
      </button>
    </div>
  );
}

/* ===================== Arrastar e soltar =====================
   Arrasto próprio (eventos de ponteiro), sem o drag-and-drop nativo do navegador:
   - o item só começa a arrastar depois de 6px (clique simples continua abrindo o card);
   - uma linha vermelha mostra exatamente onde a caixa vai cair (em cima ou embaixo de outra);
   - o quadro e a coluna rolam sozinhos perto das bordas;
   - soltar fora de uma coluna cancela — o item volta para onde estava. */
type DragPayload = { ids: string[]; box: string; from: string; label: string; tone: string; machine?: string };
/** merge = id do card de destino quando o item é solto EM CIMA de outro card (agrupar). */
type Over = { col: string; before: string | null; last: string | null; merge?: string } | null;

type Handlers = {
  act: (action: string, fields?: object) => Promise<boolean>;
  details: (card: Card) => void;
  pickClass: (card: Card, anchor: HTMLElement) => void;
  grab: (e: React.PointerEvent, payload: DragPayload) => void;
  validateColumn: (columnId: string, cardIds: string[], filtered: boolean) => void;
  deleteColumn: (columnId: string) => void;
  validateCards: (cardIds: string[]) => void;
  toggleGroup: (key: string) => void;
};
const CARD_KEYS: (keyof Card)[] = ["id", "name", "validated", "held", "class", "failure_class", "count", "minutes", "column_id", "sample", "confidence", "reason", "events"];
const sameCard = (a: Card, b: Card) => a === b || CARD_KEYS.every((k) => a[k] === b[k]);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Aplica a ordem salva (em cima / embaixo); o que não tem posição salva mantém a ordem padrão, no fim. */
function arrange<T>(items: T[], keyOf: (t: T) => string, saved?: string[]) {
  if (!saved?.length) return items;
  const pos = new Map(saved.map((k, i) => [k, i]));
  return items
    .map((item, i) => ({ item, i, p: pos.get(keyOf(item)) ?? Infinity }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.item);
}

const KanbanCard = memo(
  function KanbanCard({
    card,
    busy,
    dragging,
    flash,
    dropHere,
    mergeHere,
    h,
  }: {
    card: Card;
    busy: boolean;
    dragging: boolean;
    flash: boolean;
    dropHere: boolean;
    mergeHere: boolean;
    h: Handlers;
  }) {
    const tone = card.validated ? "done" : TONE[card.confidence];
    return (
      <article
        data-box={card.id}
        data-card={card.id}
        className={`kb-box kb-card tone-${tone} ${dragging ? "is-dragging" : ""} ${flash ? "is-flash" : ""} ${dropHere ? "drop-before" : ""} ${mergeHere ? "is-merge-target" : ""}`}
        data-machine={card.column_id}
        onPointerDown={(e) =>
          !busy && h.grab(e, { ids: [card.id], box: card.id, from: card.column_id, label: card.name, tone, machine: card.column_id })
        }
      >
        <button type="button" className="kb-title" onClick={() => h.details(card)} title="Conferir os apontamentos originais">
          {card.name}
        </button>
        <button
          type="button"
          data-nodrag
          className={`kb-class ${card.class === SEM_MODO ? "warn" : card.class === SEM_DESCRICAO ? "muted" : ""}`}
          title={card.failure_class ? "Classe definida pelo analista · clique para trocar" : "Classe sugerida pela ML · clique para trocar"}
          disabled={busy}
          onClick={(e) => h.pickClass(card, e.currentTarget)}
        >
          {prettyClass(card.class)}
        </button>
        <footer>
          <span className="kb-meta">
            <ConfidenceBadge card={card} compact />
            {fmt(card.events)} {card.events === 1 ? "falha" : "falhas"} · {fmt(card.minutes, 0)} min
          </span>
          <span className="kb-actions">
            <button
              type="button"
              data-nodrag
              className="kb-icon"
              title="Enviar para revisão no sino"
              aria-label={`Enviar ${card.name} ao sino de revisão`}
              disabled={busy}
              onClick={() => void h.act("hold", { card_id: card.id })}
            >
              <Icon name="bell" size={14} />
            </button>
            <button
              type="button"
              data-nodrag
              className={`kb-check ${card.validated ? "on" : ""}`}
              title={card.validated ? "Desfazer validação" : "Validar"}
              aria-label={`${card.validated ? "Desfazer validação" : "Validar"}: ${card.name}`}
              disabled={busy}
              onClick={() => void h.act("validate_card", { card_id: card.id })}
            >
              <Icon name="check" size={14} />
            </button>
          </span>
        </footer>
      </article>
    );
  },
  (a, b) =>
    sameCard(a.card, b.card) &&
    a.busy === b.busy &&
    a.dragging === b.dragging &&
    a.flash === b.flash &&
    a.dropHere === b.dropHere &&
    a.mergeHere === b.mergeHere,
);

/** Na visão por falha, os relatos de uma mesma máquina ficam juntos em um único bloco. */
type MachineBucket = { key: string; name: string; line: string; cards: Card[]; minutes: number; events: number; pending: number };

const MachineGroup = memo(
  function MachineGroup({
    group,
    column,
    open,
    busy,
    dragging,
    dropHere,
    mergeId,
    flashId,
    onToggle,
    h,
  }: {
    group: MachineBucket;
    column: string;
    open: boolean;
    busy: boolean;
    dragging: boolean;
    dropHere: boolean;
    mergeId: string;
    flashId: string;
    onToggle: (key: string) => void;
    h: Handlers;
  }) {
    const done = group.pending === 0;
    const worst = group.cards
      .filter((c) => !c.validated)
      .reduce<string>((w, c) => (RANK[c.confidence] > (RANK[w] ?? -1) ? c.confidence : w), "");
    const tone = done ? "done" : TONE[worst as Confidence] || "ok";
    const ids = group.cards.map((c) => c.id);
    return (
      <article
        data-box={group.key}
        className={`kb-box kb-group tone-${tone} ${dragging ? "is-dragging" : ""} ${ids.includes(flashId) ? "is-flash" : ""} ${dropHere ? "drop-before" : ""}`}
        onPointerDown={(e) => !busy && h.grab(e, { ids, box: group.key, from: column, label: group.name, tone })}
      >
        <div className="kb-group-head">
          <button type="button" className="kb-group-toggle" aria-expanded={open} onClick={() => onToggle(group.key)}>
            <span className={`kb-chev ${open ? "open" : ""}`}>
              <Icon name="chevron" size={13} />
            </span>
            <span className="kb-group-text">
              <b title={group.name}>{group.name}</b>
              <small>
                {group.line ? `${group.line} · ` : ""}
                {fmt(group.events)} {group.events === 1 ? "falha" : "falhas"} · {fmt(group.minutes, 0)} min
              </small>
            </span>
          </button>
          <span className="kb-count" title={`${group.cards.length} relato(s)`}>
            {group.cards.length}
          </span>
          <button
            type="button"
            data-nodrag
            className={`kb-check ${done ? "on" : ""}`}
            disabled={busy || done}
            title={done ? "Todos os relatos desta máquina estão validados" : `Validar ${group.pending} relato(s) desta máquina`}
            aria-label={done ? `${group.name}: validado` : `Validar ${group.name}`}
            onClick={() => h.validateCards(group.cards.filter((c) => !c.validated && !c.held).map((c) => c.id))}
          >
            <Icon name="check" size={14} />
          </button>
        </div>
        {open && (
          <ul className="kb-items">
            {group.cards.map((card) => (
              <li
                key={card.id}
                data-card={card.id}
                data-machine={card.column_id}
                className={`kb-item tone-${card.validated ? "done" : TONE[card.confidence]} ${flashId === card.id ? "is-flash" : ""} ${mergeId === card.id ? "is-merge-target" : ""}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (!busy)
                    h.grab(e, {
                      ids: [card.id],
                      box: group.key,
                      from: column,
                      label: card.name,
                      tone: card.validated ? "done" : TONE[card.confidence],
                      machine: card.column_id,
                    });
                }}
              >
                <i className="kb-dot" />
                <button type="button" className="kb-item-title" title="Conferir os apontamentos originais" onClick={() => h.details(card)}>
                  {card.name}
                  <small>
                    {fmt(card.events)} {card.events === 1 ? "falha" : "falhas"} · {fmt(card.minutes, 0)} min
                  </small>
                </button>
                <span className="kb-actions">
                  <button
                    type="button"
                    data-nodrag
                    className="kb-icon"
                    title="Trocar a falha deste relato"
                    aria-label={`Trocar a falha de ${card.name}`}
                    disabled={busy}
                    onClick={(e) => h.pickClass(card, e.currentTarget)}
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    data-nodrag
                    className="kb-icon"
                    title="Enviar para revisão no sino"
                    aria-label={`Enviar ${card.name} ao sino de revisão`}
                    disabled={busy}
                    onClick={() => void h.act("hold", { card_id: card.id })}
                  >
                    <Icon name="bell" size={13} />
                  </button>
                  <button
                    type="button"
                    data-nodrag
                    className={`kb-check small ${card.validated ? "on" : ""}`}
                    title={card.validated ? "Desfazer validação" : "Validar relato"}
                    aria-label={`${card.validated ? "Desfazer validação" : "Validar"}: ${card.name}`}
                    disabled={busy}
                    onClick={() => void h.act("validate_card", { card_id: card.id })}
                  >
                    <Icon name="check" size={12} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </article>
    );
  },
  (a, b) =>
    a.open === b.open &&
    a.busy === b.busy &&
    a.dragging === b.dragging &&
    a.dropHere === b.dropHere &&
    a.mergeId === b.mergeId &&
    a.flashId === b.flashId &&
    a.column === b.column &&
    a.onToggle === b.onToggle &&
    a.group.key === b.group.key &&
    a.group.name === b.group.name &&
    a.group.cards.length === b.group.cards.length &&
    a.group.cards.every((c, i) => sameCard(c, b.group.cards[i])),
);

function bucketsOf(cards: Card[], machines: Map<string, Column>): MachineBucket[] {
  const map = new Map<string, MachineBucket>();
  for (const c of cards) {
    const m = machines.get(c.column_id);
    let g = map.get(c.column_id);
    if (!g) {
      g = { key: c.column_id, name: m?.name || "Máquina não informada", line: m?.line || "", cards: [], minutes: 0, events: 0, pending: 0 };
      map.set(c.column_id, g);
    }
    g.cards.push(c);
    g.minutes += c.minutes;
    g.events += c.events;
    if (!c.validated) g.pending += 1;
  }
  const list = [...map.values()];
  for (const g of list) g.cards.sort((x, y) => y.minutes - x.minutes);
  // Pendentes primeiro; dentro disso, a máquina com mais tempo parado em cima.
  return list.sort((x, y) => Number(x.pending === 0) - Number(y.pending === 0) || y.minutes - x.minutes);
}

const KanbanColumn = memo(
  function KanbanColumn({
    col,
    cards,
    allCount,
    validatedCount,
    order,
    busy,
    dragBox,
    drop,
    mergeId,
    flashId,
    machines,
    openKeys,
    h,
  }: {
    col: ViewColumn;
    cards: Card[];
    allCount: number;
    validatedCount: number;
    order: string[];
    busy: boolean;
    dragBox: string;
    /** undefined = nada sendo solto aqui; null = no fim da coluna; id = em cima desta caixa. */
    drop: string | null | undefined;
    mergeId: string;
    flashId: string;
    machines: Map<string, Column>;
    openKeys: string;
    h: Handlers;
  }) {
    const byClass = col.kind === "falha";
    const buckets = useMemo(
      () => (byClass ? arrange(bucketsOf(cards, machines), (g) => g.key, order) : []),
      [byClass, cards, machines, order],
    );
    const list = useMemo(() => (byClass ? [] : arrange(cards, (c) => c.id, order)), [byClass, cards, order]);
    const open = useMemo(() => new Set(openKeys ? openKeys.split("\n") : []), [openKeys]);
    const toggle = useCallback((key: string) => h.toggleGroup(`${col.id}|${key}`), [h, col.id]);
    const pct = allCount ? (validatedCount / allCount) * 100 : 0;
    // O botão valida o que está pendente NA TELA (respeita o filtro do semáforo e a busca).
    const pendingIds = cards.filter((c) => !c.validated && !c.held).map((c) => c.id);
    const doneInView = !pendingIds.length;
    const minutes = cards.reduce((n, c) => n + c.minutes, 0);
    return (
      <section
        data-column={col.id}
        className={`kb-col ${col.validated ? "is-done" : ""} ${drop !== undefined ? "is-over" : ""} ${drop === null ? "drop-end" : ""}`}
      >
        <header className="kb-col-head">
          <div className="kb-col-title">
            <h2 title={col.name}>{col.name}</h2>
            <span>
              {byClass
                ? allCount
                  ? `${fmt(buckets.length)} máquina(s) · ${fmt(minutes, 0)} min`
                  : col.context
                : col.context}
            </span>
          </div>
          <span className="kb-count">{fmt(allCount)}</span>
          {!allCount && (!byClass || col.local) ? (
            <button className="kb-icon" aria-label={`Excluir coluna ${col.name}`} title="Excluir coluna vazia" disabled={busy} onClick={() => h.deleteColumn(col.id)}>
              <Icon name="trash" size={14} />
            </button>
          ) : (
            <button
              className={`kb-check ${doneInView ? "on" : ""}`}
              disabled={busy || doneInView}
              title={
                doneInView
                  ? col.validated
                    ? "Coluna validada"
                    : "Tudo o que está na tela já foi validado"
                  : `Validar ${pendingIds.length} item(ns) pendente(s) desta coluna`
              }
              aria-label={doneInView ? `${col.name}: validada` : `Validar ${col.name}`}
              onClick={() => h.validateColumn(col.id, pendingIds, cards.length !== allCount)}
            >
              <Icon name="check" size={14} />
            </button>
          )}
        </header>
        <div className="kb-col-progress" aria-label={`${Math.round(pct)}% validado`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="kb-col-body">
          {byClass &&
            buckets.map((g) => (
              <MachineGroup
                key={g.key}
                group={g}
                column={col.id}
                open={open.has(`${col.id}|${g.key}`)}
                busy={busy}
                dragging={dragBox === g.key}
                dropHere={drop === g.key}
                mergeId={mergeId}
                flashId={flashId}
                onToggle={toggle}
                h={h}
              />
            ))}
          {!byClass &&
            list.map((card) => (
              <KanbanCard
                key={card.id}
                card={card}
                busy={busy}
                dragging={dragBox === card.id}
                flash={flashId === card.id}
                dropHere={drop === card.id}
                mergeHere={mergeId === card.id}
                h={h}
              />
            ))}
          {!cards.length && (
            <div className="kb-empty">{allCount ? "Nada neste filtro." : "Solte um item aqui."}</div>
          )}
        </div>
      </section>
    );
  },
  (a, b) =>
    (a.col === b.col ||
      (a.col.id === b.col.id && a.col.validated === b.col.validated && a.col.name === b.col.name && a.col.context === b.col.context)) &&
    a.machines === b.machines &&
    a.openKeys === b.openKeys &&
    a.allCount === b.allCount &&
    a.validatedCount === b.validatedCount &&
    a.busy === b.busy &&
    a.dragBox === b.dragBox &&
    a.drop === b.drop &&
    a.mergeId === b.mergeId &&
    a.flashId === b.flashId &&
    a.order === b.order &&
    a.cards.length === b.cards.length &&
    a.cards.every((c, i) => sameCard(c, b.cards[i])),
);

/** Barrinha de cima: arraste para rolar o quadro na horizontal (cada risco é uma coluna). */
function BoardRail({
  boardRef,
  segments,
}: {
  boardRef: React.RefObject<HTMLDivElement | null>;
  segments: { id: string; label: string; state: string }[];
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const grab = useRef(0);
  const [s, setS] = useState({ left: 0, width: 1, client: 1 });
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setS((prev) =>
        prev.left === el.scrollLeft && prev.width === el.scrollWidth && prev.client === el.clientWidth
          ? prev
          : { left: el.scrollLeft, width: el.scrollWidth, client: el.clientWidth },
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    const mo = new MutationObserver(onScroll);
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      ro.disconnect();
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [boardRef]);
  const thumbPct = Math.min(100, (s.client / Math.max(s.width, 1)) * 100);
  const leftPct = (s.left / Math.max(s.width, 1)) * 100;
  const scrollable = s.width > s.client + 2;
  const step = (dir: number) => boardRef.current?.scrollBy({ left: dir * 304, behavior: "smooth" });
  const drag = (clientX: number) => {
    const rail = railRef.current,
      el = boardRef.current;
    if (!rail || !el) return;
    const r = rail.getBoundingClientRect();
    el.scrollLeft = ((clientX - grab.current - r.left) / r.width) * el.scrollWidth;
  };
  return (
    <div className={`kb-rail-wrap ${scrollable ? "" : "static"}`}>
      <button className="kb-icon" aria-label="Rolar quadro para a esquerda" disabled={s.left <= 2} onClick={() => step(-1)}>
        <Icon name="left" size={16} />
      </button>
      <div
        className="kb-rail"
        ref={railRef}
        role="scrollbar"
        aria-controls="kanban-board"
        aria-orientation="horizontal"
        aria-valuenow={Math.round((s.left / Math.max(s.width - s.client, 1)) * 100)}
        aria-label="Arraste para rolar o quadro"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") step(1);
          if (e.key === "ArrowLeft") step(-1);
        }}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const thumbW = (r.width * thumbPct) / 100,
            thumbL = r.left + (r.width * leftPct) / 100;
          // Pegou na alça: mantém o ponto pego. Clicou fora: centraliza a alça no ponteiro.
          grab.current = e.clientX >= thumbL && e.clientX <= thumbL + thumbW ? e.clientX - thumbL : thumbW / 2;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.classList.add("is-dragging");
          drag(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e.clientX);
        }}
        onPointerUp={(e) => e.currentTarget.classList.remove("is-dragging")}
        onPointerCancel={(e) => e.currentTarget.classList.remove("is-dragging")}
      >
        <div className="kb-rail-segments">
          {segments.map((c) => (
            <span key={c.id} className={c.state} title={c.label} />
          ))}
        </div>
        <span className="kb-rail-thumb" style={{ left: `${leftPct}%`, width: `${thumbPct}%` }}>
          <Icon name="grip" size={13} />
        </span>
      </div>
      <button className="kb-icon" aria-label="Rolar quadro para a direita" disabled={s.left + s.client >= s.width - 2} onClick={() => step(1)}>
        <Icon name="right" size={16} />
      </button>
      <span className="kb-rail-count">{segments.length} colunas</span>
    </div>
  );
}

/** Menu único de classes (com busca), aberto a partir do card clicado. */
function ClassPicker({
  card,
  anchor,
  classes,
  onPick,
  onNew,
  onClose,
}: {
  card: Card;
  anchor: DOMRect;
  classes: string[];
  onPick: (value: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const scroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [onClose]);
  const list = classes.filter((c) => c.toLowerCase().includes(q.toLowerCase()));
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 360);
  const left = Math.min(anchor.left, window.innerWidth - 300);
  return (
    <div className="class-picker" ref={ref} style={{ top, left }} role="dialog" aria-label="Escolher classe de falha">
      <input autoFocus placeholder="Buscar classe…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar classe" />
      <div className="class-picker-list">
        <button type="button" className={!card.failure_class ? "on" : ""} onClick={() => onPick("")}>
          <Icon name="target" size={12} />
          Sugestão da ML · {prettyClass(card.auto_class)}
        </button>
        {list.map((c) => (
          <button type="button" key={c} className={card.failure_class === c ? "on" : ""} onClick={() => onPick(c)}>
            {prettyClass(c)}
          </button>
        ))}
        {!list.length && <p>Nenhuma classe encontrada.</p>}
      </div>
      <button type="button" className="class-picker-new" onClick={onNew}>
        <Icon name="plus" size={13} />
        Nova classe…
      </button>
    </div>
  );
}

/** Mini gráfico da evolução do acerto a cada treino. */
function Sparkline({ values }: { values: number[] }) {
  const w = 168,
    h = 46,
    pad = 4;
  const min = Math.max(0, Math.min(...values) - 3),
    max = Math.min(100, Math.max(...values) + 3);
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(values.length - 1, 1);
  const y = (v: number) => h - pad - ((v - min) / Math.max(max - min, 1)) * (h - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const last = values.length - 1;
  return (
    <svg className="kb-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`Acerto nos últimos ${values.length} treinos`}>
      <path className="area" d={`M${x(0)},${h - pad} L${pts.join(" L")} L${x(last)},${h - pad} Z`} />
      <polyline className="line" points={pts.join(" ")} />
      <circle cx={x(last)} cy={y(values[last])} r="3.5" />
    </svg>
  );
}

/** Painel do topo: a ML já filtrou tudo — quanto acerta, como evolui e o semáforo verde/amarelo/vermelho. */
function MlPanel({
  board,
  queue,
  onQueue,
  onTrain,
  training,
}: {
  board: Board;
  queue: Queue;
  onQueue: (q: Queue) => void;
  onTrain: () => void;
  training: boolean;
}) {
  const a = board.automation;
  const l = a.learning;
  const total = Object.values(a.records).reduce((n, v) => n + v, 0) || 1;
  // Dois números, os dois MEDIDOS (nunca "100%" com dois cards validados):
  // - acerto por planilha: ao finalizar, compara a classe que a ML sugeriu na chegada com a final do analista;
  // - acerto do modelo: treina com 80% dos relatos de planilhas finalizadas e testa nos 20% que não viu.
  const sheets = l?.sheets || [];
  const last = sheets.at(-1);
  const curve = sheets.map((x) => x.hit_rate);
  const delta = curve.length >= 2 ? curve[curve.length - 1] - curve[curve.length - 2] : null;
  const isThis = last?.id === board.id;
  const measured = l?.accuracy ?? null;
  const need = l?.measure_min || 60;
  const records = board.cards.reduce((n, c) => n + c.count, 0) || 1;
  const fromPast = board.cards.filter((c) => c.source === "memoria" || c.source === "aprendizado").reduce((n, c) => n + c.count, 0);
  const tone = (v: number) => (v >= 85 ? "ok" : v >= 70 ? "warn" : "bad");
  const trainedAt = l?.trained_at ? new Date(l.trained_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "";
  return (
    <section className="kb-ml" aria-label="Filtragem automática pela machine learning">
      <div className="kb-ml-score">
        <span className="kb-ml-badge">
          <Icon name="check" size={13} />
          Falhas já filtradas pela Machine Learning
        </span>
        <div className="kb-ml-main">
          {last ? (
            <div>
              <strong className={`tone-${tone(last.hit_rate)}`}>{fmt(last.hit_rate, 1)}%</strong>
              <span title="Apontamentos em que a classe sugerida pela ML na chegada da planilha foi mantida pelo analista">
                de acerto {isThis ? "nesta planilha" : "na última planilha finalizada"}
              </span>
            </div>
          ) : (
            <div className="kb-ml-calib">
              <strong>Aprendendo</strong>
              <span>A ML aprende quando você finaliza a planilha em “Ver análises”.</span>
            </div>
          )}
          {curve.length >= 2 ? (
            <div className="kb-ml-trend">
              <Sparkline values={curve} />
              <small>
                {delta != null && (
                  <b className={delta >= 0 ? "up" : "down"}>
                    {delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(delta), 1)} pts
                  </b>
                )}
                {` · ${fmt(curve[0], 0)}% → ${fmt(curve[curve.length - 1], 0)}% em ${curve.length} planilhas`}
              </small>
            </div>
          ) : (
            <div className="kb-ml-trend empty">
              <small>
                {last ? "A curva de evolução aparece a partir da 2ª planilha finalizada." : `${fmt(sheets.length)} planilha(s) finalizada(s) até agora.`}
              </small>
            </div>
          )}
        </div>
        <p className="kb-ml-foot">
          {fromPast > 0
            ? `${fmt((fromPast / records) * 100, 0)}% desta planilha já chegou classificada pelo que a ML aprendeu`
            : `${fmt(a.auto_rate, 1)}% dos apontamentos classificados sozinhos`}
          {measured != null
            ? ` · modelo: ${fmt(measured, 1)}% de acerto (${fmt(l?.examples || 0)} exemplos)`
            : ` · modelo: ${fmt(Math.min(l?.examples || 0, need))}/${fmt(need)} exemplos para medir`}
          {trainedAt ? ` · treino ${trainedAt}` : ""}
          <button type="button" className="kb-link" disabled={training} onClick={onTrain}>
            <Icon name="refresh" size={12} />
            {training ? "Treinando…" : "Treinar"}
          </button>
        </p>
      </div>
      <div className="kb-lights" role="radiogroup" aria-label="Filtrar pelo semáforo da ML">
        {LIGHTS.map(({ key, label, hint }) => {
          const share = (a.records[key] / total) * 100;
          const on = queue === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              className={`kb-light tone-${TONE[key]} ${on ? "on" : ""} ${queue && !on ? "dim" : ""}`}
              title={`${hint} Clique para filtrar.`}
              onClick={() => onQueue(on ? "" : key)}
            >
              <span className="kb-light-top">
                <i />
                {label}
              </span>
              <strong>{fmt(a.cards[key])}</strong>
              <span className="kb-light-bar">
                <i style={{ width: `${Math.max(share, a.records[key] ? 2 : 0)}%` }} />
              </span>
              <small>{fmt(share, 0)}% dos apontamentos</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default function Kanban({ id, onUpdate }: { id: string; onUpdate: () => void }) {
  const [board, setBoard] = useState<Board>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [bell, setBell] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [details, setDetails] = useState<Card | null>(null);
  const [detailData, setDetailData] = useState<Detail>();
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [rename, setRename] = useState("");
  const [adding, setAdding] = useState(false);
  const [newCol, setNewCol] = useState({ name: "", unit: "", line: "" });
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [over, setOver] = useState<Over>(null);
  const [history, setHistory] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState("");
  const [flash, setFlash] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [queue, setQueue] = useState<Queue>("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("falha");
  const [extraClasses, setExtraClasses] = useState<string[]>([]);
  const [newFailure, setNewFailure] = useState<string | null>(null);
  const [training, setTraining] = useState(false);
  const [newClass, setNewClass] = useState<{ card: string; value: string } | null>(null);
  const [picker, setPicker] = useState<{ card: Card; rect: DOMRect } | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  // Itens que acabaram de ser movidos/reclassificados continuam na tela mesmo com filtro ativo
  // (ex.: filtro "Confiáveis" + mudar a falha → o item vira "Analista" e sumiria do filtro).
  const [finishing, setFinishing] = useState(false);
  const [mergeAsk, setMergeAsk] = useState<{ src: Card; dst: Card } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: boolean; redo?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = useCallback((t: { text: string; undo?: boolean; redo?: boolean }) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);
  const [learned, setLearned] = useState<SheetReport | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const pin = useCallback((ids: string[]) => setPinned((prev) => new Set([...prev, ...ids])), []);
  const deferredSearch = useDeferredValue(search);
  const focusColumn = useCallback((columnId: string, cardId?: string) => {
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-column="${CSS.escape(columnId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
      if (cardId) {
        setFlash(cardId);
        setTimeout(() => setFlash(""), 1400);
        setTimeout(
          () => document.querySelector(`[data-card="${CSS.escape(cardId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
          60,
        );
      }
    });
  }, []);
  const load = useCallback(async () => {
    setError("");
    try {
      setBoard(await api<Board>(`/analyses/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    let active = true;
    api<Board>(`/analyses/${id}`)
      .then((b) => {
        if (active) setBoard(b);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    if (!bell) return;
    const click = (e: PointerEvent) => {
      if (!bellRef.current?.contains(e.target as Node)) setBell(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBell(false);
    };
    document.addEventListener("pointerdown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", click);
      document.removeEventListener("keydown", key);
    };
  }, [bell]);
  async function act(action: string, fields: object = {}) {
    if (!board || busy) return false;
    setBusy(true);
    setError("");
    try {
      const next = await api<Board>(`/analyses/${id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, revision: board.revision, ...fields }),
      });
      setBoard(next);
      if (action !== "reorder") onUpdate();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function showDetails(card: Card) {
    setDetails(card);
    setRename(card.name);
    setDetailData(undefined);
    setDetailError("");
    try {
      setDetailData(await api<Detail>(`/analyses/${id}/cards/${card.id}`));
    } catch (e) {
      setDetailError((e as Error).message);
    }
  }
  async function moreDetails() {
    if (!details || !detailData) return;
    setDetailBusy(true);
    try {
      const next = await api<Detail>(`/analyses/${id}/cards/${details.id}?page=${detailData.page + 1}`);
      setDetailData({ ...next, records: [...detailData.records, ...next.records] });
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setDetailBusy(false);
    }
  }
  async function finish() {
    setBusy(true);
    setFinishing(true);
    setError("");
    try {
      // Finalizar = a ML treina com esta planilha e mede quanto acertou nela.
      const r = await api<{ ready: boolean; learning?: SheetReport }>(`/analyses/${id}/finish`, { method: "POST" });
      onUpdate();
      if (r.learning) setLearned(r.learning);
      else navigate({ view: "analise", id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setFinishing(false);
    }
  }

  async function stepHistory(kind: "undo" | "redo") {
    const step = board?.[kind];
    if (!step || busy) return;
    if (await act(kind)) {
      setPinned(new Set());
      notify({
        text: `${kind === "undo" ? "Desfeito" : "Refeito"}: ${ACTION_LABEL[step.action] || step.action}${step.card ? ` · ${step.card}` : ""}`,
        undo: kind === "redo",
        redo: kind === "undo",
      });
    }
  }
  async function confirmMerge() {
    if (!mergeAsk) return;
    const { src, dst } = mergeAsk;
    if (await act("merge_cards", { card_id: src.id, target_id: dst.id })) {
      setMergeAsk(null);
      pin([dst.id]);
      if (groupBy === "falha") setOpenGroups((prev) => new Set(prev).add(`${dst.class}|${dst.column_id}`));
      focusColumn(groupBy === "falha" ? dst.class : dst.column_id, dst.id);
      notify({ text: `Agrupado em “${dst.name}”`, undo: true });
    }
  }

  const byColumn = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const c of board?.cards || []) {
      if (c.held) continue;
      const key = groupBy === "falha" ? c.class : c.column_id;
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    return map;
  }, [board, groupBy]);
  const machines = useMemo(() => new Map((board?.columns || []).map((c) => [c.id, c])), [board]);
  const machineOf = useCallback(
    (card: Card) => {
      const m = machines.get(card.column_id);
      return m ? `${m.name} · ${m.line}` : "";
    },
    [machines],
  );
  /** Ordem completa (sem filtro) das caixas de cada coluna, já com a ordem manual salva. */
  const boxOrder = useMemo(() => {
    const out = new Map<string, string[]>();
    const saved = board?.layout || {};
    for (const [col, cards] of byColumn) {
      const key = `${groupBy}:${col}`;
      const keys =
        groupBy === "falha"
          ? arrange(bucketsOf(cards, machines), (g) => g.key, saved[key]).map((g) => g.key)
          : arrange(cards, (c) => c.id, saved[key]).map((c) => c.id);
      out.set(col, keys);
    }
    return out;
  }, [board, byColumn, groupBy, machines]);
  const viewColumns = useMemo<ViewColumn[]>(() => {
    if (!board) return [];
    if (groupBy === "maquina")
      return board.columns.map((c) => ({ ...c, kind: "maquina" as const, context: `${c.unit} / ${c.line}` }));
    // Ordem estável: "sem modo" primeiro, depois pelo tempo da classe AUTOMÁTICA (não muda quando o
    // analista reclassifica um card, então o quadro não pula); classes criadas à mão vão para o fim.
    const minutes = new Map<string, number>();
    for (const [k, list] of byColumn) minutes.set(k, list.reduce((n, c) => n + c.minutes, 0));
    const autoMinutes = new Map<string, number>();
    for (const c of board.cards) autoMinutes.set(c.auto_class, (autoMinutes.get(c.auto_class) || 0) + c.minutes);
    const rank = (k: string) => (k === SEM_MODO ? Infinity : autoMinutes.get(k) ?? -1);
    const order = [...new Set([...byColumn.keys(), ...extraClasses])].sort(
      (a, b) => rank(b) - rank(a) || extraClasses.indexOf(a) - extraClasses.indexOf(b) || a.localeCompare(b),
    );
    return order.map((k) => {
      const list = byColumn.get(k) || [];
      const nMachines = new Set(list.map((c) => c.column_id)).size;
      return {
        id: k,
        name: prettyClass(k),
        unit: "",
        line: "",
        kind: "falha" as const,
        local: !list.length,
        validated: list.length > 0 && list.every((c) => c.validated),
        context: list.length ? `${fmt(nMachines)} máquina(s) · ${fmt(minutes.get(k) || 0)} min` : "Classe nova · solte itens aqui",
      };
    });
  }, [board, groupBy, byColumn, extraClasses]);

  /** Solta o item: na mesma coluna só muda a ordem; em outra coluna muda a falha (ou a máquina) e já posiciona. */
  async function dropAt(payload: DragPayload, target: NonNullable<Over>) {
    if (target.merge) {
      // Agrupar pede confirmação antes (e dá para desfazer depois com Ctrl+Z).
      const src = board?.cards.find((c) => c.id === payload.ids[0]);
      const dst = board?.cards.find((c) => c.id === target.merge);
      if (src && dst) setMergeAsk({ src, dst });
      return;
    }
    const col = target.col;
    const full = boxOrder.get(col) || [];
    const list = full.filter((k) => k !== payload.box);
    let at = target.before ? list.indexOf(target.before) : -1;
    if (at < 0) {
      const last = target.last ? list.indexOf(target.last) : -1;
      at = last >= 0 ? last + 1 : list.length;
    }
    list.splice(at, 0, payload.box);
    const layout = { key: `${groupBy}:${col}`, ids: list };
    if (col === payload.from) {
      if (!sameList(list, full)) await act("reorder", { layout });
      return;
    }
    let ok = false;
    if (groupBy === "maquina") ok = await act("move", { card_id: payload.ids[0], column_id: col, layout });
    else if (payload.ids.length === 1) {
      const card = board?.cards.find((c) => c.id === payload.ids[0]);
      ok = await act("set_class", { card_id: payload.ids[0], failure_class: card && card.auto_class === col ? "" : col, layout });
    } else {
      const ids = new Set(payload.ids);
      const items = (board?.cards || []).filter((c) => ids.has(c.id) && c.class !== col).map((c) => ({ card_id: c.id, failure_class: col }));
      ok = items.length ? await act("set_classes", { items, layout }) : false;
    }
    if (ok) {
      pin(payload.ids);
      // O item não some: o bloco de destino abre e pisca onde ele caiu.
      if (groupBy === "falha" && payload.ids.length === 1)
        setOpenGroups((prev) => new Set(prev).add(`${col}|${payload.box}`));
      setExtraClasses((list) => list.filter((c) => c !== col));
      focusColumn(col, payload.ids[0]);
    }
  }

  // Referência estável para os handlers: cards memorizados não redesenham à toa.
  const live = useRef({ act, showDetails, dropAt, groupBy, busy, stepHistory });
  useLayoutEffect(() => {
    live.current = { act, showDetails, dropAt, groupBy, busy, stepHistory };
  });
  // Ctrl+Z desfaz; Ctrl+Y (ou Ctrl+Shift+Z) refaz. Não atrapalha quem está digitando num campo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.closest("[role=dialog]"))) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void live.current.stepHistory("undo");
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        void live.current.stepHistory("redo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const h = useMemo<Handlers>(
    () => ({
      act: (action, fields) => live.current.act(action, fields),
      details: (card) => void live.current.showDetails(card),
      pickClass: (card, anchor) => setPicker({ card, rect: anchor.getBoundingClientRect() }),
      grab: (e, payload) => {
        if (e.button !== 0 || live.current.busy) return;
        if ((e.target as HTMLElement).closest("[data-nodrag], input, select, textarea")) return;
        const start = { x: e.clientX, y: e.clientY };
        const pos = { x: e.clientX, y: e.clientY };
        let active = false;
        let frame = 0;
        let target: Over = null;
        const find = () => {
          const el = document.elementFromPoint(pos.x, pos.y) as HTMLElement | null;
          const colEl = el?.closest<HTMLElement>("[data-column]");
          if (!colEl) return null;
          const col = colEl.dataset.column || "";
          // Em cima de outro card (faixa do meio) = agrupar. Só um relato por vez e só na mesma máquina.
          const cardEl = el?.closest<HTMLElement>(".kb-card[data-card], .kb-item[data-card]");
          if (cardEl && payload.ids.length === 1 && cardEl.dataset.card !== payload.ids[0] && cardEl.dataset.machine === payload.machine) {
            const r = cardEl.getBoundingClientRect();
            if (pos.y > r.top + r.height * 0.25 && pos.y < r.bottom - r.height * 0.25)
              return { col, before: null, last: null, merge: cardEl.dataset.card };
          }
          const boxes = [...colEl.querySelectorAll<HTMLElement>(".kb-col-body > [data-box]")].filter(
            (b) => !(col === payload.from && b.dataset.box === payload.box),
          );
          const next = boxes.find((b) => {
            const r = b.getBoundingClientRect();
            return pos.y < r.top + r.height / 2;
          });
          return { col, before: next?.dataset.box ?? null, last: boxes.at(-1)?.dataset.box ?? null };
        };
        const tick = () => {
          frame = 0;
          if (!active) return;
          const ghost = ghostRef.current;
          if (ghost) ghost.style.transform = `translate(${pos.x + 14}px, ${pos.y + 10}px)`;
          // Rolagem automática perto das bordas do quadro e da coluna.
          const boardEl = boardRef.current;
          if (boardEl) {
            const r = boardEl.getBoundingClientRect();
            if (pos.x < r.left + 70) boardEl.scrollLeft -= Math.ceil((r.left + 70 - pos.x) / 4);
            else if (pos.x > r.right - 70) boardEl.scrollLeft += Math.ceil((pos.x - r.right + 70) / 4);
          }
          const body = (document.elementFromPoint(pos.x, pos.y) as HTMLElement | null)
            ?.closest("[data-column]")
            ?.querySelector<HTMLElement>(".kb-col-body");
          if (body) {
            const r = body.getBoundingClientRect();
            if (pos.y < r.top + 50) body.scrollTop -= Math.ceil((r.top + 50 - pos.y) / 3);
            else if (pos.y > r.bottom - 50) body.scrollTop += Math.ceil((pos.y - r.bottom + 50) / 3);
          }
          const t = find();
          if (t?.col !== target?.col || t?.before !== target?.before || t?.merge !== target?.merge) setOver(t);
          target = t;
          frame = requestAnimationFrame(tick);
        };
        const move = (ev: PointerEvent) => {
          pos.x = ev.clientX;
          pos.y = ev.clientY;
          if (!active) {
            if (Math.hypot(pos.x - start.x, pos.y - start.y) < 6) return;
            active = true;
            document.body.classList.add("kb-grabbing");
            window.getSelection()?.removeAllRanges();
            setDragging(payload);
          }
          if (!frame) frame = requestAnimationFrame(tick);
        };
        const stop = (drop: boolean) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          window.removeEventListener("keydown", key);
          if (frame) cancelAnimationFrame(frame);
          document.body.classList.remove("kb-grabbing");
          if (!active) return;
          // Depois de arrastar, o "clique" que o navegador dispara ao soltar não abre o card.
          const swallow = (ev: MouseEvent) => {
            ev.stopPropagation();
            ev.preventDefault();
          };
          window.addEventListener("click", swallow, { capture: true, once: true });
          setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
          const final = drop ? find() : null;
          setDragging(null);
          setOver(null);
          if (final) void live.current.dropAt(payload, final);
        };
        const up = () => stop(true);
        const cancel = () => stop(false);
        const key = (ev: KeyboardEvent) => {
          if (ev.key === "Escape") stop(false);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", key);
      },
      validateColumn: (columnId, cardIds, filtered) => {
        if (!cardIds.length) return;
        if (live.current.groupBy === "falha" || filtered) void live.current.act("validate_cards", { card_ids: cardIds });
        else void live.current.act("validate_column", { column_id: columnId });
      },
      deleteColumn: (columnId) => {
        if (live.current.groupBy === "falha") setExtraClasses((list) => list.filter((c) => c !== columnId));
        else void live.current.act("delete_column", { column_id: columnId });
      },
      validateCards: (cardIds) => {
        if (cardIds.length) void live.current.act("validate_cards", { card_ids: cardIds });
      },
      toggleGroup: (key) =>
        setOpenGroups((prev) => {
          const next = new Set(prev);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
    }),
    [],
  );
  const openKeyList = useMemo(() => [...openGroups], [openGroups]);
  const changeQueue = (q: Queue) => {
    setQueue(q);
    setPinned(new Set());
  };
  const changeSearch = (v: string) => {
    setSearch(v);
    setPinned(new Set());
  };
  const segments = useMemo(
    () =>
      viewColumns.map((c) => {
        const list = byColumn.get(c.id) || [];
        return {
          id: c.id,
          label: `${c.name} · ${list.length} item(ns)${c.validated ? " · validada" : ""}`,
          state: c.validated ? "ok" : list.length ? "" : "empty",
        };
      }),
    [viewColumns, byColumn],
  );
  async function train() {
    setTraining(true);
    try {
      await api("/learning/train", { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTraining(false);
    }
  }
  if (!board)
    return (
      <>
        <ErrorNotice message={error} retry={() => void load()} />
        {!error && <Loading />}
      </>
    );
  const held = board.cards.filter((c) => c.held),
    pending = board.cards.filter((c) => !c.validated || c.held).length;
  const columns = viewColumns;
  const visibleCards = board.cards.filter((c) => !c.held);
  const failureKinds = new Set(visibleCards.map((c) => c.class)).size;
  const progress = board.groups_count ? (board.validated_count / board.groups_count) * 100 : 0;
  const term = deferredSearch.toLocaleLowerCase();
  const filtering = Boolean(term || queue);
  return (
    <div className={`kb ${dragging ? "kb-is-dragging" : ""}`}>
      <header className="kb-head">
        <button className="kb-back" aria-label="Voltar ao início" title="Voltar ao início" onClick={() => navigate({ view: "inicio" })}>
          <Icon name="back" size={17} />
        </button>
        <div className="kb-head-text">
          <h1 title={board.name}>{board.name}</h1>
          <p>
            {fmt(board.records_count)} apontamentos · {fmt(failureKinds)} tipos de falha · {fmt(board.columns.length)} máquinas
          </p>
        </div>
        <div className="kb-head-actions">
          <div className="notifications" ref={bellRef}>
            <button
              className={`kb-round ${bell ? "active" : ""}`}
              aria-label={`Itens em revisão: ${held.length}`}
              aria-expanded={bell}
              title="Sino de revisão"
              onClick={() => setBell(!bell)}
            >
              <Icon name="bell" size={18} />
              {held.length > 0 && <span className="notification-badge">{held.length}</span>}
            </button>
            {bell && (
              <div className="notification-menu">
                <header>
                  <h3>Itens em revisão</h3>
                  <span>{held.length}</span>
                </header>
                <p>Escolha a coluna correta para cada card.</p>
                <div className="notification-items">
                  {held.length ? (
                    held.map((c) => (
                      <article key={c.id}>
                        <b>{c.name}</b>
                        <small>
                          {fmt(c.count)} apontamentos · {fmt(c.minutes, 1)} min
                        </small>
                        <button className="text-btn" onClick={() => setMoving(moving === c.id ? null : c.id)}>
                          Mover <Icon name="arrow" size={14} />
                        </button>
                        {moving === c.id && (
                          <Move
                            columns={board.columns}
                            busy={busy}
                            onMove={async (column_id) => {
                              if (await act("move", { card_id: c.id, column_id })) setMoving(null);
                            }}
                          />
                        )}
                      </article>
                    ))
                  ) : (
                    <div className="notification-empty">
                      <Icon name="check" />
                      <b>Tudo resolvido por aqui</b>
                      <span>Use o sino de um card para revisá-lo depois.</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <MoreMenu>
            <button type="button" role="menuitem" data-close onClick={() => setCatalogOpen(true)}>
              <Icon name="target" size={15} />
              Catálogo de falhas
            </button>
            <button type="button" role="menuitem" data-close onClick={() => setHistory(true)}>
              <Icon name="clock" size={15} />
              Histórico de alterações
            </button>
            <a role="menuitem" data-close href={apiUrl(`/api/workspace/analyses/${id}/source`)}>
              <Icon name="download" size={15} />
              Baixar planilha original
            </a>
            {board.warnings.length > 0 && (
              <div className="more-notes">
                <b>
                  <Icon name="info" size={14} />
                  Observações da importação
                </b>
                {board.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </div>
            )}
          </MoreMenu>
        </div>
      </header>
      <ErrorNotice message={error} retry={() => void load()} />
      <MlPanel board={board} queue={queue} onQueue={changeQueue} onTrain={() => void train()} training={training} />
      <div className="kb-toolbar">
        <div className="kb-undo" role="group" aria-label="Desfazer e refazer">
          <button
            type="button"
            className="kb-icon"
            disabled={busy || !board.undo}
            onClick={() => void stepHistory("undo")}
            title={board.undo ? `Desfazer: ${ACTION_LABEL[board.undo.action] || board.undo.action}${board.undo.card ? ` · ${board.undo.card}` : ""} (Ctrl+Z)` : "Nada para desfazer"}
            aria-label="Desfazer (Ctrl+Z)"
          >
            <Icon name="undo" size={16} />
          </button>
          <button
            type="button"
            className="kb-icon"
            disabled={busy || !board.redo}
            onClick={() => void stepHistory("redo")}
            title={board.redo ? `Refazer: ${ACTION_LABEL[board.redo.action] || board.redo.action}${board.redo.card ? ` · ${board.redo.card}` : ""} (Ctrl+Y)` : "Nada para refazer"}
            aria-label="Refazer (Ctrl+Y)"
          >
            <Icon name="redo" size={16} />
          </button>
        </div>
        <div className="kb-seg" role="radiogroup" aria-label="Agrupar colunas por">
          {(
            [
              ["falha", "Por falha"],
              ["maquina", "Por máquina"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={groupBy === k}
              className={groupBy === k ? "on" : ""}
              onClick={() => {
                setGroupBy(k);
                setMoving(null);
                boardRef.current?.scrollTo({ left: 0 });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="kb-search">
          <Icon name="search" size={15} />
          <input aria-label="Buscar no quadro" placeholder="Buscar máquina ou relato…" value={search} onChange={(e) => changeSearch(e.target.value)} />
          {search && (
            <button type="button" aria-label="Limpar busca" onClick={() => changeSearch("")}>
              <Icon name="close" size={13} />
            </button>
          )}
        </label>
        {queue && (
          <button type="button" className="kb-chip" onClick={() => changeQueue("")}>
            <i className={`tone-${TONE[queue]}`} />
            {LIGHTS.find((l) => l.key === queue)?.label}
            <Icon name="close" size={12} />
          </button>
        )}
        <span className="kb-hint">
          <Icon name="grip" size={13} />
          Arraste para mover · solte sobre um card para agrupar
        </span>
        <button
          className="kb-btn"
          disabled={busy || !board.automation.pending_high}
          onClick={() => {
            setError("");
            setBatchOpen(true);
          }}
          title="Valida de uma vez os itens verdes, depois de conferir uma amostra"
        >
          <i className="tone-ok" />
          Validar confiáveis ({fmt(board.automation.pending_high)})
        </button>
      </div>
      <BoardRail boardRef={boardRef} segments={segments} />
      <div className="kb-board" id="kanban-board" aria-label="Quadro de validação" ref={boardRef}>
        {columns.map((col) => {
          const all = byColumn.get(col.id) || [];
          const visible = !filtering
            ? all
            : all.filter(
                (c) =>
                  pinned.has(c.id) ||
                  (!queue || c.confidence === queue) &&
                  (!term || `${c.name} ${c.sample} ${c.class} ${col.name} ${col.context} ${machineOf(c)}`.toLocaleLowerCase().includes(term)),
              );
          if (filtering && !visible.length && !(dragging && over?.col === col.id)) return null;
          const fromHere = dragging?.from === col.id;
          return (
            <KanbanColumn
              key={col.id}
              col={col}
              cards={visible}
              allCount={all.length}
              validatedCount={all.filter((c) => c.validated).length}
              order={boxOrder.get(col.id) || []}
              busy={busy}
              dragBox={fromHere ? dragging.box : ""}
              drop={over?.col === col.id && !over.merge ? over.before : undefined}
              mergeId={over?.col === col.id && over.merge ? over.merge : ""}
              flashId={flash && all.some((c) => c.id === flash) ? flash : ""}
              machines={machines}
              openKeys={openKeyList.filter((k) => k.startsWith(`${col.id}|`)).join("\n")}
              h={h}
            />
          );
        })}
        <button
          className="kb-add"
          onClick={() => {
            if (groupBy === "falha") {
              setNewFailure("");
              return;
            }
            setNewCol({ name: "", unit: board.columns[0]?.unit || "", line: board.columns[0]?.line || "" });
            setAdding(true);
          }}
        >
          <Icon name="plus" size={18} />
          <span>{groupBy === "falha" ? "Nova falha" : "Nova coluna"}</span>
        </button>
      </div>
      {dragging && over?.merge && <div className="kb-merge-hint">Soltar para agrupar</div>}
      {toast && (
        <div className="kb-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && board.undo && (
            <button type="button" onClick={() => void stepHistory("undo")}>
              <Icon name="undo" size={14} />
              Desfazer
            </button>
          )}
          {toast.redo && board.redo && (
            <button type="button" onClick={() => void stepHistory("redo")}>
              <Icon name="redo" size={14} />
              Refazer
            </button>
          )}
          <button type="button" className="kb-toast-x" aria-label="Fechar aviso" onClick={() => setToast(null)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
      {mergeAsk && (
        <Modal title="Agrupar estes relatos?" onClose={() => setMergeAsk(null)}>
          <div className="kb-merge">
            <div className="kb-merge-pair">
              <div>
                <small>Relato arrastado</small>
                <b>{mergeAsk.src.name}</b>
                <span>
                  {fmt(mergeAsk.src.count)} apontamento(s) · {prettyClass(mergeAsk.src.class)}
                </span>
              </div>
              <Icon name="arrow" size={18} />
              <div>
                <small>Entra em</small>
                <b>{mergeAsk.dst.name}</b>
                <span>
                  {fmt(mergeAsk.dst.count)} apontamento(s) · {prettyClass(mergeAsk.dst.class)}
                </span>
              </div>
            </div>
            <p className="helper">
              Os apontamentos passam a contar juntos em “{mergeAsk.dst.name}” ({fmt(mergeAsk.src.count + mergeAsk.dst.count)} no total), classificados como{" "}
              {`“${prettyClass(mergeAsk.dst.class)}”`}. O card precisa ser validado de novo. Mudou de ideia? Ctrl+Z desfaz.
            </p>
            <ErrorNotice message={error} />
            <div className="kb-merge-actions">
              <button className="btn secondary" onClick={() => setMergeAsk(null)}>
                Cancelar
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void confirmMerge()}>
                <Icon name="check" size={16} />
                Agrupar
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dragging && (
        <div className={`kb-ghost tone-${dragging.tone}`} ref={ghostRef} aria-hidden="true">
          <i />
          <span>{dragging.label}</span>
          {dragging.ids.length > 1 && <b>{dragging.ids.length}</b>}
        </div>
      )}
      {picker && (
        <ClassPicker
          card={board.cards.find((c) => c.id === picker.card.id) || picker.card}
          anchor={picker.rect}
          classes={board.classes}
          onClose={() => setPicker(null)}
          onPick={(value) => {
            const cardId = picker.card.id;
            setPicker(null);
            pin([cardId]);
            void act("set_class", { card_id: cardId, failure_class: value });
          }}
          onNew={() => {
            setNewClass({ card: picker.card.id, value: "" });
            setPicker(null);
          }}
        />
      )}
      <div className="kb-footer">
        <span className={`kb-ring ${board.ready ? "done" : ""}`} style={{ "--p": `${progress}%` } as React.CSSProperties}>
          {board.ready ? <Icon name="check" size={15} /> : <b>{Math.round(progress)}%</b>}
        </span>
        <div className="kb-footer-text">
          <b>{board.ready ? "Tudo validado" : `${fmt(board.validated_count)} de ${fmt(board.groups_count)} validados`}</b>
          <small>
            {held.length
              ? `${held.length} item(ns) no sino de revisão`
              : pending
                ? "Valide o que falta para liberar os gráficos."
                : "Alterações salvas."}
          </small>
        </div>
        {!board.ready && (
          <button
            className="kb-btn ghost"
            disabled={busy || pending === 0}
            onClick={() => {
              setChecked(false);
              setTyped("");
              setConfirmAll(true);
            }}
          >
            <Icon name="checks" size={15} />
            Confirmar todos
          </button>
        )}
        <button
          className="kb-btn primary"
          disabled={!board.ready || busy}
          onClick={() => void finish()}
          title={!board.ready ? "Valide todos os cards e esvazie o sino" : "Abrir dashboard"}
        >
          {finishing ? "Aprendendo…" : board.finished_at ? "Ver análises" : "Finalizar e ver análises"} <Icon name="arrow" size={16} />
        </button>
      </div>
      {learned && (
        <Modal title="A ML aprendeu com esta planilha" onClose={() => navigate({ view: "analise", id })}>
          <div className="kb-learned">
            <div className="kb-learned-hero">
              <strong className={learned.hit_rate >= 85 ? "tone-ok" : learned.hit_rate >= 70 ? "tone-warn" : "tone-bad"}>
                {fmt(learned.hit_rate, 1)}%
              </strong>
              <span>
                de acerto da ML nesta planilha
                {learned.previous_hit_rate != null && (
                  <b className={learned.hit_rate >= learned.previous_hit_rate ? "up" : "down"}>
                    {learned.hit_rate >= learned.previous_hit_rate ? " ▲ " : " ▼ "}
                    {fmt(Math.abs(learned.hit_rate - learned.previous_hit_rate), 1)} pts vs. a anterior ({fmt(learned.previous_hit_rate, 1)}%)
                  </b>
                )}
              </span>
              {learned.estimated && <small>Estimado: esta planilha foi importada antes da medição por chegada.</small>}
            </div>
            <div className="kb-learned-grid">
              <div>
                <b>{fmt(learned.corrections)}</b>
                <span>correções suas viraram memória</span>
              </div>
              <div>
                <b>
                  {fmt(learned.examples_before || 0)} → {fmt(learned.examples_after || 0)}
                </b>
                <span>exemplos no modelo</span>
              </div>
              <div>
                <b>
                  {learned.model_after != null
                    ? `${learned.model_before != null ? `${fmt(learned.model_before, 1)}% → ` : ""}${fmt(learned.model_after, 1)}%`
                    : "Calibrando"}
                </b>
                <span>{learned.model_after != null ? "acerto do modelo (teste cego)" : "o modelo mede o acerto a partir de 60 exemplos"}</span>
              </div>
            </div>
            <p className="helper">
              {learned.from_past > 0 ? `${fmt(learned.from_past, 0)}% desta planilha já chegou classificada pelo que a ML aprendeu antes. ` : ""}
              Na próxima planilha, os relatos que você corrigiu chegam classificados e o modelo usa estes exemplos para reconhecer
              relatos parecidos.
            </p>
            <button className="btn primary" onClick={() => navigate({ view: "analise", id })}>
              Ver análises <Icon name="arrow" size={16} />
            </button>
          </div>
        </Modal>
      )}
      {batchOpen && (
        <SafeBatchModal
          board={board}
          busy={busy}
          error={error}
          onClose={() => setBatchOpen(false)}
          onConfirm={async (ids) => {
            if (await act("validate_confident", { confirm: true, card_ids: ids })) setBatchOpen(false);
          }}
        />
      )}
      {newFailure !== null && (
        <Modal title="Nova coluna de falha" onClose={() => setNewFailure(null)}>
          <form
            className="stack-form"
            onSubmit={(e) => {
              e.preventDefault();
              const label = newFailure.replace(/\s+/g, " ").trim().toUpperCase();
              if (!label) return;
              if (!byColumn.has(label)) setExtraClasses((list) => (list.includes(label) ? list : [...list, label]));
              setNewFailure(null);
              focusColumn(label);
            }}
          >
            <p className="helper">
              Crie a coluna e arraste os cards para ela: a classe de cada card muda na hora e vai para a memória e o
              aprendizado. Use o padrão “Falha de &lt;componente&gt;”.
            </p>
            <label>
              Classe de falha
              <input autoFocus required maxLength={120} value={newFailure} placeholder="FALHA DE …" onChange={(e) => setNewFailure(e.target.value)} />
            </label>
            <button className="btn primary" disabled={!newFailure.trim()}>
              <Icon name="plus" size={16} />
              Criar coluna
            </button>
          </form>
        </Modal>
      )}
      {catalogOpen && <CatalogEditor onClose={() => setCatalogOpen(false)} onSaved={() => void load()} />}
      {newClass && (
        <Modal title="Nova classe de falha" onClose={() => setNewClass(null)}>
          <form
            className="stack-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act("set_class", { card_id: newClass.card, failure_class: newClass.value })) setNewClass(null);
            }}
          >
            <p className="helper">
              Use o padrão do descritivo: o componente ou processo que falhou, sem o restante do relato. Ex.: “Falha de
              sensor”, “Falha de rolamento” (quebrado, estourado ou danificado é a mesma falha). A escolha fica na
              memória: o mesmo relato chega classificado nos próximos dias.
            </p>
            <label>
              Classe de falha
              <input
                autoFocus
                required
                maxLength={120}
                value={newClass.value}
                placeholder="FALHA DE …"
                onChange={(e) => setNewClass({ ...newClass, value: e.target.value })}
              />
            </label>
            <button className="btn primary" disabled={busy || !newClass.value.trim()}>
              <Icon name="check" size={16} />
              Aplicar ao card
            </button>
          </form>
        </Modal>
      )}
      {confirmAll && (
        <Modal title="Confirmar todos os agrupamentos" onClose={() => setConfirmAll(false)}>
          <form
            className="stack-form confirm-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act("validate_all", { confirm: typed })) setConfirmAll(false);
            }}
          >
            <div className="confirm-summary">
              <div>
                <strong>{fmt(board.cards.filter((c) => !c.validated && !c.held).length)}</strong>
                <span>cards ainda não validados</span>
              </div>
              <div>
                <strong>{fmt(board.columns.filter((c) => !c.validated).length)}</strong>
                <span>colunas pendentes</span>
              </div>
              <div>
                <strong>{fmt(board.records_count)}</strong>
                <span>apontamentos no total</span>
              </div>
            </div>
            {held.length > 0 ? (
              <div className="error-notice">
                <Icon name="bell" />
                Há {held.length} item(ns) no sino de revisão. Escolha a coluna de cada um antes de confirmar tudo.
              </div>
            ) : (
              <>
                {board.unclassified_count > 0 && (
                  <div className="info-notice">
                    <Icon name="info" />
                    {board.unclassified_count} card(s) estão como “Sem modo de falha identificado”. Eles entram assim na
                    tabela de falhas; se quiser, classifique-os antes no seletor de cada card.
                  </div>
                )}
                <ul className="confirm-list">
                  {board.columns
                    .filter((c) => !c.validated)
                    .map((c) => (
                      <li key={c.id}>
                        <b>{c.name}</b>
                        <span>
                          {c.unit} / {c.line}
                        </span>
                        <em>{board.cards.filter((x) => x.column_id === c.id && !x.validated && !x.held).length} card(s)</em>
                      </li>
                    ))}
                </ul>
                <label className="check-label confirm-check">
                  <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                  Conferi os agrupamentos e as colunas acima e assumo a validação de todos os cards.
                </label>
                <label>
                  <span>
                    Para confirmar, digite <b>CONFIRMAR</b>
                  </span>
                  <input
                    value={typed}
                    autoComplete="off"
                    placeholder="CONFIRMAR"
                    onChange={(e) => setTyped(e.target.value)}
                    aria-label="Digite CONFIRMAR"
                  />
                </label>
                <ErrorNotice message={error} />
                <button
                  className="btn primary"
                  disabled={busy || !checked || typed.trim().toUpperCase() !== "CONFIRMAR"}
                >
                  <Icon name="checks" size={17} />
                  Validar todos os cards
                </button>
                <p className="helper">
                  A ação fica registrada no histórico de alterações. Você ainda pode desfazer a validação de qualquer card depois.
                </p>
              </>
            )}
          </form>
        </Modal>
      )}
      {adding && (
        <Modal title="Criar coluna" onClose={() => setAdding(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act("add_column", newCol)) setAdding(false);
            }}
            className="stack-form"
          >
            <p className="helper">
              A coluna define a peça, unidade e linha dos cards que receber.
            </p>
            {(
              [
                ["name", "Peça / equipamento"],
                ["unit", "Unidade"],
                ["line", "Linha"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  required
                  maxLength={200}
                  autoFocus={key === "name"}
                  value={newCol[key]}
                  onChange={(e) =>
                    setNewCol({ ...newCol, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <ErrorNotice message={error} />
            <button className="btn primary" disabled={busy}>
              Criar coluna <Icon name="plus" size={17} />
            </button>
          </form>
        </Modal>
      )}
      {details && (
        <Modal
          title="Conferir agrupamento"
          wide
          onClose={() => setDetails(null)}
        >
          <div className="detail-summary">
            <div>
              <span className="eyebrow">
                {fmt(details.count)} REGISTROS ORIGINAIS
              </span>
              <h3>{details.name}</h3>
              <p>{details.dates.map(dateLabel).join(" · ")}</p>
            </div>
            {details.count > 1 && (
              <button
                className="btn secondary small"
                disabled={busy}
                onClick={async () => {
                  if (await act("split_card", { card_id: details.id }))
                    setDetails(null);
                }}
              >
                Desagrupar registros
              </button>
            )}
          </div>
          <div className={`class-explain conf-${details.confidence}`}>
            <div>
              <span className="eyebrow">CLASSE DE FALHA</span>
              <b>{prettyClass(details.class)}</b>
              <ConfidenceBadge card={details} />
            </div>
            <p>
              {details.reason}
              {details.detail ? ` Manifestação citada: ${details.detail}.` : ""}
            </p>
            <small>
              {fmt(details.count)} linha(s) do SAP = {fmt(details.events)} falha(s) real(is)
              {details.orders.length ? ` · O.S. ${details.orders.slice(0, 6).join(", ")}${details.orders.length > 6 ? "…" : ""}` : ""}
            </small>
          </div>
          <form
            className="rename-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await act("rename_card", { card_id: details.id, name: rename })
              )
                setDetails(null);
            }}
          >
            <label>
              Descrição consolidada
              <input
                value={rename}
                maxLength={500}
                onChange={(e) => setRename(e.target.value)}
                required
              />
            </label>
            <button
              className="btn secondary"
              disabled={busy || rename === details.name}
            >
              Salvar descrição
            </button>
          </form>
          <ErrorNotice message={detailError || error} />
          {!detailData && !detailError ? (
            <Loading />
          ) : (
            <div className="source-records">
              {detailData?.records.map((r) => (
                <article key={r.id}>
                  <header>
                    <b>
                      {dateLabel(r.data_inicio)} · {r.equipamento}
                    </b>
                    <span>{fmt(r.minutos_parada, 2)} min</span>
                  </header>
                  <p>{r.observacao_raw || "Sem descrição"}</p>
                  <small>
                    {r.centro} / {r.linha} · aba {r.source_sheet}, linha{" "}
                    {r.source_row}
                  </small>
                  <details>
                    <summary>Ver todas as células originais</summary>
                    <dl>
                      {Object.entries(r.original).map(([k, v]) => (
                        <div key={k}>
                          <dt>{k.replace(/^\d+ · /, "")}</dt>
                          <dd>{v || "—"}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </article>
              ))}
            </div>
          )}
          {detailData && detailData.records.length < detailData.total && (
            <button
              className="btn secondary"
              disabled={detailBusy}
              onClick={() => void moreDetails()}
            >
              Carregar mais registros ({detailData.records.length}/
              {detailData.total})
            </button>
          )}
        </Modal>
      )}
      {history && (
        <Modal
          title="Histórico de alterações"
          onClose={() => setHistory(false)}
        >
          <div className="audit-list">
            {board.events.length ? (
              [...board.events].reverse().map((e) => (
                <article key={e.revision}>
                  <b>
                    {ACTION_LABEL[e.action] || e.action}
                  </b>
                  <p>
                    {e.card || e.column}
                    {typeof e.value === "number" ? ` · ${fmt(e.value)} card(s)` : ""}
                    {e.action === "merge_cards" && e.value ? ` ← ${e.value}` : ""}
                    {(e.action === "undo" || e.action === "redo") && e.value ? ` (${ACTION_LABEL[String(e.value)] || e.value})` : ""}
                    {e.action === "set_class" && e.value ? ` → ${prettyClass(String(e.value))}` : ""}
                  </p>
                  <small>
                    {new Date(e.at).toLocaleString("pt-BR")} · revisão{" "}
                    {e.revision}
                  </small>
                </article>
              ))
            ) : (
              <p className="helper">Nenhuma alteração após a importação.</p>
            )}
          </div>
        </Modal>
      )}
    </div>

  );
}
