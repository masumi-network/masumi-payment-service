/**
 * Dev tool: retire the current active V2 PaymentSource for a network and point it
 * at the V2 contract now configured in DEFAULTS (@masumi/payment-core/config) —
 * IN PLACE, keeping the existing funded HotWallets and registered agents.
 *
 * Why in-place rather than delete+recreate:
 *  - Only ONE active (deletedAt IS NULL) V2 source per network is allowed: the
 *    partial unique index `PaymentSource_network_policyId_active_key` pins
 *    (network, policyId), and the V2 registry policyId is network-derived
 *    (getRegistryScriptV2(network)) — the SAME for every V2 source on a network.
 *    So the old and new cannot coexist active.
 *  - `HotWallet.walletVkey` is globally unique, so re-seeding a new source with
 *    the same V2 mnemonics collides with the old source's wallets. Updating in
 *    place never moves the wallets, so no collision and their funds are kept.
 *  - Changing only the V2 required-admin-signatures / admin wallets / cooldown
 *    changes the derived PAYMENT contract address (getPaymentScriptV2) but NOT
 *    the registry policyId (getRegistryScriptV2(network)) — so registered agents
 *    stay valid and are kept. If the registry contract itself was also redeployed
 *    (DEFAULTS.REGISTRY_POLICY_ID_V2_<NET> changed), the policyId changes too and
 *    agents minted under the old policyId are orphaned (the script warns).
 *
 * PREREQUISITE: update DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_<NET> (and
 * REGISTRY_POLICY_ID_V2_<NET> if it changed) to the NEW deployed contract first
 * — this script reads the target values from DEFAULTS.
 *
 * DEV/TEST ONLY: on a live source the old escrow contract may hold unsettled
 * funds; drain/settle them before repointing. This script warns about non-terminal
 * escrows but does not block.
 *
 * Usage:
 *   pnpm exec tsx scripts/replace-v2-payment-source.ts [preprod|mainnet]                          # dry run
 *   pnpm exec tsx scripts/replace-v2-payment-source.ts [preprod|mainnet] --apply                  # write
 *   pnpm exec tsx scripts/replace-v2-payment-source.ts [preprod|mainnet] --apply --purge-agents   # + wipe old agents
 *
 * --purge-agents also DELETEs this source's RegistryRequest + InboxAgentRegistrationRequest rows
 * (no on-chain deregister). Use when the registry policyId changed or the baked-in payment address
 * is now wrong, so the old registrations are unusable and must be re-created.
 */
import { Network, PaymentSourceType, PrismaClient } from '../src/generated/prisma/client';
import { DEFAULTS } from '@masumi/payment-core/config';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

type TargetParams = {
	smartContractAddress: string;
	policyId: string;
	adminWallets: string[];
};

function targetFor(network: Network): TargetParams {
	if (network === Network.Mainnet) {
		return {
			smartContractAddress: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_MAINNET,
			policyId: DEFAULTS.REGISTRY_POLICY_ID_V2_MAINNET,
			adminWallets: [DEFAULTS.ADMIN_WALLET1_MAINNET, DEFAULTS.ADMIN_WALLET2_MAINNET, DEFAULTS.ADMIN_WALLET3_MAINNET],
		};
	}
	return {
		smartContractAddress: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD,
		policyId: DEFAULTS.REGISTRY_POLICY_ID_V2_PREPROD,
		adminWallets: [DEFAULTS.ADMIN_WALLET1_PREPROD, DEFAULTS.ADMIN_WALLET2_PREPROD, DEFAULTS.ADMIN_WALLET3_PREPROD],
	};
}

