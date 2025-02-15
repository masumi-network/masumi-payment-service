import { $Enums, Prisma } from "@prisma/client";
import { Sema } from "async-sema";
import { prisma } from '@/utils/db';
import { logger } from "@/utils/logger";
import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { PlutusDatumSchema, Transaction } from "@emurgo/cardano-serialization-lib-nodejs";
import { Data } from 'lucid-cardano';
import { decodeV1ContractDatum } from "@/utils/converter/string-datum-convert";
import { advancedRetryAll, delayErrorResolver } from "advanced-retry";



const updateMutex = new Sema(1);
export async function checkLatestTransactions() {

    const maxParallelTransactions = 250;

    const acquiredMutex = await updateMutex.tryAcquire();
    //if we are already performing an update, we wait for it to finish and return
    if (!acquiredMutex)
        return await updateMutex.acquire();

    try {
        //only support web3 cardano v1 for now
        const networkChecks = await prisma.$transaction(async (prisma) => {
            const networkChecks = await prisma.networkHandler.findMany({
                where: {
                    paymentType: $Enums.PaymentType.WEB3_CARDANO_V1,
                    OR: [
                        { isSyncing: false },
                        {
                            isSyncing: true,
                            updatedAt: {
                                lte: new Date(Date.now() -
                                    //3 minutes
                                    1000 * 60 * 3
                                )
                            }
                        }
                    ]
                    //isSyncing: false
                },
                include: {

                    NetworkHandlerConfig: true
                }
            })

            if (networkChecks.length == 0) {
                logger.warn("No available network handlers found, skipping update. It could be that an other instance is already updating")
                return null;
            }


            await prisma.networkHandler.updateMany({
                where: { id: { in: networkChecks.map(x => x.id) } },
                data: { isSyncing: true }
            })
            return networkChecks.map((x) => { return { ...x, isSyncing: true } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 100000, maxWait: 10000 })
        if (networkChecks == null)
            return;
        try {
            const results = await Promise.allSettled(networkChecks.map(async (networkCheck) => {
                let latestIdentifier = networkCheck.lastIdentifierChecked;
                const blockfrost = new BlockFrostAPI({
                    projectId: networkCheck.NetworkHandlerConfig.rpcProviderApiKey,
                    network: networkCheck.network == $Enums.Network.MAINNET ? "mainnet" : "preprod"
                });

                let latestTx: { tx_hash: string }[] = []
                let foundTx = -1
                let index = 0;
                do {
                    index++;
                    const txs = await blockfrost.addressesTransactions(networkCheck.paymentContractAddress, { page: index, order: "desc" })
                    if (txs.length == 0)
                        break;

                    latestTx.push(...txs)
                    foundTx = txs.findIndex(tx => tx.tx_hash == latestIdentifier)
                    if (foundTx != -1) {
                        const latestTxIndex = latestTx.findIndex(tx => tx.tx_hash == latestIdentifier)
                        latestTx = latestTx.slice(latestTxIndex)
                        break;
                    }


                } while (foundTx == -1)


                //invert to get oldest first
                latestTx = latestTx.reverse()

                if (latestTx.length == 0) {
                    logger.warn("No transactions found for network handler", { networkHandler: networkCheck })
                    return;
                }

                if (latestTx.length > maxParallelTransactions) {
                    latestTx = latestTx.slice(latestTx.length - maxParallelTransactions)
                }

                const txData = await advancedRetryAll({
                    operations: latestTx.map(tx => async () => {
                        const cbor = await blockfrost.txsCbor(tx.tx_hash)
                        const utxos = await blockfrost.txsUtxos(tx.tx_hash)
                        const transaction = Transaction.from_bytes(Buffer.from(cbor.cbor, "hex"))
                        return { tx: tx, utxos: utxos, transaction: transaction }
                    }),
                    errorResolvers: [
                        delayErrorResolver({ configuration: { maxRetries: 5, backoffMultiplier: 2, initialDelayMs: 500, maxDelayMs: 15000 } })
                    ]
                })


                const filteredTxData = txData.filter(x => x.success == true && x.result != undefined).map(x => x.result!)

                for (const tx of filteredTxData) {

                    const utxos = tx.utxos
                    const inputs = utxos.inputs;
                    const outputs = utxos.outputs;

                    const valueInputs = inputs.filter((x) => { return x.address == networkCheck.paymentContractAddress })
                    const valueOutputs = outputs.filter((x) => { return x.address == networkCheck.paymentContractAddress })

                    const redeemers = tx.transaction.witness_set().redeemers();

                    if (redeemers == null) {
                        //payment transaction
                        if (valueInputs.length != 0) {
                            //invalid transaction
                            continue;
                        }

                        for (const output of valueOutputs) {
                            if (output.reference_script_hash != null) {
                                //no reference script allowed
                                continue
                            }
                            const outputDatum = output.inline_datum
                            if (outputDatum == null) {
                                //invalid transaction
                                continue;
                            }
                            const decodedOutputDatum: unknown = Data.from(outputDatum);
                            const decodedNewContract = decodeV1ContractDatum(decodedOutputDatum)
                            if (decodedNewContract == null) {
                                //invalid transaction
                                continue;
                            }

                            await prisma.$transaction(async (prisma) => {
                                const sellerWallet = await prisma.walletBase.findUnique({
                                    where: {
                                        networkHandlerId_walletVkey_type: { networkHandlerId: networkCheck.id, walletVkey: decodedNewContract.seller, type: $Enums.WalletType.SELLER }
                                    }
                                })
                                if (sellerWallet == null) {
                                    return;
                                }

                                const dbEntry = await prisma.purchaseRequest.findUnique({
                                    where: {
                                        networkHandlerId_blockchainIdentifier_sellerWalletId: {
                                            networkHandlerId: networkCheck.id,
                                            blockchainIdentifier: decodedNewContract.blockchainIdentifier,
                                            sellerWalletId: sellerWallet.id
                                        },
                                        CurrentStatus: {
                                            status: $Enums.PurchasingRequestStatus.PurchaseInitiated,
                                        }
                                    },
                                    include: {
                                        SmartContractWallet: true,
                                        SellerWallet: true
                                    }

                                })
                                if (dbEntry == null) {
                                    //transaction is not registered with us or duplicated (therefore invalid)
                                    return;
                                }
                                if (dbEntry.SmartContractWallet == null) {
                                    logger.error("No smart contract wallet set for purchase request in db", { purchaseRequest: dbEntry })
                                    return;
                                }


                                if (dbEntry.SellerWallet == null) {
                                    logger.error("No seller wallet set for purchase request in db", { purchaseRequest: dbEntry })
                                    return;
                                }
                                if (decodedNewContract.seller != dbEntry.SellerWallet.walletVkey) {
                                    logger.error("Seller does not match seller in db", { purchaseRequest: dbEntry, sender: decodedNewContract.seller, senderDb: dbEntry.SmartContractWallet?.walletVkey })
                                    return;
                                }

                                if (decodedNewContract.buyer != dbEntry.SmartContractWallet?.walletVkey) {
                                    logger.warn("Buyer does not match buyer in db", { paymentRequest: dbEntry, buyer: decodedNewContract.buyer, buyerDb: dbEntry.SmartContractWallet?.walletVkey })
                                    return;
                                }
                                if (decodedNewContract.refundRequested != false) {
                                    logger.warn("Refund was requested", { paymentRequest: dbEntry, refundRequested: decodedNewContract.refundRequested })
                                    return;
                                }
                                if (decodedNewContract.resultHash != "") {
                                    logger.warn("Result hash was set", { paymentRequest: dbEntry, resultHash: decodedNewContract.resultHash })
                                    return;
                                }
                                if (decodedNewContract.resultTime != dbEntry.submitResultTime) {
                                    logger.warn("Result time is not the agreed upon time", { paymentRequest: dbEntry, resultTime: decodedNewContract.resultTime, resultTimeDb: dbEntry.submitResultTime })
                                    return;
                                }
                                if (decodedNewContract.unlockTime < dbEntry.unlockTime) {
                                    logger.warn("Unlock time is before the agreed upon time", { paymentRequest: dbEntry, unlockTime: decodedNewContract.unlockTime, unlockTimeDb: dbEntry.unlockTime })
                                    return;
                                }
                                if (decodedNewContract.refundTime != dbEntry.refundTime) {
                                    logger.warn("Refund time is not the agreed upon time", { paymentRequest: dbEntry, refundTime: decodedNewContract.refundTime, refundTimeDb: dbEntry.refundTime })
                                    return;
                                }
                                if (decodedNewContract.buyerCooldownTime != 0) {
                                    logger.warn("Buyer cooldown time is not 0", { paymentRequest: dbEntry, buyerCooldownTime: decodedNewContract.buyerCooldownTime })
                                    return;
                                }
                                if (decodedNewContract.sellerCooldownTime != 0) {
                                    logger.warn("Seller cooldown time is not 0", { paymentRequest: dbEntry, sellerCooldownTime: decodedNewContract.sellerCooldownTime })
                                    return;
                                }
                                await prisma.purchaseRequest.update({
                                    where: { id: dbEntry.id },
                                    data: {
                                        CurrentStatus: {
                                            create: {
                                                status: $Enums.PurchasingRequestStatus.PurchaseConfirmed,
                                                timestamp: new Date(),
                                                Transaction: {
                                                    create: {
                                                        txHash: tx.tx.tx_hash,
                                                    }
                                                }
                                            }
                                        },
                                        StatusHistory: { connect: { id: dbEntry.currentStatusId } },
                                    }
                                })

                            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000, maxWait: 10000 })
                            await prisma.$transaction(async (prisma) => {

                                const dbEntry = await prisma.paymentRequest.findUnique({
                                    where: {
                                        networkHandlerId_blockchainIdentifier: {
                                            blockchainIdentifier: decodedNewContract.blockchainIdentifier,
                                            networkHandlerId: networkCheck.id,
                                        },
                                        BuyerWallet: null,
                                        CurrentStatus: {
                                            status: $Enums.PaymentRequestStatus.PaymentRequested,
                                        }
                                    },
                                    include: {
                                        Amounts: true,
                                        BuyerWallet: true,
                                        SmartContractWallet: true
                                    }
                                })
                                if (dbEntry == null) {
                                    //transaction is not registered with us or duplicated (therefore invalid)
                                    return;
                                }
                                if (dbEntry.BuyerWallet != null) {
                                    logger.error("Existing buyer set for payment request in db", { paymentRequest: dbEntry })
                                    return;
                                }
                                if (dbEntry.SmartContractWallet == null) {
                                    logger.error("No smart contract wallet set for payment request in db", { paymentRequest: dbEntry })
                                    return;
                                }


                                if (dbEntry.BuyerWallet != null) {
                                    logger.warn("Buyer is already set for payment request in db", { paymentRequest: dbEntry })
                                    return;
                                }
                                if (dbEntry.SmartContractWallet?.walletVkey == undefined) {
                                    logger.warn("No smart contract wallet set for payment request in db", { paymentRequest: dbEntry })
                                    return;
                                }
                                if (decodedNewContract.seller != dbEntry.SmartContractWallet.walletVkey) {
                                    logger.warn("Seller does not match seller in db", { paymentRequest: dbEntry, seller: decodedNewContract.seller, sellerDb: dbEntry.SmartContractWallet?.walletVkey })
                                    return;
                                }
                                if (decodedNewContract.refundRequested != false) {
                                    logger.warn("Refund was requested", { paymentRequest: dbEntry, refundRequested: decodedNewContract.refundRequested })
                                    return;
                                }
                                if (decodedNewContract.resultHash != "") {
                                    logger.warn("Result hash was set", { paymentRequest: dbEntry, resultHash: decodedNewContract.resultHash })
                                    return;
                                }
                                if (decodedNewContract.resultTime != dbEntry.submitResultTime) {
                                    logger.warn("Result time is not the agreed upon time", { paymentRequest: dbEntry, resultTime: decodedNewContract.resultTime, resultTimeDb: dbEntry.submitResultTime })
                                    return;
                                }
                                if (decodedNewContract.unlockTime != dbEntry.unlockTime) {
                                    logger.warn("Unlock time is before the agreed upon time", { paymentRequest: dbEntry, unlockTime: decodedNewContract.unlockTime, unlockTimeDb: dbEntry.unlockTime })
                                    return;
                                }
                                if (decodedNewContract.refundTime != dbEntry.refundTime) {
                                    logger.warn("Refund time is not the agreed upon time", { paymentRequest: dbEntry, refundTime: decodedNewContract.refundTime, refundTimeDb: dbEntry.refundTime })
                                    return;
                                }
                                if (decodedNewContract.buyerCooldownTime != 0) {
                                    logger.warn("Buyer cooldown time is not 0", { paymentRequest: dbEntry, buyerCooldownTime: decodedNewContract.buyerCooldownTime })
                                    return;
                                }
                                if (decodedNewContract.sellerCooldownTime != 0) {
                                    logger.warn("Seller cooldown time is not 0", { paymentRequest: dbEntry, sellerCooldownTime: decodedNewContract.sellerCooldownTime })
                                    return;
                                }

                                const valueMatches = checkPaymentAmountsMatch(dbEntry.Amounts, output.amount)

                                const paymentCountMatches = dbEntry.Amounts.filter(x => x.unit != "lovelace").length == output.amount.filter(x => x.unit != "lovelace").length
                                let newStatus: $Enums.PaymentRequestStatus = $Enums.PaymentRequestStatus.PaymentInvalid;

                                if (valueMatches == true && paymentCountMatches == true) {
                                    newStatus = $Enums.PaymentRequestStatus.PaymentConfirmed
                                }

                                await prisma.paymentRequest.update({
                                    where: { id: dbEntry.id },
                                    data: {
                                        CurrentStatus: {
                                            create: {
                                                status: newStatus,
                                                timestamp: new Date(),
                                                Transaction: {
                                                    create: {
                                                        txHash: tx.tx.tx_hash,
                                                    }
                                                }
                                            }
                                        },
                                        StatusHistory: { connect: { id: dbEntry.currentStatusId } },
                                        BuyerWallet: {
                                            connectOrCreate: {
                                                where: {
                                                    networkHandlerId_walletVkey_type: { networkHandlerId: networkCheck.id, walletVkey: decodedNewContract.buyer, type: $Enums.WalletType.BUYER }
                                                },
                                                create: {
                                                    walletVkey: decodedNewContract.buyer,
                                                    type: $Enums.WalletType.BUYER,
                                                    NetworkHandler: { connect: { id: networkCheck.id } }
                                                }
                                            }
                                        }
                                    }
                                })
                            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 100000, maxWait: 10000 }
                            )

                        }
                        await prisma.networkHandler.update({
                            where: { id: networkCheck.id },
                            data: { lastIdentifierChecked: tx.tx.tx_hash }
                        })
                        latestIdentifier = tx.tx.tx_hash;
                    } else {
                        //TODO validate the contract was the one from the db

                        if (redeemers.len() != 1) {
                            //invalid transaction
                            continue;
                        }

                        if (valueInputs.length != 1) {
                            continue;
                        }
                        const valueInput = valueInputs[0];
                        if (valueInput.reference_script_hash != null) {
                            logger.error("Reference script hash is not null, this should not be allowed on a contract level", { tx: tx.tx.tx_hash })
                            //invalid transaction
                            continue;
                        }

                        const inputDatum = valueInput.inline_datum
                        if (inputDatum == null) {
                            //invalid transaction
                            continue;
                        }

                        const decodedInputDatum: unknown = Data.from(inputDatum);
                        const decodedOldContract = decodeV1ContractDatum(decodedInputDatum)
                        if (decodedOldContract == null) {
                            //invalid transaction
                            continue;
                        }

                        if (valueOutputs.length > 1) {
                            continue
                        }

                        const outputDatum = valueOutputs.length == 1 ? valueOutputs[0].inline_datum : null
                        const decodedOutputDatum = outputDatum != null ? Data.from(outputDatum) : null
                        const decodedNewContract = decodeV1ContractDatum(decodedOutputDatum)

                        const paymentRequest = await prisma.paymentRequest.findUnique({
                            where: {
                                networkHandlerId_blockchainIdentifier: { networkHandlerId: networkCheck.id, blockchainIdentifier: decodedOldContract.blockchainIdentifier }
                            },
                            include: {
                                BuyerWallet: true,
                                SmartContractWallet: true,
                                Amounts: true,
                                CurrentStatus: {
                                    include: {
                                        Transaction: true
                                    }
                                }
                            }
                        })
                        const purchasingRequest = await prisma.purchaseRequest.findUnique({
                            where: {
                                networkHandlerId_blockchainIdentifier_sellerWalletId: { networkHandlerId: networkCheck.id, blockchainIdentifier: decodedOldContract.blockchainIdentifier, sellerWalletId: decodedOldContract.seller }
                            },
                            include: {
                                SmartContractWallet: true,
                                SellerWallet: true,
                                CurrentStatus: {
                                    include: {
                                        Transaction: true
                                    }
                                }
                            }
                        })

                        if (paymentRequest == null && purchasingRequest == null) {
                            //transaction is not registered with us or duplicated (therefore invalid)
                            continue;
                        }

                        let inputTxHashMatchPaymentRequest = paymentRequest?.CurrentStatus?.Transaction?.txHash == valueInput.tx_hash
                        if (paymentRequest != null && inputTxHashMatchPaymentRequest == false) {
                            const utxoChain = await findPreviousUtxosForContract(valueInput.tx_hash, networkCheck.paymentContractAddress, blockfrost)
                            if (utxoChain != null) {
                                //TODO maybe add in between tx states into the db
                                inputTxHashMatchPaymentRequest = true;
                            }
                        }
                        let inputTxHashMatchPurchasingRequest = purchasingRequest?.CurrentStatus?.Transaction?.txHash == valueInput.tx_hash
                        if (purchasingRequest != null && inputTxHashMatchPurchasingRequest == false) {
                            const utxoChain = await findPreviousUtxosForContract(valueInput.tx_hash, networkCheck.paymentContractAddress, blockfrost)
                            if (utxoChain != null) {
                                //TODO maybe add in between tx states into the db
                                inputTxHashMatchPurchasingRequest = true;
                            }
                        }
                        if (inputTxHashMatchPaymentRequest == false && inputTxHashMatchPurchasingRequest == false) {
                            logger.error("Input tx hash does not match payment request tx hash or purchasing request tx hash. This likely is a spoofing attempt", { paymentRequest: paymentRequest, purchasingRequest: purchasingRequest, txHash: valueInput.tx_hash })
                            continue;
                        }
                        const redeemer = redeemers.get(0)

                        const redeemerVersion = JSON.parse(redeemer.data().to_json(PlutusDatumSchema.BasicConversions))[
                            "constructor"
                        ]

                        if (redeemerVersion != 0 && redeemerVersion != 3 && redeemerVersion != 4 && decodedNewContract == null) {
                            //this should not be possible
                            logger.error("Possible invalid state in smart contract detected. tx_hash: " + tx.tx.tx_hash)
                            continue
                        }

                        let newStatus: $Enums.PaymentRequestStatus;
                        let newPurchasingStatus: $Enums.PurchasingRequestStatus;

                        if (redeemerVersion == 0) {
                            //Withdraw
                            newStatus = $Enums.PaymentRequestStatus.WithdrawnConfirmed
                            newPurchasingStatus = $Enums.PurchasingRequestStatus.Withdrawn
                        }
                        else if (redeemerVersion == 1) {
                            //RequestRefund
                            newStatus = $Enums.PaymentRequestStatus.RefundRequested
                            newPurchasingStatus = $Enums.PurchasingRequestStatus.RefundRequestConfirmed
                        }
                        else if (redeemerVersion == 2) {
                            //CancelRefundRequest
                            if (decodedNewContract?.resultHash) {
                                newStatus = $Enums.PaymentRequestStatus.CompletedConfirmed
                                newPurchasingStatus = $Enums.PurchasingRequestStatus.Completed
                            } else {
                                //Ensure the amounts match, to prevent state change attacks
                                const valueMatches = checkPaymentAmountsMatch(paymentRequest?.Amounts || [], valueOutputs[0].amount)
                                newStatus = valueMatches == true ? $Enums.PaymentRequestStatus.PaymentConfirmed : $Enums.PaymentRequestStatus.PaymentInvalid;
                                newPurchasingStatus = $Enums.PurchasingRequestStatus.PurchaseConfirmed
                            }
                        }
                        else if (redeemerVersion == 3) {
                            //WithdrawRefund
                            newStatus = $Enums.PaymentRequestStatus.Refunded
                            newPurchasingStatus = $Enums.PurchasingRequestStatus.RefundConfirmed
                        }
                        else if (redeemerVersion == 4) {
                            //WithdrawDisputed
                            newStatus = $Enums.PaymentRequestStatus.DisputedWithdrawn
                            newPurchasingStatus = $Enums.PurchasingRequestStatus.DisputedWithdrawn
                        }
                        else if (redeemerVersion == 5) {
                            //SubmitResult
                            newStatus = $Enums.PaymentRequestStatus.CompletedConfirmed
                            newPurchasingStatus = $Enums.PurchasingRequestStatus.Completed
                        }
                        else if (redeemerVersion == 6) {
                            //AllowRefund
                            newStatus = $Enums.PaymentRequestStatus.RefundRequested
                            newPurchasingStatus = $Enums.PurchasingRequestStatus.RefundRequestConfirmed
                        }
                        else {
                            //invalid transaction  
                            logger.error("Possible invalid state in smart contract detected. tx_hash: " + tx.tx.tx_hash)
                            continue;
                        }


                        await Promise.allSettled([
                            inputTxHashMatchPaymentRequest ? handlePaymentTransactionCardanoV1(tx.tx.tx_hash, tx.utxos.hash, newStatus, networkCheck.id, decodedOldContract.seller, decodedOldContract.blockchainIdentifier, redeemerVersion) : Promise.resolve(),
                            inputTxHashMatchPurchasingRequest ? handlePurchasingTransactionCardanoV1(tx.tx.tx_hash, tx.utxos.hash, newPurchasingStatus, networkCheck.id, decodedOldContract.seller, decodedOldContract.blockchainIdentifier, redeemerVersion) : Promise.resolve()
                        ])
                    }
                    await prisma.networkHandler.update({
                        where: { id: networkCheck.id },
                        data: { lastIdentifierChecked: tx.tx.tx_hash }
                    })

                }




            }))

            const failedResults = results.filter(x => x.status == "rejected")
            if (failedResults.length > 0) {
                logger.error("Error updating tx data", { error: failedResults, networkChecks: networkChecks })
            }
        }
        finally {
            try {
                await prisma.networkHandler.updateMany({
                    where: { id: { in: networkChecks.map(x => x.id) } },
                    data: { isSyncing: false }
                })
            } catch (error) {
                logger.error("Error updating network checks syncing status", { error: error, networkChecks: networkChecks })
                //TODO very bad, maybe add a retry mechanism?
            }
        }
    }
    finally {
        //library is strange as we can release from any non-acquired semaphore
        updateMutex.release()
    }
}

async function handlePaymentTransactionCardanoV1(tx_hash: string, utxo_hash: string, newStatus: $Enums.PaymentRequestStatus, networkCheckId: string, sellerVkey: string, blockchainIdentifier: string, redeemerVersion: number,) {
    await prisma.$transaction(async (prisma) => {
        //we dont need to do sanity checks as the tx hash is unique
        const paymentRequest = await prisma.paymentRequest.findUnique({
            where: { networkHandlerId_blockchainIdentifier: { networkHandlerId: networkCheckId, blockchainIdentifier: blockchainIdentifier } },
        })

        if (paymentRequest == null) {
            //transaction is not registered with us or a payment transaction
            return;
        }
        const newTxHash = redeemerVersion == 0 || redeemerVersion == 3 || redeemerVersion == 4 ? null : tx_hash;


        await prisma.paymentRequest.update({
            where: { id: paymentRequest.id },
            data: {
                CurrentStatus: {
                    create: {
                        status: newStatus,
                        timestamp: new Date(),
                        Transaction: {
                            create: {
                                txHash: newTxHash
                            }
                        }
                    }
                },
                StatusHistory: { connect: { id: paymentRequest.currentStatusId } },
            }
        })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000, maxWait: 10000 })
}

async function findPreviousUtxosForContract(tx_hash: string, contractAddress: string, blockfrost: BlockFrostAPI, maxDepth: number = 100) {
    const utxoChain = []
    while (tx_hash != null && maxDepth > 0) {

        //find previous utxos
        const previousUtxos = await blockfrost.txsUtxos(tx_hash)
        const previousInput = previousUtxos.inputs.filter(x => x.address == contractAddress)
        if (previousInput == null) {
            return null;
        }
        if (previousInput.length > 1) {
            const found = previousInput.find(x => x.tx_hash == tx_hash)
            if (found == null) {
                //this can only be the initial payment.Therefore we can break here
                return null;
            }
            utxoChain.push(found)
            return utxoChain;
        }
        const previousInputTxHash = previousInput[0].tx_hash
        if (tx_hash == previousInputTxHash) {
            return utxoChain;
        }
        utxoChain.push(previousInputTxHash)
        tx_hash = previousInputTxHash
        maxDepth--;
    }
    throw new Error("Max depth reached");
}

async function handlePurchasingTransactionCardanoV1(tx_hash: string, utxo_hash: string, newStatus: $Enums.PurchasingRequestStatus, networkCheckId: string, sellerVkey: string, blockchainIdentifier: string, redeemerVersion: number) {
    await prisma.$transaction(async (prisma) => {
        //we dont need to do sanity checks as the tx hash is unique
        const purchasingRequest = await prisma.paymentRequest.findUnique({
            where: { networkHandlerId_blockchainIdentifier: { networkHandlerId: networkCheckId, blockchainIdentifier: blockchainIdentifier } },
        })

        if (purchasingRequest == null) {
            //transaction is not registered with us as a purchasing transaction
            return;
        }
        const newTxHash = redeemerVersion == 0 || redeemerVersion == 3 || redeemerVersion == 4 ? null : tx_hash;

        await prisma.purchaseRequest.update({
            where: { id: purchasingRequest.id },
            data: {
                CurrentStatus: {
                    create: {
                        status: newStatus,
                        timestamp: new Date(),
                        Transaction: {
                            create: {
                                txHash: newTxHash
                            }
                        }
                    }
                },
                StatusHistory: { connect: { id: purchasingRequest.currentStatusId } },
            }
        })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000, maxWait: 10000 })
}

function checkPaymentAmountsMatch(expectedAmounts: { unit: string; amount: bigint }[], actualAmounts: { unit: string; quantity: string }[]) {
    return expectedAmounts.every((x) => {
        const existingAmount = actualAmounts.find((y) => y.unit == x.unit)
        if (existingAmount == null)
            return false;
        //allow for some overpayment to handle min lovelace requirements
        if (x.unit == "lovelace") {
            return x.amount <= BigInt(existingAmount.quantity)
        }
        //require exact match for non-lovelace amounts
        return x.amount == BigInt(existingAmount.quantity)
    })
}

export const cardanoTxHandlerService = { checkLatestTransactions, checkPaymentAmountsMatch }
