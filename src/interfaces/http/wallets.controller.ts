import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { type CreateWalletUseCase, parseCreateWalletCommand } from '../../application/use-cases/create-wallet.use-case';
import type { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { parseLedgerLimit, type WageringQueries } from '../../application/use-cases/wagering-queries';
import { TOKENS } from '../../app.tokens';
import { ROLE_OPERATOR, ROLE_PROVIDER } from '../../infrastructure/auth/principal';
import { currentContext, enrichContext } from '../../infrastructure/observability/request-context';
import { RequireRoles } from './auth.guard';
import { uuidParam } from './params';
import { presentLedgerEntry, presentReconciliation, presentWallet } from './presenters';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(TOKENS.createWallet) private readonly createWallet: CreateWalletUseCase,
    @Inject(TOKENS.reconcileWallet) private readonly reconcileWallet: ReconcileWalletUseCase,
    @Inject(TOKENS.queries) private readonly queries: WageringQueries,
  ) {}

  /** 201 created · 400 invalid payload · 409 WALLET_ALREADY_EXISTS (playerId + currency). */
  @Post()
  @HttpCode(201)
  @RequireRoles(ROLE_OPERATOR)
  async create(@Body() body: unknown) {
    const command = parseCreateWalletCommand(body);
    const wallet = await this.createWallet.execute(command, { correlationId: currentContext().correlationId ?? 'unknown' });
    enrichContext({ walletId: wallet.id });
    return presentWallet(wallet);
  }

  @Get(':walletId')
  @RequireRoles(ROLE_OPERATOR, ROLE_PROVIDER)
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.queries.getWallet(uuidParam(walletId, 'walletId'));
    return presentWallet(wallet);
  }

  @Get(':walletId/ledger')
  @RequireRoles(ROLE_OPERATOR)
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const page = await this.queries.getLedgerPage(uuidParam(walletId, 'walletId'), cursor || undefined, parseLedgerLimit(limit));
    return { items: page.items.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @RequireRoles(ROLE_OPERATOR)
  async reconcile(@Param('walletId') walletId: string) {
    const id = uuidParam(walletId, 'walletId');
    enrichContext({ walletId: id });
    return presentReconciliation(await this.reconcileWallet.execute(id));
  }
}
