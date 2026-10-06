# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

"Gargalo — Radar de Confiabilidade": a Flask/Python API plus a Next.js static frontend for importing SAP downtime spreadsheets (Coca-Cola FEMSA / KOFBR), grouping and classifying failure reports, human validation on a kanban board, and Pareto / Jack-Knife analytics. All user-facing text, identifiers in comments, and docs are in Portuguese (pt-BR); keep files UTF-8.

## Commands

```bash
# Backend (Python 3.10+)
python -m pip install -r requirements.txt
python run.py                 # Waitress on 127.0.0.1:5000, serves frontend/out + API, opens browser (KOFBR_NO_BROWSER=1 to skip)
python app.py                 # Flask dev server (FLASK_DEBUG=1 for debug)
iniciar.bat                   # Windows: creates .venv, installs deps, runs run.py

# Tests (pytest is not in requirements.txt — install it separately)
python -m pytest tests
python -m pytest tests/test_workflow.py::test_confidence_memory_and_safe_batch

# Quick syntax check (from .github/copilot-instructions.md)
python -m py_compile app.py db.py parsing.py dedup.py routes/*.py workflow/*.py

# Frontend (only needed when changing the UI)
cd frontend && npm ci
npm run dev                   # :3000; radar.ts apiUrl() auto-targets :5000 when on port 3000 (or set NEXT_PUBLIC_API_URL)
npm run build                 # static export to frontend/out (served by Flask; run.py refuses to start without it)
npm run lint
```

The frontend uses Next.js 16 / React 19 / Tailwind 4 — see `frontend/AGENTS.md`: APIs may differ from training data; consult `frontend/node_modules/next/dist/docs/` before writing Next code.

## Architecture

There are two coexisting backends registered in `app.py`:

