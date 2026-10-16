/**
 * Choosing which Hydra Host a new head's node is placed on, and refusing to
 * place it on an incompatible one.
 *
 * Placement happens once and is permanent: a head's persistence directory is
 * the only copy of its state on that machine and cannot be moved, so a Host
 * chosen badly cannot be corrected later by rescheduling — only by closing the
 * head. That is why the compatibility checks below run before provisioning
 * rather than at first use.
 */

import type { HostCapabilities } from './client';

export type PlaceableHost = {
	id: string;
	name: string;
	network: string;
	status: string;
	/** A Host registered without an admin token can be operated but not provisioned on. */
	hasAdminToken: boolean;
};

export class HostPlacementError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HostPlacementError';
	}
}

export class HostIncompatibleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HostIncompatibleError';
	}
}

/**
 * Pick a Host for a new node.
 *
 * Only `Active` Hosts take new placements — `Draining` deliberately keeps
 * serving its existing heads (they cannot move) while accepting nothing new.
 * Selection is first-fit over a caller-supplied order rather than
 * least-loaded, because capacity is only known by asking each Host and a
 * stale count would be a worse basis than a stable one.
 */
export function selectPlacementHost(hosts: PlaceableHost[], network: string): PlaceableHost {
	const onNetwork = hosts.filter((host) => host.network === network);
	if (onNetwork.length === 0) {
		throw new HostPlacementError(`no hydra host is registered for network ${network}`);
	}

	const active = onNetwork.filter((host) => host.status === 'Active');
	if (active.length === 0) {
		const states = [...new Set(onNetwork.map((host) => host.status))].join(', ');
		throw new HostPlacementError(
			`no hydra host on ${network} is accepting placements (registered hosts are: ${states})`,
		);
	}

	const provisionable = active.filter((host) => host.hasAdminToken);
	if (provisionable.length === 0) {
		throw new HostPlacementError(
			`every active hydra host on ${network} is registered without an admin token, so none can be provisioned on`,
		);
	}

	return provisionable[0];
}

export type ExpectedHostCapabilities = {
	network: string;
	/** Exact Hydra release this service has reviewed. */
	hydraVersion: string;
	/** Fingerprint of the full reviewed `--hydra-script-catalogue` output. */
	scriptCatalogueHash: string;
	/** Hash of the ledger params this service builds transactions against. */
	ledgerParamsHash: string;
};

/**
 * Refuse a Host whose ledger or chain would produce heads this service cannot
 * transact on.
 *
 * The ledger params check is the important one: if the head's cost models differ
 * from the ones the V2 builders use, every in-head script spend fails
 * `PPViewHashesDontMatch`, and it fails at commit time — long after placement,
 * with nothing pointing back at the cause.
 */
export function assertHostCompatible(capabilities: HostCapabilities, expected: ExpectedHostCapabilities): void {
	if (capabilities.probeError !== null) {
		throw new HostIncompatibleError(
			`the hydra host could not describe itself (${capabilities.probeError}); refusing to place a head on it`,
		);
	}
	if (capabilities.exchangeUrl === null) {
		throw new HostIncompatibleError(
			'the hydra host reports no public exchange URL. Upgrade the Host before placing another head',
		);
	}

	if (capabilities.network !== expected.network) {
		throw new HostIncompatibleError(
			`the hydra host runs ${capabilities.network} but this head is for ${expected.network}`,
		);
	}

	const versionMatches =
		capabilities.hydraVersion === expected.hydraVersion ||
		capabilities.hydraVersion.startsWith(`${expected.hydraVersion} `) ||
		capabilities.hydraVersion.startsWith(`${expected.hydraVersion}+`);
	if (!versionMatches) {
		// Official hydra-node builds report `X.Y.Z-<git sha>`, which is a distinct
		// version from a bare `X.Y.Z` and does not match it. Say so here: it is the
		// difference between a one-line fix and a hunt through the release notes.
		throw new HostIncompatibleError(
			`the hydra host runs ${capabilities.hydraVersion || 'an unknown version'} but this service expects ` +
				`${expected.hydraVersion}. Official hydra-node builds report a -<git sha> suffix; set ` +
				'HYDRA_EXPECTED_VERSION to the exact reported version',
		);
	}

	if (capabilities.scriptCatalogueHash === null) {
		throw new HostIncompatibleError(
			'the hydra host reports no script catalogue; its on-chain scripts cannot be verified',
		);
	}
	if (capabilities.scriptCatalogueHash !== expected.scriptCatalogueHash) {
		// The fingerprint is over a re-serialised document, so it cannot be
		// reproduced by hashing the hydra-node CLI output. Reporting the observed
		// value is the only way an operator can pin a Host they have reviewed.
		throw new HostIncompatibleError(
			`the hydra host script catalogue (${capabilities.scriptCatalogueHash}) does not match the catalogue ` +
				`reviewed by this service (${expected.scriptCatalogueHash}). If this host runs the reviewed Hydra ` +
				'release, set HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH to the observed fingerprint',
		);
	}

	if (capabilities.nodeSlots.capacity > 0 && capabilities.nodeSlots.used >= capabilities.nodeSlots.capacity) {
		throw new HostIncompatibleError(
			`the hydra host has no free node slots (${capabilities.nodeSlots.used}/${capabilities.nodeSlots.capacity}); ` +
				'free one by removing a finalised head, or register another host',
		);
	}

	if (capabilities.ledgerParamsHash === null) {
		throw new HostIncompatibleError(
			'the hydra host reports no ledger protocol parameters; it cannot run a head this service can transact on',
		);
	}

	if (expected.ledgerParamsHash !== capabilities.ledgerParamsHash) {
		throw new HostIncompatibleError(
			`the hydra host ledger protocol parameters (${capabilities.ledgerParamsHash}) do not match the ones this ` +
				`service builds against (${expected.ledgerParamsHash}); in-head script spends would fail ` +
				'PPViewHashesDontMatch. Point HYDRA_HOST_LEDGER_PARAMS_FILE at the reviewed ' +
				'packages/hydra-host/params/<network>.json, or regenerate that file from the pinned mesh line',
		);
	}
}
