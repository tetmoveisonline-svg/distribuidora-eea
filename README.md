# Central de Postagem

Sistema de dropshipping/postagem: o cliente sobe as etiquetas (PDF térmico, 1 por página),
o sistema conta as páginas (= quantidade de etiquetas), o cliente escolhe o item com preço
negociado, revisa, aceita e gera um comprovante em PDF. O admin recebe os pedidos, baixa as
etiquetas (com validade de 72h) e o comprovante (permanente), e marca como despachado.

Stack: Node.js + Express + PostgreSQL. Views em EJS. PDFs com pdfkit (comprovante) e pdf-lib
(contagem e junção de etiquetas). Sessão no Postgres (connect-pg-simple).

Partes 1 e 2 implementadas. Bipagem (entrada/saída) vem numa próxima parte.

## O que já funciona

- Quatro papéis com login próprio: admin, cliente, representante e funcionário.
- Cliente: Novo envio (upload, detecção de páginas, produto + preço, quantidade no -/+, totais),
  Revisar, Aceitar e gerar comprovante PDF, Meus envios com andamento (Aceito → Recebido →
  Em preparação → Despachado) e regra de 72h.
- Admin: Pedidos recebidos (com comissão e taxa), detalhe do pedido com atribuição de
  representante/comissão, avanço de andamento, downloads; cadastros de Clientes, Representantes,
  Funcionários, Produtos e Preços por cliente.
- Comissões: representante ganha percentual sobre o valor (definido no pedido); funcionário ganha
  valor fixo por etiqueta (vê todos os pedidos).
- Visibilidade: funcionário não vê a comissão do representante; o representante vê a taxa do
  funcionário; o admin vê tudo; o cliente não vê comissões.
- Seletor de 5 temas, salvo no navegador, com anti-flash.
- Códigos por etiqueta (ex.: DS-1042-01) já gravados para a bipagem da próxima parte.

## Logins de demonstração (após `npm run seed -- --demo`)

- admin         -> definido por ADMIN_LOGIN / ADMIN_SENHA
- cliente       -> login: cliente        senha: cliente123
- representante -> login: representante   senha: rep123   (comissão padrão 5%)
- funcionario   -> login: funcionario     senha: func123  (taxa R$ 0,10/etiqueta)

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
4. O `start` do projeto é `node src/server.js`. No primeiro boot o esquema do banco é criado
   automaticamente E o admin também é criado automaticamente a partir das variáveis
   `ADMIN_LOGIN` / `ADMIN_SENHA` (não precisa rodar nenhum comando).
5. (Opcional) Para criar um cliente de demonstração com itens, rode localmente apontando para o
   banco de produção: `npm run seed -- --demo`.

## Variáveis de ambiente

Veja `.env.example`. Destaques:

- `DATABASE_URL` — conexão do Postgres (Railway injeta).
- `SESSION_SECRET` — segredo da sessão (troque por algo aleatório e longo).
- `ADMIN_LOGIN` / `ADMIN_SENHA` — credenciais criadas pelo seed.
- `EMPRESA_NOME` / `EMPRESA_CNPJ` / `EMPRESA_CONTATO` — cabeçalho do comprovante.
- `EMPRESA_WHATSAPP` — WhatsApp da distribuidora (só dígitos, com DDI, ex.: 5511999990000). Mostra o botão "Pedir antecipação no WhatsApp" quando o cliente estoura o limite de crédito.
- `COMPROVANTE_FORMA_PAGAMENTO` / `COMPROVANTE_PRAZO_DESPACHO` — textos do comprovante.

## Observações

- Os arquivos das etiquetas e o comprovante são guardados no próprio Postgres (BYTEA), para
  sobreviver a reinícios no Railway sem precisar de storage externo.
- As etiquetas expiram 72h após o aceite (bloqueio no download). O comprovante é permanente.
- Ainda não há cadastro de clientes/itens pela interface (Parte seguinte). Use o seed `--demo`
  ou insira manualmente para testar o fluxo do cliente.

## Dimensionador de bomba de calor (página pública)

Calculadora em `/dimensionamento`, sem login, para profissionais de piscina: 3 etapas (volume,
condições de uso, contato), relatório técnico com equipamento indicado, consumo mês a mês por UF,
pré-seleção de motobomba, impressão em PDF e envio do resumo por WhatsApp.

- Regras de negócio (marca, fatores, catálogo de modelos, motobombas, clima por UF):
  `src/dimensionamento-config.js`. Edite o catálogo ali para usar seus próprios produtos.
- Motor de cálculo puro (navegador e Node): `public/js/dimensionamento-calc.js`.
- Interface: `views/dimensionamento.ejs`, `public/js/dimensionamento.js`, `public/css/dimensionamento.css`.
- Variáveis de ambiente: `DIM_WHATSAPP` (número que recebe o resumo, só dígitos com DDI, ex.
  5511999999999; sem ele o botão de WhatsApp não aparece), `DIM_MARCA` (nome exibido; padrão
  `EMPRESA_NOME`) e `DIM_FABRICANTE` (selo no topo; padrão Syllent).

Fórmula: carga (kcal) = ΔT × volume (L) × fator capa × fator tipo × fator vento + acessórios
(2.000 kcal por m² de prainha/borda infinita e por metro de cascata/borda). A seleção percorre o
catálogo de 1 a 13 máquinas e aceita a primeira combinação com aquecimento diário < 8 h/dia e
primeiro aquecimento < 48 h. Nada é gravado em banco; o lead vai só no texto do WhatsApp.
