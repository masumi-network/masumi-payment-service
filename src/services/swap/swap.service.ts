import { Lucid, Blockfrost, C } from 'lucid-cardano';
import { TxBuilderLucidV3 } from '@sundaeswap/core/lucid';
import { QueryProviderSundaeSwap } from '@sundaeswap/core';
import { AssetAmount } from '@sundaeswap/asset';
import { ESwapType, EDatumType } from '@sundaeswap/core';
import { SundaeUtils } from '@sundaeswap/core/utilities';
import type { IPoolData } from '@sundaeswap/core';
import { logger } from '@/utils/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

export interface Token {
	policyId: string;
	assetName: string;
	name: string;
}

function tokenIsAda(token: Token): boolean {
	return !token.policyId || token.policyId === '' || token.policyId.toLowerCase() === 'native';
}

/** Build assetId from API token (policyId + assetName) for comparison with pool assetId. */
function tokenToAssetId(token: Token): string {
	if (tokenIsAda(token)) return '';
	const nameHex =
		!token.assetName || token.assetName === ''
			? ''
			: /^[0-9a-fA-F]+$/i.test(token.assetName)
				? token.assetName
				: Buffer.from(token.assetName, 'utf8').toString('hex');
	return nameHex ? `${token.policyId}.${nameHex}` : `${token.policyId}.`;
}

function requestedOutputMatchesPool(toToken: Token, expectedOutputAsset: IPoolData['assetA']): boolean {
	const requestedAda = tokenIsAda(toToken);
	const expectedAda = SundaeUtils.isAdaAsset(expectedOutputAsset);
	if (requestedAda && expectedAda) return true;
	if (requestedAda !== expectedAda) return false;
	return SundaeUtils.isAssetIdsEqual(tokenToAssetId(toToken), expectedOutputAsset.assetId);
}

export interface SwapResult {
	txHash: string;
	walletAddress: string;
}

export interface SwapParams {
	mnemonic: string;
	fromAmount: number;
	fromToken: Token;
	toToken: Token;
	poolId: string;
	slippage?: number;
	/** Test-only: inflate minReceivable by this factor so the scooper never fills the order */
	outputMultiplier?: number;
}

async function initializeLucid(blockfrostApiKey: string): Promise<Lucid> {
	return await Lucid.new(new Blockfrost('https://cardano-mainnet.blockfrost.io/api/v0', blockfrostApiKey), 'Mainnet');
}

export async function getWalletFromMnemonic(
	mnemonic: string,
	blockfrostApiKey: string,
): Promise<{ address: string; lucid: Lucid }> {
	const lucid = await initializeLucid(blockfrostApiKey);
	lucid.selectWalletFromSeed(mnemonic);
	return {
		address: await lucid.wallet.address(),
		lucid,
	};
}

export interface PoolEstimateParams {
	fromToken: Token;
	toToken: Token;
	poolId: string;
}

export interface PoolEstimateResult {
	/** How many toToken units per 1 fromToken (human-readable, accounting for decimals & fee). */
	rate: number;
	fee: number;
	fromDecimals: number;
	toDecimals: number;
}

/**
 * Query the SundaeSwap pool and compute a conversion rate using constant-product AMM math.
 * rate = (bReserve / (aReserve + 1 unit)) * (1 - fee)
 */
