import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { UnauthorizedError } from '../../application/errors';
import type { Principal } from './principal';

/** Port: turns a bearer token into a Principal (or throws UnauthorizedError). */
export interface AccessTokenVerifier {
  verify(token: string): Promise<Principal>;
}

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  /** Remote JWKS URL, or a key resolver (tests use a local JWKS). */
  keys: string | JWTVerifyGetKey;
}

interface KeycloakClaims extends JWTPayload {
  azp?: string;
  provider_id?: unknown;
  realm_access?: { roles?: unknown };
}

/**
 * OIDC access-token verification against the IdP JWKS (Keycloak). Signature (RS256),
 * issuer, audience and expiry are verified locally — no call to the IdP per request
 * (JWKS is cached and refreshed on unknown `kid`).
 */
export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: JwtVerifierOptions) {
    this.keys =
      typeof options.keys === 'string'
        ? createRemoteJWKSet(new URL(options.keys), { cooldownDuration: 30_000, timeoutDuration: 3_000 })
        : options.keys;
  }

  async verify(token: string): Promise<Principal> {
    let payload: KeycloakClaims;
    try {
      ({ payload } = await jwtVerify<KeycloakClaims>(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ['RS256', 'ES256'],
        clockTolerance: 5,
      }));
    } catch {
      throw new UnauthorizedError('Invalid or expired access token');
    }
    const rawRoles = payload.realm_access?.roles;
    const roles = new Set(Array.isArray(rawRoles) ? rawRoles.filter((role): role is string => typeof role === 'string') : []);
    return {
      subject: payload.sub ?? 'unknown',
      clientId: payload.azp,
      providerId: typeof payload.provider_id === 'string' ? payload.provider_id : undefined,
      roles,
      authDisabled: false,
    };
  }
}
