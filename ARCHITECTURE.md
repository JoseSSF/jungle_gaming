# ARCHITECTURE — Distributed Wagering Processor

Este documento registra **o que foi construído, por quê, e o que fica de fora**. A regra que guiou
todas as decisões: *o banco é o árbitro final de toda invariante financeira*. O código de aplicação
é a primeira linha de defesa; o schema (constraints, índices parciais, triggers) é a última — e os
testes de integração provam cada uma delas sem passar pela aplicação.

---

## 1. Visão geral

```
                 ┌───────────── HTTP (Idempotency-Key) ─────────────┐
 Provedores ─────┤                                                  │
                 └──── SQS wager-transactions.fifo ──┐              │
                                                     ▼              ▼
                         ┌──────────────────────────────────────────────────────┐
                         │  N instâncias idênticas (Bun + NestJS)               │
                         │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │
                         │  │ HTTP API    │  │ SQS consumer │  │ PENDING_REF  │ │
                         │  └──────┬──────┘  └──────┬───────┘  │ worker       │ │
                         │         └───────┬────────┘          └──────┬───────┘ │
                         │                 ▼                          ▼         │
                         │      SubmitWagerTransactionUseCase ─► WagerTransaction│
                         │                 │                       Processor     │
                         │                 ▼ (1 transação SQL)                   │
                         │  ┌──────────────────────────────────────────────────┐ │
                         │  │ inbox → wager_tx → ledger → wallet → outbox      │ │
                         │  └──────────────────────────────────────────────────┘ │
                         │  ┌──────────────┐                                     │
                         │  │ Outbox relay │── SKIP LOCKED ──► wagering-events.fifo
                         │  └──────────────┘                                     │
                         └──────────────────────────────────────────────────────┘
                                                     │
                                       PostgreSQL (constraints + triggers)
                     falhas permanentes ──► wager-transactions-dlq.fifo
```

Todas as instâncias executam **todos os papéis** (HTTP, consumer, relay da outbox, worker de
referências pendentes). Nenhum papel é singleton: a correção não depende de quantas instâncias
rodam nem de qual delas pega cada trabalho. O `docker-compose.yml` sobe 3 réplicas atrás de um nginx.

### Camadas e boundaries

| Camada | Pasta | Depende de | Conteúdo |
|---|---|---|---|
| Domínio | `src/domain` | nada (só `decimal.js`) | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage`, eventos de integração, `FailureCode` |
| Aplicação | `src/application` | domínio + **portas** | use cases, `WagerTransactionProcessor`, política de referências, hash de payload, validação de comandos, erros de aplicação |
| Infraestrutura | `src/infrastructure` | aplicação | MikroORM (repositórios, UoW, migrations), SQS (consumer, publisher, filas), auth (JWKS), logs/métricas, workers |
| Interface | `src/interfaces/http` | aplicação + infra | controllers Nest, guard, filtro de erros, presenters |
| Composição | `src/app.module.ts` | tudo | wiring por factories — domínio e aplicação **não** têm decorators do Nest |

Portas (`src/application/ports`): `UnitOfWork` + repositórios, `EventPublisher`, `Clock`,
`IdGenerator`, `Logger`, `WageringMetrics`, `FaultInjector`. O mesmo use case atende HTTP e SQS — a
diferença entre os dois canais é só o contexto (`source`, `inbox`).

---

## 2. Modelo de domínio

Todas as classes seguem a regra do enunciado: construtor `private`, factories estáticas
(`create`/`open`/`from`/`receive`/`enqueue`) que **validam**, e `rehydrate` que **não** revalida —
apenas reconstrói estado persistido (já garantido pelo banco).

### Money
- `Decimal` isolado (`Decimal.clone`, precisão 40) — nenhuma configuração global afeta dinheiro.
- Entrada: string decimal, sem sinal, sem expoente, sem zeros à esquerda, **até** 2 casas. `"25.5"`
  é aceito e normalizado para `"25.50"`; `"10.005"` é **rejeitado, nunca arredondado**. Números JSON
  são rejeitados (a precisão já foi perdida antes de chegar). Máximo de 18 dígitos inteiros
  (`numeric(20,2)`).
- Imutável (`Object.freeze`), toda operação devolve nova instância; operações entre moedas lançam
  `CurrencyMismatchError`. Aritmética interna pode produzir negativos (ex.: `difference` da
  reconciliação), mas `Money.from` — a porta dos contratos — não aceita negativos.
- Persistência: `numeric(20,2)` ↔ **string** (MikroORM `DecimalType` com `runtimeType: 'string'`) ↔
  `Money`. Somas de reconciliação são calculadas pelo PostgreSQL em `numeric` e devolvidas como
  texto. Em nenhum ponto um valor monetário passa por `number`.

### Wallet (aggregate root)
- `open()` cria a wallet com `version = 1`. Saldo inicial positivo gera o lançamento `CREDIT` #1
  (da transação interna `OPENING`) **dentro da própria abertura** — por isso a versão continua 1.
- `debit()`/`credit()` são o único caminho que altera saldo; ambos devolvem o `WalletLedgerEntry`
  correspondente, incrementam `version` exatamente uma vez e só mutam o estado depois de validar o
  lançamento. Movimentos de valor zero são recusados (versão só muda quando o saldo muda).
- `version` é ao mesmo tempo o token de concorrência otimista e a **sequência do ledger**
  (`wallet_version` do lançamento = versão da wallet após aplicá-lo).

### WalletLedgerEntry
Sem campos mutáveis nem métodos de transição; instância congelada. `create` valida
`balanceBefore ± money === balanceAfter`, valor positivo, saldos não negativos. Ledger de partida
simples (uma linha por wallet por transação); partidas dobradas ficaram fora (opcional).

### WagerTransaction — máquina de estados

```
PENDING ─┬─► PROCESSED            (terminal)
         ├─► REJECTED             (terminal, failureCode)
         ├─► FAILED               (terminal, PROCESSING_FAILED)
         └─► PENDING_REFERENCE ─┬─► PENDING_REFERENCE (reagendamento, attempts++)
                                ├─► PROCESSED
                                ├─► REJECTED
                                └─► FAILED
