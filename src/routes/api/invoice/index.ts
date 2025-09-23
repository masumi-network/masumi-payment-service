import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { $Enums } from '@prisma/client';
import { recordBusinessEndpointError } from '@/utils/metrics';
import stringify from 'canonical-json';
import { checkSignature } from '@meshsdk/core';
import { generateInvoicePDFBase64 } from '@/utils/invoice/pdf-generator';
import { generateHash } from '@/utils/crypto';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import {
  generateInvoiceGroups,
  resolveInvoiceConfig,
} from '@/utils/invoice/template';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { fetchAssetInWalletAndMetadata } from '@/services/blockchain/asset-metadata';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

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
    signatureData: z.string().describe('The data to verify the signature'),
    action: z.enum(['retrieve_invoice']).describe('The action to perform'),
    currencySettings: z
      .object({
        currencyId: z
          .string()
          .min(1)
          .max(10)
          .describe('The currency ID of the item'),
        currencySymbol: z
          .string()
          .min(1)
          .max(10)
          .describe('The currency symbol of the item'),
        currencyDecimals: z
          .number()
          .int()
          .min(0)
          .max(4)
          .describe('Number of decimal places for this item (0-4)'),
        currencySymbolPosition: z
          .nativeEnum($Enums.SymbolPosition)
          .describe('The position of the currency symbol (before or after)'),
      })
      .optional()
      .describe('Currency settings for this item'),

    currencyConversion: z
      .map(z.string(), z.number())
      .optional()
      .describe('Currency conversion settings for this item'),
    invoice: z
      .object({
        itemNamePrefix: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('The prefix of the item name'),
        itemNameSuffix: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('The suffix of the item name'),
        title: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('The title of the invoice'),
        description: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('The description of the invoice'),
        idPrefix: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('The prefix of the invoice number'),
        id: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('The number of the invoice'),
        date: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('The date of the invoice'),
        greeting: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('The greetings of the invoice'),
        closing: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('The closing of the invoice'),
        signature: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('The signature of the invoice'),
        logo: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('The logo of the invoice'),
        footer: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('The footer of the invoice'),
        terms: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('The terms of the invoice'),
        privacy: z
          .string()
          .min(1)
          .max(1000)
          .optional()
          .describe('The privacy of the invoice'),
        correctionInvoiceReference: z
          .object({
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
        decimals: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe('Global number of decimal places (0-4, default: 2)'),
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
      })
      .optional(),
    vatRate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('The VAT rate as decimal (e.g., 0.19 for 19%)'),
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
      if (!data.invoice) return true;
      if (data.invoice.thousandDelimiter && data.invoice.decimalDelimiter) {
        return data.invoice.thousandDelimiter !== data.invoice.decimalDelimiter;
      }
      return true;
    },
    {
      message: 'Thousand delimiter and decimal delimiter must be different',
      path: ['thousandDelimiter'],
    },
  )
  .refine(
    (data) => {
      if (data.seller.companyName == null && data.seller.name == null) {
        return false;
      }
      return true;
    },
    {
      message: 'Company name or name is required',
      path: ['seller', 'companyName'],
    },
  )
  .refine((data) => {
    if (data.buyer.companyName == null && data.buyer.name == null) {
      return false;
    }
    return true;
  })
  .refine(
    (data) => {
      if (!data.invoice) return true;
      if (
        data.invoice.thousandDelimiter &&
        data.invoice.decimalDelimiter &&
        data.invoice.thousandDelimiter === data.invoice.decimalDelimiter
      ) {
        return false;
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

interface ExistingInvoiceItem {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
  name: string;
  quantity: number | { toString(): string };
  pricePerUnitWithoutVat: number | { toString(): string };
  vatRate: number | { toString(): string };
  currencyShortId?: string;
  currency?: string;
  currencySymbol?: string;
  decimals: number;
  currencySymbolPosition?: $Enums.SymbolPosition;
  invoiceRevisionId?: string;
}

interface ExistingInvoiceBase {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  buyer?: InvoiceParty;
  seller?: InvoiceParty;
  title?: string | null;
  date?: string | null;
  greeting?: string | null;
  closing?: string | null;
  signature?: string | null;
  logo?: string | null;
  footer?: string | null;
  terms?: string | null;
  privacy?: string | null;
  invoiceNumber?: string | null;
  correctionInvoiceReference?: unknown;
  decimals?: number | null;
  thousandDelimiter?: string | null;
  decimalDelimiter?: string | null;
  language?: string | null;
  dateFormat?: string | null;
}

interface ExistingInvoiceRevision {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  revisionNumber: number;
  vatRate?: number | { toString(): string };
  buyer?: InvoiceParty;
  seller?: InvoiceParty;
  title?: string | null;
  date?: string | null;
  greeting?: string | null;
  closing?: string | null;
  signature?: string | null;
  logo?: string | null;
  footer?: string | null;
  terms?: string | null;
  privacy?: string | null;
  invoiceNumber?: string | null;
  correctionInvoiceReference?: unknown;
  decimals?: number | null;
  thousandDelimiter?: string | null;
  decimalDelimiter?: string | null;
  language?: string | null;
  dateFormat?: string | null;
  invoiceItems: ExistingInvoiceItem[];
  InvoiceBase?: ExistingInvoiceBase;
}

interface InvoiceParty {
  name: string | null;
  country: string;
  city: string;
  zipCode: string;
  street: string;
  streetNumber: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  vatNumber: string | null;
}

function compareInvoiceParty(
  party1: InvoiceParty,
  party2: InvoiceParty,
): boolean {
  return (
    party1.name === party2.name &&
    party1.country === party2.country &&
    party1.city === party2.city &&
    party1.zipCode === party2.zipCode &&
    party1.street === party2.street &&
    party1.streetNumber === party2.streetNumber &&
    party1.email === party2.email &&
    party1.phone === party2.phone &&
    party1.companyName === party2.companyName &&
    party1.vatNumber === party2.vatNumber
  );
}

function invoiceDataMatches(
  input: z.infer<typeof postGenerateInvoiceSchemaInput>,
  existingInvoiceItems: ExistingInvoiceItem[],
  existingBuyer: InvoiceParty,
  existingSeller: InvoiceParty,
  existingInvoiceMetadata: {
    title?: string | null;
    date?: string | null;
    greeting?: string | null;
    closing?: string | null;
    signature?: string | null;
    logo?: string | null;
    footer?: string | null;
    terms?: string | null;
    privacy?: string | null;
    invoiceNumber?: string | null;
    correctionInvoiceReference?: unknown;
    decimals?: number | null;
    thousandDelimiter?: string | null;
    decimalDelimiter?: string | null;
    language?: string | null;
    dateFormat?: string | null;
  },
): boolean {
  // Generate invoice groups for input data to compare
  const inputGroups = generateInvoiceGroups(input.items, input.vatRate ?? 0);

  // Generate invoice groups for existing invoice data
  const existingItems = existingInvoiceItems?.map((item) => ({
    name: item.name,
    quantity: Number(item.quantity),
    price: Number(item.pricePerUnitWithoutVat),
    vatRateOverride: Number(item.vatRate),
    currencyOverride:
      item.currencyShortId || item.currency
        ? {
            currencyId: item.currencyShortId || item.currency || 'USD',
            currencySymbol:
              item.currencySymbol ||
              item.currencyShortId ||
              item.currency ||
              'USD',
            currencyDecimals: item.decimals,
            currencySymbolPosition:
              item.currencySymbolPosition || $Enums.SymbolPosition.Before,
          }
        : undefined,
  }));

  const existingGroups = generateInvoiceGroups(existingItems, 0);

  // Compare invoice groups
  const groupsMatch = stringify(inputGroups) === stringify(existingGroups);

  if (!groupsMatch) return false;

  // Compare buyer data using the dedicated function
  const buyerMatches = compareInvoiceParty(input.buyer, existingBuyer);

  // Compare seller data using the dedicated function
  const sellerMatches = compareInvoiceParty(input.seller, existingSeller);

  // Compare invoice metadata
  if (!existingInvoiceMetadata) {
    return buyerMatches && sellerMatches;
  }

  const invoiceMatches =
    input.invoice?.title === existingInvoiceMetadata.title &&
    input.invoice?.date === existingInvoiceMetadata.date &&
    input.invoice?.greeting === existingInvoiceMetadata.greeting &&
    input.invoice?.closing === existingInvoiceMetadata.closing &&
    input.invoice?.signature === existingInvoiceMetadata.signature &&
    input.invoice?.logo === existingInvoiceMetadata.logo &&
    input.invoice?.footer === existingInvoiceMetadata.footer &&
    input.invoice?.terms === existingInvoiceMetadata.terms &&
    input.invoice?.privacy === existingInvoiceMetadata.privacy &&
    input.invoice?.id === existingInvoiceMetadata.invoiceNumber &&
    stringify(input.invoice?.correctionInvoiceReference) ===
      stringify(existingInvoiceMetadata.correctionInvoiceReference) &&
    input.invoice?.decimals === existingInvoiceMetadata.decimals &&
    input.invoice?.thousandDelimiter ===
      existingInvoiceMetadata.thousandDelimiter &&
    input.invoice?.decimalDelimiter ===
      existingInvoiceMetadata.decimalDelimiter &&
    input.invoice?.language === existingInvoiceMetadata.language &&
    input.invoice?.dateFormat === existingInvoiceMetadata.dateFormat;

  return buyerMatches && sellerMatches && invoiceMatches;
}

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
        const payment = await prisma.paymentRequest.findFirst({
          where: {
            blockchainIdentifier: input.blockchainIdentifier,
          },
          include: {
            BuyerWallet: true,
            RequestedFunds: true,
            PaymentSource: { include: { PaymentSourceConfig: true } },
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
          buyer: input.buyer,
          blockchainIdentifier: input.blockchainIdentifier,
        });
        const hash = generateHash(message);

        const signedData = stringify({
          action: input.action,
          validUntil: input.validUntil,
          hash: hash,
        });

        const isValid = await checkSignature(
          signedData,
          {
            signature: input.signature,
            key: input.key,
          },
          input.walletAddress,
        );

        if (!isValid) {
          throw createHttpError(400, 'Signature is not valid');
        }

        if (
          resolvePaymentKeyHash(input.walletAddress) !==
          resolvePaymentKeyHash(payment.BuyerWallet.walletAddress)
        ) {
          throw createHttpError(400, 'Wallet is not the buyer wallet');
        }

        const existingInvoice = await prisma.invoiceRevision.findFirst({
          where: {
            invoiceItems: {
              some: {
                referencedPayment: {
                  blockchainIdentifier: input.blockchainIdentifier,
                },
              },
            },
          },
          take: 1,
          orderBy: {
            revisionNumber: 'desc',
          },
          include: {
            InvoiceBase: true,
            invoiceItems: true,
          },
        });
        const decidedIdentifier = decodeBlockchainIdentifier(
          input.blockchainIdentifier,
        );
        const agentIdentifier = decidedIdentifier?.agentIdentifier;
        if (!agentIdentifier) {
          throw createHttpError(404, 'Agent identifier not found');
        }
        const blockfrost = new BlockFrostAPI({
          projectId:
            payment.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
        });
        const agentName = await fetchAssetInWalletAndMetadata(
          blockfrost,
          agentIdentifier,
        );
        if ('error' in agentName) {
          throw createHttpError(404, 'Agent not found');
        }
        const { assetInWallet, parsedMetadata } = agentName.data;
        const resolved = resolveInvoiceConfig(input.invoice);
        const invoiceItems =
          existingInvoice?.invoiceItems != undefined
            ? existingInvoice.invoiceItems
            : calculateInvoiceItemsForPayment(
                input.itemNamePrefix +
                  parsedMetadata.agentName +
                  input.itemNameSuffix,
                payment.RequestedFunds,
                input.vatRate ?? 0,
              );

        const allDataMatches = existingInvoice
          ? invoiceDataMatches(
              input,
              invoiceItems,
              existingInvoice.buyer,
              existingInvoice.seller,
              existingInvoice,
            )
          : false;

        let pdfBase64 = '';

        if (existingInvoice == null) {
          //generate new invoice
          pdfBase64 = await generateInvoicePDFBase64(input);
        }
        if (!allDataMatches) {
          pdfBase64 = await generateInvoicePDFBase64(input);
        }

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
function calculateInvoiceItemsForPayment(
  itemName: string,
  Funds: Array<{
    unit: string;
    amount: bigint;
  }>,
  vatRate: number,
) {
  throw new Error('Function not implemented.');
}
