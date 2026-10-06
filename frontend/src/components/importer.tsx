"use client";
import { useRef, useState } from "react";
import { api, ApiError, navigate, type Board } from "@/lib/radar";
import { Icon, Heading, ErrorNotice } from "./ui";
import { BottleFill } from "./brand";
export default function Importer({ onUpdate }: { onUpdate: () => void }) {
  const [file, setFile] = useState<File>();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  function choose(candidate?: File) {
    if (!candidate || busy) return;
    setError("");
    setExisting("");
    if (!/\.(xlsx|xlsm|csv)$/i.test(candidate.name)) {
      setError("Selecione uma planilha .xlsx, .xlsm ou .csv.");
      return;
    }
    if (candidate.size > 50 * 1024 * 1024) {
      setError("O arquivo excede 50 MB.");
      return;
    }
    setFile(candidate);
  }
  async function upload() {
    if (!file) return;
    setBusy(true);
    setError("");
    setExisting("");
    const body = new FormData();
    body.append("file", file);
    try {
      const result = await api<Board>("/import", { method: "POST", body });
      onUpdate();
      navigate({ view: "quadro", id: result.id });
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.existingId) setExisting(e.existingId);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="01 / IMPORTAR APONTAMENTOS"
        title="Tudo começa com sua planilha."
        text="O Python organiza informações redundantes no mesmo contexto. Você confere o resultado no quadro."
      />
      <div className="import-layout">
        <section className="panel import-main">
          <div className="import-panel-head">
            <span className="step-mark">01</span>
            <div>
              <h2>Adicionar arquivo</h2>
              <p>Selecione a exportação da sua operação.</p>
            </div>
          </div>
          <button
            type="button"
            className={`drop-zone ${drag ? "over" : ""} ${file ? "selected" : ""}`}
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
              choose(e.dataTransfer.files[0]);
            }}
          >
            <span className="upload-glyph">
              <Icon name={file ? "file" : "upload"} size={32} />
            </span>
            <b>{file ? file.name : "Arraste sua planilha até aqui"}</b>
            <span>
              {file
                ? `${(file.size / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} MB · pronta para processar`
                : "ou clique para procurar no computador"}
            </span>
            <small>XLSX, XLSM ou CSV · até 50 MB</small>
          </button>
          <input
            ref={ref}
            className="sr-only"
            type="file"
            accept=".xlsx,.xlsm,.csv"
            aria-label="Selecionar planilha"
            onChange={(e) => choose(e.target.files?.[0])}
            disabled={busy}
          />
          <ErrorNotice message={error} />
          {existing && (
            <button
              className="btn secondary"
              onClick={() => navigate({ view: "quadro", id: existing })}
            >
              Abrir análise existente <Icon name="arrow" size={16} />
            </button>
          )}
          <button
            className="btn primary import-submit"
            disabled={!file || busy}
            onClick={() => void upload()}
          >
            {busy ? (
              <>
                <span className="spinner" />
                Processando e agrupando…
              </>
            ) : (
              <>
                Importar e agrupar <Icon name="arrow" size={18} />
              </>
            )}
          </button>
          <div className="privacy-note">
            <Icon name="shield" size={16} />
            <span>
              Processamento local. Seus registros originais são preservados.
            </span>
          </div>
          {busy && (
            <div className="import-working" role="status">
              <BottleFill size={64} />
              <p>
                Lendo a planilha e comparando descrições do mesmo contexto.
                Arquivos maiores podem levar alguns minutos.
              </p>
            </div>
          )}
        </section>
        <aside className="import-aside">
          <span className="eyebrow">COMO FUNCIONA</span>
          <ol className="process-list">
            <li>
              <span>1</span>
              <div>
                <b>Importação e leitura</b>
                <p>Reconhecemos as colunas, datas e tempos de parada.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <b>Agrupamento por contexto</b>
                <p>
                  Unidade, linha, equipamento e tipo de falha ajudam a reunir
                  descrições redundantes, sem limite de membros.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <b>Validação no seu ritmo</b>
                <p>
                  Revise card por card ou valide a coluna inteira antes de
                  seguir.
                </p>
              </div>
            </li>
          </ol>
          <div className="required-columns">
            <Icon name="file" size={20} />
            <h3>O que a planilha precisa ter</h3>
            <p>Data, linha, equipamento, observações e minutos de parada.</p>
            <small>
              Unidade e tipo de falha habilitam filtros mais completos.
              Cabeçalhos do SAP também são reconhecidos.
            </small>
          </div>
        </aside>
      </div>
    </>
  );
}
