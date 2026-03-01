import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';

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
import { fetchAssetInWalletAndMetadata } from '@/services/blockchain/asset-metadata';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { CONFIG } from '@/utils/config';
import Coingecko from '@coingecko/coingecko-typescript';
import { logger } from '@/utils/logger';

/**
 * Filter payments to only include final (billable) states:
 * - Withdrawn: seller completed work and withdrew funds → use RequestedFunds
 * - ResultSubmitted where unlockTime <= now: seller can claim imminently → use RequestedFunds
 * - DisputedWithdrawn: partial resolution → use WithdrawnForSeller (skip if empty)
 * Everything else is excluded (RefundWithdrawn, FundsLocked, RefundRequested, Disputed, FundsOrDatumInvalid, null)
 */
export function isPaymentBillable(payment: {
	onChainState: string | null;
	unlockTime: bigint;
	WithdrawnForSeller: Array<{ amount: bigint }>;
	TransactionHistory: Array<{ txHash: string | null }>;
}): boolean {
	const state = payment.onChainState;
	// Require at least one confirmed on-chain transaction to prevent mock data from being invoiced
	const hasOnChainTx = payment.TransactionHistory.some((tx) => tx.txHash != null);
	if (!hasOnChainTx) return false;

	if (state === 'Withdrawn') return true;
	if (state === 'ResultSubmitted' && payment.unlockTime <= BigInt(Date.now())) return true;
	if (state === 'DisputedWithdrawn' && payment.WithdrawnForSeller.length > 0) return true;
	return false;
}

/** Normalize asset unit: "lovelace" → "" (empty string = ADA in MeshSDK convention) */
function normalizeUnit(unit: string): string {
	return unit === 'lovelace' ? '' : unit;
}

export function getBillableFunds(payment: {
	onChainState: string | null;
	RequestedFunds: Array<{ unit: string; amount: bigint }>;
	WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
}): Array<{ unit: string; amount: bigint }> {
	const funds = payment.onChainState === 'DisputedWithdrawn' ? payment.WithdrawnForSeller : payment.RequestedFunds;
	return funds.map((f) => ({ unit: normalizeUnit(f.unit), amount: f.amount }));
}

export const invoiceGenerationBaseSchema = z.object({
	buyerWalletVkey: z.string().min(1).max(1000).describe('The buyer wallet vkey to aggregate the month for'),
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.describe('Target month in format YYYY-MM (UTC calendar)'),
	invoiceCurrency: z.enum(supportedCurrencies).describe('The currency of the invoice'),
	currencyConversion: z
		.record(z.string(), z.number().gt(0))
		.optional()
		.describe('Currency conversion settings by unit for this invoice'),
	invoice: invoiceOptionsSchema,
	vatRate: z.number().min(0).max(1).optional().describe('The VAT rate as decimal (e.g., 0.19 for 19%)'),
	reverseCharge: z.boolean().optional().default(false).describe('Enable reverse charge (VAT = 0, notice on invoice)'),
	forceRegenerate: z
		.boolean()
		.optional()
		.default(false)
		.describe('Force cancel existing invoice and generate a new revision, even if no data changes detected'),
	seller: invoiceSellerSchema,
	buyer: invoiceBuyerSchema,
});

export const invoiceGenerationSchemaInput = invoiceGenerationBaseSchema
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

export const invoiceGenerationSchemaOutput = z.object({
	invoice: z.string(),
	cancellationInvoice: z.string().optional(),
});

