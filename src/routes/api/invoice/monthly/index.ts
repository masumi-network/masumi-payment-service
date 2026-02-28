import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { $Enums } from '@prisma/client';
import stringify from 'canonical-json';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { checkSignature } from '@meshsdk/core';
import { generateInvoicePDFBase64 } from '@/utils/invoice/pdf-generator';
import {
	generateInvoiceGroups,
	resolveInvoiceConfig,
	InvoiceGroupItemInput,
	generateInvoiceId,
	generateNewInvoiceBaseId,
	supportedCurrencies,
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

export const postGenerateMonthlyInvoiceSchemaInput = z
	.object({
		signature: z.string().max(2000).describe('The signature to verify'),
		key: z.string().max(2000).describe('The key to verify the signature'),
		walletAddress: z.string().max(500).describe('The wallet address that signed the message'),
		validUntil: z.number().describe('The valid until timestamp'),
		action: z.enum(['retrieve_monthly_invoices']).describe('The action to perform for monthly invoices'),
		buyerWalletVkey: z.string().min(1).max(1000).describe('The buyer wallet vkey to aggregate the month for'),
		month: z
			.string()
			.regex(/^\d{4}-\d{2}$/)
			.describe('Target month in format YYYY-MM (UTC calendar)'),
		invoiceCurrency: z.enum(supportedCurrencies).describe('The currency of the invoice'),
		currencyConversion: z
			.record(z.number().gt(0))
			.optional()
			.describe('Currency conversion settings by unit for this invoice'),
		invoice: z
			.object({
				itemNamePrefix: z.string().min(1).max(100).optional().describe('The prefix of the item name'),
				itemNameSuffix: z.string().min(1).max(100).optional().describe('The suffix of the item name'),
				title: z.string().min(1).max(100).optional().describe('The title of the invoice'),
				description: z.string().min(1).max(1000).optional().describe('The description of the invoice'),
				idPrefix: z.string().min(1).max(100).optional().describe('The prefix of the invoice number'),
				date: z.string().min(1).max(100).optional().describe('The date of the invoice'),
				greeting: z.string().min(1).max(1000).optional().describe('The greetings of the invoice'),
				closing: z.string().min(1).max(1000).optional().describe('The closing of the invoice'),
				signature: z.string().min(1).max(1000).optional().describe('The signature of the invoice'),
				logo: z.string().min(1).max(1000).optional().describe('The logo of the invoice'),
				footer: z.string().min(1).max(1000).optional().describe('The footer of the invoice'),
				terms: z.string().min(1).max(1000).optional().describe('The terms of the invoice'),
				privacy: z.string().min(1).max(1000).optional().describe('The privacy of the invoice'),
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
		vatRate: z.number().min(0).max(1).optional().describe('The VAT rate as decimal (e.g., 0.19 for 19%)'),
		seller: z.object({
			country: z.string().min(1).max(100).describe('The country of the invoice'),
			city: z.string().min(1).max(100).describe('The city of the invoice'),
			zipCode: z.string().min(1).max(20).describe('The zip code of the invoice'),
			street: z.string().min(1).max(100).describe('The street of the invoice'),
			streetNumber: z.string().min(1).max(20).describe('The street number of the invoice'),
			email: z.string().email().min(1).max(100).nullable().describe('The email of the invoice'),
			phone: z.string().min(1).max(100).nullable().describe('The phone of the invoice'),
			name: z.string().min(1).max(100).nullable().describe('The name of the invoice'),
			companyName: z.string().min(1).max(100).nullable().describe('The company name of the invoice'),
			vatNumber: z.string().min(1).max(100).nullable().describe('The VAT number of the invoice'),
		}),
		buyer: z.object({
			country: z.string().min(1).max(100).describe('The country of the invoice'),
			city: z.string().min(1).max(100).describe('The city of the invoice'),
			zipCode: z.string().min(1).max(20).describe('The zip code of the invoice'),
			street: z.string().min(1).max(100).describe('The street of the invoice'),
			streetNumber: z.string().min(1).max(20).describe('The street number of the invoice'),
			email: z.string().email().min(1).max(100).nullable().describe('The email of the invoice'),
			phone: z.string().min(1).max(100).nullable().describe('The phone of the invoice'),
			name: z.string().min(1).max(100).nullable().describe('The name of the invoice'),
			companyName: z.string().min(1).max(100).nullable().describe('The company name of the invoice'),
			vatNumber: z.string().min(1).max(100).nullable().describe('The VAT number of the invoice'),
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

export const postGenerateMonthlyInvoiceSchemaOutput = z.object({
	invoice: z.string(),
});

export const postGenerateMonthlyInvoiceEndpoint = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postGenerateMonthlyInvoiceSchemaInput,
	output: postGenerateMonthlyInvoiceSchemaOutput,
	handler: async ({
		input,
		options,
	}: {
		input: z.infer<typeof postGenerateMonthlyInvoiceSchemaInput>;
		options: {
			id: string;
			permission: $Enums.Permission;
			networkLimit: $Enums.Network[];
			usageLimited: boolean;
		};
	}) => {
		const startTime = Date.now();
		try {
			if (Date.now() > input.validUntil) {
				throw createHttpError(400, 'Signature is expired');
			}
			if (Date.now() + 1000 * 60 * 60 * 2 < input.validUntil) {
				throw createHttpError(400, 'Signature is to far in the future');
			}

			const message = stringify({
				buyer: input.buyer,
				buyerWalletVkey: input.buyerWalletVkey,
				month: input.month,
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

			const [yearStr, monthStr] = input.month.split('-');
			const year = Number(yearStr);
			const monthIdx = Number(monthStr) - 1; // 0-based
			if (!Number.isFinite(year) || !Number.isFinite(monthIdx) || monthIdx < 0 || monthIdx > 11) {
				throw createHttpError(400, 'Invalid month parameter');
			}
			const monthStart = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0));
			const nextMonthStart = new Date(Date.UTC(year, monthIdx + 1, 1, 0, 0, 0, 0));
			const endOfMonth = new Date(Date.UTC(year, monthIdx + 1, 0, 0, 0, 0));

			const payments = await prisma.paymentRequest.findMany({
				where: {
					BuyerWallet: { walletVkey: input.buyerWalletVkey },
					createdAt: {
						gte: monthStart,
						lt: nextMonthStart,
					},
				},
				include: {
					BuyerWallet: true,
					RequestedFunds: true,
					PaymentSource: { include: { PaymentSourceConfig: true } },
				},
			});

			if (payments.length === 0) {
				recordBusinessEndpointError('/api/v1/invoice/monthly', 'POST', 404, 'No payments found for month and wallet', {
					wallet_address: input.walletAddress,
					operation: 'verify_signature',
				});
				throw createHttpError(404, 'No payments found for month and wallet');
			}

			const anyWalletAddress = payments[0].BuyerWallet?.walletAddress;
			if (!anyWalletAddress) {
				throw createHttpError(404, 'Buyer wallet address not found');
			}
			if (resolvePaymentKeyHash(input.walletAddress) !== resolvePaymentKeyHash(anyWalletAddress)) {
				throw createHttpError(400, 'Wallet is not the buyer wallet');
			}

			// Collect units across all payments
			const conversion = new Map<string, { factor: number; decimals: number }>(
				Object.entries(input.currencyConversion ?? {}).map(([key, value]) => [key, { factor: value, decimals: 0 }]),
			);
			if (conversion.size === 0 && !CONFIG.COINGECKO_API_KEY) {
				throw createHttpError(400, 'Missing currency conversion mapping');
			}

			const missingConversions = new Set<string>();
			for (const p of payments) {
				for (const fund of p.RequestedFunds) {
					if (!conversion.has(fund.unit)) {
						missingConversions.add(fund.unit);
					}
				}
			}

			const dateOfConversionDate = endOfMonth;
			logger.info('Monthly conversion date (EOM)', { dateOfConversionDate });

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
						if (!coinId) continue;
						if (missingConversion != '') {
							const platform = idData.platforms;
							if (!platform) continue;
							const cardanoPlatform = platform['cardano'];
							if (!cardanoPlatform) continue;
							if (missingConversion !== cardanoPlatform) continue;
						} else {
							if (idData.id != 'cardano') continue;
						}
						const splittedDate = new Date().toISOString().split('T');
						if (splittedDate.length !== 2) continue;

						const price = await coingeckoClient.coins.history.get(coinId, {
							date: splittedDate[0],
							localization: false,
						});
						let decimals: number | null = null;
						if (missingConversion == '') {
							decimals = 6;
						} else if (
							missingConversion == '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d' ||
							missingConversion == 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d'
						) {
							decimals = 6;
						} else {
							const coinData = await coingeckoClient.coins.getID(coinId, {});
							if (!coinData) continue;
							const detailPlatforms = coinData.detail_platforms;
							if (!detailPlatforms) continue;
							const cardanoPlatform = detailPlatforms['cardano'];
							if (!cardanoPlatform) continue;
							decimals = cardanoPlatform.decimal_place as unknown as number | null;
						}
						if (decimals === null || decimals === undefined) continue;
						const marketData = price.market_data;
						if (!marketData) continue;
						const currentPrice = marketData.current_price;
						if (!currentPrice) continue;
						try {
							const conversionFactor = currentPrice[input.invoiceCurrency as any as keyof typeof currentPrice];
							if (conversionFactor == undefined || isNaN(conversionFactor) || conversionFactor == 0) {
								continue;
							}
							conversion.set(missingConversion, {
								factor: conversionFactor / 10 ** decimals,
								decimals: decimals,
							});
							missingConversions.delete(missingConversion);
							usedCoingeckoForConversion = true;
							if (missingConversion.length == 0) break;
						} catch {
							continue;
						}
					}
					if (missingConversion.length == 0) break;
				}
			}

			if (missingConversions.size > 0) {
				throw createHttpError(400, `Missing conversion for units: ${Array.from(missingConversions).join(', ')}`);
			}

			const resolved = resolveInvoiceConfig(
				input.invoiceCurrency,
				{
					...input.invoice,
					// Default the invoice date to end-of-month if not specified
					date: input.invoice?.date ?? dateOfConversionDate.toISOString(),
				},
				{ invoiceType: 'monthly' },
			);

			const items: InvoiceGroupItemInput[] = [];
			const dbItems: Array<InvoiceGroupItemInput & { referencedPaymentId: string }> = [];

			const groupedPayments = new Map<string, Array<(typeof payments)[number]>>();
			for (const payment of payments) {
				const decidedIdentifier = decodeBlockchainIdentifier(payment.blockchainIdentifier);
				const agentIdentifier = decidedIdentifier?.agentIdentifier;
				if (!agentIdentifier) {
					throw createHttpError(404, 'Agent identifier not found');
				}
				if (!groupedPayments.has(agentIdentifier)) {
					groupedPayments.set(agentIdentifier, [payment]);
				}
				groupedPayments.get(agentIdentifier)!.push(payment);
			}

			for (const [agentIdentifier, payments] of groupedPayments) {
				const payment = payments[0];
				const quantity = payments.length;

				const blockfrost = new BlockFrostAPI({
					projectId: payment.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
				});

				const agentName = await fetchAssetInWalletAndMetadata(blockfrost, agentIdentifier);
				if ('error' in agentName) {
					throw createHttpError(404, 'Agent not found');
				}
				const { parsedMetadata } = agentName.data;
				const display = metadataToString(parsedMetadata.name);
				const agentDisplayName = display ?? '-';

				const namePrefix = resolved.itemNamePrefix;
				const nameSuffix = resolved.itemNameSuffix;
				const itemName = `${namePrefix}${agentDisplayName}${nameSuffix}`;

				let paymentCount = 0;

				for (const fund of payment.RequestedFunds) {
					paymentCount++;
					const unit = fund.unit;
					const factor = conversion.get(unit)!;
					const price = (Number(fund.amount) * factor.factor) / (1 + (input.vatRate ?? 0));
					const conversionFactor = 1 / factor.factor;
					let newItemName = itemName;
					if (paymentCount > 1) {
						newItemName = `${newItemName} (${paymentCount}/${payments.length})`;
					}
					const item: InvoiceGroupItemInput = {
						name: newItemName,
						quantity,
						price,
						conversionFactor,
						decimals: factor.decimals,
						convertedUnit: unit,
						conversionDate: dateOfConversionDate,
					};
					items.push(item);
					dbItems.push({ ...item, referencedPaymentId: payment.id });
				}
			}

			const createdInvoice = await prisma.$transaction(
				async (tx) => {
					// Always create a new monthly invoice base
					const incrementedInvoiceNumber = await tx.invoicePrefix.upsert({
						create: { id: input.invoice?.idPrefix ?? 'default', count: 0 },
						update: { count: { increment: 1 } },
						where: { id: input.invoice?.idPrefix ?? 'default' },
					});
					const baseIdString = generateNewInvoiceBaseId(
						(input.invoice?.idPrefix ? input.invoice?.idPrefix + '-' : '') +
							incrementedInvoiceNumber.count.toString().padStart(4, '0'),
					);
					const base = await tx.invoiceBase.create({
						data: {
							invoiceId: baseIdString,
						},
					});

					const newInvoiceId = generateInvoiceId(0, baseIdString);

					const groups = generateInvoiceGroups(items, input.vatRate ?? 0);

					const { pdfBase64 } = await generateInvoicePDFBase64(
						groups,
						input.seller,
						input.buyer,
						resolved,
						newInvoiceId,
						null,
						usedCoingeckoForConversion,
						{ invoiceType: 'monthly' },
					);

					const vatRateDefault = input.vatRate ?? 0;

					await tx.invoiceRevision.create({
						data: {
							invoiceBaseId: base.id,
							revisionNumber: 0,
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
								create: dbItems.map((item) => {
									const appliedVatRate = item.vatRateOverride ?? vatRateDefault;
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
										referencedPaymentId: item.referencedPaymentId,
										decimals: item.decimals,
										conversionFactor: item.conversionFactor,
										convertedUnit: item.convertedUnit,
										conversionDate: item.conversionDate,
									};
								}),
							},
						},
					});

					return { invoice: pdfBase64 };
				},
				{
					timeout: 20000,
					maxWait: 20000,
					isolationLevel: 'Serializable',
				},
			);

			return { invoice: createdInvoice.invoice };
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/invoice/monthly', 'POST', statusCode, errorInstance, {
				user_id: options.id,
				wallet_address: input.walletAddress,
				operation: 'verify_signature',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
