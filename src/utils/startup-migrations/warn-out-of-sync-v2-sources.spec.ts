import { Network } from '@/generated/prisma/client';
import { DEFAULTS } from '@masumi/payment-core/config';
import { classifyV2SourceSync } from '@/utils/v2-contract-sync';

describe('classifyV2SourceSync', () => {
	it('is in_sync when policyId + address match the current defaults', () => {
		expect(
			classifyV2SourceSync({
				network: Network.Preprod,
				policyId: DEFAULTS.REGISTRY_POLICY_ID_V2_PREPROD,
				smartContractAddress: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD,
			}),
		).toBe('in_sync');
	});

	it('flags outdated_contract when the registry policyId differs (retired contract version)', () => {
		expect(
			classifyV2SourceSync({
				network: Network.Preprod,
				// old Aiken v1.1.21 registry policy
				policyId: '7890b485b808043ef80136a447a3a43c18893a309dc323d1f8b0a13d',
				smartContractAddress: 'addr_test1wqsztux7j6c23ukjj3328vvxe3yqug43fs9vufysg6ddxpg8xqev4',
			}),
		).toBe('outdated_contract');
	});

	it('reports custom_address when policyId matches but the address is a non-default (custom-wallet) one', () => {
		expect(
			classifyV2SourceSync({
				network: Network.Mainnet,
				policyId: DEFAULTS.REGISTRY_POLICY_ID_V2_MAINNET,
				smartContractAddress: 'addr1wx7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsq87ujx7',
			}),
		).toBe('custom_address');
	});

	it('policyId mismatch takes precedence over a matching-or-not address', () => {
		expect(
			classifyV2SourceSync({
				network: Network.Mainnet,
				policyId: 'deadbeef'.repeat(7),
				smartContractAddress: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_MAINNET,
			}),
		).toBe('outdated_contract');
	});

	it('treats a null policyId as in_sync (nothing to compare — never false-flags)', () => {
		expect(
			classifyV2SourceSync({
				network: Network.Preprod,
				policyId: null,
				smartContractAddress: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD,
			}),
		).toBe('in_sync');
	});
});
