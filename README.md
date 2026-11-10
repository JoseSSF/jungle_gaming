# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) recebidas de provedores por **HTTP** e por **SQS**, permanecendo correto com mensagens
duplicadas, fora de ordem, processadas simultaneamente por várias instâncias e com processos morrendo
no pior momento.

**Stack:** Bun 1.x · TypeScript estrito · NestJS 11 · MikroORM 6 · PostgreSQL 17 · AWS SQS via
MiniStack · Keycloak 26 · Docker Compose.

> Decisões, trade-offs e limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Pré-requisitos

- **Docker** com Docker Compose v2
- **Bun ≥ 1.1** (`npm i -g bun` ou https://bun.sh) — necessário para rodar testes/scripts no host

## Subir tudo (3 instâncias + nginx)

```bash
docker compose up -d --build
```

Sobe `postgres`, `ministack` (SQS), `keycloak`, roda `migrate` e `sqs-init` (one-shot) e então
**3 réplicas** da aplicação atrás do `lb` (nginx) em `http://localhost:3000`.

| Serviço | Porta host | Observação |
|---|---|---|
| API (nginx → 3 réplicas) | 3000 | todas as réplicas rodam HTTP + consumer + relay da outbox + worker |
| PostgreSQL | 5432 | `wagering/wagering`, bancos `wagering` e `wagering_test` |
| MiniStack (SQS) | 4566 | filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo` |
| Keycloak | 8080 | admin `admin/admin`, realm `jungle` |

Para desligar a autenticação: `AUTH_MODE=disabled docker compose up -d --build`.

```bash
docker compose logs -f app        # logs JSON das 3 réplicas
docker compose down -v            # derruba tudo e apaga os volumes
```

## Rodar a aplicação no host (desenvolvimento)

```bash
bun install
docker compose up -d postgres ministack keycloak
bun run migration:up
bun run start                      # http://localhost:3000, AUTH_MODE=disabled por padrão
```

Configuração por variáveis de ambiente — ver [.env.example](.env.example). As principais:

| Variável | Padrão | |
|---|---|---|
| `WORKERS` | `consumer,outbox,pending-references` | papéis em background (`none` = só HTTP) |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | |
| `WALLET_LOCK_TIMEOUT_MS` | `3000` | espera máxima pelo lock da wallet |
| `SQS_ENDPOINT` | `http://localhost:4566` | |
| `SQS_MAX_ATTEMPTS` | `5` | tentativas antes da DLQ |
| `PENDING_REFERENCE_MAX_ATTEMPTS` / `_TTL_MS` | `12` / `900000` | limite para referências ausentes |
| `AUTH_MODE` | `disabled` (host) / `keycloak` (compose) | |

### Migrations (versionadas e reversíveis)

```bash
bun run migration:up
```

```bash
bun run migration:down
```

```bash
bun run migration:status
```

---

## Usando a API

### Tokens (Keycloak, `client_credentials`)

```bash
export OPERATOR=$(bun run auth:token -- backoffice)
export PROVIDER=$(bun run auth:token -- provider-a)
```

Clientes locais: `provider-a`, `provider-b` (papel `wagering-provider`, claim `provider_id`) e
`backoffice` (papel `wagering-operator`). Com `AUTH_MODE=disabled` omita o header `Authorization`.

### Criar wallet

```bash
curl -s -X POST localhost:3000/wallets -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

### Submeter transação

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H "authorization: Bearer $PROVIDER" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{ "transactionId": "0192f298-…", "status": "PROCESSED", "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

### Endpoints

| Método | Rota | Papel | |
|---|---|---|---|
| `POST` | `/wallets` | operator | `201`; `409 WALLET_ALREADY_EXISTS` |
| `GET` | `/wallets/:walletId` | operator, provider | |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | operator | cursor opaco e estável (keyset por `walletVersion`), mais recente primeiro |
| `POST` | `/wallets/:walletId/reconciliation` | operator | saldo armazenado × reconstruído pelo ledger |
| `POST` | `/wagering/transactions` | provider | header `Idempotency-Key` obrigatório |
| `GET` | `/wagering/transactions/:transactionId` | provider (dono), operator | |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | provider (dono), operator | |
| `GET` | `/health/live`, `/health/ready` | público | readiness checa PostgreSQL e SQS |
| `GET` | `/metrics` | público | Prometheus |

**Status HTTP** (consistentes em todos os endpoints): `201` processada · `202` pendente de referência
· `400` payload inválido · `401/403` auth · `404` não encontrado · `409` conflito de idempotência ·
`422` rejeição de negócio (com `failureCode` e `providerAction`) · `503` falha transitória
(`retryable: true`, reenvie com a **mesma** chave) · `500` falha permanente (`PROCESSING_FAILED`).
Replays devolvem a mesma resposta com `idempotentReplay: true` e header `Idempotent-Replayed: true`.

### Enviar pela fila

```bash
bun run sqs:send -- --wallet <walletId> --player <playerId> --kind BET --amount 25.00
```

Formato da mensagem: ver seção 10 do enunciado (`data.idempotencyKey` obrigatório; `correlationId`
opcional no envelope).

---

## Testes

Unidade (sem infraestrutura):

```bash
bun run test:unit
```

Integração e concorrência usam **PostgreSQL e MiniStack reais** (nada de mocks). Suba a infra e rode:

```bash
docker compose up -d postgres ministack keycloak
```

```bash
bun run test:integration
```

```bash
bun run test:concurrency
```

```bash
bun run test
```

- O banco `wagering_test` é recriado (schema dropado + migrations) a cada execução; cada arquivo usa
  filas SQS próprias (`t-<arquivo>-<id>-*.fifo`).
- Os testes de concorrência sobem **processos separados** (`bun run src/main.ts`) — ≥ 3 instâncias,
  crashes por `SIGKILL` em pontos exatos via `FAULT_INJECTION` (só usado por testes).
- Variáveis: `TEST_DATABASE_URL` (padrão `postgres://wagering:wagering@localhost:5432/wagering_test`),
  `TEST_SQS_ENDPOINT` (padrão `http://localhost:4566`), `KEYCLOAK_URL` (habilita o teste contra o
  Keycloak real), `TEST_LOG_LEVEL`.
- O teste de `SIGTERM` gracioso é pulado no Windows (sem sinais POSIX). Para rodar tudo em Linux:

```bash
docker compose --profile test run --rm tests
```

### Teste de carga

Com o compose completo de pé (3 réplicas + nginx):

```bash
bun run test:load
```

Parâmetros por ambiente: `LOAD_TARGET`, `LOAD_DURATION_S` (30), `LOAD_CONCURRENCY` (32),
`LOAD_WALLETS` (50), `LOAD_HOT_SHARE` (0.2), `LOAD_DUPLICATE_RATE` (0.05), `LOAD_DATABASE_URL`,
`KEYCLOAK_URL`. Gera `load-report.md` com ambiente, metodologia, throughput, p50/p95/p99, taxa de
erro, conflitos de concorrência, outbox lag e a verificação final saldo == ledger.

---

## Estrutura

```
src/
  domain/            Money, Wallet, WalletLedgerEntry, WagerTransaction, Inbox/Outbox, eventos, FailureCode
  application/       use cases, WagerTransactionProcessor, portas, idempotência (hash canônico), erros
  infrastructure/
    persistence/     MikroORM (EntitySchema, repositórios, UnitOfWork, migrations, tradução de erros)
    messaging/       consumer SQS, publisher de eventos, filas
    auth/            verificação JWT (JWKS do Keycloak), principal/papéis
    observability/   logs JSON (pino + AsyncLocalStorage), métricas Prometheus
    workers/         relay da outbox, worker de referências pendentes, ciclo de vida
  interfaces/http/   controllers, guard, filtro de erros, presenters
docker/              init do Postgres, realm do Keycloak, nginx
scripts/             migrate, setup das filas, envio de mensagem, token
test/
  unit/  integration/  concurrency/  load/  support/
```
