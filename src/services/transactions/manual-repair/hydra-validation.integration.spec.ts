import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import {
	AssetName,
	Assets,
	BigInt as CInt,
	BigNum,
	ConstrPlutusData,
	Credential,
	Ed25519KeyHashes,
	EnterpriseAddress,
	FixedTransaction,
	make_vkey_witness,
	MultiAsset,
	PlutusData,
	PlutusList,
	PrivateKey,
	ScriptHash,
	Transaction,
	TransactionBody,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
	Vkeywitnesses,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { deserializeDatum, SLOT_CONFIG_NETWORK } from '@meshsdk/core';
import {
	HydraHeadStatus,
	Network,
	OnChainState,
	PaymentSourceType,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;
const purchaseFind = jest.fn() as AnyMock;
const paymentFind = jest.fn() as AnyMock;
const headFind = jest.fn() as AnyMock;
const currentOutput = jest.fn() as AnyMock;
const confirmedTransaction = jest.fn() as AnyMock;
const node = {
	hasVerifiedPinnedSessions: true,
	confirmedTransactionHistoryReady: true,
	getVerifiedCurrentOutput: currentOutput,
	getConfirmedTransaction: confirmedTransaction,
};
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		purchaseRequest: { findUnique: purchaseFind },
		paymentRequest: { findUnique: paymentFind },
		hydraHead: { findUnique: headFind },
	},
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ flushHeadStatus: async () => {}, getNode: () => node }),
}));
const { decodeV2ContractDatum } = await import('@/utils/converter/string-datum-convert');
const { serializeCardanoTransactionOutput } = await import('@/lib/hydra/hydra/snapshot-verification');
const { validateHydraRepair } = await import('./hydra-validation');

