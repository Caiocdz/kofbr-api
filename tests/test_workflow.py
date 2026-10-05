import io
from copy import deepcopy
import openpyxl
import pytest
from app import create_app
from workflow import importer, service, store

HEADERS = ['Unidade', 'Data', 'Linha', 'Equipamento', 'Tipo de falha', 'Observações', 'Minutos de parada']


def spreadsheet(rows, headers=HEADERS):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = 'Apontamentos'
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    data = io.BytesIO()
    workbook.save(data)
    data.seek(0)
    return data


@pytest.fixture
def client(tmp_path, monkeypatch):
    from workflow import learning
    monkeypatch.setenv('KOFBR_DATA_DIR', str(tmp_path))
    learning.reset()
    # Nos testes o treino é chamado explicitamente (sem threads em segundo plano).
    monkeypatch.setattr(learning, 'retrain_in_background', lambda build: None)
    monkeypatch.setenv('KOFBR_WORKFLOW_DB', 'sqlite')
    app = create_app()
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


def upload(client, rows, filename='apontamentos.xlsx'):
    return client.post('/api/workspace/import', data={'file': (spreadsheet(rows), filename)})


def action(client, board, verb, **kwargs):
    return client.post(f'/api/workspace/analyses/{board["id"]}/actions', json={'action': verb, 'revision': board['revision'], **kwargs})


def validate_all(client, board):
    for column in board['columns']:
        result = action(client, board, 'validate_column', column_id=column['id'])
        assert result.status_code == 200, result.json
        board = result.json
    return board


def test_group_unlimited_and_keep_context():
    rows = [['U1', '30/09/2026', 'L1', 'Enchedora', 'Mecânica', 'Rolamento quebrado', 5]] * 1307
    rows += [['U2', '30/09/2026', 'L1', 'Enchedora', 'Mecânica', 'Rolamento quebrado', 5]]
    rows += [['U1', '30/09/2026', 'L1', 'Enchedora', 'Mecânica', 'Sem rolamento quebrado', 5]]
    records, _ = importer.parse_file(spreadsheet(rows).getvalue(), 'base.xlsx')
    columns, cards = importer.group_records(records)
    assert len(columns) == 2
    assert len(cards) == 3
    assert sorted(len(c['record_ids']) for c in cards) == [1, 1, 1307]
    assert records[0]['data_inicio'] == '2026-09-30'


def test_full_board_persistence_validation_hold_move_and_source(client):
    rows = [['U1', '30/09/2026', 'L1', 'Bomba', 'Mecânica', 'Vazamento no selo', 10],
            ['U1', '30/09/2026', 'L1', 'Bomba', 'Mecânica', 'Vazamento no selo', 20],
            ['U1', '29/09/2026', 'L1', 'Motor', 'Elétrica', 'Motor queimado', 40]]
    response = upload(client, rows)
    assert response.status_code == 201
    board = response.json
    analysis_id = board['id']
    assert board['records_count'] == 3 and board['groups_count'] == 2
    assert not board['ready']
    assert client.post(f'/api/workspace/analyses/{analysis_id}/finish').status_code == 409
    assert client.get(f'/api/workspace/analytics?ids={analysis_id}').status_code == 400
    motor = next(c for c in board['columns'] if c['name'] == 'Motor')
    board = action(client, board, 'validate_column', column_id=motor['id']).json
    pump = next(c for c in board['cards'] if c['count'] == 2)
    assert not pump['validated']
    # Ao entrar em uma coluna validada, o card herda a validação.
    board = action(client, board, 'move', card_id=pump['id'], column_id=motor['id']).json
    assert board['ready']
    stale = action(client, {**board, 'revision': 1}, 'hold', card_id=pump['id'])
    assert stale.status_code == 409
    # O sino não trava: dá para finalizar com o item lá; ele fica fora dos gráficos até ser devolvido.
    board = action(client, board, 'hold', card_id=pump['id']).json
    assert board['held_count'] == 1 and board['ready']
    assert client.post(f'/api/workspace/analyses/{analysis_id}/finish').status_code == 200
    data = client.get(f'/api/workspace/analytics?ids={analysis_id}&count=lines').json
    assert data['metrics']['lines'] == 1
    board = client.get(f'/api/workspace/analyses/{analysis_id}').json  # finalizar muda a revisão
    board = action(client, board, 'move', card_id=pump['id'], column_id=motor['id']).json
    assert board['held_count'] == 0 and board['ready']
    # Não é possível excluir coluna ocupada.
    assert action(client, board, 'delete_column', column_id=motor['id']).status_code == 400
    empty = next(c for c in board['columns'] if c['name'] == 'Bomba')
    board = action(client, board, 'delete_column', column_id=empty['id']).json
    assert len(board['columns']) == 1
    reloaded = client.get(f'/api/workspace/analyses/{analysis_id}').json
    assert reloaded['ready'] and reloaded['revision'] == board['revision']
    assert client.post(f'/api/workspace/analyses/{analysis_id}/finish').status_code == 200
    data = client.get(f'/api/workspace/analytics?ids={analysis_id}&from=2026-09-30&to=2026-09-30').json
    assert data['metrics']['count'] == 2
    assert data['metrics']['minutes'] == 30
    assert data['machines'][0]['name'] == 'Motor'  # mudança refletida nos gráficos
    detail = client.get(f'/api/workspace/analyses/{analysis_id}/cards/{pump["id"]}').json
    assert all(r['equipamento'] == 'Bomba' for r in detail['records'])  # fonte original preservada
    source = client.get(f'/api/workspace/analyses/{analysis_id}/source')
    assert source.status_code == 200 and source.data[:2] == b'PK'
    assert client.get('/api/workspace/analyses').json[0]['days'] == ['2026-09-29', '2026-09-30']


def test_duplicate_content_and_invalid_sheet(client):
    rows = [['U1', '2026-09-30', 'L1', 'Bomba', 'Mecânica', 'Vazamento', 4]]
    first = upload(client, rows).json
    duplicate = upload(client, rows, 'renomeada.xlsx')
    assert duplicate.status_code == 409 and duplicate.json['existing_id'] == first['id']
    assert len(client.get('/api/workspace/analyses').json) == 1
    for field, value in [(1, '30/02/2026'), (6, -1), (6, 'abc'), (3, '')]:
        wrong = deepcopy(rows)
        wrong[0][field] = value
        result = upload(client, wrong)
        assert result.status_code == 400, result.json
        assert 'Linha 2' in result.json['erro']
    result = client.post('/api/workspace/import', data={'file': (spreadsheet([['x']], ['Nome']), 'errada.xlsx')})
    assert result.status_code == 400 and 'Cabeçalhos' in result.json['erro']
    assert len(client.get('/api/workspace/analyses').json) == 1