1. **Current flow — `workflow/` package, routes under `/api/workspace/*`.** This is what the frontend uses.
   - `store.py`: persistence. SQLite by default at `data/radar.sqlite3` (`KOFBR_DATA_DIR` overrides the dir); MySQL when `KOFBR_WORKFLOW_DB=mysql` (via `db.get_conn`). Only two tables: `radar_analyses` (each analysis is a whole JSON **document** + original file blob, deduped by `content_hash`) and `radar_settings` (catalog, correction memory, etc. as JSON).
   - Optimistic concurrency: every doc has a `revision`. `POST /analyses/<id>/actions` takes `{action, revision, ...}`, returns 409 on mismatch; `store.save` updates `WHERE revision = expected`.
   - `service.mutate(doc, body)` is the single dispatcher for all board actions (`validate_card`, `validate_column`, `validate_all`, `validate_confident`, `set_class`, `move`, `hold`, `split_card`, `add_column`, ...). It works on a deepcopy and appends history. `service.board(doc)` builds the response shape the UI renders. `service.compute/compare/select_records` do Pareto/Jack-Knife/compare math.
   - `importer.py`: parses XLSX/XLSM/CSV (header detected in first 30 rows; reuses `COLUMN_ALIASES` from top-level `parsing.py`), validates, and groups records into columns/cards by context (unit, line, equipment, stop type, subkey, system) + normalized description similarity.
   - `classify.py`: rule/term catalog that maps each report text to a standardized failure class ("FALHA DE ROLAMENTO", "SEM MODO DE FALHA IDENTIFICADO", ...). The component cited determines the class. Analyst corrections go into a "memory" keyed by `memory_key(text)`.
   - `learning.py`: local scikit-learn model (TF-IDF word + char n-grams + machine, logistic regression) trained from finished sheets + memory + `sheet_examples` (classes with a single example are dropped when there are 200+ rows); saved to `data/aprendizado.joblib`; retrained in a background thread ~20 s after learning actions (`LEARNING_ACTIONS` in `routes.py`). Tests monkeypatch `retrain_in_background` and call training explicitly.
   - `apontamentos_ml.py` (routes `/api/workspace/ml/*`, UI `components/ml-fill.tsx`, sidebar "Gerar Planilha de Apontamentos"): separate model that fills the `Classificação Manual Analista` column of an uploaded SAP sheet. Trains from the spreadsheets in `planilhas modelo/plhanilha treinamento de ml` (override with `KOFBR_ML_TRAIN_DIR`) plus analyst reviews (`radar_ml_examples` table, weight 3, always in train). `prepare()` cleans data (missing, junk, no-info labels, near-duplicate labels merged, duplicates → weights, conflicts → majority) so each relato appears once — the 80/20 split therefore has no train/test leakage; don't reintroduce row-level duplicates. Target is the standardized catalog class (free-text label mapped via `classify.classify`, recurring unmapped labels become own classes); a nearest-neighbour `DetailIndex` suggests the analyst's free-text detail. Outputs + per-relato review state in `data/ml_saidas/<id>.xlsx|.json`; reviews are applied to the xlsx lazily on download (`dirty` flag) and trigger `retrain_soon()`.
   - `exports.py` / `xlsx_export.py`: PNG/PDF and the SAP-layout summarized Excel.
   - Learning happens on **finish** (`POST /analyses/<id>/finish`): `service.finish_learning` measures the sheet's hit rate (class suggested on arrival — `card.suggested`, snapshotted at import — vs. the analyst's final class), sets `finished_at`, retrains `learning.py` on finished sheets only (`service.finished`) + correction memory, and appends to setting `learning_sheets` (per-sheet curve shown in the board's ML panel).
   - **Exports por observação** (`resumo.py`): `GET /analyses/<id>/resumo.xlsx` (one row per unique observation, grouped by `memory_key`) from the dashboard "Exportar Excel" menu. The former upload screen "Classificar planilha" was removed; `sheet_examples` saved by it still feed training (`learning.examples(extra=)`).
   - **Jack-Knife cuts** (`service.jack_cuts`, also legacy `analytics.py`/`routes/dashboard.py`, manual builder default): standard Knights method as in the project PDF example — Q cut = ΣQ / n items, MTTR cut = ΣT / ΣQ (NOT medians). Verified by `test_pareto_and_jackknife_match_hand_calculation`.
   - **Desempenho da ML** (sidebar, `components/desempenho.tsx`, `GET /learning` + `POST /learning/train`): per finished sheet hit-rate curve/table, model blind-test accuracy history, memory size. The board's ML panel only shows the number (no link).
   - **Planilha completa com Classificação** (`resumo.write_full`; `GET /analyses/<id>/completa` = dashboard "Exportar Excel" main option): reopens the ORIGINAL uploaded workbook (stored blob, `keep_vba` for .xlsm) and writes column "Classificação" after the last header column (never inserts — formulas/filters keep their letters; fills an existing empty "Classificação…" column instead). Rows are located by `record.source_sheet/source_row`; fill colour = validated/alta green, média yellow, SEM MODO/blank red.
   - **Undo/redo + merge**: `mutate` pushes the previous `cards/columns/layout` onto `doc['undo']` (max 15) for every action and clears `redo`; actions `undo`/`redo` swap states (`_history_step`) and the route re-syncs the correction memory. `merge_cards` (card dropped ON another card, UI asks for confirmation) only within the same machine column; the target keeps its class. UI: Ctrl+Z / Ctrl+Y.
   - Returning a card to its ORIGINAL class (`service.original_class` = `card.suggested`, or auto class ignoring this card's own memory) clears `failure_class` (`_set_label`), so it gets its original confidence colour back instead of "manual" blue; `learn()` then restores/forgets the memory entry.
   - Board UI: only the "Por falha" view (machine view removed from the UI; backend `move`/columns kept). Bell is a drawer (`components/bell.tsx`, portal to body); home lists finished sheets with held items.
   - **Model vs catalog** (`learning.refine`): once the model has ≥ `MATURE` (200) examples and ≥ `MODEL_WINS` (0.6) certainty, it overrides the catalog class (blind test, 1,020 Marília relatos in the descritivo standard: catalog 75%, old logic 78%, this rule 87%). Memory still wins over both.
   - **Training folder for the board model** (`service.folder_examples`): analyst-classified sheets in `planilhas modelo/plhanilha treinamento de ml` (or `KOFBR_ML_TRAIN_DIR`) are read with `apontamentos_ml.read_folder/prepare` (labels standardized to the catalog), cached by file name/size/mtime, and fed to `training_rows`.
   - **Performance invariants**: `mutate` uses `_working_copy` (deep-copies only cards/columns/layout; `records` are SHARED and must never be mutated by an action) and the undo snapshot references the untouched original; `classify.classifier_for` short-circuits on the same catalog object; `importer.group_records` computes a dense similarity matrix per context bucket (≤ 4000 distinct texts). 15k rows: import ~36 s, action ~2 s.
   - Dashboard/Compare open on P.EQ.LINHA and, with more than one unit, on `options()['main_unit']` (descritivo 3.3).
   - Once a card is validated its class is frozen (`_freeze_classes`); catalog/model changes only affect unvalidated cards.
   - Counting: by default Q counts **real failures** (`service.event_map`: same O.S. number on same machine = 1 event; else adjacent hourly SAP slices with same text) — `count=events` vs `count=lines` in API args.

   - **Fluxo único** (`pipeline.py`, routes `/api/workspace/pipeline/*`, UI `components/pipeline.tsx`, sidebar "Nova análise", hash `#fluxo/<id>?passo=N`): upload → background job (tolerant `importer.parse_file(strict=False, keep_original=False)`, ML prediction, prediction columns written into the uploaded workbook) → per-relato validation (Correta/Errada) → `summarize()` groups by failure into `radar_failure_summary` → existing Dashboard. Documents have `mode: 'ml'`, no cards; per-relato state lives in table `radar_ml_items`, not in the document (the full SAP sheet is ~94k rows / 51k unique relatos — never rewrite the document on validation). `service.ready/summary/reduced_records` branch on `mode == 'ml'`; `store.get/all_documents` cache ML docs by revision.
2. **Legacy flow — `routes/*.py`, `db.py`, `dedup.py`, `ddl_kofbr_v2.sql`, `templates/`.** MySQL-only (PyMySQL), kept for compatibility (`/api/upload`, `/api/clusters`, `/api/records`, `/api/dashboard/*`). App queries use `?`; `db.py` translates to `%s`. `migrate_history.py` copies legacy MySQL analyses into the new store.

Frontend (`frontend/src`): single-page app in `app/page.tsx`; visual layer `app/ultimate.css` is imported LAST and redefines the tokens (Coke red `--coke`, ice surfaces, `--display` font) — put new global styling there; brand assets/splash in `components/brand.tsx`; `Heading` turns "0N / …" eyebrows into the `Steps` trail; `lib/radar.ts` holds types and the `/api/workspace` fetch wrapper; large components in `components/` (`kanban.tsx` board, `analysis.tsx` dashboard/compare, `charts.tsx`, `manual.tsx` manual chart builder whose edits live in localStorage only).

## Business rules to preserve

- Grouping/similarity only **proposes**; human validation is mandatory. Never group records missing line/equipment, and never mix contexts (unit, line, equipment, stop type, subkey, system).
- Server re-checks every UI gate: "Confirmar todos" requires the confirmation text `CONFIRMAR`; finishing requires all cards OUTSIDE the review bell validated. Held cards (bell) do NOT block finishing (changed by request): they stay out of `reduced_records`/charts until released (`release` action, optional `failure_class` + `validate`), then count on their own record dates. `hold` stores `held_at`/`held_note`.
- Imports are all-or-nothing (invalid files write nothing); identical content is detected even if renamed/reordered.
- UI must wait for the HTTP response (`response.ok`) and reload from the API rather than optimistically removing cards.
- Write routes must commit, roll back on exception, and close the connection (`store.connection()` does this).
- When changing grouping/classification rules, add test cases covering: same failure same context, same description different context, and similar phrases with different causes. The project-spec examples are in `tests/test_workflow.py::test_failure_classification_matches_project_document`.
