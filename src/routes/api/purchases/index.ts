import { payAuthenticatedEndpointFactory } from '@/utils/endpoint-factory/pay-authenticated';
import { z } from 'zod';
import { $Enums } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import * as cbor from "cbor"
import { cardanoTxHandlerService } from "@/services/cardano-tx-handler"
import { tokenCreditService } from '@/services/token-credit';
import { ez } from 'express-zod-api';
import { BlockfrostProvider, mBool, MeshWallet, SLOT_CONFIG_NETWORK, Transaction, unixTimeToEnclosingSlot } from '@meshsdk/core';
import { decrypt } from '@/utils/encryption';
import { getPaymentScriptFromNetworkHandlerV1 } from '@/utils/contractResolver';
export const queryPurchaseRequestSchemaInput = z.object({
    limit: z.number({ coerce: true }).min(1).max(100).default(10).describe("The number of purchases to return"),
    cursorIdentifier: z.object({ identifier: z.string().max(250), sellingWalletVkey: z.string().max(250) }).optional().describe("Used to paginate through the purchases"),
    network: z.nativeEnum($Enums.Network).describe("The network the purchases were made on"),
    contractAddress: z.string().max(250).describe("The address of the smart contract where the purchases were made to"),
})

export const queryPurchaseRequestSchemaOutput = z.object({
    purchases: z.array(z.object({
        createdAt: z.date(),
        updatedAt: z.date(),
        status: z.nativeEnum($Enums.PurchasingRequestStatus),
        txHash: z.string().nullable(),
        utxo: z.string().nullable(),
        errorType: z.nativeEnum($Enums.PurchaseRequestErrorType).nullable(),
        errorNote: z.string().nullable(),
        errorRequiresManualReview: z.boolean().nullable(),
        identifier: z.string(),
        smartContractWallet: z.object({ id: z.string(), walletVkey: z.string(), note: z.string().nullable() }).nullable(),
        purchaserWallet: z.object({ id: z.string(), walletVkey: z.string(), note: z.string().nullable() }).nullable(),
        sellerWallet: z.object({ walletVkey: z.string(), note: z.string().nullable() }).nullable(),
        amounts: z.array(z.object({ id: z.string(), createdAt: z.date(), updatedAt: z.date(), amount: z.number({ coerce: true }).min(0), unit: z.string() })),
        networkHandler: z.object({ id: z.string(), network: z.nativeEnum($Enums.Network), addressToCheck: z.string(), paymentType: z.nativeEnum($Enums.PaymentType) }).nullable(),
    }))
});

export const queryPurchaseRequestGet = payAuthenticatedEndpointFactory.build({
    method: "get",
    input: queryPurchaseRequestSchemaInput,
    output: queryPurchaseRequestSchemaOutput,
    handler: async ({ input, logger }) => {
        logger.info("Querying registry");

        const networkHandler = await prisma.networkHandler.findUnique({ where: { network_addressToCheck: { network: input.network, addressToCheck: input.contractAddress } } })
        if (networkHandler == null) {
            throw createHttpError(404, "Network handler not found")
        }
        let cursor = undefined;
        if (input.cursorIdentifier) {
            const sellerWallet = await prisma.sellerWallet.findUnique({ where: { networkHandlerId_walletVkey: { networkHandlerId: networkHandler.id, walletVkey: input.cursorIdentifier.sellingWalletVkey } } })
            if (sellerWallet == null) {
                throw createHttpError(404, "Selling wallet not found")
            }
            cursor = { networkHandlerId_identifier_sellerWalletId: { networkHandlerId: networkHandler.id, identifier: input.cursorIdentifier.identifier, sellerWalletId: sellerWallet.id } }
        }

        const result = await prisma.purchaseRequest.findMany({
            where: { networkHandlerId: networkHandler.id },
            cursor: cursor,
            take: input.limit,
            include: {
                sellerWallet: { select: { walletVkey: true, note: true } },
                purchaserWallet: { select: { id: true, walletVkey: true, note: true } },
                networkHandler: true,
                smartContractWallet: true,
                amounts: true
            }
        })
        if (result == null) {
            throw createHttpError(404, "Purchase not found")
        }
        return { purchases: result.map(purchase => ({ ...purchase, amounts: purchase.amounts.map(amount => ({ ...amount, amount: Number(amount.amount) })) })) }
    },
});