export async function getPoolEstimate(params: PoolEstimateParams): Promise<PoolEstimateResult> {
	const queryProvider = new QueryProviderSundaeSwap('mainnet');
	const poolData = await queryProvider.findPoolData({ ident: params.poolId });

	const fromTokenAssetId = tokenToAssetId(params.fromToken);
	const matchesAssetA = SundaeUtils.isAssetIdsEqual(fromTokenAssetId, poolData.assetA.assetId);
	const matchesAssetB = SundaeUtils.isAssetIdsEqual(fromTokenAssetId, poolData.assetB.assetId);
	if (!matchesAssetA && !matchesAssetB) {
		throw new Error(
			`From token does not match either asset in this pool. Pool assets: ${poolData.assetA.assetId || 'ADA'}, ${poolData.assetB.assetId || 'ADA'}; requested: ${fromTokenAssetId || 'ADA'}.`,
		);
	}

	const fromAsset = matchesAssetA ? poolData.assetA : poolData.assetB;
	const toAsset = matchesAssetA ? poolData.assetB : poolData.assetA;

	const aReserve = matchesAssetA ? poolData.liquidity.aReserve : poolData.liquidity.bReserve;
	const bReserve = matchesAssetA ? poolData.liquidity.bReserve : poolData.liquidity.aReserve;

	// Constant-product: output = (bReserve * dx) / (aReserve + dx), then subtract fee
	// For rate per 1 unit: dx = 10^fromDecimals (1 whole token)
	const dx = BigInt(10 ** fromAsset.decimals);
	const rawOutput = (bReserve * dx) / (aReserve + dx);
	const fee = poolData.currentFee;
	const outputAfterFee = Number(rawOutput) * (1 - fee);
	const rate = outputAfterFee / 10 ** toAsset.decimals;

	return {
		rate,
		fee,
		fromDecimals: fromAsset.decimals,
		toDecimals: toAsset.decimals,
	};
}

