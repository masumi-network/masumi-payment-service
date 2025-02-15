import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from 'zod';
import { $Enums, HotWalletType } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { Transaction } from '@meshsdk/core';
import { blake2b } from 'ethereum-cryptography/blake2b.js';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { metadataToString, stringToMetadata } from '@/utils/converter/metadata-string-convert';
import { DEFAULTS } from '@/utils/config';
import { customErrorResolver, advancedRetry, errorToString, statusCodeErrorFilterRange } from 'advanced-retry';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';

const metadataSchema = z.object({
    name: z.string().min(1).or(z.array(z.string().min(1))),
    description: z.string().or(z.array(z.string())).optional(),
    api_url: z.string().min(1).url().or(z.array(z.string().min(1))),
    example_output: z.string().or(z.array(z.string())).optional(),
    capability: z.object({
        name: z.string().or(z.array(z.string())),
        version: z.string().or(z.array(z.string())),
    }),
    requests_per_hour: z.string().or(z.array(z.string())).optional(),
    author: z.object({
        name: z.string().min(1).or(z.array(z.string().min(1))),
        contact: z.string().or(z.array(z.string())).optional(),
        organization: z.string().or(z.array(z.string())).optional()
    }),
    legal: z.object({
        privacy_policy: z.string().or(z.array(z.string())).optional(),
        terms: z.string().or(z.array(z.string())).optional(),
        other: z.string().or(z.array(z.string())).optional()
    }).optional(),
    tags: z.array(z.string().min(1)).min(1),
    pricing: z.array(z.object({
        quantity: z.number({ coerce: true }).int().min(1),
        unit: z.string().min(1).or(z.array(z.string().min(1)))
    })).min(1),
    image: z.string().or(z.array(z.string())),
    metadata_version: z.number({ coerce: true }).int().min(1).max(1)
})

export const queryAgentSchemaInput = z.object({
    walletVKey: z.string().max(250).describe("The payment key of the wallet to be queried"),
    network: z.nativeEnum($Enums.Network).describe("The Cardano network used to register the agent on"),
    paymentContractAddress: z.string().max(250).optional().describe("The smart contract address of the payment contract to which the registration belongs"),
})

