import { PaymentSourceType } from '@/generated/prisma/client';
import { buildSignedBlockchainIdentifierPayload } from './blockchain-identifier-payload';

const baseInput = {
	inputHash: 'input-hash',
	agentIdentifier: 'agent-id',
	purchaserIdentifier: 'buyer-id',
	sellerIdentifier: 'seller-id',
	requestedFunds: null,
	payByTime: '1',
	submitResultTime: '2',
	unlockTime: '3',
	externalDisputeUnlockTime: '4',
	sellerAddress: 'seller-address',
	sellerReturnAddress: 'seller-return-address',
	smartContractAddress: 'addr_test1qcontract',
};

describe('buildSignedBlockchainIdentifierPayload', () => {
	it('keeps the V1 signature payload shape unchanged', () => {
		const payload = buildSignedBlockchainIdentifierPayload({
			...baseInput,
			paymentSourceType: PaymentSourceType.Web3CardanoV1,
		});

		expect(payload).not.toHaveProperty('sellerReturnAddress');
		expect(payload).not.toHaveProperty('smartContractAddress');
		expect(payload).not.toHaveProperty('supportedPaymentSourceIndex');
	});

	it('includes the selected source with V2 signature payloads', () => {
		const payload = buildSignedBlockchainIdentifierPayload({
			...baseInput,
			supportedPaymentSourceIndex: 2,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		expect(payload).toHaveProperty('sellerReturnAddress', 'seller-return-address');
		expect(payload).toHaveProperty('smartContractAddress', 'addr_test1qcontract');
		expect(payload).toHaveProperty('supportedPaymentSourceIndex', 2);
	});

	it('keeps legacy V2 payloads compatible when no source index was signed', () => {
		const payload = buildSignedBlockchainIdentifierPayload({
			...baseInput,
			sellerReturnAddress: null,
			smartContractAddress: null,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		expect(payload).toHaveProperty('sellerReturnAddress', null);
		expect(payload).toHaveProperty('smartContractAddress', null);
		expect(payload).not.toHaveProperty('supportedPaymentSourceIndex');
	});
});