```
- Qualquer transição a partir de terminal lança `InvalidTransactionStateError` (erro de
  programação). A mesma máquina é imposta por trigger no banco.
- `PENDING` é um estado **apenas em memória**: a transação nasce e é decidida dentro da mesma
  transação SQL, então nunca é commitada como `PENDING` (há um teste que verifica isso).
- Guarda `balanceAfter`: o saldo observado quando atingiu o status atual. É o que torna possível
  "repetir uma operação já processada retorna o resultado original, incluindo o saldo daquele momento".

### Inbox / Outbox
Exatamente como no esqueleto. `OutboxMessage.id === eventId`; o payload é o envelope serializado e
congelado. `scheduleRetry` aplica backoff exponencial com teto.

### Eventos
`IntegrationEvent<T>` abstrata; `eventType` e `version` declarados **no tipo** de cada subclasse:
`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`,
`WalletBalanceChanged` (mínimos) e `WagerTransactionFailed` (extra, para o estado `FAILED`). `data`
carrega `MoneyProps` (strings). `WalletBalanceChanged` leva `walletVersion` para que consumidores
ordenem/descartem eventos atrasados.

---

## 3. ORM e estratégia transacional

**MikroORM 6.6** (preferencial no enunciado). Fixei a linha 6 (madura) em vez da 7 recém-lançada, e
NestJS 11 em vez de 12, para não apostar a correção financeira em majors novas.

- **Entidades por `EntitySchema`** (sem decorators): os records de persistência são separados do
  domínio; repositórios mapeiam record ↔ aggregate e reconstroem com `rehydrate`. O domínio não
  conhece tipos do ORM.
- **`UnitOfWork` = `em.fork().transactional()`**: cada caso de uso roda em um fork novo (identity map
  próprio) dentro de uma transação PostgreSQL `READ COMMITTED`; a reconciliação usa
  `REPEATABLE READ READ ONLY` (snapshot consistente de wallet + ledger sem lock).
- **Statements explícitos em vez de flush implícito**: `em.insert`, `em.nativeUpdate`,
  `em.findOne(..., { lockMode: LockMode.PESSIMISTIC_WRITE })` e
  `em.find(..., { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE })` (= `FOR UPDATE SKIP LOCKED`).
  Motivos: (1) a atualização crítica precisa ser um `UPDATE ... WHERE id = ? AND version = ?` cujo
  número de linhas afetadas é verificado; (2) a ordem dos writes (transação → ledger → wallet →
  outbox) é deliberada; (3) a versão é controlada pelo domínio — o `version: true` do MikroORM
  incrementaria em qualquer alteração, não "somente quando o saldo muda".
- **Leituras com `disableIdentityMap`**: toda leitura dentro da transação reflete o último estado
  commitado visto *depois* de adquirir o lock da wallet.
- **Tradução de erros após o rollback** (`database-errors.ts`): `55P03`/`40P01`/`40001`/`23505` →
  `ConcurrencyConflictError` (retentável: a transação inteira foi desfeita); CHECK/FK/trigger →
  `PersistenceInvariantError` (permanente); conexão/timeout → `InfrastructureUnavailableError`
  (transitório). Inclui erros levantados **no COMMIT** pelos triggers deferidos.
- **Migrations** versionadas e reversíveis escritas à mão (`up`/`down`), registradas por
  `migrationsList` (sem descoberta por filesystem). `disableForeignKeys: false` é proposital: o modo
  `session_replication_role=replica` desligaria os triggers de integridade.
- `ensureDatabase: false` + pool preguiçoso: a instância sobe e reporta *not ready* enquanto o
  PostgreSQL estiver fora, em vez de entrar em crash-loop.

---

## 4. Concorrência

**Unidade de concorrência: a linha da wallet.** Estratégia combinada:

1. **Lock pessimista por wallet** — `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`. Todo escritor
   de uma wallet (HTTP, consumer, worker de referências, em qualquer instância) adquire esse lock
   primeiro. Wallets diferentes nunca disputam lock (não há lock global). O lock é liberado no
   COMMIT/ROLLBACK, inclusive se o processo morrer (a conexão cai).
2. **Guarda otimista** — o `UPDATE wallets ... WHERE version = <versão lida sob lock>` precisa afetar
   1 linha; caso contrário `ConcurrencyConflictError('version-mismatch')`. Redundante com o lock por
   construção — é defesa em profundidade caso algum caminho futuro esqueça o lock.
3. **Banco como árbitro** — `CHECK (balance >= 0)`, cadeia do ledger, `UNIQUE (wallet_id,
   wallet_version)` e o trigger deferido saldo == ledger. Mesmo um bug que pulasse (1) e (2) não
   conseguiria commitar um lost update, um saldo negativo ou um débito duplicado.
4. **Espera limitada + retry limitado** — `SET LOCAL lock_timeout` (3 s por padrão). Timeout de lock,
   deadlock, falha de serialização ou corrida de unique key fazem rollback e são re-executados com
   backoff exponencial e jitter (até `SUBMIT_MAX_CONFLICT_RETRIES`). Esgotado: `503` / retry na fila.

**Por que pessimista e não otimista puro?** Em *hot wallet* o otimista degenera em tempestade de
retries (cada conflito refaz leitura + validação + escrita, e a taxa de conflito cresce com a
contenção). Com `FOR UPDATE` a fila de espera é a do próprio PostgreSQL, FIFO e sem trabalho
desperdiçado, e o p99 fica previsível. O custo — uma wallet processa uma transação por vez — é
inerente à semântica (cada débito depende do saldo do anterior).

**Por que não só `UPDATE ... SET balance = balance - x WHERE balance >= x`?** Resolve o saldo, mas o
lançamento do ledger precisa de `balance_before`/`balance_after`/`wallet_version` exatos e
consistentes com a referência, a idempotência e as regras de reversão — tudo isso precisa ler
estado. O lock de linha dá esse estado de forma consistente; o update condicional seria só uma
parte do problema.

**Por que não advisory locks?** `pg_advisory_xact_lock(hash(walletId))` funciona, mas colisões de
hash serializariam wallets distintas e o lock fica invisível ao schema. O lock de linha é natural,
auditável (`pg_locks`) e já acompanha o dado.

**Deadlocks:** a ordem de aquisição é sempre wallet → linhas filhas. A única escrita fora da wallet
travada é `expediteDependents` (marcar como "due" transações pendentes que aguardavam esta), que
nunca espera por lock de wallet — não há ciclo possível. Mesmo assim `40P01` é tratado como retentável.

**Broker:** a fila FIFO usa `MessageGroupId = walletId` e o consumer processa mensagens do mesmo
grupo em sequência dentro de um lote — isso **reduz** contenção, mas **não** é garantia: a correção é
a mesma com fila standard, mensagens fora de ordem e várias instâncias (os testes enviam HTTP e SQS
simultaneamente para a mesma wallet).

---

## 5. Idempotência

- **Fonte da verdade: `Idempotency-Key`** (header obrigatório no HTTP; campo `data.idempotencyKey`
  na mensagem SQS). Unicidade persistente `UNIQUE (provider_id, idempotency_key)` — escopo por
  provedor, para que chaves de provedores diferentes nunca colidam — e também
  `UNIQUE (provider_id, external_transaction_id)`.
- **`payloadHash` = hex(SHA-256(JSON canônico))** do subconjunto de negócio: `providerId`,
  `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
  `money {amount normalizado, currency}`, `referenceExternalTransactionId` (omitido se ausente).
  JSON canônico = chaves ordenadas recursivamente, sem espaços, `undefined` omitido, números
  proibidos. Header, `messageId`, `occurredAt` e metadados de transporte **não** entram. Como o valor
  é normalizado, `"25.5"` e `"25.50"` são o mesmo payload. HTTP e SQS produzem o mesmo hash: a mesma
  operação enviada pelos dois canais é aplicada uma vez.
