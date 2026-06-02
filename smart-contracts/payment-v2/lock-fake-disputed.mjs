// Lock funds DIRECTLY in the Disputed state with external_dispute_unlock_time
// already in the past, so a subsequent `disputed-refund-withdraw.mjs` can
// settle it on the admin multisig path without going through the real state
// machine (lock → submit-result → set-refund-requested).
//
// This works because locking is a plain send-to-script — the Aiken validator
// only runs when the UTxO is *spent*, so no on-chain check rejects an
// arbitrary initial datum. The contract's WithdrawDisputed branch only
// requires: state == Disputed, non-empty result_hash, and validity_range
// starting after external_dispute_unlock_time.
//
// Tunables (env):
//   PAST_OFFSET_MS                  default 60000   timestamps placed this far in the past
//   LOCK_LOVELACE                   default 10000000 (10 ADA)
//   COLLATERAL_RETURN_LOVELACE      default  2000000 (2 ADA)
//   RESULT_HASH / RESULT_TEXT       override the auto-generated result hash
//   BUYER_RETURN_ADDRESS, SELLER_RETURN_ADDRESS   optional Some(addr)
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Transaction } from '@meshsdk/core';
import {
	addressData,
	assertHex,
	blockchainProvider,
	fetchChainTip,
	firstWalletAddress,
	hexFromEnv,
	loadPaymentScript,
	loadWallet,
	network,
	none,
	optionalHexFromEnv,
	readAddress,
	some,
	State,
	stateData,
	syncCostModelsFromChain,
} from './example-helpers.mjs';

await syncCostModelsFromChain();

const buyerWallet = loadWallet(1);
const buyerAddress = readAddress(1);
const sellerAddress = readAddress(2);
const { scriptAddress } = loadPaymentScript();

const PAST_OFFSET_MS = Number(process.env.PAST_OFFSET_MS ?? 60_000);
// Anchor on chain time, not wall-clock. The preprod chain's POSIX time
// (validity_range.lower_bound passed to the script) can lag wall-clock by 1-2
// minutes between blocks; if we set external_dispute_unlock_time from
// Date.now() the contract's must_start_after check fails because the chain's
// validity lower bound is still behind.
const tip = await fetchChainTip();
const pastTimestamp = BigInt(tip.posixMs - PAST_OFFSET_MS);

const externalDisputeUnlockTime = BigInt(process.env.EXTERNAL_DISPUTE_UNLOCK_TIME ?? pastTimestamp);
const submitResultTime = BigInt(process.env.SUBMIT_RESULT_TIME ?? pastTimestamp);
const unlockTime = BigInt(process.env.UNLOCK_TIME ?? pastTimestamp);
const payByTime = BigInt(process.env.PAY_BY_TIME ?? pastTimestamp);
const collateralReturnLovelace = BigInt(process.env.COLLATERAL_RETURN_LOVELACE ?? 2_000_000);
const lockLovelace = process.env.LOCK_LOVELACE ?? '10000000';

const resultHash =
	process.env.RESULT_HASH ??
	createHash('sha256')
		.update(process.env.RESULT_TEXT ?? 'fake-disputed-result')
		.digest('hex');
assertHex(resultHash, 'RESULT_HASH');
if (resultHash.length === 0) {
	throw new Error('RESULT_HASH must be non-empty — WithdrawDisputed requires a result hash');
}

const buyerReturnAddress = process.env.BUYER_RETURN_ADDRESS;
const sellerReturnAddress = process.env.SELLER_RETURN_ADDRESS;

const datum = {
	value: {
		alternative: 0,
		fields: [
			addressData(buyerAddress),
			buyerReturnAddress ? some(addressData(buyerReturnAddress)) : none(),
			addressData(sellerAddress),
			sellerReturnAddress ? some(addressData(sellerReturnAddress)) : none(),
			hexFromEnv('REFERENCE_KEY', 32),
			hexFromEnv('REFERENCE_SIGNATURE', 64),
			hexFromEnv('SELLER_NONCE', 32),
			hexFromEnv('BUYER_NONCE', 32),
			hexFromEnv('AGENT_IDENTIFIER', 32),
			collateralReturnLovelace,
			optionalHexFromEnv('INPUT_HASH'),
			resultHash,
			payByTime,
			submitResultTime,
			unlockTime,
			externalDisputeUnlockTime,
			0n,
			0n,
			stateData(State.Disputed),
		],
	},
	inline: true,
};

console.log(`Locking fake Disputed UTxO on ${network}`);
console.log(`  script address:                 ${scriptAddress}`);
console.log(`  buyer (wallet_1):               ${buyerAddress}`);
console.log(`  seller (wallet_2):              ${sellerAddress}`);
console.log(`  state:                          Disputed`);
console.log(`  result_hash:                    ${resultHash}`);
console.log(`  external_dispute_unlock_time:   ${new Date(Number(externalDisputeUnlockTime)).toISOString()} (in past)`);
console.log(`  lock lovelace:                  ${lockLovelace}`);

const tx = new Transaction({ initiator: buyerWallet, fetcher: blockchainProvider })
	.sendLovelace({ address: scriptAddress, datum }, lockLovelace)
	.setChangeAddress(await firstWalletAddress(buyerWallet))
	.setNetwork(network);

const unsigned = await tx.build();
const signed = await buyerWallet.signTx(unsigned);
const txHash = await buyerWallet.submitTx(signed);

console.log(`\nFake Disputed lock submitted:
    Tx ID: ${txHash}
    Output index: 0
    View: https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}

Settle via admin multisig (after ~30-60s confirmation):
    TX_HASH=${txHash} OUTPUT_INDEX=0 pnpm run withdraw-disputed
    # or rely on auto-pick:
    pnpm run withdraw-disputed
`);