def test_compare_missing_machines_zero_baseline_and_filters(client):
    rows = [
        ['U1', '2026-09-01', 'L1', 'Bomba', 'Mecânica', 'Vazamento', 10],
        ['U1', '2026-09-01', 'L1', 'Bomba', 'Mecânica', 'Vazamento', 30],
        ['U1', '2026-09-01', 'L1', 'Motor', 'Elétrica', 'Falha', 50],
        ['U1', '2026-09-02', 'L1', 'Bomba', 'Mecânica', 'Vazamento', 20],
        ['U1', '2026-09-02', 'L1', 'Esteira', 'Mecânica', 'Trava', 80],
        ['U2', '2026-09-02', 'L1', 'Bomba', 'Mecânica', 'Vazamento', 10],
    ]
    board = validate_all(client, upload(client, rows).json)
    result = client.get('/api/workspace/compare?from=2026-09-02&to=2026-09-02&unit=U1').json
    changes = {m['name']: m for m in result['changes']}
    assert changes['Motor']['percentage'] == -100
    assert changes['Bomba']['percentage'] == -50
    assert changes['Esteira']['percentage'] is None
    assert result['a']['metrics']['count'] == 3
    assert result['b']['metrics']['count'] == 2
    assert result['a']['metrics']['mttr'] == 30
    assert result['b']['metrics']['mttr'] == 50
    metrics = client.get('/api/workspace/analytics?unit=U2&line=L1&failure=Mecânica').json['metrics']
    assert metrics['count'] == 1 and metrics['minutes'] == 10
    assert client.get('/api/workspace/analytics?from=2026-10-01&to=2026-09-01').status_code == 400
    assert client.get('/api/workspace/compare?from=bad&to=bad').status_code == 400
    assert set(client.get('/api/workspace/filters').json['units']) == {'U1', 'U2'}
    for fmt, signature in [('pdf', b'%PDF'), ('png', b'\x89PNG')]:
        for chart in ['pareto', 'jackknife']:
            result = client.get(f'/api/workspace/export?chart={chart}&format={fmt}&ids={board["id"]}')
            assert result.status_code == 200
            assert result.data.startswith(signature)


def test_add_split_and_reopen_validation(client):
    board = upload(client, [['U', '2026-01-01', 'L', 'M', 'Tipo', 'Falha', 10]]*3).json
    board = validate_all(client, board)
    card = board['cards'][0]
    board = action(client, board, 'add_column', name='Nova peça', unit='U', line='L').json
    new = board['columns'][-1]
    board = action(client, board, 'move', card_id=card['id'], column_id=new['id']).json
    assert not board['ready']  # destino não validado pede revisão
    board = action(client, board, 'split_card', card_id=card['id']).json
    assert len(board['cards']) == 3
    assert sum(c['count'] for c in board['cards']) == 3
    board = validate_all(client, board)
    assert board['ready']
    board = action(client, board, 'rename_card', card_id=board['cards'][0]['id'], name='Nova descrição').json
    assert not board['ready']
    # Uma segunda inicialização lê o mesmo histórico.
    store.initialize()
    assert store.get(board['id'])['revision'] == board['revision']


def test_validate_all_requires_human_confirmation(client):
    rows = [['U1', '30/09/2026', 'L1', 'Bomba', 'Mecânica', 'Vazamento no selo', 10],
            ['U1', '30/09/2026', 'L1', 'Motor', 'Elétrica', 'Motor queimado', 40]]
    board = upload(client, rows).json
    refused = action(client, board, 'validate_all')
    assert refused.status_code == 400 and 'CONFIRMAR' in refused.json['erro']
    held = action(client, board, 'hold', card_id=board['cards'][0]['id']).json
    # Confirmar todos valida o que está fora do sino; o item do sino continua lá.
    partial = action(client, held, 'validate_all', confirm='CONFIRMAR').json
    assert partial['ready'] and partial['held_count'] == 1
    moved = action(client, partial, 'move', card_id=held['cards'][0]['id'], column_id=held['columns'][0]['id']).json
    done = action(client, moved, 'validate_all', confirm='confirmar').json
    assert done['ready'] and all(c['validated'] for c in done['columns'])


def test_category_filter_and_excel_summary(client):
    rows = [['U1', '30/09/2026', 'L1', 'Bomba', 'Mecânica', 'Vazamento', 50]] * 3
    rows += [['U1', '30/09/2026', 'L1', 'Motor', 'Elétrica', 'Queimado', 5]]
    rows += [['U1', '30/09/2026', 'L1', 'Esteira', 'Mecânica', 'Correia', 90]]
    board = validate_all(client, upload(client, rows).json)
    full = client.get(f'/api/workspace/analytics?ids={board["id"]}').json
    # Cortes padrão: Q = 5 falhas / 3 máquinas = 1,67 · MTTR = 245 min / 5 falhas = 49 min.
    # Bomba (Q3, 50 min) crítico-crônico · Esteira (Q1, 90 min) crítico · Motor (Q1, 5 min) conforto.
    assert round(full['q_threshold'], 2) == 1.67 and full['mttr_threshold'] == 49
    assert full['categories'] == {'Crítico-crônico': 1, 'Crítico': 1, 'Crônico': 0, 'Conforto': 1}
    assert len(full['rows']) == 3
    only = client.get(f'/api/workspace/analytics?ids={board["id"]}&category=Crítico-crônico').json
    assert {m['name'] for m in only['machines']} == {'Bomba'}
    assert only['metrics']['count'] == 3 and only['q_threshold'] == full['q_threshold']
    comfort = client.get(f'/api/workspace/analytics?ids={board["id"]}&category=Conforto').json
    assert [m['name'] for m in comfort['machines']] == ['Motor'] and comfort['machines'][0]['category'] == 'Conforto'
    assert client.get(f'/api/workspace/analytics?ids={board["id"]}&category=Inventada').status_code == 400
    xlsx = client.get(f'/api/workspace/export/xlsx?ids={board["id"]}&from=2026-09-30&to=2026-09-30')
    assert xlsx.status_code == 200
    book = openpyxl.load_workbook(io.BytesIO(xlsx.data))
    assert book.sheetnames == ['Apontamentos Resumidos KOFBR', 'Tabela de máquinas', 'Tabela de falhas', 'Falhas por máquina']
    assert [c.value for c in book['Tabela de máquinas'][1]] == [None, 'EQUIPAMENTOS', 'T (min)', 'Q', 'MTTR', 'T.T.A', '%', '80%', 'Categoria']
    sheet = book['Apontamentos Resumidos KOFBR']
    assert [c.value for c in sheet[1]][:7] == HEADERS
    rows = list(sheet.iter_rows(min_row=2, values_only=True))
    # Três apontamentos iguais da Bomba viram uma única linha com os minutos somados.
    bomba = next(r for r in rows if r[3] == 'Bomba')
    assert len(rows) == 3 and bomba[6] == 150 and bomba[8] == 3 and bomba[5] == 'Vazamento'
    assert bomba[7] == 'SEM MODO DE FALHA IDENTIFICADO'  # 'Vazamento' não cita o item
    machines = book['Tabela de máquinas']
    assert machines['B2'].value == 'L1_Bomba' and machines.max_row >= 41 and machines['A41'].value == 40


