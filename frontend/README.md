# Interface Gargalo

Node.js 20.9 ou superior.

```bash
npm ci
npm run dev
```

A API Python deve estar na porta 5000. A interface de desenvolvimento abre na porta 3000.

```bash
npm run lint
npm run build
```

`npm run build` gera `out/`, servido por `python run.py` na raiz. O projeto usa exportação estática e navegação por hash; recarregar, voltar e avançar no navegador preservam a página aberta. Consulte o README da raiz para o fluxo, persistência e migração do MySQL.
