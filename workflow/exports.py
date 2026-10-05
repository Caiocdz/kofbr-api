"""Exportações PNG/PDF no formato do descritivo do projeto (itens 2 e 3)."""
import io
import threading
from datetime import date

import matplotlib
matplotlib.use('Agg')
from matplotlib.figure import Figure
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.ticker import FuncFormatter

COLORS = {'Crítico-crônico': '#e0101f', 'Crítico': '#e89a1c', 'Crônico': '#3a67c4', 'Conforto': '#1f8a63'}
_LOCK = threading.Lock()


def _br(value):
    try:
        return date.fromisoformat(value).strftime('%d/%m/%Y')
    except (TypeError, ValueError):
        return value or ''


def period_label(start, end):
    if not start:
        return 'todo o período'
    return _br(start) if start == end else f'{_br(start)} - {_br(end)}'


def render_chart(data, kind, fmt, context):
    """context: {'start', 'end', 'line', 'unit', 'machine', 'failure'} vindos do filtro."""
    if isinstance(context, str):  # compatibilidade
        context = {}
    period = period_label(context.get('start'), context.get('end'))
    scope = ' · '.join(v for v in (context.get('line') or 'Todas as linhas', context.get('machine'), context.get('unit')) if v)
    with _LOCK:
        fig = Figure(figsize=(13, 7), layout='constrained', facecolor='#ffffff')
        FigureCanvasAgg(fig)
        ax = fig.subplots()
        machines = data['machines']
        ax.spines[['top', 'right']].set_visible(False)
        if kind == 'pareto':
            fig.suptitle(f'PARETO DE FALHAS ({period})\n{scope}', fontsize=13, fontweight='bold', color='#b80d19')
            width = max(13, min(36, len(machines) * 0.75))
            fig.set_size_inches(width, 7.5)
            xs = range(len(machines))
            bars = ax.bar(xs, [m['minutes'] for m in machines], color='#e0101f', width=0.62)
            for x, m, bar in zip(xs, machines, bars):
                ax.annotate(f"Tempo: {m['minutes']:.1f}".replace('.', ','), (x, bar.get_height()), xytext=(0, 4),
                            textcoords='offset points', ha='center', fontsize=7,
                            bbox=dict(boxstyle='round,pad=0.2', fc='white', ec='#cccccc'))
                ax.annotate(f"Falhas: {m['count']}", (x, 0), xytext=(0, 6), textcoords='offset points', ha='center',
                            fontsize=7, color='white', fontweight='bold',
                            bbox=dict(boxstyle='round,pad=0.2', fc='#141313', ec='none'))
            ax.set_xticks(list(xs), [m.get('short') or m['name'] for m in machines], rotation=35, ha='right', fontsize=8)
            ax.set_ylabel('Tempo de parada (min)')
            ax.set_xlabel('Linha / equipamento')
            second = ax.twinx()
            second.plot(list(xs), [m['cumulative'] for m in machines], color='#141313', marker='o', markersize=4)
            for x, m in zip(xs, machines):
                second.annotate(f"{m['cumulative']:.1f}%".replace('.', ','), (x, m['cumulative']), xytext=(0, 7),
                                textcoords='offset points', ha='center', fontsize=7,
                                bbox=dict(boxstyle='round,pad=0.15', fc='white', ec='#cccccc'))
            second.axhline(80, color='#e0101f', linestyle='--', linewidth=1, alpha=0.6)
            second.set_ylim(0, 112)
            second.set_ylabel('% acumulado')
            second.spines[['top']].set_visible(False)
        else:
            fig.suptitle(f'{scope} - {period}', fontsize=13, fontweight='bold')
            ax.set_xscale('log')
            ax.set_yscale('log')
            plain = FuncFormatter(lambda v, _: f'{v:g}'.replace('.', ','))
            ax.xaxis.set_major_formatter(plain)
            ax.yaxis.set_major_formatter(plain)
            ax.set_xlabel('Nº de falhas')
            ax.set_ylabel('MTTR (min)')
            q, t = data['q_threshold'], data['mttr_threshold']
            ax.axvline(q, color='#2a2828', linewidth=1.2)
            ax.axhline(t, color='#2a2828', linewidth=1.2)
            for i, m in enumerate(machines, 1):
                ax.scatter([m['count']], [max(m['mttr'], 0.1)], s=260, color=COLORS[m['category']], edgecolors='white', zorder=3)
                ax.annotate(str(i), (m['count'], max(m['mttr'], 0.1)), ha='center', va='center', fontsize=7,
                            color='white', fontweight='bold', zorder=4)
            counts = [m['count'] for m in machines] + [q]
            mttrs = [max(m['mttr'], 0.1) for m in machines] + [t]
            ax.set_xlim(min(counts) * 0.5, max(counts) * 2.2)
            ax.set_ylim(min(mttrs) * 0.5, max(mttrs) * 2.2)
            for text, x, y, ha, va, color in (('CRÍTICO', 0.01, 0.99, 'left', 'top', '#c27a12'),
                                              ('CRÍTICO-CRÔNICO', 0.99, 0.99, 'right', 'top', '#b80d19'),
                                              ('CONFORTO', 0.01, 0.01, 'left', 'bottom', '#1f8a63'),
                                              ('CRÔNICO', 0.99, 0.01, 'right', 'bottom', '#3a67c4')):
                ax.text(x, y, text, transform=ax.transAxes, ha=ha, va=va, fontsize=9, fontweight='bold', color=color)
            ax.annotate(f'{q:g}'.replace('.', ','), (q, 1), xycoords=('data', 'axes fraction'), ha='center', va='bottom',
                        fontsize=8, color='#e0101f', bbox=dict(boxstyle='round,pad=0.2', fc='white', ec='#e0101f'))
            ax.annotate(f'{t:.1f}'.replace('.', ','), (1, t), xycoords=('axes fraction', 'data'), ha='left', va='center',
                        fontsize=8, color='#e0101f', bbox=dict(boxstyle='round,pad=0.2', fc='white', ec='#e0101f'))
            legend = [f"{i}. {m.get('short') or m['name']}" for i, m in enumerate(machines[:40], 1)]
            fig.text(1.0, 0.5, '\n'.join(legend), fontsize=6.5, va='center', ha='left', family='monospace')
        fig.text(0.01, 0.001, 'Fonte: apontamentos validados. Cortes do crítico-crônico: Q médio e MTTR do conjunto filtrado (tempo total ÷ falhas).',
                 fontsize=8, color='#657084')
        result = io.BytesIO()
        fig.savefig(result, format=fmt, dpi=160, bbox_inches='tight')
        result.seek(0)
        return result