def test_excel_keeps_sap_layout_and_merges_hourly_rows(client):
    headers = ['Centro', 'Data Inicio Real', 'Linha', 'Tipo de Parada', 'Material', 'Ordem', 'Descrição do Material',
               'Turno', 'Intervalo', 'chave do parada', 'Subchave de Parada', 'chave 1 de parada', 'Observações',
               'Pros. Efi. Perdid.', 'Ptos. Acumilados', 'Caixas Produzidas', 'Total minutos', 'Minutos de paradas']
    base = ['B0AC', '02/01/2026', 'LINHA003', 'P.EQ.LINHA', '92601', '11275225', 'CRYST PET 5L', 2]
    rows = [base + [f'{h:02d}:00-{h+1:02d}:00', 'PALETIZADOR 2 IEF', '', 'SISTEMA ESTRUTURA',
                    'FALHA NO EMPURRADOR DE CAMADAS 30008216826', 0.0035, 0.0035 * (h - 7), 0, 60, 60] for h in (8, 9, 10)]
    rows.append(base + ['13:00-14:00', 'ENCHEDORA BRH LI01', '', 'Sistema de enchimento', 'TROCA DA VALVULA', 0.0018, 0.02, 0, 31.2, 31.2])
    response = client.post('/api/workspace/import', data={'file': (spreadsheet(rows, headers), 'sap.xlsx')})
    board = validate_all(client, response.json)
    xlsx = client.get(f'/api/workspace/export/xlsx?ids={board["id"]}&from=2026-01-02&to=2026-01-02')
    sheet = openpyxl.load_workbook(io.BytesIO(xlsx.data)).worksheets[0]
    assert [c.value for c in sheet[1]][:18] == headers
    lines = list(sheet.iter_rows(min_row=2, values_only=True))
    assert len(lines) == 2
    pal = next(r for r in lines if r[9] == 'PALETIZADOR 2 IEF')
    assert pal[8] == '08:00-11:00' and pal[17] == 180 and pal[16] == 180 and pal[7] == 2 and pal[19] == 3 and pal[15] == 0 and pal[18] == 'FALHA DE EMPURRADOR'
    assert pal[12] == 'FALHA NO EMPURRADOR DE CAMADAS 30008216826'
    assert sheet['J1'].fill.fgColor.rgb.endswith('FFFF00') and sheet['M1'].fill.fgColor.rgb.endswith('C00000')


DOC_SENSOR = ['ATUADOR DO SENSOR TRAVADO ORDEM: 30008223804',
              'FALHA NO SENSOR DA HASTE DE PEGADA DE CAMADAS ( 30008224330 )',
              'FALHA NO SENSOR DE SAIDA DE PALETES ( 30008224349 )',
              'SENSOR DE PRESENÇA DE PALETES FOI MONTADO FORA DA POSIÇÃO NO PCM, OCASIONANDO FALHA NA BARREIRA DE SAIDA DA ENVOLVEDORA.',
              'SENSOR DA CENTRAGEM ESQUERDA DA MESA DE FORMAÇÃO DE CAMADA SAINDO FORA DE POSIÇÃO.']
DOC_VALVE = ['FALHA DE ENCHIMENTO, EXCESSO DE NIVEL BAIXO, VALVULA Nº39 QUE ESTÁ COM JAMPER COM A Nº36',
             'FALHA DE ENCHIMENTO, DIFICULTANDO DEIXAR ENCHEDORA NA VELOCIDADE NOMINAL, IDENTIFICADO VÁLVULA 41 TENDO MAIOR IMPACTO',
             'VALVULA Nº41 EM VELOCIDADE NOMINAL COM EXCESSO DE NIVEL BAIXO, VELOCIDADE REDUZIDA PARA MINIMIZAR PERDAS',
             'FALHA DE ENCHIMENTO NA VALVULA Nº36, EXCESSO DE NIVEL BAIXO',
             'VELOCIDADE REDUZIDA, FALHA DE ENCHIMENTO NA VALVULA Nº36, EXCESSO DE NIVEL BAIXO']


def test_failure_classification_matches_project_document():
    from workflow.classify import classify, default_catalog
    cat = default_catalog()
    assert {classify(t, 'PALETIZADOR 2 IEF', cat) for t in DOC_SENSOR} == {'FALHA DE SENSOR'}
    assert {classify(t, 'ENCHEDORA BRH LI01', cat) for t in DOC_VALVE} == {'FALHA DE VÁLVULA DE ENCHIMENTO'}
    assert classify('QUEBRA DE EIXO FUSIVEL E EIXO DE ARVORE', '', cat) == 'FALHA DE EIXO'
    assert classify('PARAFUSO ESPANADO NA ESTRELA', '', cat) == 'FALHA DE PARAFUSO'
    # O mesmo modo de falha escrito de jeitos diferentes cai na mesma classe (slide do funil).
    assert {classify(t, '', cat) for t in ['ROLAMENTO QUEBRADO', 'rolamento estourado', 'ROLAMNETO ESTOURADO 30008216805',
                                            'troca de rolamentos do motor']} == {'FALHA DE ROLAMENTO'}
    assert classify('ERRO DRIVE ALIMENTADOR ( QUEBRA DA CORREIA E ROLAMENTOS)', '', cat) == 'FALHA DE DRIVE'
    assert classify('ORDEM: 30008457970', '', cat) == 'SEM DESCRIÇÃO'
    assert classify('', '', cat) == 'SEM DESCRIÇÃO'
    assert classify('FALHA NA PALETIZADORA', '', cat) == 'SEM MODO DE FALHA IDENTIFICADO'


def test_failure_table_manual_class_machine_filter_and_catalog(client):
    rows = [['U1', '13/09/2026', 'LINHA003', 'PALETIZADOR 2 IEF', 'P.EQ.LINHA', t, 10] for t in DOC_SENSOR]
    rows += [['U1', '13/09/2026', 'LINHA001', 'ENCHEDORA BRH LI01', 'P.EQ.LINHA', t, 20] for t in DOC_VALVE]
    rows += [['U1', '13/09/2026', 'LINHA001', 'ENCHEDORA BRH LI01', 'P.EQ.LINHA', 'PARADA GERAL DA MAQUINA', 5]]
    board = upload(client, rows).json
    assert board['unclassified_count'] == 1
    vague = next(c for c in board['cards'] if c['class'] == 'SEM MODO DE FALHA IDENTIFICADO')
    board = action(client, board, 'set_class', card_id=vague['id'], failure_class='Falha de motor').json
    assert next(c for c in board['cards'] if c['id'] == vague['id'])['class'] == 'FALHA DE MOTOR'
    assert board['unclassified_count'] == 0
    board = validate_all(client, board)
    data = client.get(f'/api/workspace/analytics?ids={board["id"]}').json
    failures = {f['key']: f for f in data['failures']}
    assert failures['FALHA DE VÁLVULA DE ENCHIMENTO']['count'] == 5 and failures['FALHA DE SENSOR']['count'] == 5
    assert failures['FALHA DE MOTOR']['minutes'] == 5 and data['machines'][0]['short'] == 'L01_ENCHEDORA BRH LI01'
    only = client.get(f'/api/workspace/analytics?ids={board["id"]}&machine=PALETIZADOR 2 IEF').json
    assert only['metrics']['count'] == 5 and [f['key'] for f in only['failures']] == ['FALHA DE SENSOR']
    assert 'PALETIZADOR 2 IEF' in client.get('/api/workspace/filters').json['machines']
    # Catálogo editável: um novo termo passa a valer para os indicadores.
    catalog = client.get('/api/workspace/catalog').json['catalog']
    catalog['classes'].insert(0, {'label': 'PARADA GERAL', 'kind': 'regra', 'terms': ['PARADA GERAL']})
    assert client.put('/api/workspace/catalog', json=catalog).status_code == 200
    test = client.post('/api/workspace/catalog/test', json={'texts': ['PARADA GERAL DA MAQUINA']}).json
    assert test['results'][0]['class'] == 'PARADA GERAL'
    assert client.delete('/api/workspace/catalog').json['custom'] is False


