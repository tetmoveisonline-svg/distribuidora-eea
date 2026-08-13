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

-- Status aceitos: aguardando -> preparando -> despachado.
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_status_check;
ALTER TABLE pedidos ADD CONSTRAINT pedidos_status_check
  CHECK (status IN ('aguardando','preparando','despachado'));

-- Comissao do representante (definida no pedido pelo admin).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS representante_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comissao_bps INTEGER;          -- % aplicada neste pedido (pontos-base)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comissao_centavos INTEGER;     -- valor da comissao calculado
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS preparando_em TIMESTAMPTZ;

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

CREATE INDEX IF NOT EXISTS idx_itens_cliente ON itens(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_representante ON pedidos(representante_id);
CREATE INDEX IF NOT EXISTS idx_linhas_pedido ON linhas(pedido_id);
CREATE INDEX IF NOT EXISTS idx_etiquetas_pedido ON etiquetas(pedido_id);

-- ============ PARTE 3: preco padrao, cores/estoque, desconto ============

-- Produto ganha preco padrao (unico, igual para todos).
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_padrao_centavos INTEGER NOT NULL DEFAULT 0;

-- Cores de cada produto, com estoque por cor.
CREATE TABLE IF NOT EXISTS produto_cores (
  id          SERIAL PRIMARY KEY,
  produto_id  INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  estoque     INTEGER NOT NULL DEFAULT 0,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cores_produto ON produto_cores(produto_id);

-- Desconto padrao do cliente.
--   desconto_tipo:   'pct' (porcentagem) | 'val' (valor) | NULL (sem desconto)
--   desconto_escopo: 'item' (em cada item) | 'total' (no total da compra)
--   desconto_valor:  se pct -> pontos-base (10% = 1000); se val -> centavos
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS desconto_tipo TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS desconto_escopo TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS desconto_valor INTEGER;

-- itens = produtos liberados por cliente. Preco vem do produto (padrao), guardamos snapshot.
-- (produto_id ja existe da Parte 2)

-- Linhas do pedido ganham cor e desconto por item.
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS produto_cor_id INTEGER REFERENCES produto_cores(id) ON DELETE SET NULL;
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS cor_nome TEXT;
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS bruto_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS desconto_tipo TEXT;
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS desconto_valor INTEGER;
ALTER TABLE linhas ADD COLUMN IF NOT EXISTS desconto_centavos INTEGER NOT NULL DEFAULT 0;

-- Pedido ganha os totais de desconto.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS subtotal_centavos INTEGER NOT NULL DEFAULT 0;         -- soma dos brutos
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS desconto_itens_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS desconto_total_tipo TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS desconto_total_valor INTEGER;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS desconto_total_centavos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS observacoes TEXT;