interface GenerateMonthlyInvoiceInput {
	buyerWalletVkey: string;
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
		PaymentSource: { include: { PaymentSourceConfig: true as const } },
	};

	const prePayments = await prisma.paymentRequest.findMany({
		where: {
			BuyerWallet: { walletVkey: input.buyerWalletVkey },
			invoiceBaseId: null,
			OR: billableStateFilter,
		},
		include: paymentIncludes,
	});

	const preBillable = prePayments.filter(isPaymentBillable);

	// When force-regenerating, merge uninvoiced payments with payments from existing invoice (deduped)
	if (input.forceRegenerate) {
		const existingBase = await prisma.invoiceBase.findFirst({
			where: {
				coveredPaymentRequests: {
					some: { BuyerWallet: { walletVkey: input.buyerWalletVkey } },
				},
				InvoiceRevisions: {
					some: { invoiceMonth: invoiceMonth, invoiceYear: year, isCancelled: false },
				},
			},
			include: {
				coveredPaymentRequests: {
					include: paymentIncludes,
				},
			},
		});
		if (existingBase) {
			const existingBillable = existingBase.coveredPaymentRequests.filter(isPaymentBillable);
			const existingIds = new Set(preBillable.map((p) => p.id));
			for (const p of existingBillable) {
				if (!existingIds.has(p.id)) {
					preBillable.push(p);
				}
			}
		}
	}

	if (preBillable.length === 0) {
		recordBusinessEndpointError(metricPath, 'POST', 404, 'No billable payments found for month and wallet', {
			operation: 'generate_invoice',
		});
		throw createHttpError(404, 'No billable payments found for month and wallet');
	}

	// Wallet address verification (only for signature-verified flow)
	if (options?.walletAddress) {
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
	if (conversion.size === 0 && !CONFIG.COINGECKO_API_KEY) {
		throw createHttpError(400, 'Missing currency conversion mapping');
	}

	const missingConversions = new Set<string>();
	for (const p of preBillable) {
		const funds = getBillableFunds(p);
		for (const fund of funds) {
			if (!conversion.has(fund.unit)) {
				missingConversions.add(fund.unit);
			}
		}
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
				const splittedDate = dateOfConversionDate.toISOString().split('T');
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

	// Pre-resolve agent display names and verify on-chain existence (blockfrost)
	const agentDisplayNames = new Map<string, string>();
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
		if (agentDisplayNames.has(agentIdentifier)) continue;

		const blockfrost = new BlockFrostAPI({
			projectId: payment.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		});
		const agentName = await fetchAssetInWalletAndMetadata(blockfrost, agentIdentifier);
		if ('error' in agentName) {
			throw createHttpError(
				404,
				`Agent ${agentIdentifier} not found on-chain — payment ${payment.id} cannot be invoiced`,
			);
		}
		const display = metadataToString(agentName.data.parsedMetadata.name);
		agentDisplayNames.set(agentIdentifier, display ?? '-');
	}

	// Determine effective VAT rate (reverse charge forces 0)
	const effectiveVatRate = input.reverseCharge ? 0 : (input.vatRate ?? 0);

	const resolved = resolveInvoiceConfig(
		input.invoiceCurrency,
		{
			...input.invoice,
			date: input.invoice?.date ?? dateOfConversionDate.toISOString(),
		},
		{ invoiceType: 'monthly' },
	);

	// Helper to build revision data fields (shared between new and update paths)
	const buildRevisionData = (
		sellerWalletAddress: string | null,
		buyerWalletAddress: string | null,
		dbItems: Array<InvoiceGroupItemInput & { referencedPaymentId: string }>,
	) => ({
		currencyShortId: resolved.currency,
		invoiceTitle: resolved.title,
		invoiceDescription: input.invoice?.description ?? null,
		invoiceDate: resolved.date,
		invoiceMonth: invoiceMonth,
		invoiceYear: year,
		reverseCharge: input.reverseCharge,
		invoiceGreetings: resolved.greeting ?? null,
		invoiceClosing: resolved.closing ?? null,
		invoiceSignature: resolved.signature ?? null,
		invoiceLogo: resolved.logo ?? null,
		invoiceFooter: resolved.footer ?? null,
		invoiceTerms: resolved.terms ?? null,
		invoicePrivacy: resolved.privacy ?? null,
		invoiceDisclaimer: null,
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
		generatedPDFInvoice: Buffer.alloc(0),
		generatedInvoiceUpdatedAt: new Date(), // overwritten by DB trigger when PDF is set
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

	// Compute service period text for legal compliance (e.g. "January 2026")
	const servicePeriodDate = new Date(Date.UTC(year, monthIdx, 1));
	const servicePeriod = servicePeriodDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

	// ── Serializable transaction: payment read + invoice check + write ──
	// PDF generation happens AFTER the transaction commits to avoid holding locks.
	const txResult = await prisma.$transaction(
		async (tx) => {
			// Re-query payments inside transaction for serializable consistency
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

			const allPayments = await tx.paymentRequest.findMany({
				where: {
					BuyerWallet: { walletVkey: input.buyerWalletVkey },
					invoiceBaseId: null,
					OR: txBillableStateFilter,
				},
				include: paymentIncludes,
			});

			const payments = allPayments.filter(isPaymentBillable);

			// When force-regenerating, merge uninvoiced payments with payments from existing invoice (deduped)
			if (input.forceRegenerate) {
				const txExistingBase = await tx.invoiceBase.findFirst({
					where: {
						coveredPaymentRequests: {
							some: { BuyerWallet: { walletVkey: input.buyerWalletVkey } },
						},
						InvoiceRevisions: {
							some: { invoiceMonth: invoiceMonth, invoiceYear: year, isCancelled: false },
						},
					},
					include: {
						coveredPaymentRequests: {
							include: paymentIncludes,
						},
					},
				});
				if (txExistingBase) {
					const txExistingBillable = txExistingBase.coveredPaymentRequests.filter(isPaymentBillable);
					const txExistingIds = new Set(payments.map((p) => p.id));
					for (const p of txExistingBillable) {
						if (!txExistingIds.has(p.id)) {
							payments.push(p);
						}
					}
				}
			}

			if (payments.length === 0) {
				throw createHttpError(404, 'No billable payments found for month and wallet');
			}

			// Resolve wallet addresses from transactional snapshot
			const sellerWalletAddress = payments[0].SmartContractWallet?.walletAddress ?? null;
			const buyerWalletAddress = payments[0].BuyerWallet?.walletAddress ?? null;

			// Build invoice items from transactional payment data
			const items: InvoiceGroupItemInput[] = [];
			const dbItems: Array<InvoiceGroupItemInput & { referencedPaymentId: string }> = [];

			// Group payments by agent identifier + fund fingerprint (canonical stringified funds)
			// so that only payments with identical funds share a line item
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

			// Look for existing InvoiceBase for this month/year/wallet
			const existingBase = await tx.invoiceBase.findFirst({
				where: {
					coveredPaymentRequests: {
						some: {
							BuyerWallet: { walletVkey: input.buyerWalletVkey },
						},
					},
					InvoiceRevisions: {
						some: {
							invoiceMonth: invoiceMonth,
							invoiceYear: year,
							isCancelled: false,
						},
					},
				},
				include: {
					InvoiceRevisions: {
						where: { isCancelled: false },
						orderBy: { revisionNumber: 'desc' },
						take: 1,
						include: { InvoiceItems: true },
					},
				},
			});

			const existingRevision =
				existingBase && existingBase.InvoiceRevisions.length > 0
					? { ...existingBase.InvoiceRevisions[0], InvoiceBase: existingBase }
					: null;

			// If existing revision found, check if data changed
			if (existingRevision) {
				const changeResult = detectInvoiceChanges(existingRevision, groups, input.seller, input.buyer, resolved);

				if (!changeResult.hasChanges && !input.forceRegenerate) {
					// Return cached PDF
					return {
						type: 'cached' as const,
						invoice: Buffer.from(existingRevision.generatedPDFInvoice as unknown as Uint8Array).toString('base64'),
					};
				}

				// Data changed → prepare cancellation for old revision, then create new revision
				const originalInfo = getOriginalInvoiceInfo(existingRevision);

				// Reconstruct original groups from stored items
				const originalItems = existingRevision.InvoiceItems.map((it) => ({
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

				// Build original seller/buyer from stored revision data
				const originalSeller = {
					name: existingRevision.sellerName ?? null,
					companyName: existingRevision.sellerCompanyName ?? null,
					vatNumber: existingRevision.sellerVatNumber ?? null,
					country: existingRevision.sellerCountry,
					city: existingRevision.sellerCity,
					zipCode: existingRevision.sellerZipCode,
					street: existingRevision.sellerStreet,
					streetNumber: existingRevision.sellerStreetNumber,
					email: existingRevision.sellerEmail ?? null,
					phone: existingRevision.sellerPhone ?? null,
				};
				const originalBuyer = {
					name: existingRevision.buyerName ?? null,
					companyName: existingRevision.buyerCompanyName ?? null,
					vatNumber: existingRevision.buyerVatNumber ?? null,
					country: existingRevision.buyerCountry,
					city: existingRevision.buyerCity,
					zipCode: existingRevision.buyerZipCode,
					street: existingRevision.buyerStreet,
					streetNumber: existingRevision.buyerStreetNumber,
					email: existingRevision.buyerEmail ?? null,
					phone: existingRevision.buyerPhone ?? null,
				};

				// Build config for original revision
				const originalResolved = resolveInvoiceConfig(
					existingRevision.currencyShortId as SupportedCurrencies,
					{
						title: existingRevision.invoiceTitle ?? undefined,
						date: existingRevision.invoiceDate.toISOString(),
						greeting: existingRevision.invoiceGreetings ?? undefined,
						closing: existingRevision.invoiceClosing ?? undefined,
						signature: existingRevision.invoiceSignature ?? undefined,
						logo: existingRevision.invoiceLogo ?? undefined,
						footer: existingRevision.invoiceFooter ?? undefined,
						terms: existingRevision.invoiceTerms ?? undefined,
						privacy: existingRevision.invoicePrivacy ?? undefined,
						language: (existingRevision.language as 'en-us' | 'en-gb' | 'de') ?? undefined,
						localizationFormat: (existingRevision.localizationFormat as 'en-us' | 'en-gb' | 'de') ?? undefined,
					},
					{ invoiceType: 'monthly' },
				);

				// Allocate sequential cancellation ID
				const cancelPrefixKey = `${input.invoice?.idPrefix ?? 'default'}-cancel`;
				const cancelCounter = await tx.invoicePrefix.upsert({
					create: { id: cancelPrefixKey, count: 1 },
					update: { count: { increment: 1 } },
					where: { id: cancelPrefixKey },
				});
				const cancellationId = `${input.invoice?.idPrefix ? input.invoice.idPrefix + '-' : ''}${cancelCounter.count.toString().padStart(4, '0')}-CN`;

				// Mark old revision as cancelled (PDF filled after commit)
				await tx.invoiceRevision.update({
					where: { id: existingRevision.id },
					data: {
						isCancelled: true,
						cancellationReason:
							input.forceRegenerate && changeResult.reasons.length === 0
								? 'Manual regeneration requested'
								: changeResult.reasons.join('; '),
						cancellationDate: new Date(),
						cancellationId,
						generatedCancelledInvoice: Buffer.alloc(0),
					},
				});

				// Create new revision (PDF filled after commit)
				const newRevisionNumber = existingRevision.revisionNumber + 1;
				const newInvoiceId = generateInvoiceId(newRevisionNumber, existingBase!.invoiceId);

				const newRevision = await tx.invoiceRevision.create({
					data: {
						invoiceBaseId: existingBase!.id,
						revisionNumber: newRevisionNumber,
						...buildRevisionData(sellerWalletAddress, buyerWalletAddress, dbItems),
					},
				});

				return {
					type: 'revision' as const,
					newRevisionId: newRevision.id,
					oldRevisionId: existingRevision.id,
					newInvoiceId,
					cancellationId,
					newGroups: groups,
					originalGroups,
					originalSeller,
					originalBuyer,
					originalResolved,
					originalInfo,
					existingReverseCharge: existingRevision.reverseCharge,
				};
			}

			// No existing invoice → create new InvoiceBase + first revision
			const incrementedInvoiceNumber = await tx.invoicePrefix.upsert({
				create: { id: input.invoice?.idPrefix ?? 'default', count: 1 },
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
					coveredPaymentRequests: {
						connect: payments.map((p) => ({ id: p.id })),
					},
				},
			});

			const newInvoiceId = generateInvoiceId(1, baseIdString);

			const newRevision = await tx.invoiceRevision.create({
				data: {
					invoiceBaseId: base.id,
					revisionNumber: 1,
					...buildRevisionData(sellerWalletAddress, buyerWalletAddress, dbItems),
				},
			});

			return {
				type: 'new' as const,
				newRevisionId: newRevision.id,
				newInvoiceId,
				newGroups: groups,
			};
		},
		{
			timeout: 20000,
			maxWait: 20000,
			isolationLevel: 'Serializable',
		},
	);

	// ── Post-transaction: generate PDFs and update DB records ──
	if (txResult.type === 'cached') {
		return { invoice: txResult.invoice };
	}

	if (txResult.type === 'revision') {
		// Generate cancellation PDF with today's date (not original invoice date)
		const cancellationResolved = resolveInvoiceConfig(
			txResult.originalResolved.currency,
			{
				title: txResult.originalResolved.title,
				date: new Date().toISOString(),
				greeting: txResult.originalResolved.greeting,
				closing: txResult.originalResolved.closing,
				signature: txResult.originalResolved.signature,
				logo: txResult.originalResolved.logo ?? undefined,
				footer: txResult.originalResolved.footer,
				terms: txResult.originalResolved.terms,
				privacy: txResult.originalResolved.privacy,
				language: txResult.originalResolved.language as 'en-us' | 'en-gb' | 'de',
				localizationFormat: txResult.originalResolved.localizationFormat as 'en-us' | 'en-gb' | 'de',
			},
			{ invoiceType: 'monthly' },
		);

		const { pdfBase64: cancellationPdfBase64 } = await generateCancellationInvoicePDFBase64(
			txResult.originalGroups,
			txResult.originalSeller,
			txResult.originalBuyer,
			cancellationResolved,
			txResult.cancellationId,
			txResult.originalInfo.originalInvoiceNumber,
			txResult.originalInfo.originalInvoiceDate,
			usedCoingeckoForConversion,
			{ reverseCharge: txResult.existingReverseCharge },
		);

		// Generate new invoice PDF
		const { pdfBase64 } = await generateInvoicePDFBase64(
			txResult.newGroups,
			input.seller,
			input.buyer,
			resolved,
			txResult.newInvoiceId,
			null,
			usedCoingeckoForConversion,
			{ invoiceType: 'monthly', reverseCharge: input.reverseCharge, servicePeriod },
		);

		// Update DB records with generated PDFs
		await Promise.all([
			prisma.invoiceRevision.update({
				where: { id: txResult.oldRevisionId },
				data: {
					generatedCancelledInvoice: Buffer.from(cancellationPdfBase64, 'base64'),
				},
			}),
			prisma.invoiceRevision.update({
				where: { id: txResult.newRevisionId },
				data: {
					generatedPDFInvoice: Buffer.from(pdfBase64, 'base64'),
				},
			}),
		]);

		return { invoice: pdfBase64, cancellationInvoice: cancellationPdfBase64 };
	}

	// type === 'new'
	const { pdfBase64 } = await generateInvoicePDFBase64(
		txResult.newGroups,
		input.seller,
		input.buyer,
		resolved,
		txResult.newInvoiceId,
		null,
		usedCoingeckoForConversion,
		{ invoiceType: 'monthly', reverseCharge: input.reverseCharge, servicePeriod },
	);

	await prisma.invoiceRevision.update({
		where: { id: txResult.newRevisionId },
		data: {
			generatedPDFInvoice: Buffer.from(pdfBase64, 'base64'),
		},
	});

	return { invoice: pdfBase64 };
}
