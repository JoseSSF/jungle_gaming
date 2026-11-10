/**
 * Fetches an access token from Keycloak (client_credentials) for manual API calls.
 *
 *   bun run auth:token -- provider-a          # provider-a / provider-a-secret
 *   bun run auth:token -- backoffice          # operator client
 *
 * Secrets below are the local development secrets from docker/keycloak/jungle-realm.json.
 */
const LOCAL_CLIENT_SECRETS: Record<string, string> = {
  'provider-a': 'provider-a-local-secret',
  'provider-b': 'provider-b-local-secret',
  backoffice: 'backoffice-local-secret',
};

async function main(): Promise<void> {
  const clientId = process.argv.slice(2).find((arg) => arg !== '--') ?? 'provider-a';
  const secret = process.env.CLIENT_SECRET ?? LOCAL_CLIENT_SECRETS[clientId];
  if (!secret) throw new Error(`Unknown client ${clientId}; set CLIENT_SECRET`);
  const baseUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
  const response = await fetch(`${baseUrl}/realms/jungle/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
  });
  if (!response.ok) throw new Error(`Token request failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { access_token: string };
  process.stdout.write(`${body.access_token}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
