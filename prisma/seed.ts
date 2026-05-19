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
import { DEFAULTS } from './../src/utils/config';
import {
	getPaymentScriptV1,
	getPaymentScriptV2,
	getRegistryScriptV1,
	getRegistryScriptV2,
} from './../src/utils/generator/contract-generator';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { generateApiKeySecureHash } from '../src/utils/crypto/api-key-hash';
import { MeshWallet } from '@meshsdk/core';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config();
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function createMnemonicIfMissing(mnemonic: string | undefined) {
	return mnemonic ?? (MeshWallet.brew(false) as string[]).join(' ');
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

	if (seedOnlyIfEmpty?.toLowerCase() === 'true') {
		const adminKey = await prisma.apiKey.findFirst({});
		if (adminKey) {
			console.log('Already seeded, skipping');
			return;
		}
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

	let collectionWalletPreprodAddress: string | null | undefined = process.env.COLLECTION_WALLET_PREPROD_ADDRESS;
	const purchaseWalletPreprodMnemonic = createMnemonicIfMissing(process.env.PURCHASE_WALLET_PREPROD_MNEMONIC);
	const sellingWalletPreprodMnemonic = createMnemonicIfMissing(process.env.SELLING_WALLET_PREPROD_MNEMONIC);
	const purchaseWalletV2PreprodMnemonic = createMnemonicIfMissing(process.env.PURCHASE_WALLET_V2_PREPROD_MNEMONIC);
	const sellingWalletV2PreprodMnemonic = createMnemonicIfMissing(process.env.SELLING_WALLET_V2_PREPROD_MNEMONIC);
	if (!collectionWalletPreprodAddress) {
		collectionWalletPreprodAddress = null;
	}
	const collectionWalletV2PreprodAddress =
		process.env.COLLECTION_WALLET_V2_PREPROD_ADDRESS ?? collectionWalletPreprodAddress;

	let collectionWalletMainnetAddress: string | null | undefined = process.env.COLLECTION_WALLET_MAINNET_ADDRESS;
	const purchaseWalletMainnetMnemonic = createMnemonicIfMissing(process.env.PURCHASE_WALLET_MAINNET_MNEMONIC);
	const sellingWalletMainnetMnemonic = createMnemonicIfMissing(process.env.SELLING_WALLET_MAINNET_MNEMONIC);
	const purchaseWalletV2MainnetMnemonic = createMnemonicIfMissing(process.env.PURCHASE_WALLET_V2_MAINNET_MNEMONIC);
	const sellingWalletV2MainnetMnemonic = createMnemonicIfMissing(process.env.SELLING_WALLET_V2_MAINNET_MNEMONIC);
	if (!collectionWalletMainnetAddress) {
		collectionWalletMainnetAddress = null;
	}
	const collectionWalletV2MainnetAddress =
		process.env.COLLECTION_WALLET_V2_MAINNET_ADDRESS ?? collectionWalletMainnetAddress;

	const blockfrostApiKeyPreprod = process.env.BLOCKFROST_API_KEY_PREPROD;

	const encryptionKey = process.env.ENCRYPTION_KEY;

	const adminWallet1AddressPreprod = DEFAULTS.ADMIN_WALLET1_PREPROD;
	const adminWallet2AddressPreprod = DEFAULTS.ADMIN_WALLET2_PREPROD;
	const adminWallet3AddressPreprod = DEFAULTS.ADMIN_WALLET3_PREPROD;

	const feeWalletAddressPreprod = DEFAULTS.FEE_WALLET_PREPROD;
	const feePermillePreprod = DEFAULTS.FEE_PERMILLE_PREPROD;
	const cooldownTimePreprod = DEFAULTS.COOLDOWN_TIME_PREPROD;
	const cooldownTimeMainnet = DEFAULTS.COOLDOWN_TIME_MAINNET;

	if (encryptionKey != null && blockfrostApiKeyPreprod != null && blockfrostApiKeyPreprod != '') {
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
			const purchasingWalletSecretId = await prisma.walletSecret.create({
				data: { encryptedMnemonic: purchasingWalletSecret },
			});
			const sellingWalletSecretId = await prisma.walletSecret.create({
				data: { encryptedMnemonic: sellingWalletSecret },
			});

			const { policyId } = await getRegistryScriptV1(smartContractAddress, Network.Preprod);
			if (policyId != DEFAULTS.REGISTRY_POLICY_ID_PREPROD) {
				throw new Error(
					'Registry policyId is changed expected: ' + DEFAULTS.REGISTRY_POLICY_ID_PREPROD + ' got: ' + policyId,
				);
			}
			await prisma.paymentSource.create({
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
									walletVkey: resolvePaymentKeyHash((await purchasingWallet.getUnusedAddresses())[0]),
									walletAddress: (await purchasingWallet.getUnusedAddresses())[0],
									note: 'Created by seeding',
									type: HotWalletType.Purchasing,
									secretId: purchasingWalletSecretId.id,
								},
								{
									walletVkey: resolvePaymentKeyHash((await sellingWallet.getUnusedAddresses())[0]),
									walletAddress: (await sellingWallet.getUnusedAddresses())[0],
									note: 'Created by seeding',
									type: HotWalletType.Selling,
									secretId: sellingWalletSecretId.id,
									collectionAddress: collectionWalletPreprodAddress,
								},
							],
						},
					},
					cooldownTime: cooldownTimePreprod,
				},
			});

			console.log('Contract seeded on preprod: ' + smartContractAddress + ' added. Registry policyId: ' + policyId);
		} catch (error) {
			console.error(
				'Error when seeding preprod, ensure you succeed with seeding, the following error occurred: ',
				error,
			);
		}

		try {
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
			const purchasingWalletSecretId = await prisma.walletSecret.create({
				data: { encryptedMnemonic: encrypt(purchaseWalletV2PreprodMnemonic) },
			});
			const sellingWalletSecretId = await prisma.walletSecret.create({
				data: { encryptedMnemonic: encrypt(sellingWalletV2PreprodMnemonic) },
			});
			const { smartContractAddress } = await getPaymentScriptV2(
				[adminWallet1AddressPreprod, adminWallet2AddressPreprod, adminWallet3AddressPreprod],
				DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2,
				cooldownTimePreprod,
				Network.Preprod,
			);
			const latestTxHash = await queryLatestTxHash(blockfrostApiKeyPreprod, smartContractAddress, 'preprod V2');
			const { policyId } = await getRegistryScriptV2(Network.Preprod);

			await prisma.paymentSource.create({
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
									walletVkey: resolvePaymentKeyHash((await purchasingWallet.getUnusedAddresses())[0]),
									walletAddress: (await purchasingWallet.getUnusedAddresses())[0],
									note: 'Created by V2 seeding',
									type: HotWalletType.Purchasing,
									secretId: purchasingWalletSecretId.id,
									collectionAddress: collectionWalletV2PreprodAddress,
								},
								{
									walletVkey: resolvePaymentKeyHash((await sellingWallet.getUnusedAddresses())[0]),
									walletAddress: (await sellingWallet.getUnusedAddresses())[0],
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

			console.log('V2 contract seeded on preprod: ' + smartContractAddress + ' added. Registry policyId: ' + policyId);
		} catch (error) {
			console.error(
				'Error when seeding preprod V2, ensure you succeed with seeding, the following error occurred: ',
				error,
			);
		}
	} else {
		console.log(
			'Smart contract preprod to monitor is not seeded. Provide ENCRYPTION_KEY and BLOCKFROST_API_KEY_PREPROD in .env',
		);
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
			const purchasingWalletSecretId = await prisma.walletSecret.create({
				data: { encryptedMnemonic: purchasingWalletSecret },
			});
			const sellingWalletSecretId = await prisma.walletSecret.create({
				data: { encryptedMnemonic: sellingWalletSecret },
			});
			const { policyId } = await getRegistryScriptV1(smartContractAddress, Network.Mainnet);
			if (policyId != DEFAULTS.REGISTRY_POLICY_ID_MAINNET) {
				throw new Error(
					'Registry policyId is changed expected: ' + DEFAULTS.REGISTRY_POLICY_ID_MAINNET + ' got: ' + policyId,
				);
			}
			await prisma.paymentSource.create({
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
									walletVkey: resolvePaymentKeyHash((await purchasingWallet.getUnusedAddresses())[0]),
									walletAddress: (await purchasingWallet.getUnusedAddresses())[0],
									note: 'Created by seeding',
									type: HotWalletType.Purchasing,
									secretId: purchasingWalletSecretId.id,
								},
								{
									walletVkey: resolvePaymentKeyHash((await sellingWallet.getUnusedAddresses())[0]),
									walletAddress: (await sellingWallet.getUnusedAddresses())[0],
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

			console.log('Contract seeded on mainnet: ' + smartContractAddress + ' added. Registry policyId: ' + policyId);
		} catch (error) {
			console.error(
				'Error when seeding mainnet, ensure you succeed with seeding, the following error occurred: ',
				error,
			);
		}

		try {
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
			const purchasingWalletSecretId = await prisma.walletSecret.create({
				data: { encryptedMnemonic: encrypt(purchaseWalletV2MainnetMnemonic) },
			});
			const sellingWalletSecretId = await prisma.walletSecret.create({
				data: { encryptedMnemonic: encrypt(sellingWalletV2MainnetMnemonic) },
			});
			const { smartContractAddress } = await getPaymentScriptV2(
				[adminWallet1AddressMainnet, adminWallet2AddressMainnet, adminWallet3AddressMainnet],
				DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2,
				cooldownTimeMainnet,
				Network.Mainnet,
			);
			const latestTxHash = await queryLatestTxHash(blockfrostApiKeyMainnet, smartContractAddress, 'mainnet V2');
			const { policyId } = await getRegistryScriptV2(Network.Mainnet);

			await prisma.paymentSource.create({
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
									walletVkey: resolvePaymentKeyHash((await purchasingWallet.getUnusedAddresses())[0]),
									walletAddress: (await purchasingWallet.getUnusedAddresses())[0],
									note: 'Created by V2 seeding',
									type: HotWalletType.Purchasing,
									secretId: purchasingWalletSecretId.id,
									collectionAddress: collectionWalletV2MainnetAddress,
								},
								{
									walletVkey: resolvePaymentKeyHash((await sellingWallet.getUnusedAddresses())[0]),
									walletAddress: (await sellingWallet.getUnusedAddresses())[0],
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

			console.log('V2 contract seeded on mainnet: ' + smartContractAddress + ' added. Registry policyId: ' + policyId);
		} catch (error) {
			console.error(
				'Error when seeding mainnet V2, ensure you succeed with seeding, the following error occurred: ',
				error,
			);
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
	});
