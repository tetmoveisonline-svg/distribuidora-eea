# Arquitetura — A4 Móveis Distribuidora (distribuidora-eea)

Commit revisado: `3e442fb` (worktree tratado como a revisão em análise).
Escopo: `src/` e `views/` (o código real) e `package.json`. Os arquivos `*.js`/`*.ejs` soltos na raiz do repositório são cópias antigas duplicadas e foram ignorados; o ponto de entrada é `src/server.js`.

## Pilha
- Node.js + Express 4 (`src/server.js`), views em EJS (`views/`), sessão em `express-session` com store em PostgreSQL (`connect-pg-simple`).
- PostgreSQL via `pg` (`src/db.js`, esquema idempotente em `src/schema.sql`).
- Upload de arquivos com `multer` (memória); PDFs gerados com `pdfkit`/`pdf-lib`.
- Hospedagem: Railway, atrás de proxy (`app.set('trust proxy', 1)`). Domínio: distribuidoraeea.up.railway.app.

## Papéis e fronteiras de confiança
- `admin` (admin completo): vê custos, lucros, comissões, repasses; ações sensíveis.
- `operador` (admin operacional): área administrativa, mas sem custos/comissões (controlado por `exigeAdminFull` nas rotas sensíveis e por `isFull` nas views).
- `representante` (e `preposto`): cadastra os próprios clientes, vê suas comissões.
- `funcionario`: vê pedidos e a própria taxa.
- `cliente`: sobe etiquetas (PDF), cria pedidos, vê estoque/financeiro só do próprio cadastro.
- Não autenticado: apenas `/login`.

Middlewares em `src/auth.js`: `exigeLogin`, `exigeAdmin`, `exigeAdminFull`, `exigeCliente`, `exigeRepresentante`, `exigeFuncionario`.

## Entradas de dados
- Formulários HTML (POST urlencoded) e algumas chamadas `fetch` (JSON) nas áreas admin/cliente.
- Upload de PDFs de etiquetas (cliente) e imagens de produto (admin).
- Parâmetros de rota/query (ids, filtros de mês/situação) — convertidos por `pInt`/regex.

## Isolamento de dados (multi-cliente)
- Todas as consultas da área do cliente são escopadas por `cliente_id` ou `usuario_id` da sessão (`src/routes/cliente.js`, `src/routes/bipagem.js`). Não foi encontrado IDOR.
- Documentos (comprovante, etiquetas) são baixados com filtro por `cliente_id` na área do cliente.

## Observações de postura (positivas)
- SQL sempre parametrizado (`$1..$n`); os únicos identificadores interpolados vêm de constantes internas escolhidas por `tipo` em whitelist (`src/repasses.js`).
- Senhas com `bcrypt`; sessão server-side (o cookie carrega só o id assinado).
- Saída EJS escapada (`<%=`) na maioria dos pontos, inclusive nomes controlados por usuário nas páginas de admin.
- Cookie de sessão `httpOnly` e `SameSite=Lax` (mitiga CSRF de POST entre sites).
- Exclusões sensíveis (pedido, cliente) exigem a senha do admin.

## Limites desta passada (perfil quick)
Uma rodada de caça + uma verificação final, com evidência de código e execução local em sandbox isolado com dados fictícios. Fatos de implantação (variáveis de ambiente do Railway, memória da instância, versões instaladas de dependências) não são visíveis no repositório e foram marcados como "precisa validação".
