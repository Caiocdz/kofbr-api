# Gargalo — Radar de Confiabilidade

Website em português com Next.js/React e API Flask/Python. A interface compilada está incluída em `frontend/out`: para usar esta entrega, não é necessário instalar Node.js.

## Abrir no Windows

1. Extraia todo o ZIP em uma pasta.
2. Instale Python **3.10 ou superior**, se ainda não estiver instalado.
3. Execute **`iniciar.bat`**. Na primeira execução é necessário acesso à internet para instalar as dependências.
4. O site abre em **http://127.0.0.1:5000**. Mantenha o terminal aberto.

Alternativa pelo terminal, na pasta do projeto:

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements.txt
python run.py
```

Não abra `frontend/out/index.html` diretamente: a interface precisa da API Python. O script serve ambos na mesma porta, usando Waitress. `python app.py` também funciona para desenvolvimento.

## Fluxo implementado

- **Início:** biblioteca em cards diários, busca, ordenação e filtros por data, semana ISO, mês, ano ou intervalo. Datas vêm dos apontamentos da planilha. Importações pendentes ficam disponíveis para continuar a revisão.
- **Importação:** XLSX, XLSM e CSV UTF-8; cabeçalho reconhecido nas primeiras 30 linhas das abas. O Python valida datas e minutos e recusa importações inválidas sem gravar dados parciais. Arquivos com os mesmos registros são reconhecidos mesmo se renomeados ou reordenados.
- **Agrupamento:** considera unidade, linha, equipamento, tipo de parada, subchave e sistema. Normaliza descrições, usa o dicionário técnico e compara similaridade. Não divide registros em lotes e não impõe limite ao número de membros de um grupo. Registros isolados também aparecem no quadro. A validação humana continua obrigatória.
- **Confirmar todos:** botão no rodapé do quadro. Exige marcar a declaração de conferência e digitar CONFIRMAR (a API também exige). Itens no sino bloqueiam a ação. Fica registrado no histórico.
- **Navegação do quadro:** setas e uma barra superior arrastável (com um mapa das colunas: vermelho pendente, verde validado). Cada card tem setas ‹ › para ir à coluna vizinha e a tela acompanha o card. Ao arrastar um card perto das bordas, o quadro rola sozinho.
- **Kanban persistente:** colunas por peça/equipamento, com unidade e linha para distinguir máquinas homônimas. Validação da coluna inteira ou de um card; arrastar e soltar; menu “Mover” acessível no celular e pelo teclado. Mover para uma coluna validada valida automaticamente o card; mover para outra não validada exige nova conferência.
- **Sino de revisão:** a lupa retira o card da coluna e acrescenta uma notificação. O dropdown permite escolher a coluna de destino. Itens no sino continuam armazenados e bloqueiam a conclusão.
- **Colunas:** criação pelo botão “+” ao final do quadro. Lixeira disponível apenas quando não há cards na coluna. Remover uma coluna vazia não apaga registros do sino.
- **Conferência:** clicar no título do card abre as linhas e células originais, paginadas de 100 em 100. É possível editar a descrição consolidada ou desagrupar um card. Essas alterações exigem nova validação.
- **Avançar:** a seta só é habilitada com todos os cards validados e o sino vazio. A API repete essa verificação; o bloqueio não depende só da interface.
- **Dashboard:** quatro dimensões de filtro — unidade, linha, tipo de falha e período. Pareto e Jack-Knife em miniatura, ampliação em modal na mesma aba, exportação real em PNG/PDF e indicadores. A seta superior retorna ao quadro original.
- **Comparar:** em três passos — escolha um atalho (últimos 7 dias, esta semana, este mês, últimos 30 dias) ou datas personalizadas; confira A (antes) e B (depois); refine se quiser. O resultado mostra um veredito em uma frase, os indicadores A → B com variação, o gráfico "Onde mudou" (10 maiores variações) e a tabela com abas Pioraram / Melhoraram / Novos em B / Sem variação. Os gráficos podem ser vistos para A ou B. Os atalhos usam como referência o último dia com dados validados.
- **Criticidade e recorrência:** Dashboard e Comparar têm o filtro por classe do Jack-Knife (Crítico-crônico, Crítico, Crônico, Conforto). As classes são calculadas com as medianas do conjunto completo; o filtro só limita quais equipamentos entram nos totais, gráficos, tabela e exportações.
- **Modo manual (lápis):** cada gráfico tem o botão "Manual" e o dashboard tem "Montar dashboard". O montador guia passo a passo: o que agrupar (equipamento, linha, unidade, tipo ou modo de falha), qual medida, linha de corte, quantidade de itens, escala e cortes do Jack-Knife (mediana, média ou valor manual), título, e uma tabela para incluir/excluir, renomear, corrigir valores ou adicionar itens. As edições não alteram a base; ficam salvas neste navegador e podem voltar ao automático a qualquer momento. O gráfico manual pode ser baixado em PNG.
- **Excel resumido (padrão SAP/KOFBR):** cada pasta do dia tem o botão "Excel"; o Dashboard e o Comparar também exportam. A aba "Apontamentos Resumidos KOFBR" tem as mesmas colunas, ordem e destaques da planilha importada (Centro, Data Inicio Real, Linha, … chave do parada, Observações, Minutos de paradas). Cada falha consolidada vira uma linha por dia: os apontamentos hora a hora são somados (minutos, pontos de eficiência, caixas), o Intervalo vai do primeiro ao último horário e "Ptos. Acumilados" fica com o maior valor. No fim vêm as colunas Qtd. apontamentos, Descrição consolidada e Classificação Jack-Knife. A segunda aba traz o resumo por equipamento.
- **Confiança e motivo:** cada card mostra se a classe veio com confiança **alta** (regra ou termo único, ou relato já corrigido antes), **média** (o relato cita mais de um item, teve correção de digitação ou o card mistura classes), **revisar** (nada reconhecido) ou **pelo analista**. Ao abrir o card aparece o motivo ("Componente citado: rolamento; também cita correia"). A fila de revisão no topo do quadro filtra por confiança.
- **Lote seguro:** "Validar confiança alta" mostra uma amostra dos cards de confiança alta e, com a confirmação do analista, valida só esses. Média e Revisar continuam esperando a pessoa. "Confirmar todos" continua existindo (com CONFIRMAR).
- **Memória de correções:** quando o analista troca a classe de um card, o relato normalizado (sem O.S., acentos e pontuação) vai para a memória. Nas próximas importações o mesmo relato já chega classificado com confiança alta. Voltar o card para "automática" esquece o que foi aprendido. API: `GET/DELETE /api/workspace/memory`.
- **Aprendizado de máquina (scikit-learn, 100% local):** o modelo aprende com tudo o que pessoas já validaram (relato + máquina → classe final do card; correções do analista valem 3x). Usa TF-IDF de palavras e de pedaços de palavras (tolera erro de digitação) + a máquina como contexto, com regressão logística. Quando o catálogo não reconhece um relato, o modelo sugere a classe pelo contexto (confiança média, ou alta acima de 92%); quando o catálogo acha uma classe, o modelo confirma (sobe a confiança) ou discorda (desce para média e mostra a sugestão). Retreina sozinho ~20 s depois da última validação/correção (sem travar a tela) e ao abrir o programa; o botão "Treinar" força na hora. O modelo fica em `data/aprendizado.joblib`. O painel mostra quantos exemplos ele tem e o acerto estimado (treina com 80% e mede nos 20% restantes). Começa a valer a partir de 20 relatos validados. API: `GET /api/workspace/learning` e `POST /api/workspace/learning/train`.
- **Quadro agrupado por falha:** por padrão as colunas do quadro são as classes de falha ("Sem modo de falha identificado" primeiro, depois pelo tempo de parada) e cada card mostra a máquina. Arrastar um card para outra coluna (ou usar as setas ‹ › / "Mover") troca a classe dele — e isso vai para a memória e para o aprendizado. "Validar esta falha" valida os cards da coluna; "Nova falha" cria uma coluna vazia para receber cards. O botão "Por máquina" volta para a visão antiga (colunas por equipamento).
- **Classe congelada na validação:** quando um card é validado, a classe que o analista viu fica gravada nele. Mudanças posteriores no catálogo ou no aprendizado só afetam cards ainda não validados.
- **Painel de revisão:** % classificado automaticamente, barra por confiança, filtro (Todos / Confiança alta / Média / Revisar / Pelo analista), troca Por falha / Por máquina e o estado do aprendizado.
- **Histórico:** progresso e alterações ficam no banco, sobrevivem a reinicializações e podem ser consultados. O arquivo original é mantido para download. Não existe exclusão automática de análises.

## Atendimento ao descritivo do projeto (Coca-Cola FEMSA)

- **1. Classificação de falhas:** cada relato da coluna M é enquadrado automaticamente numa classe padronizada (ex.: "FALHA DE SENSOR", "FALHA DE VÁLVULA DE ENCHIMENTO", "FALHA DE ROLAMENTO"), desconsiderando o restante do texto e o número da O.S. Regras específicas têm prioridade; depois vale o componente/processo citado primeiro. **O componente define a classe**: "rolamento quebrado", "rolamento estourado" e "rolamneto estourado" caem todos em FALHA DE ROLAMENTO (a quebra/espanamento/vazamento fica só como detalhe no card). Texto vazio ou só com a ordem = "SEM DESCRIÇÃO"; nada reconhecido = "SEM MODO DE FALHA IDENTIFICADO", destacado no quadro para análise manual (item 1.4). Cada card mostra a classe e pode ser reclassificado à mão. O **Catálogo de falhas** (botão no quadro) permite incluir termos/classes e testar um relato; as mudanças valem imediatamente para os cards ainda não validados. Nos dados reais de exemplo, 94,7% dos relatos são classificados automaticamente. Os exemplos do item 1.3 estão nos testes automatizados.
- **2. Pareto:** por máquina com a linha (ex.: L03_EMPACOTADORA…), tempo de parada (colunas S/Q), quantidade de falhas no pé da coluna, % acumulado, título com o período. Filtros: ano, mês, semana, dia, intervalo, linha, unidade, equipamento e tipo de parada.
- **3. Crítico-crônico:** X = nº de falhas, Y = MTTR, escala log, cortes pelas medianas com os valores destacados, quadrantes nomeados e pontos numerados. Alterna entre **máquinas** e **falhas** (classificação do item 1). Cabeçalho com a linha analisada e o período. Tabelas de máquinas e de falhas com sequência numérica de no mínimo 40 linhas, nome com a linha, T(min) decrescente, Q, MTTR, **T.T.A** (tempo total acumulado), **%** acumulado, **80%** (tempo dos itens que somam até 80%) e categoria — como na apresentação. Clicar numa máquina abre o desdobramento nos modos de falha dela, com a **ação sugerida** para o quadrante (RCA/FMEA, FTA, RCM, monitoramento). O painel "Próximo passo por quadrante" resume isso para o conjunto.
- **Tipo de parada:** P.EQ.LINHA (manutenção) vem selecionado por padrão quando existe nos dados; pode ser alterado.
- **Excel:** além dos apontamentos resumidos no layout SAP (com as colunas "Classe de falha", "Falhas (O.S.)" e "O.S."), traz as abas "Tabela de máquinas", "Tabela de falhas" (com T.T.A, % e 80%) e "Falhas por máquina" (o desdobramento das máquinas dentro dos 80%).

## Como os números são calculados

**Falha real × linha do SAP.** O SAP fatia uma parada longa em linhas de 1 h. Por padrão o Q conta **falhas reais**: linhas com a mesma O.S. (número de 9 a 12 dígitos no relato) na mesma máquina valem 1 falha; sem O.S., linhas da mesma máquina, mesmo dia, mesmo relato e horários encostados (13:00-14:00 → 14:00-15:00) também. A tela mostra "999 linhas do SAP = 584 falhas reais" e o seletor **Como contar o Q** permite voltar para "Linhas do SAP" (cada linha conta 1). O tempo de parada é sempre a soma de todas as linhas; mudam o Q e o MTTR. Na API, `count=events` (padrão) ou `count=lines`.

- Frequência (Q): falhas reais (ou linhas, se escolhido) no filtro.
- Tempo de parada: soma dos minutos.
- MTTR: soma dos minutos ÷ Q.
- Pareto: ordenação por minutos decrescentes e percentual acumulado. Empates têm ordenação determinística.
- Jack-Knife: frequência no eixo X e MTTR no Y, em escala linear; cortes nas medianas dos equipamentos do conjunto filtrado. Valores iguais ao corte ficam no lado alto. É uma classificação descritiva relativa ao conjunto, sem previsão de falhas.
- Variação: `(B − A) ÷ A × 100`. Se A é zero, a tabela mostra **“Sem base percentual”**. Máquinas com registros em A e nenhum em B aparecem com −100% nos registros. Ausência de registros não comprova ausência de falhas.
- “Melhora” e “piora” se referem apenas à contagem registrada. Períodos com durações diferentes são identificados na tela.

Planilhas distintas que se sobrepõem parcialmente podem conter o mesmo evento. Com a O.S. no relato, a falha é contada uma vez mesmo vindo de arquivos diferentes (a chave é máquina + O.S.); as linhas e os minutos continuam preservados. A proteção de reimportação reconhece conteúdo integral idêntico. Confira a seleção de arquivos em Comparar.

## Planilha aceita

Obrigatórios: **Data, Linha, Equipamento, Observações, Minutos de parada**. Também reconhece os cabeçalhos SAP originais (por exemplo, “Data início real”, “Chave do parada” e “Minutos de paradas”). Datas ISO, `dd/mm/aaaa` e células de data do Excel são reconhecidas.

Unidade e Tipo de falha são recomendados. Na ausência deles, o sistema informa isso e preenche “Não informada/o”. Descrição vazia gera card individual, sem agrupamento automático. Colunas adicionais ficam preservadas nos detalhes originais. A primeira aba com todos os campos obrigatórios é importada. Arquivos protegidos por senha não são aceitos.

## Dados e MySQL existente

O novo fluxo usa **SQLite por padrão**, em `data/radar.sqlite3`, sem exigir configuração de MySQL. Faça backup da pasta **`data`** antes de substituir o projeto. Ela contém o histórico, os quadros e os arquivos originais. Nenhum dado de teste está pré-carregado nesta entrega.

Para colocar o novo fluxo no MySQL já usado pela API anterior:

```powershell
$env:KOFBR_WORKFLOW_DB="mysql"
$env:KOFBR_DB_HOST="localhost"
$env:KOFBR_DB_PORT="3306"
$env:KOFBR_DB_USER="seu_usuario"
$env:KOFBR_DB_PASSWORD="sua_senha"
$env:KOFBR_DB_NAME="kofbr"
python db.py
python run.py
```

O novo fluxo cria a tabela `radar_analyses` e não remove as tabelas antigas. As rotas antigas continuam disponíveis para compatibilidade e dependem do MySQL original. O frontend atualizado usa `/api/workspace/*`.

**Para trazer análises da versão anterior:** configure as variáveis do MySQL de origem e execute `python migrate_history.py`. O destino é SQLite por padrão ou MySQL se `KOFBR_WORKFLOW_DB=mysql`. O script copia o histórico sem alterar a origem e evita conteúdo duplicado. Confirmações são preservadas; grupos mistos ou questionados voltam à revisão. O Excel original não pode ser recuperado quando a versão antiga não o armazenou.

O novo fluxo foi testado com SQLite. A integração e a migração com um servidor MySQL real precisam ser verificadas no seu ambiente; não havia um servidor MySQL nesta sessão.

## Desenvolvimento

```bash
# Terminal 1, raiz
python app.py

# Terminal 2
cd frontend
npm ci
npm run dev
```

Abra http://localhost:3000. A API é localizada automaticamente na porta 5000 do mesmo computador. Opcional: `NEXT_PUBLIC_API_URL` durante o build. CORS está limitado a localhost/127.0.0.1:3000. Para atualizar a versão servida pelo Python:

```bash
cd frontend
npm run build
```

## Verificações

```bash
python -m pip install pytest
python -m pytest -q tests
cd frontend
npm run lint
npm run build
```

Os testes cobrem agrupamento com mais de 1.300 membros, contextos distintos, persistência, validações, movimentação, revisão no sino, criação/exclusão de colunas, conflito entre revisões simultâneas, dados inválidos, reimportação, filtros por data/unidade/linha/tipo, comparação e exportações PDF/PNG.

O site foi projetado para uso local e não implementa autenticação corporativa. Antes de disponibilizá-lo em rede pública, será necessário configurar identidade, autorização, HTTPS e operação do servidor. Nenhum serviço externo recebe a planilha durante o processamento.
