import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { $Enums } from '@prisma/client';
import { recordBusinessEndpointError } from '@/utils/metrics';
import stringify from 'canonical-json';
import { checkSignature } from '@meshsdk/core';
import { generateInvoicePDFBase64 } from '@/utils/invoice/pdf-generator';
import {
  generateInvoiceGroups,
  resolveInvoiceConfig,
  InvoiceGroupItemInput,
  InvoiceGroup,
} from '@/utils/invoice/template';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { fetchAssetInWalletAndMetadata } from '@/services/blockchain/asset-metadata';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { generateHash } from '@/utils/crypto';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
// Template helpers are used inside the PDF generator

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
      .map(z.string(), z.number().gt(0))
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

function partiesEqual(
  a: {
    name: string | null;
    companyName: string | null;
    vatNumber: string | null;
    country: string;
    city: string;
    zipCode: string;
    street: string;
    streetNumber: string;
    email: string | null;
    phone: string | null;
  },
  b: {
    name: string | null;
    companyName: string | null;
    vatNumber: string | null;
    country: string;
    city: string;
    zipCode: string;
    street: string;
    streetNumber: string;
    email: string | null;
    phone: string | null;
  },
): boolean {
  return (
    a.name === b.name &&
    a.companyName === b.companyName &&
    a.vatNumber === b.vatNumber &&
    a.country === b.country &&
    a.city === b.city &&
    a.zipCode === b.zipCode &&
    a.street === b.street &&
    a.streetNumber === b.streetNumber &&
    a.email === b.email &&
    a.phone === b.phone
  );
}

export function checkIfCorrectionInvoice(
  existingInvoice: {
    invoiceItems: Array<{
      name: string;
      quantity: { toString(): string } | number;
      pricePerUnitWithoutVat: { toString(): string } | number;
      vatRate: { toString(): string } | number;
    }>;
    sellerName?: string | null;
    sellerCompanyName?: string | null;
    sellerVatNumber?: string | null;
    sellerCountry?: string;
    sellerCity?: string;
    sellerZipCode?: string;
    sellerStreet?: string;
    sellerStreetNumber?: string;
    sellerEmail?: string | null;
    sellerPhone?: string | null;
    buyerName?: string | null;
    buyerCompanyName?: string | null;
    buyerVatNumber?: string | null;
    buyerCountry?: string;
    buyerCity?: string;
    buyerZipCode?: string;
    buyerStreet?: string;
    buyerStreetNumber?: string;
    buyerEmail?: string | null;
    buyerPhone?: string | null;
    invoiceTitle?: string | null;
    invoiceDate?: string | Date | null;
    invoiceGreetings?: string | null;
    invoiceClosing?: string | null;
    invoiceSignature?: string | null;
    invoiceLogo?: string | null;
    invoiceFooter?: string | null;
    invoiceTerms?: string | null;
    invoicePrivacy?: string | null;
    thousandDelimiter?: string | null;
    decimalDelimiter?: string | null;
    dateFormat?: string | null;
    invoiceNumber?: string | null;
  } | null,
  newGroups: InvoiceGroup[],
  seller: z.infer<typeof postGenerateInvoiceSchemaInput>['seller'],
  buyer: z.infer<typeof postGenerateInvoiceSchemaInput>['buyer'],
  resolved: ReturnType<typeof resolveInvoiceConfig>,
): {
  isCorrectionInvoice: boolean;
  correctionInvoice: {
    correctionReason: string;
    correctionTitle: string;
    correctionDescription: string;
  } | null;
  correctionReasons: string[];
} {
  if (
    existingInvoice == null ||
    typeof existingInvoice !== 'object' ||
    !('invoiceItems' in existingInvoice)
  ) {
    return {
      isCorrectionInvoice: false,
      correctionInvoice: null,
      correctionReasons: [],
    };
  }

  const inv = existingInvoice as {
    invoiceItems: Array<{
      name: string;
      quantity: { toString(): string } | number;
      pricePerUnitWithoutVat: { toString(): string } | number;
      vatRate: { toString(): string } | number;
    }>;
    // flattened seller/buyer fields
    sellerCountry?: string;
    sellerCity?: string;
    sellerZipCode?: string;
    sellerStreet?: string;
    sellerStreetNumber?: string;
    sellerEmail?: string | null;
    sellerPhone?: string | null;
    sellerName?: string | null;
    sellerCompanyName?: string | null;
    sellerVatNumber?: string | null;

    buyerCountry?: string;
    buyerCity?: string;
    buyerZipCode?: string;
    buyerStreet?: string;
    buyerStreetNumber?: string;
    buyerEmail?: string | null;
    buyerPhone?: string | null;
    buyerName?: string | null;
    buyerCompanyName?: string | null;
    buyerVatNumber?: string | null;

    invoiceTitle?: string | null;
    invoiceDate?: string | Date | null;
    invoiceGreetings?: string | null;
    invoiceClosing?: string | null;
    invoiceSignature?: string | null;
    invoiceLogo?: string | null;
    invoiceFooter?: string | null;
    invoiceTerms?: string | null;
    invoicePrivacy?: string | null;
    thousandDelimiter?: string | null;
    decimalDelimiter?: string | null;
    language?: string | null;
    dateFormat?: string | null;
  };

  // Compare groups
  const existingItems = inv.invoiceItems.map((it) => ({
    name: it.name,
    quantity: Number(it.quantity.toString()),
    price: Number(it.pricePerUnitWithoutVat.toString()),
    vatRateOverride: Number(it.vatRate.toString()),
  }));
  const existingGroups = generateInvoiceGroups(existingItems, 0);
  const itemsChanged = stringify(existingGroups) !== stringify(newGroups);

  // Compare parties (existing invoice stores flattened fields)
  const existingSeller = {
    name: inv.sellerName ?? null,
    companyName: inv.sellerCompanyName ?? null,
    vatNumber: inv.sellerVatNumber ?? null,
    country: inv.sellerCountry ?? '',
    city: inv.sellerCity ?? '',
    zipCode: inv.sellerZipCode ?? '',
    street: inv.sellerStreet ?? '',
    streetNumber: inv.sellerStreetNumber ?? '',
    email: inv.sellerEmail ?? null,
    phone: inv.sellerPhone ?? null,
  };
  const existingBuyer = {
    name: inv.buyerName ?? null,
    companyName: inv.buyerCompanyName ?? null,
    vatNumber: inv.buyerVatNumber ?? null,
    country: inv.buyerCountry ?? '',
    city: inv.buyerCity ?? '',
    zipCode: inv.buyerZipCode ?? '',
    street: inv.buyerStreet ?? '',
    streetNumber: inv.buyerStreetNumber ?? '',
    email: inv.buyerEmail ?? null,
    phone: inv.buyerPhone ?? null,
  };
  const sellerChanged = !partiesEqual(existingSeller, seller);
  const buyerChanged = !partiesEqual(existingBuyer, buyer);

  // Compare metadata subset
  const dateStr =
    typeof inv.invoiceDate === 'string'
      ? inv.invoiceDate
      : inv.invoiceDate instanceof Date
        ? inv.invoiceDate.toISOString().slice(0, 10)
        : '';
  const metadataChanged =
    !((resolved.title ?? '') === (inv.invoiceTitle ?? '')) ||
    !((resolved.date ?? '') === dateStr) ||
    !((resolved.greeting ?? '') === (inv.invoiceGreetings ?? '')) ||
    !((resolved.closing ?? '') === (inv.invoiceClosing ?? '')) ||
    !((resolved.signature ?? '') === (inv.invoiceSignature ?? '')) ||
    !((resolved.logo ?? '') === (inv.invoiceLogo ?? '')) ||
    !((resolved.footer ?? '') === (inv.invoiceFooter ?? '')) ||
    !((resolved.terms ?? '') === (inv.invoiceTerms ?? '')) ||
    !((resolved.privacy ?? '') === (inv.invoicePrivacy ?? '')) ||
    !(
      resolved.thousandDelimiter ===
      (inv.thousandDelimiter ?? resolved.thousandDelimiter)
    ) ||
    !(
      resolved.decimalDelimiter ===
      (inv.decimalDelimiter ?? resolved.decimalDelimiter)
    ) ||
    !(resolved.dateFormat === (inv.dateFormat ?? resolved.dateFormat));

  const reasons: string[] = [];
  if (itemsChanged) reasons.push('Items changed');
  if (sellerChanged) reasons.push('Seller data changed');
  if (buyerChanged) reasons.push('Buyer data changed');
  if (metadataChanged) reasons.push('Invoice metadata changed');

  const isCorrection = reasons.length > 0;
  return {
    isCorrectionInvoice: isCorrection,
    correctionInvoice: isCorrection
      ? {
          correctionReason: reasons.join('; '),
          correctionTitle: resolved.texts.correctionInvoice,
          correctionDescription: resolved.texts.correctionDefault(
            resolved.id,
            resolved.date,
          ),
        }
      : null,
    correctionReasons: reasons,
  };
}

