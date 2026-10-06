"use client";
/* Identidade Gargalo: o símbolo (abridor + gargalo), o nome em letra cursiva, a onda e a abertura. */
import { useEffect, useId, useRef, useState } from "react";

const MARK_VIEWBOX = "0 0 1140 2184";
const MARK_PATH = "M518 2178C512 2178 499 2177 489 2176C463 2174 410 2166 396 2161C338 2141 322 2110 349 2068C356 2056 356 2052 345 2040C321 2015 321 1986 345 1960C358 1947 359 1944 355 1926C354 1921 352 1911 350 1904C346 1883 335 1851 326 1832C290 1761 290 1705 325 1630C340 1596 346 1570 352 1503C353 1497 354 1484 354 1476C355 1468 356 1455 357 1448C358 1441 358 1430 359 1424C360 1418 361 1405 362 1395C364 1376 365 1364 368 1324C368 1311 370 1296 370 1291C378 1222 374 1140 362 1094C360 1088 357 1076 354 1065C351 1054 349 1044 348 1042C347 1041 344 1030 340 1018C335 1006 328 989 323 978C318 966 311 953 308 946C306 940 300 929 296 922C292 914 287 904 285 898C279 886 270 868 262 852C219 770 216 763 226 764C234 764 271 797 296 826C303 835 312 845 315 849C319 854 326 862 330 869C334 875 339 883 341 886C354 903 391 982 397 1006C398 1008 400 1017 402 1025C422 1091 429 1171 422 1254C421 1261 421 1278 420 1292C420 1306 418 1323 418 1329C416 1340 415 1355 412 1390C411 1397 410 1406 410 1410C407 1434 413 1439 423 1422C427 1415 442 1377 446 1366C447 1361 449 1355 450 1352C453 1343 461 1317 463 1306C464 1301 466 1292 468 1288C469 1282 471 1272 472 1265C473 1258 475 1249 476 1247C486 1210 486 1106 476 1056C474 1050 472 1042 472 1038C470 1031 463 1008 459 996C442 949 434 932 417 902C385 845 321 781 250 736C205 707 185 689 177 671C170 656 162 639 158 629C146 603 141 593 134 580C131 572 126 563 125 560C124 556 118 544 113 532C108 521 100 503 95 493C90 483 86 472 84 470C82 467 79 460 77 454C75 449 72 443 70 440C68 437 66 432 55 406C53 402 44 384 37 368C14 321 14 320 8 291C6 279 5 234 7 221C18 139 69 60 130 33C134 31 139 28 142 26C152 20 179 11 196 8C221 5 920 5 944 8C962 11 989 20 999 26C1002 28 1008 31 1011 33C1072 60 1123 139 1134 221C1136 234 1135 279 1132 291C1127 320 1127 321 1104 368C1097 384 1088 402 1086 406C1075 432 1073 437 1071 440C1069 443 1066 449 1064 454C1062 460 1058 467 1057 470C1056 472 1050 483 1046 493C1042 503 1033 521 1028 532C1023 544 1017 556 1016 560C1015 563 1010 572 1007 580C1000 593 995 603 984 629C979 639 971 656 964 671C956 689 936 707 891 736C820 781 756 845 724 902C707 932 699 949 682 996C678 1008 671 1031 670 1038C669 1042 667 1050 666 1056C654 1106 654 1210 666 1247C666 1249 668 1258 669 1265C670 1272 672 1282 674 1288C675 1292 677 1301 678 1306C680 1317 688 1343 691 1352C692 1355 694 1361 696 1366C699 1377 714 1415 718 1422C728 1439 734 1434 731 1410C730 1406 730 1397 729 1390C726 1355 725 1340 723 1329C723 1323 722 1306 721 1292C720 1278 720 1261 719 1254C712 1171 719 1091 738 1025C741 1017 743 1008 744 1006C750 982 787 903 800 886C802 883 807 875 811 869C815 862 822 854 826 849C830 845 838 835 845 826C870 797 907 764 915 764C925 763 922 770 880 852C871 868 862 886 856 898C854 904 849 914 845 922C841 929 835 940 833 946C830 953 823 966 818 978C813 989 806 1006 802 1018C798 1030 794 1041 793 1042C792 1044 790 1054 787 1065C784 1076 781 1088 780 1094C767 1140 763 1222 771 1291C772 1296 773 1311 774 1324C776 1364 777 1376 779 1395C780 1405 781 1418 782 1424C782 1430 783 1441 784 1448C785 1455 786 1468 786 1476C787 1484 788 1497 789 1503C795 1570 801 1596 816 1630C851 1705 851 1761 816 1832C806 1851 795 1883 790 1904C789 1911 787 1921 786 1926C782 1944 783 1947 796 1960C820 1986 820 2015 796 2040C785 2052 785 2056 792 2068C819 2110 803 2141 746 2161C731 2166 678 2174 652 2176C643 2177 629 2178 622 2178C607 2179 532 2179 518 2178ZM624 2141C635 2139 650 2138 658 2137C725 2131 755 2118 747 2098C742 2086 709 2074 666 2069C622 2064 618 2064 570 2064C523 2064 519 2064 476 2069C410 2077 378 2097 399 2117C406 2123 439 2133 463 2135C468 2136 484 2137 498 2139C511 2140 525 2142 528 2142C542 2144 603 2143 624 2141ZM427 2031C441 2028 467 2024 478 2022C482 2022 491 2021 498 2020C511 2018 515 2018 570 2018C626 2018 630 2018 642 2020C650 2021 659 2022 662 2022C675 2024 701 2028 714 2031C739 2037 745 2035 752 2018C766 1989 743 1976 654 1963C615 1957 526 1957 486 1963C396 1976 374 1989 390 2020C398 2035 402 2037 427 2031ZM418 1907C433 1892 435 1857 426 1794C425 1787 424 1779 423 1775C423 1771 421 1759 418 1747C411 1711 408 1695 406 1682C404 1663 401 1638 399 1627C395 1600 393 1602 379 1647C377 1655 374 1665 372 1670C350 1725 352 1750 381 1830C391 1856 395 1870 397 1882C402 1909 408 1916 418 1907ZM736 1907C739 1904 740 1899 744 1882C746 1870 750 1856 760 1830C789 1750 791 1725 769 1670C767 1665 764 1655 762 1647C748 1602 746 1600 742 1627C740 1638 737 1663 734 1682C733 1695 730 1711 723 1747C720 1759 718 1771 718 1775C717 1779 716 1787 715 1794C709 1833 708 1868 711 1882C717 1904 728 1916 736 1907ZM387 660C391 657 394 650 397 633C401 613 411 586 417 576C426 564 431 563 454 569C469 573 484 575 516 578C524 579 543 580 570 580C598 580 617 579 626 578C657 575 672 573 688 569C710 563 715 564 724 576C730 585 740 614 744 632C750 666 753 667 801 658C859 647 871 637 893 584C907 548 916 529 920 520C922 515 926 506 929 499C932 492 936 483 938 479C940 474 944 466 947 459C952 447 955 440 965 418C967 412 972 399 976 390C987 363 989 359 993 351C995 347 997 342 998 341C998 340 1001 332 1005 323C1041 237 1001 144 916 118C855 99 806 110 753 154C720 181 694 196 666 204C661 206 654 208 649 210C611 224 530 224 492 210C487 208 480 206 475 204C447 196 421 181 388 154C349 121 320 110 275 110C226 110 183 131 151 170C120 210 114 270 136 323C140 332 143 340 144 341C144 342 146 347 148 351C152 359 154 363 164 390C168 399 174 412 176 418C186 440 190 447 194 459C197 466 201 474 203 479C205 483 209 492 212 499C215 506 219 515 221 520C225 529 234 548 248 584C270 637 282 647 340 658C369 664 382 664 387 660Z";

