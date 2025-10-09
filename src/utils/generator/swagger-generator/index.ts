import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';
import { healthResponseSchema } from '@/routes/api/health';
import {
  addAPIKeySchemaInput,
  addAPIKeySchemaOutput,
  deleteAPIKeySchemaInput,
  deleteAPIKeySchemaOutput,
  getAPIKeySchemaInput,
  getAPIKeySchemaOutput,
  updateAPIKeySchemaInput,
  updateAPIKeySchemaOutput,
} from '@/routes/api/api-key';
import {
  createPaymentSchemaOutput,
  createPaymentsSchemaInput,
  queryPaymentsSchemaInput,
  queryPaymentsSchemaOutput,
} from '@/routes/api/payments';
import {
  createPurchaseInitSchemaInput,
  createPurchaseInitSchemaOutput,
  queryPurchaseRequestSchemaInput,
  queryPurchaseRequestSchemaOutput,
} from '@/routes/api/purchases';
import {
  queryRegistryRequestSchemaInput,
  queryRegistryRequestSchemaOutput,
  registerAgentSchemaInput,
  registerAgentSchemaOutput,
  deleteAgentRegistrationSchemaInput,
  deleteAgentRegistrationSchemaOutput,
} from '@/routes/api/registry';
import {
  unregisterAgentSchemaInput,
  unregisterAgentSchemaOutput,
} from '@/routes/api/registry/deregister';
import { getAPIKeyStatusSchemaOutput } from '@/routes/api/api-key-status';
import {
  getWalletSchemaInput,
  getWalletSchemaOutput,
  patchWalletSchemaInput,
  patchWalletSchemaOutput,
  postWalletSchemaInput,
  postWalletSchemaOutput,
} from '@/routes/api/wallet';
import {
  getRpcProviderKeysSchemaInput,
  getRpcProviderKeysSchemaOutput,
} from '@/routes/api/rpc-api-keys';
import { getUTXOSchemaInput, getUTXOSchemaOutput } from '@/routes/api/utxos';
import {
  paymentSourceSchemaInput,
  paymentSourceSchemaOutput,
} from '@/routes/api/payment-source';
import {
  Network,
  PaymentType,
  PurchasingAction,
  PaymentAction,
  Permission,
  ApiKeyStatus,
  RPCProvider,
  PricingType,
} from '@prisma/client';
import {
  authorizePaymentRefundSchemaInput,
  authorizePaymentRefundSchemaOutput,
} from '@/routes/api/payments/authorize-refund';
import {
  submitPaymentResultSchemaInput,
  submitPaymentResultSchemaOutput,
} from '@/routes/api/payments/submit-result';
import {
  requestPurchaseRefundSchemaInput,
  requestPurchaseRefundSchemaOutput,
} from '@/routes/api/purchases/request-refund';
import {
  cancelPurchaseRefundRequestSchemaInput,
  cancelPurchaseRefundRequestSchemaOutput,
} from '@/routes/api/purchases/cancel-refund-request';
import {
  paymentSourceExtendedCreateSchemaInput,
  paymentSourceExtendedCreateSchemaOutput,
  paymentSourceExtendedDeleteSchemaInput,
  paymentSourceExtendedDeleteSchemaOutput,
  paymentSourceExtendedSchemaInput,
  paymentSourceExtendedSchemaOutput,
  paymentSourceExtendedUpdateSchemaInput,
  paymentSourceExtendedUpdateSchemaOutput,
} from '@/routes/api/payment-source-extended';
import {
  queryAgentFromWalletSchemaInput,
  queryAgentFromWalletSchemaOutput,
} from '@/routes/api/registry/wallet';
import {
  postPaymentRequestSchemaInput,
  postPaymentRequestSchemaOutput,
} from '@/routes/api/payments/resolve-blockchain-identifier';
import {
  postPurchaseRequestSchemaInput,
  postPurchaseRequestSchemaOutput,
} from '@/routes/api/purchases/resolve-blockchain-identifier';
import {
  postRevealDataSchemaOutput,
  postVerifyDataRevealSchemaInput,
} from '@/routes/api/reveal-data';
import {
  postGenerateInvoiceSchemaInput,
  postGenerateInvoiceSchemaOutput,
} from '@/routes/api/invoice';
import {
  postSignatureSchemaInput,
  postSignatureSchemaOutput,
} from '@/routes/api/invoice/signature';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();
export function generateOpenAPI() {
  /********************* HEALTH *****************************/

  registry.registerPath({
    method: 'get',
    path: '/health/',
    tags: ['health'],
    summary: 'Get the status of the API server',
    request: {},
    responses: {
      200: {
        description: 'Object with status ok, if the server is running',
        content: {
          'application/json': {
            schema: healthResponseSchema.openapi({ example: { status: 'ok' } }),
          },
        },
      },
    },
  });

  const apiKeyAuth = registry.registerComponent('securitySchemes', 'API-Key', {
    type: 'apiKey',
    in: 'header',
    name: 'token',
    description: 'API key authentication via header (token)',
  });

  /********************* KEY STATUS *****************************/
  registry.registerPath({
    method: 'get',
    path: '/api-key-status/',
    description: 'Gets api key status',
    summary: 'Get information about your current API key.',
    tags: ['api-key'],
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'API key status',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.string(), data: getAPIKeyStatusSchemaOutput })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    status: ApiKeyStatus.Active,
                    token: 'masumi_payment_api_key_secret',
                    permission: Permission.Admin,
                    networkLimit: [Network.Preprod],
                    usageLimited: true,
                    RemainingUsageCredits: [{ unit: '', amount: '10000000' }],
                  },
                },
              }),
          },
        },
      },
    },
  });

  /********************* WALLET *****************************/
  registry.registerPath({
    method: 'get',
    path: '/wallet/',
    description: 'Gets wallet status',
    summary: 'Get information about a wallet. (admin access required)',
    tags: ['wallet'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      query: getWalletSchemaInput.openapi({
        example: {
          id: 'unique_cuid_v2_of_entry_to_delete',
          includeSecret: 'true',
          walletType: 'Selling',
        },
      }),
    },
    responses: {
      200: {
        description: 'Wallet status',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.string(), data: getWalletSchemaOutput })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    walletVkey: 'wallet_vkey',
                    note: 'note',
                    PendingTransaction: null,
                    walletAddress: 'wallet_address',
                    Secret: {
                      createdAt: new Date(1713636260),
                      updatedAt: new Date(1713636260),
                      mnemonic: 'decoded_secret',
                    },
                  },
                },
              }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/wallet/',
    description:
      'Creates a wallet, it will not be saved in the database, please ensure to remember the mnemonic',
    summary: 'Create a new wallet. (admin access required)',
    tags: ['wallet'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: postWalletSchemaInput.openapi({
              example: {
                network: Network.Preprod,
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Wallet created',
        content: {
          'application/json': {
            schema: postWalletSchemaOutput.openapi({
              example: {
                walletMnemonic: 'wallet_mnemonic',
                walletAddress: 'wallet_address',
                walletVkey: 'wallet_vkey',
              },
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/wallet/',
    description: 'Updates a wallet',
    summary: 'Update a wallet. (admin access required)',
    tags: ['wallet'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: patchWalletSchemaInput.openapi({
              example: {
                id: 'unique_cuid_v2_of_entry_to_update',
                newCollectionAddress: 'collection_address',
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Wallet updated',
        content: {
          'application/json': {
            schema: patchWalletSchemaOutput.openapi({
              example: {
                id: 'unique_cuid_v2_of_entry_to_update',
                collectionAddress: 'collection_address',
                type: 'Selling',
                walletVkey: 'wallet_vkey',
                walletAddress: 'wallet_address',
                note: 'note',
              },
            }),
          },
        },
      },
    },
  });

  /********************* REVEAL DATA *****************************/
  registry.registerPath({
    method: 'post',
    path: '/reveal-data/',
    description: 'Verifies the reveal data signature is valid.',
    summary:
      'Verifies the reveal data signature is valid. (read access required)',
    tags: ['reveal-data'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: postVerifyDataRevealSchemaInput.openapi({
              example: {
                action: 'reveal_data',
                blockchainIdentifier: 'blockchain_identifier',
                signature: 'signature',
                key: 'key',
                walletAddress: 'wallet_address',
                validUntil: 1713636260,
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'Revealed data',
        content: {
          'application/json': {
            schema: postRevealDataSchemaOutput.openapi({
              example: {
                isValid: true,
              },
            }),
          },
        },
      },
    },
  });
  /********************* API KEYS *****************************/
  registry.registerPath({
    method: 'get',
    path: '/api-key/',
    description: 'Gets api key status',
    summary: 'Get information about all API keys. (admin access required)',
    tags: ['api-key'],
    request: {
      query: getAPIKeySchemaInput.openapi({
        example: {
          limit: 10,
          cursorToken: 'identifier',
        },
      }),
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'Api key status',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.string(), data: getAPIKeySchemaOutput })
              .openapi({
                example: {
                  data: {
                    ApiKeys: [
                      {
                        id: 'unique_cuid_v2_of_entry',
                        token: 'masumi_payment_api_key_secret',
                        permission: Permission.Admin,
                        usageLimited: true,
                        RemainingUsageCredits: [
                          { unit: '', amount: '10000000' },
                        ],
                        status: ApiKeyStatus.Active,
                        networkLimit: [Network.Mainnet],
                      },
                    ],
                  },
                  status: 'success',
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api-key/',
    description: 'Creates a API key',
    summary: 'Create a new API key. (admin access required)',
    tags: ['api-key'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: addAPIKeySchemaInput.openapi({
              example: {
                usageLimited: 'true',
                UsageCredits: [{ unit: '', amount: '10000000' }],
                permission: Permission.Admin,
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'API key deleted',
        content: {
          'application/json': {
            schema: z
              .object({ data: addAPIKeySchemaOutput, status: z.string() })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'unique_cuid_v2_of_entry_to_delete',
                    token: 'masumi_payment_api_key_secret',
                    permission: Permission.Admin,
                    usageLimited: true,
                    networkLimit: [Network.Preprod],
                    status: ApiKeyStatus.Active,
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api-key/',
    description: 'Creates a API key',
    summary: 'Update an existing API key. (admin access required)',
    tags: ['api-key'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: updateAPIKeySchemaInput.openapi({
              example: {
                id: 'unique_cuid_v2_of_entry_to_update',
                token: 'api_key_to_change_to',
                UsageCreditsToAddOrRemove: [
                  { unit: '', amount: '10000000' },
                  { unit: 'usdm_policy_and_asset_id', amount: '-10000000' },
                ],
                status: ApiKeyStatus.Active,
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'API key deleted',
        content: {
          'application/json': {
            schema: z
              .object({ data: updateAPIKeySchemaOutput, status: z.string() })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'unique_cuid_v2_of_entry_to_delete',
                    token: 'masumi_payment_api_key_secret',
                    permission: Permission.Admin,
                    usageLimited: true,
                    networkLimit: [Network.Preprod, Network.Mainnet],
                    status: ApiKeyStatus.Active,
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api-key/',
    description: 'Removes a API key',
    summary: 'Delete an existing API key. (admin access required)',
    tags: ['api-key'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: deleteAPIKeySchemaInput.openapi({
              example: {
                id: 'id_or_apiKey_unique_cuid_v2_of_entry_to_delete',
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'API key deleted',
        content: {
          'application/json': {
            schema: z
              .object({ data: deleteAPIKeySchemaOutput, status: z.string() })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'unique_cuid_v2_of_entry_to_delete',
                    token: 'masumi_registry_api_key_secret',
                    status: ApiKeyStatus.Revoked,
                    permission: Permission.Admin,
                    usageLimited: true,
                    networkLimit: [Network.Preprod, Network.Mainnet],
                    deletedAt: new Date(1713636260),
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  /********************* PAYMENT *****************************/
  registry.registerPath({
    method: 'get',
    path: '/payment/',
    description:
      'Gets the payment status. It needs to be created first with a POST request.',
    summary: 'Get information about a payment request. (admin access required)',
    tags: ['payment'],
    request: {
      query: queryPaymentsSchemaInput.openapi({
        example: {
          limit: 10,
          cursorId: 'cuid_v2_of_last_cursor_entry',
          network: Network.Preprod,
        },
      }),
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'Payment status',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.string(), data: queryPaymentsSchemaOutput })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    Payments: [
                      {
                        id: 'cuid_v2_auto_generated',
                        blockchainIdentifier: 'blockchain_identifier',
                        createdAt: new Date(1713636260),
                        updatedAt: new Date(1713636260),
                        submitResultTime: '0',
                        unlockTime: '0',
                        externalDisputeUnlockTime: '0',
                        lastCheckedAt: null,
                        cooldownTime: 0,
                        payByTime: null,
                        cooldownTimeOtherParty: 0,
                        collateralReturnLovelace: null,
                        requestedById: 'requester_id',
                        resultHash: 'result_hash',
                        onChainState: null,
                        inputHash: 'input_hash',
                        NextAction: {
                          requestedAction:
                            PaymentAction.AuthorizeRefundRequested,
                          errorType: null,
                          errorNote: null,
                          resultHash: null,
                        },
                        CurrentTransaction: null,
                        TransactionHistory: [],
                        RequestedFunds: [
                          {
                            amount: '10000000',
                            unit: '',
                          },
                        ],
                        PaymentSource: {
                          id: 'payment_source_id',
                          network: Network.Preprod,
                          smartContractAddress: 'address',
                          policyId: 'policy_id',
                          paymentType: PaymentType.Web3CardanoV1,
                        },
                        WithdrawnForSeller: [],
                        WithdrawnForBuyer: [],
                        BuyerWallet: null,
                        SmartContractWallet: null,
                        metadata: null,
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/payment/',
    description:
      'Creates a payment request and identifier. This will check incoming payments in the background.',
    summary: 'Create a new payment request. (admin access required +PAY)',
    tags: ['payment'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: createPaymentsSchemaInput.openapi({
              example: {
                agentIdentifier: 'agent_identifier',
                network: Network.Preprod,
                inputHash:
                  '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
                payByTime: new Date(1713626260).toISOString(),
                metadata:
                  '(private) metadata to be stored with the payment request',
                paymentType: PaymentType.Web3CardanoV1,
                submitResultTime: new Date(1713636260).toISOString(),
                identifierFromPurchaser: 'aabbaabb11221122aabb',
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'Payment request created',
        content: {
          'application/json': {
            schema: z
              .object({ data: createPaymentSchemaOutput, status: z.string() })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    inputHash: 'input_hash',
                    blockchainIdentifier: 'blockchain_identifier',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    payByTime: '0',
                    submitResultTime: '0',
                    unlockTime: '0',
                    externalDisputeUnlockTime: '0',
                    lastCheckedAt: null,
                    requestedById: 'requester_id',
                    resultHash: 'result_hash',
                    onChainState: null,
                    NextAction: {
                      requestedAction: PaymentAction.AuthorizeRefundRequested,
                      errorType: null,
                      errorNote: null,
                      resultHash: null,
                    },
                    RequestedFunds: [
                      {
                        amount: '10000000',
                        unit: '',
                      },
                    ],
                    PaymentSource: {
                      id: 'payment_source_id',
                      policyId: 'policy_id',
                      network: Network.Preprod,
                      smartContractAddress: 'address',
                      paymentType: PaymentType.Web3CardanoV1,
                    },
                    BuyerWallet: null,
                    SmartContractWallet: null,
                    metadata: null,
                    WithdrawnForSeller: [],
                    WithdrawnForBuyer: [],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/payment/submit-result',
    description:
      'Submit the hash of their completed job for a payment request, which triggers the fund unlock process so the seller can collect payment after the unlock time expires. (admin access required +PAY)',
    summary:
      'Completes a payment request. This will collect the funds after the unlock time. (admin access required +PAY)',
    tags: ['payment'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: submitPaymentResultSchemaInput.openapi({
              example: {
                network: Network.Preprod,
                blockchainIdentifier: 'identifier',
                submitResultHash:
                  '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'Payment updated',
        content: {
          'application/json': {
            schema: z
              .object({
                data: submitPaymentResultSchemaOutput,
                status: z.string(),
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    blockchainIdentifier: 'blockchain_identifier',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    submitResultTime: '0',
                    unlockTime: '0',
                    externalDisputeUnlockTime: '0',
                    lastCheckedAt: null,
                    requestedById: 'requester_id',
                    payByTime: null,
                    resultHash: 'result_hash',
                    onChainState: null,
                    inputHash: 'input_hash',
                    NextAction: {
                      requestedAction: PaymentAction.AuthorizeRefundRequested,
                      errorType: null,
                      errorNote: null,
                      resultHash: null,
                    },
                    RequestedFunds: [
                      {
                        amount: '10000000',
                        unit: '',
                      },
                    ],
                    PaymentSource: {
                      id: 'payment_source_id',
                      network: Network.Preprod,
                      policyId: 'policy_id',
                      smartContractAddress: 'address',
                      paymentType: PaymentType.Web3CardanoV1,
                    },
                    BuyerWallet: null,
                    SmartContractWallet: null,
                    metadata: null,
                    WithdrawnForSeller: [],
                    WithdrawnForBuyer: [],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/payment/authorize-refund',
    description:
      'Authorizes a refund for a payment request. This will stop the right to receive a payment and initiate a refund for the other party.',
    summary:
      'Authorizes a refund for a payment request. This will stop the right to receive a payment and initiate a refund for the other party. (admin access required +PAY)',
    tags: ['payment'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: authorizePaymentRefundSchemaInput.openapi({
              example: {
                network: Network.Preprod,
                blockchainIdentifier: 'blockchain_identifier',
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'API key deleted',
        content: {
          'application/json': {
            schema: z
              .object({
                data: authorizePaymentRefundSchemaOutput,
                status: z.string(),
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    blockchainIdentifier: 'blockchain_identifier',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    submitResultTime: '0',
                    unlockTime: '0',
                    externalDisputeUnlockTime: '0',
                    lastCheckedAt: null,
                    payByTime: null,
                    requestedById: 'requester_id',
                    resultHash: 'result_hash',
                    onChainState: null,
                    inputHash: 'input_hash',
                    NextAction: {
                      requestedAction: PaymentAction.AuthorizeRefundRequested,
                      errorType: null,
                      errorNote: null,
                      resultHash: null,
                    },
                    RequestedFunds: [
                      {
                        amount: '10000000',
                        unit: '',
                      },
                    ],
                    PaymentSource: {
                      id: 'payment_source_id',
                      network: Network.Preprod,
                      policyId: 'policy_id',
                      smartContractAddress: 'address',
                      paymentType: PaymentType.Web3CardanoV1,
                    },
                    BuyerWallet: null,
                    SmartContractWallet: null,
                    metadata: null,
                    WithdrawnForSeller: [],
                    WithdrawnForBuyer: [],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  /********************* PURCHASE *****************************/
  registry.registerPath({
    method: 'get',
    path: '/purchase/',
    description:
      'Gets the purchase status. It needs to be created first with a POST request.',
    summary:
      'Get information about an existing purchase request. (READ access required)',
    tags: ['purchase'],
    request: {
      query: queryPurchaseRequestSchemaInput.openapi({
        example: {
          limit: 10,
          cursorId: 'cuid_v2_of_last_cursor_entry',
          network: Network.Preprod,
        },
      }),
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'Purchase status',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: queryPurchaseRequestSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    Purchases: [
                      {
                        id: 'cuid_v2_auto_generated',
                        blockchainIdentifier: 'blockchain_identifier',
                        lastCheckedAt: null,
                        onChainState: null,
                        metadata: null,
                        requestedById: 'requester_id',
                        resultHash: '',
                        cooldownTime: 0,
                        payByTime: null,
                        cooldownTimeOtherParty: 0,
                        collateralReturnLovelace: null,
                        inputHash: 'input_hash',
                        NextAction: {
                          requestedAction:
                            PurchasingAction.FundsLockingRequested,
                          errorType: null,
                          errorNote: null,
                          inputHash: 'input_hash',
                        },
                        createdAt: new Date(1713636260),
                        updatedAt: new Date(1713636260),
                        externalDisputeUnlockTime: (1713636260).toString(),
                        submitResultTime: new Date(1713636260).toISOString(),
                        unlockTime: (1713636260).toString(),
                        PaidFunds: [],
                        PaymentSource: {
                          id: 'payment_source_id',
                          network: Network.Preprod,
                          policyId: 'policy_id',
                          smartContractAddress: 'address',
                          paymentType: PaymentType.Web3CardanoV1,
                        },
                        SellerWallet: null,
                        SmartContractWallet: null,
                        CurrentTransaction: null,
                        TransactionHistory: [],
                        WithdrawnForSeller: [],
                        WithdrawnForBuyer: [],
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/purchase/',
    description:
      'Creates a purchase and pays the seller. This requires funds to be available.',
    summary: 'Create a new purchase request and pay. (access required +PAY)',
    tags: ['purchase'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: createPurchaseInitSchemaInput.openapi({
              example: {
                identifierFromPurchaser: 'aabbaabb11221122aabb',
                network: Network.Preprod,
                sellerVkey: 'seller_vkey',
                paymentType: PaymentType.Web3CardanoV1,
                blockchainIdentifier: 'blockchain_identifier',
                payByTime: (1713626260).toString(),
                submitResultTime: (1713636260).toString(),
                unlockTime: (1713636260).toString(),
                externalDisputeUnlockTime: (1713636260).toString(),
                agentIdentifier: 'agent_identifier',
                inputHash:
                  '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'Purchase request created',
        content: {
          'application/json': {
            schema: z
              .object({
                data: createPurchaseInitSchemaOutput,
                status: z.string(),
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    blockchainIdentifier: 'blockchain_identifier',
                    lastCheckedAt: null,
                    submitResultTime: '0',
                    unlockTime: '0',
                    externalDisputeUnlockTime: '0',
                    payByTime: null,
                    requestedById: 'requester_id',
                    resultHash: '',
                    onChainState: null,
                    inputHash: 'input_hash',
                    NextAction: {
                      requestedAction: PurchasingAction.FundsLockingRequested,
                      errorType: null,
                      errorNote: null,
                    },
                    CurrentTransaction: null,
                    PaidFunds: [
                      {
                        amount: '10000000',
                        unit: '',
                      },
                    ],
                    PaymentSource: {
                      id: 'payment_source_id',
                      policyId: 'policy_id',
                      network: Network.Preprod,
                      smartContractAddress: 'address',
                      paymentType: PaymentType.Web3CardanoV1,
                    },
                    SellerWallet: null,
                    SmartContractWallet: null,
                    metadata: null,
                    WithdrawnForSeller: [],
                    WithdrawnForBuyer: [],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      409: {
        description: 'Conflict (purchase request already exists)',
        content: {
          'application/json': {
            schema: z.object({
              status: z.string(),
              error: z.object({ message: z.string() }),
              id: z.string(),
              object: createPurchaseInitSchemaOutput,
            }),
            example: {
              status: 'error',
              error: { message: 'Purchase request already exists' },
              id: 'cuid_v2_auto_generated',
              object: {
                id: 'cuid_v2_auto_generated',
                createdAt: new Date(1713636260),
                updatedAt: new Date(1713636260),
                blockchainIdentifier: 'blockchain_identifier',
                lastCheckedAt: null,
                submitResultTime: '0',
                unlockTime: '0',
                externalDisputeUnlockTime: '0',
                payByTime: null,
                requestedById: 'requester_id',
                resultHash: '',
                onChainState: null,
                inputHash: 'input_hash',
                NextAction: {
                  requestedAction: PurchasingAction.FundsLockingRequested,
                  errorType: null,
                  errorNote: null,
                },
                CurrentTransaction: null,
                PaidFunds: [
                  {
                    amount: '10000000',
                    unit: '',
                  },
                ],
                PaymentSource: {
                  id: 'payment_source_id',
                  policyId: 'policy_id',
                  network: Network.Preprod,
                  smartContractAddress: 'address',
                  paymentType: PaymentType.Web3CardanoV1,
                },
                SellerWallet: null,
                SmartContractWallet: null,
                metadata: null,
                WithdrawnForSeller: [],
                WithdrawnForBuyer: [],
              },
            },
          },
        },
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/purchase/request-refund',
    description:
      'Requests a refund for a completed purchase. This will collect the refund after the refund time.',
    summary:
      'Request a refund for a completed purchase, which will be automatically collected after the refund time period expires. (+PAY access required)',
    tags: ['purchase'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: requestPurchaseRefundSchemaInput.openapi({
              example: {
                network: Network.Preprod,
                blockchainIdentifier: 'blockchain_identifier',
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'API key deleted',
        content: {
          'application/json': {
            schema: z
              .object({
                data: requestPurchaseRefundSchemaOutput,
                status: z.string(),
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    blockchainIdentifier: 'blockchain_identifier',
                    lastCheckedAt: null,
                    submitResultTime: '0',
                    unlockTime: '0',
                    externalDisputeUnlockTime: '0',
                    payByTime: null,
                    requestedById: 'requester_id',
                    resultHash: '',
                    onChainState: null,
                    NextAction: {
                      requestedAction: PurchasingAction.FundsLockingRequested,
                      errorType: null,
                      errorNote: null,
                    },
                    CurrentTransaction: null,
                    PaidFunds: [
                      {
                        amount: '10000000',
                        unit: '',
                      },
                    ],
                    PaymentSource: {
                      id: 'payment_source_id',
                      policyId: 'policy_id',
                      network: Network.Preprod,
                      smartContractAddress: 'address',
                      paymentType: PaymentType.Web3CardanoV1,
                    },
                    SellerWallet: null,
                    SmartContractWallet: null,
                    metadata: null,
                    WithdrawnForSeller: [],
                    WithdrawnForBuyer: [],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/purchase/cancel-refund-request',
    description:
      'Requests a refund for a completed purchase. This will collect the refund after the refund time.',
    summary:
      'Cancel a previously requested refund for a purchase, reverting the transaction back to its normal processing state. (+PAY access required)',
    tags: ['purchase'],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: cancelPurchaseRefundRequestSchemaInput.openapi({
              example: {
                network: Network.Preprod,
                blockchainIdentifier: 'blockchain_identifier',
              },
            }),
          },
        },
      },
    },
    security: [{ [apiKeyAuth.name]: [] }],
    responses: {
      200: {
        description: 'API key deleted',
        content: {
          'application/json': {
            schema: z
              .object({
                data: cancelPurchaseRefundRequestSchemaOutput,
                status: z.string(),
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    blockchainIdentifier: 'blockchain_identifier',
                    lastCheckedAt: null,
                    submitResultTime: '0',
                    unlockTime: '0',
                    externalDisputeUnlockTime: '0',
                    payByTime: null,
                    requestedById: 'requester_id',
                    resultHash: '',
                    onChainState: null,
                    NextAction: {
                      requestedAction: PurchasingAction.FundsLockingRequested,
                      errorType: null,
                      errorNote: null,
                    },
                    CurrentTransaction: null,
                    PaidFunds: [
                      {
                        amount: '10000000',
                        unit: '',
                      },
                    ],
                    PaymentSource: {
                      id: 'payment_source_id',
                      policyId: 'policy_id',
                      network: Network.Preprod,
                      smartContractAddress: 'address',
                      paymentType: PaymentType.Web3CardanoV1,
                    },
                    SellerWallet: null,
                    SmartContractWallet: null,
                    metadata: null,
                    WithdrawnForSeller: [],
                    WithdrawnForBuyer: [],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/payment/resolve-blockchain-identifier',
    description: 'Resolves a payment request by its blockchain identifier.',
    summary:
      'Resolve a payment request by its blockchain identifier. (READ access required)',
    tags: ['payment'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: postPaymentRequestSchemaInput.openapi({
              example: {
                blockchainIdentifier: 'blockchain_identifier',
                network: Network.Preprod,
                includeHistory: 'false',
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Payment request resolved',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: postPaymentRequestSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    blockchainIdentifier: 'blockchain_identifier',
                    lastCheckedAt: null,
                    payByTime: null,
                    submitResultTime: '0',
                    unlockTime: '0',
                    externalDisputeUnlockTime: '0',
                    requestedById: 'requester_id',
                    resultHash: 'result_hash',
                    inputHash: 'input_hash',
                    cooldownTime: 0,
                    cooldownTimeOtherParty: 0,
                    collateralReturnLovelace: null,
                    onChainState: null,
                    NextAction: {
                      requestedAction: PaymentAction.WaitingForExternalAction,
                      errorType: null,
                      errorNote: null,
                      resultHash: null,
                    },
                    CurrentTransaction: null,
                    TransactionHistory: [],
                    RequestedFunds: [
                      {
                        amount: '10000000',
                        unit: '',
                      },
                    ],
                    PaymentSource: {
                      id: 'payment_source_id',
                      network: Network.Preprod,
                      smartContractAddress: 'address',
                      policyId: 'policy_id',
                      paymentType: PaymentType.Web3CardanoV1,
                    },
                    BuyerWallet: null,
                    SmartContractWallet: null,
                    metadata: null,
                    WithdrawnForSeller: [],
                    WithdrawnForBuyer: [],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      404: {
        description: 'Payment request not found',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/purchase/resolve-blockchain-identifier',
    description: 'Resolves a purchase request by its blockchain identifier.',
    summary:
      'Resolve a purchase request by its blockchain identifier. (READ access required)',
    tags: ['purchase'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: postPurchaseRequestSchemaInput.openapi({
              example: {
                blockchainIdentifier: 'blockchain_identifier',
                network: Network.Preprod,
                includeHistory: 'false',
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Purchase request resolved',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: postPurchaseRequestSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    blockchainIdentifier: 'blockchain_identifier',
                    lastCheckedAt: null,
                    payByTime: null,
                    submitResultTime: '0',
                    unlockTime: '0',
                    externalDisputeUnlockTime: '0',
                    requestedById: 'requester_id',
                    onChainState: null,
                    collateralReturnLovelace: null,
                    cooldownTime: 0,
                    cooldownTimeOtherParty: 0,
                    inputHash: 'input_hash',
                    resultHash: '',
                    NextAction: {
                      inputHash: 'input_hash',
                      requestedAction: PurchasingAction.FundsLockingRequested,
                      errorType: null,
                      errorNote: null,
                    },
                    CurrentTransaction: null,
                    TransactionHistory: [],
                    PaidFunds: [
                      {
                        amount: '10000000',
                        unit: '',
                      },
                    ],
                    PaymentSource: {
                      id: 'payment_source_id',
                      network: Network.Preprod,
                      smartContractAddress: 'address',
                      policyId: 'policy_id',
                      paymentType: PaymentType.Web3CardanoV1,
                    },
                    SellerWallet: null,
                    SmartContractWallet: null,
                    metadata: null,
                    WithdrawnForSeller: [],
                    WithdrawnForBuyer: [],
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request (possible parameters missing or invalid)',
      },
      401: {
        description: 'Unauthorized',
      },
      404: {
        description: 'Purchase request not found',
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  /********************* INVOICE *****************************/
  registry.registerPath({
    method: 'post',
    path: '/invoice/',
    description:
      'Generates an invoice PDF for a payment by blockchain identifier, validating a signed request from the buyer wallet. (admin access required)',
    summary:
      'Generate or retrieve an invoice PDF for a payment. (admin access required)',
    tags: ['invoice'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: postGenerateInvoiceSchemaInput.openapi({
              example: {
                signature: 'ed25519_signature',
                key: 'ed25519_key',
                walletAddress:
                  'addr1xk2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
                validUntil: 1736352000000,
                blockchainIdentifier: 'blockchain_identifier',
                signatureData:
                  '{"action":"retrieve_invoice","validUntil":1736352000000,"hash":"..."}',
                action: 'retrieve_invoice',
                invoiceCurrency: 'usd',
                invoice: {
                  itemNamePrefix: 'Agent: ',
                  title: 'Invoice',
                  language: 'en-us',
                  localizationFormat: 'en-us',
                },
                vatRate: 0.19,
                seller: {
                  country: 'DE',
                  city: 'Berlin',
                  zipCode: '10115',
                  street: 'Example Str.',
                  streetNumber: '1',
                  email: 'seller@example.com',
                  phone: '+49 30 123456',
                  name: 'Alice',
                  companyName: 'Alice GmbH',
                  vatNumber: 'DE123456789',
                },
                buyer: {
                  country: 'DE',
                  city: 'Berlin',
                  zipCode: '10115',
                  street: 'Buyer Str.',
                  streetNumber: '2',
                  email: 'buyer@example.com',
                  phone: '+49 30 987654',
                  name: 'Bob',
                  companyName: null,
                  vatNumber: null,
                },
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Invoice generated or existing invoice returned',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: postGenerateInvoiceSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    invoice: 'BASE64_PDF_STRING',
                  },
                },
              }),
          },
        },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/invoice/signature',
    description:
      'Provides a signed message from the smart contract wallet to authorize invoice retrieval for a purchase. (+PAY access required)',
    summary:
      'Get a signed message to request an invoice. (+PAY access required)',
    tags: ['invoice'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: postSignatureSchemaInput.openapi({
              example: {
                blockchainIdentifier: 'blockchain_identifier',
                action: 'retrieve_invoice',
                buyer: {
                  country: 'DE',
                  city: 'Berlin',
                  zipCode: '10115',
                  street: 'Buyer Str.',
                  streetNumber: '2',
                  email: 'buyer@example.com',
                  phone: '+49 30 987654',
                  name: 'Bob',
                  companyName: null,
                  vatNumber: null,
                },
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Signature generated',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: postSignatureSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    signature: 'ed25519_signature',
                    key: 'ed25519_key',
                    walletAddress: 'addr1...',
                    signatureData:
                      '{"action":"retrieve_invoice","validUntil":1736352000000,"hash":"..."}',
                  },
                },
              }),
          },
        },
      },
    },
  });

  /********************* REGISTRY *****************************/

  registry.registerPath({
    method: 'get',
    path: '/registry/wallet',
    description: 'Gets the agent metadata.',
    summary:
      'Fetch all agents (and their full metadata) that are registered to a specified wallet. (READ access required)',
    tags: ['registry'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      query: queryAgentFromWalletSchemaInput.openapi({
        example: {
          walletVKey: 'wallet_vkey',
          network: Network.Preprod,
        },
      }),
    },
    responses: {
      200: {
        description: 'Agent metadata',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: queryAgentFromWalletSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    Assets: [
                      {
                        policyId: 'policy_id',
                        assetName: 'asset_name',
                        agentIdentifier: 'agent_identifier',
                        Metadata: {
                          name: 'name',
                          description: 'description',
                          apiBaseUrl: 'api_url',
                          ExampleOutputs: [],
                          Tags: ['tag1', 'tag2'],
                          Capability: {
                            name: 'capability_name',
                            version: 'capability_version',
                          },
                          Legal: {
                            privacyPolicy: 'privacy_policy',
                            terms: 'terms',
                            other: 'other',
                          },
                          Author: {
                            name: 'author_name',
                            contactEmail: 'author_contact_email',
                            contactOther: 'author_contact_other',
                            organization: 'author_organization',
                          },
                          image: 'image',
                          AgentPricing: {
                            pricingType: PricingType.Fixed,
                            Pricing: [
                              {
                                amount: '1000000',
                                unit: 'unit',
                              },
                            ],
                          },
                          metadataVersion: 1,
                        },
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/registry/',
    description: 'Gets the agent metadata.',
    summary:
      'List every agent that is recorded in the Masumi Registry. (READ access required)',
    tags: ['registry'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      query: queryRegistryRequestSchemaInput.openapi({
        example: {
          network: Network.Preprod,
          cursorId: 'cursor_id',
        },
      }),
    },
    responses: {
      200: {
        description: 'Agent metadata',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: queryRegistryRequestSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    Assets: [
                      {
                        error: null,
                        id: 'asset_id',
                        name: 'name',
                        description: 'description',
                        Capability: {
                          name: 'capability_name',
                          version: 'capability_version',
                        },
                        Author: {
                          name: 'author_name',
                          organization: 'author_organization',
                          contactEmail: 'author_contact_email',
                          contactOther: 'author_contact_other',
                        },
                        Legal: {
                          privacyPolicy: 'privacy_policy',
                          terms: 'terms',
                          other: 'other',
                        },
                        state: 'RegistrationRequested',
                        Tags: ['tag1', 'tag2'],
                        createdAt: new Date(1713636260),
                        updatedAt: new Date(1713636260),
                        lastCheckedAt: new Date(1713636260),
                        agentIdentifier: 'agent_identifier',
                        apiBaseUrl: 'api_url',
                        ExampleOutputs: [],
                        AgentPricing: {
                          pricingType: PricingType.Fixed,
                          Pricing: [
                            {
                              unit: 'unit',
                              amount: '1000000',
                            },
                          ],
                        },
                        SmartContractWallet: {
                          walletVkey: 'wallet_vkey',
                          walletAddress: 'wallet_address',
                        },
                        CurrentTransaction: null,
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/registry/',
    description:
      'Registers an agent to the registry (Please note that while it it is put on-chain, the transaction is not yet finalized by the blockchain, as designed finality is only eventually reached. If you need certainty, please check status via the registry(GET) or if you require custom logic, the transaction directly using the txHash)',
    summary: 'Registers an agent to the registry (+PAY access required)',
    tags: ['registry'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: registerAgentSchemaInput.openapi({
              example: {
                network: Network.Preprod,
                ExampleOutputs: [
                  {
                    name: 'example_output_name',
                    url: 'https://example.com/example_output',
                    mimeType: 'application/json',
                  },
                ],
                Tags: ['tag1', 'tag2'],
                name: 'Agent Name',
                description: 'Agent Description',
                Author: {
                  name: 'Author Name',
                  contactEmail: 'author@example.com',
                  contactOther: 'author_contact_other',
                  organization: 'Author Organization',
                },
                apiBaseUrl: 'https://api.example.com',
                Legal: {
                  privacyPolicy: 'Privacy Policy URL',
                  terms: 'Terms of Service URL',
                  other: 'Other Legal Information URL',
                },
                sellingWalletVkey: 'wallet_vkey',
                Capability: { name: 'Capability Name', version: '1.0.0' },
                AgentPricing: {
                  pricingType: PricingType.Fixed,
                  Pricing: [
                    {
                      unit: '',
                      amount: '10000000',
                    },
                  ],
                },
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Agent registered',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.string(), data: registerAgentSchemaOutput })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid2',
                    apiBaseUrl: 'api_url',
                    Tags: ['tag1', 'tag2'],
                    Capability: {
                      name: 'capability_name',
                      version: 'capability_version',
                    },
                    Legal: {
                      privacyPolicy: 'privacy_policy',
                      terms: 'terms',
                      other: 'other',
                    },
                    AgentPricing: {
                      pricingType: PricingType.Fixed,
                      Pricing: [
                        {
                          unit: '',
                          amount: '10000000',
                        },
                      ],
                    },
                    ExampleOutputs: [],
                    Author: {
                      name: 'author_name',
                      organization: 'author_organization',
                      contactEmail: 'author_contact_email',
                      contactOther: 'author_contact_other',
                    },
                    SmartContractWallet: {
                      walletVkey: 'wallet_vkey',
                      walletAddress: 'wallet_address',
                    },
                    state: 'RegistrationRequested',
                    description: 'description',
                    name: 'name',
                  },
                },
              }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/registry/deregister',
    description:
      'Deregisters a agent from the specified registry (Please note that while the command is put on-chain, the transaction is not yet finalized by the blockchain, as designed finality is only eventually reached. If you need certainty, please check status via the registry(GET) or if you require custom logic, the transaction directly using the txHash)',
    summary:
      'Deregisters an agent from the specified registry. (admin access required +PAY)',
    tags: ['registry'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: unregisterAgentSchemaInput.openapi({
              example: {
                agentIdentifier: 'agentIdentifier',
                network: Network.Preprod,
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Payment source deleted',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.string(), data: unregisterAgentSchemaOutput })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid2',
                    apiBaseUrl: 'api_url',
                    Tags: ['tag1', 'tag2'],
                    Capability: {
                      name: 'capability_name',
                      version: 'capability_version',
                    },
                    ExampleOutputs: [
                      {
                        name: 'example_output_name',
                        url: 'https://example.com/example_output',
                        mimeType: 'application/json',
                      },
                    ],
                    Author: {
                      name: 'author_name',
                      organization: 'author_organization',
                      contactEmail: 'author_contact_email',
                      contactOther: 'author_contact_other',
                    },
                    Legal: {
                      privacyPolicy: 'privacy_policy',
                      terms: 'terms',
                      other: 'other',
                    },
                    AgentPricing: {
                      pricingType: PricingType.Fixed,
                      Pricing: [
                        {
                          unit: '',
                          amount: '10000000',
                        },
                      ],
                    },
                    SmartContractWallet: {
                      walletVkey: 'wallet_vkey',
                      walletAddress: 'wallet_address',
                    },
                    state: 'RegistrationRequested',
                    description: 'description',
                    name: 'name',
                  },
                },
              }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/registry/',
    description:
      'Permanently deletes an agent registration record from the database. This action is irreversible and should only be used for registrations in specific failed or completed states.',
    summary: 'Delete an agent registration record. (admin access required)',
    tags: ['registry'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: deleteAgentRegistrationSchemaInput.openapi({
              example: {
                id: 'example_id',
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Agent registration deleted successfully',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: deleteAgentRegistrationSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'example_id',
                  },
                },
              }),
          },
        },
      },
      400: {
        description: 'Bad Request - Invalid state for deletion',
        content: {
          'application/json': {
            schema: z.object({
              status: z.string(),
              error: z.object({ message: z.string() }),
            }),
            example: {
              status: 'error',
              error: {
                message:
                  'Agent registration cannot be deleted in its current state: RegistrationRequested',
              },
            },
          },
        },
      },
      401: {
        description: 'Unauthorized',
      },
      404: {
        description: 'Agent Registration not found',
        content: {
          'application/json': {
            schema: z.object({
              status: z.string(),
              error: z.object({ message: z.string() }),
            }),
            example: {
              status: 'error',
              error: { message: 'Agent Registration not found' },
            },
          },
        },
      },
      500: {
        description: 'Internal Server Error',
      },
    },
  });

  /********************* PAYMENT CONTRACT *****************************/
  registry.registerPath({
    method: 'get',
    path: '/payment-source/',
    description: 'Gets the payment source.',
    summary:
      'List payment sources with their public details. (READ access required)',
    tags: ['payment-source'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      query: paymentSourceSchemaInput.openapi({
        example: {
          take: 10,
          cursorId: 'cursor_id',
        },
      }),
    },
    responses: {
      200: {
        description: 'Payment source status',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.string(), data: paymentSourceSchemaOutput })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    PaymentSources: [
                      {
                        id: 'cuid_v2_auto_generated',
                        createdAt: new Date(1713636260),
                        updatedAt: new Date(1713636260),
                        network: Network.Mainnet,
                        paymentType: PaymentType.Web3CardanoV1,
                        smartContractAddress: 'address_of_the_smart_contract',
                        policyId: 'policy_id',
                        AdminWallets: [
                          { walletAddress: 'wallet_address', order: 0 },
                          { walletAddress: 'wallet_address', order: 1 },
                          { walletAddress: 'wallet_address', order: 2 },
                        ],
                        feeRatePermille: 50,
                        FeeReceiverNetworkWallet: {
                          walletAddress: 'wallet_address',
                        },
                        lastCheckedAt: new Date(1713636260),
                        lastIdentifierChecked: 'identifier',
                        PurchasingWallets: [
                          {
                            collectionAddress: null,
                            note: 'note',
                            walletVkey: 'wallet_vkey',
                            walletAddress: 'wallet_address',
                            id: 'unique_cuid_v2_auto_generated',
                          },
                          {
                            collectionAddress: 'send_refunds_to_this_address',
                            note: 'note',
                            walletVkey: 'wallet_vkey',
                            walletAddress: 'wallet_address',
                            id: 'unique_cuid_v2_auto_generated',
                          },
                        ],
                        SellingWallets: [
                          {
                            collectionAddress:
                              'null_will_use_selling_wallet_as_revenue_address',
                            note: 'note',
                            walletVkey: 'wallet_vkey',
                            walletAddress: 'wallet_address',
                            id: 'unique_cuid_v2_auto_generated',
                          },
                          {
                            collectionAddress: 'send_revenue_to_this_address',
                            note: 'note',
                            walletVkey: 'wallet_vkey',
                            walletAddress: 'wallet_address',
                            id: 'unique_cuid_v2_auto_generated',
                          },
                        ],
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
    },
  });

  /********************* PAYMENT SOURCE *****************************/
  registry.registerPath({
    method: 'get',
    path: '/payment-source-extended/',
    description: 'Gets the payment contracts including the status.',
    summary:
      'List payment sources with their public details augmented with internal configuration and sync status information. (admin access required)',
    tags: ['payment-source'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      query: paymentSourceExtendedSchemaInput.openapi({
        example: {
          take: 10,
          cursorId: 'cursor_id',
        },
      }),
    },
    responses: {
      200: {
        description: 'Payment source status',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: paymentSourceExtendedSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    ExtendedPaymentSources: [
                      {
                        id: 'cuid_v2_auto_generated',
                        createdAt: new Date(1713636260),
                        updatedAt: new Date(1713636260),
                        network: Network.Mainnet,
                        paymentType: PaymentType.Web3CardanoV1,
                        feeRatePermille: 50,
                        syncInProgress: true,
                        policyId: 'policy_id',
                        smartContractAddress: 'address_of_the_smart_contract',
                        AdminWallets: [
                          { walletAddress: 'wallet_address', order: 0 },
                          { walletAddress: 'wallet_address', order: 1 },
                          { walletAddress: 'wallet_address', order: 2 },
                        ],
                        FeeReceiverNetworkWallet: {
                          walletAddress: 'wallet_address',
                        },
                        lastCheckedAt: new Date(1713636260),
                        lastIdentifierChecked: 'identifier',
                        PaymentSourceConfig: {
                          rpcProviderApiKey: 'rpc_provider_api_key_blockfrost',
                          rpcProvider: RPCProvider.Blockfrost,
                        },
                        PurchasingWallets: [
                          {
                            collectionAddress: null,
                            note: 'note',
                            walletVkey: 'wallet_vkey',
                            walletAddress: 'wallet_address',
                            id: 'unique_cuid_v2_auto_generated',
                          },
                          {
                            collectionAddress: 'send_refunds_to_this_address',
                            note: 'note',
                            walletVkey: 'wallet_vkey',
                            walletAddress: 'wallet_address',
                            id: 'unique_cuid_v2_auto_generated',
                          },
                        ],
                        SellingWallets: [
                          {
                            collectionAddress:
                              'null_will_use_selling_wallet_as_revenue_address',
                            note: 'note',
                            walletVkey: 'wallet_vkey',
                            walletAddress: 'wallet_address',
                            id: 'unique_cuid_v2_auto_generated',
                          },
                          {
                            collectionAddress: 'send_revenue_to_this_address',
                            note: 'note',
                            walletVkey: 'wallet_vkey',
                            walletAddress: 'wallet_address',
                            id: 'unique_cuid_v2_auto_generated',
                          },
                        ],
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/payment-source-extended/',
    description: 'Creates a payment source.',
    summary: 'Create a new payment source. (+ADMIN access required)',
    tags: ['payment-source'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: paymentSourceExtendedCreateSchemaInput.openapi({
              example: {
                network: Network.Preprod,
                PaymentSourceConfig: {
                  rpcProviderApiKey: 'rpc_provider_api_key',
                  rpcProvider: RPCProvider.Blockfrost,
                },
                paymentType: PaymentType.Web3CardanoV1,
                AdminWallets: [
                  { walletAddress: 'wallet_address_1' },
                  { walletAddress: 'wallet_address_2' },
                  { walletAddress: 'wallet_address_3' },
                ],
                FeeReceiverNetworkWallet: { walletAddress: 'wallet_address' },
                feeRatePermille: 50,
                PurchasingWallets: [
                  {
                    walletMnemonic: 'wallet mnemonic',
                    note: 'note',
                    collectionAddress: null,
                  },
                ],
                SellingWallets: [
                  {
                    walletMnemonic: 'wallet mnemonic',
                    note: 'note',
                    collectionAddress: 'collection_address',
                  },
                ],
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Payment source created',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: paymentSourceExtendedCreateSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    network: Network.Mainnet,
                    paymentType: PaymentType.Web3CardanoV1,
                    syncInProgress: true,
                    smartContractAddress: 'address_of_the_smart_contract',
                    AdminWallets: [
                      { walletAddress: 'wallet_address', order: 0 },
                      { walletAddress: 'wallet_address', order: 1 },
                      { walletAddress: 'wallet_address', order: 2 },
                    ],
                    feeRatePermille: 50,
                    FeeReceiverNetworkWallet: {
                      walletAddress: 'wallet_address',
                    },
                    lastCheckedAt: new Date(1713636260),
                    lastIdentifierChecked: 'identifier',
                    PaymentSourceConfig: {
                      rpcProviderApiKey: 'rpc_provider_api_key_blockfrost',
                      rpcProvider: RPCProvider.Blockfrost,
                    },
                    PurchasingWallets: [
                      {
                        collectionAddress: null,
                        note: 'note',
                        walletVkey: 'wallet_vkey',
                        walletAddress: 'wallet_address',
                        id: 'unique_cuid_v2_auto_generated',
                      },
                      {
                        collectionAddress: 'send_refunds_to_this_address',
                        note: 'note',
                        walletVkey: 'wallet_vkey',
                        walletAddress: 'wallet_address',
                        id: 'unique_cuid_v2_auto_generated',
                      },
                    ],
                    SellingWallets: [
                      {
                        collectionAddress:
                          'null_will_use_the_selling_wallet_as_revenue_address',
                        note: 'note',
                        walletVkey: 'wallet_vkey',
                        walletAddress: 'wallet_address',
                        id: 'unique_cuid_v2_auto_generated',
                      },
                      {
                        collectionAddress: 'send_revenue_to_this_address',
                        note: 'note',
                        walletVkey: 'wallet_vkey',
                        walletAddress: 'wallet_address',
                        id: 'unique_cuid_v2_auto_generated',
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/payment-source-extended/',
    description: 'Updates a payment source.',
    summary: 'Update an existing payment source. (+ADMIN access required)',
    tags: ['payment-source'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: paymentSourceExtendedUpdateSchemaInput.openapi({
              example: {
                id: 'unique_cuid_v2',
                lastIdentifierChecked: 'optional_identifier',
                PaymentSourceConfig: {
                  rpcProviderApiKey: 'rpc_provider_api_key',
                  rpcProvider: RPCProvider.Blockfrost,
                },
                AddPurchasingWallets: [
                  {
                    walletMnemonic: 'wallet_mnemonic',
                    note: 'note',
                    collectionAddress: 'refunds_will_be_sent_to_this_address',
                  },
                ],
                AddSellingWallets: [
                  {
                    walletMnemonic: 'wallet_mnemonic',
                    note: 'note',
                    collectionAddress: 'revenue_will_be_sent_to_this_address',
                  },
                ],
                RemovePurchasingWallets: [{ id: 'unique_cuid_v2' }],
                RemoveSellingWallets: [{ id: 'unique_cuid_v2' }],
              },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Payment contract updated',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: paymentSourceExtendedUpdateSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    id: 'cuid_v2_auto_generated',
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                    network: Network.Mainnet,
                    paymentType: PaymentType.Web3CardanoV1,
                    syncInProgress: true,
                    smartContractAddress: 'address_of_the_smart_contract',
                    AdminWallets: [
                      { walletAddress: 'wallet_address', order: 0 },
                      { walletAddress: 'wallet_address', order: 1 },
                      { walletAddress: 'wallet_address', order: 2 },
                    ],
                    feeRatePermille: 50,
                    FeeReceiverNetworkWallet: {
                      walletAddress: 'wallet_address',
                    },
                    lastCheckedAt: new Date(1713636260),
                    lastIdentifierChecked: 'identifier',
                    PaymentSourceConfig: {
                      rpcProviderApiKey: 'rpc_provider_api_key_blockfrost',
                      rpcProvider: RPCProvider.Blockfrost,
                    },
                    PurchasingWallets: [
                      {
                        collectionAddress: null,
                        note: 'note',
                        walletVkey: 'wallet_vkey',
                        walletAddress: 'wallet_address',
                        id: 'unique_cuid_v2_auto_generated',
                      },
                      {
                        collectionAddress: 'send_refunds_to_this_address',
                        note: 'note',
                        walletVkey: 'wallet_vkey',
                        walletAddress: 'wallet_address',
                        id: 'unique_cuid_v2_auto_generated',
                      },
                    ],
                    SellingWallets: [
                      {
                        collectionAddress:
                          'null_will_use_selling_wallet_as_revenue_address',
                        note: 'note',
                        walletVkey: 'wallet_vkey',
                        walletAddress: 'wallet_address',
                        id: 'unique_cuid_v2_auto_generated',
                      },
                      {
                        collectionAddress: 'send_revenue_to_this_address',
                        note: 'note',
                        walletVkey: 'wallet_vkey',
                        walletAddress: 'wallet_address',
                        id: 'unique_cuid_v2_auto_generated',
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/payment-source-extended/',
    description:
      'Deletes a payment source. WARNING will also delete all associated wallets and transactions.',
    summary: 'Delete an existing payment source. (+ADMIN access required)',
    tags: ['payment-source'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      body: {
        description: '',
        content: {
          'application/json': {
            schema: paymentSourceExtendedDeleteSchemaInput.openapi({
              example: { id: 'unique_cuid_v2_auto_generated' },
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Payment source deleted',
        content: {
          'application/json': {
            schema: z
              .object({
                status: z.string(),
                data: paymentSourceExtendedDeleteSchemaOutput,
              })
              .openapi({
                example: {
                  status: 'success',
                  data: { id: 'unique_cuid_v2_auto_generated' },
                },
              }),
          },
        },
      },
    },
  });
  /********************* UTXOS *****************************/
  registry.registerPath({
    method: 'get',
    path: '/utxos/',
    description: 'Gets UTXOs (internal)',
    summary:
      'Helper endpoint that lets you ask the payment service for the current UTXOs sitting at a particular Cardano address. (READ access required)',
    tags: ['utxos'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      query: getUTXOSchemaInput.openapi({
        example: {
          network: Network.Preprod,
          address: 'addr1qx2ej34k567890',
          count: 10,
          page: 1,
          order: 'desc',
        },
      }),
    },
    responses: {
      200: {
        description: 'UTXOs',
        content: {
          'application/json': {
            schema: z
              .object({ status: z.string(), data: getUTXOSchemaOutput })
              .openapi({
                example: {
                  status: 'success',
                  data: {
                    Utxos: [
                      {
                        txHash: 'tx_hash',
                        address: 'addr1qx2ej34k567890',
                        Amounts: [{ unit: '', quantity: 10000000 }],
                        outputIndex: 1,
                        block: '1',
                        dataHash: 'data_hash',
                        inlineDatum: 'inline_datum',
                        referenceScriptHash: 'reference_script_hash',
                      },
                    ],
                  },
                },
              }),
          },
        },
      },
    },
  });
  /********************* RPC API KEYS *****************************/
  registry.registerPath({
    method: 'get',
    path: '/rpc-api-keys/',
    description:
      'Gets rpc api keys, currently only blockfrost is supported (internal)',
    summary: 'List Blockfrost API keys. (admin access required)',
    tags: ['rpc-api-keys'],
    security: [{ [apiKeyAuth.name]: [] }],
    request: {
      query: getRpcProviderKeysSchemaInput.openapi({
        example: {
          cursorId: 'unique_cuid_v2',
          limit: 50,
        },
      }),
    },
    responses: {
      200: {
        description: 'Blockfrost keys',
        content: {
          'application/json': {
            schema: getRpcProviderKeysSchemaOutput.openapi({
              example: {
                RpcProviderKeys: [
                  {
                    network: Network.Preprod,
                    id: 'unique_cuid_v2',
                    rpcProviderApiKey: 'blockfrost_api_key',
                    rpcProvider: RPCProvider.Blockfrost,
                    createdAt: new Date(1713636260),
                    updatedAt: new Date(1713636260),
                  },
                ],
              },
            }),
          },
        },
      },
    },
  });

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.0',
    info: {
      version: '1.0.0',
      title: 'Masumi Payment Service API',
      description:
        'A comprehensive payment service API for the Masumi ecosystem, providing secure payment processing, agent registry management, and wallet operations.',
    },

    servers: [{ url: './../api/v1/' }],
  });
}
