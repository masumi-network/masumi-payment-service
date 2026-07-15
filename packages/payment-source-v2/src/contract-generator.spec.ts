import { SmartContractState } from '@masumi/payment-core';
import { getDatumV2 } from './contract-generator';

const PREPROD_BASE_ADDRESS =
	'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
// Same payment key hash as PREPROD_BASE_ADDRESS, no stake credential.
const PREPROD_ENTERPRISE_ADDRESS = 'addr_test1vq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0c75xvdu';
const PREPROD_SCRIPT_ADDRESS = 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm';
const PAYMENT_KEY_HASH = '1f9d349ec66fb28920e0f093edce415792ce0281a8825015ce3e16bf';

type MConstr = { alternative: number; fields: unknown[] };

function buildDatum(overrides: { buyerAddress?: string; sellerAddress?: string } = {}) {
	return getDatumV2({
		buyerAddress: overrides.buyerAddress ?? PREPROD_BASE_ADDRESS,
		sellerAddress: overrides.sellerAddress ?? PREPROD_BASE_ADDRESS,
		referenceKey: 'aa'.repeat(32),
		referenceSignature: 'bb'.repeat(16),
		sellerNonce: 'cc'.repeat(32),
		buyerNonce: 'dd'.repeat(32),
		agentIdentifier: 'ee'.repeat(16),
		collateralReturnLovelace: 0n,
		inputHash: null,
		resultHash: null,
		payByTime: 1_000n,
		resultTime: 2_000n,
		unlockTime: 3_000n,
		externalDisputeUnlockTime: 4_000n,
		newCooldownTimeSeller: 0n,
		newCooldownTimeBuyer: 0n,
		state: SmartContractState.FundsLocked,
	});
}

function addressField(datum: ReturnType<typeof buildDatum>, index: number): MConstr {
	return (datum.value as unknown as MConstr).fields[index] as MConstr;
}

describe('getDatumV2 participant address encoding', () => {
	it('encodes a base address with an inline stake credential (Some)', () => {
		const buyer = addressField(buildDatum(), 0);
		expect(buyer.alternative).toBe(0);
		const payment = buyer.fields[0] as MConstr;
		expect(payment.alternative).toBe(0);
		expect(payment.fields[0]).toBe(PAYMENT_KEY_HASH);
		const stakeOption = buyer.fields[1] as MConstr;
		expect(stakeOption.alternative).toBe(0); // Some(Inline(cred))
		expect(stakeOption.fields).toHaveLength(1);
	});

	it('encodes an enterprise address with stake credential None', () => {
		const buyer = addressField(buildDatum({ buyerAddress: PREPROD_ENTERPRISE_ADDRESS }), 0);
		expect(buyer.alternative).toBe(0);
		const payment = buyer.fields[0] as MConstr;
		expect(payment.fields[0]).toBe(PAYMENT_KEY_HASH);
		const stakeOption = buyer.fields[1] as MConstr;
		expect(stakeOption.alternative).toBe(1); // None
		expect(stakeOption.fields).toHaveLength(0);
	});

	it('accepts an enterprise seller as well', () => {
		const seller = addressField(buildDatum({ sellerAddress: PREPROD_ENTERPRISE_ADDRESS }), 2);
		const stakeOption = seller.fields[1] as MConstr;
		expect(stakeOption.alternative).toBe(1);
	});

	it('rejects script-credential participant addresses', () => {
		expect(() => buildDatum({ buyerAddress: PREPROD_SCRIPT_ADDRESS })).toThrow(
			'buyerAddress must be a Cardano base or enterprise address with a payment key credential',
		);
		expect(() => buildDatum({ sellerAddress: PREPROD_SCRIPT_ADDRESS })).toThrow(
			'sellerAddress must be a Cardano base or enterprise address with a payment key credential',
		);
	});
});
