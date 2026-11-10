import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { parseSubmitWagerTransactionCommand } from '../../application/commands/submit-wager-transaction.command';
import type { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction.use-case';
import type { WageringQueries } from '../../application/use-cases/wagering-queries';
import { TOKENS } from '../../app.tokens';
import { FAILURE_CODE_ACTIONS } from '../../domain/wagering/failure-code';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { assertProviderAccess, ROLE_OPERATOR, ROLE_PROVIDER } from '../../infrastructure/auth/principal';
import { currentContext, enrichContext } from '../../infrastructure/observability/request-context';
import { type AuthenticatedRequest, principalOf, RequireRoles } from './auth.guard';
import { identifierParam, uuidParam } from './params';
import { presentSubmitResult, presentTransaction, type SubmitResponseBody, submitHttpStatus } from './presenters';

@Controller()
export class WageringController {
  constructor(
    @Inject(TOKENS.submitWager) private readonly submitWager: SubmitWagerTransactionUseCase,
    @Inject(TOKENS.queries) private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  @RequireRoles(ROLE_PROVIDER)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitResponseBody> {
    const command = parseSubmitWagerTransactionCommand(body, idempotencyKey);
    assertProviderAccess(principalOf(request), command.providerId, true);
    enrichContext({ providerId: command.providerId, walletId: command.walletId });
    const correlationId = currentContext().correlationId ?? command.idempotencyKey;

    const result = await this.submitWager.execute(command, {
      source: 'http',
      correlationId,
      causationId: `http:${command.idempotencyKey}`,
    });

    switch (result.type) {
      case 'wallet-not-found':
        response.status(422);
        return {
          transactionId: null,
          status: WagerTransactionStatus.Rejected,
          balance: null,
          idempotentReplay: false,
          failureCode: result.failureCode,
          providerAction: FAILURE_CODE_ACTIONS[result.failureCode],
        };
      case 'duplicate-message':
        // Only reachable through the inbox (SQS); HTTP never registers inbox messages.
        throw new Error('Unexpected duplicate-message result on HTTP');
      case 'transaction': {
        const tx = result.transaction;
        enrichContext({ transactionId: tx.id });
        response.status(submitHttpStatus(tx.status));
        response.setHeader('Location', `/wagering/transactions/${tx.id}`);
        if (result.replay) response.setHeader('Idempotent-Replayed', 'true');
        return presentSubmitResult(tx, result.replay);
      }
    }
  }

  @Get('wagering/transactions/:transactionId')
  @RequireRoles(ROLE_PROVIDER, ROLE_OPERATOR)
  async getTransaction(@Param('transactionId') transactionId: string, @Req() request: AuthenticatedRequest) {
    const tx = await this.queries.getTransaction(uuidParam(transactionId, 'transactionId'));
    assertProviderAccess(principalOf(request), tx.providerId, false);
    return presentTransaction(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @RequireRoles(ROLE_PROVIDER, ROLE_OPERATOR)
  async getTransactionByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertProviderAccess(principalOf(request), identifierParam(providerId, 'providerId'), false);
    const tx = await this.queries.getTransactionByExternalId(
      providerId,
      identifierParam(externalTransactionId, 'externalTransactionId'),
    );
    return presentTransaction(tx);
  }
}
