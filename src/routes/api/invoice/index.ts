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
  generateInvoiceId,
  generateNewInvoiceBaseId,
} from '@/utils/invoice/template';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { fetchAssetInWalletAndMetadata } from '@/services/blockchain/asset-metadata';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { generateHash } from '@/utils/crypto';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { CONFIG } from '@/utils/config';
import Coingecko from '@coingecko/coingecko-typescript';
import { logger } from '@/utils/logger';
import { supportedCurrencies } from '@/utils/invoice/template';
// Template helpers are used inside the PDF generator

export const postGenerateInvoiceSchemaInput = z
  .object({
    signature: z.string().max(2000).describe('The signature to verify'),
    key: z.string().max(2000).describe('The key to verify the signature'),
    walletAddress: z
      .string()
      .max(500)
      .describe('The wallet address that signed the message'),
    validUntil: z.number().describe('The valid until timestamp'),
    blockchainIdentifier: z
      .string()
      .describe(
        'The blockchain identifier, for which the invoice should be created',
      ),
    signatureData: z.string().describe('The data to verify the signature'),
    action: z.enum(['retrieve_invoice']).describe('The action to perform'),
    invoiceCurrency: z
      .enum(supportedCurrencies)
      .describe('The currency of the invoice'),
    currencyConversion: z
      .record(z.number().gt(0))
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
        language: z
          .enum(['en-us', 'en-uk', 'de'])
          .optional()
          .describe(
            'Invoice language and region: English US (en-us), English UK (en-uk), or German (de). Default: en-us',
          ),
        localizationFormat: z
          .enum(['en-us', 'en-uk', 'de'])
          .optional()
          .describe('The localization format of the invoice'),
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
  });

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
    InvoiceItems: Array<{
      name: string;
      quantity: { toString(): string } | number;
      pricePerUnitWithoutVat: { toString(): string } | number;
      vatRate: { toString(): string } | number;
      decimals: { toString(): string } | number;
      conversionFactor: { toString(): string } | number;
      convertedUnit: string;
      conversionDate: Date;
    }>;
    InvoiceBase: {
      invoiceId: string;
    };
    revisionNumber: number;
    currencyShortId: string;
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
    invoiceDate: Date;
    invoiceGreetings?: string | null;
    invoiceClosing?: string | null;
    invoiceSignature?: string | null;
    invoiceLogo?: string | null;
    invoiceFooter?: string | null;
    invoiceTerms?: string | null;
    invoicePrivacy?: string | null;
    localizationFormat: string;
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
    originalInvoiceNumber: string;
    originalInvoiceDate: string;
  } | null;
  correctionReasons: string[];
} {
  if (existingInvoice == null) {
    return {
      isCorrectionInvoice: false,
      correctionInvoice: null,
      correctionReasons: [],
    };
  }

  // Compare groups
  const existingItems = existingInvoice.InvoiceItems.map((it) => ({
    name: it.name,
    quantity: Number(it.quantity.toString()),
    price: Number(it.pricePerUnitWithoutVat.toString()),
    vatRateOverride: Number(it.vatRate.toString()),
    decimals: Number(it.decimals.toString()),
    conversionFactor: Number(it.conversionFactor.toString()),
    convertedUnit: it.convertedUnit,
    conversionDate: it.conversionDate,
  }));
  const existingGroups = generateInvoiceGroups(existingItems, 0);
  const itemsChanged = stringify(existingGroups) !== stringify(newGroups);

  // Compare parties (existing invoice stores flattened fields)
  const existingSeller = {
    name: existingInvoice.sellerName ?? null,
    companyName: existingInvoice.sellerCompanyName ?? null,
    vatNumber: existingInvoice.sellerVatNumber ?? null,
    country: existingInvoice.sellerCountry ?? '',
    city: existingInvoice.sellerCity ?? '',
    zipCode: existingInvoice.sellerZipCode ?? '',
    street: existingInvoice.sellerStreet ?? '',
    streetNumber: existingInvoice.sellerStreetNumber ?? '',
    email: existingInvoice.sellerEmail ?? null,
    phone: existingInvoice.sellerPhone ?? null,
  };
  const existingBuyer = {
    name: existingInvoice.buyerName ?? null,
    companyName: existingInvoice.buyerCompanyName ?? null,
    vatNumber: existingInvoice.buyerVatNumber ?? null,
    country: existingInvoice.buyerCountry ?? '',
    city: existingInvoice.buyerCity ?? '',
    zipCode: existingInvoice.buyerZipCode ?? '',
    street: existingInvoice.buyerStreet ?? '',
    streetNumber: existingInvoice.buyerStreetNumber ?? '',
    email: existingInvoice.buyerEmail ?? null,
    phone: existingInvoice.buyerPhone ?? null,
  };
  const sellerChanged = !partiesEqual(existingSeller, seller);
  const buyerChanged = !partiesEqual(existingBuyer, buyer);

  const existingDateFormatter = new Intl.DateTimeFormat(
    existingInvoice.localizationFormat,
    {
      dateStyle: 'short',
    },
  );

  const formattedExistingDate = existingDateFormatter.format(
    existingInvoice.invoiceDate,
  );
  const resolvedFormattedDate = resolved.dateFormatter.format(resolved.date);

  const metadataChanged =
    !((resolved.title ?? '') === (existingInvoice.invoiceTitle ?? '')) ||
    !(resolvedFormattedDate === formattedExistingDate) ||
    !((resolved.greeting ?? '') === (existingInvoice.invoiceGreetings ?? '')) ||
    !((resolved.closing ?? '') === (existingInvoice.invoiceClosing ?? '')) ||
    !(
      (resolved.signature ?? '') === (existingInvoice.invoiceSignature ?? '')
    ) ||
    !((resolved.logo ?? '') === (existingInvoice.invoiceLogo ?? '')) ||
    !((resolved.footer ?? '') === (existingInvoice.invoiceFooter ?? '')) ||
    !((resolved.terms ?? '') === (existingInvoice.invoiceTerms ?? '')) ||
    !((resolved.privacy ?? '') === (existingInvoice.invoicePrivacy ?? '')) ||
    !(resolved.localizationFormat === existingInvoice.localizationFormat);

  const reasons: string[] = [];
  if (itemsChanged) reasons.push('Items and or their prices were updated');
  if (sellerChanged) reasons.push('Seller data was updated');
  if (buyerChanged) reasons.push('Buyer data was updated');
  if (metadataChanged) reasons.push('Invoice text or formatting changed');

  const isCorrection = reasons.length > 0;
  return {
    isCorrectionInvoice: isCorrection,
    correctionInvoice: isCorrection
      ? {
          correctionReason: reasons.join('; '),
          correctionTitle: resolved.texts.correctionInvoice,
          correctionDescription: resolved.texts.correctionDefault(
            generateInvoiceId(
              existingInvoice.revisionNumber,
              existingInvoice.InvoiceBase.invoiceId,
            ),
            formattedExistingDate,
          ),
          originalInvoiceNumber: generateInvoiceId(
            existingInvoice.revisionNumber,
            existingInvoice.InvoiceBase.invoiceId,
          ),
          originalInvoiceDate: formattedExistingDate,
        }
      : null,
    correctionReasons: reasons,
  };
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

        const conversion = new Map<
          string,
          { factor: number; decimals: number }
        >(
          Object.entries(input.currencyConversion ?? {}).map(([key, value]) => [
            key,
            { factor: value, decimals: 0 },
          ]),
        );

        if (conversion.size === 0 && !CONFIG.COINGECKO_API_KEY) {
          throw createHttpError(400, 'Missing currency conversion mapping');
        }
        const resolved = resolveInvoiceConfig(
          input.invoiceCurrency,
          input.invoice,
        );
        const missingConversions = new Set<string>();
        for (const fund of payment.RequestedFunds) {
          if (!conversion.has(fund.unit)) {
            missingConversions.add(fund.unit);
          }
        }
        //
        const dateOfConversion = Math.min(
          Number(payment.payByTime ?? 1000000000000000000n),
          Number(payment.unlockTime),
        );
        if (
          dateOfConversion == 0 ||
          isNaN(dateOfConversion) ||
          dateOfConversion > Date.now()
        ) {
          //throw createHttpError(400, 'Date of conversion is not valid');
        }
        const dateOfConversionDate = new Date(); //dateOfConversion);
        logger.info('Date of conversion', { dateOfConversionDate });
        let usedCoingeckoForConversion = false;
        if (CONFIG.COINGECKO_API_KEY && missingConversions.size > 0) {
          const coingeckoClient = new Coingecko({
            demoAPIKey: CONFIG.COINGECKO_API_KEY,
            environment: CONFIG.IS_COINGECKO_DEMO ? 'demo' : 'pro',
          });
          const idMapping = await coingeckoClient.coins.list.get({
            include_platform: true,
          });
          const missingConversionList = Array.from(missingConversions);
          for (const missingConversion of missingConversionList) {
            for (const idData of idMapping) {
              const coinId = idData.id;
              if (!coinId) {
                continue;
              }
              if (missingConversion != '') {
                const platform = idData.platforms;
                if (!platform) {
                  continue;
                }
                const cardanoPlatform = platform['cardano'];
                if (!cardanoPlatform) {
                  continue;
                }
                if (missingConversion !== cardanoPlatform) {
                  continue;
                }
              } else {
                if (idData.id != 'cardano') {
                  continue;
                }
              }

              const price = await coingeckoClient.coins.history.get(coinId, {
                //Format date as YYYY-MM-DD
                date: dateOfConversionDate.toISOString().split('T')[0],
                localization: false,
              });
              let decimals = null;
              if (missingConversion == '') {
                decimals = 6;
              } else if (
                missingConversion ==
                  '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d' ||
                missingConversion ==
                  'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d'
              ) {
                decimals = 6;
              } else {
                const coinData = await coingeckoClient.coins.getID(coinId, {});
                if (!coinData) {
                  continue;
                }
                const detailPlatforms = coinData.detail_platforms;
                if (!detailPlatforms) {
                  continue;
                }
                const cardanoPlatform = detailPlatforms['cardano'];
                if (!cardanoPlatform) {
                  continue;
                }
                decimals = cardanoPlatform.decimal_place;
              }
              if (decimals === null || decimals === undefined) {
                continue;
              }
              const marketData = price.market_data;
              if (!marketData) {
                continue;
              }
              const currentPrice = marketData.current_price;
              if (!currentPrice) {
                continue;
              }
              try {
                const conversionFactor =
                  currentPrice[
                    input.invoiceCurrency as any as keyof typeof currentPrice
                  ];
                if (
                  conversionFactor == undefined ||
                  isNaN(conversionFactor) ||
                  conversionFactor == 0
                ) {
                  continue;
                }
                conversion.set(missingConversion, {
                  factor: conversionFactor / 10 ** decimals,
                  decimals,
                });
                missingConversions.delete(missingConversion);
                usedCoingeckoForConversion = true;
                if (missingConversion.length == 0) {
                  break;
                }
              } catch {
                continue;
              }
            }
            if (missingConversion.length == 0) {
              break;
            }
          }
        }
        if (missingConversions.size > 0) {
          throw createHttpError(
            400,
            `Missing conversion for units: ${Array.from(missingConversions).join(', ')}`,
          );
        }

        const items: InvoiceGroupItemInput[] = await Promise.all(
          payment.RequestedFunds.map(async (fund) => {
            const unit = fund.unit;
            const factor = conversion.get(unit)!;
            const quantity = 1;
            const price =
              (Number(fund.amount) * factor.factor) /
              (1 + (input.vatRate ?? 0));
            const conversionFactor = 1 / factor.factor;
            const agentDisplayName = metadataToString(parsedMetadata.name);
            const name = `${resolved.itemNamePrefix}${agentDisplayName}${resolved.itemNameSuffix}`;
            return {
              name,
              quantity,
              price,
              conversionFactor,
              decimals: factor.decimals,
              convertedUnit: unit,
              conversionDate: dateOfConversionDate,
            };
          }),
        );
        const createdInvoice = await prisma.$transaction(
          async (tx) => {
            const existingInvoice = await prisma.invoiceRevision.findFirst({
              where: {
                InvoiceItems: {
                  some: {
                    referencedPaymentId: payment.id,
                  },
                },
              },
              orderBy: {
                revisionNumber: 'desc',
              },
              include: {
                InvoiceItems: true,
                InvoiceBase: true,
              },
            });

            const groups = generateInvoiceGroups(items, input.vatRate ?? 0);
            const correctionData = checkIfCorrectionInvoice(
              existingInvoice,
              groups,
              input.seller,
              input.buyer,
              resolved,
            );
            if (!correctionData.isCorrectionInvoice && existingInvoice) {
              return {
                invoice: Buffer.from(
                  existingInvoice.generatedPDFInvoice as unknown as Uint8Array,
                ).toString('base64'),
              };
            }
            // Decide on base invoice and revision number
            let invoiceBaseId: string;
            let revisionNumber: number;
            let newInvoiceId: string;
            if (existingInvoice) {
              invoiceBaseId = existingInvoice.invoiceBaseId;
              const latest = await tx.invoiceRevision.findFirst({
                where: { invoiceBaseId },
                orderBy: { revisionNumber: 'desc' },
                select: { revisionNumber: true },
              });
              revisionNumber = (latest?.revisionNumber ?? -1) + 1;

              newInvoiceId = generateInvoiceId(
                revisionNumber,
                existingInvoice.InvoiceBase.invoiceId,
              );
            } else {
              revisionNumber = 0;
              const incrementedInvoiceNumber = await tx.invoicePrefix.upsert({
                create: { id: input.invoice?.idPrefix ?? 'default', count: 0 },
                update: { count: { increment: 1 } },
                where: { id: input.invoice?.idPrefix ?? 'default' },
              });
              newInvoiceId = generateNewInvoiceBaseId(
                (input.invoice?.idPrefix ? input.invoice?.idPrefix + '-' : '') +
                  incrementedInvoiceNumber.count.toString().padStart(4, '0'),
              );

              const base = await tx.invoiceBase.create({
                data: {
                  invoiceId: newInvoiceId,
                },
              });
              newInvoiceId = generateInvoiceId(
                0,
                generateNewInvoiceBaseId(
                  (input.invoice?.idPrefix
                    ? input.invoice?.idPrefix + '-'
                    : '') +
                    incrementedInvoiceNumber.count.toString().padStart(4, '0'),
                ),
              );
              invoiceBaseId = base.id;
            }

            const { pdfBase64 } = await generateInvoicePDFBase64(
              groups,
              input.seller,
              input.buyer,
              resolved,
              newInvoiceId,
              correctionData.correctionInvoice,
              usedCoingeckoForConversion,
            );

            const vatRateDefault = input.vatRate ?? 0;

            await tx.invoiceRevision.create({
              data: {
                invoiceBaseId,
                revisionNumber,
                currencyShortId: resolved.currency,
                invoiceTitle: resolved.title,
                invoiceDescription: input.invoice?.description ?? null,
                invoiceDate: resolved.date,
                invoiceGreetings: resolved.greeting ?? null,
                invoiceClosing: resolved.closing ?? null,
                invoiceSignature: resolved.signature ?? null,
                invoiceLogo: resolved.logo ?? null,
                invoiceFooter: resolved.footer ?? null,
                invoiceTerms: resolved.terms ?? null,
                invoicePrivacy: resolved.privacy ?? null,
                invoiceDisclaimer: null,

                // Correction invoice fields
                correctionInvoiceOriginalNumber:
                  correctionData.correctionInvoice?.originalInvoiceNumber ??
                  null,
                correctionInvoiceOriginalDate:
                  correctionData.correctionInvoice?.originalInvoiceDate ?? null,
                correctionInvoiceReason:
                  correctionData.correctionInvoice?.correctionReason ?? null,
                correctionInvoiceTitle:
                  correctionData.correctionInvoice?.correctionTitle ?? null,
                correctionInvoiceDescription:
                  correctionData.correctionInvoice?.correctionDescription ??
                  null,

                // Formatting
                language: resolved.language,
                localizationFormat: resolved.localizationFormat,

                // Seller
                sellerCountry: input.seller.country,
                sellerCity: input.seller.city,
                sellerZipCode: input.seller.zipCode,
                sellerStreet: input.seller.street,
                sellerStreetNumber: input.seller.streetNumber,
                sellerEmail: input.seller.email ?? null,
                sellerPhone: input.seller.phone ?? null,
                sellerName: input.seller.name ?? null,
                sellerCompanyName: input.seller.companyName ?? null,
                sellerVatNumber: input.seller.vatNumber ?? null,

                // Buyer
                buyerCountry: input.buyer.country,
                buyerCity: input.buyer.city,
                buyerZipCode: input.buyer.zipCode,
                buyerStreet: input.buyer.street,
                buyerStreetNumber: input.buyer.streetNumber,
                buyerEmail: input.buyer.email ?? null,
                buyerPhone: input.buyer.phone ?? null,
                buyerName: input.buyer.name ?? null,
                buyerCompanyName: input.buyer.companyName ?? null,
                buyerVatNumber: input.buyer.vatNumber ?? null,

                // PDF bytes
                generatedPDFInvoice: Buffer.from(pdfBase64, 'base64'),

                // Items
                InvoiceItems: {
                  create: items.map((item) => {
                    const appliedVatRate =
                      item.vatRateOverride ?? vatRateDefault;
                    const quantity = item.quantity;
                    const unitPrice = item.price;
                    const netAmount = quantity * unitPrice;
                    const vatAmount = netAmount * appliedVatRate;
                    const totalAmount = netAmount + vatAmount;
                    return {
                      name: item.name,
                      quantity: quantity,
                      pricePerUnitWithoutVat: unitPrice,
                      vatRate: appliedVatRate,
                      vatAmount: vatAmount,
                      totalAmount: totalAmount,
                      referencedPaymentId: payment.id,
                      decimals: item.decimals,
                      conversionFactor: item.conversionFactor,
                      convertedUnit: item.convertedUnit,
                      conversionDate: item.conversionDate,
                    };
                  }),
                },
              },
            });
            return {
              invoice: pdfBase64,
            };
          },
          {
            timeout: 20000,
            maxWait: 20000,
            isolationLevel: 'Serializable',
          },
        );

        return {
          invoice: createdInvoice.invoice,
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
