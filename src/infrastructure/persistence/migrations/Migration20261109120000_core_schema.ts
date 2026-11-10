import { Migration } from '@mikro-orm/migrations';

/**
 * Core schema. Every guarantee from the domain (uniqueness, non-negativity, ledger
 * arithmetic, reference rules) is enforced here too — the application is not trusted
 * to be the only line of defense.
 */
export class Migration20261109120000_core_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   varchar(128)   NOT NULL,
        currency    char(3)        NOT NULL,
        balance     numeric(20,2)  NOT NULL,
        version     integer        NOT NULL,
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT ux_wallets_player_currency UNIQUE (player_id, currency),
        -- Target of the composite FK that pins ledger currency to the wallet currency.
        CONSTRAINT ux_wallets_id_currency UNIQUE (id, currency),
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT ck_wallets_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wallets_player_not_blank CHECK (length(btrim(player_id)) > 0)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        varchar(64)    NOT NULL,
        external_transaction_id            varchar(128)   NOT NULL,
        idempotency_key                    varchar(256)   NOT NULL,
        payload_hash                       char(64)       NOT NULL,
        wallet_id                          uuid           NOT NULL REFERENCES wallets (id),
        player_id                          varchar(128)   NOT NULL,
        round_id                           varchar(128)   NOT NULL,
        game_id                            varchar(128)   NOT NULL,
        kind                               varchar(16)    NOT NULL,
        amount                             numeric(20,2)  NOT NULL,
        currency                           char(3)        NOT NULL,
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid           REFERENCES wager_transactions (id),
        status                             varchar(24)    NOT NULL,
        failure_code                       varchar(64),
        balance_after                      numeric(20,2),
        reference_attempts                 integer        NOT NULL DEFAULT 0,
        next_reference_check_at            timestamptz,
        correlation_id                     varchar(128)   NOT NULL,
        created_at                         timestamptz    NOT NULL,
        updated_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,

        -- Persistent idempotency: one row per key and per provider-side id.
        CONSTRAINT ux_wager_tx_provider_idempotency_key UNIQUE (provider_id, idempotency_key),
        CONSTRAINT ux_wager_tx_provider_external_id UNIQUE (provider_id, external_transaction_id),
        -- Target of the composite FK (ledger.transaction_id, ledger.wallet_id).
        CONSTRAINT ux_wager_tx_id_wallet UNIQUE (id, wallet_id),

        CONSTRAINT ck_wager_tx_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT ck_wager_tx_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT ck_wager_tx_amount CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
        CONSTRAINT ck_wager_tx_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wager_tx_payload_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT ck_wager_tx_reference_required
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_tx_reference_forbidden
          CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT ck_wager_tx_not_self_reference
          CHECK (reference_external_transaction_id IS NULL OR reference_external_transaction_id <> external_transaction_id),
        CONSTRAINT ck_wager_tx_resolved_reference_consistent
          CHECK (reference_transaction_id IS NULL OR (reference_external_transaction_id IS NOT NULL AND reference_transaction_id <> id)),
        CONSTRAINT ck_wager_tx_processed_shape
          CHECK (status <> 'PROCESSED' OR (processed_at IS NOT NULL AND balance_after IS NOT NULL AND failure_code IS NULL)),
        CONSTRAINT ck_wager_tx_processed_reference_resolved
          CHECK (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_tx_failure_code_iff_terminal_failure
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wager_tx_pending_reference_scheduled
          CHECK ((status = 'PENDING_REFERENCE') = (next_reference_check_at IS NOT NULL)),
        CONSTRAINT ck_wager_tx_balance_after_non_negative CHECK (balance_after IS NULL OR balance_after >= 0),
        CONSTRAINT ck_wager_tx_reference_attempts CHECK (reference_attempts >= 0)
      );
    `);

    // A reference can be reverted at most once (any reversal kind) — see ARCHITECTURE.md.
    this.addSql(`
      CREATE UNIQUE INDEX ux_wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`CREATE UNIQUE INDEX ux_wager_tx_single_opening ON wager_transactions (wallet_id) WHERE kind = 'OPENING';`);
    this.addSql(`
      CREATE INDEX ix_wager_tx_pending_reference_due
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX ix_wager_tx_awaiting_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX ix_wager_tx_wallet_created ON wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL,
        transaction_id  uuid           NOT NULL,
        wallet_version  integer        NOT NULL,
        direction       varchar(6)     NOT NULL,
        amount          numeric(20,2)  NOT NULL,
        currency        char(3)        NOT NULL,
        balance_before  numeric(20,2)  NOT NULL,
        balance_after   numeric(20,2)  NOT NULL,
        created_at      timestamptz    NOT NULL,
        -- The entry belongs to the same wallet as its transaction, in the wallet currency.
        CONSTRAINT fk_ledger_transaction_wallet FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),
        -- At most one entry per (transaction, wallet).
        CONSTRAINT ux_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        -- Gapless per-wallet sequence (also the keyset pagination index).
        CONSTRAINT ux_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ck_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        ),
        CONSTRAINT ck_ledger_wallet_version_positive CHECK (wallet_version >= 1)
      );
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(128)  NOT NULL,
        message_id     varchar(256)  NOT NULL,
        payload_hash   char(64)      NOT NULL,
        received_at    timestamptz   NOT NULL,
        processed_at   timestamptz,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid           PRIMARY KEY,
        aggregate_id     varchar(128)   NOT NULL,
        event_type       varchar(128)   NOT NULL,
        event_version    integer        NOT NULL,
        payload          jsonb          NOT NULL,
        occurred_at      timestamptz    NOT NULL,
        attempts         integer        NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       varchar(1024),
        CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0),
        CONSTRAINT ck_outbox_event_version CHECK (event_version >= 1),
        CONSTRAINT ck_outbox_payload_event_id CHECK (payload ->> 'eventId' = id::text)
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_pending
        ON outbox_messages (occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
