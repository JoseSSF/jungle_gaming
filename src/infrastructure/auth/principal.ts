import { ForbiddenError } from '../../application/errors';

export const ROLE_PROVIDER = 'wagering-provider';
export const ROLE_OPERATOR = 'wagering-operator';

/** Authenticated caller, derived from a verified access token. */
export interface Principal {
  subject: string;
  clientId?: string;
  /** Provider identity bound to the client (claim `provider_id`). */
  providerId?: string;
  roles: ReadonlySet<string>;
  /** true when AUTH_MODE=disabled: every check passes (local development only). */
  authDisabled: boolean;
}

export const ANONYMOUS_SYSTEM_PRINCIPAL: Principal = Object.freeze({
  subject: 'auth-disabled',
  roles: new Set([ROLE_PROVIDER, ROLE_OPERATOR]),
  authDisabled: true,
});

export function hasAnyRole(principal: Principal, roles: readonly string[]): boolean {
  return principal.authDisabled || roles.some((role) => principal.roles.has(role));
}

/**
 * A provider can only act on its own providerId. Operators can read everything.
 * `forWrite` = submitting wagers: operators are not allowed to impersonate providers.
 */
export function assertProviderAccess(principal: Principal, providerId: string, forWrite: boolean): void {
  if (principal.authDisabled) return;
  if (!forWrite && principal.roles.has(ROLE_OPERATOR)) return;
  if (!principal.roles.has(ROLE_PROVIDER) || principal.providerId !== providerId) {
    throw new ForbiddenError('PROVIDER_MISMATCH', 'The access token is not bound to this providerId');
  }
}
