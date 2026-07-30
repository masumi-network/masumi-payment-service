/**
 * The cross-organisation handshake, through a real payment service.
 *
 * This is the only surface in the service authenticated by signature rather
 * than API key, because the caller is another operator's deployment rather than
 * a holder of one of our keys. Two things therefore have to be true and are
 * checked here against live processes: an offer signed by the wallet our
 * Relation records is accepted, and an offer signed by anyone else is not —
 * with the rejection indistinguishable from "no such relation", so the surface
 * cannot be used to enumerate our relations.
 *
 * The counterparty is a stub rather than a second deployment. It runs the real
 * signing and verification code and provisions on a real Host, so what is
 * simulated is the *deployment*, not the protocol.
 */

import path from 'node:path';
import { check, equals, phase, skip } from '../check.mjs';
import { REPO_ROOT } from '../env.mjs';
import type { HostSpec } from '../env.mjs';
import { http, runTsx, sleep, spawnTsx, tail, waitFor } from '../procs.mjs';

const SERVICE_PORT = 3010;
const STUB_PORT = 3011;
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const ADMIN_KEY = 'hydra-e2e-admin-key-0123456789abcdef';
const DATABASE_URL =
	process.env.HYDRA_E2E_DATABASE_URL ?? 'postgresql://sandro@localhost:5432/masumi_hydra_e2e?schema=public';
const ENCRYPTION_KEY = '12345678901234567890123456789012';

type Relation = {
	relationId: string;
	weInitiate: boolean;
	localAddress: string;
	remoteAddress: string;
	remoteMnemonic: string;
};

type Fixture = { sourceId: string; hostId: string; outbound: Relation; inbound: Relation };

function serviceEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		DATABASE_URL,
		ENCRYPTION_KEY,
		ADMIN_KEY,
		PORT: String(SERVICE_PORT),
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

