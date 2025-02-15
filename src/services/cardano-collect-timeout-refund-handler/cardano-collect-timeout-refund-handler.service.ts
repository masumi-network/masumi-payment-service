import { $Enums } from "@prisma/client";
import { Sema } from "async-sema";
import { prisma } from '@/utils/db';
import { BlockfrostProvider, SLOT_CONFIG_NETWORK, Transaction, unixTimeToEnclosingSlot } from "@meshsdk/core";
import { logger } from "@/utils/logger";
import * as cbor from "cbor";
import { getPaymentScriptFromNetworkHandlerV1 } from "@/utils/generator/contract-generator";
import { convertNetwork } from "@/utils/converter/network-convert";
import { generateWalletExtended } from "@/utils/generator/wallet-generator";
import { decodeV1ContractDatum } from "@/utils/converter/string-datum-convert";
import { lockAndQueryPurchases } from "@/utils/db/lock-and-query-purchases";

const updateMutex = new Sema(1);

export async function collectTimeoutRefundsV1() {
    const acquiredMutex = await updateMutex.tryAcquire();
    //if we are already performing an update, we wait for it to finish and return
    if (!acquiredMutex)
        return await updateMutex.acquire();

    try {
        const networkChecksWithWalletLocked = await lockAndQueryPurchases(
            {
                purchasingStatus: $Enums.PurchasingRequestStatus.RefundInitiated,
                smartContractWalletPendingTransaction: null,
                resultHash: null,
                submitResultTime: { lte: Date.now() + 1000 * 60 * 25 }, //add 25 minutes for block time
                errorType: null
            }
        )

        await Promise.allSettled(networkChecksWithWalletLocked.map(async (networkCheck) => {

            if (networkCheck.PurchaseRequests.length == 0)
                return;

            const network = convertNetwork(networkCheck.network)


            const blockchainProvider = new BlockfrostProvider(networkCheck.NetworkHandlerConfig.rpcProviderApiKey, undefined);


            const purchaseRequests = networkCheck.PurchaseRequests;

            if (purchaseRequests.length == 0)
                return;
            //we can only allow one transaction per wallet
            const deDuplicatedRequests: ({
                SmartContractWallet: ({
                    Secret: {
                        id: string; createdAt: Date; updatedAt: Date; secret: string;
                    };
                } & {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    walletVkey: string;
                    secretId: string;
                    pendingTransactionId: string | null;
                    walletAddress: string;
                    networkHandlerId: string;
                    note: string | null;
                }) | null;
            } & {
                id: string;
                createdAt: Date; updatedAt: Date;
                lastCheckedAt: Date | null;
                CurrentStatus: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    timestamp: Date;
                    status: $Enums.PurchasingRequestStatus;
                    Transaction: {
                        txHash: string | null;
                    } | null;
                    errorNote: string | null; errorRequiresManualReview: boolean | null;
                    errorType: $Enums.PurchaseRequestErrorType | null;
                }
                networkHandlerId: string;
                sellerWalletId: string;
                smartContractWalletId: string | null;
                blockchainIdentifier: string;
                submitResultTime: bigint;
                unlockTime: bigint;
                refundTime: bigint;
                requestedById: string;

            })[] = []
            for (const request of purchaseRequests) {
                if (request.smartContractWalletId == null)
                    continue;
                if (deDuplicatedRequests.some(r => r.smartContractWalletId == request.smartContractWalletId))
                    continue;
                deDuplicatedRequests.push(request);
            }

            await Promise.allSettled(deDuplicatedRequests.map(async (request) => {

                const purchasingWallet = request.SmartContractWallet;
                if (purchasingWallet == null)
                    throw new Error("Purchasing wallet not found");
                const encryptedSecret = purchasingWallet.Secret.secret;

                const { wallet, utxos, address } = await generateWalletExtended(networkCheck.network, networkCheck.NetworkHandlerConfig.rpcProviderApiKey, encryptedSecret)
                if (utxos.length === 0) {
                    //this is if the seller wallet is empty
                    throw new Error('No UTXOs found in the wallet. Wallet is empty.');
                }

                const { script, smartContractAddress } = await getPaymentScriptFromNetworkHandlerV1(networkCheck)

                const txHash = request.CurrentStatus?.Transaction?.txHash;
                if (txHash == null) {
                    throw new Error('Transaction hash not found');
                }
                const utxoByHash = await blockchainProvider.fetchUTxOs(
                    txHash,
                );

                const utxo = utxoByHash.find((utxo) => utxo.input.txHash == txHash);

                if (!utxo) {
                    throw new Error('UTXO not found');
                }

                const utxoDatum = utxo.output.plutusData;
                if (!utxoDatum) {
                    throw new Error('No datum found in UTXO');
                }

                const decodedDatum = cbor.decode(Buffer.from(utxoDatum, 'hex'));
                const decodedContract = decodeV1ContractDatum(decodedDatum)
                if (decodedContract == null) {
                    throw new Error('Invalid datum');
                }

                const redeemer = {
                    data: {
                        alternative: 3,
                        fields: [],
                    },
                };
                const invalidBefore =
                    unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK[network]) - 1;

                const invalidAfter =
                    unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK[network]) + 1;

                const unsignedTx = new Transaction({ initiator: wallet })
                    .redeemValue({
                        value: utxo,
                        script: script,
                        redeemer: redeemer,
                    }).setMetadata(674, {
                        msg: ["Masumi", "RefundCollectionAfterTimeout"],
                    })
                    .sendAssets(
                        {
                            address: address,
                        },
                        utxo.output.amount
                    )
                    .setChangeAddress(address)
                    .setRequiredSigners([address]);

                unsignedTx.txBuilder.invalidBefore(invalidBefore);
                unsignedTx.txBuilder.invalidHereafter(invalidAfter);

                const buildTransaction = await unsignedTx.build();
                const signedTx = await wallet.signTx(buildTransaction);
                await prisma.purchaseRequest.update({
                    where: { id: request.id }, data: {
                        CurrentStatus: {
                            create: {
                                status: $Enums.PurchasingRequestStatus.RefundInitiated,
                                timestamp: new Date(),
                                Transaction: {
                                    create: {
                                        txHash: null,
                                        BlocksWallet: { connect: { id: purchasingWallet.id } }
                                    }
                                }
                            }
                        },
                        StatusHistory: { connect: { id: request.CurrentStatus.id } },

                    }
                })

                //submit the transaction to the blockchain
                const newTxHash = await wallet.submitTx(signedTx);
                await prisma.purchaseRequest.update({
                    where: { id: request.id }, data: {
                        CurrentStatus: {
                            update: {
                                Transaction: {
                                    update: {
                                        txHash: newTxHash
                                    }
                                }
                            }
                        }
                    }
                })



                logger.info(`Created withdrawal transaction:
                  Tx ID: ${txHash}
                  View (after a bit) on https://${network === 'preprod'
                        ? 'preprod.'
                        : ''
                    }cardanoscan.io/transaction/${txHash}
                  Smart Contract Address: ${smartContractAddress}
              `);

            }))
        }))


    }
    finally {
        //library is strange as we can release from any non-acquired semaphore
        updateMutex.release()
    }
}

export const cardanoTimeoutRefundHandlerService = { collectTimeoutRefundsV1 }