export const queryAgentSchemaOutput = z.object({
    assets: z.array(z.object({
        policyId: z.string(),
        assetName: z.string(),
        agentIdentifier: z.string(),
        metadata: z.object({
            name: z.string().max(250),
            description: z.string().max(250).nullable().optional(),
            api_url: z.string().max(250),
            example_output: z.string().max(250).nullable().optional(),
            tags: z.array(z.string().max(250)),
            requests_per_hour: z.string().max(250).nullable().optional(),
            capability: z.object({
                name: z.string().max(250),
                version: z.string().max(250),
            }),
            author: z.object({
                name: z.string().max(250),
                contact: z.string().max(250).nullable().optional(),
                organization: z.string().max(250).nullable().optional(),
            }),
            legal: z.object({
                privacy_policy: z.string().max(250).nullable().optional(),
                terms: z.string().max(250).nullable().optional(),
                other: z.string().max(250).nullable().optional(),
            }).nullable().optional(),
            pricing: z.array(z.object({
                quantity: z.number({ coerce: true }).int().min(1),
                unit: z.string().max(250),
            })).min(1),
            image: z.string().max(250),
            metadata_version: z.number({ coerce: true }).int().min(1).max(1)
        }),
    })),
})
export const queryAgentGet = payAuthenticatedEndpointFactory.build({
    method: "get",
    input: queryAgentSchemaInput,
    output: queryAgentSchemaOutput,
    handler: async ({ input }) => {
        const paymentContractAddress = input.paymentContractAddress ?? (input.network == $Enums.Network.MAINNET ? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET : DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD)
        const networkCheckSupported = await prisma.networkHandler.findUnique({ where: { network_paymentContractAddress: { network: input.network, paymentContractAddress: paymentContractAddress } }, include: { AdminWallets: true, NetworkHandlerConfig: true, HotWallets: { include: { Secret: true } } } })
        if (networkCheckSupported == null) {
            throw createHttpError(404, "Network and Address combination not supported")
        }
        const blockfrost = new BlockFrostAPI({
            projectId: networkCheckSupported.NetworkHandlerConfig.rpcProviderApiKey,
        })
        const wallet = networkCheckSupported.HotWallets.find(wallet => wallet.walletVkey == input.walletVKey && wallet.type == HotWalletType.SELLING)
        if (wallet == null) {
            throw createHttpError(404, "Wallet not found")
        }
        const { policyId, } = await getRegistryScriptFromNetworkHandlerV1(networkCheckSupported)

        const addressInfo = await blockfrost.addresses(wallet.walletAddress)
        if (addressInfo.stake_address == null) {
            throw createHttpError(404, "Stake address not found")
        }
        const stakeAddress = addressInfo.stake_address

        const holderWallet = await blockfrost.accountsAddressesAssetsAll(stakeAddress)
        if (!holderWallet || holderWallet.length == 0) {
            throw createHttpError(404, "Asset not found")
        }
        const assets = holderWallet.filter(asset => asset.unit.startsWith(policyId))
        const detailedAssets: { unit: string, metadata: z.infer<typeof queryAgentSchemaOutput>["assets"][0]["metadata"] }[] = []

        await Promise.all(assets.map(async (asset) => {
            const assetInfo = await blockfrost.assetsById(asset.unit)
            const parsedMetadata = metadataSchema.safeParse(assetInfo.onchain_metadata)
            if (!parsedMetadata.success) {
                return
            }
            detailedAssets.push({
                unit: asset.unit,
                metadata:
                {
                    name: metadataToString(parsedMetadata.data.name!)!,
                    description: metadataToString(parsedMetadata.data.description),
                    api_url: metadataToString(parsedMetadata.data.api_url)!,
                    example_output: metadataToString(parsedMetadata.data.example_output),
                    capability: {
                        name: metadataToString(parsedMetadata.data.capability.name)!,
                        version: metadataToString(parsedMetadata.data.capability.version)!,
                    },
                    author: {
                        name: metadataToString(parsedMetadata.data.author.name)!,
                        contact: metadataToString(parsedMetadata.data.author.contact),
                        organization: metadataToString(parsedMetadata.data.author.organization),
                    },
                    legal: parsedMetadata.data.legal ? {
                        privacy_policy: metadataToString(parsedMetadata.data.legal.privacy_policy),
                        terms: metadataToString(parsedMetadata.data.legal.terms),
                        other: metadataToString(parsedMetadata.data.legal.other),
                    } : undefined,
                    tags: parsedMetadata.data.tags.map(tag => metadataToString(tag)!),
                    pricing: parsedMetadata.data.pricing.map(price => ({
                        quantity: price.quantity,
                        unit: metadataToString(price.unit)!,
                    })),
                    image: metadataToString(parsedMetadata.data.image)!,
                    metadata_version: parsedMetadata.data.metadata_version,
                }
            })
        }))

        return {
            assets: detailedAssets.map(asset => ({
                policyId: policyId,
                assetName: asset.unit.slice(policyId.length),
                agentIdentifier: asset.unit,
                metadata: asset.metadata,
            })),
        }
    },
});



export const registerAgentSchemaInput = z.object({
    network: z.nativeEnum($Enums.Network).describe("The Cardano network used to register the agent on"),
    paymentContractAddress: z.string().max(250).optional().describe("The smart contract address of the payment contract to be registered for"),
    sellingWalletVkey: z.string().max(250).optional().describe("The payment key of a specific wallet used for the registration"),
    example_output: z.string().max(250).optional().describe("Link to a example output of the agent"),
    tags: z.array(z.string().max(63)).min(1).max(15).describe("Tags used in the registry metadata"),
    name: z.string().max(250).describe("Name of the agent"),
    api_url: z.string().max(250).describe("Base URL of the agent, to request interactions"),
    description: z.string().max(250).describe("Description of the agent"),
    capability: z.object({ name: z.string().max(250), version: z.string().max(250) }).describe("Provide information about the used AI model and version"),
    requests_per_hour: z.string().max(250).describe("The request the agent can handle per hour"),
    pricing: z.array(z.object({
        unit: z.string().max(250),
        quantity: z.string().max(55),
    })).max(5).describe("Price for a default interaction"),
    legal: z.object({
        privacy_policy: z.string().max(250).optional(),
        terms: z.string().max(250).optional(),
        other: z.string().max(250).optional(),
    }).optional().describe("Legal information about the agent"),
    author: z.object({
        name: z.string().max(250),
        contact: z.string().max(250).optional(),
        organization: z.string().max(250).optional(),
    }).describe("Author information about the agent"),
})