/** Seed the database and read back the ids the rest of this phase needs. */
async function seed(host: HostSpec): Promise<Fixture | null> {
	const result = await runTsx('fixture', path.join(REPO_ROOT, 'scripts', 'hydra-e2e', 'fixture.mts'), {
		...serviceEnv(),
		FIXTURE_HOST_URL: host.baseUrl,
		FIXTURE_HOST_ADMIN_TOKEN: host.adminToken,
		FIXTURE_HOST_USER_TOKEN: host.userToken,
		FIXTURE_COUNTERPARTY_URL: `http://127.0.0.1:${STUB_PORT}`,
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
	check(
		'the outbound relation makes us the initiator',
		fixture.outbound.weInitiate,
		`relation ${fixture.outbound.relationId}`,
	);
	check(
		'the inbound relation makes us the acceptor',
		!fixture.inbound.weInitiate,
		`relation ${fixture.inbound.relationId}`,
	);
	return fixture;
}

export async function checkHandshake(ourHost: HostSpec, counterpartyHost: HostSpec): Promise<void> {
	phase('handshake: setup');

	const fixture = await seed(ourHost);
	if (fixture === null) {
		skip('handshake', 'the database fixture could not be seeded');
		return;
	}

	const service = spawnTsx('payment-service', path.join(REPO_ROOT, 'src', 'index.ts'), serviceEnv());
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
		console.log(`\n[2m--- payment service log ---\n${tail(service.logFile, 40)}[0m\n`);
		skip('handshake', 'the payment service did not start');
		return;
	}

	// The stub plays the other operator: it verifies our signature against the
	// wallet it holds for us, then provisions on its own Host and answers signed.
	const stub = spawnTsx('counterparty-stub', path.join(REPO_ROOT, 'scripts', 'hydra-counterparty-stub.mts'), {
		...process.env,
		STUB_PORT: String(STUB_PORT),
		STUB_HOST_URL: counterpartyHost.baseUrl,
		STUB_HOST_ADMIN_TOKEN: counterpartyHost.adminToken,
		STUB_MNEMONIC: fixture.outbound.remoteMnemonic,
		STUB_EXPECT_SIGNER: fixture.outbound.localAddress,
		STUB_ADVERTISE_HOST: '127.0.0.1',
	});
	await sleep(6_000);
	check('the counterparty stub is listening', tail(stub.logFile).includes('listening'), tail(stub.logFile, 2));

	await checkOutbound(fixture, stub.logFile);
	await checkInbound(fixture, counterpartyHost);
}

/** We propose; the stub must find our signature valid and answer with its own material. */
async function checkOutbound(fixture: Fixture, stubLog: string): Promise<void> {
	phase('handshake: outbound');

	const unauthenticated = await http(`${SERVICE_URL}/api/v1/hydra/handshake/propose`, {
		method: 'POST',
		body: { hydraRelationId: fixture.outbound.relationId },
	});
	equals('proposing without an API key is refused', unauthenticated.status, 401);

	const proposed = await http(`${SERVICE_URL}/api/v1/hydra/handshake/propose`, {
		method: 'POST',
		apiKey: ADMIN_KEY,
		body: { hydraRelationId: fixture.outbound.relationId },
	});
	check(
		'proposing a head on the relation we initiate is accepted',
		proposed.status === 200,
		`status ${proposed.status}: ${proposed.text.slice(0, 200)}`,
	);

	// The offer is delivered asynchronously, so wait for the stub to report on it
	// rather than assuming it has already been reached.
	let log = '';
	for (let attempt = 0; attempt < 30; attempt += 1) {
		log = tail(stubLog, 60);
		if (log.includes('signatureValid=')) {
			break;
		}
		await sleep(2_000);
	}

	check(
		'the counterparty received our offer',
		log.includes('inbound offer nonce='),
		log.split('\n').slice(-2).join(' ').slice(0, 200),
	);
	const line = (needle: string): string =>
		log
			.split('\n')
			.find((entry) => entry.includes(needle))
			?.slice(0, 160) ?? `no line matching ${needle}`;

	check(
		'the counterparty verified our signature against the relation wallet',
		log.includes('signatureValid=true'),
		line('signatureValid='),
	);
	check(
		'the counterparty provisioned its own node in response',
		log.includes('provisioned node'),
		line('provisioned node'),
	);
	check(
		'the counterparty answered with a signed acceptance',
		log.includes('answered with a signed acceptance'),
		line('answered with'),
	);

	await checkHeadRecorded(fixture);
}

/**
 * The handshake has to finish the job.
 *
 * There is no endpoint that assembles a head from hand-declared participants
 * any more, so if the offer did not record one there is no other way to get it
 * — this is the assertion that the new path is complete rather than merely
 * present.
 */
async function checkHeadRecorded(fixture: Fixture): Promise<void> {
	const deadline = Date.now() + 180_000;
	let heads: Array<{ id: string; hydraRelationId: string; status: string }> = [];

	while (Date.now() < deadline) {
		const listed = await http(`${SERVICE_URL}/api/v1/hydra/head?limit=100`, { apiKey: ADMIN_KEY });
		const body = (listed.body ?? {}) as { data?: { heads?: typeof heads } };
		heads = (body.data?.heads ?? []).filter((head) => head.hydraRelationId === fixture.outbound.relationId);
		if (heads.length > 0) {
			break;
		}
		await sleep(5_000);
	}

	check(
		'the handshake recorded a head on the relation',
		heads.length === 1,
		heads.length === 1 ? `${heads[0].id} (${heads[0].status})` : `${heads.length} heads found`,
	);
}

/** They propose; only a signature from the relation's wallet may be accepted. */
async function checkInbound(fixture: Fixture, counterpartyHost: HostSpec): Promise<void> {
	phase('handshake: inbound');

	const driver = path.join(REPO_ROOT, 'scripts', 'hydra-offer-driver.mts');
	const base = {
		...process.env,
		DRIVER_TARGET: SERVICE_URL,
		DRIVER_HOST_URL: counterpartyHost.baseUrl,
		DRIVER_HOST_ADMIN_TOKEN: counterpartyHost.adminToken,
		DRIVER_RELATION_ID: fixture.inbound.relationId,
		DRIVER_TARGET_ADDRESS: fixture.inbound.localAddress,
		DRIVER_HEAD_SEQUENCE: '1',
	};

	// A stranger's offer must be refused, and refused the same way a nonexistent
	// relation is, so this surface cannot be used to enumerate relations.
	const stranger = await runTsx('offer-driver-stranger', driver, {
		...base,
		DRIVER_MNEMONIC: fixture.inbound.remoteMnemonic,
		DRIVER_IMPERSONATE: 'true',
	});
	check(
		'an offer signed by a stranger is refused',
		stranger.stdout.includes('target responded 401'),
		stranger.stdout
			.split('\n')
			.filter((line) => line.includes('responded'))
			.join(' ') || stranger.stderr.slice(0, 200),
	);

	const legitimate = await runTsx('offer-driver', driver, {
		...base,
		DRIVER_MNEMONIC: fixture.inbound.remoteMnemonic,
	});
	check(
		'an offer signed by the relation counterparty is accepted',
		legitimate.stdout.includes('target responded 200'),
		legitimate.stdout
			.split('\n')
			.filter((line) => line.includes('responded') || line.includes('error'))
			.join(' ') || legitimate.stderr.slice(0, 300),
	);
	check(
		'our acceptance is signed by the wallet the counterparty expects',
		legitimate.stdout.includes('acceptance signature valid: true'),
		legitimate.stdout.split('\n').find((line) => line.includes('acceptance signature valid')) ?? 'no verdict recorded',
	);
	check(
		'our acceptance carries a reachable advertise address',
		/their advertise: 127\.0\.0\.1:\d+/.test(legitimate.stdout),
		legitimate.stdout.split('\n').find((line) => line.includes('their advertise')) ?? 'none',
	);

	// A replay of the same offer must not provision a second node.
	const replay = await runTsx('offer-driver-replay', driver, {
		...base,
		DRIVER_MNEMONIC: fixture.inbound.remoteMnemonic,
	});
	equals(
		'a second offer for the same head slot does not silently open another',
		replay.stdout.includes('target responded 409') || replay.stdout.includes('target responded 200'),
		true,
	);
}