async function main() {
	const netArg = (process.argv[2] ?? 'preprod').toLowerCase();
	const apply = process.argv.includes('--apply');
	if (netArg !== 'preprod' && netArg !== 'mainnet') {
		throw new Error(`Unknown network '${netArg}'. Use 'preprod' or 'mainnet'.`);
	}
	const purgeAgents = process.argv.includes('--purge-agents');
	const network = netArg === 'mainnet' ? Network.Mainnet : Network.Preprod;
	const target = targetFor(network);
	const requiredAdminSignatures = DEFAULTS.DEFAULT_ADMIN_SIGNATURES_V2;

	const existing = await prisma.paymentSource.findFirst({
		where: { network, paymentSourceType: PaymentSourceType.Web3CardanoV2, deletedAt: null },
		include: { HotWallets: { where: { deletedAt: null } }, AdminWallets: true },
	});

	if (!existing) {
		console.log(
			`No active Web3CardanoV2 PaymentSource on ${network}. Nothing to replace — run the seed to create one.`,
		);
		return;
	}
	if (existing.smartContractAddress === target.smartContractAddress) {
		console.log(`V2 source ${existing.id} on ${network} is already at ${target.smartContractAddress}. Nothing to do.`);
		return;
	}

	// Informational: rows tied to the OLD contract(s) (dev/test — do not block).
	const policyChanged = existing.policyId !== target.policyId;
	const openEscrows =
		(await prisma.paymentRequest.count({ where: { paymentSourceId: existing.id } })) +
		(await prisma.purchaseRequest.count({ where: { paymentSourceId: existing.id } }));
	const registeredAgents =
		(await prisma.registryRequest.count({ where: { paymentSourceId: existing.id } })) +
		(await prisma.inboxAgentRegistrationRequest.count({ where: { paymentSourceId: existing.id } }));

	console.log(`Replace V2 PaymentSource ${existing.id} on ${network} (IN PLACE, keeping hot wallets):`);
	console.log(`  smartContractAddress: ${existing.smartContractAddress}`);
	console.log(`                     -> ${target.smartContractAddress}`);
	console.log(`  policyId:             ${existing.policyId ?? '(none)'} -> ${target.policyId}`);
	console.log(
		`  requiredAdminSignatures: ${existing.requiredAdminSignatures ?? '(none)'} -> ${requiredAdminSignatures}`,
	);
	console.log(`  adminWallets:         ${existing.AdminWallets.length} -> ${target.adminWallets.length}`);
	console.log(
		`  hot wallets kept:     ${existing.HotWallets.length} (${existing.HotWallets.map((w) => w.type).join(', ') || 'none'})`,
	);
	if (openEscrows > 0) {
		console.log(
			`  WARNING: ${openEscrows} payment/purchase request row(s) reference this source and the OLD escrow contract; ` +
				`they will be orphaned against the new address. Fine for dev/test; on a live source, settle them first.`,
		);
	}
	if (policyChanged && registeredAgents > 0) {
		console.log(
			`  WARNING: the registry policyId also changes, so ${registeredAgents} agent registration row(s) minted under ` +
				`the OLD policyId will be orphaned (they do not exist under the new policyId). Fine for dev/test; on a live ` +
				`source, migrate/re-register agents first.`,
		);
	}

	if (purgeAgents) {
		console.log(
			`  --purge-agents: will DELETE ${registeredAgents} agent registration row(s) (registry + inbox) for this ` +
				`source from the DB (no on-chain deregister — the old NFTs are abandoned).`,
		);
	}

	if (!apply) {
		console.log('\nDry run — no changes written. Re-run with --apply to commit.');
		return;
	}

	await prisma.$transaction(async (tx) => {
		if (purgeAgents) {
			// Wipe agents tied to the retired registry policy / stale payment info.
			// RegistryRequest children (ExampleOutput / SupportedPaymentSource /
			// Verifications) are onDelete: Cascade; x402 attempts are SetNull; nothing
			// Restricts the delete. Orphaned AgentPricing / Transaction rows are left
			// (harmless dev-DB clutter). InboxAgentRegistrationRequest has no children.
			const deletedRegistry = await tx.registryRequest.deleteMany({ where: { paymentSourceId: existing.id } });
			const deletedInbox = await tx.inboxAgentRegistrationRequest.deleteMany({
				where: { paymentSourceId: existing.id },
			});
			console.log(`Purged ${deletedRegistry.count} registry + ${deletedInbox.count} inbox agent registration row(s).`);
		}
		await tx.paymentSource.update({
			where: { id: existing.id },
			data: {
				smartContractAddress: target.smartContractAddress,
				policyId: target.policyId,
				requiredAdminSignatures,
				syncInProgress: false,
				// Re-scan the NEW contract from the start; the old value indexed the
				// retired contract and is meaningless for the new address.
				lastIdentifierChecked: null,
				AdminWallets: {
					deleteMany: {},
					create: target.adminWallets.map((walletAddress, i) => ({ walletAddress, order: i + 1 })),
				},
			},
		});
	});

	console.log(
		`\nDone. V2 source ${existing.id} now points at ${target.smartContractAddress} (hot wallets preserved` +
			`${policyChanged ? '; registry policyId changed' : '; registry policyId unchanged'}` +
			`${purgeAgents ? '; old agents purged' : ''}).`,
	);
}

main()
	.then(async () => {
		await prisma.$disconnect();
		await pool.end();
	})
	.catch(async (e) => {
		console.error(e);
		await prisma.$disconnect();
		await pool.end();
		process.exit(1);
	});
