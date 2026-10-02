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
  type Detail,
} from "@/lib/radar";
import { Icon, Modal, Loading, ErrorNotice, Heading } from "./ui";
import CatalogEditor from "./catalog";
import { AutomationSummary, ConfidenceBadge, MoreMenu, ReviewBar, SafeBatchModal, type GroupBy, type Queue } from "./automation";

/** Coluna do quadro: uma máquina (visão por máquina) ou uma classe de falha (visão por falha). */
type ViewColumn = Column & { context: string; kind: GroupBy; local?: boolean };

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
      <select
        aria-label="Coluna de destino"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="">Escolher coluna…</option>
        {columns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} · {c.context ?? `${c.unit} / ${c.line}`}
            {c.validated ? " · validada" : ""}
          </option>
        ))}
      </select>
      <button
        className="btn small primary"
        disabled={!target || busy}
        onClick={() => onMove(target)}
      >
        Mover card <Icon name="arrow" size={14} />
      </button>
    </div>
  );
}

/* ===================== Otimização do quadro =====================
   O quadro pode ter centenas de cards. Para não travar:
   - cada coluna e cada card só redesenham quando os próprios dados mudam (memo);
   - a barra superior acompanha a rolagem sem redesenhar o quadro;
   - o seletor de classe é um único menu compartilhado (não um <select> por card);
   - o navegador pula o desenho do que está fora da tela (content-visibility). */
type Handlers = {
  act: (action: string, fields?: object) => Promise<boolean>;
  details: (card: Card) => void;
  toggleMove: (cardId: string) => void;
  moveTo: (cardId: string, columnId: string, follow: boolean) => void;
  pickClass: (card: Card, anchor: HTMLElement) => void;
  dragStart: (cardId: string) => void;
  dragEnd: () => void;
  dragOver: (columnId: string) => void;
  dragLeave: () => void;
  drop: (cardId: string, columnId: string) => void;
  validateColumn: (columnId: string, cardIds: string[]) => void;
  deleteColumn: (columnId: string) => void;
  validateCards: (cardIds: string[]) => void;
  toggleGroup: (key: string) => void;
};
const CARD_KEYS: (keyof Card)[] = ["id", "name", "validated", "held", "class", "failure_class", "count", "minutes", "column_id", "sample", "confidence", "reason", "events"];
const sameCard = (a: Card, b: Card) => a === b || CARD_KEYS.every((k) => a[k] === b[k]);

