import io
from pathlib import Path
from flask import Blueprint, jsonify, request, send_file
from werkzeug.exceptions import HTTPException
from . import store, importer, service

bp = Blueprint('workspace', __name__, url_prefix='/api/workspace')


def document(analysis_id):
    doc = store.get(analysis_id)
    if not doc:
        from werkzeug.exceptions import NotFound
        raise NotFound('Análise não encontrada.')
    return doc


@bp.errorhandler(ValueError)
def invalid(error):
    return jsonify(erro=str(error)), 400


@bp.route('/analyses', methods=['GET'])
def listing():
    return jsonify([service.summary(d) for d in store.all_documents()])


@bp.route('/import', methods=['POST'])
def upload():
    file = request.files.get('file')
    if not file or not file.filename:
        raise ValueError('Selecione uma planilha.')
    filename = Path(file.filename.replace('\\', '/')).name
    if not filename.lower().endswith(('.xlsx', '.xlsm', '.csv')):
        raise ValueError('Envie um arquivo .xlsx, .xlsm ou .csv.')
    data = file.read()
    try:
        records, warnings = importer.parse_file(data, filename)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError('Não foi possível ler o arquivo. Confira se é uma planilha válida, sem senha.') from exc
    fingerprint = importer.content_hash(records)
    # Evita repetir agrupamentos custosos se o conteúdo já foi importado.
    with store.connection() as conn:
        previous = conn.execute('SELECT id FROM radar_analyses WHERE content_hash = ?', (fingerprint,)).fetchone()
    if previous:
        return jsonify(erro='Esta planilha já está no histórico.', existing_id=previous['id']), 409
    doc = service.snapshot_suggestions(importer.new_document(records, filename, warnings))
    analysis_id, inserted = store.insert(doc, fingerprint, data)
    if not inserted:
        return jsonify(erro='Esta planilha já está no histórico.', existing_id=analysis_id), 409
    return jsonify(service.board(doc)), 201


@bp.route('/analyses/<analysis_id>')
def detail(analysis_id):
    return jsonify(service.board(document(analysis_id)))


@bp.route('/analyses/<analysis_id>/cards/<card_id>')
def card_detail(analysis_id, card_id):
    doc = document(analysis_id)
    card = next((c for c in doc['cards'] if c['id'] == card_id), None)
    if not card:
        raise ValueError('Card não encontrado.')
    ids = set(card['record_ids'])
    rows = [r for r in doc['records'] if r['id'] in ids]
    try:
        page = max(1, int(request.args.get('page', 1)))
    except ValueError:
        raise ValueError('Página inválida.')
    return jsonify(card=card, total=len(rows), page=page, records=rows[(page-1)*100:page*100])


@bp.route('/analyses/<analysis_id>/actions', methods=['POST'])
def action(analysis_id):
    doc = document(analysis_id)
    body = request.get_json(silent=True) or {}
    if body.get('revision') != doc['revision']:
        return jsonify(erro='A análise mudou em outra aba. Atualize o quadro e tente novamente.'), 409
    updated = service.mutate(doc, body)
    if not store.save(updated, doc['revision']):
        return jsonify(erro='Outra alteração foi salva. Atualize o quadro antes de continuar.'), 409
    if body.get('action') == 'set_class':
        previous = {c['id']: c.get('failure_class') for c in doc['cards']}
        service.learn(updated, {body.get('card_id')}, previous)
    elif body.get('action') == 'set_classes':
        service.learn(updated, {str((i or {}).get('card_id')) for i in body.get('items') or []})
    elif body.get('action') in ('undo', 'redo'):
        # A memória de correções acompanha o desfazer: o que voltou ao automático é esquecido.
        previous = {c['id']: c.get('failure_class') for c in doc['cards']}
        now = {c['id']: c.get('failure_class') for c in updated['cards']}
        changed = {i for i in now if now[i] != previous.get(i)}
        if changed:
            service.learn(updated, changed, previous)
    if body.get('action') in LEARNING_ACTIONS:
        # O modelo aprende com cada validação/correção, em segundo plano.
        from . import learning
        learning.retrain_in_background(service.training_rows)
    return jsonify(service.board(updated))


LEARNING_ACTIONS = {'set_class', 'set_classes', 'merge_cards', 'undo', 'redo', 'validate_card', 'validate_column', 'validate_all',
                    'validate_confident', 'validate_cards', 'move'}


@bp.route('/learning', methods=['GET'])
def learning_status():
    from . import learning
    return jsonify(learning.info() | {'training': learning._state['training']})


@bp.route('/learning/train', methods=['POST'])
def learning_train():
    from . import learning
    return jsonify(learning.train(service.training_rows(), force=True) | {'training': False})


