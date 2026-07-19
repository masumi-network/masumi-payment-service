import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { PaymentSourceType, PricingType, Prisma, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { extractAssetName, extractPolicyId } from '@/utils/converter/agent-identifier';
import { registryRequestOutputSchema, registerAgentSchemaInput } from '@/routes/api/registry';
import { getBlockfrostInstance, validateAssetsOnChain } from '@/utils/blockfrost';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import { bumpRegistryAssetNameVersionV2, normalizeRequestedRegistryFundingLovelace } from '@/services/registry/shared';
import { recordBusinessEndpointError } from '@masumi/payment-core/metrics';
import { supportedPaymentSourceSchema, validateSupportedPaymentSourcesOrThrow } from '@/types/payment-source';
import { serializeSupportedPaymentSources, serializeVerifications } from '../serializers';
import { verificationToRow } from '@/types/verification';

const updateSupportedPaymentSourcesSchema = z
	.array(supportedPaymentSourceSchema)
	.max(25)
	.describe('Payment sources to replace on this registry request. Provide an empty array to clear them.');

// The update flow re-uses the same metadata fields as registration — the
// V2 mint contract's UpdateAction atomically burns the current asset and
// mints a replacement carrying the new CIP-25 metadata. The schema mirrors
// `registerAgentSchemaInput` except:
//   - `sellingWalletVkey` is omitted: the signing wallet is whichever managed
//     hot wallet currently holds the asset (resolved on chain), not a
//     caller-supplied vkey.
//   - `agentIdentifier` of the existing registration is required.
//   - `smartContractAddress` is optional: when omitted we resolve the active
//     V2 payment source on the requested `network` by `policyId` extracted
//     from `agentIdentifier`, mirroring the deregister route's fallback.
export const updateAgentSchemaInput = registerAgentSchemaInput.omit({ sellingWalletVkey: true }).extend({
	agentIdentifier: z
		.string()
		.min(57)
		.max(250)
		.regex(/^[0-9a-fA-F]+$/, 'agentIdentifier must be a hex string (policyId + assetName)')
		.describe('The current on-chain identifier of the agent registration to update'),
	smartContractAddress: z
		.string()
		.min(58)
		.max(120)
		.regex(/^(addr1|addr_test1)[0-9a-z]+$/, 'smartContractAddress must be a bech32 Cardano address')
		.optional()
		.describe('The smart contract address of the payment source the registration belongs to'),
	supportedPaymentSources: updateSupportedPaymentSourcesSchema.optional(),
});

export const updateAgentSchemaOutput = registryRequestOutputSchema;

export const updateAgentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: updateAgentSchemaInput,
	output: updateAgentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof updateAgentSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

			const requestedPolicyId = extractPolicyId(input.agentIdentifier);
			const requestedAssetName = extractAssetName(input.agentIdentifier);

			const paymentSourceInclude = {
				PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
				HotWallets: { where: { deletedAt: null } },
			};

			// Resolve the V2 payment source by caller-supplied address when
			// present, otherwise by the policy prefix from agentIdentifier. This
			// matches deregister's fallback and avoids accidentally resolving the
			// legacy V1 default smart-contract address for V2-only updates.
			const paymentSource =
				input.smartContractAddress != null
					? await prisma.paymentSource.findUnique({
							where: {
								network_smartContractAddress: {
									network: input.network,
									smartContractAddress: input.smartContractAddress,
								},
								deletedAt: null,
							},
							include: paymentSourceInclude,
						})
					: await prisma.paymentSource.findFirst({
							where: {
								network: input.network,
								policyId: requestedPolicyId,
								paymentSourceType: PaymentSourceType.Web3CardanoV2,
								deletedAt: null,
							},
							include: paymentSourceInclude,
						});

			if (paymentSource == null) {
				throw createHttpError(404, 'Network and Address combination not supported');
			}

			// The V1 mint contract's `Action` enum has no UpdateAction (only
			// MintAction / BurnAction). Reject the operation up front so we
			// don't leave half-built rows around for an action that can never
			// be submitted.
			if (paymentSource.paymentSourceType !== PaymentSourceType.Web3CardanoV2) {
				throw createHttpError(400, 'Update agent identifier is only supported for Web3CardanoV2 payment sources');
			}

			// Now derive the V2 policyId from the resolved payment source and
			// look up the agent within that source. Mismatch between the
			// agentIdentifier's policy prefix and the source's policyId means
			// the caller is pointing at a different source than the asset
			// belongs to.
			const { policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

			if (policyId !== requestedPolicyId) {
				throw createHttpError(409, 'agentIdentifier policy does not match this payment source');
			}

			const registryRequest = await prisma.registryRequest.findUnique({
				where: { agentIdentifier: policyId + requestedAssetName },
			});
			if (registryRequest == null) {
				throw createHttpError(404, 'Registration not found');
			}
			if (registryRequest.paymentSourceId !== paymentSource.id) {
				// Defensive: the unique row exists but is anchored to a
				// different payment source. Treat as "not found here" so the
				// caller gets a consistent 404 rather than a stale 409.
				throw createHttpError(404, 'Registration not found');
			}

			const blockfrost = getBlockfrostInstance(input.network, paymentSource.PaymentSourceConfig.rpcProviderApiKey);

			const holderWallet = await blockfrost.assetsAddresses(policyId + requestedAssetName, {
				order: 'desc',
				count: 1,
			});
			if (holderWallet.length === 0) {
				throw createHttpError(404, 'Asset not found');
			}
			const vkey = resolvePaymentKeyHash(holderWallet[0].address);

			const managedHolderWallet = paymentSource.HotWallets.find((wallet) => wallet.walletVkey == vkey);
			if (managedHolderWallet == null) {
				throw createHttpError(409, 'Registered asset is not currently held by a managed wallet');
			}
			assertHotWalletInScope(ctx.walletScopeIds, managedHolderWallet.id);
			if (!ctx.canAdmin && (registryRequest.requestedById == null || registryRequest.requestedById !== ctx.id)) {
				throw createHttpError(403, 'You are not authorized to update this agent');
			}
			// Only Confirmed registrations have an on-chain asset to update.
			// Failed / Requested / Initiated / Deregistration* rows are out
			// of scope — operator should fix those via deregister / delete.
			const validStatesForUpdate: RegistrationState[] = [
				RegistrationState.RegistrationConfirmed,
				RegistrationState.UpdateConfirmed,
				RegistrationState.UpdateFailed,
			];
			if (!validStatesForUpdate.includes(registryRequest.state)) {
				throw createHttpError(
					400,
					`Agent registration cannot be updated in its current state: ${registryRequest.state}`,
				);
			}

			// Pre-compute the bumped asset name so the schedule tick can
			// derive it deterministically (`bumpRegistryAssetNameVersionV2`
			// is pure-function over the asset name, so this throws today if
			// the version segment would overflow — better to surface that
			// here than to leave the row queued forever).
			bumpRegistryAssetNameVersionV2(requestedAssetName);

			// Recipient: if caller specified, validate it lives on the same
			// payment source. Otherwise, the V2 update service emits to the
			// current holder by default.
			let recipientHotWalletId: string | null = null;
			if (input.recipientWalletAddress != null) {
				const recipient = await prisma.hotWallet.findFirst({
					where: {
						walletAddress: input.recipientWalletAddress,
						paymentSourceId: paymentSource.id,
						deletedAt: null,
					},
					select: { id: true },
				});
				if (recipient == null) {
					throw createHttpError(404, 'Recipient wallet not found on the same payment source');
				}
				assertHotWalletInScope(ctx.walletScopeIds, recipient.id);
				recipientHotWalletId = recipient.id;
			}

			// supportedPaymentSources is OPTIONAL on update. Distinguish:
			//   - omitted (undefined)     → leave existing rows UNCHANGED (no delete, no recreate).
			//                                Previously `?? []` collapsed this into a silent wipe.
			//   - provided (including [])  → REPLACE: delete existing rows, recreate from input.
			// This route is already V2-gated above, so supportedPaymentSources is a
			// V2-only concept here by construction.
			const supportedPaymentSources = input.supportedPaymentSources;
			const replaceSupportedPaymentSources = supportedPaymentSources !== undefined;
			if (supportedPaymentSources != null && supportedPaymentSources.length > 0) {
				try {
					validateSupportedPaymentSourcesOrThrow(
						supportedPaymentSources,
						input.network,
						paymentSource.paymentSourceType,
						ctx.caip2NetworkLimit,
					);
				} catch (error) {
					throw createHttpError(400, error instanceof Error ? error.message : String(error));
				}
			}

			if (input.AgentPricing.pricingType === PricingType.Fixed) {
				const assetUnits = input.AgentPricing.Pricing.map((pricing) => pricing.unit);
				const { valid: _valid, invalid: invalidAssets } = await validateAssetsOnChain(blockfrost, assetUnits);
				if (invalidAssets.length > 0) {
					const invalidAssetsMessage = invalidAssets.map((item) => `${item.asset} (${item.errorMessage})`).join(', ');
					throw createHttpError(400, `Invalid assets in pricing: ${invalidAssetsMessage}`);
				}
			}

			// Replace pricing / example outputs / supported payment sources atomically.
			// AgentPricing is 1:1 with RegistryRequest via a NOT NULL FK, so we
			// build a fresh AgentPricing standalone, swap the RegistryRequest FK,
			// then drop the orphan old row (and its AgentFixedPricing if any).
			const result = await prisma.$transaction(async (tx) => {
				// Re-read state INSIDE the tx and CAS-guard the state write below to
				// close the TOCTOU window between the validStatesForUpdate check above
				// (a stale findUnique read) and these writes. A concurrent deregister
				// could have flipped the row to DeregistrationRequested; without this
				// both the update and deregister schedulers would act on the same asset.
				const current = await tx.registryRequest.findUnique({
					where: { id: registryRequest.id },
					select: { state: true, paymentSourceId: true },
				});
				if (current == null || current.paymentSourceId !== paymentSource.id) {
					throw createHttpError(404, 'Registration not found');
				}
				if (!validStatesForUpdate.includes(current.state)) {
					throw createHttpError(409, `Agent registration cannot be updated in its current state: ${current.state}`);
				}
				await tx.exampleOutput.deleteMany({ where: { registryRequestId: registryRequest.id } });
				// Only clear when the caller explicitly provided supportedPaymentSources;
				// omitted (undefined) means "leave existing rows as-is".
				if (replaceSupportedPaymentSources) {
					await tx.supportedPaymentSource.deleteMany({ where: { registryRequestId: registryRequest.id } });
				}
				const oldPricing = await tx.registryRequest.findUnique({
					where: { id: registryRequest.id },
					select: { agentPricingId: true },
				});
				let oldFixedPricingId: string | null = null;
				if (oldPricing?.agentPricingId != null) {
					const oldAgentPricing = await tx.agentPricing.findUnique({
						where: { id: oldPricing.agentPricingId },
						select: { agentFixedPricingId: true },
					});
					oldFixedPricingId = oldAgentPricing?.agentFixedPricingId ?? null;
				}
				const newPricing = await tx.agentPricing.create({
					data:
						input.AgentPricing.pricingType == PricingType.Fixed
							? {
									pricingType: input.AgentPricing.pricingType,
									FixedPricing: {
										create: {
											Amounts: {
												createMany: {
													data: input.AgentPricing.Pricing.map((price) => ({
														unit: price.unit.toLowerCase() == 'lovelace' ? '' : price.unit,
														amount: BigInt(price.amount),
													})),
												},
											},
										},
									},
								}
							: {
									pricingType: input.AgentPricing.pricingType,
								},
					select: { id: true },
				});
				await tx.registryRequest.update({
					// Atomic CAS on state: if a concurrent action advanced the row out of
					// an updatable state between the re-read above and this write, match 0
					// rows -> the whole tx rolls back (P2025, mapped to 409 below) instead
					// of half-updating a row another scheduler now owns.
					where: { id: registryRequest.id, state: { in: validStatesForUpdate } },
					data: {
						name: input.name,
						description: input.description,
						apiBaseUrl: input.apiBaseUrl,
						capabilityName: input.Capability.name,
						capabilityVersion: input.Capability.version,
						other: input.Legal?.other,
						terms: input.Legal?.terms,
						privacyPolicy: input.Legal?.privacyPolicy,
						authorName: input.Author.name,
						authorContactEmail: input.Author.contactEmail,
						authorContactOther: input.Author.contactOther,
						authorOrganization: input.Author.organization,
						// Clamp to the minimum NFT funding like the register path; a raw value
						// below the min (e.g. "1") would build an update mint output under
						// min-UTXO and fail, stranding the row in UpdateRequested/UpdateFailed.
						// null still means "leave funding unchanged".
						sendFundingLovelace:
							input.sendFundingLovelace != null
								? normalizeRequestedRegistryFundingLovelace(input.sendFundingLovelace)
								: null,
						state: RegistrationState.UpdateRequested,
						error: null,
						tags: input.Tags,
						// verifications is OPTIONAL on update: replace only when the caller
						// provided the field (an empty array clears it); omitting it leaves
						// the existing rows to carry into the re-mint.
						...(input.verifications !== undefined
							? {
									Verifications: {
										deleteMany: {},
										createMany: { data: input.verifications.map(verificationToRow) },
									},
								}
							: {}),
						// Re-use the deregistration hot-wallet relation as the
						// holder-side action wallet — the lock-and-query
						// path already keys non-RegistrationRequested
						// states off this column.
						DeregistrationHotWallet: { connect: { id: managedHolderWallet.id } },
						Pricing: { connect: { id: newPricing.id } },
						...(recipientHotWalletId != null ? { RecipientWallet: { connect: { id: recipientHotWalletId } } } : {}),
						ExampleOutputs: {
							createMany: {
								data: input.ExampleOutputs.map((exampleOutput) => ({
									name: exampleOutput.name,
									url: exampleOutput.url,
									mimeType: exampleOutput.mimeType,
								})),
							},
						},
						...(supportedPaymentSources != null && supportedPaymentSources.length > 0
							? {
									SupportedPaymentSources: {
										createMany: {
											data: supportedPaymentSources.map((source) => ({
												chain: source.chain,
												network: source.network,
												paymentSourceType: source.paymentSourceType,
												address: source.chain === 'EVM' ? (source.address ?? source.payTo) : source.address,
												...(source.chain === 'EVM'
													? {
															scheme: source.scheme,
															pricingType: source.pricingType,
															asset: source.pricingType === PricingType.Free ? null : (source.asset ?? null),
															amount: source.pricingType === PricingType.Fixed ? BigInt(source.amount) : null,
															decimals: source.pricingType === PricingType.Free ? null : (source.decimals ?? null),
															payTo: source.payTo,
															resource: source.resource,
															extra: source.extra as Prisma.InputJsonValue | undefined,
														}
													: {}),
											})),
										},
									},
								}
							: {}),
					},
				});
				if (oldFixedPricingId != null) {
					// UnitValue.agentFixedPricingId uses ON DELETE SET NULL, not
					// cascade. Delete amounts explicitly before dropping the old
					// fixed-pricing row so update retries do not accumulate
					// detached pricing values.
					await tx.unitValue.deleteMany({ where: { agentFixedPricingId: oldFixedPricingId } });
				}
				if (oldPricing?.agentPricingId != null) {
					await tx.agentPricing.delete({ where: { id: oldPricing.agentPricingId } });
				}
				if (oldFixedPricingId != null) {
					await tx.agentFixedPricing.delete({ where: { id: oldFixedPricingId } });
				}
				return tx.registryRequest.findUniqueOrThrow({
					where: { id: registryRequest.id },
					include: {
						Pricing: {
							include: {
								FixedPricing: {
									include: { Amounts: { select: { unit: true, amount: true } } },
								},
							},
						},
						SmartContractWallet: { select: { walletVkey: true, walletAddress: true } },
						RecipientWallet: { select: { walletVkey: true, walletAddress: true } },
						ExampleOutputs: { select: { name: true, url: true, mimeType: true } },
						Verifications: true,
						SupportedPaymentSources: {
							select: {
								chain: true,
								network: true,
								paymentSourceType: true,
								address: true,
								scheme: true,
								pricingType: true,
								asset: true,
								amount: true,
								decimals: true,
								payTo: true,
								resource: true,
								extra: true,
							},
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
			});

			return {
				...result,
				Capability: {
					name: result.capabilityName,
					version: result.capabilityVersion,
				},
				Author: {
					name: result.authorName,
					contactEmail: result.authorContactEmail,
					contactOther: result.authorContactOther,
					organization: result.authorOrganization,
				},
				Legal: {
					privacyPolicy: result.privacyPolicy,
					terms: result.terms,
					other: result.other,
				},
				AgentPricing:
					result.Pricing.pricingType == PricingType.Fixed
						? {
								pricingType: PricingType.Fixed,
								Pricing:
									result.Pricing.FixedPricing?.Amounts.map((price) => ({
										unit: price.unit,
										amount: price.amount.toString(),
									})) ?? [],
							}
						: {
								pricingType: result.Pricing.pricingType,
							},
				sendFundingLovelace: result.sendFundingLovelace?.toString() ?? null,
				supportedPaymentSources: serializeSupportedPaymentSources(result.SupportedPaymentSources),
				verifications: serializeVerifications(result.Verifications),
				Tags: result.tags,
				RecipientWallet: result.RecipientWallet,
				CurrentTransaction: result.CurrentTransaction
					? {
							...result.CurrentTransaction,
							fees: result.CurrentTransaction.fees?.toString() ?? null,
						}
					: null,
			};
		} catch (rawError: unknown) {
			// A CAS miss on the state guard (a concurrent lifecycle action advancing
			// the row between the re-read and the write) surfaces as Prisma P2025.
			// Map it to a clean 409 so callers see a conflict, not an opaque 500.
			const error =
				rawError != null &&
				typeof rawError === 'object' &&
				'code' in rawError &&
				(rawError as { code?: string }).code === 'P2025'
					? createHttpError(409, 'Agent registration state changed concurrently; please retry')
					: rawError;
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/registry/update', 'POST', statusCode, errorInstance, {
				network: input.network,
				user_id: ctx.id,
				agent_identifier: input.agentIdentifier,
				operation: 'update_agent',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
