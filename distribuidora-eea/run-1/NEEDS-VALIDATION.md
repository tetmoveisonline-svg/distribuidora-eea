# Precisa validação — leads priorizados (sem severidade)

Cada item tem base no código, mas o fato decisivo está fora do repositório (ambiente/runtime). Não são, por si só, vulnerabilidades confirmadas. Não transformar em teste contra produção; usar os planos abaixo.

---

## A. Credenciais padrão de admin (admin/admin123) — `setup-default-admin-credentials`
- **Trace:** `src/bootstrap.js:9` (login→'admin' se ADMIN_LOGIN ausente) → `src/bootstrap.js:14` (senha→'admin123' se ADMIN_SENHA ausente; inserido como papel admin). `src/server.js:97` roda no boot.
- **Fronteira:** não autenticado → admin completo.
- **Bloqueio:** se ADMIN_SENHA foi definido no 1º deploy e se a senha foi trocada depois — fato de produção.
- **Plano (dono, não destrutivo):** tentar entrar na produção com `admin`/`admin123`; se entrar, trocar a senha imediatamente e definir `ADMIN_SENHA`; revisar a tabela `usuarios` por admins nunca alterados.
- **Plano local:** banco descartável sem `ADMIN_*` → confirmar que admin/admin123 entra (já observado localmente).

## B. Segredo de sessão padrão + sessão não regenerada — `session-default-secret-no-regenerate`
- **Trace:** `src/server.js:25` (secret cai para constante pública) → `src/routes/auth.js:43` (define `req.session.user` sem `regenerate()`) → `src/server.js:24` (store server-side: segredo conhecido forja só o id assinado).
- **Fronteira:** atacante → sessão (via fixação).
- **Bloqueio:** SESSION_SECRET está definido em produção? Existe vetor de plantio de cookie (subdomínio, MITM sobre cookie sem Secure)?
- **Plano (deploy):** garantir `SESSION_SECRET` longo e aleatório no Railway; se ausente, definir e republicar (invalida sessões).
- **Plano local:** com o segredo padrão, assinar um `connect.sid` para um id escolhido, plantá-lo antes do login e verificar que o id não é rotacionado.

## C. Flag Secure do cookie depende de NODE_ENV — `session-cookie-secure-depends-nodeenv`
- **Trace:** `src/server.js:31` — `secure: process.env.NODE_ENV === 'production'`.
- **Fronteira:** transporte de rede → sessão.
- **Bloqueio:** NODE_ENV=production está definido no Railway?
- **Plano (deploy):** conferir `NODE_ENV=production` e inspecionar o `Set-Cookie` do site ao vivo quanto ao atributo `Secure`.
- **Plano local:** subir sem NODE_ENV e confirmar cookie sem `Secure` (já observado).

## D. Upload em memória sem limite agregado (~750MB) — `upload-memory-unbounded-oom`
- **Trace:** `src/routes/cliente.js:90` (POST /api/upload, até 30 arquivos) → `:39` (memoryStorage, 25MB×30) → `:100` (`contarPaginas(f.buffer)` lê inteiro). Segundo upload em memória em `src/imagens.js:9` (6MB×8, admin).
- **Fronteira:** cliente autenticado → serviço (disponibilidade).
- **Bloqueio:** a RAM da instância aguenta 30×25MB por pedido e a concorrência correspondente?
- **Plano local (sandbox):** enviar 30 arquivos de ~25MB e medir o pico de RSS (aproxima ~750MB/pedido).
- **Plano (deploy):** confirmar o limite de memória no Railway; considerar limite agregado por requisição e/ou streaming para disco/objeto.

## E. Dependências transitivas do Express com advisories — `deps-express-transitive-advisories`
- **Trace:** `package.json:18` (express ^4.19.2) → `src/server.js:20` (express.urlencoded/json; `:15` trust proxy).
- **Fronteira:** cadeia de suprimentos.
- **Evidência de apoio:** `npm audit` (deps de produção) no sandbox do audit reportou 1 crítico (proxy-addr, IP spoofing via subnet IPv4-mapeada em IPv6), 2 altos (body-parser DoS; brace-expansion DoS), 1 moderado (qs DoS). Caminhos (trust proxy, parsing de corpo/query) são usados.
- **Bloqueio:** versões instaladas exatas e exploração concreta nesta implantação não comprovadas.
- **Plano local:** `npm audit` / `npm audit fix`, subir o express para a última 4.x (ou avaliar 5.x), reexecutar testes.
- **Plano (deploy):** republicar e rodar `npm audit` no CI até zerar os advisories conhecidos.