function constr(alternative: number, fields: PlutusData[] = []) {
	const list = PlutusList.new();
	fields.forEach((field) => list.add(field));
	return PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.from_str(String(alternative)), list));
}
const bytes = (hex: string) => PlutusData.new_bytes(Buffer.from(hex, 'hex'));
const int = (value: bigint) => PlutusData.new_integer(CInt.from_str(value.toString()));
function fixture() {
	const buyerKey = PrivateKey.from_normal_bytes(new Uint8Array(32).fill(1));
	const sellerKey = PrivateKey.from_normal_bytes(new Uint8Array(32).fill(2));
	const buyerHash = buyerKey.to_public().hash();
	const sellerHash = sellerKey.to_public().hash();
	const address = (hash: typeof buyerHash) =>
		EnterpriseAddress.new(1, Credential.from_keyhash(hash)).to_address().to_bech32();
	const buyer = { walletVkey: buyerHash.to_hex(), walletAddress: address(buyerHash), paymentSourceId: 'source' };
	const seller = { walletVkey: sellerHash.to_hex(), walletAddress: address(sellerHash), paymentSourceId: 'source' };
	const addressDatum = (hash: typeof buyerHash) => constr(0, [constr(0, [bytes(hash.to_hex())]), constr(1)]);
	const zeroTime = BigInt(SLOT_CONFIG_NETWORK.mainnet.zeroTime);
	const payBy = zeroTime + 200000n;
	const datum = constr(0, [
		addressDatum(buyerHash),
		constr(1),
		addressDatum(sellerHash),
		constr(1),
		bytes('aa'),
		bytes('bb'),
		bytes('cc'),
		bytes('dd'),
		bytes('ee'),
		int(4460850n),
		bytes('ff'),
		bytes(''),
		int(payBy),
		int(payBy + 10000n),
		int(payBy + 20000n),
		int(payBy + 30000n),
		int(0n),
		int(0n),
		constr(0),
	]);
	const policy = ScriptHash.from_bytes(new Uint8Array(28).fill(3));
	const asset = AssetName.new(Buffer.from('USDM'));
	const assets = Assets.new();
	assets.insert(asset, BigNum.from_str('900000'));
	const multiasset = MultiAsset.new();
	multiasset.insert(policy, assets);
	const escrow = EnterpriseAddress.new(
		1,
		Credential.from_scripthash(ScriptHash.from_bytes(new Uint8Array(28).fill(4))),
	).to_address();
	const output = TransactionOutput.new(escrow, Value.new_with_assets(BigNum.from_str('4460850'), multiasset));
	output.set_plutus_data(datum);
	const outputs = TransactionOutputs.new();
	outputs.add(output);
	const body = TransactionBody.new(TransactionInputs.new(), outputs, BigNum.from_str('0'));
	body.set_ttl(BigNum.from_str(String(SLOT_CONFIG_NETWORK.mainnet.zeroSlot + 100)));
	const required = Ed25519KeyHashes.new();
	required.add(buyerHash);
	body.set_required_signers(required);
	const txHash = FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash();
	const witnesses = TransactionWitnessSet.new();
	const vkeys = Vkeywitnesses.new();
	vkeys.add(make_vkey_witness(txHash, buyerKey));
	witnesses.set_vkeys(vkeys);
	const transaction = Transaction.new(body, witnesses);
	const decoded = decodeV2ContractDatum(deserializeDatum(datum.to_hex()), 'mainnet', escrow.to_bech32())!;
	const common = {
		id: 'request',
		updatedAt: new Date(0),
		paymentSourceId: 'source',
		blockchainIdentifier: decoded.blockchainIdentifier,
		onChainState: OnChainState.FundsOrDatumInvalid,
		layer: TransactionLayer.L2,
		currentHydraUtxoTxHash: txHash.to_hex(),
		currentHydraUtxoOutputIndex: 0,
		CurrentTransaction: {
			id: 'transaction',
			txHash: txHash.to_hex(),
			layer: TransactionLayer.L2,
			status: TransactionStatus.Confirmed,
			hydraHeadId: 'head',
		},
		PaymentSource: {
			network: Network.Mainnet,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			smartContractAddress: escrow.to_bech32(),
		},
		inputHash: decoded.inputHash,
		payByTime: decoded.payByTime,
		submitResultTime: decoded.resultTime,
		unlockTime: decoded.unlockTime,
		externalDisputeUnlockTime: decoded.externalDisputeUnlockTime,
		collateralReturnLovelace: decoded.collateralReturnLovelace,
		buyerReturnAddress: null,
		sellerReturnAddress: null,
	};
	const funds = [{ unit: policy.to_hex() + asset.to_hex(), amount: 900000n }];
	purchaseFind.mockResolvedValue({ ...common, SmartContractWallet: buyer, SellerWallet: seller, PaidFunds: funds });
	paymentFind.mockResolvedValue({ ...common, SmartContractWallet: seller, BuyerWallet: null, RequestedFunds: funds });
	headFind.mockResolvedValue({
		isEnabled: true,
		isClosing: false,
		initTxHash: 'init',
		headIdentifier: 'head-identifier',
		reconciliationCompletedAt: null,
		status: HydraHeadStatus.Open,
		ownerEpoch: 3n,
		latestSnapshotNumber: 3n,
		HydraRelation: { LocalHotWallet: buyer, RemoteWallet: seller },
	});
	currentOutput.mockReturnValue(serializeCardanoTransactionOutput(output));
	confirmedTransaction.mockReturnValue({ cborHex: transaction.to_hex(), confirmedAtMs: Number(zeroTime + 100000n) });
	return { txHash: txHash.to_hex(), funds, buyer, seller };
}

beforeEach(() => {
	jest.clearAllMocks();
});
describe('Hydra repair with signed CBOR and real validators', () => {
	it('accepts the purchase using exact token and collateral quantities', async () => {
		const data = fixture();
		const result = await validateHydraRepair({ kind: 'purchase', requestId: 'request', txHash: data.txHash });
		expect(result.derivedOnChainState).toBe(OnChainState.FundsLocked);
		expect(result.buyerWallet).toEqual({ walletVkey: data.buyer.walletVkey, walletAddress: data.buyer.walletAddress });
	});
	it('accepts seller-side repair before BuyerWallet is attached', async () => {
		const data = fixture();
		const head = await headFind();
		head.HydraRelation = { LocalHotWallet: data.seller, RemoteWallet: data.buyer };
		await expect(
			validateHydraRepair({ kind: 'payment', requestId: 'request', txHash: data.txHash }),
		).resolves.toMatchObject({ derivedOnChainState: OnChainState.FundsLocked });
	});
	it('rejects a genuine signed output whose token amount differs from the request', async () => {
		const data = fixture();
		data.funds[0].amount = 900001n;
		await expect(validateHydraRepair({ kind: 'purchase', requestId: 'request', txHash: data.txHash })).rejects.toThrow(
			'Payment amounts do not match',
		);
	});
});