// Legacy types retained for reference – currently unused
// interface ExistingInvoiceItem { /* omitted */ }

// interface ExistingInvoiceBase { /* omitted */ }

// Legacy type retained for reference – currently unused
// interface ExistingInvoiceRevision { /* omitted */ }

// interface InvoiceParty { /* omitted */ }

// Legacy compare function removed in new flow

// NOTE: Legacy comparison removed for the new flow

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
        const { parsedMetadata } = agentName.data;
        // Build invoice items from RequestedFunds using conversion mapping (required)

        const conversion = input.currencyConversion;
        if (!conversion || conversion.size === 0) {
          throw createHttpError(400, 'Missing currency conversion mapping');
        }
        const resolved = resolveInvoiceConfig(
          input.currencySettings,
          input.invoice,
        );

        const items: InvoiceGroupItemInput[] = payment.RequestedFunds.map(
          (fund) => {
            const unit = fund.unit;
            const factor = conversion.get(unit);
            if (factor == null) {
              throw createHttpError(
                400,
                `Missing conversion for unit: ${unit}`,
              );
            }
            const quantity = 1;
            const price = Number(fund.amount) * factor;
            const conversionFactor = 1 / factor;
            const agentDisplayName = metadataToString(parsedMetadata.name);
            const name = `${resolved.itemNamePrefix}${agentDisplayName}${resolved.itemNameSuffix}`;
            return {
              name,
              quantity,
              price,
              conversionFactor,
              conversionPrefix: '',
              conversionSuffix: ` ${unit}`,
            };
          },
        );

        const x = checkIfCorrectionInvoice(
          existingInvoice,
          groups,
          input.seller,
          input.buyer,
          resolved,
        );

        const groups = generateInvoiceGroups(items, input.vatRate ?? 0);
        const pdfBase64 = await generateInvoicePDFBase64(
          groups,
          input.seller,
          input.buyer,
          resolved,
        );

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