- **Fluxo**: lookup pela chave (fast path, sem lock) → lock da wallet → **lookup de novo sob o
  lock** (autoritativo: todo escritor da wallet está serializado atrás de nós) → aplica. Uma corrida
  com a mesma chave em wallets diferentes termina em `23505` → rollback → retry → caminho de replay.
- **Corrida encontrada pelos testes de concorrência:** cada lookup tem duas leituras, primeiro pela
  chave e depois pelo `externalTransactionId`. Em `READ COMMITTED` cada statement enxerga o último
  commit, então uma requisição com a **mesma** chave podia commitar entre as duas leituras. A segunda
  leitura respondia `409 EXTERNAL_TRANSACTION_ID_CONFLICT` em vez de replay. Saldo e ledger nunca
  foram afetados. Correção: se a linha achada pelo id externo tem a mesma chave, o caminho é
  replay/conflito por hash. Há um teste de unidade determinístico que reproduz a janela.
- **Replay**: mesma chave + mesmo hash → a transação original, com status, `failureCode` e o
  **saldo observado na época**; mesma resposta HTTP (mesmo status) com `idempotentReplay: true` e
  header `Idempotent-Replayed: true`. Vale também para rejeições e para `PENDING_REFERENCE` (que
  reflete o estado atual da transação).