SAP_HEADERS = ['Centro', 'Data Inicio Real', 'Linha', 'Tipo de Parada', 'Intervalo', 'chave do parada', 'Observações',
               'Minutos de paradas']


def test_one_failure_per_order_even_when_sap_slices_hours(client):
    # Uma quebra de 3 h (mesma O.S.) vira 3 linhas no SAP, mas é UMA falha.
    rows = [['B0AC', '02/01/2026', 'LINHA003', 'P.EQ.LINHA', f'{h:02d}:00-{h+1:02d}:00', 'PALETIZADOR',
             'ROLAMENTO QUEBRADO 30008216826', 60] for h in (8, 9, 10)]
    # Sem O.S.: intervalos encostados e mesmo relato também são a mesma falha; separados, não.
    rows += [['B0AC', '02/01/2026', 'LINHA003', 'P.EQ.LINHA', iv, 'PALETIZADOR', 'ROLAMENTO ESTOURADO', 30]
             for iv in ('13:00-14:00', '14:00-15:00', '18:00-19:00')]
    board = validate_all(client, client.post('/api/workspace/import', data={'file': (spreadsheet(rows, SAP_HEADERS), 'f.xlsx')}).json)
    assert board['automation']['lines'] == 6 and board['automation']['failures'] == 3
    events = client.get(f'/api/workspace/analytics?ids={board["id"]}').json
    lines = client.get(f'/api/workspace/analytics?ids={board["id"]}&count=lines').json
    assert events['count_mode'] == 'events' and events['metrics']['count'] == 3 and events['metrics']['lines'] == 6
    assert lines['metrics']['count'] == 6
    machine = events['machines'][0]
    assert machine['count'] == 3 and machine['lines'] == 6 and machine['mttr'] == 90
    assert [f['key'] for f in events['failures']] == ['FALHA DE ROLAMENTO'] and events['failures'][0]['count'] == 3
    assert client.get(f'/api/workspace/analytics?ids={board["id"]}&count=xx').status_code == 400


def test_confidence_memory_and_safe_batch(client):
    rows = [['U1', '13/09/2026', 'L1', 'ENCHEDORA', 'P.EQ.LINHA', 'SENSOR COM DEFEITO', 10],
            ['U1', '13/09/2026', 'L1', 'ENCHEDORA', 'P.EQ.LINHA', 'MAQUINA PAROU SOZINHA', 10]]
    board = upload(client, rows).json
    cards = {c['sample']: c for c in board['cards']}
    assert cards['SENSOR COM DEFEITO']['confidence'] == 'alta' and 'sensor' in cards['SENSOR COM DEFEITO']['reason']
    vague = cards['MAQUINA PAROU SOZINHA']
    assert vague['confidence'] == 'baixa'
    # Lote seguro exige confirmação e só valida o que tem confiança alta.
    assert action(client, board, 'validate_confident', card_ids=[cards['SENSOR COM DEFEITO']['id']]).status_code == 400
    board = action(client, board, 'validate_confident', confirm=True, card_ids=[cards['SENSOR COM DEFEITO']['id']]).json
    assert sum(c['validated'] for c in board['cards']) == 1
    board = action(client, board, 'set_class', card_id=vague['id'], failure_class='FALHA DE MOTOR ELÉTRICO').json
    assert next(c for c in board['cards'] if c['id'] == vague['id'])['confidence'] == 'manual'
    # Memória: o mesmo relato (mesmo com outra O.S.) chega classificado na próxima importação.
    assert client.get('/api/workspace/memory').json['total'] == 1
    again = upload(client, [['U1', '14/09/2026', 'L1', 'ENCHEDORA', 'P.EQ.LINHA', 'Máquina parou sozinha 30008216826', 7]], 'dia2.xlsx').json
    card = again['cards'][0]
    assert card['class'] == 'FALHA DE MOTOR ELÉTRICO' and card['confidence'] == 'alta' and card['source'] == 'memoria'


def test_machine_learning_learns_context_from_validated_work(client):
    # O catálogo não conhece "carrossel". O analista classifica alguns relatos e valida;
    # o modelo aprende e reconhece um relato NOVO (não idêntico) pelo contexto.
    known = ['SENSOR COM DEFEITO', 'FALHA NO SENSOR DE SAIDA', 'SENSOR SUJO', 'TROCA DO SENSOR INDUTIVO',
             'ROLAMENTO QUEBRADO', 'ROLAMENTO ESTOURADO', 'TROCA DE ROLAMENTO', 'ROLAMENTO COM RUIDO',
             'MOTOR AQUECENDO', 'MOTOR DESARMOU', 'TROCA DO MOTOR', 'MOTOR COM RUIDO']
    novel = ['TRAVAMENTO DO CARROSSEL', 'CARROSSEL TRAVADO NA SAIDA', 'CARROSSEL PRESO', 'AJUSTE DO CARROSSEL TRAVANDO',
             'CARROSSEL DESALINHADO', 'CARROSSEL TRAVOU NA ENTRADA', 'LIMPEZA DO CARROSSEL TRAVADO', 'CARROSSEL BATENDO']
    rows = [['U1', '13/09/2026', 'L1', 'ENCHEDORA', 'P.EQ.LINHA', t, 10] for t in known + novel]
    board = upload(client, rows).json
    assert client.get('/api/workspace/learning').json['ready'] is False
    for card in board['cards']:
        if card['class'] == 'SEM MODO DE FALHA IDENTIFICADO':
            board = action(client, board, 'set_class', card_id=card['id'], failure_class='FALHA DE CARROSSEL').json
    board = validate_all(client, board)
    assert all(c.get('validated_class') or c.get('failure_class') for c in board['cards'])
    info = client.post('/api/workspace/learning/train').json
    assert info['ready'] and info['examples'] >= 20 and info['classes'] == 4
    new = upload(client, [['U1', '14/09/2026', 'L1', 'ENCHEDORA', 'P.EQ.LINHA', 'carrossel travando de novo', 8]], 'dia2.xlsx').json
    card = new['cards'][0]
    assert card['class'] == 'FALHA DE CARROSSEL' and card['source'] == 'aprendizado' and 'aprendizado' in card['reason']
    # A classe validada fica congelada: retreinar não muda o que já foi validado.
    assert client.get(f'/api/workspace/analytics?ids={board["id"]}').json['failures'][0]['key'] in {
        'FALHA DE CARROSSEL', 'FALHA DE SENSOR', 'FALHA DE ROLAMENTO', 'FALHA DE MOTOR'}


