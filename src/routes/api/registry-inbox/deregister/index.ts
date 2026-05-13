import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from '@/utils/zod-openapi';
import { Network, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { DEFAULTS } from '@/utils/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { registryInboxRequestOutputSchema } from '@/routes/api/registry-inbox';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import { serializeInboxRegistryEntry } from '../serializers';

export const unregisterInboxAgentSchemaInput = z.object({
	agentIdentifier: z
		.string()
		.min(57)
		.max(250)
		.describe('The identifier of the inbox registration (asset) to be deregistered'),
	network: z.nativeEnum(Network).describe('The network the inbox registration was made on'),
	smartContractAddress: z
		.string()
		.max(250)
		.optional()
		.describe('The smart contract address of the payment contract to which the inbox registration belongs'),
});

export const unregisterInboxAgentSchemaOutput = registryInboxRequestOutputSchema;

export const unregisterInboxAgentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: unregisterInboxAgentSchemaInput,
	output: unregisterInboxAgentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof unregisterInboxAgentSchemaInput>; ctx: AuthContext }) => {
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
					smartContractAddress,
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

		const managedHolderWallet = paymentSource.HotWallets.find((wallet) => wallet.walletVkey == vkey);
		if (managedHolderWallet == null) {
			throw createHttpError(409, 'Registered asset is not currently held by a managed wallet');
		}
		assertHotWalletInScope(ctx.walletScopeIds, managedHolderWallet.id);
		const registrationRequest = await prisma.inboxAgentRegistrationRequest.findUnique({
			where: {
				agentIdentifier: policyId + assetName,
			},
		});
		if (registrationRequest == null) {
			throw createHttpError(404, 'Registration not found');
		}

		const result = await prisma.inboxAgentRegistrationRequest.update({
			where: {
				id: registrationRequest.id,
				SmartContractWallet: {
					deletedAt: null,
				},
			},
			data: {
				state: RegistrationState.DeregistrationRequested,
				deregistrationHotWalletId: managedHolderWallet.id,
			},
			include: {
				SmartContractWallet: {
					select: { walletVkey: true, walletAddress: true },
				},
				RecipientWallet: {
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
			},
		});

		return serializeInboxRegistryEntry(result);
	},
});
