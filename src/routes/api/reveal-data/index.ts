import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { Permission } from '@/generated/prisma/client';
import { recordBusinessEndpointError } from '@/utils/metrics';
import stringify from 'canonical-json';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { checkSignature, resolvePaymentKeyHash } from '@meshsdk/core';
import { CONSTANTS } from '@/utils/config';
import { AuthContext } from '@/utils/middleware/auth-middleware';

export const postVerifyDataRevealSchemaInput = z.object({
  signature: z
    .string()
    .max(7500)
    .describe('Cryptographic signature from the admin wallet'),
  key: z.string().max(2500).describe('Public key used to create the signature'),
  walletAddress: z
    .string()
    .max(250)
    .describe('Cardano address of the admin wallet signing the request'),
  validUntil: z
    .number()
    .min(0)
    .max(1000000000000000000)
    .describe(
      'Unix timestamp (in milliseconds) until which this signature is valid',
    ),
  blockchainIdentifier: z
    .string()
    .min(1)
    .max(2500)
    .describe(
      'The blockchain identifier, for which the data should be revealed',
    ),
  action: z.literal('reveal_data').describe('The action to perform'),
});

export const postRevealDataSchemaOutput = z.object({
  isValid: z
    .boolean()
    .describe('Whether the signature is valid and the data can be revealed'),
});

export const revealDataEndpointPost = readAuthenticatedEndpointFactory.build({
  method: 'post',
  input: postVerifyDataRevealSchemaInput,
  output: postRevealDataSchemaOutput,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof postVerifyDataRevealSchemaInput>;
    ctx: AuthContext;
  }) => {
    const startTime = Date.now();
    try {
      const payment = await prisma.paymentRequest.findFirst({
        where: {
          blockchainIdentifier: input.blockchainIdentifier,
        },
        include: {
          PaymentSource: {
            include: {
              PaymentSourceConfig: true,
              AdminWallets: true,
            },
          },
        },
      });

      if (payment == null) {
        recordBusinessEndpointError(
          '/api/v1/reveal-data',
          'POST',
          404,
          'Payment not found',
          {
            wallet_address: input.walletAddress,
            blockchain_identifier: input.blockchainIdentifier,
            valid_until: input.validUntil,
            signature: input.signature,
            key: input.key,
          },
        );
        throw createHttpError(404, 'Payment not found');
      }
      if (
        ctx.permission !== Permission.Admin &&
        !ctx.networkLimit.includes(payment.PaymentSource.network)
      ) {
        recordBusinessEndpointError(
          '/api/v1/reveal-data',
          'POST',
          400,
          'Payment is not on the requested network',
        );
        throw createHttpError(403, 'Network not allowed');
      }
      if (payment.onChainState !== 'Disputed') {
        recordBusinessEndpointError(
          '/api/v1/reveal-data',
          'POST',
          400,
          'Payment is not disputed state',
          {
            wallet_address: input.walletAddress,
            blockchain_identifier: input.blockchainIdentifier,
            valid_until: input.validUntil,
            signature: input.signature,
            key: input.key,
          },
        );
        throw createHttpError(400, 'Payment is not disputed state');
      }
      if (
        !payment.PaymentSource.AdminWallets.some(
          (adminWallet) =>
            resolvePaymentKeyHash(adminWallet.walletAddress) ===
            resolvePaymentKeyHash(input.walletAddress),
        )
      ) {
        recordBusinessEndpointError(
          '/api/v1/reveal-data',
          'POST',
          400,
          'Wallet is not an admin wallet',
          {
            wallet_address: input.walletAddress,
            blockchain_identifier: input.blockchainIdentifier,
            valid_until: input.validUntil,
            signature: input.signature,
            key: input.key,
          },
        );
        throw createHttpError(400, 'Wallet is not an admin wallet');
      }

      if (Date.now() > input.validUntil) {
        recordBusinessEndpointError(
          '/api/v1/reveal-data',
          'POST',
          400,
          'Signature is expired',
          {
            wallet_address: input.walletAddress,
            blockchain_identifier: input.blockchainIdentifier,
            valid_until: input.validUntil,
            signature: input.signature,
            key: input.key,
          },
        );
        throw createHttpError(400, 'Signature is expired');
      }
      if (Date.now() + CONSTANTS.REVEAL_DATA_VALIDITY_TIME < input.validUntil) {
        recordBusinessEndpointError(
          '/api/v1/reveal-data',
          'POST',
          400,
          'Signature is to far in the future',
          {
            wallet_address: input.walletAddress,
            operation: 'reveal_data',
          },
        );
        throw createHttpError(400, 'Signature is to far in the future');
      }

      const message = stringify({
        action: 'reveal_data',
        validUntil: input.validUntil,
        blockchainIdentifier: input.blockchainIdentifier,
      });

      const isValid = await checkSignature(
        message,
        {
          signature: input.signature,
          key: input.key,
        },
        input.walletAddress,
      );

      return {
        isValid,
      };
    } catch (error) {
      const errorInstance =
        error instanceof Error ? error : new Error(String(error));
      const statusCode =
        (errorInstance as { statusCode?: number; status?: number })
          .statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;
      recordBusinessEndpointError(
        '/api/v1/reveal-data',
        'POST',
        statusCode,
        errorInstance,
        {
          user_id: ctx.id,
          wallet_id: input.walletAddress,
          blockchain_identifier: input.blockchainIdentifier,
          valid_until: input.validUntil,
          signature: input.signature,
          key: input.key,
          duration: Date.now() - startTime,
        },
      );
      throw error;
    }
  },
});
