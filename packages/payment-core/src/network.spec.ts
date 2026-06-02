import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Network } from '@prisma/client';
import {
	BASE_MAINNET_CAIP2,
	BASE_SEPOLIA_CAIP2,
	CARDANO_MAINNET_CAIP2,
	CARDANO_PREPROD_CAIP2,
	caip2LimitToCardanoNetworks,
	cardanoNetworkToCaip2,
	mergeCaip2NetworkLimits,
	isAllowedCaip2Network,
} from './network';

describe('CAIP-2 network helpers', () => {
	it('maps legacy Cardano network enum values to CAIP-2 chain ids', () => {
		expect(cardanoNetworkToCaip2(Network.Mainnet)).toBe(CARDANO_MAINNET_CAIP2);
		expect(cardanoNetworkToCaip2(Network.Preprod)).toBe(CARDANO_PREPROD_CAIP2);
	});

	it('keeps Cardano API output limited to legacy network enum values', () => {
		expect(caip2LimitToCardanoNetworks([CARDANO_PREPROD_CAIP2, BASE_SEPOLIA_CAIP2, CARDANO_MAINNET_CAIP2])).toEqual([
			Network.Preprod,
			Network.Mainnet,
		]);
	});

	it('merges existing Cardano limits with new x402 chain ids', () => {
		expect(mergeCaip2NetworkLimits([Network.Preprod], [BASE_MAINNET_CAIP2, BASE_SEPOLIA_CAIP2])).toEqual([
			CARDANO_PREPROD_CAIP2,
			BASE_MAINNET_CAIP2,
			BASE_SEPOLIA_CAIP2,
		]);
	});

	it('treats null CAIP-2 limits as admin/unlimited access', () => {
		expect(isAllowedCaip2Network(null, 'eip155:999999')).toBe(true);
	});

	it('migration backfills legacy API-key network limits to CAIP-2 strings in place', () => {
		const migrationSql = readFileSync(
			join(process.cwd(), 'prisma/migrations/20260602000000_add_x402_payment_rail/migration.sql'),
			'utf8',
		);

		expect(migrationSql).toContain("WHEN 'Mainnet' THEN 'cardano:mainnet'");
		expect(migrationSql).toContain("WHEN 'Preprod' THEN 'cardano:preprod'");
		expect(migrationSql).toContain('ALTER TABLE "ApiKey" RENAME COLUMN "networkLimitCaip2" TO "networkLimit"');
	});
});
