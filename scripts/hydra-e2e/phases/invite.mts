/**
 * Head invites, through a real payment service and a real Host.
 *
 * The seams worth exercising here are the ones that only exist because the
 * exchange terminates somewhere that holds no wallet key:
 *
 *  - the Exchange Plane accepts a redemption for a nonce the Host issued, and
 *    refuses an unknown, spent or expired one — with no signature check of its
 *    own, because it cannot do one;
 *  - the payment service does that check afterwards, and refuses to record a
 *    head for material whose signature does not verify;
 *  - the plane exposes nothing else, however it is addressed.
 *
 * The counterparty is simulated by posting to the plane directly rather than by
 * running a second deployment. That is the honest boundary for this phase: what
 * a real counterparty sends is exactly this body, and the two-node script exists
 * for the case where the *deployment* is the thing under test.
 *
 * Test support only.
 */

import path from 'node:path';
import { check, phase, skip } from '../check.mjs';
import { REPO_ROOT } from '../env.mjs';
import type { HostSpec } from '../env.mjs';
import { http, runTsx, spawnTsx, tail, waitFor } from '../procs.mjs';

const SERVICE_PORT = 3010;
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const ADMIN_KEY = 'hydra-e2e-admin-key-0123456789abcdef';
const DATABASE_URL =
	process.env.HYDRA_E2E_DATABASE_URL ?? 'postgresql://sandro@localhost:5432/masumi_hydra_e2e?schema=public';
const ENCRYPTION_KEY = '12345678901234567890123456789012';

type Fixture = { sourceId: string; hostId: string; walletId: string };

function serviceEnv(host: HostSpec): NodeJS.ProcessEnv {
	return {
		...process.env,
		DATABASE_URL,
		ENCRYPTION_KEY,
		ADMIN_KEY,
		PORT: String(SERVICE_PORT),
		HYDRA_HOST_EXCHANGE_PORT: String(host.exchangePort),
		// The background jobs are irrelevant here and would hammer Blockfrost with
		// a fixture key; push them past the life of the run.
		BATCH_PAYMENT_INTERVAL: '3600',
		CHECK_TX_INTERVAL: '3600',
		CHECK_COLLECTION_INTERVAL: '3600',
		CHECK_COLLECT_REFUND_INTERVAL: '3600',
		CHECK_SET_REFUND_INTERVAL: '3600',
		CHECK_UNSET_REFUND_INTERVAL: '3600',
		CHECK_AUTHORIZE_REFUND_INTERVAL: '3600',
		CHECK_SUBMIT_RESULT_INTERVAL: '3600',
		CHECK_WALLET_TRANSACTION_HASH_INTERVAL: '3600',
		REGISTER_AGENT_INTERVAL: '3600',
		DEREGISTER_AGENT_INTERVAL: '3600',
		SEED_ONLY_IF_EMPTY: 'true',
	};
}

async function seed(host: HostSpec): Promise<Fixture | null> {
	const result = await runTsx('fixture', path.join(REPO_ROOT, 'scripts', 'hydra-e2e', 'fixture.mts'), {
		...serviceEnv(host),
		FIXTURE_HOST_URL: host.baseUrl,
		FIXTURE_HOST_ADMIN_TOKEN: host.adminToken,
		FIXTURE_HOST_USER_TOKEN: host.userToken,
		FIXTURE_RELATIONS: 'none',
	});

	const line = result.stdout
		.split('\n')
		.reverse()
		.find((entry) => entry.trim().startsWith('{'));
	if (result.code !== 0 || line === undefined) {
		check('the database fixture seeded', false, result.stderr.split('\n').slice(-3).join(' ').slice(0, 300));
		return null;
	}
	const fixture = JSON.parse(line) as Fixture;
	check('the database fixture seeded', true, `source ${fixture.sourceId}`);
	return fixture;
}

type Minted = { id: string; nonce: string; code: string; expiresAt: string };

