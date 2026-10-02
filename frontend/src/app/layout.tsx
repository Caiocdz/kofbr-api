import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Radar de Confiabilidade",
  description:
    "Análise de recorrências, tempo de parada e padrões de falha em apontamentos operacionais, com validação humana.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className="h-full antialiased">
      <body>{children}</body>
    </html>
  );
}
