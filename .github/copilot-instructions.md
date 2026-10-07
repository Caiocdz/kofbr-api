# KOFBR: instrucoes para contribuicoes assistidas por Copilot

## Arquitetura

- `app.py` registra os blueprints Flask e os headers CORS.
- `routes/upload.py` importa a planilha SAP como registros `pending`.
- `dedup.py` apenas **sugere** grupos; nao deve confirmar ou alterar um
  registro automaticamente.
- `routes/clusters.py` e a unica camada que confirma um grupo, dentro de uma
  transacao, depois de uma decisao humana na interface.
- O banco e MySQL via PyMySQL (config em `.env` / `KOFBR_DB_*`; padrao
  root:root@localhost:3306/kofbr). As queries da aplicacao usam `?`; `db.py`
  traduz para o placeholder `%s` do driver. Nao existe mais SQLite.

## Regras de negocio obrigatorias

1. Nunca agrupar registros sem `linha` e `equipamento` preenchidos.
2. Nunca misturar contextos: centro, linha, equipamento, tipo de parada,
   subchave e sistema precisam ser compativeis.
3. Similaridade e sinonimos criam somente propostas. A associacao a
   `canonical_failures` exige `POST /api/clusters/<id>/confirm`.
4. Ao confirmar, remova os registros confirmados de qualquer proposta
   pendente sobreposta; a lista e o contador devem refletir a fonte de
   verdade do banco.
5. Rotas que escrevem no banco precisam usar `commit`, fazer `rollback` em
   caso de excecao e fechar a conexao.

## Interface e verificacao

- Antes de confirmar, ofereca uma forma de ver as observacoes originais e
  uma confirmacao explicita para agrupar todos os membros.
- Nao remova cards da tela por suposicao: aguarde a resposta HTTP, confira
  `response.ok` e recarregue a lista da API.
- Preserve os textos em UTF-8.
- Rode antes de entregar: `python -m py_compile app.py db.py parsing.py dedup.py routes/*.py`.
- Para mudar a regra de agrupamento, inclua casos representando: mesma falha
  no mesmo contexto, mesma descricao em contexto diferente e frases parecidas
  com causas distintas.
