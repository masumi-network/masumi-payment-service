/**
 * VERIFIED: The binary in the locally cached
 * `hydra-review-host:etcd-3.5.35` image reports this version and this
 * `--hydra-script-catalogue` document. The hash uses JSON.stringify on the
 * parsed document, as `hashOf` in client.ts does. The source image digest is
 * the pin in packages/hydra-host/Dockerfile; the local image has no source
 * attestation, so the test below checks the recorded catalogue itself.
 *
 * Review the new binary and change this record in code before an upgrade.
 * A Host response is never evidence for changing this pin.
 */
export const REVIEWED_HYDRA_RELEASE = {
	upstreamImageDigest: 'sha256:608ae9b336209a18d7f3c42f7ca2d73c51dcb1b90732e533dd3b8017485fa98a',
	version: '2.4.1-099f5dd775d8640047d0074edef294c1b39a600d',
	catalogueHash: 'sha256:5dad151a3623da9c04a981971763164a18b58c44ac18963a7df814a56eadc14a',
	catalogue: {
		crsScriptHash: '09db7ee6cf7a4b358dd5c8a2f19d2c048336ffc5a01ef35a47ca7072',
		crsScriptSize: 2736,
		depositScriptHash: 'eafae2c32f99ab347c7bb15961e0e84c74305f9088c1a7b8abf88e7f',
		depositScriptSize: 2117,
		headScriptHash: '1d511733200df551c8cd8cddb3160ed39087af815638be37a1b80ffd',
		headScriptSize: 12962,
		mintingScriptHash: '603f261bc5a01f5f4ed988cc07a40a130b94e6820c28e9affde82d9e',
		mintingScriptSize: 4971,
	},
} as const;
