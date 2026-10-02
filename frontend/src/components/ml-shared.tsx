"use client";
/* Peças compartilhadas do ML: qualidade do modelo e tratamento dos dados.
   Usadas pela tela "Gerar Planilha de Apontamentos" e pelo fluxo único. */
import { fmt } from "@/lib/radar";
import { Icon } from "./ui";

export type Band = "Alta" | "Média" | "Baixa";
export type Faixa = Band | "Analista";
export type CleaningInfo = {
  lidas: number;
  faltantes: number;
  sem_conteudo: number;
  rotulo_sem_informacao: number;
  rotulos_antes: number;
  rotulos_depois: number;
  duplicadas: number;
  conflitos: number;
  substituidos_pelo_analista: number;
  classe_pelo_rotulo: number;
  classe_pelo_relato: number;
  classe_propria: number;
  so_detalhe: number;
  do_analista: number;
  exemplos: number;
  exemplos_com_classe: number;
};
export type ModelInfo = {
  ready: boolean;
  erro?: string;
  training?: boolean;
  pending?: boolean;
  trained_at: string;
  files: { file: string; rows: number }[];
  cleaning: CleaningInfo;
  examples: number;
  train_size: number;
  test_size: number;
  classes: number;
  accuracy: number;
  previous_accuracy: number | null;
  error_rate: number;
  margin: number;
  ci_low: number;
  ci_high: number;
  stability_mean: number;
  stability_sd: number;
  stability_runs: number;
  top3: number;
  detail_accuracy: number;
  analyst_examples: number;
  bands: { band: Band; share: number; accuracy: number | null; count: number }[];
};

export const BANDS: Band[] = ["Alta", "Média", "Baixa"];
export const pct = (v: number | null | undefined) => (v == null ? "—" : `${fmt(v, 1)}%`);

export function Cleaning({ c }: { c: CleaningInfo }) {
  const steps: [string, number, string][] = [
    ["Linhas lidas nas planilhas de treino", c.lidas, ""],
    ["Sem relato ou sem classificação", -c.faltantes, "removidas"],
    ["Relato sem conteúdo (“xxxxxx”, só a O.S.…)", -c.sem_conteudo, "removidas"],
    ["Classificação sem informação (“Sem detalhes”…)", -c.rotulo_sem_informacao, "removidas"],
    ["Duplicadas (mesmo relato e classificação)", -c.duplicadas, "unidas, viram peso"],
    ["Mesmo relato com classificações diferentes", c.conflitos, "fica a da maioria"],
    ["Classificações quase iguais unidas", c.rotulos_antes - c.rotulos_depois, `${fmt(c.rotulos_antes)} → ${fmt(c.rotulos_depois)}`],
  ];
  return (
    <section className="panel ml-cleaning" aria-label="Tratamento dos dados">
      <span className="eyebrow">TRATAMENTO DOS DADOS</span>
      <ol>
        {steps.map(([label, n, note]) => (
          <li key={label} className={n < 0 ? "minus" : ""}>
            <span>{label}</span>
            <b>{n < 0 ? `−${fmt(-n)}` : fmt(n)}</b>
            {note && <small>{note}</small>}
          </li>
        ))}
        {c.do_analista > 0 && (
          <li className="plus">
            <span>Relatos revisados pelo analista (valem 3×)</span>
            <b>+{fmt(c.do_analista)}</b>
          </li>
        )}
        <li className="total">
          <span>Relatos únicos usados</span>
          <b>{fmt(c.exemplos)}</b>
        </li>
      </ol>
      <p className="helper">
        Classe padronizada: {fmt(c.classe_pelo_rotulo)} pela classificação do analista, {fmt(c.classe_pelo_relato)} pelo
        relato, {fmt(c.classe_propria)} em classes recorrentes fora do catálogo. {fmt(c.so_detalhe)} relatos sem classe
        reconhecível só servem para o detalhe.
      </p>
    </section>
  );
}

