import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { InvalidCommandError, NotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/repositories';

export interface LedgerPageResult {
  items: WalletLedgerEntry[];
  /** Opaque cursor for the next (older) page, or null when exhausted. */
  nextCursor: string | null;
}

interface CursorPayload {
  w: string;
  v: number;
}

export const MAX_LEDGER_PAGE_SIZE = 200;
export const DEFAULT_LEDGER_PAGE_SIZE = 50;

/**
 * Opaque, stable keyset cursor. It encodes the walletVersion of the last returned entry
 * (unique and immutable per wallet), so pages never skip or repeat entries even while
 * new entries are being appended.
 */
export function encodeLedgerCursor(walletId: string, walletVersion: number): string {
  const payload: CursorPayload = { w: walletId, v: walletVersion };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(walletId: string, cursor: string): number {
  const invalid = () => new InvalidCommandError('INVALID_CURSOR', 'cursor is invalid', [{ path: 'cursor', message: 'is invalid' }]);
  if (cursor.length > 256) throw invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const candidate = payload as Partial<CursorPayload> | null;
  if (
    !candidate ||
    candidate.w !== walletId ||
    typeof candidate.v !== 'number' ||
    !Number.isInteger(candidate.v) ||
    candidate.v < 1
  ) {
    throw invalid();
  }
  return candidate.v;
}

export function parseLedgerLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_LEDGER_PAGE_SIZE;
  const value = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEDGER_PAGE_SIZE) {
    throw new InvalidCommandError('INVALID_PAYLOAD', 'limit is invalid', [
      { path: 'limit', message: `must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}` },
    ]);
  }
  return value;
}

/** Read side. Uses short read-only transactions; no locks. */
export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.run((repos) => repos.wallets.findById(walletId), { readOnly: true });
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
    return wallet;
  }

  async getLedgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageResult> {
    const beforeVersion = cursor ? decodeLedgerCursor(walletId, cursor) : undefined;
    return this.uow.run(
      async (repos) => {
        const wallet = await repos.wallets.findById(walletId);
        if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
        const rows = await repos.ledger.listByWallet(walletId, { beforeVersion, limit: limit + 1 });
        const items = rows.slice(0, limit);
        const last = items.at(-1);
        const nextCursor = rows.length > limit && last ? encodeLedgerCursor(walletId, last.walletVersion) : null;
        return { items, nextCursor };
      },
      { readOnly: true },
    );
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.run((repos) => repos.transactions.findById(transactionId), { readOnly: true });
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${transactionId} not found`);
    return tx;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.run((repos) => repos.transactions.findByExternalId(providerId, externalTransactionId), {
      readOnly: true,
    });
    if (!tx) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${providerId}/${externalTransactionId} not found`);
    }
    return tx;
  }
}