export async function swapTokens(params: SwapParams, blockfrostApiKey: string): Promise<SwapResult> {
	const startTime = Date.now();
	try {
		logger.info('Initializing swap transaction', {
			component: 'swap-service',
			amount: params.fromAmount,
			poolId: params.poolId,
		});

		const wallet = await getWalletFromMnemonic(params.mnemonic, blockfrostApiKey);

		const lovelaceBalance = await wallet.lucid.wallet.getUtxos();
		const adaBalance =
			lovelaceBalance.reduce((acc: bigint, utxo) => {
				const lovelace = (utxo.assets as { lovelace: bigint }).lovelace;
				return acc + lovelace;
			}, 0n) / 1000000n;

		logger.info('Wallet initialized', {
			component: 'swap-service',
			walletAddress: wallet.address,
			adaBalance: String(adaBalance),
		});

		const queryProvider = new QueryProviderSundaeSwap('mainnet');
		const txBuilder = new TxBuilderLucidV3(wallet.lucid, 'mainnet');

		logger.info('Querying pool data', {
			component: 'swap-service',
			poolId: params.poolId,
		});

		const poolData = await queryProvider.findPoolData({
			ident: params.poolId,
		});

		const fromTokenAssetId = tokenToAssetId(params.fromToken);
		const matchesAssetA = SundaeUtils.isAssetIdsEqual(fromTokenAssetId, poolData.assetA.assetId);
		const matchesAssetB = SundaeUtils.isAssetIdsEqual(fromTokenAssetId, poolData.assetB.assetId);
		if (!matchesAssetA && !matchesAssetB) {
			throw new Error(
				`From token does not match either asset in this pool. Pool assets: ${poolData.assetA.assetId || 'ADA'}, ${poolData.assetB.assetId || 'ADA'}; requested: ${fromTokenAssetId || 'ADA'}.`,
			);
		}
		const suppliedAssetMetadata = matchesAssetA ? poolData.assetA : poolData.assetB;
		const scale = 10 ** suppliedAssetMetadata.decimals;
		const suppliedAsset = new AssetAmount(BigInt(Math.round(params.fromAmount * scale)), suppliedAssetMetadata);

		const expectedOutputAsset = matchesAssetA ? poolData.assetB : poolData.assetA;
		if (!requestedOutputMatchesPool(params.toToken, expectedOutputAsset)) {
			throw new Error(
				`Requested output token does not match pool output asset. Pool receives ${expectedOutputAsset.assetId}; requested ${tokenToAssetId(params.toToken) || 'ADA'}.`,
			);
		}

		const slippage = params.slippage ?? 0.03;

		// Calculate swap type: LIMIT with inflated minReceivable for test, or MARKET normally
		const swapType = params.outputMultiplier
			? (() => {
					const multiplier = params.outputMultiplier ?? 1;
					const aReserve = matchesAssetA ? poolData.liquidity.aReserve : poolData.liquidity.bReserve;
					const bReserve = matchesAssetA ? poolData.liquidity.bReserve : poolData.liquidity.aReserve;
					const inputRaw = BigInt(Math.round(params.fromAmount * scale));
					const rawOutput = (bReserve * inputRaw) / (aReserve + inputRaw);
					const inflatedOutput = rawOutput * BigInt(Math.round(multiplier));
					return {
						type: ESwapType.LIMIT as const,
						minReceivable: new AssetAmount(inflatedOutput, expectedOutputAsset),
					};
				})()
			: {
					type: ESwapType.MARKET as const,
					slippage,
				};

		const args = {
			swapType,
			pool: poolData,
			orderAddresses: {
				DestinationAddress: {
					address: wallet.address,
					datum: {
						type: EDatumType.NONE as const,
					},
				},
			},
			suppliedAsset: suppliedAsset,
		};

		logger.info('Building swap transaction', {
			component: 'swap-service',
			slippage,
			outputMultiplier: params.outputMultiplier,
		});

		const { build } = await txBuilder.swap(args);
		const builtTx = await build();
		const { submit } = await builtTx.sign();

		logger.info('Submitting transaction', {
			component: 'swap-service',
		});

		const txHash = await submit();

		logger.info('Transaction submitted successfully', {
			component: 'swap-service',
			txHash,
			walletAddress: wallet.address,
			duration: Date.now() - startTime,
		});

		return {
			txHash,
			walletAddress: wallet.address,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		logger.error('Swap failed', {
			component: 'swap-service',
			error: errorMessage,
			duration: Date.now() - startTime,
		});
		throw error;
	}
}

export interface CancelSwapParams {
	mnemonic: string;
	orderTxHash: string;
	orderOutputIndex: number;
}

export async function cancelSwapOrder(params: CancelSwapParams, blockfrostApiKey: string): Promise<{ txHash: string }> {
	const startTime = Date.now();
	try {
		logger.info('Initializing swap cancel transaction', {
			component: 'swap-service',
			orderTxHash: params.orderTxHash,
			orderOutputIndex: params.orderOutputIndex,
		});

		const wallet = await getWalletFromMnemonic(params.mnemonic, blockfrostApiKey);
		const txBuilder = new TxBuilderLucidV3(wallet.lucid, 'mainnet', new QueryProviderSundaeSwap('mainnet'));

		const cancelResult = await txBuilder.cancel({
			utxo: { hash: params.orderTxHash, index: params.orderOutputIndex },
			ownerAddress: wallet.address,
		});
		const builtTx = await cancelResult.build();

		// The native WASM UPLC evaluator consistently underestimates script execution
		// fees for SundaeSwap cancel transactions. Always bump the fee by 50% and
		// reconstruct the transaction body before signing.
		const origTx = builtTx.builtTx.txComplete;
		const origBody = origTx.body();
		const origOutputs = origBody.outputs();
		const originalFee = BigInt(origBody.fee().to_str());
		const bumpedFee = originalFee + originalFee / 2n;
		const feeDiff = bumpedFee - originalFee;

		logger.info('Bumping cancel tx fee', {
			component: 'swap-service',
			originalFee: String(originalFee),
			bumpedFee: String(bumpedFee),
		});

		// Rebuild outputs, reducing the change (last) output to compensate for the higher fee.
		const newOutputs = C.TransactionOutputs.new();
		for (let i = 0; i < origOutputs.len(); i++) {
			const output = origOutputs.get(i);
			if (i === origOutputs.len() - 1) {
				const val = output.amount();
				const newCoin = BigInt(val.coin().to_str()) - feeDiff;
				if (newCoin <= 0n) throw new Error('Fee bump exceeds change output');
				const newVal = C.Value.new(C.BigNum.from_str(String(newCoin)));
				const multiasset = val.multiasset();
				if (multiasset) newVal.set_multiasset(multiasset);
				const newOutput = C.TransactionOutput.new(output.address(), newVal);
				const datum = output.datum();
				if (datum) newOutput.set_datum(datum);
				const scriptRef = output.script_ref();
				if (scriptRef) newOutput.set_script_ref(scriptRef);
				newOutputs.add(newOutput);
			} else {
				newOutputs.add(output);
			}
		}

		const newBody = C.TransactionBody.new(
			origBody.inputs(),
			newOutputs,
			C.BigNum.from_str(String(bumpedFee)),
			origBody.ttl(),
		);
		const certs = origBody.certs();
		if (certs) newBody.set_certs(certs);
		const collateral = origBody.collateral();
		if (collateral) newBody.set_collateral(collateral);
		const requiredSigners = origBody.required_signers();
		if (requiredSigners) newBody.set_required_signers(requiredSigners);
		const scriptDataHash = origBody.script_data_hash();
		if (scriptDataHash) newBody.set_script_data_hash(scriptDataHash);
		// Collateral must be ≥ 150% of the fee. Bump total_collateral proportionally
		// and reduce collateral_return to compensate.
		const totalCollateral = origBody.total_collateral();
		const collateralReturn = origBody.collateral_return();
		if (totalCollateral && collateralReturn) {
			const oldCollateral = BigInt(totalCollateral.to_str());
			const newCollateral = (bumpedFee * 3n) / 2n + bumpedFee / 10n; // 160% of fee
			const collateralDiff = newCollateral - oldCollateral;
			newBody.set_total_collateral(C.BigNum.from_str(String(newCollateral)));
			const retVal = collateralReturn.amount();
			const retCoin = BigInt(retVal.coin().to_str()) - collateralDiff;
			if (retCoin <= 0n) throw new Error('Collateral bump exceeds collateral return output');
			const newRetVal = C.Value.new(C.BigNum.from_str(String(retCoin)));
			const retMultiasset = retVal.multiasset();
			if (retMultiasset) newRetVal.set_multiasset(retMultiasset);
			const newCollateralReturn = C.TransactionOutput.new(collateralReturn.address(), newRetVal);
			newBody.set_collateral_return(newCollateralReturn);
		} else {
			if (totalCollateral) newBody.set_total_collateral(totalCollateral);
			if (collateralReturn) newBody.set_collateral_return(collateralReturn);
		}
		const referenceInputs = origBody.reference_inputs();
		if (referenceInputs) newBody.set_reference_inputs(referenceInputs);

		// Use Lucid's fromTx → sign → complete flow. Lucid's TxComplete.complete()
		// uses TransactionWitnessSetBuilder.build_unchecked() which preserves all
		// script witnesses (redeemers, datums, plutus scripts). Calling wallet.signTx()
		// directly uses build() which drops them.
		const unsignedTx = C.Transaction.new(newBody, origTx.witness_set(), origTx.auxiliary_data());
		const txHex = Buffer.from(unsignedTx.to_bytes()).toString('hex');
		const txComplete = wallet.lucid.fromTx(txHex);
		const signed = await txComplete.sign().complete();
		const txHash = await signed.submit();

		logger.info('Cancel transaction submitted', {
			component: 'swap-service',
			txHash,
			duration: Date.now() - startTime,
		});

		return { txHash };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		logger.error('Swap cancel failed', {
			component: 'swap-service',
			error: errorMessage,
			duration: Date.now() - startTime,
		});
		throw error;
	}
}

export async function findOrderOutputIndex(
	txHash: string,
	blockfrost: BlockFrostAPI,
	walletAddress: string,
): Promise<number> {
	const txUtxos = await blockfrost.txsUtxos(txHash);

	// The order output is the one sent to the script address (not back to the wallet)
	for (const output of txUtxos.outputs) {
		if (output.address !== walletAddress) {
			return output.output_index;
		}
	}

	throw new Error(`Could not find order output in transaction ${txHash}`);
}