- **Conflito**: mesma chave + hash diferente → `409 IDEMPOTENCY_KEY_CONFLICT` (com
  `existingTransactionId`); mesmo `externalTransactionId` sob outra chave →
  `409 EXTERNAL_TRANSACTION_ID_CONFLICT`. Nunca replay.
- Nada disso usa memória: cache em memória não participa de nenhuma garantia.

### Inbox (SQS)
`(consumer_name, message_id)` é PK de `inbox_messages`, gravada **na mesma transação** que o efeito
financeiro via `INSERT ... ON CONFLICT DO NOTHING`. Uma duplicata concorrente bloqueia no índice até
a primeira transação terminar e então vê a linha commitada (ou insere, se a primeira fez rollback).
"Registrada" implica "efeitos commitados". `messageId` repetido com payload diferente →
`INBOX_MESSAGE_CONFLICT` → DLQ (bug do produtor, precisa de auditoria). Inbox e idempotency key são
complementares: a inbox deduplica **entregas** (mesmo `messageId`); a chave deduplica **operações**
(mensagens diferentes, ou HTTP + SQS, com a mesma chave).

---

## 6. Regras de negócio e interpretações

| Operação | Efeito | Ledger | Observações |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | saldo insuficiente → `INSUFFICIENT_FUNDS`; não pode ter referência |
| `WIN` | crédito | 1 `CREDIT` | referência **opcional** a uma `BET` da mesma rodada |
| `LOSS` | nenhum | nenhum | `PROCESSED` com evento; aceita valor `0.00`; referência opcional a `BET` |
| `REFUND` | crédito | 1 `CREDIT` | referência obrigatória a `BET` `PROCESSED`, mesmo valor |
| `ROLLBACK` | inverso da referência | 1 invertido | referência a `BET` (crédito), `WIN` (débito) ou `REFUND` (débito) |

Interpretações adotadas (todas testadas):
1. **Referência validada por** `(providerId, referenceExternalTransactionId)` e deve ter o mesmo
   provider, player, wallet, moeda e rodada → senão `REFERENCE_MISMATCH`.
2. **Uma referência é revertida no máximo uma vez, por qualquer tipo de reversão.** O enunciado pede
   "não duas vezes pelo mesmo tipo"; adotei a regra mais forte porque `REFUND` + `ROLLBACK` da mesma
   `BET` creditaria duas vezes um único débito. Imposto por índice único parcial
   (`ux_wager_tx_single_reversal`). `ROLLBACK` de um `REFUND` continua permitido (desfaz o refund).
