import { Migration } from '@mikro-orm/migrations';

/**
 * Integrity rules that CHECK constraints cannot express:
 *
 * 1. Ledger is append-only: UPDATE / DELETE / TRUNCATE are rejected.
 * 2. Ledger chain: each entry continues the previous one of the same wallet
 *    (wallet_version = previous + 1, balance_before = previous balance_after).
 * 3. Materialized balance == ledger: at COMMIT (deferred constraint trigger), the wallet
 *    balance/version must equal the last ledger entry (or 0 / version 1 when empty).
 *    "Every balance change has a ledger entry and vice-versa" is enforced by the database.
 * 4. Wallet identity columns are immutable; version never decreases.
 * 5. Wager transactions: terminal statuses are final, business columns immutable, no DELETE.
 * 6. Outbox: event content is immutable and a published event cannot be "unpublished".
 */
export class Migration20261109120100_integrity_triggers extends Migration {
  override async up(): Promise<void> {
    // 1. Append-only ledger -------------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION fn_ledger_append_only();
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION fn_ledger_append_only();
    `);

    // 2. Ledger chain continuity ---------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous RECORD;
      BEGIN
        SELECT wallet_version, balance_after
          INTO previous
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF FOUND THEN
          IF NEW.wallet_version <> previous.wallet_version + 1 THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: version % does not follow %',
              NEW.wallet_id, NEW.wallet_version, previous.wallet_version
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF NEW.balance_before <> previous.balance_after THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before does not match previous balance_after',
              NEW.wallet_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.balance_before <> 0 THEN
          RAISE EXCEPTION 'first ledger entry of wallet % must start from zero', NEW.wallet_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION fn_ledger_chain();
    `);

    // 3. Wallet balance == ledger (checked at commit) -----------------------------------
    this.addSql(`
      CREATE FUNCTION fn_wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        target_wallet uuid;
        wallet_row RECORD;
        last_entry RECORD;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target_wallet := NEW.id;
        ELSE
          target_wallet := NEW.wallet_id;
        END IF;

        SELECT balance, version INTO wallet_row FROM wallets WHERE id = target_wallet;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ledger entry references missing wallet %', target_wallet
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT wallet_version, balance_after
          INTO last_entry
          FROM wallet_ledger_entries
         WHERE wallet_id = target_wallet
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF FOUND THEN
          IF wallet_row.balance <> last_entry.balance_after OR wallet_row.version <> last_entry.wallet_version THEN
            RAISE EXCEPTION 'wallet % diverges from its ledger (balance/version mismatch)', target_wallet
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF wallet_row.balance <> 0 OR wallet_row.version <> 1 THEN
          RAISE EXCEPTION 'wallet % has a balance without ledger entries', target_wallet
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_matches_ledger_on_wallet
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION fn_wallet_matches_ledger();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_matches_ledger_on_entry
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION fn_wallet_matches_ledger();
    `);

    // 4. Wallet immutable identity ------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet % identity columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.version < OLD.version THEN
          RAISE EXCEPTION 'wallet % version cannot decrease', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wallet_guard
        BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION fn_wallet_guard();
    `);

    // 5. Wager transaction state machine --------------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_wager_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transactions are an audit trail and cannot be deleted'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'invalid transition PENDING_REFERENCE -> PENDING for %', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id
           OR NEW.provider_id <> OLD.provider_id
           OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.idempotency_key <> OLD.idempotency_key
           OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.wallet_id <> OLD.wallet_id
           OR NEW.player_id <> OLD.player_id
           OR NEW.round_id <> OLD.round_id
           OR NEW.game_id <> OLD.game_id
           OR NEW.kind <> OLD.kind
           OR NEW.amount <> OLD.amount
           OR NEW.currency <> OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.correlation_id <> OLD.correlation_id
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'business columns of wager transaction % are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.reference_attempts < OLD.reference_attempts THEN
          RAISE EXCEPTION 'reference_attempts cannot decrease for %', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_transaction_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION fn_wager_transaction_guard();
    `);

    // 6. Outbox content immutability --------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.aggregate_id <> OLD.aggregate_id OR NEW.event_type <> OLD.event_type
           OR NEW.event_version <> OLD.event_version OR NEW.payload <> OLD.payload
           OR NEW.occurred_at <> OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox event % content is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'outbox event % is already published', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_outbox_guard
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION fn_outbox_guard();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_outbox_guard ON outbox_messages;');
    this.addSql('DROP FUNCTION IF EXISTS fn_outbox_guard();');
    this.addSql('DROP TRIGGER IF EXISTS trg_wager_transaction_guard ON wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS fn_wager_transaction_guard();');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_guard ON wallets;');
    this.addSql('DROP FUNCTION IF EXISTS fn_wallet_guard();');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_matches_ledger_on_entry ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_matches_ledger_on_wallet ON wallets;');
    this.addSql('DROP FUNCTION IF EXISTS fn_wallet_matches_ledger();');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_chain ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS fn_ledger_chain();');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_append_only ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS fn_ledger_append_only();');
  }
}
