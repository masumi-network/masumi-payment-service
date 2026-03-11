import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from '@/utils/zod-openapi';
import { HotWalletType, Network, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { DEFAULTS } from '@/utils/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { a2aRegistryRequestOutputSchema, registryRequestOutputSchema } from '@/routes/api/registry/schemas';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import { mapA2ARegistryRequestToOutput, mapRegistryRequestToOutput } from '@/routes/api/registry/utils';

const a2aInclude = {
	Pricing: {
		include: {
			FixedPricing: {
				include: { Amounts: { select: { unit: true, amount: true } } },
			},
		},
	},
	SmartContractWallet: {
		select: { walletVkey: true, walletAddress: true },
	},
	CurrentTransaction: {
		select: {
			txHash: true,
			status: true,
			confirmations: true,
			fees: true,
			blockHeight: true,
			blockTime: true,
		},
	},
} as const;

const standardInclude = {
	...a2aInclude,
	ExampleOutputs: { select: { name: true, url: true, mimeType: true } },
} as const;

export const unregisterAgentSchemaInput = z.object({
	agentIdentifier: z
		.string()
		.min(57)
		.max(250)
		.describe('The identifier of the registration (asset) to be deregistered'),
	network: z.nativeEnum(Network).describe('The network the registration was made on'),
	smartContractAddress: z
		.string()
		.max(250)
		.optional()
		.describe('The smart contract address of the payment contract to which the registration belongs'),
});

export const unregisterAgentSchemaOutput = registryRequestOutputSchema.or(a2aRegistryRequestOutputSchema);

export const unregisterAgentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: unregisterAgentSchemaInput,
	output: unregisterAgentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof unregisterAgentSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const smartContractAddress =
			input.smartContractAddress ??
			(input.network == Network.Mainnet
				? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET
				: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD);
		const paymentSource = await prisma.paymentSource.findUnique({
			where: {
				network_smartContractAddress: {
					network: input.network,
					smartContractAddress: smartContractAddress,
				},
				deletedAt: null,
			},
			include: {
				PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
				HotWallets: {
					include: { Secret: { select: { encryptedMnemonic: true } } },
					where: { deletedAt: null },
				},
			},
		});
		if (paymentSource == null) {
			throw createHttpError(404, 'Network and Address combination not supported');
		}

		const blockfrost = getBlockfrostInstance(input.network, paymentSource.PaymentSourceConfig.rpcProviderApiKey);

		const { policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);

		const assetName = extractAssetName(input.agentIdentifier);
		const holderWallet = await blockfrost.assetsAddresses(policyId + assetName, {
			order: 'desc',
			count: 1,
		});
		if (holderWallet.length == 0) {
			throw createHttpError(404, 'Asset not found');
		}
		const vkey = resolvePaymentKeyHash(holderWallet[0].address);

		const sellingWallet = paymentSource.HotWallets.find(
			(wallet) => wallet.walletVkey == vkey && wallet.type == HotWalletType.Selling,
		);
		if (sellingWallet == null) {
			throw createHttpError(404, 'Registered Wallet not found');
		}
		assertHotWalletInScope(ctx.walletScopeIds, sellingWallet.id);

		const fullIdentifier = policyId + assetName;

		// Check standard registry first, then A2A
		const registryRequest = await prisma.registryRequest.findUnique({
			where: { agentIdentifier: fullIdentifier },
		});

		if (registryRequest != null) {
			const result = await prisma.registryRequest.update({
				where: {
					id: registryRequest.id,
					state: RegistrationState.RegistrationConfirmed,
					SmartContractWallet: { deletedAt: null },
				},
				data: { state: RegistrationState.DeregistrationRequested },
				include: standardInclude,
			});
			return mapRegistryRequestToOutput(result);
		}

		const a2aRequest = await prisma.a2ARegistryRequest.findUnique({
			where: { agentIdentifier: fullIdentifier },
		});

		if (a2aRequest != null) {
			const result = await prisma.a2ARegistryRequest.update({
				where: {
					id: a2aRequest.id,
					state: RegistrationState.RegistrationConfirmed,
					SmartContractWallet: { deletedAt: null },
				},
				data: { state: RegistrationState.DeregistrationRequested },
				include: a2aInclude,
			});
			return mapA2ARegistryRequestToOutput(result);
		}

		throw createHttpError(404, 'Registration not found');
	},
});