/** Símbolo do gargalo em vetor (fundo transparente). Assume a cor do texto (currentColor). */
export function GargaloMark({ size = 40, className = "", title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      className={`gargalo-mark ${className}`}
      viewBox={MARK_VIEWBOX}
      height={size}
      width={(size * 1140) / 2184}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path fill="currentColor" fillRule="evenodd" d={MARK_PATH} />
    </svg>
  );
}

/** Onda (fita dinâmica). Duas faixas periódicas que deslizam devagar, em velocidades diferentes. */
export function Ribbon({ className = "", still = false }: { className?: string; still?: boolean }) {
  // Período de 400 unidades: a faixa tem 800 de largura e desliza -400 em loop, sem emenda.
  const wave = (y: number, a: number) =>
    `M0 ${y} C 100 ${y - a}, 300 ${y + a}, 400 ${y} C 500 ${y - a}, 700 ${y + a}, 800 ${y} L800 140 L0 140 Z`;
  return (
    <svg className={`ribbon ${still ? "still" : ""} ${className}`} viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true">
      <g className="ribbon-back-g">
        <path className="ribbon-back" d={wave(62, 34)} />
      </g>
      <g className="ribbon-front-g">
        <path className="ribbon-front" d={wave(84, 26)} />
      </g>
    </svg>
  );
}

