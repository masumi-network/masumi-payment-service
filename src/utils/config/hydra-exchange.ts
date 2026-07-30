/**
 * Which port a Hydra Host serves its Exchange Plane on.
 *
 * One setting for the whole fleet rather than a column per Host: the plane is
 * part of the Host image, so its port is a property of the deployment
 * convention rather than of any individual Host. A deployment that genuinely
 * needs to vary it per Host has a reverse proxy in front, which is where that
 * variation belongs.
 *
 * It matters because the URL derived from it is signed into every invite we
 * issue and is where counterparties will try to reach us. Getting it wrong does
 * not fail here — it fails when someone tries to redeem.
 */

const DEFAULT_EXCHANGE_PORT = 8444;

export function hydraExchangePort(): number {
	const raw = process.env.HYDRA_HOST_EXCHANGE_PORT;
	if (raw === undefined || raw.trim() === '') {
		return DEFAULT_EXCHANGE_PORT;
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`HYDRA_HOST_EXCHANGE_PORT must be a TCP port, received ${JSON.stringify(raw)}`);
	}
	return parsed;
}
