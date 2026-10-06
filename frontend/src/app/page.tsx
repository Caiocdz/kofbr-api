"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import {
  api,
  navigate,
  readRoute,
  fmt,
  dateLabel,
  downloadExcel,
  type Analysis,
  type Route,
} from "@/lib/radar";
import {
  Icon,
  Heading,
  Stat,
  Period,
  Loading,
  Empty,
  ErrorNotice,
} from "@/components/ui";
import Importer from "@/components/importer";
import Kanban from "@/components/kanban";
import MlFill from "@/components/ml-fill";
import Pipeline from "@/components/pipeline";
import Desempenho from "@/components/desempenho";
import { GargaloMark, Ribbon, Splash, useFizzOnActions } from "@/components/brand";
import { Dashboard, Compare } from "@/components/analysis";
import "./home.css";
import "./kanban.css";
import "./desempenho.css";
import "./ultimate.css";

const weekday = (date: string) =>
  new Date(`${date}T12:00:00`)
    .toLocaleDateString("pt-BR", { weekday: "short" })
    .replace(".", "")
    .replace(/^./, (c) => c.toUpperCase());
const shortDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
function localToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
function groupLabel(date: string, today: number) {
  const [y, m, d] = date.split("-").map(Number);
  const diff = Math.round((today - new Date(y, m - 1, d).getTime()) / 864e5);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Ontem";
  if (diff > 1 && diff < 7) return "Últimos 7 dias";
  if (diff < 0) return "Próximos dias";
  return new Date(y, m - 1, 1)
    .toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
    .replace(/^./, (c) => c.toUpperCase());
}

type Day = Analysis["daily"][number] & { analysis: Analysis };

function Folder({ day, index }: { day: Day; index: number }) {
  const max = Math.max(...day.series, 1);
  return (
    <div
      className="folder-wrap"
      style={{ animationDelay: `${Math.min(index, 14) * 35}ms` }}
    >
      <button
        className="folder-card"
        onClick={() =>
          navigate({ view: "analise", id: day.analysis.id, day: day.date })
        }
        aria-label={`Abrir análise de ${dateLabel(day.date)}, ${day.analysis.name}`}
      >
        <span className="folder" aria-hidden="true">
          <span className="folder-back" />
          <span className="folder-paper">
            <span className="paper-kicker">Pareto</span>
            <svg viewBox="0 0 100 40" preserveAspectRatio="none">
              {day.series.slice(0, 6).map((v, i, list) => {
                const slot = 100 / Math.max(list.length, 1);
                const h = Math.max(3, (v / max) * 36);
                return (
                  <rect
                    key={i}
                    x={i * slot + slot * 0.18}
                    y={40 - h}
                    width={slot * 0.64}
                    height={h}
                    rx="2"
                    fill={i < 2 ? "#e4002b" : "#f6b8c3"}
                  />
                );
              })}
            </svg>
          </span>
          <span className="folder-paper second" />
          <span className="folder-front">
            <span className="folder-count">{fmt(day.count)}</span>
            <span className="folder-unit">ocorrências</span>
            <span className="folder-hours">{fmt(day.minutes / 60, 1)} h</span>
          </span>
        </span>
        <span className="folder-label">
          <b>{shortDate(day.date)}</b>
          <span>– {weekday(day.date)}</span>
        </span>
        <span className="folder-meta">{day.analysis.name}</span>
      </button>
      <button
        className="folder-excel"
        title={`Exportar resumo de ${dateLabel(day.date)} em Excel`}
        aria-label={`Exportar resumo de ${dateLabel(day.date)} em Excel`}
        onClick={() =>
          downloadExcel({ ids: day.analysis.id, from: day.date, to: day.date })
        }
      >
        <Icon name="sheet" size={13} />
        Excel
      </button>
    </div>
  );
}

