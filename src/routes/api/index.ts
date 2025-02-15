import { DependsOnMethod, Routing } from "express-zod-api";
import { healthEndpointGet } from '@/routes/api/health';
import { queryAPIKeyEndpointGet as queryCentralizedRegistrySourceGet, addAPIKeyEndpointPost as addCentralizedRegistrySourceEndpointPost, updateAPIKeyEndpointPatch, deleteAPIKeyEndpointDelete as deleteCentralizedRegistrySourceEndpointDelete } from "./api-key";
import { createPurchaseInitPost, queryPurchaseRequestGet, refundPurchasePatch } from "./purchases";
import { paymentInitPost, paymentUpdatePatch, queryPaymentEntryGet, refundPaymentDelete } from "./payments";
import { queryAgentGet, registerAgentPost, unregisterAgentDelete } from "./registry";
import { paymentSourceEndpointDelete, paymentSourceEndpointGet, paymentSourceEndpointPatch, paymentSourceEndpointPost } from "./payment-source";
import { queryAPIKeyStatusEndpointGet } from "./api-key-status";
import { postWalletEndpointPost, queryWalletEndpointGet } from "./wallet";
import { queryRpcProviderKeysEndpointGet } from "./rpc-api-keys";
import { queryUTXOEndpointGet } from "./utxos";
import { paymentContractEndpointGet } from "./payment-contract";

export const apiRouter: Routing = {
    v1: {
        health: healthEndpointGet,
        "purchase": new DependsOnMethod({
            get: queryPurchaseRequestGet,
            post: createPurchaseInitPost,
            patch: refundPurchasePatch,
        }),
        "payment": new DependsOnMethod({
            get: queryPaymentEntryGet,
            post: paymentInitPost,
            patch: paymentUpdatePatch,
            delete: refundPaymentDelete
        }),
        "registry": new DependsOnMethod({
            get: queryAgentGet,
            post: registerAgentPost,
            delete: unregisterAgentDelete
        }),
        "api-key-status": new DependsOnMethod({
            get: queryAPIKeyStatusEndpointGet,
        }),
        "api-key": new DependsOnMethod({
            get: queryCentralizedRegistrySourceGet,
            post: addCentralizedRegistrySourceEndpointPost,
            patch: updateAPIKeyEndpointPatch,
            delete: deleteCentralizedRegistrySourceEndpointDelete
        }),
        "wallet": new DependsOnMethod({
            get: queryWalletEndpointGet,
            post: postWalletEndpointPost,
        }),
        "payment-source": new DependsOnMethod({
            get: paymentSourceEndpointGet,
            post: paymentSourceEndpointPost,
            patch: paymentSourceEndpointPatch,
            delete: paymentSourceEndpointDelete
        }),
        "rpc-api-keys": new DependsOnMethod({
            get: queryRpcProviderKeysEndpointGet,
        }),
        "utxos": new DependsOnMethod({
            get: queryUTXOEndpointGet,
        }),
        "payment-contract": new DependsOnMethod({
            get: paymentContractEndpointGet,
        }),
    }
}
