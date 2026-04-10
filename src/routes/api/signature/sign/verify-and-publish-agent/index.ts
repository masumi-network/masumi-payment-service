import { RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import stringify from 'canonical-json';
import { z } from '@/utils/zod-openapi';

export const postVerifyAndPublishAgentSignatureSchemaInput = z.object({
	publicKey: z.string().min(1).max(1000).describe('The public key to sign for publishing the agent'),
	agentIdentifier: z.string().min(57).max(250).describe('Full agent identifier (policy ID + asset name in hex)'),
	action: z.enum(['VerifyAndPublishAgent']).describe('The action to perform for agent publish verification'),
});

export const postVerifyAndPublishAgentSignatureSchemaOutput = z.object({
	signature: z.string(),
	key: z.string(),
	walletAddress: z.string(),
	signatureData: z.string(),
});

export const postVerifyAndPublishAgentSignatureEndpoint = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postVerifyAndPublishAgentSignatureSchemaInput,
	output: postVerifyAndPublishAgentSignatureSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof postVerifyAndPublishAgentSignatureSchemaInput>;
		ctx: AuthContext;
	}) => {
		const startTime = Date.now();

		try {
			const registryRequest = await prisma.registryRequest.findFirst({
				where: {
					agentIdentifier: input.agentIdentifier,
					state: RegistrationState.RegistrationConfirmed,
					PaymentSource: {
						deletedAt: null,
					},
					SmartContractWallet: {
						deletedAt: null,
					},
				},
				include: {
					SmartContractWallet: {
						include: {
							Secret: true,
							PaymentSource: {
								include: {
									PaymentSourceConfig: {
										select: {
											rpcProviderApiKey: true,
										},
									},
								},
							},
						},
					},
				},
			});

			if (registryRequest == null) {
				throw createHttpError(404, 'Registered agent not found');
			}

			assertHotWalletInScope(ctx.walletScopeIds, registryRequest.SmartContractWallet.id);

			const { wallet: meshWallet } = await generateWalletExtended(
				registryRequest.SmartContractWallet.PaymentSource.network,
				registryRequest.SmartContractWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
				registryRequest.SmartContractWallet.Secret.encryptedMnemonic,
			);

			const message = stringify({
				action: input.action,
				validUntil: Date.now() + 1000 * 60 * 60,
				data: {
					publicKey: input.publicKey,
					walletVkey: registryRequest.SmartContractWallet.walletVkey,
				},
			});

			const signature = await meshWallet.signData(message, registryRequest.SmartContractWallet.walletAddress);

			return {
				signature: signature.signature,
				key: signature.key,
				walletAddress: registryRequest.SmartContractWallet.walletAddress,
				signatureData: message,
			};
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;

			recordBusinessEndpointError('/api/v1/signature/sign/verifyAndPublishAgent', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				agent_identifier: input.agentIdentifier,
				operation: 'verify_and_publish_agent_signature',
				duration: Date.now() - startTime,
			});

			throw error;
		}
	},
});
