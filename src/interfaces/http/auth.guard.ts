import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../application/errors';
import { TOKENS } from '../../app.tokens';
import type { AppConfig } from '../../config/app-config';
import type { AccessTokenVerifier } from '../../infrastructure/auth/access-token-verifier';
import { ANONYMOUS_SYSTEM_PRINCIPAL, hasAnyRole, type Principal } from '../../infrastructure/auth/principal';

const PUBLIC_KEY = 'auth:public';
const ROLES_KEY = 'auth:roles';

/** Route is reachable without a token (health, metrics). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Caller must hold at least one of the given realm roles. */
export const RequireRoles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

/**
 * Global guard: Bearer token → Principal through the AccessTokenVerifier port (Keycloak
 * JWKS). AUTH_MODE=disabled installs a permissive principal — the extension point stays
 * explicit and every controller still goes through the same authorization helpers.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKENS.config) private readonly config: AppConfig,
    @Inject(TOKENS.tokenVerifier) private readonly verifier: AccessTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (this.config.auth.mode === 'disabled') {
      request.principal = ANONYMOUS_SYSTEM_PRINCIPAL;
      return true;
    }

    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match?.[1]) throw new UnauthorizedError();
    const principal = await this.verifier.verify(match[1]);
    request.principal = principal;

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, targets) ?? [];
    if (roles.length > 0 && !hasAnyRole(principal, roles)) {
      throw new ForbiddenError('INSUFFICIENT_ROLE', `Requires one of: ${roles.join(', ')}`);
    }
    return true;
  }
}

export function principalOf(request: AuthenticatedRequest): Principal {
  if (!request.principal) throw new UnauthorizedError();
  return request.principal;
}