export const registerAgentSchemaOutput = z.object({
    txHash: z.string(),
    policyId: z.string(),
    assetName: z.string(),
    agentIdentifier: z.string(),
});

export const registerAgentPost = payAuthenticatedEndpointFactory.build({
    method: "post",
    input: registerAgentSchemaInput,
    output: registerAgentSchemaOutput,
    handler: async ({ input, logger }) => {
        logger.info("Registering Agent", input.paymentTypes);
        const paymentContractAddress = input.paymentContractAddress ?? (input.network == $Enums.Network.MAINNET ? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET : DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD)
        const networkCheckSupported = await prisma.networkHandler.findUnique({
            where: {
                network_paymentContractAddress: {
                    network: input.network,
                    paymentContractAddress: paymentContractAddress
                }
            }, include: { AdminWallets: true, HotWallets: { include: { Secret: true } }, NetworkHandlerConfig: true }
        })
        if (networkCheckSupported == null) {
            throw createHttpError(404, "Network and Address combination not supported")
        }
        let sellingWallet = networkCheckSupported.HotWallets.find(wallet => wallet.walletVkey == input.sellingWalletVkey && wallet.type == HotWalletType.SELLING)

        if (sellingWallet == null) {
            if (input.sellingWalletVkey != null) {
                throw createHttpError(404, "Selling Wallet not found")
            }
            const hotWallets = networkCheckSupported.HotWallets.filter(wallet => wallet.type == HotWalletType.SELLING)
            if (hotWallets.length == 0) {
                throw createHttpError(404, "No Selling Wallets found")
            }
            const freeHotWallets = hotWallets.filter(wallet => wallet.pendingTransactionId == null)
            if (freeHotWallets.length == 0) {
                throw createHttpError(429, "No Selling Wallets not in use found")
            }
            const randomIndex = Math.floor(Math.random() * freeHotWallets.length)
            sellingWallet = freeHotWallets[randomIndex]
        }

        const result = await advancedRetry({
            operation: async () => {

                const { wallet, utxos, address } = await generateWalletExtended(input.network, networkCheckSupported.NetworkHandlerConfig.rpcProviderApiKey, sellingWallet.Secret.secret)

                if (utxos.length === 0) {
                    throw new Error('No UTXOs found for the wallet');
                }
                const { script, policyId, smartContractAddress } = await getRegistryScriptFromNetworkHandlerV1(networkCheckSupported)

                /*const filteredUtxos = utxos.findIndex((a) => getLovelace(a.output.amount) > 0 && a.output.amount.length == 1);
                if (filteredUtxos == -1) {
                    const tx = new Transaction({ initiator: wallet }).setTxInputs(utxos);
        
                    tx.isCollateralNeeded = false;
        
                    tx.sendLovelace(address, "5000000")
                    //sign the transaction with our address
                    tx.setChangeAddress(address).setRequiredSigners([address]);
                    //build the transaction
                    const unsignedTx = await tx.build();
                    const signedTx = await wallet.signTx(unsignedTx, true);
                    try {
                        const txHash = await wallet.submitTx(signedTx);
                        throw createHttpError(429, "Defrag error, try again later. Defrag via : " + txHash);
                    } catch (error: unknown) {
                        logger.error("Defrag failed with error", error)
                        throw createHttpError(429, "Defrag error, try again later. Defrag failed with error");
                    }
                }*/

                const firstUtxo = utxos[0];
                //utxos = utxos.filter((_, index) => index !== filteredUtxos);

                const txId = firstUtxo.input.txHash;
                const txIndex = firstUtxo.input.outputIndex;
                const serializedOutput = txId + txIndex.toString(16).padStart(8, '0');

                const serializedOutputUint8Array = new Uint8Array(
                    Buffer.from(serializedOutput.toString(), 'hex'),
                );
                // Hash the serialized output using blake2b_256
                const blake2b256 = blake2b(serializedOutputUint8Array, 32);
                const assetName = Buffer.from(blake2b256).toString('hex');

                const redeemer = {
                    data: { alternative: 0, fields: [] },
                    tag: 'MINT',
                };


                const tx = new Transaction({ initiator: wallet }).setMetadata(674, {
                    msg: ["Masumi", "RegisterAgent"],
                }).setTxInputs([
                    //ensure our first utxo hash (serializedOutput) is used as first input
                    firstUtxo,
                    ...utxos.slice(1),
                ]);

                tx.isCollateralNeeded = true;

                //setup minting data separately as the minting function does not work well with hex encoded strings without some magic
                tx.txBuilder
                    .mintPlutusScript(script.version)
                    .mint('1', policyId, assetName)
                    .mintingScript(script.code)
                    .mintRedeemerValue(redeemer.data, 'Mesh');



                //setup the metadata
                tx.setMetadata(721, {
                    [policyId]: {
                        [assetName]: {
                            name: stringToMetadata(input.name),
                            description: stringToMetadata(input.description),
                            api_url: stringToMetadata(input.api_url),
                            example_output: stringToMetadata(input.example_output),
                            capability: {
                                name: stringToMetadata(input.capability?.name),
                                version: stringToMetadata(input.capability?.version)
                            },
                            requests_per_hour: stringToMetadata(input.requests_per_hour),
                            author: {
                                name: stringToMetadata(input.author?.name),
                                contact: stringToMetadata(input.author?.contact),
                                organization: stringToMetadata(input.author.organization)
                            },
                            legal: {
                                privacy_policy: stringToMetadata(input.legal?.privacy_policy),
                                terms: stringToMetadata(input.legal?.terms),
                                other: stringToMetadata(input.legal?.other)
                            },
                            tags: input.tags,
                            pricing: input.pricing.map(pricing => ({
                                unit: stringToMetadata(pricing.unit),
                                quantity: pricing.quantity,
                            })),
                            image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
                            metadata_version: stringToMetadata(DEFAULTS.DEFAULT_METADATA_VERSION)

                        },
                    },
                    version: "1"
                });
                //send the minted asset to the address where we want to receive payments
                tx.sendAssets(address, [{ unit: policyId + assetName, quantity: '1' }])
                tx.sendLovelace(address, "5000000")
                //sign the transaction with our address
                tx.setChangeAddress(address).setRequiredSigners([address]);

                //build the transaction
                const unsignedTx = await tx.build();
                const signedTx = await wallet.signTx(unsignedTx, true);


                //submit the transaction to the blockchain, it can take a bit until the transaction is confirmed and found on the explorer
                const txHash = await wallet.submitTx(signedTx);
                logger.info(`Minted 1 asset with the contract at:
            Tx ID: ${txHash}
            AssetName: ${assetName}
            PolicyId: ${policyId}
            AssetId: ${policyId + assetName}
            Smart Contract Address: ${smartContractAddress}
        `);
                return { txHash, policyId, assetName, agentIdentifier: policyId + assetName }

            },
            throwOnUnrecoveredError: true,
            errorResolvers: [
                customErrorResolver({
                    configuration: {
                        attempts: 3,
                    },
                    callback: async (error, attempt, configuration) => {
                        const errorMessage = errorToString(error)
                        if (errorMessage.includes("ValueNotConservedUTxO")) {
                            await new Promise(resolve => setTimeout(resolve, 15000));
                            return {
                                remainingAttempts: configuration.attempts - attempt,
                                unrecoverable: false
                            }
                        }
                        return {
                            remainingAttempts: configuration.attempts - attempt,
                            unrecoverable: true
                        }
                    },
                    canHandleError: (error, attempt, context) => {
                        return statusCodeErrorFilterRange(0, 599).canHandleError(error, attempt, context) == false
                    }
                })
            ]
        })

        return result.result!
    },
});





