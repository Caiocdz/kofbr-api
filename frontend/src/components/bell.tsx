"use client";
/* Sino de revisão: itens separados para decidir depois.
   - Não trava: a planilha pode ser finalizada com itens aqui (eles ficam fora dos gráficos).
   - Quando o item for devolvido — mesmo dias depois — ele volta à máquina e ao dia dele, e entra
     nos gráficos daquele dia (os apontamentos guardam a data original). */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fmt, dateLabel, prettyClass, type Card, type Column } from "@/lib/radar";
import { Icon } from "./ui";

const TONE: Record<string, string> = { alta: "ok", media: "warn", baixa: "bad", manual: "man" };

/** "agora", "há 5 min", "há 3 h", "há 2 dias". */
export function since(iso?: string) {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} ${d === 1 ? "dia" : "dias"}`;
}

function Note({ card, busy, onSave }: { card: Card; busy: boolean; onSave: (note: string) => void }) {
  const [value, setValue] = useState(card.held_note || "");
  return (
    <textarea
      className="bl-note"
      rows={value ? 2 : 1}
      maxLength={300}
      placeholder="Anotação: por que ficou no sino? (opcional)"
      value={value}
      disabled={busy}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() !== (card.held_note || "") && onSave(value.trim())}
    />
  );
}

export default function BellDrawer({
  held,
  machines,
  busy,
  finished,
  onClose,
  onRelease,
  onPick,
  onNote,
}: {
  held: Card[];
  machines: Map<string, Column>;
  busy: boolean;
  finished: boolean;
  onClose: () => void;
  onRelease: (card: Card, validate: boolean) => void;
  onPick: (card: Card, anchor: HTMLElement) => void;
  onNote: (card: Card, note: string) => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  const ordered = [...held].sort((a, b) => (a.held_at || "").localeCompare(b.held_at || ""));
  // Portal no <body>: a página tem animação (transform), que prenderia o painel abaixo da barra do topo.
  return createPortal(
    <>
      <button type="button" className="bl-scrim" aria-label="Fechar sino" onClick={onClose} />
      <aside className="bl" role="dialog" aria-label="Sino de revisão">
        <header className="bl-head">
          <span className="bl-icon">
            <Icon name="bell" size={18} />
          </span>
          <div>
            <h2>
              Sino de revisão <span>{fmt(held.length)}</span>
            </h2>
            <p>
              Itens para decidir depois. {finished ? "A planilha já foi finalizada: " : "Você pode finalizar a planilha com eles aqui; "}
              ao devolver, cada um volta à máquina e ao dia dele e entra nos gráficos.
            </p>
          </div>
          <button type="button" className="kb-icon" aria-label="Fechar" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="bl-list">
          {ordered.length ? (
            ordered.map((c) => {
              const m = machines.get(c.column_id);
              return (
                <article key={c.id} className={`bl-item tone-${TONE[c.confidence] || "ok"}`}>
                  <div className="bl-title">
                    <i />
                    <b>{c.name}</b>
                    <small title={c.held_at ? new Date(c.held_at).toLocaleString("pt-BR") : ""}>{since(c.held_at)}</small>
                  </div>
                  <div className="bl-meta">
                    {m && (
                      <span>
                        <Icon name="machine" size={12} />
                        {m.name} · {m.line}
                      </span>
                    )}
                    <span>
                      <Icon name="calendar" size={12} />
                      {c.dates.map(dateLabel).join(", ")}
                    </span>
                    <span>
                      <Icon name="clock" size={12} />
                      {fmt(c.events)} {c.events === 1 ? "falha" : "falhas"} · {fmt(c.minutes, 0)} min
                    </span>
                  </div>
                  <div className="bl-class">
                    <span>Falha atual</span>
                    <b>{prettyClass(c.class)}</b>
                  </div>
                  <Note key={c.held_note || ""} card={c} busy={busy} onSave={(note) => onNote(c, note)} />
                  <div className="bl-actions">
                    <button type="button" className="bl-btn primary" disabled={busy} onClick={() => onRelease(c, true)}>
                      <Icon name="check" size={14} />
                      Devolver e validar
                    </button>
                    <button type="button" className="bl-btn" disabled={busy} onClick={(e) => onPick(c, e.currentTarget)}>
                      <Icon name="pencil" size={13} />
                      Trocar falha
                    </button>
                    <button
                      type="button"
                      className="bl-btn ghost"
                      disabled={busy}
                      title="Volta para a coluna dele no quadro, sem validar"
                      onClick={() => onRelease(c, false)}
                    >
                      <Icon name="undo" size={13} />
                      Devolver ao quadro
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <div className="bl-empty">
              <span>
                <Icon name="check" size={22} />
              </span>
              <b>Nada no sino</b>
              <p>Clique no sino de um card para separá-lo e decidir depois, sem travar a planilha.</p>
            </div>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}