3. **Referência existente mas ainda não aplicada** (`PENDING_REFERENCE`) é tratada como ausente
   (aguarda). Referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`.
4. **Reversão que deixaria saldo negativo** → `REVERSAL_WOULD_OVERDRAW` (distinto de
   `INSUFFICIENT_FUNDS`), transação `REJECTED` e auditável.
5. **Valor**: `BET`/`WIN`/`REFUND`/`ROLLBACK` exigem valor > 0; `LOSS` aceita ≥ 0.
6. **Wallet inexistente** → `WALLET_NOT_FOUND` (422). Não vira linha em `wager_transactions` (a FK
   exige wallet), mas gera evento `WagerTransactionRejected` e, no SQS, registro na inbox.
7. **Wallet de outro player** → `WALLET_PLAYER_MISMATCH` sem expor o saldo da wallet alheia.
   **Moeda diferente da wallet** → `CURRENCY_MISMATCH`, sem snapshot de saldo (estaria em outra moeda).
8. **`FAILED`**: falha permanente não-negocial (o banco recusou um write por invariante ou um
   invariante de domínio quebrou = bug). É registrada numa transação separada, gera evento e é
   terminal para aquela chave (replay devolve `FAILED`); exige ação de operador.
9. **Wallets multi-moeda**: uma por `(playerId, currency)`; todos os testes usam BRL e conflitos de
   moeda são testados.

### 6.1 Referências fora de ordem
- Referência ausente → `PENDING_REFERENCE` (HTTP `202`), evento `WagerTransactionPendingReference`,
  `next_reference_check_at` agendado.
- **Worker agendado** (todas as instâncias) seleciona candidatas vencidas sem lock e processa cada
  uma em sua própria transação: lock da wallet → relê a transação → se ainda vencida, aplica o mesmo
  `WagerTransactionProcessor` do caminho síncrono. Quem perder a corrida encontra a transação já
  resolvida/reagendada e pula.
- **Backoff exponencial**: 1 s, 2 s, 4 s ... teto 60 s. **Limite: 12 tentativas ou TTL de 15 min**, o
  que vier primeiro. Justificativa: o provedor normalmente entrega a operação referenciada em
  segundos; 15 min cobre com folga redeliveries do SQS (visibility timeout × tentativas) e janelas de
  indisponibilidade curtas, e ainda fica dentro da janela típica de reconciliação de provedores. Com
  o teto de 60 s, 12 tentativas cabem nesse TTL.
- **Aceleração**: quando uma transação é processada, as pendentes que a referenciam têm
  `next_reference_check_at = now()` — o worker as pega no próximo ciclo em vez de esperar o backoff.
- Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.

### 6.2 Taxonomia de `failureCode`
Cada código é estável e vem acompanhado de `providerAction` na resposta:

| failureCode | Quando | providerAction |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | `GIVE_UP` |
| `REVERSAL_WOULD_OVERDRAW` | REFUND/ROLLBACK deixaria saldo negativo | `CONTACT_OPERATOR` |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | `FIX_AND_RESEND_NEW_KEY` |
| `WALLET_NOT_FOUND` | walletId inexistente | `FIX_AND_RESEND_NEW_KEY` |
| `WALLET_PLAYER_MISMATCH` | wallet de outro player | `FIX_AND_RESEND_NEW_KEY` |
| `REFERENCE_NOT_FOUND` | referência não chegou no prazo | `FIX_AND_RESEND_NEW_KEY` |
| `REFERENCE_NOT_PROCESSED` | referência REJECTED/FAILED | `GIVE_UP` |
| `REFERENCE_MISMATCH` | outro player/wallet/moeda/rodada | `FIX_AND_RESEND_NEW_KEY` |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: REFUND de WIN | `FIX_AND_RESEND_NEW_KEY` |
| `REFERENCE_AMOUNT_MISMATCH` | reversão parcial | `FIX_AND_RESEND_NEW_KEY` |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | `GIVE_UP` |
| `PROCESSING_FAILED` | status FAILED (permanente, não-negocial) | `CONTACT_OPERATOR` |

Erros de contrato (`400`) também têm `code` estável: `INVALID_PAYLOAD` (com `issues[]`),
`INVALID_MONEY`, `INVALID_JSON`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `SELF_REFERENCE`,
`INVALID_CURSOR`.

### 6.3 Mapeamento HTTP (igual em todos os endpoints)

| Situação | Status | `retryable` | O que o provedor faz |
|---|---|---|---|
| Processada | `201` | – | – |
| Aceita, pendente de referência | `202` | – | consulta depois (`GET`) ou reenvia a mesma chave |
| Payload inválido | `400` | false | corrige; nova chave |
| Sem token / token inválido | `401` | false | renova o token |
| Sem permissão / provider errado | `403` | false | – |
| Recurso inexistente | `404` | false | – |
| Conflito de idempotência / wallet duplicada | `409` | false | não reenviar com essa chave |
| Rejeição de negócio | `422` + `failureCode` | – | segue `providerAction` |
| Falha transitória (DB/SQS fora, lock timeout esgotado) | `503` + `Retry-After` | **true** | reenvia **com a mesma chave** |
| Falha permanente (`FAILED`) | `500` + `PROCESSING_FAILED` | false | aciona operador |

Corpo de erro único: `{ "error": { "code", "message", "retryable", ... }, "correlationId" }`.

---

## 7. Mensageria e falhas

### Consumer SQS (`wager-transactions.fifo`)
- Long polling; mensagens do mesmo `MessageGroupId` em sequência, grupos em paralelo.
- Valida o envelope e usa **o mesmo parser e o mesmo use case** do HTTP, com contexto de inbox.
- **`DeleteMessage` (ack) só depois do commit.** Se o processo morrer entre o commit e o ack, a
  mensagem volta após o visibility timeout e a inbox a absorve (teste dedicado mata o processo
  exatamente nesse ponto).
- Classificação:
  - **negócio** (`PROCESSED`/`REJECTED`/`PENDING_REFERENCE`/duplicata) → ack;
  - **transitório** (DB/SQS indisponível, conflitos esgotados, erro desconhecido) → `ChangeMessageVisibility`
    com backoff exponencial (2 s, 4 s ... teto 60 s);
  - **permanente** (JSON/envelope/payload inválido, conflito de idempotência/inbox, `FAILED`) →
    cópia para a DLQ com `failureReason`, `originalMessageId` e `receiveCount`, depois ack.
- **Limite de tentativas** `SQS_MAX_ATTEMPTS` (5): na última falha transitória → DLQ
  (`RETRIES_EXHAUSTED`); mensagem recebida acima do limite (crash-loop) → DLQ
  (`MAX_ATTEMPTS_EXCEEDED`) sem processar. A `RedrivePolicy` da fila (`maxReceiveCount` = limite + 2)
  é rede de segurança caso o próprio processo morra antes de decidir.
- **SIGTERM**: para de receber (aborta o long poll), termina as mensagens em andamento (com teto
  `SQS_SHUTDOWN_GRACE_MS`), devolve a visibilidade (`VisibilityTimeout=0`) das que foram recebidas mas
  não iniciadas, para os workers e só então fecha o pool. A readiness passa a `503` no início do
  shutdown.

### Transactional Outbox
- Eventos são gravados em `outbox_messages` **na mesma transação** da mudança de estado. Nada é
  publicado antes do commit.
- **Relay** (todas as instâncias): numa transação, `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 10` das
  linhas vencidas → `SendMessageBatch` para `wagering-events.fifo` → `published_at` (ou
  `attempts++`/`next_attempt_at` com backoff) → COMMIT. Dois relays nunca publicam a mesma linha ao
  mesmo tempo; se um processo morre segurando o lote, a conexão cai, os locks somem e outro relay
  assume.
- **At-least-once**: se o processo morrer depois de o broker aceitar e antes do COMMIT, a linha
  continua pendente e é republicada com o **mesmo `eventId`** (= `MessageDeduplicationId` na FIFO,
  então o broker já descarta repetições em 5 min; o consumidor deduplica por `eventId`). Nunca há
  perda: linhas não são apagadas e só são marcadas após o ack do broker.
- O relay segura a transação durante a chamada ao broker. Escolha consciente: lotes pequenos (≤10,
  uma chamada), e em troca não há lease/expiração a calibrar. Alternativa para escala maior: claim
  com lease (`locked_until`) e publicação fora da transação.
- **Outbox lag**: `wagering_outbox_lag_seconds` (idade do evento pendente mais antigo),
  `wagering_outbox_pending`, histograma `wagering_outbox_publish_lag_seconds`.

### Indisponibilidade temporária
- PostgreSQL fora: HTTP `503 SERVICE_UNAVAILABLE` (retryable), consumer reagenda as mensagens,
  workers fazem backoff, readiness `503`. A instância não cai.
- SQS fora: consumer e relay fazem backoff; eventos ficam na outbox (lag cresce, nada se perde);
  o HTTP continua funcionando.

---

## 8. Garantias no schema (seção 5, item 9)

| Garantia | Mecanismo |
|---|---|
| 1 wallet por player+moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` em wallets, ledger e snapshot da transação |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, PK da inbox |
| No máximo 1 lançamento por transação/wallet | `UNIQUE (transaction_id, wallet_id)` |
| Lançamento pertence à wallet/moeda da transação | FKs compostas `(transaction_id, wallet_id)` e `(wallet_id, currency)` |
| Aritmética do lançamento | `CHECK` before ± amount = after |
| Cadeia do ledger sem buracos nem bifurcações | `UNIQUE (wallet_id, wallet_version)` + trigger `fn_ledger_chain` |
| Ledger imutável | trigger bloqueia `UPDATE`/`DELETE`/`TRUNCATE` |
| **Saldo materializado == ledger** (e vice-versa) | constraint trigger **deferida** valida no COMMIT que saldo/versão da wallet batem com o último lançamento |
| Reversão única | índice único parcial em `reference_transaction_id` para REFUND/ROLLBACK `PROCESSED` |
| Uma OPENING por wallet | índice único parcial |
| Forma de cada status | `CHECK`s: PROCESSED tem `processed_at` e snapshot; REJECTED/FAILED ⇔ `failure_code`; PENDING_REFERENCE ⇔ agendamento; REFUND/ROLLBACK exigem referência; BET não pode ter |
| Estados terminais e colunas de negócio imutáveis | trigger `fn_wager_transaction_guard` (também bloqueia DELETE) |
| Outbox | `payload.eventId = id`, conteúdo imutável, publicação irreversível |