export const unregisterAgentSchemaInput = z.object({
    assetName: z.string().max(250).describe("The identifier of the registration (asset) to be deregistered"),
    network: z.nativeEnum($Enums.Network).describe("The network the registration was made on"),
    paymentContractAddress: z.string().max(250).optional().describe("The smart contract address of the payment contract to which the registration belongs"),
})

export const unregisterAgentSchemaOutput = z.object({
    txHash: z.string(),
});

export const unregisterAgentDelete = payAuthenticatedEndpointFactory.build({
    method: "delete",
    input: unregisterAgentSchemaInput,
    output: unregisterAgentSchemaOutput,
    handler: async ({ input, logger }) => {
        logger.info("Deregister Agent", input.paymentTypes);
        const paymentContractAddress = input.paymentContractAddress ?? (input.network == $Enums.Network.MAINNET ? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET : DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD)
        const networkCheckSupported = await prisma.networkHandler.findUnique({ where: { network_paymentContractAddress: { network: input.network, paymentContractAddress: paymentContractAddress } }, include: { AdminWallets: true, HotWallets: { include: { Secret: true } }, NetworkHandlerConfig: true } })
        if (networkCheckSupported == null) {
            throw createHttpError(404, "Network and Address combination not supported")
        }
        if (networkCheckSupported.HotWallets == null || networkCheckSupported.HotWallets.length == 0) {
            throw createHttpError(404, "Selling Wallet not found")
        }

        const blockfrost = new BlockFrostAPI({
            projectId: networkCheckSupported.NetworkHandlerConfig.rpcProviderApiKey,
        })

        const { policyId, script, smartContractAddress } = await getRegistryScriptFromNetworkHandlerV1(networkCheckSupported)

        let assetName = input.assetName
        if (assetName.startsWith(policyId)) {
            assetName = assetName.slice(policyId.length)
        }
        const holderWallet = await blockfrost.assetsAddresses(policyId + assetName, { order: "desc", count: 1 })
        if (holderWallet.length == 0) {
            throw createHttpError(404, "Asset not found")
        }
        const vkey = resolvePaymentKeyHash(holderWallet[0].address)

        const sellingWallet = networkCheckSupported.HotWallets.find(wallet => wallet.walletVkey == vkey && wallet.type == HotWalletType.SELLING)
        if (sellingWallet == null) {
            throw createHttpError(404, "Registered Wallet not found")
        }
        const { wallet, utxos, address } = await generateWalletExtended(input.network, networkCheckSupported.NetworkHandlerConfig.rpcProviderApiKey, sellingWallet.Secret.secret)

        if (utxos.length === 0) {
            throw new Error('No UTXOs found for the wallet');
        }


        const redeemer = {
            data: { alternative: 1, fields: [] },
        };

        const tx = new Transaction({ initiator: wallet }).setMetadata(674, {
            msg: ["Masumi", "DeregisterAgent"],
        }).setTxInputs(utxos);

        tx.isCollateralNeeded = true;

        //setup minting data separately as the minting function does not work well with hex encoded strings without some magic
        tx.txBuilder
            .mintPlutusScript(script.version)
            .mint('-1', policyId, assetName)
            .mintingScript(script.code)
            .mintRedeemerValue(redeemer.data, 'Mesh');
        tx.sendLovelace(address, "5000000")
        //send the minted asset to the address where we want to receive payments
        //used to defrag for further transactions
        //sign the transaction with our address
        tx.setChangeAddress(address).setRequiredSigners([address]);
        //build the transaction
        const unsignedTx = await tx.build();
        const signedTx = await wallet.signTx(unsignedTx, true);
        //submit the transaction to the blockchain, it can take a bit until the transaction is confirmed and found on the explorer
        const txHash = await wallet.submitTx(signedTx);

        console.log(`Burned 1 asset with the contract at:
    Tx ID: ${txHash}
    AssetName: ${assetName}
    PolicyId: ${policyId}
    Smart Contract Address: ${smartContractAddress}
`);
        return { txHash }
    },
});