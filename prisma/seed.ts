import {
	ApiKeyStatus,
	HotWalletType,
	Network,
	PaymentSourceType,
	PrismaClient,
	RPCProvider,
} from '../src/generated/prisma/client';
import dotenv from 'dotenv';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { encrypt } from './../src/utils/security/encryption';
import { DEFAULTS } from '@masumi/payment-core/config';
import {
	getPaymentScriptV1,
	getPaymentScriptV2,
	getRegistryScriptV1,
	getRegistryScriptV2,
} from './../src/utils/generator/contract-generator';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { generateApiKeySecureHash } from '@masumi/payment-core/api-key-hash';
import { MeshWallet } from '@meshsdk/core';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import {
	formatMissingEnvError,
	isMissingEnvValue,
	isSeedV1LegacyEnabled,
	printGeneratedMnemonics,
	resolveMnemonic,
	validatePreprodSeedPrerequisites,
	type ResolvedMnemonic,
} from './seed.validation';

dotenv.config();
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function brewMnemonic(): string {
	return (MeshWallet.brew(false) as string[]).join(' ');
}

function resolveV2WalletMnemonic(
	v2Raw: string | undefined,
	v2EnvName: string,
	defaultResolved: ResolvedMnemonic,
): ResolvedMnemonic {
	if (!isMissingEnvValue(v2Raw)) {
		return resolveMnemonic(v2Raw, v2EnvName, brewMnemonic);
	}
	return defaultResolved;
}

/**
 * Read the optional numbered siblings of a wallet mnemonic env var, e.g.
 * `SELLING_WALLET_PREPROD_MNEMONIC_2`, `..._3`, stopping at the first gap.
 *
 * Opt-in on purpose, and never brewed: an extra hot wallet that nobody funded
 * still gets picked by the batch services, so seeding one without a mnemonic
 * would stall real work. Absent env means the source keeps exactly the wallets
 * it had before.
 */
function readExtraMnemonics(baseEnvName: string): string[] {
	const mnemonics: string[] = [];
	for (let index = 2; ; index++) {
		const raw = process.env[`${baseEnvName}_${index}`];
		if (raw == null || raw.trim() === '') break;
		mnemonics.push(raw.trim());
	}
	return mnemonics;
}

async function queryLatestTxHash(blockfrostApiKey: string, smartContractAddress: string, networkLabel: string) {
	const blockfrostApi = new BlockFrostAPI({
		projectId: blockfrostApiKey,
	});

	try {
		const latestTx = await blockfrostApi.addressesTransactions(smartContractAddress, { count: 1, order: 'desc' });
		if (latestTx.length > 0) {
			console.log(
				`Smart contract address exists on ${networkLabel}, syncing after tx: ${latestTx[0]?.tx_hash ?? 'no tx hash'}`,
			);
		}
		return latestTx && latestTx.length > 0 ? latestTx[0].tx_hash : null;
	} catch (error) {
		console.warn(
			`Smart contract address ${networkLabel} has no transactions. This is expected if the contract is not deployed yet, otherwise ensure you are using the correct smart contract address`,
			error,
		);
		return null;
	}
}