`test/integration/schema-constraints.test.ts` exercita cada linha acima com SQL cru.

---

## 9. Autenticação (Keycloak)

- **IdP externo**: Keycloak 26 no compose, realm `jungle` importado de
  `docker/keycloak/jungle-realm.json`. Nada de tabela de usuários.
- **Provedores são clientes confidenciais** com `client_credentials` (`provider-a`, `provider-b`);
  um *hardcoded claim mapper* injeta `provider_id` no token; *audience mapper* adiciona
  `wagering-api`. O back-office é o cliente `backoffice`.
- **Papéis (realm roles)**: `wagering-provider` (submete e lê as próprias transações, lê wallets) e
  `wagering-operator` (cria wallets, ledger, reconciliação, lê tudo; **não** submete apostas).
- **Validação local** do JWT (RS256, `iss`, `aud`, `exp`) contra o JWKS em cache (`jose`) — sem
  chamada ao IdP por requisição. O guard global só conhece a porta `AccessTokenVerifier`.
- **Vínculo provedor ↔ payload**: `providerId` do corpo deve ser igual a `provider_id` do token
  (`403 PROVIDER_MISMATCH`), inclusive nas leituras.
- `AUTH_MODE=disabled` instala um principal permissivo (desenvolvimento/testes); o ponto de extensão
  continua explícito. Health e `/metrics` são sempre públicos. Mensagens da fila são canal interno
  confiável, mas o `providerId` delas passa pelas mesmas validações de domínio (referência do mesmo
  provider, etc.).