export async function checkInvites(host: HostSpec): Promise<void> {
	phase('invites: setup');

	const fixture = await seed(host);
	if (fixture === null) {
		skip('invites', 'the database fixture could not be seeded');
		return;
	}

	const service = spawnTsx('payment-service', path.join(REPO_ROOT, 'src', 'index.ts'), serviceEnv(host));
	try {
		await waitFor(
			'the payment service to answer',
			() => http(`${SERVICE_URL}/api/v1/health`),
			(result) => result.status === 200,
			{ timeoutMs: 120_000, intervalMs: 2_000 },
		);
		check('the payment service is up', true, SERVICE_URL);
	} catch (error) {
		check('the payment service is up', false, (error as Error).message);
		console.log(`\n[2m--- payment service log ---\n${tail(service.logFile, 40)}[0m\n`);
		skip('invites', 'the payment service did not start');
		return;
	}

	const minted = await checkMinting(fixture);
	if (minted === null) {
		skip('invites', 'no invite could be minted');
		return;
	}

	await checkPreview(minted);
	await checkExchangePlane(host, minted);
	await checkPlaneExposesNothingElse(host);
	await checkRevocation(fixture);
}

async function checkMinting(fixture: Fixture): Promise<Minted | null> {
	phase('invites: minting');

	const unauthenticated = await http(`${SERVICE_URL}/api/v1/hydra/invite`, {
		method: 'POST',
		body: { hotWalletId: fixture.walletId },
	});
	check('minting needs an api key', unauthenticated.status === 401, `status ${unauthenticated.status}`);

	const response = await http(`${SERVICE_URL}/api/v1/hydra/invite`, {
		method: 'POST',
		apiKey: ADMIN_KEY,
		body: { hotWalletId: fixture.walletId, ttlHours: 24 },
	});
	check(
		'an invite can be minted',
		response.status === 200,
		`status ${response.status}: ${response.text.slice(0, 200)}`,
	);
	if (response.status !== 200) {
		return null;
	}

	const minted = (JSON.parse(response.text) as { data: Minted }).data;
	check('the invite carries a code', minted.code.startsWith('masumi-hydra-invite-1.'), minted.code.slice(0, 40));

	// The reservation is the whole cost of the design: a node exists from this
	// moment, and it is idle because it has no peer.
	const listed = await http(`${SERVICE_URL}/api/v1/hydra/invite?limit=10`, { apiKey: ADMIN_KEY });
	const invites = (JSON.parse(listed.text) as { data: { invites: { nonce: string; status: string }[] } }).data.invites;
	const row = invites.find((invite) => invite.nonce === minted.nonce);
	check('the invite is recorded as Issued', row?.status === 'Issued', `status ${row?.status ?? 'missing'}`);

	return minted;
}

async function checkPreview(minted: Minted): Promise<void> {
	phase('invites: preview');

	const preview = await http(`${SERVICE_URL}/api/v1/hydra/invite/preview`, {
		method: 'POST',
		apiKey: ADMIN_KEY,
		body: { code: minted.code },
	});
	check('an invite can be previewed', preview.status === 200, `status ${preview.status}`);
	if (preview.status === 200) {
		const body = (JSON.parse(preview.text) as { data: { signatureValid: boolean; alreadyKnown: boolean } }).data;
		check('our own signature verifies', body.signatureValid, 'signatureValid');
		check('a known nonce is reported as known', body.alreadyKnown, 'alreadyKnown');
	}

	// A code whose payload was edited must fail verification rather than parse
	// into something plausible: the signature covers the canonical payload.
	const decoded = JSON.parse(
		Buffer.from(minted.code.slice('masumi-hydra-invite-1.'.length), 'base64url').toString('utf8'),
	) as { payload: Record<string, unknown>; signature: unknown };
	decoded.payload.advertise = 'attacker.example.com:5999';
	const tampered = `masumi-hydra-invite-1.${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}`;

	const tamperedPreview = await http(`${SERVICE_URL}/api/v1/hydra/invite/preview`, {
		method: 'POST',
		apiKey: ADMIN_KEY,
		body: { code: tampered },
	});
	const tamperedBody =
		tamperedPreview.status === 200
			? (JSON.parse(tamperedPreview.text) as { data: { signatureValid: boolean } }).data
			: null;
	check(
		'a tampered advertise address breaks the signature',
		tamperedBody?.signatureValid === false,
		`signatureValid ${String(tamperedBody?.signatureValid)}`,
	);

	const garbage = await http(`${SERVICE_URL}/api/v1/hydra/invite/preview`, {
		method: 'POST',
		apiKey: ADMIN_KEY,
		body: { code: 'https://example.com/not-an-invite' },
	});
	check('a non-invite is rejected', garbage.status === 400, `status ${garbage.status}`);
}