# ---------- Gerar planilha de apontamentos (ML) ----------
def ml_folder(tmp_path):
    folder = tmp_path / 'treino'
    folder.mkdir()
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(['Observações Operação', 'Classificação Manual Analista'])
    parts = {'Sensor danificado': 'sensor', 'Rolamento quebrado': 'rolamento', 'Correia rompida': 'correia'}
    for label, word in parts.items():
        for i in range(25):
            sheet.append([f'{word} com defeito na posicao {i} da maquina', label])
    sheet.append(['sensor com defeito na posicao 0 da maquina', 'Sensor danificado'])   # duplicada
    sheet.append(['sensor com defeito na posicao 1 da maquina', 'Sensores danificados'])  # plural → unido
    sheet.append(['sensor com defeito na posicao 2 da maquina', 'Rolamento quebrado'])   # conflito (maioria vence)
    sheet.append([None, 'Sensor danificado'])                                             # faltante
    sheet.append(['correia gasta', None])                                                 # faltante
    sheet.append(['xxxxxx', 'Correia rompida'])                                           # sem conteúdo
    sheet.append(['motor parou', 'Sem detalhes'])                                         # rótulo sem informação
    workbook.save(folder / 'treino.xlsx')
    return folder


@pytest.fixture
def ml(client, tmp_path, monkeypatch):
    from workflow import apontamentos_ml
    monkeypatch.setenv('KOFBR_ML_TRAIN_DIR', str(ml_folder(tmp_path)))
    monkeypatch.setattr(apontamentos_ml, 'retrain_soon', lambda delay=20.0: None)
    apontamentos_ml._state.update(model=None, info=None, fingerprint=None, training=False)
    return apontamentos_ml


def test_ml_cleaning_and_split_without_leakage(client, ml):
    info = client.post('/api/workspace/ml/train').json
    c = info['cleaning']
    assert (c['faltantes'], c['sem_conteudo'], c['rotulo_sem_informacao']) == (2, 1, 1)
    # A linha no plural vira duplicada depois que os rótulos são unidos.
    assert c['duplicadas'] == 2 and c['conflitos'] == 1
    assert c['rotulos_antes'] - c['rotulos_depois'] == 1  # "Sensores danificados" unido a "Sensor danificado"
    assert c['exemplos'] == 75 and info['classes'] == 3
    assert info['train_size'] + info['test_size'] == 75 and info['test_size'] == 15
    raw, _, counts = ml.read_folder()
    from workflow import service
    examples, _, _ = ml.prepare(raw, [], service.catalog(), counts)
    texts = [e['text'] for e in examples]
    assert len(texts) == len(set(texts))  # um exemplo por relato: nada aparece no treino e no teste
    assert info['accuracy'] >= 80


def test_ml_fill_review_and_learn(client, ml):
    rows = [['Data', 'Equipamento', 'Observações']]
    rows += [['01/01/2026', 'ENCHEDORA', 'sensor com defeito na saida 30008216805'],
             ['01/01/2026', 'ENCHEDORA', 'sensor com defeito na saida 30008216999'],
             ['01/01/2026', 'ENCHEDORA', 'carrossel travado na entrada']]
    workbook = openpyxl.Workbook()
    for row in rows:
        workbook.active.append(row)
    data = io.BytesIO()
    workbook.save(data)
    result = client.post('/api/workspace/ml/fill', data={'file': (io.BytesIO(data.getvalue()), 'dia.xlsx')}).json
    assert result['rows'] == 3 and result['unique'] == 2 and result['preview'][0]['classe'] == 'FALHA DE SENSOR'
    items = client.get(f"/api/workspace/ml/runs/{result['id']}/items").json['items']
    carrossel = next(i for i in items if 'carrossel' in i['key'])
    sensor = next(i for i in items if 'sensor' in i['key'])
    assert sensor['n_linhas'] == 2  # mesma frase com O.S. diferentes = um relato para revisar
    review = client.post(f"/api/workspace/ml/runs/{result['id']}/review", json={'items': [
        {'key': carrossel['key'], 'acao': 'corrigir', 'classe': 'falha de carrossel', 'detalhe': 'Carrossel travado'},
        {'key': sensor['key'], 'acao': 'confirmar'}]}).json
    assert review['saved'] == 2 and review['run']['reviewed'] == 2
    # A planilha baixada já sai com a correção.
    sheet = openpyxl.load_workbook(io.BytesIO(client.get(f"/api/workspace/ml/fill/{result['id']}").data)).active
    assert [c.value for c in sheet[4]][3:] == ['FALHA DE CARROSSEL', 'Carrossel travado', None, 'Analista']
    # O modelo retreina com as revisões e o mesmo relato já chega corrigido.
    info = client.post('/api/workspace/ml/train').json
    assert info['analyst_examples'] == 2 and 'FALHA DE CARROSSEL' in client.get('/api/workspace/ml/classes').json['classes']
    again = client.post('/api/workspace/ml/fill', data={'file': (io.BytesIO(data.getvalue()), 'dia2.xlsx')}).json
    assert again['preview'][2]['classe'] == 'FALHA DE CARROSSEL' and again['preview'][2]['faixa'] == 'Analista'
    # Revisar de novo o mesmo relato substitui a revisão anterior.
    client.post(f"/api/workspace/ml/runs/{again['id']}/review", json={'items': [
        {'key': carrossel['key'], 'acao': 'corrigir', 'classe': 'FALHA DE ESTRELA', 'detalhe': ''}]})
    from workflow import store
    examples = store.ml_examples()
    assert len(examples) == 2 and {e['classe'] for e in examples} == {'FALHA DE ESTRELA', 'FALHA DE SENSOR'}


# ---------- Fluxo único: upload → predição → validação → agrupamento → dashboard ----------
def sap_sheet(rows):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = 'Apontamentos de Falha KOFBR'
    sheet.append(['Centro', 'Data Inicio Real', 'Linha', 'Tipo de Parada', 'Intervalo', 'chave do parada',
                  'Observações', 'Minutos de paradas'])
    for row in rows:
        sheet.append(row)
    data = io.BytesIO()
    workbook.save(data)
    return data.getvalue()


def run_pipeline(client, data, name='completa.xlsx'):
    import time
    job = client.post('/api/workspace/pipeline', data={'file': (io.BytesIO(data), name)}).json
    for _ in range(300):
        status = client.get(f"/api/workspace/pipeline/jobs/{job['id']}").json
        if status['done']:
            return status
        time.sleep(0.1)
    raise AssertionError('processamento não terminou')