export function ModelQuality({ info, onRetrain, training }: { info: ModelInfo; onRetrain: () => void; training: boolean }) {
  const busy = training || info.training;
  return (
    <section className="panel ml-quality" aria-label="Qualidade do modelo">
      <header className="ml-quality-head">
        <div>
          <span className="eyebrow">QUALIDADE DO MODELO · TESTE 20%</span>
          <div className="ml-accuracy">
            <strong>{pct(info.accuracy)}</strong>
            <span>
              de acerto da classe
              <b>± {fmt(info.margin, 1)} p.p.</b>
            </span>
          </div>
          <p>
            Margem de erro com 95% de confiança: o acerto real fica entre <b>{pct(info.ci_low)}</b> e{" "}
            <b>{pct(info.ci_high)}</b>. Taxa de erro: <b>{pct(info.error_rate)}</b>. Em {info.stability_runs} sorteios
            80/20 diferentes: <b>{pct(info.stability_mean)}</b> ± {fmt(info.stability_sd, 1)}.
          </p>
          {info.previous_accuracy != null && info.previous_accuracy !== info.accuracy && (
            <p className="ml-delta">
              <Icon name={info.accuracy >= info.previous_accuracy ? "up" : "down"} size={14} />
              Modelo atualizado: {pct(info.previous_accuracy)} → {pct(info.accuracy)}
            </p>
          )}
        </div>
        <button className="btn small secondary" disabled={busy} onClick={onRetrain}>
          <Icon name="refresh" size={15} />
          {busy ? "Treinando…" : "Retreinar"}
        </button>
      </header>
      {info.pending && !busy && (
        <p className="info-notice">
          <Icon name="info" size={15} /> Há revisões novas: o modelo será atualizado em instantes.
        </p>
      )}

      <div className="ml-split" aria-label="Divisão dos dados">
        <i style={{ width: `${(info.train_size / info.examples) * 100}%` }}>Treino · {fmt(info.train_size)}</i>
        <i>Teste · {fmt(info.test_size)}</i>
      </div>

      <div className="ml-bands">
        <span className="eyebrow">ACERTO POR FAIXA DE CONFIANÇA</span>
        <table>
          <thead>
            <tr>
              <th>Faixa</th>
              <th>Linhas do teste</th>
              <th>Acerto</th>
            </tr>
          </thead>
          <tbody>
            {info.bands.map((b) => (
              <tr key={b.band}>
                <td>
                  <span className={`ml-band band-${b.band}`}>
                    <i />
                    {b.band}
                  </span>
                  <small>{{ Alta: "confiança ≥ 50%", Média: "20% a 50%", Baixa: "abaixo de 20%" }[b.band]}</small>
                </td>
                <td>{pct(b.share)}</td>
                <td>
                  <div className="ml-meter">
                    <i className={`band-${b.band}`} style={{ width: `${b.accuracy ?? 0}%` }} />
                  </div>
                  <b>{pct(b.accuracy)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-facts">
        <div>
          <dt>Classe certa entre as 3 primeiras</dt>
          <dd>{pct(info.top3)}</dd>
        </div>
        <div>
          <dt>Detalhe igual ao do analista</dt>
          <dd>{pct(info.detail_accuracy)}</dd>
        </div>
        <div>
          <dt>Classes padronizadas</dt>
          <dd>{fmt(info.classes)}</dd>
        </div>
        <div>
          <dt>Revisões do analista no treino</dt>
          <dd>{fmt(info.analyst_examples)}</dd>
        </div>
      </dl>
      <p className="helper ml-note">
        <Icon name="info" size={14} /> Duplicadas foram unidas antes da divisão: o mesmo relato nunca aparece no treino e
        no teste, então o acerto acima é o que o modelo faz com relatos novos. As revisões do analista entram sempre no
        treino; o teste é sorteado só entre as planilhas da pasta. Treinado com{" "}
        {info.files.map((f) => `${f.file} (${fmt(f.rows)})`).join(", ")}.
      </p>
    </section>
  );
}