/** A garrafa enchendo: o símbolo do gargalo como recipiente, com o líquido subindo, a superfície
    ondulando e bolhas. Indicador de carregamento do sistema e peça central da abertura. */
export function BottleFill({
  size = 64,
  className = "",
  mode = "loop",
  tone = "light",
}: {
  size?: number;
  className?: string;
  /** loop = enche e esvazia (carregando) · once = enche uma vez e fica cheia (abertura) */
  mode?: "loop" | "once";
  /** light = vidro rosado e líquido vermelho (fundo claro) · cola = vidro branco e refrigerante (fundo vermelho) */
  tone?: "light" | "cola";
}) {
  const id = useId().replace(/:/g, "");
  const wave = "M0 60 C 190 0, 380 120, 570 60 C 760 0, 950 120, 1140 60 C 1330 0, 1520 120, 1710 60 C 1900 0, 2090 120, 2280 60 L2280 2400 L0 2400 Z";
  return (
    <svg
      className={`bottle bottle-${mode} bottle-${tone} ${className}`}
      viewBox={MARK_VIEWBOX}
      height={size}
      width={(size * 1140) / 2184}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`bf-${id}`}>
          <path fillRule="evenodd" clipRule="evenodd" d={MARK_PATH} />
        </clipPath>
      </defs>
      <path className="bottle-glass" fillRule="evenodd" d={MARK_PATH} />
      <g clipPath={`url(#bf-${id})`}>
        <g className="bottle-level">
          <path className="bottle-liquid back" d={wave} />
          <path className="bottle-liquid" d={wave} />
          {Array.from({ length: 9 }, (_, i) => (
            <circle key={i} className="bottle-bubble" cx={260 + ((i * 97) % 620)} cy={2150} r={22 + ((i * 7) % 4) * 10} style={{ "--i": i } as React.CSSProperties} />
          ))}
        </g>
      </g>
    </svg>
  );
}

/** Efervescência: bolhas saindo de um ponto da tela (resposta a uma ação — validar, finalizar, importar). */
export function fizz(x: number, y: number, count = 12, spread = 1) {
  if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const host = document.createElement("div");
  host.className = "fizz-burst";
  host.style.left = `${x}px`;
  host.style.top = `${y}px`;
  for (let i = 0; i < count; i++) {
    const b = document.createElement("i");
    const size = 4 + Math.random() * 9 * spread;
    b.style.setProperty("--dx", `${(Math.random() - 0.5) * 70 * spread}px`);
    b.style.setProperty("--dy", `${-(40 + Math.random() * 90) * spread}px`);
    b.style.setProperty("--s", `${size}px`);
    b.style.setProperty("--d", `${0.55 + Math.random() * 0.5}s`);
    b.style.setProperty("--w", `${Math.random() * 0.12}s`);
    host.appendChild(b);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 1400);
}

/** Bolhas no centro de um elemento. */
export function fizzAt(el: Element | null, count = 12, spread = 1) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  fizz(r.left + r.width / 2, r.top + r.height / 2, count, spread);
}

/** Tampinha estourando em um ponto (comemoração ao finalizar uma planilha). */
export function popCap(x: number, y: number) {
  if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 48 48");
  el.setAttribute("class", "cap-pop");
  el.innerHTML = `<path d="${CAP}"/><circle cx="24" cy="24" r="15.5"/>`;
  el.style.left = `${x - 26}px`;
  el.style.top = `${y - 26}px`;
  document.body.appendChild(el);
  fizz(x, y, 34, 1.8);
  setTimeout(() => el.remove(), 1500);
}

