-- Esquema do banco da Central de Postagem.
-- Idempotente: pode rodar varias vezes sem quebrar (CREATE ... IF NOT EXISTS + ALTER guardados).

-- Clientes (a empresa/loja do cliente).
CREATE TABLE IF NOT EXISTS clientes (
  id           SERIAL PRIMARY KEY,
  nome         TEXT NOT NULL,
  email        TEXT,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usuarios do sistema (admin, cliente, representante, funcionario).
CREATE TABLE IF NOT EXISTS usuarios (
  id           SERIAL PRIMARY KEY,
  nome         TEXT NOT NULL,
  login        TEXT NOT NULL UNIQUE,
  senha_hash   TEXT NOT NULL,
  papel        TEXT NOT NULL,
  cliente_id   INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Papeis aceitos (recria a constraint de forma idempotente).
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_papel_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_papel_check
  CHECK (papel IN ('admin','operador','cliente','representante','funcionario'));
-- 'operador' = administrador operacional: tudo do admin, menos custos/lucros de produto e comissoes/taxas.

-- Colunas extras por papel:
--   representante: comissao_bps  (comissao padrao em pontos-base: 1% = 100, 5% = 500)
--   funcionario:   taxa_etiqueta_centavos (valor fixo por etiqueta, em centavos)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS comissao_bps INTEGER;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS taxa_etiqueta_centavos INTEGER;

-- Catalogo de produtos.
CREATE TABLE IF NOT EXISTS produtos (
  id           SERIAL PRIMARY KEY,
  nome         TEXT NOT NULL,
  descricao    TEXT,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Precos negociados por cliente (itens). Cada item liga um produto do catalogo a um cliente.
CREATE TABLE IF NOT EXISTS itens (
  id             SERIAL PRIMARY KEY,
  cliente_id     INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE itens ADD COLUMN IF NOT EXISTS produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL;

-- Sequencia para o numero do pedido.
CREATE SEQUENCE IF NOT EXISTS pedido_numero_seq START 1042;

-- Pedidos.
CREATE TABLE IF NOT EXISTS pedidos (
  id                 SERIAL PRIMARY KEY,
  numero             TEXT NOT NULL UNIQUE,
  cliente_id         INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  usuario_id         INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'aguardando',
  total_centavos     INTEGER NOT NULL DEFAULT 0,
  total_etiquetas    INTEGER NOT NULL DEFAULT 0,
  aceite_em          TIMESTAMPTZ,
  aceite_ip          TEXT,
  etiquetas_expira_em TIMESTAMPTZ,
  preparando_em      TIMESTAMPTZ,
  despachado_em      TIMESTAMPTZ,
  comprovante        BYTEA,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Status aceitos: aguardando -> separacao -> despachado.
-- Mantemos 'preparando' na lista por compatibilidade com pedidos antigos (evita falha na constraint no boot).
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_status_check;
ALTER TABLE pedidos ADD CONSTRAINT pedidos_status_check
  CHECK (status IN ('aguardando','preparando','separacao','despachado'));

-- Comissao do representante (definida no pedido pelo admin).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS representante_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comissao_bps INTEGER;          -- % aplicada neste pedido (pontos-base)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comissao_centavos INTEGER;     -- valor da comissao calculado
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS preparando_em TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS separacao_em TIMESTAMPTZ;   -- quando a separacao (bipagem) foi concluida

-- Arquivos de etiqueta enviados.
CREATE TABLE IF NOT EXISTS arquivos (
  id           SERIAL PRIMARY KEY,
  pedido_id    INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
  usuario_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  nome         TEXT NOT NULL,
  paginas      INTEGER NOT NULL DEFAULT 0,
  conteudo     BYTEA NOT NULL,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Codigos lidos do PDF no upload (um conjunto por pagina): [{"br":"...","nfe":"..."}, ...]
ALTER TABLE arquivos ADD COLUMN IF NOT EXISTS codigos JSONB;

-- Linhas do pedido.
CREATE TABLE IF NOT EXISTS linhas (
  id             SERIAL PRIMARY KEY,
  pedido_id      INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  arquivo_id     INTEGER REFERENCES arquivos(id) ON DELETE SET NULL,
  item_id        INTEGER REFERENCES itens(id) ON DELETE SET NULL,
  item_nome      TEXT NOT NULL,
  arquivo_nome   TEXT NOT NULL,
  preco_centavos INTEGER NOT NULL,
  quantidade     INTEGER NOT NULL CHECK (quantidade > 0),
  total_centavos INTEGER NOT NULL
);

-- Etiquetas individuais (uma por unidade), com codigo proprio para bipagem futura.
CREATE TABLE IF NOT EXISTS etiquetas (
  id           SERIAL PRIMARY KEY,
  pedido_id    INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  linha_id     INTEGER REFERENCES linhas(id) ON DELETE CASCADE,
  codigo       TEXT NOT NULL UNIQUE,
  indice       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','conferido','despachado')),
  conferido_em TIMESTAMPTZ,
  despachado_em TIMESTAMPTZ
);

-- Codigo de barras da etiqueta, lido do PDF no upload (o que o leitor do operador bipa).
--   codigo_externo = codigo de rastreio (ex.: BR...); codigo_nfe = chave da nota (44 digitos).
-- Na bipagem aceitamos qualquer um dos dois.
ALTER TABLE etiquetas ADD COLUMN IF NOT EXISTS codigo_externo TEXT;
ALTER TABLE etiquetas ADD COLUMN IF NOT EXISTS codigo_nfe TEXT;
CREATE INDEX IF NOT EXISTS idx_etiquetas_codigo_externo ON etiquetas(codigo_externo);
CREATE INDEX IF NOT EXISTS idx_etiquetas_codigo_nfe ON etiquetas(codigo_nfe);

CREATE INDEX IF NOT EXISTS idx_itens_cliente ON itens(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_representante ON pedidos(representante_id);
CREATE INDEX IF NOT EXISTS idx_linhas_pedido ON linhas(pedido_id);
CREATE INDEX IF NOT EXISTS idx_etiquetas_pedido ON etiquetas(pedido_id);

-- ===================== FINANCEIRO =====================
-- Prazo de pagamento do cliente (dias apos o aceite) usado para calcular o vencimento.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS prazo_dias INTEGER NOT NULL DEFAULT 7;

-- Um lancamento por pedido, criado no aceite com o valor total do pedido.
-- Situacao "vencido" nao e gravada: e calculada pela data (aberto + vencimento < hoje).
CREATE TABLE IF NOT EXISTS financeiro (
  id              SERIAL PRIMARY KEY,
  pedido_id       INTEGER NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
  cliente_id      INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  valor_centavos  INTEGER NOT NULL CHECK (valor_centavos >= 0),
  vencimento      DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','pago','cancelado')),
  pago_em         TIMESTAMPTZ,
  forma_pagamento TEXT,
  observacao      TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financeiro_cliente ON financeiro(cliente_id);
CREATE INDEX IF NOT EXISTS idx_financeiro_vencimento ON financeiro(vencimento);

-- Pedidos criados antes do financeiro existir ganham lancamento em aberto (idempotente).
INSERT INTO financeiro (pedido_id, cliente_id, valor_centavos, vencimento)
SELECT p.id, p.cliente_id, p.total_centavos,
       (COALESCE(p.aceite_em, p.criado_em) AT TIME ZONE 'America/Sao_Paulo')::date + c.prazo_dias
FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
WHERE NOT EXISTS (SELECT 1 FROM financeiro f WHERE f.pedido_id = p.id);

-- Limite de credito do cliente: o que esta em aberto/vencido no financeiro consome o limite;
-- o pagamento libera. NULL = sem controle. bloquear_vencido = com pedido vencido, nao aceita envio novo.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS limite_centavos INTEGER CHECK (limite_centavos IS NULL OR limite_centavos >= 0);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bloquear_vencido BOOLEAN NOT NULL DEFAULT TRUE;

-- Promocao no preco negociado (itens): 'valor' = preco promocional fixo em centavos;
-- 'percentual' = desconto em pontos-base sobre o preco. Vale entre promo_inicio e promo_fim (inclusive).
ALTER TABLE itens ADD COLUMN IF NOT EXISTS promo_tipo TEXT CHECK (promo_tipo IS NULL OR promo_tipo IN ('valor','percentual'));
ALTER TABLE itens ADD COLUMN IF NOT EXISTS promo_valor INTEGER;
ALTER TABLE itens ADD COLUMN IF NOT EXISTS promo_inicio DATE;
ALTER TABLE itens ADD COLUMN IF NOT EXISTS promo_fim DATE;

-- ===================== ENCERRAMENTO E CREDITO EM CONTA =====================
-- Etiqueta que ficou para tras quando o admin encerrou o pedido: nao e cobrada.
ALTER TABLE etiquetas DROP CONSTRAINT IF EXISTS etiquetas_status_check;
ALTER TABLE etiquetas ADD CONSTRAINT etiquetas_status_check
  CHECK (status IN ('pendente','conferido','despachado','nao_enviada'));
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS encerrado_em TIMESTAMPTZ;

-- Credito em conta do cliente (sobra de pedido ja pago, abate o proximo aceite).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS credito_centavos INTEGER NOT NULL DEFAULT 0;

-- Historico do lancamento: valor reservado no aceite, etiquetas cobradas, credito gerado/usado.
ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS valor_original_centavos INTEGER;
ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS etiquetas_total INTEGER;
ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS etiquetas_cobradas INTEGER;
ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS credito_gerado_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS credito_usado_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE financeiro ADD COLUMN IF NOT EXISTS encerrado_em TIMESTAMPTZ;
UPDATE financeiro f SET valor_original_centavos = f.valor_centavos WHERE f.valor_original_centavos IS NULL;
UPDATE financeiro f SET etiquetas_total = p.total_etiquetas FROM pedidos p WHERE p.id = f.pedido_id AND f.etiquetas_total IS NULL;

-- ===================== SKU E CORES =====================
-- SKU base do produto (opcional). Cada cor tem um sufixo e vira um SKU proprio (base-sufixo).
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS sku TEXT;
CREATE TABLE IF NOT EXISTS produto_cores (
  id          SERIAL PRIMARY KEY,
  produto_id  INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  sufixo      TEXT,
  ordem       INTEGER NOT NULL DEFAULT 0,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (produto_id, nome)
);
CREATE INDEX IF NOT EXISTS idx_produto_cores_produto ON produto_cores(produto_id);
-- Cor escolhida pelo cliente na linha do pedido (item_nome ja vem como "Produto · Cor").
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS cor_id INTEGER REFERENCES produto_cores(id) ON DELETE SET NULL;
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS cor_nome TEXT;
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS sku TEXT;

-- O SKU e da cor (codigo completo), nao do produto. Migra o que ja foi cadastrado como base-sufixo.
ALTER TABLE produto_cores ADD COLUMN IF NOT EXISTS sku TEXT;
UPDATE produto_cores c SET sku = CASE WHEN p.sku IS NOT NULL AND p.sku <> '' AND c.sufixo IS NOT NULL THEN p.sku || '-' || c.sufixo ELSE c.sufixo END
  FROM produtos p WHERE p.id = c.produto_id AND c.sku IS NULL AND c.sufixo IS NOT NULL;

-- ===================== ESTOQUE =====================
-- Saldo por cor (produto com cores) ou no produto (cor unica). Pode ficar negativo se o
-- despacho passar do estoque lancado: fica em destaque para o admin acertar.
ALTER TABLE produto_cores ADD COLUMN IF NOT EXISTS saldo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS saldo INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS estoque_mov (
  id          SERIAL PRIMARY KEY,
  produto_id  INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  cor_id      INTEGER REFERENCES produto_cores(id) ON DELETE SET NULL,
  cor_nome    TEXT,
  quantidade  INTEGER NOT NULL,            -- positivo entra, negativo sai
  saldo_apos  INTEGER NOT NULL,
  motivo      TEXT NOT NULL,               -- Entrada, Ajuste, Saída manual, Despacho
  observacao  TEXT,
  pedido_id   INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  etiqueta_id INTEGER REFERENCES etiquetas(id) ON DELETE SET NULL,
  usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_estoque_mov_produto ON estoque_mov(produto_id, criado_em DESC);

-- ===================== CUSTO E LUCRO DO PRODUTO =====================
-- Preco sugerido = (custo + taxa do funcionario + lucro desejado) / (1 - % do representante).
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_centavos INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS lucro_centavos INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS rep_bps INTEGER;   -- % do representante usada no calculo (pontos-base)

-- Quem recebe no calculo do preco sugerido: representante (comissao %) e funcionario (taxa por etiqueta),
-- lidos do cadastro de cada um na hora do calculo.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS rep_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS func_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;

-- ===================== REPASSES (representante e funcionario) =====================
-- Funcionario atribuido ao pedido e a taxa por etiqueta na hora da atribuicao.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS funcionario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS taxa_func_centavos INTEGER;
-- Repasse pago ao representante / funcionario (valor, data e forma). NULL = ainda nao pago.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rep_pago_em TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rep_pago_forma TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rep_pago_centavos INTEGER;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS func_pago_em TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS func_pago_forma TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS func_pago_centavos INTEGER;
CREATE INDEX IF NOT EXISTS idx_pedidos_funcionario ON pedidos(funcionario_id);

-- ===================== ESTOQUE: RESERVA =====================
-- Aceite reserva (reservado += qtd), despacho consome (saldo -= 1 e reservado -= 1),
-- encerramento com sobras libera (reservado -= nao enviadas). Disponivel = saldo - reservado.
ALTER TABLE produto_cores ADD COLUMN IF NOT EXISTS reservado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS reservado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE estoque_mov ADD COLUMN IF NOT EXISTS reserva INTEGER NOT NULL DEFAULT 0;      -- delta do reservado
ALTER TABLE estoque_mov ADD COLUMN IF NOT EXISTS reservado_apos INTEGER;
ALTER TABLE estoque_mov ADD COLUMN IF NOT EXISTS linha_id INTEGER REFERENCES linhas(id) ON DELETE SET NULL;

-- Migracao unica: reserva o que ainda falta despachar nos pedidos abertos de antes desta regra.
CREATE TABLE IF NOT EXISTS migracoes (nome TEXT PRIMARY KEY, em TIMESTAMPTZ NOT NULL DEFAULT now());
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM migracoes WHERE nome = 'reserva_inicial') THEN
    -- por linha de pedido aberto: faltam = quantidade - despachadas
    CREATE TEMP TABLE tmp_res AS
      SELECT l.id AS linha_id, l.pedido_id, l.cor_id, l.cor_nome, i.produto_id,
             (l.quantidade - (SELECT count(*) FROM etiquetas e WHERE e.linha_id = l.id AND e.status = 'despachado'))::int AS faltam
      FROM linhas l JOIN pedidos p ON p.id = l.pedido_id LEFT JOIN itens i ON i.id = l.item_id
      WHERE p.status <> 'despachado' AND i.produto_id IS NOT NULL;
    UPDATE produto_cores c SET reservado = c.reservado + s.q
      FROM (SELECT cor_id, sum(faltam)::int AS q FROM tmp_res WHERE cor_id IS NOT NULL AND faltam > 0 GROUP BY cor_id) s
      WHERE c.id = s.cor_id;
    UPDATE produtos pr SET reservado = pr.reservado + s.q
      FROM (SELECT produto_id, sum(faltam)::int AS q FROM tmp_res WHERE cor_id IS NULL AND faltam > 0 GROUP BY produto_id) s
      WHERE pr.id = s.produto_id;
    INSERT INTO estoque_mov (produto_id, cor_id, cor_nome, quantidade, reserva, saldo_apos, reservado_apos, motivo, observacao, pedido_id, linha_id)
      SELECT t.produto_id, t.cor_id, t.cor_nome, 0, t.faltam,
             COALESCE(c.saldo, pr.saldo), COALESCE(c.reservado, pr.reservado),
             'Reserva', 'pedido aberto antes da regra de reserva', t.pedido_id, t.linha_id
      FROM tmp_res t LEFT JOIN produto_cores c ON c.id = t.cor_id JOIN produtos pr ON pr.id = t.produto_id
      WHERE t.faltam > 0;
    DROP TABLE tmp_res;
    INSERT INTO migracoes (nome) VALUES ('reserva_inicial');
  END IF;
END $$;

-- ===================== PRECO PADRAO = SUGERIDO; NEGOCIACAO POR CLIENTE =====================
-- itens.negociado = TRUE: preco negociado para o cliente (substitui o sugerido).
-- FALSE: vinculo criado automaticamente no aceite, so para ligar linhas/etiquetas ao produto;
-- o preco cobrado e o sugerido do produto no momento do aceite.
ALTER TABLE itens ADD COLUMN IF NOT EXISTS negociado BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_itens_cliente_produto ON itens(cliente_id, produto_id);

-- Peso e medidas do produto (informativo para o cliente na aba Estoque).
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_gramas INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS medidas TEXT;

-- Presenca: ultimo acesso de cada usuario (para "online agora" no admin).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS visto_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultima_pagina TEXT;

-- ===================== NOVIDADES (feed do cliente) =====================
-- Eventos gerados pelo sistema: produto liberado, cor nova, estoque reposto/esgotado, promocao,
-- negociacao, pedido e pagamento. cliente_id NULL = vale para todos os clientes.
CREATE TABLE IF NOT EXISTS novidades (
  id          SERIAL PRIMARY KEY,
  tipo        TEXT NOT NULL,                -- produto | cor | reposto | esgotou | promo | negociado | pedido | financeiro
  cliente_id  INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  produto_id  INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  pedido_id   INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
  titulo      TEXT NOT NULL,
  detalhe     TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_novidades_tempo ON novidades(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_novidades_cliente ON novidades(cliente_id, criado_em DESC);

-- WhatsApp do cliente (so digitos, com DDD) para enviar o acesso e avisos.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefone TEXT;

-- Imagens do produto (guardadas no banco: o disco do Railway e apagado a cada deploy).
CREATE TABLE IF NOT EXISTS produto_imagens (
  id         SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  nome       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  tamanho    INTEGER NOT NULL,
  dados      BYTEA NOT NULL,
  ordem      INTEGER NOT NULL DEFAULT 0,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_produto_imagens_produto ON produto_imagens(produto_id);
