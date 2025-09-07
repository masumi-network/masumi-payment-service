import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { decrypt } from '@/utils/security/encryption';
import { $Enums } from '@prisma/client';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import stringify from 'canonical-json';
import { checkSignature } from '@meshsdk/core';

export const getSignatureSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'The blockchain identifier, for which the invoice should be created',
    ),
  country: z.string().min(1).max(100),
  city: z.string().min(1).max(100),
  zipCode: z.string().min(1).max(20),
  street: z.string().min(1).max(100),
  streetNumber: z.string().min(1).max(20),
  email: z.string().email().min(1).max(100).nullable(),
  phone: z.string().min(1).max(100).nullable(),
  name: z.string().min(1).max(100).nullable(),
  companyName: z.string().min(1).max(100).nullable(),
  vatNumber: z.string().min(1).max(100).nullable(),
});

export const getSignatureSchemaOutput = z.object({
  signature: z.string(),
  key: z.string(),
  walletAddress: z.string(),
  data: z.string(),
});

export const getSignatureEndpoint = payAuthenticatedEndpointFactory.build({
  method: 'get',
  input: getSignatureSchemaInput,
  output: getSignatureSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof getSignatureSchemaInput>;
    options: {
      id: string;
      permission: $Enums.Permission;
      networkLimit: $Enums.Network[];
      usageLimited: boolean;
    };
  }) => {
    const startTime = Date.now();
    try {
      if (input.companyName == null && input.name == null) {
        throw createHttpError(400, 'Company name or name is required');
      }

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

      const message = stringify({
        action: 'request_invoice',
        validUntil: Date.now() + 1000 * 60 * 60,
        ...input,
      });

      const signature = await meshWallet.signData(
        message,
        wallet.walletAddress,
      );

      return {
        signature: signature.signature,
        key: signature.key,
        walletAddress: wallet.walletAddress,
        data: message,
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
        'GET',
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

export const postGenerateInvoiceSchemaInput = z.object({
  signature: z.string().max(2000).describe('The signature to verify'),
  key: z.string().max(2000).describe('The key to verify the signature'),
  walletAddress: z
    .string()
    .max(100)
    .describe('The wallet address that signed the message'),
  validUntil: z.number().describe('The valid until timestamp'),
  blockchainIdentifier: z
    .string()
    .describe(
      'The blockchain identifier, for which the invoice should be created',
    ),
  action: z.literal('generate_invoice').describe('The action to perform'),
  invoiceTitle: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('The title of the invoice'),
  invoiceDescription: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The description of the invoice'),
  invoiceNumber: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('The number of the invoice'),
  invoiceDate: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('The date of the invoice'),
  invoiceGreetings: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The greetings of the invoice'),
  invoiceClosing: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The closing of the invoice'),
  invoiceSignature: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The signature of the invoice'),
  invoiceLogo: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The logo of the invoice'),
  invoiceFooter: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The footer of the invoice'),
  invoiceTerms: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The terms of the invoice'),
  invoicePrivacy: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The privacy of the invoice'),
  invoiceDisclaimer: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('The disclaimer of the invoice'),
  invoiceItems: z
    .array(
      z.object({
        name: z.string().min(1).max(100).describe('The name of the item'),
        quantity: z.number().min(1).describe('The quantity of the item'),
        price: z.number().describe('The price of the item'),
        currency: z
          .string()
          .min(1)
          .max(100)
          .describe('The currency of the item'),
        total: z.number().min(1).describe('The total of the item'),
      }),
    )
    .optional()
    .describe('The items of the invoice'),
  seller: z.object({
    country: z.string().min(1).max(100).describe('The country of the invoice'),
    city: z.string().min(1).max(100).describe('The city of the invoice'),
    zipCode: z.string().min(1).max(20).describe('The zip code of the invoice'),
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
  buyer: z.object({
    country: z.string().min(1).max(100).describe('The country of the invoice'),
    city: z.string().min(1).max(100).describe('The city of the invoice'),
    zipCode: z.string().min(1).max(20).describe('The zip code of the invoice'),
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
});

export const postGenerateInvoiceSchemaOutput = z.object({
  invoice: z.string(),
});

export const postGenerateInvoiceEndpoint =
  adminAuthenticatedEndpointFactory.build({
    method: 'post',
    input: postGenerateInvoiceSchemaInput,
    output: postGenerateInvoiceSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof postGenerateInvoiceSchemaInput>;
      options: {
        id: string;
        permission: $Enums.Permission;
        networkLimit: $Enums.Network[];
        usageLimited: boolean;
      };
    }) => {
      const startTime = Date.now();
      try {
        if (input.seller.companyName == null && input.seller.name == null) {
          throw createHttpError(400, 'Company name or name is required');
        }
        if (input.buyer.companyName == null && input.buyer.name == null) {
          throw createHttpError(400, 'Company name or name is required');
        }
        const payment = await prisma.paymentRequest.findFirst({
          where: {
            blockchainIdentifier: input.blockchainIdentifier,
          },
          include: {
            BuyerWallet: true,
          },
        });

        if (payment == null) {
          recordBusinessEndpointError(
            '/api/v1/invoice',
            'POST',
            404,
            'Payment not found',
            {
              wallet_address: input.walletAddress,
              operation: 'verify_signature',
            },
          );
          throw createHttpError(404, 'Payment not found');
        }

        if (payment.BuyerWallet == null) {
          throw createHttpError(404, 'Buyer wallet not found');
        }
        if (Date.now() > input.validUntil) {
          throw createHttpError(400, 'Signature is expired');
        }
        if (Date.now() + 1000 * 60 * 60 * 2 < input.validUntil) {
          throw createHttpError(400, 'Signature is to far in the future');
        }

        const message = stringify({
          ...input,
        });

        const isValid = await checkSignature(
          message,
          {
            signature: input.signature,
            key: input.key,
          },
          input.walletAddress,
        );

        if (!isValid) {
          throw createHttpError(400, 'Signature is not valid');
        }
        //TODO: get existing invoices

        return {
          invoice: '',
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
            wallet_address: input.walletAddress,
            operation: 'verify_signature',
            duration: Date.now() - startTime,
          },
        );
        throw error;
      }
    },
  });
