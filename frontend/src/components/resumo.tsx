"use client";
/* Planilha resumida: solte uma planilha com "Observações" (e, se tiver, "Classificação") e baixe uma
   planilha nova com uma linha por observação ÚNICA e a classificação padronizada ("FALHA DE …"),
   preenchida pela ferramenta onde estava em branco. As classificações dos analistas ensinam a ML. */
import { useRef, useState } from "react";
import { api, apiUrl, fmt, prettyClass } from "@/lib/radar";
import { Icon, Heading, ErrorNotice } from "./ui";

type Stats = {
  rows: number;
  unique: number;
  duplicates: number;
  blank: number;
  analyst: number;
  filled: number;
  unclassified: number;
  classes: number;
  by_source: Record<string, number>;
  model_accuracy: number | null;
  model_examples: number | null;
};
type Preview = { text: string; count: number; class: string; source: string; confidence: string; analyst: string; variations: number };
type Result = { id: string; filename: string; full: string | null; stats: Stats; preview: Preview[] };

const TONE: Record<string, string> = { alta: "ok", media: "warn", baixa: "bad" };
const CONF: Record<string, string> = { alta: "Alta", media: "Média", baixa: "Revisar" };

export default function Resumo() {
  const [file, setFile] = useState<File>();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result>();
  const ref = useRef<HTMLInputElement>(null);

  async function send(candidate?: File) {
    if (!candidate || busy) return;
    setError("");
    if (!/\.(xlsx|xlsm|csv)$/i.test(candidate.name)) {
      setError("Selecione uma planilha .xlsx, .xlsm ou .csv.");
      return;
    }
    if (candidate.size > 50 * 1024 * 1024) {
      setError("O arquivo excede 50 MB.");
      return;
    }
    setFile(candidate);
    setResult(undefined);
    setBusy(true);
    const body = new FormData();
    body.append("file", candidate);
    try {
      setResult(await api<Result>("/resumo", { method: "POST", body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const st = result?.stats;
  return (
    <div className="rs">
      <Heading
        eyebrow="CLASSIFICAR PLANILHA"
        title="A ML preenche a Classificação."
        text="Solte a planilha completa do SAP (ou só com a coluna Observações). Você baixa a mesma planilha com a coluna Classificação preenchida no padrão “Falha de <componente>” e, se quiser, a versão resumida, uma linha por observação."
      />
      <button
        type="button"
        className={`rs-drop ${drag ? "over" : ""} ${busy ? "busy" : ""}`}
        disabled={busy}
        onClick={() => ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void send(e.dataTransfer.files[0]);
        }}
      >
        <span className="rs-drop-icon">
          <Icon name={busy ? "brain" : file ? "file" : "upload"} size={26} />
        </span>
        <span className="rs-drop-text">
          <b>{busy ? `Lendo ${file?.name}…` : file && result ? "Soltar outra planilha" : "Arraste a planilha até aqui"}</b>
          <small>
            {busy
              ? "Agrupando repetições, aprendendo com as classificações dos analistas e preenchendo o resto."
              : "ou clique para escolher · .xlsx, .xlsm ou .csv · precisa de uma coluna “Observações”"}
          </small>
        </span>
        {busy && <span className="rs-spinner" aria-hidden="true" />}
      </button>
      <input
        ref={ref}
        type="file"
        hidden
        accept=".xlsx,.xlsm,.csv"
        onChange={(e) => {
          void send(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <ErrorNotice message={error} />

      {result && st && (
        <>
          <section className="rs-result">
            <div className="rs-result-head">
              <div>
                <span className="rs-ok">
                  <Icon name="check" size={13} />
                  Classificação pronta
                </span>
                <h2>{result.full || result.filename}</h2>
                <p>
                  {fmt(st.rows)} linhas viraram <b>{fmt(st.unique)} observações únicas</b> ({fmt(st.duplicates)} repetições agrupadas) em{" "}
                  {fmt(st.classes)} classificações.
                </p>
              </div>
              <div className="rs-downloads">
                {result.full && (
                  <a className="btn primary" href={apiUrl(`/api/workspace/resumo/${result.id}/completa`)} download>
                    <Icon name="download" size={16} />
                    Planilha completa com Classificação
                  </a>
                )}
                <a className={`btn ${result.full ? "secondary" : "primary"}`} href={apiUrl(`/api/workspace/resumo/${result.id}.xlsx`)} download>
                  <Icon name="download" size={16} />
                  Resumida (sem repetições)
                </a>
              </div>
            </div>
            <div className="rs-stats">
              <div>
                <b>{fmt(st.analyst)}</b>
                <span>classificadas pelo analista e padronizadas</span>
              </div>
              <div>
                <b>{fmt(st.filled)}</b>
                <span>preenchidas pela ferramenta</span>
              </div>
              <div className={st.unclassified ? "warn" : ""}>
                <b>{fmt(st.unclassified)}</b>
                <span>sem modo de falha / sem descrição — análise manual</span>
              </div>
              <div>
                <b>{st.model_accuracy != null ? `${fmt(st.model_accuracy, 1)}%` : "Calibrando"}</b>
                <span>
                  acerto do modelo em teste cego{st.model_examples ? ` · ${fmt(st.model_examples)} exemplos` : ""}
                </span>
              </div>
            </div>
          </section>
          <section className="rs-table-wrap">
            <header>
              <h3>Prévia · as {fmt(result.preview.length)} observações mais frequentes</h3>
              <span>
                <i className="tone-ok" /> Alta <i className="tone-warn" /> Média <i className="tone-bad" /> Revisar
              </span>
            </header>
            <div className="rs-table-scroll">
              <table className="rs-table">
                <thead>
                  <tr>
                    <th>Observação</th>
                    <th>Ocorr.</th>
                    <th>Classificação</th>
                    <th>Origem</th>
                  </tr>
                </thead>
                <tbody>
                  {result.preview.map((p, i) => (
                    <tr key={i}>
                      <td>
                        {p.text || <em>(em branco)</em>}
                        {p.variations > 0 && <small>+{fmt(p.variations)} variação(ões) de escrita</small>}
                      </td>
                      <td className="num">{fmt(p.count)}</td>
                      <td>
                        <span className={`rs-class tone-${TONE[p.confidence] || "none"}`} title={CONF[p.confidence] || ""}>
                          <i />
                          {prettyClass(p.class)}
                        </span>
                        {p.analyst && p.source.startsWith("Analista") && <small>analista: {p.analyst}</small>}
                      </td>
                      <td className="src">{p.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
