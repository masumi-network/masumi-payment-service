/**
 * The KZG accumulator a Hydra snapshot commits to.
 *
 * Split from snapshot-verification because it shares nothing with it but a
 * string: this side is field arithmetic over BLS12-381 — polynomial roots, an
 * NTT-backed multiply, and a multi-scalar multiplication against a bundled
 * trusted setup — while that side is about what a snapshot means. The boundary
 * is `computeHydraAccumulatorHash`, which takes serialized outputs and returns
 * a commitment; nothing else here escapes.
 *
 * The trusted setup is verified against its SHA-256 on first use and cached,
 * because a substituted setup would let a forged accumulator verify.
 */

import { bls12_381 } from 'ethereum-cryptography/bls.js';
import { blake2b } from 'ethereum-cryptography/blake2b.js';
import { createHash } from 'node:crypto';

import { HydraProtocolError } from './errors';
import { HYDRA_KZG_G1_0 } from './kzg/hydra-kzg-g1-0';
import { HYDRA_KZG_G1_1 } from './kzg/hydra-kzg-g1-1';
import { HYDRA_KZG_G1_2 } from './kzg/hydra-kzg-g1-2';
import { HYDRA_KZG_G1_3 } from './kzg/hydra-kzg-g1-3';
import { HYDRA_KZG_G1_4 } from './kzg/hydra-kzg-g1-4';
import { HYDRA_KZG_G1_5 } from './kzg/hydra-kzg-g1-5';
import { HYDRA_KZG_G1_6 } from './kzg/hydra-kzg-g1-6';
import { HYDRA_KZG_G1_7 } from './kzg/hydra-kzg-g1-7';
import { MAX_HYDRA_SNAPSHOT_OUTPUTS } from './schemas';

const BLS_SCALAR_ORDER = bls12_381.fields.Fr.ORDER;
const BLS_SCALAR_GENERATOR = 7n;
const TRUSTED_SETUP_POINT_HEX_LENGTH = 96;
const TRUSTED_SETUP_SHA256 = '08797579f6cfd5788eddc1a215d64dcfabd04acbcaf2953fb2c1afb830f43315';
const TRUSTED_SETUP_G1_HEX =
	HYDRA_KZG_G1_0 +
	HYDRA_KZG_G1_1 +
	HYDRA_KZG_G1_2 +
	HYDRA_KZG_G1_3 +
	HYDRA_KZG_G1_4 +
	HYDRA_KZG_G1_5 +
	HYDRA_KZG_G1_6 +
	HYDRA_KZG_G1_7;

function mod(value: bigint): bigint {
	const reduced = value % BLS_SCALAR_ORDER;
	return reduced < 0n ? reduced + BLS_SCALAR_ORDER : reduced;
}

function modPow(base: bigint, exponent: bigint): bigint {
	let result = 1n;
	let factor = mod(base);
	let remaining = exponent;
	while (remaining > 0n) {
		if ((remaining & 1n) === 1n) result = mod(result * factor);
		factor = mod(factor * factor);
		remaining >>= 1n;
	}
	return result;
}

function ntt(values: bigint[], inverse: boolean): void {
	const size = values.length;
	for (let index = 1, reversed = 0; index < size; index++) {
		let bit = size >> 1;
		for (; (reversed & bit) !== 0; bit >>= 1) reversed ^= bit;
		reversed ^= bit;
		if (index < reversed) [values[index], values[reversed]] = [values[reversed], values[index]];
	}
	for (let length = 2; length <= size; length <<= 1) {
		let root = modPow(BLS_SCALAR_GENERATOR, (BLS_SCALAR_ORDER - 1n) / BigInt(length));
		if (inverse) root = modPow(root, BLS_SCALAR_ORDER - 2n);
		for (let offset = 0; offset < size; offset += length) {
			let factor = 1n;
			for (let index = 0; index < length / 2; index++) {
				const even = values[offset + index];
				const odd = mod(values[offset + index + length / 2] * factor);
				values[offset + index] = mod(even + odd);
				values[offset + index + length / 2] = mod(even - odd);
				factor = mod(factor * root);
			}
		}
	}
	if (inverse) {
		const inverseSize = modPow(BigInt(size), BLS_SCALAR_ORDER - 2n);
		for (let index = 0; index < size; index++) values[index] = mod(values[index] * inverseSize);
	}
}