def test_pipeline_end_to_end(client, ml):
    rows = [
        ['B0AC', '02/01/2026', 'LINHA001', 'P.EQ.LINHA', '13:00-14:00', 'ENCHEDORA', 'sensor com defeito na saida 300082168051', 60],
        ['B0AC', '02/01/2026', 'LINHA001', 'P.EQ.LINHA', '14:00-15:00', 'ENCHEDORA', 'sensor com defeito na saida 300082168051', 30],
        ['B0AC', '03/01/2026', 'LINHA002', 'P.EQ.LINHA', '08:00-09:00', 'ROTULADORA', 'carrossel travado na entrada', 20],
        ['B0AC', '03/01/2026', '', 'P.EQ.LINHA', '09:00-10:00', '', 'rolamento com defeito', 10],  # inválida
    ]
    data = sap_sheet(rows)
    status = run_pipeline(client, data)
    assert status['error'] == '' and status['analysis_id']
    analysis_id = status['analysis_id']
    info = client.get(f'/api/workspace/pipeline/{analysis_id}').json
    assert info['rows'] == 3 and info['skipped'] == [{'linha': 5, 'motivo': 'linha e equipamento são obrigatórios'}]
    assert info['ready'] is False and info['step'] == 3
    # Dashboard ainda bloqueado: nada validado.
    assert client.get(f'/api/workspace/analytics?ids={analysis_id}').status_code == 400

    page = client.get(f'/api/workspace/pipeline/{analysis_id}/items').json
    assert page['total'] == 2 and page['progress']['linhas'] == 3  # mesma frase com O.S. diferente = 1 relato
    sensor = next(i for i in page['items'] if 'sensor' in i['relato_norm'])
    carrossel = next(i for i in page['items'] if 'carrossel' in i['relato_norm'])
    assert sensor['classe'] == 'FALHA DE SENSOR' and sensor['n_linhas'] == 2

    saved = client.post(f'/api/workspace/pipeline/{analysis_id}/validate', json={'items': [
        {'key': sensor['relato_norm'], 'resultado': 'correta'},
        {'key': carrossel['relato_norm'], 'resultado': 'errada', 'classe': 'falha de carrossel', 'detalhe': 'Carrossel travado'}]}).json
    assert saved['saved'] == 2 and saved['progress']['validados'] == 2 and saved['progress']['percent_linhas'] == 100
    # Passo 4: agrupado por falha validada (2 linhas do SAP da mesma O.S. = 1 falha real).
    summary = {r['classe']: r for r in client.get(f'/api/workspace/pipeline/{analysis_id}/summary').json['failures']}
    assert summary['FALHA DE SENSOR']['linhas'] == 2 and summary['FALHA DE SENSOR']['falhas_reais'] == 1
    assert summary['FALHA DE CARROSSEL']['linhas'] == 1 and summary['FALHA DE CARROSSEL']['linhas_validadas'] == 1
    # Passo 5: o Dashboard existente conta pela classe validada.
    analytics = client.get(f'/api/workspace/analytics?ids={analysis_id}').json
    assert {f['key']: f['lines'] for f in analytics['failures']} == {'FALHA DE SENSOR': 2, 'FALHA DE CARROSSEL': 1}
    listing = next(a for a in client.get('/api/workspace/analyses').json if a['id'] == analysis_id)
    assert listing['mode'] == 'ml' and listing['ready'] and listing['step'] == 5
    # Validações viram exemplos de treino.
    from workflow import store
    assert {e['classe'] for e in store.ml_examples()} == {'FALHA DE SENSOR', 'FALHA DE CARROSSEL'}
    # A planilha completa sai com as previsões e as correções, na linha certa.
    sheet = openpyxl.load_workbook(io.BytesIO(client.get(f'/api/workspace/pipeline/{analysis_id}/download').data)).active
    assert [c.value for c in sheet[1]][-4:] == ['Classificação Manual Analista', 'Detalhe sugerido',
                                               'Confiança do modelo (%)', 'Faixa de confiança']
    assert sheet['G4'].value == 'carrossel travado na entrada'
    assert [c.value for c in sheet[4]][-4:] == ['FALHA DE CARROSSEL', 'Carrossel travado', None, 'Analista']
    assert sheet.cell(5, 12).value == 'Linha ignorada: linha e equipamento são obrigatórios'
    # Mesmo arquivo de novo: recusado, com o link da análise existente.
    again = run_pipeline(client, data, 'copia.xlsx')
    assert again['existing_id'] == analysis_id and again['error']


def test_pipeline_accept_high_needs_confirmation(client, ml):
    data = sap_sheet([['B0AC', '02/01/2026', 'LINHA001', 'P.EQ.LINHA', '13:00-14:00', 'ENCHEDORA',
                       f'correia com defeito na posicao {i} da maquina', 10] for i in range(3)])
    analysis_id = run_pipeline(client, data)['analysis_id']
    url = f'/api/workspace/pipeline/{analysis_id}/accept-high'
    assert client.post(url, json={}).status_code == 400
    high = client.get(f'/api/workspace/pipeline/{analysis_id}/high').json
    if high['total']:
        result = client.post(url, json={'confirm': True}).json
        assert result['progress']['validados'] == high['total']


def test_reorder_boxes_and_move_with_position(client):
    rows = [['U1', '30/09/2026', 'L1', 'Enchedora', 'Mecânica', 'Rolamento quebrado', 5],
            ['U1', '30/09/2026', 'L1', 'Rotuladora', 'Elétrica', 'Sensor com defeito', 3],
            ['U1', '30/09/2026', 'L1', 'Paletizador', 'Mecânica', 'Correia rompida', 4]]
    board = upload(client, rows).json
    ids = [c['id'] for c in board['cards']]
    revision, events = board['revision'], len(board['events'])
    # Só a ordem: não muda classe, validação nem o histórico de alterações.
    result = action(client, board, 'reorder', layout={'key': 'maquina:x', 'ids': list(reversed(ids))})
    assert result.status_code == 200, result.json
    board = result.json
    assert board['layout']['maquina:x'] == list(reversed(ids))
    assert board['revision'] == revision + 1 and len(board['events']) == events
    assert not any(c['validated'] for c in board['cards'])
    # Mudar de falha já posicionando a caixa em cima de outra.
    card = board['cards'][0]
    result = action(client, board, 'set_class', card_id=card['id'], failure_class='FALHA DE TESTE',
                    layout={'key': 'falha:FALHA DE TESTE', 'ids': [card['column_id']]})
    board = result.json
    assert next(c for c in board['cards'] if c['id'] == card['id'])['class'] == 'FALHA DE TESTE'
    assert board['layout']['falha:FALHA DE TESTE'] == [card['column_id']]
    assert action(client, board, 'reorder', layout={'key': 'outra', 'ids': []}).status_code == 400


def test_learning_history_tracks_accuracy(tmp_path, monkeypatch):
    from workflow import learning
    monkeypatch.setenv('KOFBR_DATA_DIR', str(tmp_path))
    learning.reset()
    rows = [(f'rolamento quebrado {i}', 'Enchedora', 'FALHA DE ROLAMENTO', 1) for i in range(40)]
    rows += [(f'sensor sem sinal {i}', 'Rotuladora', 'FALHA DE SENSOR', 1) for i in range(40)]
    first = learning.train(rows)
    assert first['accuracy'] is not None
    learning.train(rows, force=True)  # mesmos exemplos = mesmo ponto
    assert len(learning.history()) == 1
    learning.train(rows + [('correia rompida', 'Paletizador', 'FALHA DE CORREIA', 3)])
    info = learning.info()
    assert len(info['history']) == 2 and info['measure_min'] == 60
    learning.reset()
    assert learning.history() == []