/** Bolhas automáticas nas ações principais do app (um único ouvinte para a página inteira). */
export function useFizzOnActions() {
  useEffect(() => {
    const SELECTOR =
      ".btn.primary, .kb-btn.primary, .bl-btn.primary, .import-nav, .kb-check:not(.on), .lg-btn, [data-fizz]";
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(SELECTOR);
      if (!el || (el as HTMLButtonElement).disabled) return;
      const small = el.classList.contains("kb-check");
      fizz(e.clientX || el.getBoundingClientRect().left, e.clientY || el.getBoundingClientRect().top, small ? 8 : 12, small ? 0.7 : 1);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}

/** Número que "enche" de 0 até o valor (formato pt-BR, com sufixo: "1.234", "96,8%", "361,7 h"). */
export function CountUp({ value, duration = 900 }: { value: string; duration?: number }) {
  const m = /^(-?[\d.]+)(?:,(\d+))?(.*)$/.exec(value.trim());
  const target = m ? Number(m[1].replace(/\./g, "") + (m[2] ? `.${m[2]}` : "")) : NaN;
  const decimals = m?.[2]?.length || 0;
  const fmt = (n: number) =>
    n.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + (m?.[3] || "");
  const animate = Boolean(m) && Number.isFinite(target);
  const [shown, setShown] = useState(() => (animate ? fmt(0) : value));
  const started = useRef(false);
  useEffect(() => {
    if (!animate || started.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      started.current = true;
      const raf = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(raf);
    }
    started.current = true;
    let frame = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      setShown(p < 1 ? fmt(target * (1 - Math.pow(1 - p, 3))) : value);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anima só na primeira vez; depois mostra o valor direto
  }, [value]);
  return <>{shown}</>;
}

/** Tampinha (coroa com 21 dentes). */
const CAP = (() => {
  const teeth = 21,
    pts: string[] = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (Math.PI * i) / teeth - Math.PI / 2,
      r = i % 2 ? 20.2 : 23.4;
    pts.push(`${(24 + r * Math.cos(a)).toFixed(2)},${(24 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
})();

const SEEN = "gargalo-splash";

/** Abertura (uma vez por sessão): a garrafa enche de refrigerante, a tampinha estoura com bolhas,
    o nome é escrito e a tela sobe com a onda branca. Clique ou tecla pulam; "reduzir movimento" desliga. */
export function Splash() {
  const [phase, setPhase] = useState<"off" | "on" | "out">("off");
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN) === "1";
      sessionStorage.setItem(SEEN, "1");
    } catch {}
    const unveil = () => document.documentElement.classList.remove("splash-pending");
    if (seen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      unveil();
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setPhase("on"), 0));
    timers.push(setTimeout(unveil, 300));
    timers.push(
      setTimeout(() => {
        const neck = stage.current?.querySelector(".splash-bottle");
        if (neck) {
          const r = neck.getBoundingClientRect();
          fizz(r.left + r.width / 2, r.top + 10, 26, 1.6);
        }
      }, 1250),
    );
    timers.push(setTimeout(() => setPhase("out"), 2700));
    timers.push(setTimeout(() => setPhase("off"), 3500));
    const skip = () => {
      setPhase("out");
      timers.push(setTimeout(() => setPhase("off"), 750));
    };
    window.addEventListener("keydown", skip, { once: true });
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("keydown", skip);
    };
  }, []);
  if (phase === "off") return null;
  return (
    <div
      className={`splash ${phase === "out" ? "out" : ""}`}
      onClick={() => {
        setPhase("out");
        setTimeout(() => setPhase("off"), 750);
      }}
      aria-hidden="true"
    >
      <span className="splash-bubbles">
        {Array.from({ length: 18 }, (_, i) => (
          <i key={i} style={{ "--i": i } as React.CSSProperties} />
        ))}
      </span>
      <div className="splash-stage" ref={stage}>
        <svg className="splash-cap" viewBox="0 0 48 48">
          <path d={CAP} />
          <circle cx="24" cy="24" r="15.5" />
        </svg>
        <BottleFill size={210} mode="once" tone="cola" className="splash-bottle" />
        <span className="splash-word">gargalo</span>
        <span className="splash-sub">Radar de Confiabilidade</span>
      </div>
      <Ribbon className="splash-ribbon" />
    </div>
  );
}