export const seed = async (prisma: PrismaClient) => {
	const seedOnlyIfEmpty = process.env.SEED_ONLY_IF_EMPTY;
	const seedV1Legacy = isSeedV1LegacyEnabled(process.env.SEED_V1_LEGACY);

	// Per-type gating: V2 was bolted on after V1 deployments existed in the
	// wild, so a global "any PaymentSource exists" check (the previous
	// behaviour) would prevent V2 from ever being seeded on a database that
	// already has a V1 source. We now decide per paymentSourceType whether to
	// skip, so adding V2 support to an existing V1-only deployment works on
	// re-seed. The env-var override stays as a hard opt-in.
	const shouldSkipV1 =
		seedOnlyIfEmpty?.toLowerCase() === 'true' &&
		(await prisma.paymentSource.count({
			where: { paymentSourceType: PaymentSourceType.Web3CardanoV1 },
		})) > 0;
	const shouldSkipV2 =
		seedOnlyIfEmpty?.toLowerCase() === 'true' &&
		(await prisma.paymentSource.count({
			where: { paymentSourceType: PaymentSourceType.Web3CardanoV2 },
		})) > 0;
	if (shouldSkipV1) {
		console.log('V1 PaymentSource(s) already present, skipping V1 seeding (SEED_ONLY_IF_EMPTY=true)');
	}
	if (shouldSkipV2) {
		console.log('V2 PaymentSource(s) already present, skipping V2 seeding (SEED_ONLY_IF_EMPTY=true)');
	}
	let adminKey = process.env.ADMIN_KEY;
	let usedDefaultAdminKey = false;

	if (!adminKey) {
		adminKey = DEFAULTS.DEFAULT_ADMIN_KEY;
		usedDefaultAdminKey = true;

		console.warn('****************************************************');
		console.warn('**  WARNING: Using DEFAULT ADMIN_KEY for seeding!  **');
		console.warn('**  This is INSECURE. Set ADMIN_KEY in your .env!  **');
		console.warn('****************************************************');
	}
	if (!adminKey || adminKey.length < 15) {
		console.error('ADMIN_KEY is insecure, ensure it is at least 15 characters long');
		throw Error('API-KEY is insecure');
	}

	const adminKeyHash = await generateApiKeySecureHash(adminKey);
	// SECURITY: Refuse to seed the public DEFAULT_ADMIN_KEY when an admin
	// already exists. Without this guard, an operator who provisioned a real
	// ADMIN_KEY, then later ran the seed script without that env var set,
	// would silently add a SECOND admin key (the public default) alongside
	// their real one — creating a public backdoor. The default is intended
	// as a bootstrap convenience for first-time empty deployments only.
	let skipAdminKeyUpsert = false;
	if (usedDefaultAdminKey) {
		const existingAdminCount = await prisma.apiKey.count({
			where: { canAdmin: true, status: ApiKeyStatus.Active },
		});
		if (existingAdminCount > 0) {
			console.warn('****************************************************');
			console.warn('**  REFUSING to seed DEFAULT_ADMIN_KEY — an admin **');
			console.warn('**  key already exists. Set ADMIN_KEY in .env to  **');
			console.warn('**  manage admin credentials explicitly.          **');
			console.warn('****************************************************');
			skipAdminKeyUpsert = true;
		}
	}
	if (!skipAdminKeyUpsert) {
		await prisma.apiKey.upsert({
			create: {
				encryptedToken: encrypt(adminKey),
				tokenHash: adminKeyHash,
				token: '*****' + adminKey.slice(-4),
				// Flag-based permissions (new system)
				canRead: true,
				canPay: true,
				canAdmin: true,
				status: ApiKeyStatus.Active,
				// networkLimit is now a NOT NULL CAIP-2 String[] with no DB default (the
				// x402 migration dropped it). Admin keys store an empty list — auth grants
				// all networks regardless — mirroring addAPIKeyEndpointPost (`isAdmin ? []`).
				// Backwards compatible: the legacy Network[] column also defaulted to empty.
				networkLimit: [],
			},
			update: {
				encryptedToken: encrypt(adminKey),
				token: '*****' + adminKey.slice(-4),
				canRead: true,
				canPay: true,
				canAdmin: true,
				status: ApiKeyStatus.Active,
			},
			where: { tokenHash: adminKeyHash },
		});
		if (usedDefaultAdminKey) {
			console.log('Seeded with DEFAULT_ADMIN_KEY');
		} else {
			console.log('ADMIN_KEY seeded successfully');
		}
	}

	let collectionWalletPreprodAddress: string | null | undefined = process.env.COLLECTION_WALLET_PREPROD_ADDRESS;
	const purchaseWalletPreprodResolved = resolveMnemonic(
		process.env.PURCHASE_WALLET_PREPROD_MNEMONIC,
		'PURCHASE_WALLET_PREPROD_MNEMONIC',
		brewMnemonic,
	);
	const sellingWalletPreprodResolved = resolveMnemonic(
		process.env.SELLING_WALLET_PREPROD_MNEMONIC,
		'SELLING_WALLET_PREPROD_MNEMONIC',
		brewMnemonic,
	);
	const purchaseWalletPreprodMnemonic = purchaseWalletPreprodResolved.mnemonic;
	const sellingWalletPreprodMnemonic = sellingWalletPreprodResolved.mnemonic;
	const purchaseWalletV2PreprodResolved = resolveV2WalletMnemonic(
		process.env.PURCHASE_WALLET_V2_PREPROD_MNEMONIC,
		'PURCHASE_WALLET_V2_PREPROD_MNEMONIC',
		purchaseWalletPreprodResolved,
	);
	const sellingWalletV2PreprodResolved = resolveV2WalletMnemonic(
		process.env.SELLING_WALLET_V2_PREPROD_MNEMONIC,
		'SELLING_WALLET_V2_PREPROD_MNEMONIC',
		sellingWalletPreprodResolved,
	);
	const hasDistinctV2PreprodMnemonics =
		!isMissingEnvValue(process.env.PURCHASE_WALLET_V2_PREPROD_MNEMONIC) &&
		!isMissingEnvValue(process.env.SELLING_WALLET_V2_PREPROD_MNEMONIC);
	if (!collectionWalletPreprodAddress) {
		collectionWalletPreprodAddress = null;
	}
	const collectionWalletV2PreprodAddress =
		process.env.COLLECTION_WALLET_V2_PREPROD_ADDRESS ?? collectionWalletPreprodAddress;

	let collectionWalletMainnetAddress: string | null | undefined = process.env.COLLECTION_WALLET_MAINNET_ADDRESS;
	const purchaseWalletMainnetResolved = resolveMnemonic(
		process.env.PURCHASE_WALLET_MAINNET_MNEMONIC,
		'PURCHASE_WALLET_MAINNET_MNEMONIC',
		brewMnemonic,
	);
	const sellingWalletMainnetResolved = resolveMnemonic(
		process.env.SELLING_WALLET_MAINNET_MNEMONIC,
		'SELLING_WALLET_MAINNET_MNEMONIC',
		brewMnemonic,
	);
	const purchaseWalletMainnetMnemonic = purchaseWalletMainnetResolved.mnemonic;
	const sellingWalletMainnetMnemonic = sellingWalletMainnetResolved.mnemonic;
	const purchaseWalletV2MainnetResolved = resolveV2WalletMnemonic(
		process.env.PURCHASE_WALLET_V2_MAINNET_MNEMONIC,
		'PURCHASE_WALLET_V2_MAINNET_MNEMONIC',
		purchaseWalletMainnetResolved,
	);
	const sellingWalletV2MainnetResolved = resolveV2WalletMnemonic(
		process.env.SELLING_WALLET_V2_MAINNET_MNEMONIC,
		'SELLING_WALLET_V2_MAINNET_MNEMONIC',
		sellingWalletMainnetResolved,
	);
	const hasDistinctV2MainnetMnemonics =
		!isMissingEnvValue(process.env.PURCHASE_WALLET_V2_MAINNET_MNEMONIC) &&
		!isMissingEnvValue(process.env.SELLING_WALLET_V2_MAINNET_MNEMONIC);
	if (!collectionWalletMainnetAddress) {
		collectionWalletMainnetAddress = null;
	}
	const collectionWalletV2MainnetAddress =
		process.env.COLLECTION_WALLET_V2_MAINNET_ADDRESS ?? collectionWalletMainnetAddress;

	const preprodValidation = validatePreprodSeedPrerequisites({
		DATABASE_URL: process.env.DATABASE_URL,
		ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
		BLOCKFROST_API_KEY_PREPROD: process.env.BLOCKFROST_API_KEY_PREPROD,
	});
	if (!preprodValidation.ok) {
		throw new Error(formatMissingEnvError(preprodValidation.missing));
	}

	const blockfrostApiKeyPreprod = process.env.BLOCKFROST_API_KEY_PREPROD!.trim();
	const encryptionKey = process.env.ENCRYPTION_KEY!.trim();

	const adminWallet1AddressPreprod = DEFAULTS.ADMIN_WALLET1_PREPROD;
	const adminWallet2AddressPreprod = DEFAULTS.ADMIN_WALLET2_PREPROD;
	const adminWallet3AddressPreprod = DEFAULTS.ADMIN_WALLET3_PREPROD;

	const feeWalletAddressPreprod = DEFAULTS.FEE_WALLET_PREPROD;
	const feePermillePreprod = DEFAULTS.FEE_PERMILLE_PREPROD;
	const cooldownTimePreprod = DEFAULTS.COOLDOWN_TIME_PREPROD;
	const cooldownTimeMainnet = DEFAULTS.COOLDOWN_TIME_MAINNET;

	// Preprod seed path — DATABASE_URL, ENCRYPTION_KEY, and BLOCKFROST_API_KEY_PREPROD validated above.
	{
		const fee = feePermillePreprod;
		if (fee < 0 || fee > 1000) {
			console.error('Fee permille is not valid, must be between 0 and 1000 (0.0% and 100.0%)');
			throw Error('Fee permille is not valid');
		}

		const { smartContractAddress } = await getPaymentScriptV1(
			adminWallet1AddressPreprod,
			adminWallet2AddressPreprod,
			adminWallet3AddressPreprod,
			feeWalletAddressPreprod,
			fee,
			cooldownTimePreprod,
			Network.Preprod,
		);
		if (smartContractAddress != DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD) {
			throw new Error(
				'Smart contract address is changed expected: ' +
					DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD +
					' got: ' +
					smartContractAddress,
			);
		}
		const latestTxHash = await queryLatestTxHash(blockfrostApiKeyPreprod, smartContractAddress, 'preprod');

		if (shouldSkipV1) {
			console.log('V1 preprod seeding skipped (per-type gating).');
		} else if (!seedV1Legacy) {
			console.log('V1 preprod seeding skipped (Web3CardanoV2 is the default; set SEED_V1_LEGACY=true for legacy V1).');
		} else
			try {
				const purchasingWallet = new MeshWallet({
					networkId: 0,
					key: {
						type: 'mnemonic',
						words: purchaseWalletPreprodMnemonic.split(' '),
					},
				});
				const sellingWallet = new MeshWallet({
					networkId: 0,
					key: {
						type: 'mnemonic',
						words: sellingWalletPreprodMnemonic.split(' '),
					},
				});
				const purchasingWalletSecret = encrypt(purchaseWalletPreprodMnemonic);
				const sellingWalletSecret = encrypt(sellingWalletPreprodMnemonic);

				const { policyId } = await getRegistryScriptV1(smartContractAddress, Network.Preprod);
				if (policyId != DEFAULTS.REGISTRY_POLICY_ID_PREPROD) {
					throw new Error(
						'Registry policyId is changed expected: ' + DEFAULTS.REGISTRY_POLICY_ID_PREPROD + ' got: ' + policyId,
					);
				}
				// Atomic: wallet secrets + the PaymentSource that references them
				// commit together. A crash between the two previously left orphan
				// WalletSecret rows that no PaymentSource pointed at, polluting the
				// secrets table and complicating manual recovery.
				const purchasingUnusedAddress = (await purchasingWallet.getUnusedAddresses())[0];
				const sellingUnusedAddress = (await sellingWallet.getUnusedAddresses())[0];
				// Extra selling wallets, Preprod only. The e2e suite registers one
				// agent per selling wallet so its concurrent flows stop queueing
				// behind a single wallet (V1 processes one request per hot wallet
				// per scheduler tick). Each extra mnemonic must be funded.
				const extraSellingPreprod = await Promise.all(
					readExtraMnemonics('SELLING_WALLET_PREPROD_MNEMONIC').map(async (mnemonic) => {
						const wallet = new MeshWallet({
							networkId: 0,
							key: { type: 'mnemonic', words: mnemonic.split(' ') },
						});
						return {
							address: (await wallet.getUnusedAddresses())[0],
							encryptedMnemonic: encrypt(mnemonic),
						};
					}),
				);
				if (extraSellingPreprod.length > 0) {
					console.log(`Seeding ${extraSellingPreprod.length} extra Preprod selling wallet(s) from env.`);
				}
				await prisma.$transaction(async (tx) => {
					const purchasingWalletSecretId = await tx.walletSecret.create({
						data: { encryptedMnemonic: purchasingWalletSecret },
					});
					const sellingWalletSecretId = await tx.walletSecret.create({
						data: { encryptedMnemonic: sellingWalletSecret },
					});
					const extraSellingWallets = [];
					for (const extra of extraSellingPreprod) {
						const secret = await tx.walletSecret.create({
							data: { encryptedMnemonic: extra.encryptedMnemonic },
						});
						extraSellingWallets.push({
							walletVkey: resolvePaymentKeyHash(extra.address),
							walletAddress: extra.address,
							note: 'Created by seeding (extra selling wallet)',
							type: HotWalletType.Selling,
							secretId: secret.id,
							collectionAddress: collectionWalletPreprodAddress,
						});
					}
					await tx.paymentSource.create({
						data: {
							smartContractAddress: smartContractAddress,
							policyId: policyId,
							network: Network.Preprod,
							PaymentSourceConfig: {
								create: {
									rpcProviderApiKey: blockfrostApiKeyPreprod,
									rpcProvider: RPCProvider.Blockfrost,
								},
							},
							syncInProgress: false,
							lastIdentifierChecked: latestTxHash,
							FeeReceiverNetworkWallet: {
								create: {
									walletAddress: feeWalletAddressPreprod,
									order: 1,
								},
							},
							feeRatePermille: fee,
							AdminWallets: {
								create: [
									{ walletAddress: adminWallet1AddressPreprod, order: 1 },
									{ walletAddress: adminWallet2AddressPreprod, order: 2 },
									{ walletAddress: adminWallet3AddressPreprod, order: 3 },
								],
							},
							HotWallets: {
								createMany: {
									data: [
										{
											walletVkey: resolvePaymentKeyHash(purchasingUnusedAddress),
											walletAddress: purchasingUnusedAddress,
											note: 'Created by seeding',
											type: HotWalletType.Purchasing,
											secretId: purchasingWalletSecretId.id,
										},
										{
											walletVkey: resolvePaymentKeyHash(sellingUnusedAddress),
											walletAddress: sellingUnusedAddress,
											note: 'Created by seeding',
											type: HotWalletType.Selling,
											secretId: sellingWalletSecretId.id,
											collectionAddress: collectionWalletPreprodAddress,
										},
										...extraSellingWallets,
									],
								},
							},
							cooldownTime: cooldownTimePreprod,
						},
					});
				});

				console.log('Contract seeded on preprod: ' + smartContractAddress + ' added. Registry policyId: ' + policyId);
				printGeneratedMnemonics([purchaseWalletPreprodResolved, sellingWalletPreprodResolved]);
			} catch (error) {
				console.error(
					'Error when seeding preprod, ensure you succeed with seeding, the following error occurred: ',
					error,
				);
				throw error;
			}

		// V2 is the default payment source for new installations. When
		// SEED_V1_LEGACY=true, V2 requires distinct PURCHASE/SELLING_WALLET_V2_*
		// mnemonics so HotWallet vkeys do not collide with the V1 source.
		if (shouldSkipV2) {
			console.log('V2 preprod seeding skipped (per-type gating).');
		} else if (seedV1Legacy && !hasDistinctV2PreprodMnemonics) {
			console.log(
				'V2 preprod seeding skipped in legacy mode: set PURCHASE_WALLET_V2_PREPROD_MNEMONIC and ' +
					'SELLING_WALLET_V2_PREPROD_MNEMONIC (distinct from V1 mnemonics) to seed both types.',
			);
		} else
			try {
				const purchaseWalletV2PreprodMnemonic = purchaseWalletV2PreprodResolved.mnemonic;
				const sellingWalletV2PreprodMnemonic = sellingWalletV2PreprodResolved.mnemonic;
				const purchasingWallet = new MeshWallet({
					networkId: 0,
					key: {
						type: 'mnemonic',
						words: purchaseWalletV2PreprodMnemonic.split(' '),
					},
				});
				const sellingWallet = new MeshWallet({
					networkId: 0,
					key: {
						type: 'mnemonic',
						words: sellingWalletV2PreprodMnemonic.split(' '),
					},
				});
				const { smartContractAddress } = await getPaymentScriptV2(
					[adminWallet1AddressPreprod, adminWallet2AddressPreprod, adminWallet3AddressPreprod],
					DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2,
					cooldownTimePreprod,
					Network.Preprod,
				);
				if (smartContractAddress != DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD) {
					throw new Error(
						'V2 smart contract address is changed expected: ' +
							DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD +
							' got: ' +
							smartContractAddress,
					);
				}
				const latestTxHash = await queryLatestTxHash(blockfrostApiKeyPreprod, smartContractAddress, 'preprod V2');
				const { policyId } = await getRegistryScriptV2(Network.Preprod);
				if (policyId != DEFAULTS.REGISTRY_POLICY_ID_V2_PREPROD) {
					throw new Error(
						'V2 registry policyId is changed expected: ' + DEFAULTS.REGISTRY_POLICY_ID_V2_PREPROD + ' got: ' + policyId,
					);
				}
				const purchasingUnusedAddress = (await purchasingWallet.getUnusedAddresses())[0];
				const sellingUnusedAddress = (await sellingWallet.getUnusedAddresses())[0];

				// Atomic: V2 wallet secrets + V2 PaymentSource together. Without
				// this the previous failure mode was orphan WalletSecret rows when
				// the subsequent paymentSource.create failed (e.g. unique conflict
				// with an already-deployed V2 contract), polluting the secrets
				// table and confusing later re-runs.
				await prisma.$transaction(async (tx) => {
					const purchasingWalletSecretId = await tx.walletSecret.create({
						data: { encryptedMnemonic: encrypt(purchaseWalletV2PreprodMnemonic) },
					});
					const sellingWalletSecretId = await tx.walletSecret.create({
						data: { encryptedMnemonic: encrypt(sellingWalletV2PreprodMnemonic) },
					});
					await tx.paymentSource.create({
						data: {
							smartContractAddress,
							policyId,
							network: Network.Preprod,
							paymentSourceType: PaymentSourceType.Web3CardanoV2,
							requiredAdminSignatures: DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2,
							PaymentSourceConfig: {
								create: {
									rpcProviderApiKey: blockfrostApiKeyPreprod,
									rpcProvider: RPCProvider.Blockfrost,
								},
							},
							syncInProgress: false,
							lastIdentifierChecked: latestTxHash,
							feeRatePermille: 0,
							AdminWallets: {
								create: [
									{ walletAddress: adminWallet1AddressPreprod, order: 1 },
									{ walletAddress: adminWallet2AddressPreprod, order: 2 },
									{ walletAddress: adminWallet3AddressPreprod, order: 3 },
								],
							},
							HotWallets: {
								createMany: {
									data: [
										{
											walletVkey: resolvePaymentKeyHash(purchasingUnusedAddress),
											walletAddress: purchasingUnusedAddress,
											note: 'Created by V2 seeding',
											type: HotWalletType.Purchasing,
											secretId: purchasingWalletSecretId.id,
											collectionAddress: collectionWalletV2PreprodAddress,
										},
										{
											walletVkey: resolvePaymentKeyHash(sellingUnusedAddress),
											walletAddress: sellingUnusedAddress,
											note: 'Created by V2 seeding',
											type: HotWalletType.Selling,
											secretId: sellingWalletSecretId.id,
											collectionAddress: collectionWalletV2PreprodAddress,
										},
									],
								},
							},
							cooldownTime: cooldownTimePreprod,
						},
					});
				});

				console.log(
					'V2 contract seeded on preprod: ' + smartContractAddress + ' added. Registry policyId: ' + policyId,
				);
				printGeneratedMnemonics([purchaseWalletV2PreprodResolved, sellingWalletV2PreprodResolved]);

				// Hydra heads are not seeded — see docs/hydra-operations.md.
			} catch (error) {
				console.error(
					'Error when seeding preprod V2, ensure you succeed with seeding, the following error occurred: ',
					error,
				);
				// Re-throw so that CI / automated environments fail loudly instead of
				// silently continuing with an incomplete payment source set. The V2
				// e2e suite expects a V2 PaymentSource to exist after seeding; without
				// it, globalSetup aborts with an opaque "No active Web3CardanoV2
				// PaymentSource" error that hides this root-cause stack.
				throw error;
			}
	}

	const blockfrostApiKeyMainnet = process.env.BLOCKFROST_API_KEY_MAINNET;
	const adminWallet1AddressMainnet = DEFAULTS.ADMIN_WALLET1_MAINNET;
	const adminWallet2AddressMainnet = DEFAULTS.ADMIN_WALLET2_MAINNET;
	const adminWallet3AddressMainnet = DEFAULTS.ADMIN_WALLET3_MAINNET;

	const feeWalletAddressMainnet = DEFAULTS.FEE_WALLET_MAINNET;
	const feePermilleMainnet = DEFAULTS.FEE_PERMILLE_MAINNET;

	if (encryptionKey != null && blockfrostApiKeyMainnet != null && blockfrostApiKeyMainnet != '') {
		const fee = feePermilleMainnet;
		if (fee < 0 || fee > 1000) {
			console.error('Fee permille is not valid, must be between 0 and 1000 (0.0% and 100.0%)');
			throw Error('Fee permille is not valid');
		}

		const { smartContractAddress } = await getPaymentScriptV1(
			adminWallet1AddressMainnet,
			adminWallet2AddressMainnet,
			adminWallet3AddressMainnet,
			feeWalletAddressMainnet,
			fee,
			cooldownTimeMainnet,
			Network.Mainnet,
		);
		if (smartContractAddress != DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET) {
			throw new Error(
				'Smart contract address is changed expected: ' +
					DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET +
					' got: ' +
					smartContractAddress,
			);
		}
		const latestTxHash = await queryLatestTxHash(blockfrostApiKeyMainnet, smartContractAddress, 'mainnet');
		if (shouldSkipV1) {
			console.log('V1 mainnet seeding skipped (per-type gating).');
		} else if (!seedV1Legacy) {
			console.log('V1 mainnet seeding skipped (Web3CardanoV2 is the default; set SEED_V1_LEGACY=true for legacy V1).');
		} else
			try {
				const purchasingWallet = new MeshWallet({
					networkId: 1,
					key: {
						type: 'mnemonic',
						words: purchaseWalletMainnetMnemonic.split(' '),
					},
				});
				const sellingWallet = new MeshWallet({
					networkId: 1,
					key: {
						type: 'mnemonic',
						words: sellingWalletMainnetMnemonic.split(' '),
					},
				});
				const purchasingWalletSecret = encrypt(purchaseWalletMainnetMnemonic);
				const sellingWalletSecret = encrypt(sellingWalletMainnetMnemonic);
				const { policyId } = await getRegistryScriptV1(smartContractAddress, Network.Mainnet);
				if (policyId != DEFAULTS.REGISTRY_POLICY_ID_MAINNET) {
					throw new Error(
						'Registry policyId is changed expected: ' + DEFAULTS.REGISTRY_POLICY_ID_MAINNET + ' got: ' + policyId,
					);
				}
				// Atomic: wallet secrets + the PaymentSource that references them
				// commit together. See V1 preprod block for rationale.
				const purchasingUnusedAddress = (await purchasingWallet.getUnusedAddresses())[0];
				const sellingUnusedAddress = (await sellingWallet.getUnusedAddresses())[0];
				await prisma.$transaction(async (tx) => {
					const purchasingWalletSecretId = await tx.walletSecret.create({
						data: { encryptedMnemonic: purchasingWalletSecret },
					});
					const sellingWalletSecretId = await tx.walletSecret.create({
						data: { encryptedMnemonic: sellingWalletSecret },
					});
					await tx.paymentSource.create({
						data: {
							smartContractAddress: smartContractAddress,
							policyId: policyId,
							lastIdentifierChecked: latestTxHash,
							network: Network.Mainnet,
							PaymentSourceConfig: {
								create: {
									rpcProviderApiKey: blockfrostApiKeyMainnet,
									rpcProvider: RPCProvider.Blockfrost,
								},
							},
							syncInProgress: false,
							FeeReceiverNetworkWallet: {
								create: {
									walletAddress: feeWalletAddressMainnet,
									order: 1,
								},
							},
							feeRatePermille: fee,
							AdminWallets: {
								create: [
									{ walletAddress: adminWallet1AddressMainnet, order: 1 },
									{ walletAddress: adminWallet2AddressMainnet, order: 2 },
									{ walletAddress: adminWallet3AddressMainnet, order: 3 },
								],
							},
							HotWallets: {
								createMany: {
									data: [
										{
											walletVkey: resolvePaymentKeyHash(purchasingUnusedAddress),
											walletAddress: purchasingUnusedAddress,
											note: 'Created by seeding',
											type: HotWalletType.Purchasing,
											secretId: purchasingWalletSecretId.id,
										},
										{
											walletVkey: resolvePaymentKeyHash(sellingUnusedAddress),
											walletAddress: sellingUnusedAddress,
											note: 'Created by seeding',
											type: HotWalletType.Selling,
											secretId: sellingWalletSecretId.id,
											collectionAddress: collectionWalletMainnetAddress,
										},
									],
								},
							},
							cooldownTime: cooldownTimeMainnet,
						},
					});
				});

				console.log('Contract seeded on mainnet: ' + smartContractAddress + ' added. Registry policyId: ' + policyId);
				printGeneratedMnemonics([purchaseWalletMainnetResolved, sellingWalletMainnetResolved]);
			} catch (error) {
				console.error(
					'Error when seeding mainnet, ensure you succeed with seeding, the following error occurred: ',
					error,
				);
				throw error;
			}

		if (shouldSkipV2) {
			console.log('V2 mainnet seeding skipped (per-type gating).');
		} else if (seedV1Legacy && !hasDistinctV2MainnetMnemonics) {
			console.log(
				'V2 mainnet seeding skipped in legacy mode: set PURCHASE_WALLET_V2_MAINNET_MNEMONIC and ' +
					'SELLING_WALLET_V2_MAINNET_MNEMONIC (distinct from V1 mnemonics) to seed both types.',
			);
		} else
			try {
				const purchaseWalletV2MainnetMnemonic = purchaseWalletV2MainnetResolved.mnemonic;
				const sellingWalletV2MainnetMnemonic = sellingWalletV2MainnetResolved.mnemonic;
				const purchasingWallet = new MeshWallet({
					networkId: 1,
					key: {
						type: 'mnemonic',
						words: purchaseWalletV2MainnetMnemonic.split(' '),
					},
				});
				const sellingWallet = new MeshWallet({
					networkId: 1,
					key: {
						type: 'mnemonic',
						words: sellingWalletV2MainnetMnemonic.split(' '),
					},
				});
				const { smartContractAddress } = await getPaymentScriptV2(
					[adminWallet1AddressMainnet, adminWallet2AddressMainnet, adminWallet3AddressMainnet],
					DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2,
					cooldownTimeMainnet,
					Network.Mainnet,
				);
				if (smartContractAddress != DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_MAINNET) {
					throw new Error(
						'V2 smart contract address is changed expected: ' +
							DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_MAINNET +
							' got: ' +
							smartContractAddress,
					);
				}
				const latestTxHash = await queryLatestTxHash(blockfrostApiKeyMainnet, smartContractAddress, 'mainnet V2');
				const { policyId } = await getRegistryScriptV2(Network.Mainnet);
				if (policyId != DEFAULTS.REGISTRY_POLICY_ID_V2_MAINNET) {
					throw new Error(
						'V2 registry policyId is changed expected: ' + DEFAULTS.REGISTRY_POLICY_ID_V2_MAINNET + ' got: ' + policyId,
					);
				}
				const purchasingUnusedAddress = (await purchasingWallet.getUnusedAddresses())[0];
				const sellingUnusedAddress = (await sellingWallet.getUnusedAddresses())[0];

				// Atomic: V2 wallet secrets + V2 PaymentSource together. See V2
				// preprod block for rationale.
				await prisma.$transaction(async (tx) => {
					const purchasingWalletSecretId = await tx.walletSecret.create({
						data: { encryptedMnemonic: encrypt(purchaseWalletV2MainnetMnemonic) },
					});
					const sellingWalletSecretId = await tx.walletSecret.create({
						data: { encryptedMnemonic: encrypt(sellingWalletV2MainnetMnemonic) },
					});
					await tx.paymentSource.create({
						data: {
							smartContractAddress,
							policyId,
							network: Network.Mainnet,
							paymentSourceType: PaymentSourceType.Web3CardanoV2,
							requiredAdminSignatures: DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2,
							PaymentSourceConfig: {
								create: {
									rpcProviderApiKey: blockfrostApiKeyMainnet,
									rpcProvider: RPCProvider.Blockfrost,
								},
							},
							syncInProgress: false,
							lastIdentifierChecked: latestTxHash,
							feeRatePermille: 0,
							AdminWallets: {
								create: [
									{ walletAddress: adminWallet1AddressMainnet, order: 1 },
									{ walletAddress: adminWallet2AddressMainnet, order: 2 },
									{ walletAddress: adminWallet3AddressMainnet, order: 3 },
								],
							},
							HotWallets: {
								createMany: {
									data: [
										{
											walletVkey: resolvePaymentKeyHash(purchasingUnusedAddress),
											walletAddress: purchasingUnusedAddress,
											note: 'Created by V2 seeding',
											type: HotWalletType.Purchasing,
											secretId: purchasingWalletSecretId.id,
											collectionAddress: collectionWalletV2MainnetAddress,
										},
										{
											walletVkey: resolvePaymentKeyHash(sellingUnusedAddress),
											walletAddress: sellingUnusedAddress,
											note: 'Created by V2 seeding',
											type: HotWalletType.Selling,
											secretId: sellingWalletSecretId.id,
											collectionAddress: collectionWalletV2MainnetAddress,
										},
									],
								},
							},
							cooldownTime: cooldownTimeMainnet,
						},
					});
				});

				console.log(
					'V2 contract seeded on mainnet: ' + smartContractAddress + ' added. Registry policyId: ' + policyId,
				);
				printGeneratedMnemonics([purchaseWalletV2MainnetResolved, sellingWalletV2MainnetResolved]);
			} catch (error) {
				console.error(
					'Error when seeding mainnet V2, ensure you succeed with seeding, the following error occurred: ',
					error,
				);
				// Re-throw so prod/CI deployments fail loudly. Silent failure here
				// leaves the mainnet V2 PaymentSource missing without any visible
				// signal until the first V2 mainnet request silently 404s.
				throw error;
			}
	} else {
		console.log(
			'Smart contract mainnet to monitor is not seeded. Provide ENCRYPTION_KEY and BLOCKFROST_API_KEY_MAINNET in .env',
		);
	}
};
seed(prisma)
	.then(() => {
		prisma.$disconnect();
		pool.end();
		console.log('Seed completed');
	})
	.catch((e) => {
		prisma.$disconnect();
		pool.end();
		console.error(e);
		// Exit non-zero so `prisma db seed` reports failure to the caller
		// (e.g. CI). Without this the script swallowed errors and CI continued
		// with an incomplete payment-source set, surfacing only later as an
		// opaque "No active Web3CardanoV2 PaymentSource" abort in globalSetup.
		process.exit(1);
	});