def test_finish_learns_and_next_sheet_improves(client):
    vague = ['MAQUINA PAROU DE REPENTE NO TURNO', 'EQUIPAMENTO PAROU SOZINHO', 'PAROU DE REPENTE NO TURNO B']
    sheet1 = [['U1', '13/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', t, 10] for t in vague]
    sheet1 += [['U1', '13/09/2026', 'L1', 'Paletizador', 'P.EQ.LINHA', 'FALHA NO SENSOR DE SAIDA', 5]]
    board = upload(client, sheet1, 'dia13.xlsx').json
    assert all(c.get('suggested') for c in store.get(board['id'])['cards'])
    # O analista corrige os relatos vagos e finaliza.
    for card in [c for c in board['cards'] if c['class'] == 'SEM MODO DE FALHA IDENTIFICADO']:
        board = action(client, board, 'set_class', card_id=card['id'], failure_class='FALHA DE INVERSOR').json
    board = validate_all(client, board)
    assert not store.get(board['id']).get('finished_at')
    done = client.post(f"/api/workspace/analyses/{board['id']}/finish").json
    report = done['learning']
    assert report['hit_rate'] < 50 and report['corrections'] >= 1 and report['previous_hit_rate'] is None
    assert store.get(board['id'])['finished_at']
    # Próxima planilha com os mesmos relatos: já chega classificada pelo que foi aprendido.
    sheet2 = [['U1', '14/09/2026', 'L2', 'Enchedora', 'P.EQ.LINHA', t, 7] for t in vague]
    board2 = upload(client, sheet2, 'dia14.xlsx').json
    assert {c['class'] for c in board2['cards']} == {'FALHA DE INVERSOR'}
    board2 = validate_all(client, board2)
    report2 = client.post(f"/api/workspace/analyses/{board2['id']}/finish").json['learning']
    assert report2['hit_rate'] == 100 and report2['previous_hit_rate'] == report['hit_rate']
    assert report2['from_past'] == 100
    sheets = client.get(f"/api/workspace/analyses/{board2['id']}").json['automation']['learning']['sheets']
    assert [s['id'] for s in sheets] == [board['id'], board2['id']]
    # Finalizar de novo não duplica o ponto da planilha.
    client.post(f"/api/workspace/analyses/{board2['id']}/finish")
    assert len(client.get(f"/api/workspace/analyses/{board2['id']}").json['automation']['learning']['sheets']) == 2


def test_merge_cards_undo_redo(client):
    rows = [['U1', '13/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', 'ROLAMENTO QUEBRADO', 10],
            ['U1', '13/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', 'SENSOR SEM SINAL', 5],
            ['U1', '13/09/2026', 'L1', 'Rotuladora', 'P.EQ.LINHA', 'MOTOR QUEIMADO', 7]]
    board = upload(client, rows).json
    assert board['undo'] is None and board['redo'] is None
    by = {c['sample']: c for c in board['cards']}
    rol, sen, mot = by['ROLAMENTO QUEBRADO'], by['SENSOR SEM SINAL'], by['MOTOR QUEIMADO']
    # Contextos diferentes (outra máquina) nunca se misturam.
    bad = action(client, board, 'merge_cards', card_id=mot['id'], target_id=rol['id'])
    assert bad.status_code == 400 and 'mesma máquina' in bad.json['erro']
    board = action(client, board, 'merge_cards', card_id=sen['id'], target_id=rol['id']).json
    merged = next(c for c in board['cards'] if c['id'] == rol['id'])
    assert len(board['cards']) == 2 and merged['count'] == 2 and merged['class'] == 'FALHA DE ROLAMENTO'
    assert board['undo']['action'] == 'merge_cards' and board['events'][-1]['value'].upper() == 'SENSOR SEM SINAL'
    # Ctrl+Z desfaz, Ctrl+Y refaz.
    board = action(client, board, 'undo').json
    assert len(board['cards']) == 3 and board['redo']['action'] == 'merge_cards' and board['undo'] is None
    board = action(client, board, 'redo').json
    assert len(board['cards']) == 2 and board['redo'] is None
    # Desfazer uma troca de classe também tira o relato da memória de correções.
    board = action(client, board, 'set_class', card_id=mot['id'], failure_class='FALHA DE BOBINA').json
    assert service.memory().get('MOTOR QUEIMADO', {}).get('label') == 'FALHA DE BOBINA'
    board = action(client, board, 'undo').json
    assert 'MOTOR QUEIMADO' not in service.memory()
    assert next(c for c in board['cards'] if c['id'] == mot['id'])['class'] == 'FALHA DE MOTOR'
    assert action(client, board, 'redo').status_code == 200


def test_resumo_from_validated_analysis(client):
    import openpyxl as xl
    rows = [['U1', '13/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', 'FALHA NO SENSOR DE SAIDA 30008224349', 10],
            ['U1', '13/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', 'FALHA NO SENSOR DE SAIDA 30008224350', 5],
            ['U1', '13/09/2026', 'L2', 'Rotuladora', 'P.EQ.LINHA', 'ROLAMENTO QUEBRADO', 7]]
    board = validate_all(client, upload(client, rows).json)
    out = client.get(f"/api/workspace/analyses/{board['id']}/resumo.xlsx")
    assert out.status_code == 200
    sheet = xl.load_workbook(io.BytesIO(out.data)).worksheets[0]
    head = [c.value for c in sheet[1]]
    body = [dict(zip(head, [c.value for c in r])) for r in sheet.iter_rows(min_row=2)]
    assert len(body) == 2
    sensor = next(r for r in body if r['Classificação'] == 'FALHA DE SENSOR')
    assert sensor['Ocorrências'] == 2 and sensor['Minutos de parada'] == 15


def _sap_sheet():
    import openpyxl as xl
    from openpyxl.styles import PatternFill
    head = ['Centro', 'Data Inicio Real', 'Linha', 'Tipo de Parada', 'Ordem', 'Turno', 'Intervalo', 'chave do parada',
            'Observações', 'Total minutos', 'Minutos de paradas']
    wb = xl.Workbook()
    ws = wb.active
    ws.title = 'Base SAP'
    ws.append(head)
    ws['I1'].fill = PatternFill('solid', fgColor='C00000')
    texts = ['FALHA NO SENSOR DE SAIDA DE PALETES ( 30008224349 )', 'ROLAMENTO QUEBRADO', 'FALHA NO SENSOR DE SAIDA DE PALETES ( 30008224350 )',
             'TRAVOU NA SAIDA', '']
    for i, t in enumerate(texts, 2):
        ws.append(['BR01', '13/09/2026', 'LINHA001', 'P.EQ.LINHA', 3000 + i, 1, '08:00', 'ENCHEDORA BRH LI01', t, f'=K{i}*1', 10 * i])
    ws.auto_filter.ref = 'A1:K6'
    data = io.BytesIO()
    wb.save(data)
    return data.getvalue(), head, texts


