import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { $Enums } from '@prisma/client';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import stringify from 'canonical-json';
import { generateHash } from '@/utils/crypto';

export const postSignatureSchemaInput = z
  .object({
    blockchainIdentifier: z
      .string()
      .describe(
        'The blockchain identifier, for which the invoice should be created',
      ),
    action: z.enum(['retrieve_invoice']).describe('The action to perform'),
    buyer: z.object({
      country: z
        .string()
        .min(1)
        .max(100)
        .describe('The country of the invoice'),
      city: z.string().min(1).max(100).describe('The city of the invoice'),
      zipCode: z
        .string()
        .min(1)
        .max(20)
        .describe('The zip code of the invoice'),
      street: z.string().min(1).max(100).describe('The street of the invoice'),
      streetNumber: z
        .string()
        .min(1)
        .max(20)
        .describe('The street number of the invoice'),
      email: z
        .string()
        .email()
        .min(1)
        .max(100)
        .nullable()
        .describe('The email of the invoice'),
      phone: z
        .string()
        .min(1)
        .max(100)
        .nullable()
        .describe('The phone of the invoice'),
      name: z
        .string()
        .min(1)
        .max(100)
        .nullable()
        .describe('The name of the invoice'),
      companyName: z
        .string()
        .min(1)
        .max(100)
        .nullable()
        .describe('The company name of the invoice'),
      vatNumber: z
        .string()
        .min(1)
        .max(100)
        .nullable()
        .describe('The VAT number of the invoice'),
    }),
  })
  .refine((data) => {
    if (data.buyer.companyName == null && data.buyer.name == null) {
      return false;
    }
    return true;
  });

export const postSignatureSchemaOutput = z.object({
  signature: z.string(),
  key: z.string(),
  walletAddress: z.string(),
  signatureData: z.string(),
});

export const postSignatureEndpoint = payAuthenticatedEndpointFactory.build({
  method: 'post',
  input: postSignatureSchemaInput,
  output: postSignatureSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof postSignatureSchemaInput>;
    options: {
      id: string;
      permission: $Enums.Permission;
      networkLimit: $Enums.Network[];
      usageLimited: boolean;
    };
  }) => {
    const startTime = Date.now();
    try {
      const purchase = await prisma.purchaseRequest.findFirst({
        where: {
          blockchainIdentifier: input.blockchainIdentifier,
        },
        include: {
          PaymentSource: {
            include: {
              PaymentSourceConfig: true,
            },
          },
          SmartContractWallet: {
            include: {
              Secret: true,
            },
          },
        },
      });

      if (purchase == null) {
        throw createHttpError(404, 'Purchase not found');
      }

      if (purchase.onChainState == 'RefundWithdrawn') {
        throw createHttpError(400, 'Purchase is refunded');
      }

      const paymentContract = purchase.PaymentSource;
      const wallet = purchase.SmartContractWallet;

      if (wallet == null) {
        throw createHttpError(404, 'Wallet not found');
      }

      const { wallet: meshWallet } = await generateWalletExtended(
        paymentContract.network,
        paymentContract.PaymentSourceConfig.rpcProviderApiKey,
        wallet.Secret.encryptedMnemonic,
      );

      const signedData = stringify({
        buyer: input.buyer,
        blockchainIdentifier: input.blockchainIdentifier,
      });

      const hash = generateHash(signedData);

      const message = stringify({
        action: input.action,
        validUntil: Date.now() + 1000 * 60 * 60,
        hash: hash,
      });

      const signature = await meshWallet.signData(
        message,
        wallet.walletAddress,
      );

      return {
        signature: signature.signature,
        key: signature.key,
        walletAddress: wallet.walletAddress,
        signatureData: message,
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
        '/api/v1/signature',
        'POST',
        statusCode,
        errorInstance,
        {
          user_id: options.id,
          blockchain_identifier: input.blockchainIdentifier,
          operation: 'get_signature',
          duration: Date.now() - startTime,
        },
      );
      throw error;
    }
  },
});