@bp.route('/memory', methods=['GET'])
def get_memory():
    mem = service.memory()
    items = sorted(({'text': k, **v} for k, v in mem.items()), key=lambda x: x.get('at', ''), reverse=True)
    return jsonify(total=len(items), items=items[:500])


@bp.route('/memory', methods=['DELETE'])
def forget_memory():
    text = request.args.get('text')
    mem = service.memory()
    if text:
        mem.pop(text, None)
        store.set_setting('class_memory', mem)
    else:
        store.delete_setting('class_memory')
    return jsonify(total=len(mem) if text else 0)


@bp.route('/analyses/<analysis_id>/finish', methods=['POST'])
def finish(analysis_id):
    doc = document(analysis_id)
    if not service.ready(doc):
        return jsonify(erro='Valide todos os cards e resolva os itens do sino antes de avançar.'), 409
    if doc.get('mode') == 'ml':
        return jsonify(ready=True)
    # Finalizar = a ML aprende com esta planilha (treino na hora) e mede quanto acertou nela.
    return jsonify(ready=True, learning=service.finish_learning(doc))


@bp.route('/resumo', methods=['POST'])
def resumo_upload():
    """Planilha solta na tela "Planilha resumida": agrupa as observações e preenche a classificação."""
    from . import resumo
    file = request.files.get('file')
    if not file or not file.filename:
        raise ValueError('Selecione uma planilha.')
    filename = Path(file.filename.replace('\\', '/')).name
    if not filename.lower().endswith(('.xlsx', '.xlsm', '.csv')):
        raise ValueError('Envie um arquivo .xlsx, .xlsm ou .csv.')
    return jsonify(resumo.from_upload(file.read(), filename))


