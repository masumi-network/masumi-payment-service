// point-vault.mts — re-point the seeded V2 PaymentSource at the contract address
// that matches its CURRENT cooldownTime ("vault B").
//
// Why this exists (devnet demo only):
//   The V2 payment script bakes `cooldownPeriod` in via applyParamsToScript, so
//   the smartContractAddress is cooldown-dependent. `prisma db seed` derives and
//   stores the address using the preprod default cooldown (420000ms = "vault A").
//   The e2e harness then lowers PaymentSource.cooldownTime to 60000ms to shrink
//   the demo's cooldown waits. After that edit two addresses are in play:
//     - l2-lock locks funds at the STORED `smartContractAddress` (vault A), but
//     - every spend service re-derives the script from the LIVE `cooldownTime`
//       (getPaymentScriptFromPaymentSourceV2 → vault B).
//   They diverge → the spend matcher reports "contract UTXO not found".
//
//   This script recomputes the address from the live PaymentSource and writes it
//   back, so lock + spend + the on-chain script all agree on vault B. It is a
//   no-op when they already match (e.g. a real preprod source whose stored
//   address was derived with the same cooldown).
//
// Run: DATABASE_URL=<test-db> pnpm exec tsx hydra-l2-flow/point-vault.mts
import { prisma } from '@masumi/payment-core/db';
import { getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { PaymentSourceType } from '@/generated/prisma/client';

async function main() {
	const paymentSource = await prisma.paymentSource.findFirstOrThrow({
		where: { paymentSourceType: PaymentSourceType.Web3CardanoV2, deletedAt: null },
		include: { AdminWallets: true },
		orderBy: { createdAt: 'desc' },
	});

	const { smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentSource);
	const stored = paymentSource.smartContractAddress;

	if (smartContractAddress === stored) {
		console.log(`point-vault: already consistent (cooldownTime=${paymentSource.cooldownTime}) → ${stored.slice(0, 24)}…`);
		process.exit(0);
	}

	await prisma.paymentSource.update({
		where: { id: paymentSource.id },
		data: { smartContractAddress },
	});
	console.log(
		`point-vault: re-pointed to vault B (cooldownTime=${paymentSource.cooldownTime})\n` +
			`  was: ${stored}\n` +
			`  now: ${smartContractAddress}`,
	);
	process.exit(0);
}

main().catch((e) => {
	console.error('[point-vault] FATAL', e);
	process.exit(1);
});