def test_full_sheet_from_validated_analysis_keeps_everything_and_adds_classification(client):
    import openpyxl as xl
    data, head, texts = _sap_sheet()
    board = client.post('/api/workspace/import', data={'file': (io.BytesIO(data), 'sap.xlsx')}).json
    board = validate_all(client, board)
    out = client.get(f"/api/workspace/analyses/{board['id']}/completa")
    assert out.status_code == 200 and 'com classifica' in out.headers['Content-Disposition']
    ws = xl.load_workbook(io.BytesIO(out.data)).worksheets[0]
    assert ws.title == 'Base SAP'
    # Todas as colunas originais no mesmo lugar (fórmulas intactas) + Classificação no fim.
    assert [c.value for c in ws[1]] == head + ['Classificação']
    assert ws['J2'].value == '=K2*1' and ws['I1'].fill.fgColor.rgb.endswith('C00000')
    assert ws.max_row == 1 + len(texts) and ws.auto_filter.ref.startswith('A1:L')
    got = {ws.cell(r, 9).value or '': ws.cell(r, 12).value for r in range(2, ws.max_row + 1)}
    assert got[texts[0]] == got[texts[2]] == 'FALHA DE SENSOR'
    assert got[texts[1]] == 'FALHA DE ROLAMENTO'
    assert got[''] == 'SEM DESCRIÇÃO'


def test_pareto_and_jackknife_match_hand_calculation(client):
    """Conferência à mão (contagem por linhas do SAP, como no item 2.2 do descritivo).
    M1: 4×25=100 min · M2: 1×90 · M5: 3×20=60 · M3: 10×3=30 · M4: 2×5=10 → T=290, Q=20, 5 máquinas.
    Cortes (método padrão, igual ao exemplo do descritivo): Q = 20/5 = 4 · MTTR = 290/20 = 14,5."""
    plan = {'M1': [25] * 4, 'M2': [90], 'M3': [3] * 10, 'M4': [5] * 2, 'M5': [20] * 3}
    rows = []
    for machine, minutes in plan.items():
        for i, m in enumerate(minutes):
            rows.append(['U1', f'{13 + i % 3}/09/2026', 'LINHA001', machine, 'P.EQ.LINHA', f'ROLAMENTO QUEBRADO {machine} {i}', m])
    board = validate_all(client, upload(client, rows).json)
    data = client.get(f"/api/workspace/analytics?ids={board['id']}&count=lines").json
    assert data['q_threshold'] == 4 and data['mttr_threshold'] == 14.5
    pareto = [(m['name'], m['minutes'], m['count'], round(m['percent'], 2), round(m['cumulative'], 2)) for m in data['machines']]
    assert pareto == [('M1', 100, 4, 34.48, 34.48), ('M2', 90, 1, 31.03, 65.52), ('M5', 60, 3, 20.69, 86.21),
                      ('M3', 30, 10, 10.34, 96.55), ('M4', 10, 2, 3.45, 100)]
    cat = {m['name']: (m['mttr'], m['category']) for m in data['machines']}
    assert cat == {'M1': (25, 'Crítico-crônico'), 'M2': (90, 'Crítico'), 'M5': (20, 'Crítico'),
                   'M3': (3, 'Crônico'), 'M4': (5, 'Conforto')}
    # Com a mediana (método antigo) o corte de Q seria 3 e a M5 viraria crítico-crônico por empate.


def test_card_returned_to_original_column_gets_its_color_back(client):
    rows = [['U1', '13/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', 'FALHA NO SENSOR DE SAIDA', 10],
            ['U1', '13/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', 'ROLAMENTO QUEBRADO', 5]]
    board = upload(client, rows).json
    card = next(c for c in board['cards'] if c['class'] == 'FALHA DE SENSOR')
    color = card['confidence']
    board = action(client, board, 'set_class', card_id=card['id'], failure_class='FALHA DE ROLAMENTO').json
    moved = next(c for c in board['cards'] if c['id'] == card['id'])
    assert moved['confidence'] == 'manual' and service.memory()
    # Devolver à coluna original (mesmo que a UI mande o nome da classe) volta ao automático e à cor de antes.
    board = action(client, board, 'set_class', card_id=card['id'], failure_class='FALHA DE SENSOR').json
    back = next(c for c in board['cards'] if c['id'] == card['id'])
    assert back['class'] == 'FALHA DE SENSOR' and back['confidence'] == color and not back['failure_class']
    assert 'FALHA NO SENSOR DE SAIDA' not in service.memory()
    # Em lote (arrastar o bloco da máquina) também.
    board = action(client, board, 'set_classes', items=[{'card_id': card['id'], 'failure_class': 'FALHA DE MOTOR'}]).json
    board = action(client, board, 'set_classes', items=[{'card_id': card['id'], 'failure_class': 'FALHA DE SENSOR'}]).json
    assert next(c for c in board['cards'] if c['id'] == card['id'])['confidence'] == color


def test_bell_finish_with_held_and_release_later_to_the_right_day(client):
    rows = [['U1', '13/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', 'FALHA NO SENSOR DE SAIDA', 10],
            ['U1', '14/09/2026', 'L1', 'Enchedora', 'P.EQ.LINHA', 'ROLAMENTO QUEBRADO', 7]]
    board = upload(client, rows).json
    rol = next(c for c in board['cards'] if c['class'] == 'FALHA DE ROLAMENTO')
    board = action(client, board, 'hold', card_id=rol['id'], note='Confirmar com a manutenção').json
    held = next(c for c in board['cards'] if c['id'] == rol['id'])
    assert held['held'] and held['held_note'] == 'Confirmar com a manutenção' and held['held_at']
    board = action(client, board, 'validate_all', confirm='CONFIRMAR').json
    assert client.post(f"/api/workspace/analyses/{board['id']}/finish").status_code == 200
    day14 = client.get(f"/api/workspace/analytics?ids={board['id']}&from=2026-09-14&to=2026-09-14&count=lines").json
    assert day14['metrics']['lines'] == 0
    board = client.get(f"/api/workspace/analyses/{board['id']}").json
    # Dias depois: devolve trocando a falha e já validado → entra no dia 14, com a falha escolhida.
    board = action(client, board, 'release', card_id=rol['id'], failure_class='FALHA DE EIXO', validate=True).json
    back = next(c for c in board['cards'] if c['id'] == rol['id'])
    assert not back['held'] and back['validated'] and back['class'] == 'FALHA DE EIXO' and board['ready']
    assert 'held_at' not in back and service.memory()['ROLAMENTO QUEBRADO']['label'] == 'FALHA DE EIXO'
    day14 = client.get(f"/api/workspace/analytics?ids={board['id']}&from=2026-09-14&to=2026-09-14&count=lines").json
    assert day14['metrics']['lines'] == 1 and day14['failures'][0]['key'] == 'FALHA DE EIXO'
    assert action(client, board, 'release', card_id=rol['id']).status_code == 400
