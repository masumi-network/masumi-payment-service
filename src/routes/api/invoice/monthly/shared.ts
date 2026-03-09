import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';

import { recordBusinessEndpointError } from '@/utils/metrics';
import { generateInvoicePDFBase64, generateCancellationInvoicePDFBase64 } from '@/utils/invoice/pdf-generator';
import {
	generateInvoiceGroups,
	resolveInvoiceConfig,
	InvoiceGroupItemInput,
	generateInvoiceId,
	generateNewInvoiceBaseId,
	supportedCurrencies,
	invoiceSellerSchema,
	invoiceBuyerSchema,
	invoiceOptionsSchema,
	SupportedCurrencies,
} from '@/utils/invoice/template';
import { detectInvoiceChanges, getOriginalInvoiceInfo } from '@/utils/invoice/comparison';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { CONFIG } from '@/utils/config';
import Coingecko from '@coingecko/coingecko-typescript';
import { logger } from '@/utils/logger';
import {
	collectDistinctSellerWalletVkeys,
	getBillableFunds,
	getSellerWalletVkey,
	isPaymentBillable,
	type PaymentWithInvoiceContext,
} from './billing';

export { getBillableFunds, isPaymentBillable } from './billing';

// Token unit constants (policyId + assetName hex)
const MAINNET_USDM_UNIT = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
const PREPROD_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const isUsdmUnit = (unit: string) => unit === MAINNET_USDM_UNIT || unit === PREPROD_USDM_UNIT;
import { getServicePeriodLabel, mergePaymentsById, validateInvoiceCompliance } from '@/utils/invoice/compliance';

