-- Esquema do banco da Central de Postagem.
-- Idempotente: pode rodar varias vezes sem quebrar (CREATE ... IF NOT EXISTS).

-- Clientes (a empresa/loja do cliente).
CREATE TABLE IF NOT EXISTS clientes (
  id           SERIAL PRIMARY KEY,
  nome         TEXT NOT NULL,
  email        TEXT,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usuarios do sistema (admin ou cliente). Cliente aponta para clientes.id.
CREATE TABLE IF NOT EXISTS usuarios (
  id           SERIAL PRIMARY KEY,
  nome         TEXT NOT NULL,
  login        TEXT NOT NULL UNIQUE,
  senha_hash   TEXT NOT NULL,
  papel        TEXT NOT NULL CHECK (papel IN ('admin','cliente')),
  cliente_id   INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Itens com preco negociado por cliente (so o admin cadastra).
CREATE TABLE IF NOT EXISTS itens (
  id             SERIAL PRIMARY KEY,
  cliente_id     INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sequencia para o numero do pedido (comeca em 1042 pra ficar tipo #DS-1042).
CREATE SEQUENCE IF NOT EXISTS pedido_numero_seq START 1042;

-- Pedidos (um "envio" aceito pelo cliente).
CREATE TABLE IF NOT EXISTS pedidos (
  id                 SERIAL PRIMARY KEY,
  numero             TEXT NOT NULL UNIQUE,
  cliente_id         INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  usuario_id         INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando','despachado')),
  total_centavos     INTEGER NOT NULL DEFAULT 0,
  total_etiquetas    INTEGER NOT NULL DEFAULT 0,
  aceite_em          TIMESTAMPTZ,
  aceite_ip          TEXT,
  etiquetas_expira_em TIMESTAMPTZ,
  despachado_em      TIMESTAMPTZ,
  comprovante        BYTEA,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Arquivos de etiqueta enviados. Enquanto o pedido nao e criado, pedido_id fica nulo (pendente).
CREATE TABLE IF NOT EXISTS arquivos (
  id           SERIAL PRIMARY KEY,
  pedido_id    INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
  usuario_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  nome         TEXT NOT NULL,
  paginas      INTEGER NOT NULL DEFAULT 0,
  conteudo     BYTEA NOT NULL,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Linhas do pedido: cada arquivo com um item, quantidade e valores.
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
CREATE INDEX IF NOT EXISTS idx_linhas_pedido ON linhas(pedido_id);
CREATE INDEX IF NOT EXISTS idx_etiquetas_pedido ON etiquetas(pedido_id);