function multiplyPolynomials(left: bigint[], right: bigint[]): bigint[] {
	const resultLength = left.length + right.length - 1;
	if (Math.min(left.length, right.length) <= 32) {
		const result = Array<bigint>(resultLength).fill(0n);
		for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
			for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
				result[leftIndex + rightIndex] = mod(result[leftIndex + rightIndex] + left[leftIndex] * right[rightIndex]);
			}
		}
		return result;
	}
	let size = 1;
	while (size < resultLength) size <<= 1;
	const transformedLeft = [...left, ...Array<bigint>(size - left.length).fill(0n)];
	const transformedRight = [...right, ...Array<bigint>(size - right.length).fill(0n)];
	ntt(transformedLeft, false);
	ntt(transformedRight, false);
	for (let index = 0; index < size; index++) {
		transformedLeft[index] = mod(transformedLeft[index] * transformedRight[index]);
	}
	ntt(transformedLeft, true);
	return transformedLeft.slice(0, resultLength);
}

function polynomialFromRoots(roots: bigint[]): bigint[] {
	if (roots.length === 0) return [1n];
	let polynomials = roots.map((root) => [root, 1n]);
	while (polynomials.length > 1) {
		const next: bigint[][] = [];
		for (let index = 0; index < polynomials.length; index += 2) {
			const right = polynomials[index + 1];
			next.push(right ? multiplyPolynomials(polynomials[index], right) : polynomials[index]);
		}
		polynomials = next;
	}
	return polynomials[0];
}

let trustedSetupChecked = false;
const trustedSetupPoints: Array<ReturnType<typeof bls12_381.G1.ProjectivePoint.fromHex>> = [];

function getTrustedSetupPoints(count: number) {
	if (!trustedSetupChecked) {
		const setupBytes = Buffer.from(TRUSTED_SETUP_G1_HEX, 'hex');
		if (
			TRUSTED_SETUP_G1_HEX.length !== 4096 * TRUSTED_SETUP_POINT_HEX_LENGTH ||
			createHash('sha256').update(setupBytes).digest('hex') !== TRUSTED_SETUP_SHA256
		) {
			throw new HydraProtocolError('Bundled Hydra KZG trusted setup failed its integrity check');
		}
		trustedSetupChecked = true;
	}
	while (trustedSetupPoints.length < count) {
		const index = trustedSetupPoints.length;
		const pointHex = TRUSTED_SETUP_G1_HEX.slice(
			index * TRUSTED_SETUP_POINT_HEX_LENGTH,
			(index + 1) * TRUSTED_SETUP_POINT_HEX_LENGTH,
		);
		trustedSetupPoints.push(bls12_381.G1.ProjectivePoint.fromHex(pointHex));
	}
	return trustedSetupPoints.slice(0, count);
}

export function computeHydraAccumulatorHash(serializedOutputs: Iterable<string>): string {
	const outputs = [...serializedOutputs];
	if (outputs.length > MAX_HYDRA_SNAPSHOT_OUTPUTS) {
		throw new HydraProtocolError(`Hydra snapshot exceeded the ${MAX_HYDRA_SNAPSHOT_OUTPUTS}-output KZG limit`);
	}
	const roots = outputs.map((output) => {
		const outputHash = createHash('sha256').update(Buffer.from(output, 'hex')).digest();
		return BigInt(`0x${Buffer.from(blake2b(outputHash, 28)).toString('hex')}`);
	});
	const coefficients = polynomialFromRoots(roots);
	const points = getTrustedSetupPoints(coefficients.length);
	const nonzeroPoints = [];
	const nonzeroScalars = [];
	for (let index = 0; index < coefficients.length; index++) {
		if (coefficients[index] === 0n) continue;
		nonzeroPoints.push(points[index]);
		nonzeroScalars.push(coefficients[index]);
	}
	const commitment = bls12_381.G1.ProjectivePoint.msm(nonzeroPoints, nonzeroScalars);
	return Buffer.from(blake2b(commitment.toRawBytes(true), 32)).toString('hex');
}
