# Gargalo — Radar de Confiabilidade

Ferramenta local (roda no próprio computador e no MySQL da sua rede, sem enviar dados para fora) que transforma
a planilha de paradas do SAP em análise de manutenção, seguindo o descritivo do projeto Coca-Cola FEMSA:

1. **Classifica** cada relato da coluna M (Observações) no padrão “FALHA DE <componente>” (descritivo, item 1);
2. o analista **valida** num quadro kanban (validação humana obrigatória);
3. gera o **Pareto** por máquina (item 2) e o **crítico-crônico / Jack-Knife** com as tabelas (item 3);
4. a **machine learning aprende** com cada planilha finalizada e erra menos na seguinte.

API em Python (Flask + scikit-learn), interface em Next.js/React servida pela própria API.

**Identidade visual:** vermelho Coca-Cola mais sóbrio `#C8102E` só na marca e nas ações, branco no conteúdo, cinza-gelo
`#F4F6F8` nas superfícies e grafite no texto; títulos em Bricolage Grotesque e texto em Manrope. O símbolo do
gargalo é vetorial com fundo transparente (`frontend/public/gargalo.svg` e `gargalo-branco.svg`; componente
`GargaloMark` em `components/brand.tsx`). Animações: a abertura (a garrafa enche, a tampinha estoura, o
nome é escrito e a tela sobe com a onda) aparece uma vez por sessão; a garrafa enchendo é o indicador de
carregamento; bolhas sobem ao validar, importar e finalizar; a tampinha estoura quando a ML aprende com uma
planilha; a fita da barra lateral ondula; os números enchem de 0 até o valor. Tudo é desligado quando o
sistema pede "reduzir movimento".

**Modo escuro:** botão de sol/lua no topo. A escolha fica salva neste computador; sem escolha, segue o tema
do sistema. Os arquivos exportados (Excel, PNG, PDF) saem sempre no tema claro.

## Abrir no Windows

1. Extraia todo o ZIP em uma pasta.
2. Instale **Python 3.10 ou superior** (marque “Add Python to PATH”).
3. Deixe o **MySQL** ligado (5.7, 8.x ou MariaDB 10.4+). Padrão: `localhost:3306`, usuário `root`, senha `root`,
   banco `kofbr` — para mudar, edite o arquivo **`.env`** (modelo em `.env.example`). O banco e as tabelas são
   criados sozinhos na primeira execução.
4. Execute **`iniciar.bat`**. Na primeira vez ele instala as dependências (precisa de internet só nessa hora).
5. O sistema abre em **http://127.0.0.1:5000**. Mantenha a janela do terminal aberta.

A interface já vem compilada em `frontend/out` no pacote de entrega; Node.js só é necessário para quem for
alterar a interface (`cd frontend && npm ci && npm run build`).

Pelo terminal: `python -m pip install -r requirements.txt` e depois `python run.py`.

## Banco de dados (MySQL)

Todo o histórico fica no MySQL, fora da pasta do projeto: análises (com a planilha original), validações,
memória de correções, catálogo, revisões da ML e o resumo por falha. Tabelas: `radar_analyses`,
`radar_settings`, `radar_ml_examples`, `radar_ml_items`, `radar_failure_summary` (e as do fluxo antigo:
`upload_batches`, `records`, `clusters`...). Se o MySQL não responder, o `iniciar.bat` para com uma mensagem
dizendo qual servidor/usuário tentou.

- **Planilhas grandes:** documento + planilha original passam do limite padrão de pacote do MySQL. Ao iniciar,
  o sistema eleva `max_allowed_packet` para 256 MB (o usuário `root` tem permissão; no MySQL 8 fica salvo).
  Com outro usuário sem esse privilégio, peça ao DBA para configurar `max_allowed_packet=256M`.
- **Vindo da versão com SQLite:** rode uma vez `python migrar_sqlite_para_mysql.py` (lê `data/radar.sqlite3`,
  não altera o arquivo e pode ser repetido sem duplicar). Depois de conferir, o arquivo pode ser arquivado.
- A pasta `data/` guarda só arquivos gerados: os modelos treinados (`*.joblib`, refeitos sozinhos a partir do
  banco) e as planilhas classificadas pelo fluxo de ML (`data/ml_saidas`).

## Fluxo

**1. Importar.** Planilha .xlsx/.xlsm/.csv exportada do SAP (cabeçalho reconhecido nas primeiras 30 linhas).
Colunas usadas: Centro (A), Data Início Real (B), Linha (C), Tipo de Parada (D), Turno (H), Intervalo (I),
chave do parada (J), Observações (M) e Minutos de paradas (S/Q). Importação tudo-ou-nada: arquivo inválido
não grava nada; o mesmo conteúdo renomeado ou reordenado é reconhecido.

**2. Agrupar e classificar (automático).** Linhas repetidas do mesmo apontamento são agrupadas só dentro do
mesmo contexto (unidade, linha, máquina, tipo de parada, subchave e sistema) e com texto pelo menos 80%
parecido, sem acento/pontuação/número de O.S.; frases com “não/sem/nunca” nunca se juntam às sem negação.
Cada relato recebe a classe pela seguinte ordem: memória de correções do analista → catálogo de falhas
(o componente citado define a classe; editável na tela) → machine learning. Relato vazio = “Sem descrição”;
nada reconhecido = “Sem modo de falha identificado”, para análise manual (item 1.4).