const KanbanCard = memo(
  function KanbanCard({
    card,
    index,
    total,
    prevId,
    nextId,
    busy,
    dragging,
    flash,
    moving,
    moveColumns,
    machine,
    h,
  }: {
    card: Card;
    machine: string;
    index: number;
    total: number;
    prevId?: string;
    nextId?: string;
    busy: boolean;
    dragging: boolean;
    flash: boolean;
    moving: boolean;
    moveColumns: ViewColumn[] | null;
    h: Handlers;
  }) {
    return (
      <article
        data-card={card.id}
        className={`kanban-card conf-${card.confidence} ${card.validated ? "card-validated" : ""} ${dragging ? "dragging" : ""} ${flash ? "flash" : ""}`}
        draggable={!busy}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", card.id);
          e.dataTransfer.effectAllowed = "move";
          h.dragStart(card.id);
        }}
        onDragEnd={h.dragEnd}
      >
        <div className="card-top">
          {machine ? (
            <span className="machine-chip" title={`Máquina: ${machine}`}>
              <Icon name="machine" size={12} />
              <span>{machine}</span>
            </span>
          ) : (
          <button
            type="button"
            className={`class-chip ${card.class === SEM_MODO ? "warn" : card.class === SEM_DESCRICAO ? "muted" : ""} ${card.failure_class ? "manual" : ""}`}
            title={card.failure_class ? "Classe definida manualmente · clique para trocar" : "Classe automática (coluna M) · clique para trocar"}
            aria-label={`Classe de falha: ${prettyClass(card.class)}. Alterar`}
            disabled={busy}
            onClick={(e) => h.pickClass(card, e.currentTarget)}
          >
            <Icon name={card.failure_class ? "pencil" : "target"} size={12} />
            <span>{prettyClass(card.class)}</span>
          </button>
          )}
          <ConfidenceBadge card={card} />
          <button
            className="inspect-card icon-btn"
            aria-label={`Enviar ${card.name} ao sino de revisão`}
            title="Enviar para revisão no sino"
            disabled={busy}
            onClick={() => void h.act("hold", { card_id: card.id })}
          >
            <Icon name="search" size={16} />
          </button>
        </div>
        <button className="card-title" onClick={() => h.details(card)}>
          {card.name}
        </button>
        <p className="card-sample">{card.sample || "Sem observação na planilha."}</p>
        <div className="card-meta">
          <span title={`${fmt(card.count)} linha(s) do SAP formam ${fmt(card.events)} falha(s) real(is) (mesma O.S. = 1 falha)`}>
            <Icon name="file" size={13} />
            {card.events !== card.count
              ? `${fmt(card.events)} ${card.events === 1 ? "falha" : "falhas"} · ${fmt(card.count)} linhas`
              : `${fmt(card.count)} ${card.count === 1 ? "falha" : "falhas"}`}
          </span>
          <span>
            <Icon name="clock" size={13} />
            {fmt(card.minutes, 1)} min
          </span>
          <span className="meta-type">{card.types.join(" · ")}</span>
        </div>
        <footer>
          <div className="card-move">
            <button
              className="mini-arrow"
              aria-label={`Mover ${card.name} para a coluna anterior`}
              title={machine ? "Mudar para a falha da coluna anterior" : "Mover para a coluna anterior"}
              disabled={busy || index === 0 || !prevId}
              onClick={() => prevId && h.moveTo(card.id, prevId, true)}
            >
              <Icon name="left" size={14} />
            </button>
            <button className="text-btn small" onClick={() => h.toggleMove(card.id)}>
              Mover
              <Icon name="chevron" size={12} />
            </button>
            <button
              className="mini-arrow"
              aria-label={`Mover ${card.name} para a próxima coluna`}
              title={machine ? "Mudar para a falha da próxima coluna" : "Mover para a próxima coluna"}
              disabled={busy || index === total - 1 || !nextId}
              onClick={() => nextId && h.moveTo(card.id, nextId, true)}
            >
              <Icon name="right" size={14} />
            </button>
          </div>
          <button
            className={`validate-card ${card.validated ? "complete" : ""}`}
            title={card.validated ? "Desfazer validação" : "Validar card"}
            aria-label={`${card.validated ? "Desfazer validação" : "Validar"}: ${card.name}`}
            disabled={busy}
            onClick={() => void h.act("validate_card", { card_id: card.id })}
          >
            <Icon name="check" size={13} />
            {card.validated ? "Validado" : "Validar"}
          </button>
        </footer>
        {moving && moveColumns && (
          <Move columns={moveColumns} busy={busy} onMove={(column_id) => h.moveTo(card.id, column_id, true)} />
        )}
      </article>
    );
  },
  (a, b) =>
    sameCard(a.card, b.card) &&
    a.machine === b.machine &&
    a.index === b.index &&
    a.total === b.total &&
    a.prevId === b.prevId &&
    a.nextId === b.nextId &&
    a.busy === b.busy &&
    a.dragging === b.dragging &&
    a.flash === b.flash &&
    a.moving === b.moving &&
    (!a.moving || a.moveColumns === b.moveColumns),
);

/** Na visão por falha, os cards de uma mesma máquina ficam juntos em um único bloco. */
type MachineBucket = { key: string; name: string; line: string; cards: Card[]; minutes: number; events: number; pending: number };
const CONF_RANK: Record<string, number> = { baixa: 3, media: 2, manual: 1, alta: 0 };

