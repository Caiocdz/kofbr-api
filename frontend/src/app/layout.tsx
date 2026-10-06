import type { Metadata } from "next";
import "./globals.css";
import { THEME_BOOT } from "@/lib/theme-boot";

export const metadata: Metadata = {
  title: "Radar de Confiabilidade",
  description:
    "Análise de recorrências, tempo de parada e padrões de falha em apontamentos operacionais, com validação humana.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Tema salvo (ou o do sistema) aplicado antes do primeiro quadro. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        {/* Cobre a tela de vermelho desde o primeiro quadro quando a abertura vai tocar (sem piscar o app). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(sessionStorage.getItem('gargalo-splash')!=='1'&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&location.pathname.indexOf('login')<0)document.documentElement.classList.add('splash-pending')}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
