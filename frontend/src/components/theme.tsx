"use client";
/* Tema claro/escuro. A escolha fica salva neste computador; sem escolha, segue o tema do sistema.
   O layout aplica o tema antes do primeiro quadro (sem piscar branco). */
import { useEffect, useState } from "react";
import { Icon } from "./ui";

export type Theme = "light" | "dark";
import { THEME_KEY as KEY } from "@/lib/theme-boot";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme, animate = true) {
  const html = document.documentElement;
  if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    html.classList.add("theme-switching");
    setTimeout(() => html.classList.remove("theme-switching"), 450);
  }
  html.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
}


export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    const t = requestAnimationFrame(() => setTheme(currentTheme()));
    return () => cancelAnimationFrame(t);
  }, []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={next === "dark" ? "Ativar modo escuro" : "Ativar modo claro"}
      title={next === "dark" ? "Modo escuro" : "Modo claro"}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      <span className="t-moon" aria-hidden="true">
        <Icon name="moon" size={18} />
      </span>
      <span className="t-sun" aria-hidden="true">
        <Icon name="sun" size={18} />
      </span>
    </button>
  );
}
