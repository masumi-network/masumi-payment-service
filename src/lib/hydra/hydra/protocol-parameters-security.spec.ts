import { expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { fetchHydraProtocolParameters, type HydraQueryTransport } from './node-control-queries';
import { HydraProtocolError } from './errors';

const paramsDirectory = new URL('../../../../packages/hydra-host/params/', import.meta.url);
const shippedParameters = JSON.parse(readFileSync(new URL('preprod.json', paramsDirectory), 'utf8')) as {
	utxoCostPerByte: number;
};

function transport(parameters: object): HydraQueryTransport {
	return { get: async <T>() => parameters as T };
}

it.each([100_000, Number.MAX_SAFE_INTEGER, 0, 4311])(
	'refuses untrusted utxoCostPerByte %i before returning builder parameters',
	async (utxoCostPerByte) => {
		await expect(
			fetchHydraProtocolParameters(transport({ ...shippedParameters, utxoCostPerByte }), new Set()),
		).rejects.toBeInstanceOf(HydraProtocolError);
	},
);

it('accepts the independently shipped head byte cost and tolerates additive fields', async () => {
	await expect(
		fetchHydraProtocolParameters(transport({ ...shippedParameters, futureField: true }), new Set()),
	).resolves.toMatchObject({ coinsPerUtxoSize: 4310 });
});

it('keeps the accepted byte cost consistent with every shipped head ledger', async () => {
	for (const file of readdirSync(paramsDirectory).filter((name) => name.endsWith('.json'))) {
		const parameters = JSON.parse(readFileSync(new URL(file, paramsDirectory), 'utf8')) as object;
		await expect(fetchHydraProtocolParameters(transport(parameters), new Set())).resolves.toMatchObject({
			coinsPerUtxoSize: 4310,
		});
		await expect(
			fetchHydraProtocolParameters(transport({ ...parameters, utxoCostPerByte: 4311 }), new Set()),
		).rejects.toBeInstanceOf(HydraProtocolError);
	}
});