export const createPurchaseInitSchemaInput = z.object({
    identifier: z.string().max(250).describe("The identifier of the purchase. Is provided by the seller"),
    network: z.nativeEnum($Enums.Network).describe("The network the transaction will be made on"),
    sellerVkey: z.string().max(250).describe("The verification key of the seller"),
    contractAddress: z.string().max(250).describe("The address of the smart contract where the purchase will be made to"),
    amounts: z.array(z.object({ amount: z.number({ coerce: true }).min(0).max(Number.MAX_SAFE_INTEGER), unit: z.string() })).max(7).describe("The amounts of the purchase"),
    paymentType: z.nativeEnum($Enums.PaymentType).describe("The payment type of smart contract used"),
    unlockTime: ez.dateIn().describe("The time after which the purchase will be unlocked"),
    refundTime: ez.dateIn().describe("The time after which a refund will be approved"),
    submitResultTime: ez.dateIn().describe("The time by which the result has to be submitted"),
})

export const createPurchaseInitSchemaOutput = z.object({
    id: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
    status: z.nativeEnum($Enums.PurchasingRequestStatus),
});

export const createPurchaseInitPost = payAuthenticatedEndpointFactory.build({
    method: "post",
    input: createPurchaseInitSchemaInput,
    output: createPurchaseInitSchemaOutput,
    handler: async ({ input, options, logger }) => {
        logger.info("Creating purchase", input.paymentTypes);
        const networkCheckSupported = await prisma.networkHandler.findUnique({ where: { network_addressToCheck: { network: input.network, addressToCheck: input.contractAddress } } })
        if (networkCheckSupported == null) {
            throw createHttpError(404, "Network and Address combination not supported")
        }
        const wallets = await prisma.purchasingWallet.aggregate({ where: { networkHandlerId: networkCheckSupported.id, }, _count: true })
        if (wallets._count === 0) {
            throw createHttpError(404, "No valid purchasing wallets found")
        }
        //require at least 3 hours between unlock time and the submit result time
        const additionalRefundTime = 1000 * 60 * 60 * 3;
        if (input.unlockTime > new Date(input.refundTime.getTime() + additionalRefundTime)) {
            throw createHttpError(400, "Refund request time must be after unlock time with at least 3 hours difference")
        }
        if (input.submitResultTime.getTime() < Date.now()) {
            throw createHttpError(400, "Submit result time must be in the future")
        }
        const offset = 1000 * 60 * 15;
        if (input.submitResultTime > new Date(input.unlockTime.getTime() + offset)) {
            throw createHttpError(400, "Submit result time must be after unlock time with at least 15 minutes difference")
        }


        const initial = await tokenCreditService.handlePurchaseCreditInit(options.id, input.amounts.map(amount => ({ amount: BigInt(amount.amount), unit: amount.unit })), input.network, input.identifier, input.paymentType, input.contractAddress, input.sellerVkey, input.submitResultTime, input.unlockTime, input.refundTime);
        return initial
    },
});


export const refundPurchaseSchemaInput = z.object({
    identifier: z.string().max(250).describe("The identifier of the purchase to be refunded"),
    network: z.nativeEnum($Enums.Network).describe("The network the Cardano wallet will be used on"),
    smartContractAddress: z.string().max(250).describe("The address of the smart contract holding the purchase"),
})

export const refundPurchaseSchemaOutput = z.object({
    txHash: z.string(),
});