const MachineGroup = memo(
  function MachineGroup({
    group,
    open,
    busy,
    dragging,
    flashId,
    onToggle,
    h,
  }: {
    group: MachineBucket;
    open: boolean;
    busy: boolean;
    dragging: boolean;
    flashId: string;
    onToggle: (key: string) => void;
    h: Handlers;
  }) {
    const done = group.pending === 0;
    // A borda mostra o relato pendente que mais precisa de atenção.
    const worst = group.cards
      .filter((c) => !c.validated)
      .reduce<string>((w, c) => (CONF_RANK[c.confidence] > (CONF_RANK[w] ?? -1) ? c.confidence : w), "");
    const ids = group.cards.map((c) => c.id);
    return (
      <article
        className={`machine-group ${done ? "done" : `attn-${worst}`} ${dragging ? "dragging" : ""} ${ids.includes(flashId) ? "flash" : ""}`}
        draggable={!busy}
        onDragStart={(e) => {
          const payload = `group:${ids.join(",")}`;
          e.dataTransfer.setData("text/plain", payload);
          e.dataTransfer.effectAllowed = "move";
          h.dragStart(payload);
        }}
        onDragEnd={h.dragEnd}
      >
        <div className="mg-head">
          <button type="button" className="mg-toggle" aria-expanded={open} onClick={() => onToggle(group.key)}>
            <span className={`mg-chevron ${open ? "open" : ""}`}>
              <Icon name="chevron" size={14} />
            </span>
            <span className="mg-text">
              <b title={group.name}>{group.name}</b>
              <small>
                {group.line} · {fmt(group.events)} {group.events === 1 ? "falha" : "falhas"} · {fmt(group.minutes, 0)} min
              </small>
            </span>
          </button>
          <button
            type="button"
            className={`mg-validate ${done ? "complete" : ""}`}
            disabled={busy || done}
            title={done ? "Todos os relatos desta máquina estão validados" : `Validar ${group.pending} relato(s) desta máquina`}
            aria-label={done ? `${group.name}: validado` : `Validar ${group.name}`}
            onClick={() => h.validateCards(group.cards.filter((c) => !c.validated && !c.held).map((c) => c.id))}
          >
            <Icon name="check" size={13} />
            {done ? "OK" : "Validar"}
          </button>
        </div>
        {open && (
          <ul className="mg-list">
            {group.cards.map((card) => (
              <li
                key={card.id}
                data-card={card.id}
                className={`mg-item conf-${card.confidence} ${card.validated ? "ok" : ""} ${flashId === card.id ? "flash" : ""}`}
                draggable={!busy}
                onDragStart={(e) => {
                  e.stopPropagation();
                  e.dataTransfer.setData("text/plain", card.id);
                  e.dataTransfer.effectAllowed = "move";
                  h.dragStart(card.id);
                }}
                onDragEnd={h.dragEnd}
              >
                <ConfidenceBadge card={card} compact />
                <button type="button" className="mg-item-title" title="Conferir os apontamentos originais" onClick={() => h.details(card)}>
                  {card.name}
                  <small>
                    {fmt(card.events)} {card.events === 1 ? "falha" : "falhas"} · {fmt(card.minutes, 0)} min
                  </small>
                </button>
                <span className="mg-item-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Trocar a falha deste relato"
                    aria-label={`Trocar a falha de ${card.name}`}
                    disabled={busy}
                    onClick={(e) => h.pickClass(card, e.currentTarget)}
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Enviar para revisão no sino"
                    aria-label={`Enviar ${card.name} ao sino de revisão`}
                    disabled={busy}
                    onClick={() => void h.act("hold", { card_id: card.id })}
                  >
                    <Icon name="bell" size={13} />
                  </button>
                  <button
                    type="button"
                    className={`mg-check ${card.validated ? "complete" : ""}`}
                    title={card.validated ? "Desfazer validação" : "Validar relato"}
                    aria-label={`${card.validated ? "Desfazer validação" : "Validar"}: ${card.name}`}
                    disabled={busy}
                    onClick={() => void h.act("validate_card", { card_id: card.id })}
                  >
                    <Icon name="check" size={13} />
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
    a.flashId === b.flashId &&
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
    index,
    total,
    prevId,
    nextId,
    cards,
    allCount,
    busy,
    canDrop,
    over,
    dragId,
    flashId,
    movingId,
    moveColumns,
    machineOf,
    machines,
    openKeys,
    h,
  }: {
    col: ViewColumn;
    machineOf: ((card: Card) => string) | null;
    machines: Map<string, Column>;
    openKeys: string;
    index: number;
    total: number;
    prevId?: string;
    nextId?: string;
    cards: Card[];
    allCount: number;
    busy: boolean;
    canDrop: boolean;
    over: boolean;
    dragId: string;
    flashId: string;
    movingId: string;
    moveColumns: ViewColumn[] | null;
    h: Handlers;
  }) {
    const byClass = col.kind === "falha";
    const buckets = useMemo(() => (byClass ? bucketsOf(cards, machines) : []), [byClass, cards, machines]);
    const open = useMemo(() => new Set(openKeys ? openKeys.split("\n") : []), [openKeys]);
    const toggle = useCallback((key: string) => h.toggleGroup(`${col.id}|${key}`), [h, col.id]);
    const minutes = byClass ? cards.reduce((n, c) => n + c.minutes, 0) : 0;
    return (
      <section
        data-column={col.id}
        className={`kanban-column ${byClass ? "by-class" : ""} ${col.validated ? "validated" : ""} ${over ? "drag-over" : ""}`}
        onDragOver={(e) => {
          if (canDrop && !busy) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            h.dragOver(col.id);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) h.dragLeave();
        }}
        onDrop={(e) => {
          e.preventDefault();
          h.drop(e.dataTransfer.getData("text/plain"), col.id);
        }}
      >
        <header className="column-head">
          <div>
            {byClass ? (
              <>
                <h2 title={col.name}>{col.name}</h2>
                <span className="column-context">
                  {allCount ? `${fmt(buckets.length)} equipamento(s) · ${fmt(minutes, 0)} min` : col.context}
                </span>
              </>
            ) : (
              <>
                <span className="column-context">{col.context}</span>
                <h2>
                  {col.name}
                  <span>{allCount}</span>
                </h2>
              </>
            )}
          </div>
          {!allCount && (!byClass || col.local) && (
            <button
              className="icon-btn delete-column"
              aria-label={`Excluir coluna ${col.name}`}
              disabled={busy}
              onClick={() => h.deleteColumn(col.id)}
            >
              <Icon name="trash" size={16} />
            </button>
          )}
        </header>
        <button
          className={`validate-column ${col.validated ? "complete" : ""}`}
          disabled={busy || col.validated || !allCount}
          onClick={() => h.validateColumn(col.id, cards.filter((c) => !c.validated).map((c) => c.id))}
        >
          <Icon name={col.validated ? "shield" : "check"} size={16} />
          {col.validated ? (byClass ? "Falha validada" : "Coluna validada") : byClass ? "Validar esta falha" : "Validar coluna inteira"}
        </button>
        <div className="column-cards">
          {byClass &&
            buckets.map((g) => (
              <MachineGroup
                key={g.key}
                group={g}
                open={open.has(`${col.id}|${g.key}`)}
                busy={busy}
                dragging={dragId === `group:${g.cards.map((c) => c.id).join(",")}`}
                flashId={flashId}
                onToggle={toggle}
                h={h}
              />
            ))}
          {!byClass && cards.map((card) => (
            <KanbanCard
              key={card.id}
              card={card}
              index={index}
              total={total}
              prevId={prevId}
              nextId={nextId}
              busy={busy}
              dragging={dragId === card.id}
              flash={flashId === card.id}
              moving={movingId === card.id}
              moveColumns={movingId === card.id ? moveColumns : null}
              machine={machineOf ? machineOf(card) : ""}
              h={h}
            />
          ))}
          {!cards.length && (
            <div className="column-empty">{allCount ? "Nenhum card corresponde à busca." : "Arraste um card para cá."}</div>
          )}
        </div>
      </section>
    );
  },
  (a, b) =>
    (a.col === b.col ||
      (a.col.id === b.col.id &&
        a.col.validated === b.col.validated &&
        a.col.name === b.col.name &&
        a.col.context === b.col.context)) &&
      a.machineOf === b.machineOf &&
      a.machines === b.machines &&
      a.openKeys === b.openKeys &&
      a.index === b.index &&
      a.total === b.total &&
      a.prevId === b.prevId &&
      a.nextId === b.nextId &&
      a.allCount === b.allCount &&
      a.busy === b.busy &&
      a.canDrop === b.canDrop &&
      a.over === b.over &&
      a.dragId === b.dragId &&
      a.flashId === b.flashId &&
      a.movingId === b.movingId &&
      a.moveColumns === b.moveColumns &&
      a.cards.length === b.cards.length &&
      a.cards.every((c, i) => sameCard(c, b.cards[i])),
);

/** Barra superior arrastável: acompanha a rolagem sem redesenhar o quadro. */
function BoardRail({
  boardRef,
  segments,
}: {
  boardRef: React.RefObject<HTMLDivElement | null>;
  segments: { id: string; label: string; state: string }[];
}) {
  const railRef = useRef<HTMLDivElement>(null);
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
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [boardRef, segments.length]);
  const step = (dir: number) => boardRef.current?.scrollBy({ left: dir * 316, behavior: "smooth" });
  const drag = (clientX: number) => {
    const rail = railRef.current,
      el = boardRef.current;
    if (!rail || !el) return;
    const r = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    el.scrollLeft = ratio * el.scrollWidth - el.clientWidth / 2;
  };
  return (
    <div className="board-nav">
      <button className="nav-arrow" aria-label="Rolar quadro para a esquerda" disabled={s.left <= 2} onClick={() => step(-1)}>
        <Icon name="left" size={18} />
      </button>
      <div
        className="board-rail"
        ref={railRef}
        role="scrollbar"
        aria-controls="kanban-board"
        aria-orientation="horizontal"
        aria-valuenow={Math.round((s.left / Math.max(s.width - s.client, 1)) * 100)}
        aria-label="Barra de navegação do quadro: arraste para rolar"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") step(1);
          if (e.key === "ArrowLeft") step(-1);
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.classList.add("dragging");
          drag(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e.clientX);
        }}
        onPointerUp={(e) => e.currentTarget.classList.remove("dragging")}
      >
        <div className="rail-segments">
          {segments.map((c) => (
            <span key={c.id} className={c.state} title={c.label} />
          ))}
        </div>
        <span
          className="rail-thumb"
          style={{
            transform: `translateX(${(s.left / s.client) * 100}%)`,
            width: `${Math.min(100, (s.client / s.width) * 100)}%`,
          }}
        >
          <Icon name="grip" size={14} />
        </span>
      </div>
      <button
        className="nav-arrow"
        aria-label="Rolar quadro para a direita"
        disabled={s.left + s.client >= s.width - 2}
        onClick={() => step(1)}
      >
        <Icon name="right" size={18} />
      </button>
      <span className="nav-count">{segments.length} colunas</span>
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
    const scroll = () => onClose();
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
          Automática · {prettyClass(card.auto_class)}
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

export default function Kanban({
  id,
  onUpdate,
}: {
  id: string;
  onUpdate: () => void;
}) {
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
  const [drag, setDrag] = useState("");
  const [over, setOver] = useState("");
  const [history, setHistory] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
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
  const deferredSearch = useDeferredValue(search);
  const focusColumn = useCallback((columnId: string, cardId?: string) => {
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-column="${CSS.escape(columnId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      if (cardId) {
        setFlash(cardId);
        setTimeout(() => setFlash(""), 1400);
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
      onUpdate();
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
      const next = await api<Detail>(
        `/analyses/${id}/cards/${details.id}?page=${detailData.page + 1}`,
      );
      setDetailData({
        ...next,
        records: [...detailData.records, ...next.records],
      });
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setDetailBusy(false);
    }
  }
  async function finish() {
    setBusy(true);
    setError("");
    try {
      await api(`/analyses/${id}/finish`, { method: "POST" });
      navigate({ view: "analise", id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // Referência estável para os handlers: cards memorizados não redesenham à toa.
  const live = useRef({ act, showDetails, focusColumn, board, drag, setMoving, moving, groupBy });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- atualiza a referência a cada render, de propósito
  useLayoutEffect(() => {
    live.current = { act, showDetails, focusColumn, board, drag, setMoving, moving, groupBy };
  });
  const h = useMemo<Handlers>(
    () => ({
      act: (action, fields) => live.current.act(action, fields),
      details: (card) => void live.current.showDetails(card),
      toggleMove: (cardId) => live.current.setMoving((m) => (m === cardId ? null : cardId)),
      moveTo: async (cardId, columnId, follow) => {
        if (await live.current.act(...moveAction(cardId, columnId))) {
          live.current.setMoving(null);
          if (follow) live.current.focusColumn(columnId, cardId);
        }
      },
      pickClass: (card, anchor) => setPicker({ card, rect: anchor.getBoundingClientRect() }),
      dragStart: (cardId) => setDrag(cardId),
      dragEnd: () => {
        setDrag("");
        setOver("");
      },
      dragOver: (columnId) => setOver(columnId),
      dragLeave: () => setOver(""),
      drop: (cardId, columnId) => {
        if (cardId.startsWith("group:")) {
          // Bloco de uma máquina: todos os relatos dela passam para a falha da coluna de destino.
          const ids = new Set(cardId.slice(6).split(","));
          const items = (live.current.board?.cards || [])
            .filter((c) => ids.has(c.id) && c.class !== columnId)
            .map((c) => ({ card_id: c.id, failure_class: columnId }));
          if (live.current.groupBy === "falha" && items.length) void live.current.act("set_classes", { items });
          setDrag("");
          setOver("");
          return;
        }
        const card = live.current.board?.cards.find((c) => c.id === cardId);
        const current = card && (live.current.groupBy === "falha" ? card.class : card.column_id);
        if (card && current !== columnId) void live.current.act(...moveAction(cardId, columnId));
        setDrag("");
        setOver("");
      },
      validateColumn: (columnId, cardIds) => {
        if (live.current.groupBy === "falha") void live.current.act("validate_cards", { card_ids: cardIds });
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
  /** Na visão por falha, mover um card para outra coluna = trocar a classe de falha. */
  function moveAction(cardId: string, columnId: string): [string, object] {
    if (live.current.groupBy !== "falha") return ["move", { card_id: cardId, column_id: columnId }];
    const card = live.current.board?.cards.find((c) => c.id === cardId);
    return ["set_class", { card_id: cardId, failure_class: card && card.auto_class === columnId ? "" : columnId }];
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
        context: list.length ? `${fmt(nMachines)} máquina(s) · ${fmt(minutes.get(k) || 0)} min` : "Classe nova · arraste cards para cá",
      };
    });
  }, [board, groupBy, byColumn, extraClasses]);
  const openKeyList = useMemo(() => [...openGroups], [openGroups]);
  const segments = useMemo(
    () =>
      viewColumns.map((c) => {
        const n = byColumn.get(c.id)?.length || 0;
        return { id: c.id, label: `${c.name} · ${c.context} · ${n} card(s)`, state: c.validated ? "ok" : n ? "" : "empty" };
      }),
    [viewColumns, byColumn],
  );
  const movingColumn = useMemo(() => {
    if (!board || !moving) return null;
    const card = board.cards.find((c) => c.id === moving);
    if (!card) return null;
    const current = groupBy === "falha" ? card.class : card.column_id;
    return viewColumns.filter((c) => c.id !== current);
  }, [board, moving, viewColumns, groupBy]);
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
  const equipmentFailures = new Set(visibleCards.map((c) => `${c.class}|${c.column_id}`)).size;
  const failureKinds = new Set(visibleCards.map((c) => c.class)).size;
  const progress = board.groups_count
    ? (board.validated_count / board.groups_count) * 100
    : 0;
  return (
    <div className="board-page">
      <button
        className="text-btn back-link"
        onClick={() => navigate({ view: "inicio" })}
      >
        <Icon name="back" size={17} />
        Voltar ao início
      </button>
      <Heading
        eyebrow="02 / REVISAR E VALIDAR"
        title={board.name}
        text={`${fmt(board.records_count)} apontamentos · ${fmt(equipmentFailures)} falhas por equipamento em ${fmt(failureKinds)} tipos de falha`}
        action={
          <div className="notifications" ref={bellRef}>
            <button
              className={`bell-btn ${bell ? "active" : ""}`}
              aria-label={`Itens em revisão: ${held.length}`}
              aria-expanded={bell}
              onClick={() => setBell(!bell)}
            >
              <Icon name="bell" size={22} />
              {held.length > 0 && (
                <span className="notification-badge">{held.length}</span>
              )}
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
                        <button
                          className="text-btn"
                          onClick={() =>
                            setMoving(moving === c.id ? null : c.id)
                          }
                        >
                          Mover <Icon name="arrow" size={14} />
                        </button>
                        {moving === c.id && (
                          <Move
                            columns={board.columns}
                            busy={busy}
                            onMove={async (column_id) => {
                              if (
                                await act("move", { card_id: c.id, column_id })
                              )
                                setMoving(null);
                            }}
                          />
                        )}
                      </article>
                    ))
                  ) : (
                    <div className="notification-empty">
                      <Icon name="check" />
                      <b>Tudo resolvido por aqui</b>
                      <span>Use a lupa de um card para revisá-lo depois.</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        }
      />
      <ErrorNotice message={error} retry={() => void load()} />
      <ReviewBar
        board={board}
        queue={queue}
        onQueue={setQueue}
        busy={busy}
        search={search}
        onSearch={setSearch}
        onBatch={() => {
          setError("");
          setBatchOpen(true);
        }}
        groupBy={groupBy}
        onGroupBy={(g) => {
          setGroupBy(g);
          setMoving(null);
          boardRef.current?.scrollTo({ left: 0 });
        }}
        more={
          <MoreMenu>
            <AutomationSummary board={board} onTrain={() => void train()} training={training} />
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
        }
      />
      <BoardRail boardRef={boardRef} segments={segments} />
      <div
        className="kanban-board"
        id="kanban-board"
        aria-label="Quadro de validação"
        ref={boardRef}
        onDragOver={(e) => {
          // Rolagem automática enquanto o card é arrastado perto das bordas.
          const el = boardRef.current;
          if (!drag || !el) return;
          const r = el.getBoundingClientRect();
          if (e.clientX < r.left + 90) el.scrollLeft -= 22;
          else if (e.clientX > r.right - 90) el.scrollLeft += 22;
        }}
      >
        {columns.map((col, index) => {
          const all = byColumn.get(col.id) || [];
          const term = deferredSearch.toLocaleLowerCase();
          const visible =
            !term && !queue
              ? all
              : all.filter(
                  (c) =>
                    (!queue || c.confidence === queue) &&
                    (!term ||
                      `${c.name} ${c.sample} ${c.class} ${col.name} ${col.context} ${machineOf(c)}`.toLocaleLowerCase().includes(term)),
                );
          if (queue && !visible.length) return null;
          const inColumn = (id: string) => (id && all.some((c) => c.id === id) ? id : "");
          return (
            <KanbanColumn
              key={col.id}
              col={col}
              index={index}
              total={columns.length}
              prevId={columns[index - 1]?.id}
              nextId={columns[index + 1]?.id}
              cards={visible}
              allCount={all.length}
              busy={busy}
              canDrop={!!drag}
              over={over === col.id}
              dragId={groupBy === "falha" && drag.startsWith("group:") ? drag : inColumn(drag)}
              flashId={inColumn(flash)}
              movingId={inColumn(moving || "")}
              moveColumns={inColumn(moving || "") ? movingColumn : null}
              machineOf={groupBy === "falha" ? machineOf : null}
              machines={machines}
              openKeys={openKeyList.filter((k) => k.startsWith(`${col.id}|`)).join("\n")}
              h={h}
            />
          );
        })}
        <button
          className="add-column"
          onClick={() => {
            if (groupBy === "falha") {
              setNewFailure("");
              return;
            }
            setNewCol({
              name: "",
              unit: board.columns[0]?.unit || "",
              line: board.columns[0]?.line || "",
            });
            setAdding(true);
          }}
        >
          <Icon name="plus" size={23} />
          <span>{groupBy === "falha" ? "Nova falha" : "Nova coluna"}</span>
        </button>
      </div>
      {picker && (
        <ClassPicker
          card={board.cards.find((c) => c.id === picker.card.id) || picker.card}
          anchor={picker.rect}
          classes={board.classes}
          onClose={() => setPicker(null)}
          onPick={(value) => {
            const cardId = picker.card.id;
            setPicker(null);
            void act("set_class", { card_id: cardId, failure_class: value });
          }}
          onNew={() => {
            setNewClass({ card: picker.card.id, value: "" });
            setPicker(null);
          }}
        />
      )}
      <div className="validation-footer">
        <div className="validation-status">
          <span className={`status-ring ${board.ready ? "complete" : ""}`}>
            {board.ready ? (
              <Icon name="check" size={18} />
            ) : (
              <Icon name="shield" size={19} />
            )}
          </span>
          <div>
            <b>
              {board.ready
                ? "Tudo validado. Vamos aos gráficos?"
                : `${fmt(board.validated_count)} de ${fmt(board.groups_count)} grupos validados`}
            </b>
            <small>
              {held.length
                ? `${held.length} item(ns) no sino de revisão`
                : pending
                  ? "Confira os cards restantes para continuar."
                  : "Suas alterações estão salvas."}
            </small>
          </div>
        </div>
        <div
          className="progress-track"
          aria-label={`${Math.round(progress)}% validado`}
        >
          <i style={{ width: `${progress}%` }} />
        </div>
        {!board.ready && (
          <button
            className="btn confirm-all"
            disabled={busy || pending === 0}
            onClick={() => {
              setChecked(false);
              setTyped("");
              setConfirmAll(true);
            }}
          >
            <Icon name="checks" size={17} />
            Confirmar todos
          </button>
        )}
        <button
          className="btn primary next-step"
          disabled={!board.ready || busy}
          onClick={() => void finish()}
          title={
            !board.ready
              ? "Valide todos os cards e esvazie o sino"
              : "Abrir dashboard"
          }
        >
          Ver análises <Icon name="arrow" />
        </button>
      </div>
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
                    {{
                      validate_column: "Coluna validada",
                      validate_card: "Validação de card alterada",
                      validate_all: "Todos os cards confirmados",
                      set_class: "Classe de falha alterada",
                      set_classes: "Classes aplicadas em lote",
                      validate_cards: "Falha validada (cards da coluna)",
                      validate_confident: "Lote de confiança alta validado",
                      hold: "Card enviado ao sino",
                      move: "Card movido",
                      add_column: "Coluna criada",
                      delete_column: "Coluna vazia excluída",
                      rename_card: "Descrição editada",
                      split_card: "Registros desagrupados",
                    }[e.action] || e.action}
                  </b>
                  <p>
                    {e.card || e.column}
                    {e.value != null && e.action !== "set_class" ? `${fmt(Number(e.value))} card(s)` : ""}
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
