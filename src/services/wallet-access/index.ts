import { Permission } from '@prisma/client';
import createHttpError from 'http-errors';

export interface AccessContext {
  apiKeyId: string;
  permission: Permission;
  allowedWalletIds: string[];
}

export class WalletAccess {
  /**
   * Get array of allowed wallet IDs from context
   */
  static getAllowedWalletIds(context: AccessContext): string[] {
    return context.allowedWalletIds;
  }

  /**
   * Build filter for Prisma queries based on wallet access
   * Returns the baseWhere with wallet filtering added if needed
   */
  static buildFilter<T extends Record<string, unknown>>(
    context: AccessContext,
    baseWhere: T = {} as T,
  ): T {
    if (context.permission === Permission.Admin) {
      return baseWhere;
    }

    if (context.permission === Permission.WalletScoped) {
      if (context.allowedWalletIds.length === 0) {
        // No wallets assigned - return filter that matches nothing
        return {
          ...baseWhere,
          id: 'never-match-this-id',
        } as T;
      }

      // For payments: filter by SmartContractWallet.id (seller HotWallet)
      // For purchases: filter by SmartContractWallet.id (buyer/purchasing HotWallet)
      // For registry: filter by SmartContractWallet.id (seller HotWallet)
      return {
        ...baseWhere,
        SmartContractWallet: {
          ...((baseWhere as { SmartContractWallet?: unknown })
            .SmartContractWallet as Record<string, unknown> | undefined),
          id: { in: context.allowedWalletIds },
          deletedAt: null,
        },
      } as T;
    }

    return baseWhere;
  }

  /**
   * Validate that a resource's wallet is in the allowed list
   * Throws 404 if not found (to prevent enumeration)
   */
  static validateResourceAccess(
    context: AccessContext,
    resource: { smartContractWalletId: string | null } | null,
  ): Promise<void> {
    if (context.permission === Permission.Admin) {
      return Promise.resolve();
    }

    if (!resource) {
      throw createHttpError(404, 'Resource not found');
    }

    if (context.permission === Permission.WalletScoped) {
      if (context.allowedWalletIds.length === 0) {
        throw createHttpError(404, 'Resource not found');
      }

      if (!resource.smartContractWalletId) {
        // Resource has no wallet assigned yet - not accessible to WalletScoped keys
        throw createHttpError(404, 'Resource not found');
      }

      if (!context.allowedWalletIds.includes(resource.smartContractWalletId)) {
        throw createHttpError(404, 'Resource not found');
      }
    }

    return Promise.resolve();
  }

  /**

   */
  static isWalletAllowedForKey(
    context: AccessContext,
    walletId: string,
  ): boolean {
    if (context.permission === Permission.Admin) {
      return true;
    }

    if (context.permission === Permission.WalletScoped) {
      return context.allowedWalletIds.includes(walletId);
    }

    return true;
  }

  /**
   * Require access to a specific wallet
   */
  static requireWalletAccess(context: AccessContext, walletId: string): void {
    if (!this.isWalletAllowedForKey(context, walletId)) {
      throw createHttpError(403, 'Forbidden: Cannot access this wallet');
    }
  }
}