function toPrismaBytes(base64: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function storedPdfToBase64(storedPdf: unknown): string | null {
	if (!(storedPdf instanceof Uint8Array) || storedPdf.byteLength === 0) {
		return null;
	}
	return Buffer.from(storedPdf).toString('base64');
}

export const invoiceGenerationBaseSchema = z.object({
	buyerWalletVkey: z.string().min(1).max(1000).describe('The buyer wallet vkey to aggregate the month for'),
	sellerWalletVkey: z
		.string()
		.min(1)
		.max(1000)
		.optional()
		.describe('Optional seller wallet vkey to scope the invoice to a specific seller'),
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.describe('Target month in format YYYY-MM (UTC calendar)'),
	invoiceCurrency: z.enum(supportedCurrencies).describe('The currency of the invoice'),
	CurrencyConversion: z
		.record(z.string(), z.number().gt(0))
		.optional()
		.describe('Currency conversion settings by unit for this invoice'),
	Invoice: invoiceOptionsSchema,
	vatRate: z.number().min(0).max(1).optional().describe('The VAT rate as decimal (e.g., 0.19 for 19%)'),
	reverseCharge: z.boolean().optional().default(false).describe('Enable reverse charge (VAT = 0, notice on invoice)'),
	forceRegenerate: z
		.boolean()
		.optional()
		.default(false)
		.describe('Force cancel existing invoice and generate a new revision, even if no data changes detected'),
	Seller: invoiceSellerSchema,
	Buyer: invoiceBuyerSchema,
});

export const invoiceGenerationSchemaInput = invoiceGenerationBaseSchema
	.refine(
		(data) => {
			if (data.Seller.companyName == null && data.Seller.name == null) {
				return false;
			}
			return true;
		},
		{
			message: 'Company name or name is required',
			path: ['Seller', 'companyName'],
		},
	)
	.refine((data) => {
		if (data.Buyer.companyName == null && data.Buyer.name == null) {
			return false;
		}
		return true;
	});

export const invoiceGenerationSchemaOutput = z.object({
	invoice: z.string(),
	cancellationInvoice: z.string().optional(),
});

interface GenerateMonthlyInvoiceInput {
	buyerWalletVkey: string;
	sellerWalletVkey?: string;
	month: string;
	invoiceCurrency: (typeof supportedCurrencies)[number];
	currencyConversion?: Record<string, number>;
	invoice?: z.infer<typeof invoiceOptionsSchema>;
	vatRate?: number;
	reverseCharge: boolean;
	forceRegenerate: boolean;
	seller: z.infer<typeof invoiceSellerSchema>;
	buyer: z.infer<typeof invoiceBuyerSchema>;
}

interface GenerateMonthlyInvoiceOptions {
	walletAddress?: string;
	metricPath?: string;
	walletScopeIds?: string[] | null;
}

export async function generateMonthlyInvoice(
	input: GenerateMonthlyInvoiceInput,
	options?: GenerateMonthlyInvoiceOptions,
): Promise<{ invoice: string; cancellationInvoice?: string }> {
	const metricPath = options?.metricPath ?? '/api/v1/invoice/monthly';

	const [yearStr, monthStr] = input.month.split('-');
	const year = Number(yearStr);
	const monthIdx = Number(monthStr) - 1; // 0-based
	if (!Number.isFinite(year) || !Number.isFinite(monthIdx) || monthIdx < 0 || monthIdx > 11) {
		throw createHttpError(400, 'Invalid month parameter');
	}
	const monthStart = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0));
	const nextMonthStart = new Date(Date.UTC(year, monthIdx + 1, 1, 0, 0, 0, 0));
	const invoiceMonth = monthIdx + 1; // 1-based for storage

	const nowMs = BigInt(Date.now());

	// ── Pre-resolve external data (outside txn – idempotent lookups) ──
	const billableStateFilter = [
		{
			onChainState: 'ResultSubmitted' as const,
			unlockTime: { lte: nowMs },
			onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
		},
		{
			onChainState: 'Withdrawn' as const,
			onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
		},
		{
			onChainState: 'DisputedWithdrawn' as const,
			onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
		},
	];

	const paymentIncludes = {
		BuyerWallet: true as const,
		RequestedFunds: true as const,
		WithdrawnForSeller: true as const,
		SmartContractWallet: true as const,
		TransactionHistory: { select: { txHash: true as const } },
	};

	const walletScopePaymentFilter = buildWalletScopeFilter(options?.walletScopeIds ?? null);
	const preUninvoicedPayments = await prisma.paymentRequest.findMany({
		where: {
			BuyerWallet: { walletVkey: input.buyerWalletVkey },
			...(input.sellerWalletVkey ? { SmartContractWallet: { walletVkey: input.sellerWalletVkey } } : {}),
			invoiceBaseId: null,
			OR: billableStateFilter,
			...walletScopePaymentFilter,
		},
		include: paymentIncludes,
	});

	const preUninvoicedBillableAll = preUninvoicedPayments.filter((payment) =>
		isPaymentBillable(payment),
	) as PaymentWithInvoiceContext[];
	const preUninvoicedSellerWalletVkeys = collectDistinctSellerWalletVkeys(preUninvoicedBillableAll);
	if (preUninvoicedSellerWalletVkeys.length > 1) {
		throw createHttpError(
			409,
			`Multiple seller wallets found for buyer ${input.buyerWalletVkey} in ${input.month}: ${preUninvoicedSellerWalletVkeys.join(', ')}. Provide sellerWalletVkey to scope the invoice to a specific seller.`,
		);
	}

	const preExistingBases = await prisma.invoiceBase.findMany({
		where: {
			buyerWalletVkey: input.buyerWalletVkey,
			...(input.sellerWalletVkey ? { sellerWalletVkey: input.sellerWalletVkey } : {}),
			invoiceMonth: invoiceMonth,
			invoiceYear: year,
		},
		include: {
			InvoiceRevisions: {
				where: { isCancelled: false },
				orderBy: { revisionNumber: 'desc' },
				take: 1,
			},
			coveredPaymentRequests: {
				include: paymentIncludes,
			},
		},
	});
	const preExistingBasesBySeller = new Map<string, (typeof preExistingBases)[number]>(
		preExistingBases.map((base) => [base.sellerWalletVkey, base]),
	);
	if (preExistingBasesBySeller.size !== preExistingBases.length) {
		throw createHttpError(409, 'Multiple invoice bases exist for the same buyer/seller/month/year scope');
	}

	let targetSellerWalletVkey: string | null = input.sellerWalletVkey ?? preUninvoicedSellerWalletVkeys[0] ?? null;
	if (!targetSellerWalletVkey && preExistingBases.length === 1) {
		targetSellerWalletVkey = preExistingBases[0].sellerWalletVkey;
	}
	if (!targetSellerWalletVkey && preExistingBases.length > 1) {
		throw createHttpError(
			409,
			`Multiple seller-scoped invoice bases found for buyer ${input.buyerWalletVkey} in ${input.month}. Provide sellerWalletVkey to scope the invoice.`,
		);
	}

	const preExistingBase = targetSellerWalletVkey
		? (preExistingBasesBySeller.get(targetSellerWalletVkey) ?? null)
		: null;
	const preUninvoicedBillable = targetSellerWalletVkey
		? preUninvoicedBillableAll.filter((payment) => getSellerWalletVkey(payment) === targetSellerWalletVkey)
		: preUninvoicedBillableAll;
	const preExistingBillable = (preExistingBase?.coveredPaymentRequests ?? []).filter(
		isPaymentBillable,
	) as PaymentWithInvoiceContext[];
	const preBillable = mergePaymentsById(preExistingBillable, preUninvoicedBillable);
	const preExistingRevision = preExistingBase?.InvoiceRevisions[0] ?? null;

	if (preExistingRevision && preUninvoicedBillable.length === 0 && !input.forceRegenerate) {
		const cachedInvoice = storedPdfToBase64(preExistingRevision.generatedPDFInvoice);
		if (!cachedInvoice) {
			logger.warn('Skipping cached invoice because stored PDF is empty', {
				invoiceRevisionId: preExistingRevision.id,
				buyerWalletVkey: input.buyerWalletVkey,
				month: input.month,
			});
		} else {
			if (options?.walletAddress) {
				const buyerWalletAddress = preBillable[0]?.BuyerWallet?.walletAddress ?? preExistingRevision.buyerWalletAddress;
				if (!buyerWalletAddress) {
					throw createHttpError(404, 'Buyer wallet address not found');
				}
				if (resolvePaymentKeyHash(options.walletAddress) !== resolvePaymentKeyHash(buyerWalletAddress)) {
					throw createHttpError(400, 'Wallet is not the buyer wallet');
				}
			}
			return { invoice: cachedInvoice };
		}
	}

	if (preBillable.length === 0 && !preExistingRevision && !input.forceRegenerate) {
		recordBusinessEndpointError(metricPath, 'POST', 404, 'No billable payments found for month and wallet', {
			operation: 'generate_invoice',
		});
		throw createHttpError(404, 'No billable payments found for month and wallet');
	}

	// Wallet address verification (only for signature-verified flow)
	if (options?.walletAddress && preBillable.length > 0) {
		const anyWalletAddress = preBillable[0].BuyerWallet?.walletAddress;
		if (!anyWalletAddress) {
			throw createHttpError(404, 'Buyer wallet address not found');
		}
		if (resolvePaymentKeyHash(options.walletAddress) !== resolvePaymentKeyHash(anyWalletAddress)) {
			throw createHttpError(400, 'Wallet is not the buyer wallet');
		}
	}

	// Collect units across all payments for conversion resolution
	const conversion = new Map<string, { factor: number; decimals: number }>(
		Object.entries(input.currencyConversion ?? {}).map(([key, value]) => [key, { factor: value, decimals: 0 }]),
	);

	const missingConversions = new Set<string>();
	for (const payment of preBillable) {
		const funds = getBillableFunds(payment);
		for (const fund of funds) {
			if (!conversion.has(fund.unit)) {
				missingConversions.add(fund.unit);
			}
		}
	}

	if (missingConversions.size > 0 && !CONFIG.COINGECKO_API_KEY) {
		throw createHttpError(
			400,
			'Missing currency conversion mapping. Provide CurrencyConversion values or set COINGECKO_API_KEY.',
		);
	}

	const dateOfConversionDate = new Date();
	logger.info('Monthly conversion date (invoice creation)', { dateOfConversionDate });

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
			// For preprod tUSDM, look up the mainnet USDM on CoinGecko instead
			const lookupUnit = missingConversion === PREPROD_USDM_UNIT ? MAINNET_USDM_UNIT : missingConversion;

			for (const idData of idMapping) {
				const coinId = idData.id;
				if (!coinId) continue;
				if (lookupUnit !== '') {
					const platform = idData.platforms;
					if (!platform) continue;
					const cardanoPlatform = platform['cardano'];
					if (!cardanoPlatform) continue;
					if (lookupUnit !== cardanoPlatform) continue;
				} else if (idData.id !== 'cardano') {
					continue;
				}

				const splittedDate = dateOfConversionDate.toISOString().split('T');
				if (splittedDate.length !== 2) continue;

				const price = await coingeckoClient.coins.history.get(coinId, {
					date: splittedDate[0],
					localization: false,
				});
				let decimals: number | null = null;
				if (lookupUnit === '') {
					decimals = 6;
				} else if (isUsdmUnit(lookupUnit)) {
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
					const conversionFactor = currentPrice[input.invoiceCurrency as keyof typeof currentPrice];
					if (conversionFactor === undefined || Number.isNaN(conversionFactor) || conversionFactor === 0) {
						continue;
					}
					// Store under the original unit (not the lookup unit)
					conversion.set(missingConversion, {
						factor: conversionFactor / 10 ** decimals,
						decimals: decimals,
					});
					missingConversions.delete(missingConversion);
					usedCoingeckoForConversion = true;
					break;
				} catch {
					continue;
				}
			}
		}
	}

	if (missingConversions.size > 0) {
		throw createHttpError(
			400,
			`Missing conversion for units: ${Array.from(missingConversions).join(', ')}. Provide CurrencyConversion mapping for each unit or configure COINGECKO_API_KEY.`,
		);
	}

	// Pre-resolve agent identifiers from blockchain identifiers (decode only, no on-chain lookup)
	const agentDisplayNames = new Map<string, string>();
	const uniqueAgentIdentifiers = new Set<string>();
	for (const payment of preBillable) {
		const decidedIdentifier = decodeBlockchainIdentifier(payment.blockchainIdentifier);
		if (!decidedIdentifier) {
			throw createHttpError(
				400,
				`Payment ${payment.id} has an invalid blockchain identifier — cannot generate invoice`,
			);
		}
		const agentIdentifier = decidedIdentifier.agentIdentifier;
		if (!agentIdentifier) {
			throw createHttpError(
				400,
				`Payment ${payment.id} has no agent identifier in blockchain identifier — cannot generate invoice`,
			);
		}
		uniqueAgentIdentifiers.add(agentIdentifier);
	}

	// Look up agent display names from registry
	if (uniqueAgentIdentifiers.size > 0) {
		const registryEntries = await prisma.registryRequest.findMany({
			where: { agentIdentifier: { in: Array.from(uniqueAgentIdentifiers) } },
			select: { agentIdentifier: true, name: true },
		});
		const registryMap = new Map(
			registryEntries.filter((r) => r.agentIdentifier != null).map((r) => [r.agentIdentifier!, r.name]),
		);
		for (const agentId of uniqueAgentIdentifiers) {
			const registryName = registryMap.get(agentId);
			if (registryName) {
				const abbreviated = agentId.length > 14 ? `${agentId.slice(0, 2)}****${agentId.slice(-12)}` : agentId;
				agentDisplayNames.set(agentId, `${registryName} (${abbreviated})`);
			} else {
				agentDisplayNames.set(agentId, agentId);
			}
		}
	}

	// Determine effective VAT rate (reverse charge forces 0)
	const effectiveVatRate = input.reverseCharge ? 0 : (input.vatRate ?? 0);
	validateInvoiceCompliance(input, effectiveVatRate);

	const resolved = resolveInvoiceConfig(
		input.invoiceCurrency,
		{
			...input.invoice,
			date: input.invoice?.date ?? dateOfConversionDate.toISOString(),
		},
		{ invoiceType: 'monthly' },
	);
	const servicePeriod = getServicePeriodLabel(year, monthIdx, resolved.localizationFormat);

	// Helper to build revision data fields (shared between new and update paths)
	const buildRevisionData = (
		sellerWalletAddress: string | null,
		buyerWalletAddress: string | null,
		dbItems: Array<InvoiceGroupItemInput & { referencedPaymentId: string }>,
		generatedPdfInvoice: Uint8Array<ArrayBuffer>,
	) => ({
		currencyShortId: resolved.currency,
		invoiceTitle: resolved.title,
		invoiceDescription: input.invoice?.description ?? null,
		invoiceDate: resolved.date,
		reverseCharge: input.reverseCharge,
		invoiceGreetings: resolved.greeting ?? null,
		invoiceClosing: resolved.closing ?? null,
		invoiceSignature: resolved.signature ?? null,
		invoiceLogo: resolved.logo ?? null,
		invoiceFooter: resolved.footer ?? null,
		invoiceTerms: resolved.terms ?? null,
		invoicePrivacy: resolved.privacy ?? null,
		language: resolved.language,
		localizationFormat: resolved.localizationFormat,
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
		sellerWalletAddress,
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
		buyerWalletAddress,
		generatedPDFInvoice: generatedPdfInvoice,
		generatedInvoiceUpdatedAt: new Date(),
		InvoiceItems: {
			create: dbItems.map((item) => {
				const appliedVatRate = item.vatRateOverride ?? effectiveVatRate;
				const qty = item.quantity;
				const unitPrice = item.price;
				const netAmount = qty * unitPrice;
				const vatAmount = netAmount * appliedVatRate;
				const totalAmount = netAmount + vatAmount;
				return {
					name: item.name,
					quantity: qty,
					pricePerUnitWithoutVat: unitPrice,
					vatRate: appliedVatRate,
					vatAmount,
					totalAmount,
					referencedPaymentId: item.referencedPaymentId,
					decimals: item.decimals,
					conversionFactor: item.conversionFactor,
					convertedUnit: item.convertedUnit,
					conversionDate: item.conversionDate,
				};
			}),
		},
	});

	// ── Serializable transaction: payment read + invoice check + write ──
	const invoiceResult = await prisma.$transaction(
		async (tx) => {
			const txNowMs = BigInt(Date.now());
			const txBillableStateFilter = [
				{
					onChainState: 'ResultSubmitted' as const,
					unlockTime: { lte: txNowMs },
					onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
				},
				{
					onChainState: 'Withdrawn' as const,
					onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
				},
				{
					onChainState: 'DisputedWithdrawn' as const,
					onChainStateOrResultLastChangedAt: { gte: monthStart, lt: nextMonthStart },
				},
			];

			const txUninvoicedPayments = await tx.paymentRequest.findMany({
				where: {
					BuyerWallet: { walletVkey: input.buyerWalletVkey },
					...(input.sellerWalletVkey ? { SmartContractWallet: { walletVkey: input.sellerWalletVkey } } : {}),
					invoiceBaseId: null,
					OR: txBillableStateFilter,
					...walletScopePaymentFilter,
				},
				include: paymentIncludes,
			});
			const txUninvoicedBillableAll = txUninvoicedPayments.filter((payment) =>
				isPaymentBillable(payment),
			) as PaymentWithInvoiceContext[];
			const txUninvoicedSellerWalletVkeys = collectDistinctSellerWalletVkeys(txUninvoicedBillableAll);
			if (txUninvoicedSellerWalletVkeys.length > 1) {
				throw createHttpError(
					409,
					`Multiple seller wallets found for buyer ${input.buyerWalletVkey} in ${input.month}: ${txUninvoicedSellerWalletVkeys.join(', ')}. Provide sellerWalletVkey to scope the invoice.`,
				);
			}

			let txTargetSellerWalletVkey = targetSellerWalletVkey;
			if (!txTargetSellerWalletVkey && txUninvoicedSellerWalletVkeys.length === 1) {
				txTargetSellerWalletVkey = txUninvoicedSellerWalletVkeys[0];
			}

			const txExistingBases = await tx.invoiceBase.findMany({
				where: {
					buyerWalletVkey: input.buyerWalletVkey,
					invoiceMonth: invoiceMonth,
					invoiceYear: year,
					...(txTargetSellerWalletVkey ? { sellerWalletVkey: txTargetSellerWalletVkey } : {}),
				},
				include: {
					InvoiceRevisions: {
						where: { isCancelled: false },
						orderBy: { revisionNumber: 'desc' },
						take: 1,
						include: { InvoiceItems: true },
					},
					coveredPaymentRequests: {
						include: paymentIncludes,
					},
				},
			});
			const txExistingBasesBySeller = new Map<string, (typeof txExistingBases)[number]>(
				txExistingBases.map((base) => [base.sellerWalletVkey, base]),
			);
			if (txExistingBasesBySeller.size !== txExistingBases.length) {
				throw createHttpError(409, 'Multiple invoice bases exist for the same buyer/seller/month/year scope');
			}
			if (!txTargetSellerWalletVkey && txExistingBases.length > 1) {
				throw createHttpError(
					409,
					`Multiple seller-scoped invoice bases found for buyer ${input.buyerWalletVkey} in ${input.month}.`,
				);
			}
			if (!txTargetSellerWalletVkey && txExistingBases.length === 1) {
				txTargetSellerWalletVkey = txExistingBases[0].sellerWalletVkey;
			}

			const txExistingBase = txTargetSellerWalletVkey
				? (txExistingBasesBySeller.get(txTargetSellerWalletVkey) ?? null)
				: null;
			const txExistingRevision =
				txExistingBase && txExistingBase.InvoiceRevisions.length > 0
					? { ...txExistingBase.InvoiceRevisions[0], InvoiceBase: txExistingBase }
					: null;

			const txExistingBillable = (txExistingBase?.coveredPaymentRequests ?? []).filter((payment) =>
				isPaymentBillable(payment),
			) as PaymentWithInvoiceContext[];
			const txUninvoicedBillable = txTargetSellerWalletVkey
				? txUninvoicedBillableAll.filter((payment) => getSellerWalletVkey(payment) === txTargetSellerWalletVkey)
				: txUninvoicedBillableAll;
			const payments = mergePaymentsById(txExistingBillable, txUninvoicedBillable);

			if (payments.length === 0) {
				if (txExistingRevision && !input.forceRegenerate) {
					const cachedInvoice = storedPdfToBase64(txExistingRevision.generatedPDFInvoice);
					if (cachedInvoice) {
						return { invoice: cachedInvoice };
					}

					logger.error('Active invoice revision has empty PDF and cannot be returned as cache', {
						invoiceRevisionId: txExistingRevision.id,
						buyerWalletVkey: input.buyerWalletVkey,
						month: input.month,
					});
					throw createHttpError(
						409,
						'Cached invoice PDF is unavailable. Regenerate the invoice with force regeneration to repair the revision.',
					);
				}
				throw createHttpError(404, 'No billable payments found for month and wallet');
			}

			const sellerWalletAddress = payments[0].SmartContractWallet?.walletAddress ?? null;
			const buyerWalletAddress = payments[0].BuyerWallet?.walletAddress ?? null;

			const items: InvoiceGroupItemInput[] = [];
			const dbItems: Array<InvoiceGroupItemInput & { referencedPaymentId: string }> = [];

			const groupedPayments = new Map<string, Array<(typeof payments)[number]>>();
			for (const payment of payments) {
				const decidedIdentifier = decodeBlockchainIdentifier(payment.blockchainIdentifier);
				const agentIdentifier = decidedIdentifier?.agentIdentifier ?? `unknown-${payment.id}`;
				const funds = getBillableFunds(payment);
				const fundFingerprint = funds
					.map((f) => `${f.unit}:${f.amount.toString()}`)
					.sort()
					.join('|');
				const groupKey = `${agentIdentifier}::${fundFingerprint}`;
				if (!groupedPayments.has(groupKey)) {
					groupedPayments.set(groupKey, []);
				}
				groupedPayments.get(groupKey)!.push(payment);
			}

			for (const [, agentPayments] of groupedPayments) {
				const payment = agentPayments[0];
				const quantity = agentPayments.length;

				const decidedIdentifier = decodeBlockchainIdentifier(payment.blockchainIdentifier);
				const agentIdentifier = decidedIdentifier?.agentIdentifier ?? `unknown-${payment.id}`;
				const agentDisplayName = agentDisplayNames.get(agentIdentifier) ?? '-';
				const itemName = `${resolved.itemNamePrefix}${agentDisplayName}${resolved.itemNameSuffix}`;

				const funds = getBillableFunds(payment);
				let paymentCount = 0;

				for (const fund of funds) {
					paymentCount++;
					const unit = fund.unit;
					const factor = conversion.get(unit);
					if (!factor) {
						throw createHttpError(400, `Missing conversion for unit: ${unit}`);
					}
					const rawPrice = (Number(fund.amount) * factor.factor) / (1 + effectiveVatRate);
					const price = Math.round(rawPrice * 1e10) / 1e10;
					const conversionFactor = 1 / factor.factor;
					let newItemName = itemName;
					if (paymentCount > 1) {
						newItemName = `${newItemName} (${paymentCount}/${funds.length})`;
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

			const groups = generateInvoiceGroups(items, effectiveVatRate);

			if (txExistingRevision) {
				const changeResult = detectInvoiceChanges(txExistingRevision, groups, input.seller, input.buyer, resolved);

				if (!changeResult.hasChanges && !input.forceRegenerate) {
					const cachedInvoice = storedPdfToBase64(txExistingRevision.generatedPDFInvoice);
					if (cachedInvoice) {
						return { invoice: cachedInvoice };
					}

					logger.warn('Cached invoice has no PDF bytes; creating recovery revision', {
						invoiceRevisionId: txExistingRevision.id,
						buyerWalletVkey: input.buyerWalletVkey,
						month: input.month,
					});
				}

				const originalInfo = getOriginalInvoiceInfo(txExistingRevision);
				const originalItems = txExistingRevision.InvoiceItems.map((it) => ({
					name: it.name,
					quantity: Number(it.quantity.toString()),
					price: Number(it.pricePerUnitWithoutVat.toString()),
					vatRateOverride: Number(it.vatRate.toString()),
					decimals: Number(it.decimals.toString()),
					conversionFactor: Number(it.conversionFactor.toString()),
					convertedUnit: it.convertedUnit,
					conversionDate: it.conversionDate,
				}));
				const originalGroups = generateInvoiceGroups(originalItems, 0);

				const originalSeller = {
					name: txExistingRevision.sellerName ?? null,
					companyName: txExistingRevision.sellerCompanyName ?? null,
					vatNumber: txExistingRevision.sellerVatNumber ?? null,
					country: txExistingRevision.sellerCountry,
					city: txExistingRevision.sellerCity,
					zipCode: txExistingRevision.sellerZipCode,
					street: txExistingRevision.sellerStreet,
					streetNumber: txExistingRevision.sellerStreetNumber,
					email: txExistingRevision.sellerEmail ?? null,
					phone: txExistingRevision.sellerPhone ?? null,
				};
				const originalBuyer = {
					name: txExistingRevision.buyerName ?? null,
					companyName: txExistingRevision.buyerCompanyName ?? null,
					vatNumber: txExistingRevision.buyerVatNumber ?? null,
					country: txExistingRevision.buyerCountry,
					city: txExistingRevision.buyerCity,
					zipCode: txExistingRevision.buyerZipCode,
					street: txExistingRevision.buyerStreet,
					streetNumber: txExistingRevision.buyerStreetNumber,
					email: txExistingRevision.buyerEmail ?? null,
					phone: txExistingRevision.buyerPhone ?? null,
				};

				const originalResolved = resolveInvoiceConfig(
					txExistingRevision.currencyShortId as SupportedCurrencies,
					{
						title: txExistingRevision.invoiceTitle ?? undefined,
						date: txExistingRevision.invoiceDate.toISOString(),
						greeting: txExistingRevision.invoiceGreetings ?? undefined,
						closing: txExistingRevision.invoiceClosing ?? undefined,
						signature: txExistingRevision.invoiceSignature ?? undefined,
						logo: txExistingRevision.invoiceLogo ?? undefined,
						footer: txExistingRevision.invoiceFooter ?? undefined,
						terms: txExistingRevision.invoiceTerms ?? undefined,
						privacy: txExistingRevision.invoicePrivacy ?? undefined,
						language: (txExistingRevision.language as 'en-us' | 'en-gb' | 'de') ?? undefined,
						localizationFormat: (txExistingRevision.localizationFormat as 'en-us' | 'en-gb' | 'de') ?? undefined,
					},
					{ invoiceType: 'monthly' },
				);

				const requiresRecoveryReason = !changeResult.hasChanges && !input.forceRegenerate;
				const cancellationReason =
					changeResult.reasons.length > 0
						? changeResult.reasons.join('; ')
						: input.forceRegenerate
							? 'Manual regeneration requested'
							: requiresRecoveryReason
								? 'Automatic regeneration because cached invoice PDF was missing'
								: 'Invoice regenerated';

				const cancelPrefixKey = `${input.invoice?.idPrefix ?? 'default'}-cancel`;
				const cancelCounter = await tx.invoicePrefix.upsert({
					create: { id: cancelPrefixKey, count: 1 },
					update: { count: { increment: 1 } },
					where: { id: cancelPrefixKey },
				});
				const cancellationId = `${input.invoice?.idPrefix ? input.invoice.idPrefix + '-' : ''}${cancelCounter.count
					.toString()
					.padStart(4, '0')}-CN`;

				const cancellationResolved = resolveInvoiceConfig(
					originalResolved.currency,
					{
						title: originalResolved.title,
						date: new Date().toISOString(),
						greeting: originalResolved.greeting,
						closing: originalResolved.closing,
						signature: originalResolved.signature,
						logo: originalResolved.logo ?? undefined,
						footer: originalResolved.footer,
						terms: originalResolved.terms,
						privacy: originalResolved.privacy,
						language: originalResolved.language as 'en-us' | 'en-gb' | 'de',
						localizationFormat: originalResolved.localizationFormat as 'en-us' | 'en-gb' | 'de',
					},
					{ invoiceType: 'monthly' },
				);

				const { pdfBase64: cancellationPdfBase64 } = await generateCancellationInvoicePDFBase64(
					originalGroups,
					originalSeller,
					originalBuyer,
					cancellationResolved,
					cancellationId,
					originalInfo.originalInvoiceNumber,
					originalInfo.originalInvoiceDate,
					usedCoingeckoForConversion,
					{ reverseCharge: txExistingRevision.reverseCharge, cancellationReason },
				);

				const newRevisionNumber = txExistingRevision.revisionNumber + 1;
				const newInvoiceId = generateInvoiceId(newRevisionNumber, txExistingBase!.invoiceId);
				const { pdfBase64 } = await generateInvoicePDFBase64(
					groups,
					input.seller,
					input.buyer,
					resolved,
					newInvoiceId,
					null,
					usedCoingeckoForConversion,
					{ invoiceType: 'monthly', reverseCharge: input.reverseCharge, servicePeriod },
				);

				const newlyCoveredPaymentIds = txUninvoicedBillable.map((payment) => payment.id);
				if (newlyCoveredPaymentIds.length > 0) {
					await tx.invoiceBase.update({
						where: { id: txExistingBase!.id },
						data: {
							coveredPaymentRequests: {
								connect: newlyCoveredPaymentIds.map((id) => ({ id })),
							},
						},
					});
				}

				await tx.invoiceRevision.update({
					where: { id: txExistingRevision.id },
					data: {
						isCancelled: true,
						cancellationReason,
						cancellationDate: new Date(),
						cancellationId,
						generatedCancelledInvoice: toPrismaBytes(cancellationPdfBase64),
					},
				});

				await tx.invoiceRevision.create({
					data: {
						invoiceBaseId: txExistingBase!.id,
						revisionNumber: newRevisionNumber,
						...buildRevisionData(sellerWalletAddress, buyerWalletAddress, dbItems, toPrismaBytes(pdfBase64)),
					},
				});

				return { invoice: pdfBase64, cancellationInvoice: cancellationPdfBase64 };
			}

			if (txUninvoicedBillable.length === 0) {
				throw createHttpError(404, 'No billable payments found for month and wallet');
			}

			const incrementedInvoiceNumber = await tx.invoicePrefix.upsert({
				create: { id: input.invoice?.idPrefix ?? 'default', count: 1 },
				update: { count: { increment: 1 } },
				where: { id: input.invoice?.idPrefix ?? 'default' },
			});
			const baseIdString = generateNewInvoiceBaseId(
				(input.invoice?.idPrefix ? input.invoice?.idPrefix + '-' : '') +
					incrementedInvoiceNumber.count.toString().padStart(4, '0'),
			);

			const newInvoiceId = generateInvoiceId(1, baseIdString);
			const { pdfBase64 } = await generateInvoicePDFBase64(
				groups,
				input.seller,
				input.buyer,
				resolved,
				newInvoiceId,
				null,
				usedCoingeckoForConversion,
				{ invoiceType: 'monthly', reverseCharge: input.reverseCharge, servicePeriod },
			);

			if (!txTargetSellerWalletVkey) {
				throw createHttpError(
					409,
					`Unable to resolve seller wallet scope for buyer ${input.buyerWalletVkey} in ${input.month}.`,
				);
			}

			const base = await tx.invoiceBase.create({
				data: {
					invoiceId: baseIdString,
					buyerWalletVkey: input.buyerWalletVkey,
					sellerWalletVkey: txTargetSellerWalletVkey,
					invoiceMonth: invoiceMonth,
					invoiceYear: year,
					coveredPaymentRequests: {
						connect: txUninvoicedBillable.map((payment) => ({ id: payment.id })),
					},
				},
			});

			await tx.invoiceRevision.create({
				data: {
					invoiceBaseId: base.id,
					revisionNumber: 1,
					...buildRevisionData(sellerWalletAddress, buyerWalletAddress, dbItems, toPrismaBytes(pdfBase64)),
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

	return invoiceResult;
}
