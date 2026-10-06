import Link from "next/link";
import { GargaloMark, Ribbon } from "@/components/brand";
import "../ultimate.css";
import "./login.css";

export default function LoginPage() {
  return (
    <main className="lg">
      <section className="lg-brand" aria-hidden="true">
        <span className="lg-bubbles">
          {Array.from({ length: 12 }, (_, i) => (
            <i key={i} style={{ "--i": i } as React.CSSProperties} />
          ))}
        </span>
        <GargaloMark size={260} className="lg-mark" />
        <Ribbon className="lg-ribbon" />
      </section>
      <section className="lg-panel">
        <div className="lg-card">
          <span className="lg-word">gargalo</span>
          <p className="lg-sub">Radar de Confiabilidade · Coca-Cola FEMSA Brasil</p>
          <h1>Da parada à decisão de manutenção.</h1>
          <p className="lg-text">
            Importe os apontamentos do SAP, valide a classificação das falhas e veja o Pareto e o crítico-crônico da sua
            unidade.
          </p>
          <Link href="/" className="lg-btn">
            Entrar na área de trabalho
          </Link>
          <p className="lg-note">Roda neste computador. Nenhum dado sai da sua máquina.</p>
        </div>
      </section>
    </main>
  );
}
