import { v7 as uuidv7 } from 'uuid';

export interface ApiResponse<T = Record<string, any>> {
  status: number;
  body: T;
  headers: Headers;
}

export interface WagerOverrides {
  providerId?: string;
  externalTransactionId?: string;
  kind?: string;
  amount?: string;
  currency?: string;
  roundId?: string;
  gameId?: string;
  referenceExternalTransactionId?: string;
  playerId?: string;
}

export function wagerPayload(walletId: string, playerId: string, overrides: WagerOverrides = {}) {
  const payload: Record<string, unknown> = {
    providerId: overrides.providerId ?? 'provider-a',
    externalTransactionId: overrides.externalTransactionId ?? `tx-${uuidv7()}`,
    playerId: overrides.playerId ?? playerId,
    walletId,
    roundId: overrides.roundId ?? 'round-1',
    gameId: overrides.gameId ?? 'fortune-chimp',
    kind: overrides.kind ?? 'BET',
    money: { amount: overrides.amount ?? '10.00', currency: overrides.currency ?? 'BRL' },
  };
  if (overrides.referenceExternalTransactionId) {
    payload.referenceExternalTransactionId = overrides.referenceExternalTransactionId;
  }
  return payload;
}

export class Api {
  constructor(
    readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  withToken(token: string): Api {
    return new Api(this.baseUrl, token);
  }

  async request<T = Record<string, any>>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // non-JSON (e.g. /metrics)
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  async createWallet(amount = '100.00', playerId = `player-${uuidv7()}`, currency = 'BRL') {
    const response = await this.request('POST', '/wallets', { playerId, initialBalance: { amount, currency } });
    if (response.status !== 201) throw new Error(`createWallet failed: ${response.status} ${JSON.stringify(response.body)}`);
    return { walletId: response.body.id as string, playerId, response };
  }

  submit(payload: Record<string, unknown>, idempotencyKey?: string) {
    const key = idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}`;
    return this.request('POST', '/wagering/transactions', payload, { 'idempotency-key': key });
  }

  wallet(walletId: string) {
    return this.request('GET', `/wallets/${walletId}`);
  }

  reconcile(walletId: string) {
    return this.request('POST', `/wallets/${walletId}/reconciliation`);
  }
}