@bp.route('/resumo/<file_id>.xlsx')
def resumo_download(file_id):
    from . import resumo
    path, name = resumo.output(file_id)
    return send_file(path, as_attachment=True, download_name=name,
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


@bp.route('/resumo/<file_id>/completa')
def resumo_full_download(file_id):
    from . import resumo
    path, name = resumo.output(file_id, full=True)
    return send_file(path, as_attachment=True, download_name=name)


@bp.route('/analyses/<analysis_id>/completa')
def analysis_full(analysis_id):
    """A planilha que foi importada, inteira, com a coluna Classificação que saiu do quadro."""
    from . import resumo
    doc = document(analysis_id)
    if doc.get('mode') == 'ml':
        raise ValueError('Para análises do fluxo único, baixe a planilha classificada pelo próprio fluxo.')
    data, name = resumo.full_from_analysis(doc, store.source(analysis_id))
    mime = ('application/vnd.ms-excel.sheet.macroEnabled.12' if name.endswith('.xlsm')
            else 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    return send_file(io.BytesIO(data), as_attachment=True, download_name=name, mimetype=mime)


@bp.route('/analyses/<analysis_id>/resumo.xlsx')
def analysis_resumo(analysis_id):
    from . import resumo
    doc = document(analysis_id)
    if doc.get('mode') == 'ml':
        raise ValueError('A planilha resumida por observação está disponível para análises do quadro.')
    data, name = resumo.from_analysis(doc)
    return send_file(io.BytesIO(data), as_attachment=True, download_name=name,
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


@bp.route('/analyses/<analysis_id>/source')
def download_source(analysis_id):
    doc = document(analysis_id)
    source = store.source(analysis_id)
    if not source:
        raise ValueError('O arquivo original desta importação antiga não está disponível.')
    return send_file(io.BytesIO(source), as_attachment=True, download_name=doc['filename'])


def _validate_catalog(body):
    from .classify import Classifier
    if not isinstance(body, dict) or not isinstance(body.get('classes'), list):
        raise ValueError('Catálogo inválido.')
    clean = []
    for item in body['classes'][:400]:
        label = str(item.get('label') or '').strip().upper()[:120]
        kind = item.get('kind') if item.get('kind') in ('regra', 'componente', 'processo') else 'componente'
        lists = {k: [str(t).strip().upper()[:80] for t in (item.get(k) or []) if str(t).strip()][:60]
                 for k in ('terms', 'with', 'machine')}
        if label and lists['terms']:
            clean.append({'label': label, 'kind': kind, **{k: v for k, v in lists.items() if v or k == 'terms'}})
    if not clean:
        raise ValueError('O catálogo precisa de ao menos uma classe com termos.')
    manif = body.get('manifestations') if isinstance(body.get('manifestations'), dict) else {}
    catalog = {'version': 1, 'classes': clean, 'manifestations': {
        str(k).strip().upper()[:40]: [str(t).strip().upper()[:40] for t in v if str(t).strip()][:30]
        for k, v in manif.items() if isinstance(v, list)}}
    Classifier(catalog)  # garante que as expressões são válidas
    return catalog


@bp.route('/catalog', methods=['GET'])
def get_catalog():
    from .classify import default_catalog
    saved = store.get_setting('failure_catalog')
    return jsonify(catalog=saved or default_catalog(), custom=bool(saved))


@bp.route('/catalog', methods=['PUT'])
def put_catalog():
    catalog = _validate_catalog(request.get_json(silent=True))
    store.set_setting('failure_catalog', catalog)
    return jsonify(catalog=catalog, custom=True)


@bp.route('/catalog', methods=['DELETE'])
def reset_catalog():
    from .classify import default_catalog
    store.delete_setting('failure_catalog')
    return jsonify(catalog=default_catalog(), custom=False)


@bp.route('/catalog/test', methods=['POST'])
def test_catalog():
    from .classify import Classifier
    body = request.get_json(silent=True) or {}
    catalog = _validate_catalog(body.get('catalog')) if body.get('catalog') else service.catalog()
    texts = body.get('texts') or [body.get('text', '')]
    machine = str(body.get('machine') or '')
    clf = Classifier(catalog)
    return jsonify(results=[{'text': str(t), 'class': (e := clf.explain(str(t), machine))['label'],
                             'confidence': e['confidence'], 'reason': e['reason']} for t in texts[:200]])


@bp.route('/filters')
def filters():
    documents = store.all_documents()
    ids = set(filter(None, request.args.get('ids', '').split(',')))
    return jsonify(service.options([d for d in documents if (not ids or d['id'] in ids) and service.ready(d)]))


def analytics_data():
    documents = store.all_documents()
    ids = set(filter(None, request.args.get('ids', '').split(',')))
    if ids:
        selected = [d for d in documents if d['id'] in ids]
        if len(selected) != len(ids):
            raise ValueError('Uma das análises selecionadas não existe.')
        if any(not service.ready(d) for d in selected):
            raise ValueError('A análise possui pendências. Conclua a validação do quadro.')
    return service.compute(service.select_records(documents, request.args), service.categories_from(request.args),
                           service.count_mode(request.args))


@bp.route('/analytics')
def analytics():
    return jsonify(analytics_data())


@bp.route('/compare')
def comparison():
    return jsonify(service.compare(store.all_documents(), request.args))


@bp.route('/export')
def export():
    from .exports import render_chart
    kind, fmt = request.args.get('chart', 'pareto'), request.args.get('format', 'pdf')
    if kind not in {'pareto', 'jackknife'} or fmt not in {'pdf', 'png'}:
        raise ValueError('Exportação deve ser Pareto ou Jack-Knife, em PDF ou PNG.')
    data = analytics_data()
    if not data['machines']:
        raise ValueError('Não há registros no filtro selecionado.')
    context = {'start': request.args.get('from', ''), 'end': request.args.get('to', ''), 'line': request.args.get('line', ''),
               'unit': request.args.get('unit', ''), 'machine': request.args.get('machine', '')}
    return send_file(render_chart(data, kind, fmt, context), as_attachment=True,
                     download_name=f'{kind}.{fmt}', mimetype='application/pdf' if fmt == 'pdf' else 'image/png')


@bp.route('/export/xlsx')
def export_xlsx():
    from .xlsx_export import build_summary
    documents = store.all_documents()
    ids = [i for i in request.args.get('ids', '').split(',') if i]
    if ids:
        selected = [d for d in documents if d['id'] in ids]
        if len(selected) != len(ids):
            raise ValueError('Uma das análises selecionadas não existe.')
        if any(not service.ready(d) for d in selected):
            raise ValueError('A análise possui pendências. Conclua a validação do quadro.')
    records = service.select_records(documents, request.args)
    data = service.compute(records, service.categories_from(request.args), service.count_mode(request.args))
    keys = {m['key'] for m in data['machines']}
    records = [r for r in records if '\x1f'.join((r['centro'], r['linha'], r['equipamento'])) in keys]
    if not records:
        raise ValueError('Não há apontamentos validados no filtro selecionado.')
    names = [d['filename'] for d in documents if d['id'] in ids] if ids else []
    start, end = request.args.get('from', ''), request.args.get('to', '')
    filters = {label: request.args.get(key) for key, label in
               (('unit', 'Unidade'), ('line', 'Linha'), ('failure', 'Tipo de falha'), ('category', 'Criticidade'))
               if request.args.get(key)}
    stamp = start if start and start == end else f'{start}_a_{end}' if start else 'todo-periodo'
    return send_file(build_summary(records, data, names, start, end, filters), as_attachment=True,
                     download_name=f'apontamentos-resumidos-{stamp}.xlsx',
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ---------- Fluxo único: upload → predição → validação → agrupamento → dashboard ----------
@bp.route('/pipeline', methods=['POST'])
def pipeline_upload():
    from . import pipeline
    file = request.files.get('file')
    if not file or not file.filename:
        raise ValueError('Selecione a planilha completa.')
    return jsonify(pipeline.start(file.read(), file.filename)), 202


@bp.route('/pipeline/jobs/<job_id>', methods=['GET'])
def pipeline_job(job_id):
    from . import pipeline
    return jsonify(pipeline.job_status(job_id))


@bp.route('/pipeline/<analysis_id>', methods=['GET'])
def pipeline_analysis(analysis_id):
    from . import pipeline
    return jsonify(pipeline.analysis_info(pipeline._document(analysis_id)))


@bp.route('/pipeline/<analysis_id>/items', methods=['GET'])
def pipeline_items(analysis_id):
    from . import pipeline
    args = request.args
    return jsonify(pipeline.items_page(analysis_id, faixa=args.get('faixa', ''), status=args.get('status', ''),
                                       q=args.get('q', ''), page=args.get('page', 1, type=int)))


@bp.route('/pipeline/<analysis_id>/validate', methods=['POST'])
def pipeline_validate(analysis_id):
    from . import pipeline
    body = request.get_json(silent=True) or {}
    return jsonify(pipeline.validate(analysis_id, body.get('items')))


@bp.route('/pipeline/<analysis_id>/high', methods=['GET'])
def pipeline_high_sample(analysis_id):
    from . import pipeline
    pipeline._document(analysis_id)
    return jsonify(pipeline.high_sample(analysis_id))


@bp.route('/pipeline/<analysis_id>/accept-high', methods=['POST'])
def pipeline_accept_high(analysis_id):
    from . import pipeline
    body = request.get_json(silent=True) or {}
    return jsonify(pipeline.accept_high(analysis_id, body.get('confirm'), body.get('keys')))


@bp.route('/pipeline/<analysis_id>/summary', methods=['GET'])
def pipeline_summary(analysis_id):
    from . import pipeline
    return jsonify(pipeline.summary(analysis_id))


@bp.route('/pipeline/<analysis_id>/download', methods=['GET'])
def pipeline_download(analysis_id):
    from . import pipeline
    path, name = pipeline.output_file(analysis_id)
    return send_file(path, as_attachment=True, download_name=name)


# ---------- Gerar planilha de apontamentos (ML) ----------
@bp.route('/ml/status', methods=['GET'])
def ml_status():
    from . import apontamentos_ml
    return jsonify(apontamentos_ml.status())


@bp.route('/ml/train', methods=['POST'])
def ml_train():
    from . import apontamentos_ml
    return jsonify(apontamentos_ml.train(force=True))


@bp.route('/ml/fill', methods=['POST'])
def ml_fill():
    from . import apontamentos_ml
    file = request.files.get('file')
    if not file or not file.filename:
        raise ValueError('Selecione uma planilha.')
    filename = Path(file.filename.replace('\\', '/')).name
    _, summary = apontamentos_ml.fill_workbook(file.read(), filename)
    return jsonify(summary)


@bp.route('/ml/classes', methods=['GET'])
def ml_classes():
    from . import apontamentos_ml
    return jsonify(apontamentos_ml.class_options())


@bp.route('/ml/runs', methods=['GET'])
def ml_runs():
    from . import apontamentos_ml
    return jsonify(apontamentos_ml.list_runs())


@bp.route('/ml/runs/<file_id>/items', methods=['GET'])
def ml_run_items(file_id):
    from . import apontamentos_ml
    args = request.args
    return jsonify(apontamentos_ml.run_items(file_id, faixa=args.get('faixa', ''), status=args.get('status', ''),
                                             q=args.get('q', ''), page=args.get('page', 1, type=int)))


@bp.route('/ml/runs/<file_id>/review', methods=['POST'])
def ml_review(file_id):
    from . import apontamentos_ml
    body = request.get_json(silent=True) or {}
    return jsonify(apontamentos_ml.review(file_id, body.get('items')))


@bp.route('/ml/fill/<file_id>', methods=['GET'])
def ml_download(file_id):
    from . import apontamentos_ml
    path = apontamentos_ml.output_path(file_id)
    if not path:
        return jsonify(erro='Arquivo não encontrado. Processe a planilha novamente.'), 404
    name = request.args.get('nome') or f'apontamentos classificados{path.suffix}'
    return send_file(path, as_attachment=True, download_name=Path(name).name)
