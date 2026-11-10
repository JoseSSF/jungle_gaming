import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { JwtAccessTokenVerifier } from '../../src/infrastructure/auth/access-token-verifier';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { prepareDatabase } from '../support/database';
import { uniqueQueues } from '../support/env';
import { assertGlobalInvariants } from '../support/invariants';

/*
 * Authorization rules with locally signed tokens (same claims as Keycloak issues):
 * realm_access.roles, provider_id (hardcoded claim mapper), aud = wagering-api.
 * The optional e2e block at the bottom talks to the real Keycloak from docker compose.
 */

const ISSUER = 'http://localhost:8080/realms/jungle';
const AUDIENCE = 'wagering-api';
let privateKey: CryptoKey;
let jwk: JWK;
let app: Awaited<ReturnType<typeof startApp>>;

async function token(claims: Record<string, unknown>, options: { issuer?: string; audience?: string; expiresIn?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject(String(claims.azp ?? 'subject'))
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(privateKey);
}

const providerToken = (providerId: string) =>
  token({ azp: providerId, provider_id: providerId, realm_access: { roles: ['wagering-provider'] } });
const operatorToken = () => token({ azp: 'backoffice', realm_access: { roles: ['wagering-operator'] } });

beforeAll(async () => {
  await prepareDatabase();
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  app = await startApp(
    { ...uniqueQueues('auth'), AUTH_MODE: 'keycloak' },
    { tokenVerifier: new JwtAccessTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: createLocalJWKSet({ keys: [jwk] }) }) },
  );
});

afterAll(async () => {
  await app?.close();
  await assertGlobalInvariants();
});

describe('authentication', () => {
  test('health and metrics are public', async () => {
    expect((await app.api.request('GET', '/health/live')).status).toBe(200);
    expect((await app.api.request('GET', '/health/ready')).status).toBe(200);
    expect((await app.api.request('GET', '/metrics')).status).toBe(200);
  });

  test('missing, expired, wrong-audience or wrong-issuer tokens → 401', async () => {
    expect((await app.api.request('POST', '/wallets', {})).status).toBe(401);
    const operator = app.api.withToken(
      await token({ realm_access: { roles: ['wagering-operator'] } }, { expiresIn: '-1m' }),
    );
    expect((await operator.request('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37')).status).toBe(401);
    const wrongAudience = app.api.withToken(await token({ realm_access: { roles: ['wagering-operator'] } }, { audience: 'other' }));
    expect((await wrongAudience.request('POST', '/wallets', {})).status).toBe(401);
    const wrongIssuer = app.api.withToken(await token({ realm_access: { roles: ['wagering-operator'] } }, { issuer: 'http://evil' }));
    expect((await wrongIssuer.request('POST', '/wallets', {})).status).toBe(401);
  });
});

describe('authorization', () => {
  test('only operators manage wallets; providers submit only for their own providerId', async () => {
    const operator = app.api.withToken(await operatorToken());
    const providerA = app.api.withToken(await providerToken('provider-a'));

    const denied = await providerA.request('POST', '/wallets', { playerId: 'p-auth', initialBalance: { amount: '10.00', currency: 'BRL' } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_ROLE');

    const { walletId, playerId } = await operator.createWallet('100.00');
    const own = await providerA.submit(wagerPayload(walletId, playerId, { providerId: 'provider-a' }));
    expect(own.status).toBe(201);

    const impersonation = await providerA.submit(wagerPayload(walletId, playerId, { providerId: 'provider-b' }));
    expect(impersonation.status).toBe(403);
    expect(impersonation.body.error.code).toBe('PROVIDER_MISMATCH');

    const operatorSubmit = await operator.submit(wagerPayload(walletId, playerId));
    expect(operatorSubmit.status).toBe(403);

    // Reads: provider B cannot read provider A's transaction; operators can.
    const providerB = app.api.withToken(await providerToken('provider-b'));
    expect((await providerB.request('GET', `/wagering/transactions/${own.body.transactionId}`)).status).toBe(403);
    expect((await operator.request('GET', `/wagering/transactions/${own.body.transactionId}`)).status).toBe(200);
    expect((await providerA.request('GET', `/wallets/${walletId}/ledger`)).status).toBe(403);
    expect((await operator.request('GET', `/wallets/${walletId}/ledger`)).status).toBe(200);
  });
});

const keycloakUrl = process.env.KEYCLOAK_URL;

describe.skipIf(!keycloakUrl)('real Keycloak (set KEYCLOAK_URL to run)', () => {
  test('client_credentials tokens issued by Keycloak are accepted', async () => {
    const fetchToken = async (clientId: string, secret: string) => {
      const response = await fetch(`${keycloakUrl}/realms/jungle/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { access_token: string }).access_token;
    };
    const verifier = new JwtAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: `${keycloakUrl}/realms/jungle/protocol/openid-connect/certs`,
    });
    const provider = await verifier.verify(await fetchToken('provider-a', 'provider-a-local-secret'));
    expect(provider.providerId).toBe('provider-a');
    expect(provider.roles.has('wagering-provider')).toBe(true);
    const operator = await verifier.verify(await fetchToken('backoffice', 'backoffice-local-secret'));
    expect(operator.roles.has('wagering-operator')).toBe(true);
    expect(operator.providerId).toBeUndefined();
  });
});
