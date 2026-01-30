import { ApiKeyStatus, HotWalletType, Network, PrismaClient, RPCProvider } from '../src/generated/prisma/client';
import dotenv from 'dotenv';
import {
	resolvePaymentKeyHash,
	resolvePlutusScriptAddress,
	resolveStakeKeyHash,
	applyParamsToScript,
} from '@meshsdk/core-cst';
import { encrypt } from './../src/utils/security/encryption';
import { DEFAULTS } from './../src/utils/config';
import { getRegistryScriptV1 } from './../src/utils/generator/contract-generator';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import paymentPlutus from '../smart-contracts/payment/plutus.json';
import { generateSHA256Hash } from '../src/utils/crypto';
import { MeshWallet, PlutusScript } from '@meshsdk/core';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config();
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
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

	await prisma.apiKey.upsert({
		create: {
			token: adminKey,
			tokenHash: generateSHA256Hash(adminKey),
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Active,
		},
		update: {
			token: adminKey,
			tokenHash: generateSHA256Hash(adminKey),
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Active,
		},
		where: { token: adminKey },
	});
	if (usedDefaultAdminKey) {
		console.log('Seeded with DEFAULT_ADMIN_KEY');
	} else {
		console.log('ADMIN_KEY seeded successfully');
	}

	let collectionWalletPreprodAddress: string | null | undefined = process.env.COLLECTION_WALLET_PREPROD_ADDRESS;
	let purchaseWalletPreprodMnemonic = process.env.PURCHASE_WALLET_PREPROD_MNEMONIC;
	if (!purchaseWalletPreprodMnemonic) {
		const secret_key = MeshWallet.brew(false) as string[];
		purchaseWalletPreprodMnemonic = secret_key.join(' ');
	}
	let sellingWalletPreprodMnemonic = process.env.SELLING_WALLET_PREPROD_MNEMONIC;
	if (!sellingWalletPreprodMnemonic) {
		const secret_key = MeshWallet.brew(false) as string[];
		sellingWalletPreprodMnemonic = secret_key.join(' ');
	}
	if (!collectionWalletPreprodAddress) {
		collectionWalletPreprodAddress = null;
	}

	let collectionWalletMainnetAddress: string | null | undefined = process.env.COLLECTION_WALLET_MAINNET_ADDRESS;
	let purchaseWalletMainnetMnemonic = process.env.PURCHASE_WALLET_MAINNET_MNEMONIC;
	if (!purchaseWalletMainnetMnemonic) {
		const secret_key = MeshWallet.brew(false) as string[];
		purchaseWalletMainnetMnemonic = secret_key.join(' ');
	}
	let sellingWalletMainnetMnemonic = process.env.SELLING_WALLET_MAINNET_MNEMONIC;
	if (!sellingWalletMainnetMnemonic) {
		const secret_key = MeshWallet.brew(false) as string[];
		sellingWalletMainnetMnemonic = secret_key.join(' ');
	}
	if (!collectionWalletMainnetAddress) {
		collectionWalletMainnetAddress = null;
	}

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

		const script = {
			code: applyParamsToScript(paymentPlutus.validators[0].compiledCode, [
				2,
				[
					resolvePaymentKeyHash(adminWallet1AddressPreprod),
					resolvePaymentKeyHash(adminWallet2AddressPreprod),
					resolvePaymentKeyHash(adminWallet3AddressPreprod),
				],
				{
					alternative: 0,
					fields: [
						{
							alternative: 0,
							fields: [resolvePaymentKeyHash(feeWalletAddressPreprod)],
						},
						{
							alternative: 0,
							fields: [
								{
									alternative: 0,
									fields: [
										{
											alternative: 0,
											fields: [resolveStakeKeyHash(feeWalletAddressPreprod)],
										},
									],
								},
							],
						},
					],
				},
				fee,
				cooldownTimePreprod,
			]),
			version: 'V3',
		};
		const smartContractAddress = resolvePlutusScriptAddress(script as PlutusScript, 0);
		if (smartContractAddress != DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD) {
			throw new Error(
				'Smart contract address is changed expected: ' +
					DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD +
					' got: ' +
					smartContractAddress,
			);
		}
		const blockfrostApi = new BlockFrostAPI({
			projectId: blockfrostApiKeyPreprod,
		});

		let latestTx: { tx_hash: string }[] | null = null;
		try {
			latestTx = await blockfrostApi.addressesTransactions(smartContractAddress, {
				count: 1,
				order: 'desc',
			});
			if (latestTx.length > 0) {
				console.log(
					'Smart contract address exists on preprod, syncing after tx: ' + (latestTx[0]?.tx_hash ?? 'no tx hash'),
				);
			}
		} catch (error) {
			console.warn(
				'Smart contract address preprod has no transactions. This is expected if the contract is not deployed yet, otherwise ensure you are using the correct smart contract address',
				error,
			);
		}

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
					lastIdentifierChecked: latestTx && latestTx.length > 0 ? latestTx[0].tx_hash : null,
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

		const script: PlutusScript = {
			code: applyParamsToScript(paymentPlutus.validators[0].compiledCode, [
				2,
				[
					resolvePaymentKeyHash(adminWallet1AddressMainnet),
					resolvePaymentKeyHash(adminWallet2AddressMainnet),
					resolvePaymentKeyHash(adminWallet3AddressMainnet),
				],
				{
					alternative: 0,
					fields: [
						{
							alternative: 0,
							fields: [resolvePaymentKeyHash(feeWalletAddressMainnet)],
						},
						{
							alternative: 0,
							fields: [
								{
									alternative: 0,
									fields: [
										{
											alternative: 0,
											fields: [resolveStakeKeyHash(feeWalletAddressMainnet)],
										},
									],
								},
							],
						},
					],
				},
				fee,
				cooldownTimeMainnet,
			]),
			version: 'V3',
		};

		const smartContractAddress = resolvePlutusScriptAddress(script, 1);
		if (smartContractAddress != DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET) {
			throw new Error(
				'Smart contract address is changed expected: ' +
					DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET +
					' got: ' +
					smartContractAddress,
			);
		}
		const blockfrostApi = new BlockFrostAPI({
			projectId: blockfrostApiKeyMainnet,
		});
		let latestTx: { tx_hash: string }[] | null = null;
		try {
			latestTx = await blockfrostApi.addressesTransactions(smartContractAddress, {
				count: 1,
				order: 'desc',
			});
			if (latestTx.length > 0) {
				console.log(
					'Smart contract address exists on mainnet, syncing after tx: ' + (latestTx[0]?.tx_hash ?? 'no tx hash'),
				);
			}
		} catch (error) {
			console.warn('Smart contract address mainnet has no transactions. ', error);
		}
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
					lastIdentifierChecked: latestTx && latestTx.length > 0 ? latestTx[0].tx_hash : null,
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
