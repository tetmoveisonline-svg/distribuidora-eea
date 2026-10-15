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
  CHECK (papel IN ('admin','cliente','representante','funcionario'));

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
