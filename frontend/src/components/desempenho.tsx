"use client";
/* Desempenho da ML: só acompanha o aprendizado (nada de enviar planilha aqui).
   - Acerto por planilha finalizada: classe sugerida na chegada × classe final do analista.
   - Modelo: acerto em teste cego (20% dos relatos validados que ele não viu no treino) e evolução.
   - Memória de correções: relatos que o analista corrigiu e que já chegam certos. */
import { useEffect, useState } from "react";
import { api, fmt, navigate, type Learning, type SheetReport } from "@/lib/radar";
import { Icon, Heading, ErrorNotice, Loading } from "./ui";

type Status = Learning & { training: boolean; sheets: SheetReport[]; memory: number; pending: number };

const tone = (v: number) => (v >= 85 ? "ok" : v >= 70 ? "warn" : "bad");

function Curve({ values, labels }: { values: number[]; labels: string[] }) {
  const w = 640,
    h = 190,
    l = 40,
    r = 16,
    t = 28,
    b = 30;
  const min = Math.max(0, Math.floor((Math.min(...values) - 5) / 10) * 10),
    max = Math.min(100, Math.ceil((Math.max(...values) + 5) / 10) * 10);
  const x = (i: number) => l + (i * (w - l - r)) / Math.max(values.length - 1, 1);
  const y = (v: number) => t + (1 - (v - min) / Math.max(max - min, 1)) * (h - t - b);
  const ticks = [min, (min + max) / 2, max];
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="dp-curve" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Acerto em ${values.length} pontos`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={l} x2={w - r} y1={y(v)} y2={y(v)} className="grid" />
          <text x={l - 8} y={y(v) + 4} textAnchor="end">
            {fmt(v, 0)}%
          </text>
        </g>
      ))}
      <path className="area" d={`M${x(0)},${h - b} L${pts.replace(/ /g, " L")} L${x(values.length - 1)},${h - b} Z`} />
      <polyline className="line" points={pts} />
      {values.map((v, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(v)} r="4" />
          <title>{`${labels[i]}: ${fmt(v, 1)}%`}</title>
          {(values.length <= 12 || i === values.length - 1) && (
            <text x={x(i)} y={y(v) - 10} textAnchor="middle" className="val">
              {fmt(v, 0)}%
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export default function Desempenho() {
  const [s, setS] = useState<Status>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<Status>("/learning")
      .then((d) => active && setS(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  async function train() {
    setBusy(true);
    setError("");
    try {
      setS(await api<Status>("/learning/train", { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!s) return error ? <ErrorNotice message={error} /> : <Loading />;
  const sheets = s.sheets || [];
  const last = sheets.at(-1);
  const first = sheets[0];
  const model = s.history || [];
  const need = s.measure_min || 60;
  const trained = s.trained_at ? new Date(s.trained_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "";
  return (
    <div className="dp">
      <Heading
        eyebrow="DESEMPENHO DA MACHINE LEARNING"
        title="Quanto a ML acerta e como evolui."
        text="A ML aprende a cada planilha que você valida no quadro e finaliza. Aqui você acompanha o resultado."
        action={
          <button className="btn secondary" disabled={busy || s.training} onClick={() => void train()}>
            <Icon name="refresh" size={16} />
            {busy || s.training ? "Treinando…" : "Treinar agora"}
          </button>
        }
      />
      <ErrorNotice message={error} />
      <div className="dp-kpis">
        <div>
          <span>Acerto na última planilha</span>
          <b className={last ? `tone-${tone(last.hit_rate)}` : ""}>{last ? `${fmt(last.hit_rate, 1)}%` : "—"}</b>
          <small>
            {last
              ? first && sheets.length > 1
                ? `${fmt(first.hit_rate, 0)}% na 1ª → ${fmt(last.hit_rate, 0)}% em ${sheets.length} planilhas`
                : "a curva aparece a partir da 2ª planilha"
              : "nenhuma planilha finalizada ainda"}
          </small>
        </div>
        <div>
          <span>Acerto do modelo (teste cego)</span>
          <b className={s.accuracy != null ? `tone-${tone(s.accuracy)}` : ""}>{s.accuracy != null ? `${fmt(s.accuracy, 1)}%` : "—"}</b>
          <small>
            {s.accuracy != null
              ? `${fmt(s.examples)} exemplos · ${fmt(s.classes)} tipos de falha`
              : `${fmt(Math.min(s.examples || 0, need))}/${fmt(need)} relatos validados para medir`}
          </small>
        </div>
        <div>
          <span>Memória de correções</span>
          <b>{fmt(s.memory)}</b>
          <small>relatos corrigidos que já chegam classificados</small>
        </div>
        <div>
          <span>Planilhas finalizadas</span>
          <b>{fmt(sheets.length)}</b>
          <small>{s.pending ? `${fmt(s.pending)} em validação no quadro` : trained ? `último treino ${trained}` : "—"}</small>
        </div>
      </div>

      <section className="dp-card">
        <header>
          <h2>Acerto por planilha finalizada</h2>
          <p>
            Em cada planilha, a classe que a ML sugeriu quando ela chegou é comparada com a classe final validada por você. Subindo =
            a ML está aprendendo.
          </p>
        </header>
        {sheets.length >= 2 ? (
          <Curve values={sheets.map((x) => x.hit_rate)} labels={sheets.map((x) => x.name)} />
        ) : (
          <p className="dp-empty">
            <Icon name="chart" size={18} />
            {sheets.length ? "Finalize mais uma planilha para ver a curva." : "Valide uma planilha no quadro e clique em “Finalizar e ver análises”."}
          </p>
        )}
        {sheets.length > 0 && (
          <div className="dp-table-scroll">
            <table className="dp-table">
              <thead>
                <tr>
                  <th>Planilha</th>
                  <th>Finalizada</th>
                  <th>Apontamentos</th>
                  <th>Acerto da ML</th>
                  <th>Correções</th>
                  <th>Já veio aprendido</th>
                </tr>
              </thead>
              <tbody>
                {[...sheets].reverse().map((x) => (
                  <tr key={x.id}>
                    <td>
                      <button type="button" className="dp-link" onClick={() => navigate({ view: "analise", id: x.id })}>
                        {x.name}
                      </button>
                      {x.estimated && <small>estimado</small>}
                    </td>
                    <td>{x.finished_at ? new Date(x.finished_at).toLocaleDateString("pt-BR") : "—"}</td>
                    <td className="num">{fmt(x.records)}</td>
                    <td className="num">
                      <span className={`dp-pill tone-${tone(x.hit_rate)}`}>{fmt(x.hit_rate, 1)}%</span>
                      {x.previous_hit_rate != null && (
                        <small className={x.hit_rate >= x.previous_hit_rate ? "up" : "down"}>
                          {x.hit_rate >= x.previous_hit_rate ? "▲" : "▼"} {fmt(Math.abs(x.hit_rate - x.previous_hit_rate), 1)}
                        </small>
                      )}
                    </td>
                    <td className="num">{fmt(x.corrections)}</td>
                    <td className="num">{fmt(x.from_past, 0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dp-card">
        <header>
          <h2>Modelo · acerto em teste cego a cada treino</h2>
          <p>O modelo treina com 80% dos relatos validados e é testado nos 20% que não viu.</p>
        </header>
        {model.length >= 2 ? (
          <Curve
            values={model.map((p) => p.accuracy)}
            labels={model.map((p) => `${new Date(p.at).toLocaleDateString("pt-BR")} · ${fmt(p.examples)} exemplos`)}
          />
        ) : (
          <p className="dp-empty">
            <Icon name="brain" size={18} />
            {s.accuracy != null ? "A curva aparece a partir do 2º treino." : `O acerto do modelo é medido a partir de ${fmt(need)} relatos validados.`}
          </p>
        )}
      </section>
    </div>
  );
}
