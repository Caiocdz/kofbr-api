import Link from "next/link";
export default function LoginPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: "100%",
          padding: "44px 40px",
          background: "#fff",
          borderRadius: 28,
          boxShadow: "0 40px 100px -30px #000000a0",
        }}
      >
        <span
          style={{
            fontFamily: "Lokicola, cursive",
            fontSize: 54,
            lineHeight: 1,
            color: "#e0101f",
          }}
        >
          gargalo
        </span>
        <p
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 2,
            color: "#e0101f",
            marginTop: 14,
          }}
        >
          RADAR DE CONFIABILIDADE
        </p>
        <h1
          style={{
            fontSize: 34,
            fontWeight: 800,
            letterSpacing: -1.4,
            lineHeight: 1.12,
            margin: "18px 0 12px",
          }}
        >
          Clareza em cada decisão.
        </h1>
        <p style={{ color: "#5e5a58", lineHeight: 1.7, fontSize: 15 }}>
          Importe apontamentos, revise os agrupamentos e explore os indicadores
          da operação.
        </p>
        <Link
          href="/"
          style={{
            display: "inline-flex",
            background: "#e0101f",
            color: "white",
            fontWeight: 700,
            borderRadius: 999,
            padding: "14px 24px",
            marginTop: 28,
            boxShadow: "0 10px 24px -8px #e0101f80",
          }}
        >
          Acessar área de trabalho →
        </Link>
      </div>
    </main>
  );
}