- `KC_HOSTNAME=http://localhost:8080` fixa o `iss`, então tokens obtidos do host validam dentro do
  Docker (o JWKS é buscado em `keycloak:8080`).

---

## 10. Observabilidade

- **Logs JSON** (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`
  propagados por `AsyncLocalStorage` (HTTP: `X-Correlation-Id` recebido ou gerado; SQS:
  `correlationId` do envelope ou `messageId`). Nenhum payload financeiro é logado; `redact` cobre
  `money`, `amount`, `balance*`, `payload`, `authorization`... como rede de segurança.
- **Métricas Prometheus** em `GET /metrics`:
  `wagering_transactions_total{kind,status,source}`, `wagering_duplicates_detected_total{kind}`,
  `wagering_idempotency_conflicts_total`, `wagering_retries_total{operation,reason}`,
  `wagering_concurrency_conflicts_total{reason}`, `wagering_wallet_lock_wait_seconds`,
  `wagering_processing_duration_seconds{source,outcome}`, `wagering_sqs_messages_total{outcome}`,
  `wagering_sqs_dlq_messages_total{reason}`, `wagering_outbox_lag_seconds`,
  `wagering_outbox_pending`, `wagering_outbox_publish_lag_seconds`,
  `wagering_pending_reference_resolutions_total`, `wagering_reconciliation_divergences_total`,
  `wagering_http_request_duration_seconds`, além das métricas de processo.
- **Health**: `/health/live` (processo vivo) e `/health/ready` (`SELECT 1` + `GetQueueAttributes`,
  com timeout, e `503` durante shutdown), ambos públicos.
- **Reconciliação**: `POST /wallets/:id/reconciliation` compara saldo armazenado × reconstruído, num
  snapshot `REPEATABLE READ`; divergência é logada (`wallet_reconciliation_divergence`), contada e
  sinalizada (`consistent: false`) — nunca corrigida silenciosamente. Na prática o trigger deferido
  torna a divergência impossível de commitar; a reconciliação é a verificação independente.

---

## 11. Testes

| Requisito | Onde |
|---|---|
| Money (escala, arredondamento, inválidos), Wallet, regras por kind, conflito de moeda, chave com payload divergente | `test/unit/*` |
| Migrations reversíveis e constraints | `test/integration/schema-constraints.test.ts` |
| Atomicidade wallet/ledger/inbox/outbox | `test/integration/atomicity.test.ts` (falha injetada em cada etapa, PostgreSQL real) |
| Inbox, redelivery, retry, DLQ | `test/integration/sqs-consumer.test.ts` |
| Publishers concorrentes, backoff do broker | `test/integration/outbox.test.ts` |
| Referências fora de ordem, TTL | `test/integration/pending-references.test.ts`, `test/concurrency/out-of-order.test.ts` |
| Auth | `test/integration/auth.test.ts` (+ bloco opcional contra o Keycloak real) |
| 50× a mesma aposta em paralelo | `test/concurrency/idempotency-storm.test.ts` |
| Cenário da seção 8 (×20), hot wallet | `test/concurrency/hot-wallet.test.ts` |
| Wallets distintas em paralelo | `test/concurrency/parallel-wallets.test.ts` |
| ≥ 3 processos simultâneos | `test/concurrency/multi-instance.test.ts` |
| Worker morto depois do commit e antes do ack; publisher morto antes/depois de publicar; dois publishers | `test/concurrency/crash-recovery.test.ts` |
| Reinício com prova de consistência final; SIGTERM | `test/concurrency/restart-consistency.test.ts` |

- **Nada de mock de PostgreSQL ou SQS** nas suítes de integração/concorrência: elas sobem a
  aplicação real (in-process ou como processos `bun run src/main.ts` separados) contra os containers.
  Os únicos *fakes* (repositórios em memória) estão nos testes de **unidade** das regras.
- **Paralelismo real**: `Promise.all` de requisições HTTP/mensagens contra o pool real; múltiplos
  processos de SO; crashes por `SIGKILL` em pontos exatos via `FAULT_INJECTION` (variável só usada
  pelos testes; sem ela o injetor é no-op).
- **Determinismo**: os cenários são desenhados para ter resultado exato independente da ordem
  (ex.: 100 apostas de 10.00 em 500.00 → exatamente 50/50; 130 apostas por HTTP+SQS em 3 instâncias
  → exatamente 50 débitos). Isolamento por filas únicas por arquivo e wallets novas por teste.
- **CI** (`.github/workflows/ci.yml`): todas as suítes rodam em Linux com containers reais a cada
  push, além da stack completa com 3 réplicas e o teste de carga. Resultado atual: 114 testes de
  unidade, 58 de integração e 17 de concorrência, 0 falhas, verdes em execuções consecutivas.
- **Invariante final de todos os arquivos** (`assertGlobalInvariants`): saldo == ledger reconstruído,
  versão == último lançamento, nenhum saldo negativo, cada transação `PROCESSED` que move saldo tem
  exatamente 1 lançamento (e as demais nenhum), nenhuma referência revertida duas vezes.

---

## 12. Trade-offs e limitações

- **Throughput de uma wallet é serial** (lock por linha). É o preço da correção sem retries
  especulativos; wallets diferentes escalam horizontalmente. Uma *hot wallet* extrema pediria
  particionamento do saldo (sub-wallets) ou agregação em lote — fora do escopo.
- **Relay segura transação durante a chamada ao SQS** (ver §7).
- **Ordem de eventos** não é global: é por `aggregateId` (FIFO) e, para eventos de saldo, por
  `walletVersion`. Consumidores devem deduplicar por `eventId`.
- **Retenção**: `inbox_messages` e `outbox_messages` publicadas crescem indefinidamente; um job de
  limpeza por idade (inbox precisa ficar mais tempo que a janela máxima de redelivery) não foi
  implementado.
- **Ledger de partida simples**; partidas dobradas e reversões parciais ficaram fora.
- **`WALLET_NOT_FOUND` não vira linha** em `wager_transactions` (a FK exige wallet). Replays HTTP
  dessa chave reavaliam (se a wallet passar a existir, a operação seria aplicada) — via SQS a inbox
  impede isso.
- **LocalStack → MiniStack**: desde 2026 a imagem do LocalStack exige token de conta; usei o
  MiniStack (`ministackorg/ministack`, sem conta), compatível com a API do SQS na porta 4566. Ele é
  um emulador: semânticas finas da AWS (ex.: janela de deduplicação FIFO, `ApproximateReceiveCount`)
  podem diferir — por isso nenhuma garantia depende do broker.
- **Teste de SIGTERM** é pulado no Windows (lá não há sinais POSIX; `kill` encerra o processo). Roda
  em Linux/macOS e no container de testes.
- **Autorização de leitura de wallets** por provedores é ampla (não modelamos o vínculo
  player ↔ provedor).
- Rate limiting, multi-tenant, OpenTelemetry e dashboards não foram implementados.