const REDEEMER = {
	walletAddress: 'addr_test1qzredeemer',
	hydraVerificationKey: 'redeemer-hydra-vk',
	cardanoVerificationKey: `5820${'ab'.repeat(32)}`,
	advertise: '127.0.0.1:5199',
	exchangeUrl: 'http://127.0.0.1:18544/exchange',
};

async function checkExchangePlane(host: HostSpec, minted: Minted): Promise<void> {
	phase('invites: exchange plane');

	const exchange = `http://127.0.0.1:${host.exchangePort}/exchange`;
	const body = (nonce: string) => ({
		nonce,
		redeemer: REDEEMER,
		signature: { signature: 'not-a-real-signature', key: 'k' },
	});

	const unknown = await http(`${exchange}/redeem`, {
		method: 'POST',
		body: body('nonce-that-was-never-issued'),
	});
	check('an unknown nonce is refused', unknown.status === 404, `status ${unknown.status}`);

	// No credential of any kind: the nonce is the capability. This is the whole
	// reason the plane can be public while the payment service is not.
	const redeemed = await http(`${exchange}/redeem`, {
		method: 'POST',
		body: body(minted.nonce),
	});
	check(
		'a redemption needs no credential beyond the nonce',
		redeemed.status === 200,
		`status ${redeemed.status}: ${redeemed.text.slice(0, 120)}`,
	);
	check(
		'the reply carries no material to trust',
		redeemed.text.includes('"redeemed":true'),
		redeemed.text.slice(0, 80),
	);

	const replayed = await http(`${exchange}/redeem`, {
		method: 'POST',
		body: body(minted.nonce),
	});
	check('a spent nonce cannot be redeemed twice', replayed.status === 409, `status ${replayed.status}`);

	// The Host cannot check a signature — that is the payment service's job on
	// its next poll, and a bad one must leave no head behind.
	const malformed = await http(`${exchange}/redeem`, {
		method: 'POST',
		body: { nonce: minted.nonce, redeemer: { walletAddress: 'x' }, signature: { signature: 's' } },
	});
	check('malformed material is refused', malformed.status === 400, `status ${malformed.status}`);
}

async function checkPlaneExposesNothingElse(host: HostSpec): Promise<void> {
	phase('invites: exchange plane surface');

	const base = `http://127.0.0.1:${host.exchangePort}`;
	for (const pathname of ['/v1/nodes', '/v1/capabilities', '/v1/invites', '/v1/allowed-issuers']) {
		const response = await http(`${base}${pathname}`, {
			method: 'POST',
			body: {},
		});
		check(`the exchange plane has no ${pathname}`, response.status === 404, `status ${response.status}`);
	}

	const wrongMethod = await http(`${base}/exchange/redeem`);
	check('the exchange plane refuses GET', wrongMethod.status === 405, `status ${wrongMethod.status}`);
}

async function checkRevocation(fixture: Fixture): Promise<void> {
	phase('invites: revocation');

	const minted = await http(`${SERVICE_URL}/api/v1/hydra/invite`, {
		method: 'POST',
		apiKey: ADMIN_KEY,
		body: { hotWalletId: fixture.walletId, ttlHours: 1 },
	});
	if (minted.status !== 200) {
		check('a second invite could be minted for revocation', false, `status ${minted.status}`);
		return;
	}
	const invite = (JSON.parse(minted.text) as { data: Minted }).data;

	const revoked = await http(`${SERVICE_URL}/api/v1/hydra/invite`, {
		method: 'DELETE',
		apiKey: ADMIN_KEY,
		body: { id: invite.id },
	});
	check(
		'an unredeemed invite can be revoked',
		revoked.status === 200,
		`status ${revoked.status}: ${revoked.text.slice(0, 160)}`,
	);

	// Revoking releases the reservation, so the nonce must no longer be
	// redeemable — otherwise a counterparty holding the code could still start a
	// node we thought we had taken back.
	const listed = await http(`${SERVICE_URL}/api/v1/hydra/invite?limit=20`, { apiKey: ADMIN_KEY });
	const rows = (JSON.parse(listed.text) as { data: { invites: { nonce: string; status: string }[] } }).data.invites;
	const row = rows.find((candidate) => candidate.nonce === invite.nonce);
	check('the revoked invite is recorded as Revoked', row?.status === 'Revoked', `status ${row?.status ?? 'missing'}`);
}
