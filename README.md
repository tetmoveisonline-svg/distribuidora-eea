# Central de Postagem

Sistema de dropshipping/postagem: o cliente sobe as etiquetas (PDF térmico, 1 por página),
o sistema conta as páginas (= quantidade de etiquetas), o cliente escolhe o item com preço
negociado, revisa, aceita e gera um comprovante em PDF. O admin recebe os pedidos, baixa as
etiquetas (com validade de 72h) e o comprovante (permanente), e marca como despachado.

Stack: Node.js + Express + PostgreSQL. Views em EJS. PDFs com pdfkit (comprovante) e pdf-lib
(contagem e junção de etiquetas). Sessão no Postgres (connect-pg-simple).

Esta é a Parte 1 (base + fluxo do cliente + admin mínimo de pedidos). Bipagem (entrada/saída)
e os cadastros CRUD de clientes/itens vêm nas próximas partes.

## O que já funciona

- Login (cliente e admin no mesmo formulário; o papel vem do cadastro).
- Cliente: Novo envio (upload, detecção de páginas, item + preço, quantidade no -/+, totais),
  Revisar, Aceitar e gerar comprovante PDF, Meus envios (histórico com regra de 72h).
- Admin: Pedidos recebidos, baixar etiquetas (72h) e comprovante, marcar despachado.
- Seletor de 5 temas (Escuro Minimal, Grafite Quente, Midnight Corporativo, Claro Corporativo,
  Indústria/Terminal), salvo no navegador, com anti-flash.
- Códigos por etiqueta (ex.: DS-1042-01) já gravados para a bipagem da próxima parte.

## Rodando localmente

1. Instale as dependências:

   npm install

2. Tenha um PostgreSQL rodando e crie um banco. Copie `.env.example` para `.env` e ajuste
   `DATABASE_URL` e `SESSION_SECRET`.

3. Crie o admin (e, opcionalmente, um cliente de demonstração com itens):

   npm run seed            # cria só o admin (login/senha do .env)
   npm run seed -- --demo  # cria também o cliente demo (login: cliente / senha: cliente123)

4. Suba o servidor:

   npm start

   Acesse http://localhost:3000

## Deploy no Railway

1. Crie um novo projeto no Railway e conecte este repositório (novo, separado dos outros).
2. Adicione o plugin PostgreSQL (banco próprio para este sistema).
3. Configure as variáveis de ambiente (ver `.env.example`). O Railway já injeta `PORT` e
   `DATABASE_URL`. Defina pelo menos `SESSION_SECRET`, `NODE_ENV=production`, os dados da
   empresa e as credenciais do admin.
4. O `start` do projeto é `node src/server.js`. O esquema do banco é criado automaticamente no
   primeiro boot.
5. Rode o seed uma vez (via aba de comandos/one-off do Railway ou localmente apontando para o
   banco de produção):

   npm run seed

## Variáveis de ambiente

Veja `.env.example`. Destaques:

- `DATABASE_URL` — conexão do Postgres (Railway injeta).
- `SESSION_SECRET` — segredo da sessão (troque por algo aleatório e longo).
- `ADMIN_LOGIN` / `ADMIN_SENHA` — credenciais criadas pelo seed.
- `EMPRESA_NOME` / `EMPRESA_CNPJ` / `EMPRESA_CONTATO` — cabeçalho do comprovante.
- `COMPROVANTE_FORMA_PAGAMENTO` / `COMPROVANTE_PRAZO_DESPACHO` — textos do comprovante.

## Observações

- Os arquivos das etiquetas e o comprovante são guardados no próprio Postgres (BYTEA), para
  sobreviver a reinícios no Railway sem precisar de storage externo.
- As etiquetas expiram 72h após o aceite (bloqueio no download). O comprovante é permanente.
- Ainda não há cadastro de clientes/itens pela interface (Parte seguinte). Use o seed `--demo`
  ou insira manualmente para testar o fluxo do cliente.
