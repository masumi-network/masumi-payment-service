/**
 * Check that one output is in a Hydra snapshot's accumulator, without the rest
 * of the UTxO set.
 *
 * The snapshot signature covers `accumulator` = blake2b-256(C), where C is the
 * KZG commitment [P(τ)]₁ to P(x) = ∏(x + rᵢ) over every output root. A witness
 * π = [P(x) / (x + r)]₁ shows that root r divides P, which is the pairing
 * check e(C, [1]₂) = e(π, [τ]₂ + r·[1]₂). This is the equation Hydra's head
 * contract checks for a partial fanout (Hydra 2.4.1
 * `hydra-plutus/src/Hydra/Contract/CRS.hs` `checkMembershipPairing`).
 */
import { bls12_381 } from 'ethereum-cryptography/bls.js';
import { HydraProtocolError } from './errors';
import { hydraAccumulatorHashOfCommitment, hydraAccumulatorRoot } from './snapshot-accumulator';

/**
 * `g2_monomial[0]` and `[1]` of Hydra 2.4.1 `hydra-plutus/trusted_setup.json`
 * (sha256 9a8dcad9eaba191842f57d23d14674cbdea4b3cf7912fcc477821264dfe0c042),
 * the same ceremony as the bundled G1 points in `./kzg`.
 */
const G2_ONE = bls12_381.G2.ProjectivePoint.fromHex(
	'93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8',
);
const G2_TAU = bls12_381.G2.ProjectivePoint.fromHex(
	'b5bfd7dd8cdeb128843bc287230af38926187075cbfbefa81009a2ce615ac53d2914e5870cb452d2afaaab24f3499f72185cbfee53492714734429b7b38608e23926c911cceceac9a36851477ba4c60b087041de621000edc98edada20c1def2',
);

const COMPRESSED_G1 = /^[0-9a-f]{96}$/;

/**
 * Throws unless `commitment` hashes to the signed `accumulator` and `witness`
 * proves `serializedOutput` (Plutus TxOut bytes, hex) is one of its outputs.
 * Verify the snapshot signatures first: the accumulator is only as good as they are.
 */
export function verifyHydraMembership(params: {
	accumulator: string;
	commitment: string;
	witness: string;
	serializedOutput: string;
}): void {
	const { accumulator, commitment, witness, serializedOutput } = params;
	if (!COMPRESSED_G1.test(commitment) || !COMPRESSED_G1.test(witness)) {
		throw new HydraProtocolError('Membership commitment and witness must be compressed G1 points');
	}
	const commitmentBytes = Buffer.from(commitment, 'hex');
	if (hydraAccumulatorHashOfCommitment(commitmentBytes) !== accumulator.toLowerCase()) {
		throw new HydraProtocolError('Membership commitment does not hash to the signed accumulator');
	}
	let commitmentPoint;
	let witnessPoint;
	try {
		// fromHex checks the point is on the curve and in the prime-order subgroup.
		commitmentPoint = bls12_381.G1.ProjectivePoint.fromHex(commitmentBytes);
		witnessPoint = bls12_381.G1.ProjectivePoint.fromHex(witness);
	} catch (error) {
		throw new HydraProtocolError('Membership commitment or witness is not a valid G1 point', { cause: error });
	}
	const shifted = G2_TAU.add(G2_ONE.multiply(hydraAccumulatorRoot(serializedOutput)));
	const left = bls12_381.pairing(commitmentPoint, G2_ONE);
	const right = bls12_381.pairing(witnessPoint, shifted);
	if (!bls12_381.fields.Fp12.eql(left, right)) {
		throw new HydraProtocolError('Membership witness does not prove the output is in the snapshot');
	}
}
