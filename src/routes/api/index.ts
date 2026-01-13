import { DependsOnMethod, Routing } from 'express-zod-api';
import { healthEndpointGet } from '@/routes/api/health';
import {
  queryAPIKeyEndpointGet as queryCentralizedRegistrySourceGet,
  addAPIKeyEndpointPost as addCentralizedRegistrySourceEndpointPost,
  updateAPIKeyEndpointPatch,
  deleteAPIKeyEndpointDelete,
} from './api-key';
import { createPurchaseInitPost, queryPurchaseRequestGet } from './purchases';
import { paymentInitPost, queryPaymentEntryGet } from './payments';
import {
  deleteAgentRegistration,
  queryRegistryRequestGet,
  registerAgentPost,
} from './registry';
import {
  paymentSourceExtendedEndpointDelete,
  paymentSourceExtendedEndpointGet,
  paymentSourceExtendedEndpointPatch,
  paymentSourceExtendedEndpointPost,
} from './payment-source-extended';
import { queryAPIKeyStatusEndpointGet } from './api-key-status';
import {
  patchWalletEndpointPatch,
  postWalletEndpointPost,
  queryWalletEndpointGet,
} from './wallet';
import { queryRpcProviderKeysEndpointGet } from './rpc-api-keys';
import { queryUTXOEndpointGet } from './utxos';
import { paymentSourceEndpointGet } from './payment-source';
import { submitPaymentResultEndpointPost } from './payments/submit-result';
import { authorizePaymentRefundEndpointPost } from './payments/authorize-refund';
import { requestPurchaseRefundPost } from './purchases/request-refund';
import { cancelPurchaseRefundRequestPost } from './purchases/cancel-refund-request';
import { queryAgentFromWalletGet } from './registry/wallet';
import { resolvePaymentRequestPost } from './payments/resolve-blockchain-identifier';
import { resolvePurchaseRequestPost } from './purchases/resolve-blockchain-identifier';
import { unregisterAgentPost } from './registry/deregister';
import { revealDataEndpointPost } from './reveal-data';
import { paymentErrorStateRecoveryPost } from './payments/error-state-recovery';
import { purchaseErrorStateRecoveryPost } from './purchases/error-state-recovery';
import { queryRegistryDiffGet } from './registry/diff';
import {
  queryPaymentDiffCombinedGet,
  queryPaymentDiffNextActionGet,
  queryPaymentDiffOnChainStateOrResultGet,
} from './payments/diff';
import {
  queryPurchaseDiffCombinedGet,
  queryPurchaseDiffNextActionGet,
  queryPurchaseDiffOnChainStateOrResultGet,
} from './purchases/diff';

export const apiRouter: Routing = {
  v1: {
    'reveal-data': new DependsOnMethod({
      post: revealDataEndpointPost,
    }),
    health: healthEndpointGet,
    purchase: new DependsOnMethod({
      get: queryPurchaseRequestGet,
      post: createPurchaseInitPost,
    }).nest({
      diff: new DependsOnMethod({
        get: queryPurchaseDiffCombinedGet,
      }).nest({
        'next-action': new DependsOnMethod({
          get: queryPurchaseDiffNextActionGet,
        }),
        'onchain-state-or-result': new DependsOnMethod({
          get: queryPurchaseDiffOnChainStateOrResultGet,
        }),
      }),
      'request-refund': new DependsOnMethod({
        post: requestPurchaseRefundPost,
      }),
      'cancel-refund-request': new DependsOnMethod({
        post: cancelPurchaseRefundRequestPost,
      }),
      'resolve-blockchain-identifier': new DependsOnMethod({
        post: resolvePurchaseRequestPost,
      }),
      'error-state-recovery': new DependsOnMethod({
        post: purchaseErrorStateRecoveryPost,
      }),
    }),
    payment: new DependsOnMethod({
      get: queryPaymentEntryGet,
      post: paymentInitPost,
    }).nest({
      diff: new DependsOnMethod({
        get: queryPaymentDiffCombinedGet,
      }).nest({
        'next-action': new DependsOnMethod({
          get: queryPaymentDiffNextActionGet,
        }),
        'onchain-state-or-result': new DependsOnMethod({
          get: queryPaymentDiffOnChainStateOrResultGet,
        }),
      }),
      'authorize-refund': new DependsOnMethod({
        post: authorizePaymentRefundEndpointPost,
      }),
      'submit-result': new DependsOnMethod({
        post: submitPaymentResultEndpointPost,
      }),
      'resolve-blockchain-identifier': new DependsOnMethod({
        post: resolvePaymentRequestPost,
      }),
      'error-state-recovery': new DependsOnMethod({
        post: paymentErrorStateRecoveryPost,
      }),
    }),
    registry: new DependsOnMethod({
      get: queryRegistryRequestGet,
      post: registerAgentPost,
      delete: deleteAgentRegistration,
    }).nest({
      diff: new DependsOnMethod({
        get: queryRegistryDiffGet,
      }),
      wallet: new DependsOnMethod({
        get: queryAgentFromWalletGet,
      }),
      deregister: new DependsOnMethod({
        post: unregisterAgentPost,
      }),
    }),
    'api-key-status': new DependsOnMethod({
      get: queryAPIKeyStatusEndpointGet,
    }),
    'api-key': new DependsOnMethod({
      get: queryCentralizedRegistrySourceGet,
      post: addCentralizedRegistrySourceEndpointPost,
      patch: updateAPIKeyEndpointPatch,
      delete: deleteAPIKeyEndpointDelete,
    }),
    wallet: new DependsOnMethod({
      get: queryWalletEndpointGet,
      post: postWalletEndpointPost,
      patch: patchWalletEndpointPatch,
    }),
    'payment-source-extended': new DependsOnMethod({
      get: paymentSourceExtendedEndpointGet,
      post: paymentSourceExtendedEndpointPost,
      patch: paymentSourceExtendedEndpointPatch,
      delete: paymentSourceExtendedEndpointDelete,
    }),
    'rpc-api-keys': new DependsOnMethod({
      get: queryRpcProviderKeysEndpointGet,
    }),
    utxos: new DependsOnMethod({
      get: queryUTXOEndpointGet,
    }),
    'payment-source': new DependsOnMethod({
      get: paymentSourceEndpointGet,
    }),
  },
};
