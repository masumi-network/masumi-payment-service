import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { $Enums } from '@prisma/client';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import stringify from 'canonical-json';
import { checkSignature } from '@meshsdk/core';
import { generateInvoicePDFBase64 } from '@/utils/invoice/pdf-generator';

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

export const postGenerateInvoiceSchemaInput = z
  .object({
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
    correctionInvoiceReference: z
      .object({
        originalInvoiceNumber: z
          .string()
          .min(1)
          .max(100)
          .describe('The number of the original invoice being corrected'),
        originalInvoiceDate: z
          .string()
          .min(1)
          .max(100)
          .describe('The date of the original invoice being corrected'),
        correctionReason: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('Reason for the correction (optional)'),
        correctionTitle: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Custom title for the correction notice (default: "CORRECTION INVOICE")',
          ),
        correctionDescription: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            'Custom description text for the correction notice (default: "This invoice corrects the original invoice...")',
          ),
      })
      .optional()
      .describe(
        'Reference to the original invoice if this is a correction invoice',
      ),
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
          vatRateOverride: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe('The VAT rate as decimal (e.g., 0.19 for 19%)'),
          vatIsIncludedInThePriceOverride: z
            .boolean()
            .optional()
            .describe('Whether the VAT is included in the price'),
          decimalsOverride: z
            .number()
            .int()
            .min(0)
            .max(4)
            .optional()
            .describe('Number of decimal places for this item (0-4)'),
          currencyOverride: z
            .string()
            .min(1)
            .max(10)
            .optional()
            .describe('Currency override for this item'),
        }),
      )
      .optional()
      .describe('The items of the invoice'),
    decimals: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe('Global number of decimal places (0-4, default: 2)'),
    currency: z
      .string()
      .min(1)
      .max(10)
      .optional()
      .describe('Global currency (e.g., EUR, USD, GBP)'),
    thousandDelimiter: z
      .enum([',', '.', ' ', "'"])
      .optional()
      .describe(
        "Thousand separator: comma (1,000), period (1.000), space (1 000), or apostrophe (1'000). Default: Node.js default",
      ),
    decimalDelimiter: z
      .enum(['.', ','])
      .optional()
      .describe(
        'Decimal separator: period (1234.56) or comma (1234,56). Default: period',
      ),
    language: z
      .enum(['en-us', 'en-uk', 'de'])
      .optional()
      .describe(
        'Invoice language and region: English US (en-us), English UK (en-uk), or German (de). Default: en-us',
      ),
    dateFormat: z
      .string()
      .optional()
      .describe(
        'Date format override (e.g., "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"). If not specified, uses language default',
      ),
    vatRate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('The VAT rate as decimal (e.g., 0.19 for 19%)'),
    vatIsIncludedInThePrice: z
      .boolean()
      .optional()
      .describe('Whether the VAT is included in the price'),
    seller: z.object({
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
  .refine(
    (data) => {
      // Ensure thousand and decimal delimiters are different when both are specified
      if (data.thousandDelimiter && data.decimalDelimiter) {
        return data.thousandDelimiter !== data.decimalDelimiter;
      }
      return true;
    },
    {
      message: 'Thousand delimiter and decimal delimiter must be different',
      path: ['thousandDelimiter'],
    },
  );

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

        const pdfBase64 = await generateInvoicePDFBase64(input);

        return {
          invoice: pdfBase64,
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