function Home({ analyses }: { analyses: Analysis[] }) {
  const [search, setSearch] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const [sort, setSort] = useState("desc");
  const [today] = useState(localToday);
  const ready = analyses.filter((a) => a.ready),
    pending = analyses.filter((a) => !a.ready);
  const belled = analyses.filter((a) => a.ready && a.mode !== "ml" && a.held_count > 0);
  const daily = useMemo(
    () =>
      ready
        .flatMap((a) => a.daily.map((d) => ({ ...d, analysis: a })))
        .filter(
          (d) =>
            (!range.from || d.date >= range.from) &&
            (!range.to || d.date <= range.to) &&
            `${d.analysis.filename} ${d.analysis.name} ${dateLabel(d.date)} ${d.date}`
              .toLocaleLowerCase()
              .includes(search.toLocaleLowerCase()),
        )
        .sort((a, b) =>
          sort === "desc"
            ? b.date.localeCompare(a.date)
            : a.date.localeCompare(b.date),
        ),
    [ready, range, search, sort],
  );
  const groups = useMemo(() => {
    const out: { label: string; items: Day[] }[] = [];
    for (const day of daily) {
      const label = groupLabel(day.date, today);
      const last = out.at(-1);
      if (last && last.label === label) last.items.push(day);
      else out.push({ label, items: [day] });
    }
    return out;
  }, [daily, today]);
  const filtered = Boolean(range.from || range.to || search);
  const showToday =
    sort === "desc" && !filtered && daily.length > 0 && groups[0]?.label !== "Hoje";
  const records = analyses.reduce((n, a) => n + a.records_count, 0),
    groupCount = analyses.reduce((n, a) => n + a.groups_count, 0);
  let folderIndex = 0;
  return (
    <>
      <Heading
        eyebrow="RADAR DE CONFIABILIDADE"
        title="Suas análises, organizadas."
        text="Do apontamento à visão completa da operação. Tudo em um só lugar."
        action={
          <button
            className="btn primary"
            onClick={() => navigate({ view: "importar" })}
          >
            <Icon name="plus" size={18} />
            Nova análise
          </button>
        }
      />
      <div className="stats-grid">
        <Stat
          tone="dark"
          index={0}
          label="Análises importadas"
          value={fmt(analyses.length)}
          sub={`${ready.length} validadas e disponíveis`}
          icon="folder"
        />
        <Stat
          index={1}
          label="Apontamentos"
          value={fmt(records)}
          sub="Registros originais preservados"
          icon="file"
        />
        <Stat
          index={2}
          label="Grupos identificados"
          value={fmt(groupCount)}
          sub={
            records
              ? `${fmt((1 - groupCount / records) * 100, 1)}% menos descrições para revisar`
              : "Informações organizadas por contexto"
          }
          icon="chart"
        />
        <Stat
          index={3}
          label="Aguardando revisão"
          value={fmt(pending.length)}
          sub="Continue de onde parou"
          icon="clock"
        />
      </div>
      {pending.length > 0 && (
        <section className="pending-section">
          <div className="section-heading">
            <div>
              <h2>
                Continue sua revisão{" "}
                <span className="count-pill">{pending.length}</span>
              </h2>
              <p>
                O progresso está salvo. Conclua a validação para liberar os
                resultados.
              </p>
            </div>
          </div>
          <div className="pending-list">
            {pending.map((a) => {
              const pct = a.groups_count
                ? (a.validated_count / a.groups_count) * 100
                : 0;
              return (
                <button
                  className="pending-item"
                  key={a.id}
                  onClick={() =>
                    navigate(a.mode === "ml" ? { view: "fluxo", id: a.id, step: a.step } : { view: "quadro", id: a.id })
                  }
                >
                  <span
                    className="pending-ring"
                    style={{ "--p": `${pct}%` } as React.CSSProperties}
                  >
                    <span>{Math.round(pct)}%</span>
                  </span>
                  <span className="pending-name">
                    <b>{a.filename}</b>
                    <small>
                      {a.validated_count} de {a.groups_count} {a.mode === "ml" ? "relatos" : "grupos"} validados
                      {a.held_count ? ` · ${a.held_count} no sino` : ""}
                    </small>
                  </span>
                  <span className="pending-action">
                    Revisar <Icon name="arrow" size={16} />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {belled.length > 0 && (
        <section className="pending-section">
          <div className="section-heading">
            <div>
              <h2>
                Itens no sino <span className="count-pill">{belled.reduce((n, a) => n + a.held_count, 0)}</span>
              </h2>
              <p>Planilhas já liberadas com itens separados para decidir depois. Ao devolver, eles entram no dia certo dos gráficos.</p>
            </div>
          </div>
          <div className="pending-list">
            {belled.map((a) => (
              <button className="pending-item" key={a.id} onClick={() => navigate({ view: "quadro", id: a.id })}>
                <span className="pending-ring bell-ring">
                  <Icon name="bell" size={18} />
                </span>
                <span className="pending-name">
                  <b>{a.filename}</b>
                  <small>
                    {a.held_count} {a.held_count === 1 ? "item" : "itens"} no sino · {a.days.length > 1 ? `${dateLabel(a.days[0])} a ${dateLabel(a.days[a.days.length - 1])}` : a.days[0] ? dateLabel(a.days[0]) : ""}
                  </small>
                </span>
                <span className="pending-action">
                  Abrir sino <Icon name="arrow" size={16} />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="analyses-section">
        <div className="section-heading">
          <div>
            <h2>
              Biblioteca de análises{" "}
              <span className="count-pill">{daily.length}</span>
            </h2>
            <p>Uma pasta para cada dia da base reduzida e validada.</p>
          </div>
        </div>
        <div className="home-filters">
          <label className="search-box chip">
            <Icon name="search" size={16} />
            <input
              aria-label="Buscar análises"
              placeholder="Buscar por nome ou data…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Period
            label="Data"
            from={range.from}
            to={range.to}
            onChange={setRange}
          />
          <label className="sort-control chip">
            <Icon name="calendar" size={15} />
            <select
              aria-label="Ordenar análises"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="desc">Mais recentes</option>
              <option value="asc">Mais antigas</option>
            </select>
          </label>
          {filtered && (
            <button
              className="text-btn clear-btn"
              onClick={() => {
                setRange({ from: "", to: "" });
                setSearch("");
              }}
            >
              <Icon name="close" size={14} />
              Limpar
            </button>
          )}
        </div>
        {daily.length ? (
          <div className="folder-groups">
            {showToday && (
              <section className="folder-group">
                <h3>Hoje</h3>
                <p className="folder-group-empty">Nenhuma análise feita hoje</p>
              </section>
            )}
            {groups.map((group) => (
              <section className="folder-group" key={group.label}>
                <h3>
                  {group.label}
                  <span>{group.items.length}</span>
                </h3>
                <div className="folder-grid">
                  {group.items.map((day) => (
                    <Folder
                      key={`${day.analysis.id}-${day.date}`}
                      day={day}
                      index={folderIndex++}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <Empty
            title={
              analyses.length
                ? "Nenhuma análise disponível neste filtro"
                : "Seu próximo insight começa aqui"
            }
            text={
              analyses.length
                ? "Conclua uma revisão ou ajuste a busca e o período para encontrar suas análises."
                : "Importe sua primeira planilha. Os relatórios de cada dia aparecerão aqui após a validação."
            }
            action={
              !analyses.length ? (
                <button
                  className="btn primary"
                  onClick={() => navigate({ view: "importar" })}
                >
                  <Icon name="plus" size={17} />
                  Importar primeira planilha
                </button>
              ) : undefined
            }
          />
        )}
      </section>
      <div className="home-bottom-note">
        <Icon name="shield" size={16} />
        <span>
          Histórico preservado. As análises são organizadas pela data dos
          apontamentos da planilha.
        </span>
      </div>
    </>
  );
}

export default function Page() {
  const [route, setRoute] = useState<Route>({ view: "inicio" });
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState(false);
  useFizzOnActions();
  const load = useCallback(() => {
    void api<Analysis[]>("/analyses")
      .then((a) => {
        setAnalyses(a);
        setLoaded(true);
        setError("");
      })
      .catch((e) => {
        setError(e.message);
        setLoaded(true);
      });
  }, []);
  useEffect(() => {
    const change = () => {
      setRoute(readRoute());
      setMobile(false);
      window.scrollTo({ top: 0 });
    };
    change();
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    let active = true;
    api<Analysis[]>("/analyses")
      .then((a) => {
        if (active) {
          setAnalyses(a);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobile(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobile]);
  const analysis = analyses.find((a) => a.id === route.id);
  const title = {
    inicio: "Início",
    importar: "Importar planilha",
    quadro: "Validação de agrupamentos",
    analise: "Dashboard",
    comparar: "Comparar períodos",
    gerar: "Gerar planilha de apontamentos",
    fluxo: "Nova análise",
    desempenho: "Desempenho da ML",
  }[route.view];
  return (
    <div className="app-shell">
      <Splash />
      {mobile && (
        <button
          className="sidebar-scrim"
          aria-label="Fechar menu"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        className={`sidebar ${mobile ? "open" : ""}`}
        aria-label="Navegação principal"
      >
        <a href="#inicio" className="brand" onClick={() => setMobile(false)} aria-label="Gargalo, início">
          <span className="brand-mark">
            <GargaloMark size={58} />
          </span>
          <span className="brand-text">
            <span className="brand-word">gargalo</span>
            <small>Radar de Confiabilidade</small>
          </span>
        </a>
        <button
          className={`import-nav ${route.view === "importar" ? "active" : ""}`}
          onClick={() => navigate({ view: "importar" })}
        >
          <span className="nav-plus" aria-hidden="true">
            <Icon name="plus" size={18} />
          </span>
          Importar planilha
        </button>
        <nav aria-label="Seções">
          {(
            [
              ["inicio", "home", "Início"],
              ["comparar", "compare", "Comparar períodos"],
              ["desempenho", "brain", "Desempenho da ML"],
            ] as const
          ).map(([view, icon, label]) => {
            const on = route.view === view || (view === "inicio" && (route.view === "quadro" || route.view === "analise"));
            return (
              <button
                key={view}
                className={`nav-link ${on ? "active" : ""}`}
                onClick={() => navigate({ view })}
                aria-current={on ? "page" : undefined}
              >
                <Icon name={icon} size={19} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <Ribbon className="sidebar-ribbon" />
          <div className="sidebar-footer">
            <b>Coca-Cola FEMSA Brasil</b>
            <span>Manutenção e Confiabilidade</span>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-btn mobile-toggle"
              aria-label="Abrir menu"
              aria-expanded={mobile}
              onClick={() => setMobile(!mobile)}
            >
              <Icon name="menu" />
            </button>
            <GargaloMark size={30} className="topbar-logo" />
            <div className="topbar-title">
              <span className="breadcrumb-root">Área de trabalho</span>
              <b>{title}</b>
            </div>
          </div>
          <div className="topbar-right">
            <span className={`connection-status ${error ? "offline" : ""}`}>
              <i />
              {error
                ? "API indisponível"
                : loaded
                  ? "Dados sincronizados"
                  : "Conectando…"}
            </span>
            <span className="profile-mark" title="Radar de Confiabilidade">
              RC
            </span>
          </div>
        </header>
        <main
          className={`page-content ${route.view === "quadro" ? "board-content" : ""}`}
        >
          <ErrorNotice message={error} retry={load} />
          {!loaded && route.view !== "importar" && route.view !== "gerar" && route.view !== "fluxo" && route.view !== "desempenho" ? (
            <Loading />
          ) : (
            <>
              {route.view === "inicio" && <Home analyses={analyses} />}
              {route.view === "importar" && <Importer onUpdate={load} />}
              {route.view === "gerar" && <MlFill />}
              {route.view === "desempenho" && <Desempenho />}
              {route.view === "fluxo" && (
                <Pipeline key={route.id || "novo"} id={route.id} step={route.step} analyses={analyses} onUpdate={load} />
              )}
              {route.view === "quadro" && route.id && (
                <Kanban key={route.id} id={route.id} onUpdate={load} />
              )}
              {route.view === "analise" &&
                (analysis ? (
                  <Dashboard
                    key={`${analysis.id}-${route.day}`}
                    analysis={analysis}
                    day={route.day}
                  />
                ) : (
                  <Empty
                    title="Análise não encontrada"
                    text="Volte ao início e selecione uma análise existente."
                    action={
                      <button
                        className="btn secondary"
                        onClick={() => navigate({ view: "inicio" })}
                      >
                        Voltar ao início
                      </button>
                    }
                  />
                ))}
              {route.view === "comparar" && (
                <Compare
                  key={loaded ? "loaded" : "loading"}
                  analyses={analyses}
                />
              )}
              {route.view === "quadro" && !route.id && (
                <Empty
                  title="Selecione uma análise"
                  text="Abra uma revisão no início ou importe uma nova planilha."
                  action={
                    <button
                      className="btn primary"
                      onClick={() => navigate({ view: "inicio" })}
                    >
                      Ir para o início
                    </button>
                  }
                />
              )}
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>Gargalo · Radar de Confiabilidade</span>
          <span>Organizar. Validar. Entender.</span>
        </footer>
      </div>
    </div>
  );
}