export const refundPurchasePatch = payAuthenticatedEndpointFactory.build({
    method: "patch",
    input: refundPurchaseSchemaInput,
    output: refundPurchaseSchemaOutput,
    handler: async ({ input, logger }) => {
        logger.info("Creating purchase", input.paymentTypes);
        const networkCheckSupported = await prisma.networkHandler.findUnique({ where: { network_addressToCheck: { network: input.network, addressToCheck: input.smartContractAddress } }, include: { FeeReceiverNetworkWallet: true, AdminWallets: true, PurchaseRequests: { where: { identifier: input.identifier }, include: { sellerWallet: true, purchaserWallet: { include: { walletSecret: true } } } } } })
        if (networkCheckSupported == null) {
            throw createHttpError(404, "Network and Address combination not supported")
        }
        if (networkCheckSupported.PurchaseRequests.length == 0) {
            throw createHttpError(404, "Purchase not found")
        }
        const purchase = networkCheckSupported.PurchaseRequests[0];
        if (purchase.status != $Enums.PurchasingRequestStatus.RefundConfirmed) {
            throw createHttpError(400, "Purchase in invalid state " + purchase.status)
        }


        const blockchainProvider = new BlockfrostProvider(
            networkCheckSupported.blockfrostApiKey,
        )



        const wallet = new MeshWallet({
            networkId: 0,
            fetcher: blockchainProvider,
            submitter: blockchainProvider,
            key: {
                type: 'mnemonic',
                words: decrypt(purchase.purchaserWallet!.walletSecret.secret!).split(" "),
            },
        });

        const address = (await wallet.getUsedAddresses())[0];
        const { script, smartContractAddress } = await getPaymentScriptFromNetworkHandlerV1(networkCheckSupported)

        const utxos = await wallet.getUtxos();
        if (utxos.length === 0) {
            //this is if the buyer wallet is empty
            throw new Error('No UTXOs found in the wallet. Wallet is empty.');
        }

        const utxoByHash = await blockchainProvider.fetchUTxOs(
            purchase.txHash!,
        );

        const utxo = utxoByHash.find((utxo) => utxo.input.txHash == purchase.txHash);

        if (!utxo) {
            throw new Error('UTXO not found');
        }

        if (!utxo) {
            throw new Error('UTXO not found');
        }

        // Get the datum from the UTXO

        // Decode the CBOR-encoded datum

        const sellerVerificationKeyHash = purchase.sellerWallet.walletVkey;
        const buyerVerificationKeyHash = purchase.purchaserWallet?.walletVkey;
        if (!buyerVerificationKeyHash)
            throw createHttpError(404, "purchasing wallet not found")

        const utxoDatum = utxo.output.plutusData;
        if (!utxoDatum) {
            throw new Error('No datum found in UTXO');
        }


        const decodedDatum = cbor.decode(Buffer.from(utxoDatum, 'hex'));
        if (typeof decodedDatum.value[3] !== 'string') {
            throw new Error('Invalid datum at position 3');
        }
        const resultHash = Buffer.from(decodedDatum.value[3], "hex").toString("utf-8")

        if (typeof decodedDatum.value[4] !== 'number') {
            throw new Error('Invalid datum at position 4');
        }
        if (typeof decodedDatum.value[5] !== 'number') {
            throw new Error('Invalid datum at position 5');
        }
        if (typeof decodedDatum.value[6] !== 'number') {
            throw new Error('Invalid datum at position 5');
        }
        const submitResultTime = decodedDatum.value[4];
        const unlockTime = decodedDatum.value[5];
        const refundTime = decodedDatum.value[6];

        const refundDenied = cardanoTxHandlerService.mBoolToBool(decodedDatum.value[8])
        if (refundDenied == null) {
            throw new Error("Invalid datum at position 8")
        }
        const datum = {
            value: {
                alternative: 0,
                fields: [
                    buyerVerificationKeyHash,
                    sellerVerificationKeyHash,
                    purchase.identifier,
                    resultHash,
                    submitResultTime,
                    unlockTime,
                    refundTime,
                    //is converted to true
                    mBool(true),
                    //is converted to false
                    //Todo decode old contract value
                    mBool(refundDenied)
                ],
            },
            inline: true,
        };
        const redeemer = {
            data: {
                alternative: 2,
                fields: [],
            },
        };
        const networkType = networkCheckSupported.network == "MAINNET" ? "mainnet" : networkCheckSupported.network == "PREPROD" ? "preprod" : "preview"
        const invalidBefore =
            unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK[networkType]) - 1;
        const invalidHereafter =
            unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK[networkType]) + 1;
        //console.log(utxo);

        const unsignedTx = new Transaction({ initiator: wallet }).setMetadata(674, {
            msg: ["Masumi", "RequestRefund"],
        })
            .redeemValue({
                value: utxo,
                script: script,
                redeemer: redeemer,
            })
            .sendValue(
                { address: smartContractAddress, datum: datum },
                utxo,
            )
            .setChangeAddress(address)
            .setRequiredSigners([address]);

        unsignedTx.txBuilder.invalidBefore(invalidBefore);
        unsignedTx.txBuilder.invalidHereafter(invalidHereafter);
        const buildTransaction = await unsignedTx.build();
        const signedTx = await wallet.signTx(buildTransaction);

        //submit the transaction to the blockchain
        const txHash = await wallet.submitTx(signedTx);
        await prisma.purchaseRequest.update({ where: { id: purchase.id }, data: { status: $Enums.PurchasingRequestStatus.RefundRequestInitiated, potentialTxHash: txHash } })

        return { txHash }
    },
});