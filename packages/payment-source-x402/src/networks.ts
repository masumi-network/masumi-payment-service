import createHttpError from 'http-errors';
import { Prisma, X402EvmWalletType, prisma } from '@masumi/payment-core/db';
import { encrypt } from '@masumi/payment-core/encryption';
import { assertHexAddress, assertSafeRpcUrl, getEip155ChainId, normalizeAddress } from './internal';

const NETWORK_SELECT = {
	id: true,
	caip2Id: true,
	displayName: true,
	rpcUrl: true,
	isTestnet: true,
	isEnabled: true,
	defaultAsset: true,
	facilitatorWalletId: true,
	facilitatorUrl: true,
	// Denormalize the facilitator address so the UI can label chains without loading the
	// full managed-wallet set to resolve the id. facilitatorAuthEnc is never projected.
	FacilitatorWallet: { select: { address: true } },
	createdById: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.X402NetworkSelect;

type NetworkRow = Prisma.X402NetworkGetPayload<{ select: typeof NETWORK_SELECT }>;

function flattenNetwork({ FacilitatorWallet, ...network }: NetworkRow) {
	return { ...network, facilitatorWalletAddress: FacilitatorWallet?.address ?? null };
}

export async function listX402Networks(input?: { isTestnet?: boolean }) {
	const networks = await prisma.x402Network.findMany({
		// Split by environment at the query level: testnet chains belong to the Preprod
		// environment, mainnet chains to Mainnet. Undefined returns every chain.
		where: { isTestnet: input?.isTestnet },
		orderBy: { caip2Id: 'asc' },
		select: NETWORK_SELECT,
	});
	return networks.map(flattenNetwork);
}

// Resolve the facilitator configuration into the columns to persist, enforcing the
// "exactly one mode" invariant: a network settles either through an owned Selling wallet
// (self-hosted) or a remote HTTP facilitator (facilitatorUrl), never both.
//
// Every field is tri-state so the update can distinguish KEEP from CLEAR — the collapse of
// `undefined` and `null` into one "not supplied" bucket was what let a plain metadata edit wipe
// the stored remote-facilitator auth, silently unauthenticating every later settle:
//   - a field is OMITTED (undefined)      → keep whatever is stored (that column is not written)
//   - a selector is explicit `null`       → clear it
//   - a selector is a string              → set that mode (and clear the other + its auth)
//   - facilitatorAuth string / null / omit → set / clear / keep the remote auth header
// Returns undefined when nothing facilitator-related was supplied (touch no facilitator column).
async function resolveFacilitatorData(input: {
	caip2Id: string;
	facilitatorWalletId?: string | null;
	facilitatorUrl?: string | null;
	facilitatorAuth?: string | null;
}): Promise<Prisma.X402NetworkUncheckedUpdateInput | undefined> {
	const wantsWallet = typeof input.facilitatorWalletId === 'string';
	const wantsUrl = typeof input.facilitatorUrl === 'string';
	if (wantsWallet && wantsUrl) {
		throw createHttpError(400, 'Provide either facilitatorWalletId or facilitatorUrl, not both');
	}

	if (wantsWallet) {
		// A facilitator must reference a live Selling wallet that is bound to THIS network.
		// Validating here returns a clear 404/400 (instead of an opaque FK 500), stops a retired
		// or Purchasing wallet from being wired up as a settlement signer, and enforces the
		// wallet<->network binding for the sell side just as getClientForWallet does for buys.
		const wallet = await prisma.x402EvmWallet.findUnique({
			where: { id: input.facilitatorWalletId as string, deletedAt: null },
			select: { id: true, type: true, Network: { select: { caip2Id: true } } },
		});
		if (wallet == null) {
			throw createHttpError(404, 'Managed EVM wallet not found');
		}
		if (wallet.type !== X402EvmWalletType.Selling) {
			throw createHttpError(400, 'Managed EVM wallet is not a Selling wallet');
		}
		if (wallet.Network.caip2Id !== input.caip2Id) {
			throw createHttpError(400, 'Facilitator wallet is bound to a different network');
		}
		// Switching to self-hosted clears any remote endpoint and its auth.
		return { facilitatorWalletId: input.facilitatorWalletId, facilitatorUrl: null, facilitatorAuthEnc: null };
	}

	if (wantsUrl) {
		// The remote facilitator endpoint is admin-supplied and reached server-side, so guard
		// it against SSRF exactly like the RPC URL.
		assertSafeRpcUrl(input.facilitatorUrl as string);
		const data: Prisma.X402NetworkUncheckedUpdateInput = {
			facilitatorWalletId: null,
			facilitatorUrl: input.facilitatorUrl,
		};
		// Only touch the auth column when the caller actually spoke to it: a string sets/rotates
		// it, an explicit null clears it, and omitting it (the dialog's default — auth is
		// write-only and never prefilled) leaves the stored header intact across a URL/name edit.
		if (input.facilitatorAuth !== undefined) {
			data.facilitatorAuthEnc = input.facilitatorAuth != null ? encrypt(input.facilitatorAuth) : null;
		}
		return data;
	}

	// No mode selected but both selectors were explicitly nulled → detach the facilitator entirely
	// (the only way to return a network to "no facilitator", e.g. the dialog's "None").
	if (input.facilitatorWalletId === null && input.facilitatorUrl === null) {
		return { facilitatorWalletId: null, facilitatorUrl: null, facilitatorAuthEnc: null };
	}

	// Auth-only change (rotate or clear the header) against the existing remote facilitator, with
	// no selector supplied. Only valid when a remote URL is already configured — setting auth on a
	// self-hosted or unconfigured network would store a header nothing ever reads.
	if (input.facilitatorAuth !== undefined) {
		const existing = await prisma.x402Network.findUnique({
			where: { caip2Id: input.caip2Id },
			select: { facilitatorUrl: true },
		});
		if (existing?.facilitatorUrl == null) {
			throw createHttpError(400, 'facilitatorAuth can only be set on a network with a remote facilitator URL');
		}
		return { facilitatorAuthEnc: input.facilitatorAuth != null ? encrypt(input.facilitatorAuth) : null };
	}

	return undefined;
}

export async function upsertX402Network(input: {
	caip2Id: string;
	displayName: string;
	rpcUrl: string;
	isTestnet?: boolean;
	isEnabled?: boolean;
	defaultAsset?: string | null;
	facilitatorWalletId?: string | null;
	facilitatorUrl?: string | null;
	facilitatorAuth?: string | null;
	createdById?: string | null;
}) {
	getEip155ChainId(input.caip2Id);
	assertSafeRpcUrl(input.rpcUrl);
	if (input.defaultAsset != null) assertHexAddress(input.defaultAsset, 'defaultAsset');
	const facilitatorData = await resolveFacilitatorData(input);

	const result = await prisma.x402Network.upsert({
		where: { caip2Id: input.caip2Id },
		create: {
			caip2Id: input.caip2Id,
			displayName: input.displayName,
			rpcUrl: input.rpcUrl,
			isTestnet: input.isTestnet ?? false,
			isEnabled: input.isEnabled ?? true,
			defaultAsset: input.defaultAsset,
			// On create there is no prior config to preserve; default to no facilitator.
			facilitatorWalletId: (facilitatorData?.facilitatorWalletId as string | null | undefined) ?? null,
			facilitatorUrl: (facilitatorData?.facilitatorUrl as string | null | undefined) ?? null,
			facilitatorAuthEnc: (facilitatorData?.facilitatorAuthEnc as string | null | undefined) ?? null,
			createdById: input.createdById,
		},
		// createdById is intentionally not updated — it records the original creator.
		update: {
			displayName: input.displayName,
			rpcUrl: input.rpcUrl,
			isTestnet: input.isTestnet,
			isEnabled: input.isEnabled,
			defaultAsset: input.defaultAsset,
			// Only touch facilitator columns when the caller supplied a facilitator field, so a
			// plain metadata edit does not silently wipe the configured facilitator.
			...(facilitatorData ?? {}),
		},
		select: NETWORK_SELECT,
	});
	return flattenNetwork(result);
}

const BUDGET_SELECT = {
	id: true,
	apiKeyId: true,
	evmWalletId: true,
	// Chain comes from the wallet's bound network now, not a budget column.
	EvmWallet: { select: { address: true, Network: { select: { caip2Id: true } } } },
	asset: true,
	remainingAmount: true,
	spentAmount: true,
	createdById: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.X402WalletBudgetSelect;

type BudgetRow = Prisma.X402WalletBudgetGetPayload<{ select: typeof BUDGET_SELECT }>;

function flattenBudget(budget: BudgetRow) {
	const { EvmWallet, ...rest } = budget;
	return { ...rest, caip2Network: EvmWallet.Network.caip2Id, EvmWallet: { address: EvmWallet.address } };
}

export async function setX402WalletBudget(input: {
	apiKeyId: string;
	evmWalletId: string;
	// Optional now: the budget's chain is the wallet's bound network. When supplied it must
	// match, so a budget cannot be granted against a chain the wallet does not operate on.
	caip2Network?: string;
	asset: string;
	remainingAmount: string;
	createdById?: string | null;
}) {
	assertHexAddress(input.asset, 'asset');
	const asset = normalizeAddress(input.asset);
	const remainingAmount = BigInt(input.remainingAmount);

	// Budgets fund outbound payments, so they may only be granted to a Purchasing wallet.
	// Load the wallet with its bound network to validate the (optional) requested chain.
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: input.evmWalletId, deletedAt: null },
		select: { id: true, type: true, Network: { select: { caip2Id: true } } },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	if (wallet.type !== X402EvmWalletType.Purchasing) {
		throw createHttpError(400, 'Managed EVM wallet is not a Purchasing wallet');
	}
	if (input.caip2Network != null && input.caip2Network !== wallet.Network.caip2Id) {
		throw createHttpError(400, 'caip2Network does not match the wallet network');
	}

	const apiKey = await prisma.apiKey.findUnique({ where: { id: input.apiKeyId }, select: { id: true } });
	if (apiKey == null) {
		throw createHttpError(404, 'API key not found');
	}

	const budget = await prisma.x402WalletBudget.upsert({
		where: {
			apiKeyId_evmWalletId_asset: {
				apiKeyId: input.apiKeyId,
				evmWalletId: input.evmWalletId,
				asset,
			},
		},
		create: {
			apiKeyId: input.apiKeyId,
			evmWalletId: input.evmWalletId,
			asset,
			remainingAmount,
			spentAmount: 0n,
			createdById: input.createdById,
		},
		// createdById is intentionally not updated — it records who first set the budget.
		// Setting a budget replaces the remaining amount with a fresh grant, so reset
		// spentAmount too; otherwise "remaining + spent" no longer equals what was granted
		// and the Spent column keeps stale consumption from the previous grant.
		update: {
			remainingAmount,
			spentAmount: 0n,
		},
		select: BUDGET_SELECT,
	});
	return flattenBudget(budget);
}

export async function listX402WalletBudgets(apiKeyId?: string) {
	const budgets = await prisma.x402WalletBudget.findMany({
		where: { apiKeyId },
		orderBy: { createdAt: 'desc' },
		select: BUDGET_SELECT,
	});
	return budgets.map(flattenBudget);
}