**3. Validar (quadro kanban).** Uma coluna por falha; dentro dela, um bloco por máquina.
- Painel da ML no topo com o acerto e o **semáforo**: verde (confiável), amarelo (conferir), vermelho (revisar);
  azul = alterado manualmente; cinza = validado. Clicar numa cor filtra o quadro.
- Arrastar um relato para outra coluna troca a falha (vira memória para as próximas planilhas); devolvê-lo à
  coluna original volta à cor de antes. Soltar **em cima** de outro relato da mesma máquina agrupa (com
  confirmação). A ordem das caixas (em cima/embaixo) fica salva.
- **Desfazer/Refazer** (Ctrl+Z / Ctrl+Y) para qualquer ação.
- **Sino de revisão**: separa itens para decidir depois, com anotação. Não trava: dá para finalizar com itens
  no sino; eles ficam fora dos gráficos e entram no dia certo quando forem devolvidos, mesmo dias depois.
- “Validar confiáveis” (lote, com amostra para conferir) e “Confirmar todos” (exige digitar CONFIRMAR).
- **Finalizar e ver análises**: mede quanto a ML acertou nesta planilha e retreina o modelo.

**4. Analisar (dashboard).** Filtros: unidade, linha, equipamento, tipo de parada e período (dia, semana,
mês, ano ou intervalo). Abre em P.EQ.LINHA (manutenção, item 1.1) e, se houver mais de uma unidade, na
unidade principal (o crítico-crônico é relativo a uma unidade, item 3.3).
- **Pareto** por máquina com a linha no nome (L05_PALETIZADORA), tempo de parada, Q no pé da coluna,
  % acumulado e período no título.
- **Crítico-crônico (Jack-Knife)**: X = nº de falhas, Y = MTTR, escala log, pontos numerados, quadrantes
  Crítico / Crônico / Crítico-crônico / Conforto, por máquina ou por falha, cabeçalho com linha e período.
  Linhas de corte pelo método padrão, o mesmo do exemplo do descritivo: Q = total de falhas ÷ nº de itens;
  MTTR = tempo total ÷ total de falhas.
- **Tabelas** de máquinas e de falhas com no mínimo 40 linhas numeradas, T (min) do maior para o menor,
  Q, MTTR, T.T.A, %, 80% e categoria automática.
- **Exportar Excel**: a planilha original completa com a coluna **Classificação** (nenhuma coluna muda de
  letra; fórmulas e filtros preservados). Gráficos em PNG/PDF. **Comparar** dois períodos. **Montar dashboard** manual.

**5. Desempenho da ML** (barra lateral): acerto por planilha finalizada (curva), acerto do modelo em teste
cego a cada treino e tamanho da memória de correções.

## Como os números são calculados

**Q (quantidade de falhas).** O SAP fatia uma parada longa em linhas de 1 h. O dashboard tem as duas
contagens: **Falhas reais** (padrão: mesma O.S. na mesma máquina = 1 falha; sem O.S., linhas encostadas com
o mesmo relato = 1 falha) e **Linhas do SAP** (cada vez que a máquina aparece na coluna J conta 1, como no
item 2.2 do descritivo). O tempo de parada é sempre a soma de todas as linhas; mudam o Q e o MTTR.

**Acerto da ML.** Medido, nunca estimado: (a) por planilha — a classe sugerida quando a planilha chegou
contra a classe final validada pelo analista; (b) do modelo — treina com 80% dos relatos validados e é
testado nos 20% que não viu. Num teste cego com 1.020 relatos reais de Marília, no padrão do descritivo:
catálogo 75%, catálogo + modelo treinado 87%.

## Machine learning (100% local)

TF-IDF de palavras e de pedaços de palavras (tolera erro de digitação) + a máquina como contexto, com
regressão logística (scikit-learn). Aprende com: planilhas finalizadas no quadro, memória de correções e,
opcionalmente, planilhas antigas já classificadas pelos analistas (colunas “Observações” e “Classificação…”)
colocadas na pasta `planilhas modelo/plhanilha treinamento de ml` (ou `KOFBR_ML_TRAIN_DIR`). Com pelo menos
200 exemplos, quando o modelo tem 60%+ de certeza ele pode corrigir o catálogo. Modelo salvo em
`data/aprendizado.joblib`.

## Desempenho medido

| Planilha | Importar | Abrir o quadro | Cada ação |
|---|---|---|---|
| 3 mil linhas | ~5 s | ~0,3 s | ~0,4 s |
| 15 mil linhas | ~36 s | ~1,4 s | ~2 s |

Para a planilha mensal completa (~94 mil linhas), importe por período (semana ou quinzena).

## Testes

`python -m pytest tests` (pytest à parte). Usam o mesmo MySQL do `.env`, num banco descartável
`kofbr_teste_*` criado e apagado a cada teste (sem MySQL acessível, os testes são pulados). Cobrem: exemplos do descritivo (itens 1.3), regras de agrupamento,
Pareto e Jack-Knife conferidos com cálculo à mão, sino, desfazer/refazer, aprendizado e exportações.

## Limitações conhecidas

- Uso local, um analista por vez: não há login nem controle de usuários (a tela /login é só de apresentação).
- As rotas `/api/upload`, `/api/clusters`, `/api/dashboard/*` são do fluxo antigo, mantidas por
  compatibilidade; a interface usa `/api/workspace/*`. Os dois usam o mesmo banco MySQL.
