import { Network } from '@/generated/prisma/enums';

export interface ApiClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

export interface RegistrationData {
  network: Network;
  sellingWalletVkey: string;
  ExampleOutputs: Array<{
    name: string;
    url: string;
    mimeType: string;
  }>;
  Tags: string[];
  name: string;
  apiBaseUrl: string;
  description: string;
  Capability: {
    name: string;
    version: string;
  };
  AgentPricing: {
    pricingType: 'Fixed';
    Pricing: Array<{
      unit: string;
      amount: string;
    }>;
  };
  Legal?: {
    privacyPolicy?: string;
    terms?: string;
    other?: string;
  };
  Author: {
    name: string;
    contactEmail?: string;
    contactOther?: string;
    organization?: string;
  };
}

export interface RegistrationResponse {
  id: string;
  name: string;
  apiBaseUrl: string;
  Capability: {
    name: string | null;
    version: string | null;
  };
  Legal: {
    privacyPolicy: string | null;
    terms: string | null;
    other: string | null;
  };
  Author: {
    name: string;
    contactEmail: string | null;
    contactOther: string | null;
    organization: string | null;
  };
  description: string | null;
  Tags: string[];
  state: string;
  SmartContractWallet: {
    walletVkey: string;
    walletAddress: string;
  };
  ExampleOutputs: Array<{
    name: string;
    url: string;
    mimeType: string;
  }>;
  AgentPricing: {
    pricingType: 'Fixed';
    Pricing: Array<{
      unit: string;
      amount: string;
    }>;
  };
  agentIdentifier?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueryRegistryParams {
  cursorId?: string;
  network: Network;
  filterSmartContractAddress?: string;
}

export interface QueryRegistryResponse {
  Assets: Array<{
    error: string | null;
    id: string;
    name: string;
    description: string | null;
    apiBaseUrl: string;
    Capability: {
      name: string | null;
      version: string | null;
    };
    Author: {
      name: string;
      contactEmail: string | null;
      contactOther: string | null;
      organization: string | null;
    };
    Legal: {
      privacyPolicy: string | null;
      terms: string | null;
      other: string | null;
    };
    state: string;
    Tags: string[];
    createdAt: string;
    updatedAt: string;
    lastCheckedAt: string | null;
    ExampleOutputs: Array<{
      name: string;
      url: string;
      mimeType: string;
    }>;
    agentIdentifier: string | null;
    AgentPricing: {
      pricingType: 'Fixed';
      Pricing: Array<{
        amount: string;
        unit: string;
      }>;
    };
    SmartContractWallet: {
      walletVkey: string;
      walletAddress: string;
    };
    CurrentTransaction: {
      txHash: string;
      status: string;
    } | null;
  }>;
}

export interface CreatePaymentData {
  inputHash: string;
  network: Network;
  agentIdentifier: string;
  RequestedFunds?: Array<{ amount: string; unit: string }>;
  paymentType: string;
  payByTime: string;
  submitResultTime: string;
  unlockTime?: string;
  externalDisputeUnlockTime?: string;
  metadata?: string;
  identifierFromPurchaser: string;
}

export interface PaymentResponse {
  id: string;
  createdAt: string;
  updatedAt: string;
  blockchainIdentifier: string;
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  lastCheckedAt: string | null;
  requestedById: string;
  inputHash: string;
  resultHash: string;
  onChainState: string | null;
  NextAction: {
    requestedAction: string;
    resultHash: string | null;
    errorType: string | null;
    errorNote: string | null;
  };
  RequestedFunds: Array<{
    amount: string;
    unit: string;
  }>;
  WithdrawnForSeller: Array<{
    amount: string;
    unit: string;
  }>;
  WithdrawnForBuyer: Array<{
    amount: string;
    unit: string;
  }>;
  PaymentSource: {
    id: string;
    network: Network;
    smartContractAddress: string;
    policyId: string | null;
    paymentType: string;
  };
  BuyerWallet: {
    id: string;
    walletVkey: string;
  } | null;
  SmartContractWallet: {
    id: string;
    walletVkey: string;
    walletAddress: string;
  } | null;
  metadata: string | null;
}

export interface QueryPaymentsParams {
  limit?: number;
  cursorId?: string;
  network: Network;
  filterSmartContractAddress?: string;
  includeHistory?: boolean;
}

export interface QueryPaymentsResponse {
  Payments: PaymentResponse[];
}

export interface CreatePurchaseData {
  blockchainIdentifier: string;
  network: Network;
  inputHash: string;
  sellerVkey: string;
  agentIdentifier: string;
  Amounts?: Array<{ amount: string; unit: string }>;
  paymentType: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  submitResultTime: string;
  payByTime: string;
  metadata?: string;
  identifierFromPurchaser: string;
}

export interface PurchaseResponse {
  id: string;
  createdAt: string;
  updatedAt: string;
  blockchainIdentifier: string;
  lastCheckedAt: string | null;
  payByTime: string | null;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  requestedById: string;
  resultHash: string;
  inputHash: string;
  onChainState: string | null;
  NextAction: {
    requestedAction: string;
    errorType: string | null;
    errorNote: string | null;
  };
  CurrentTransaction: {
    id: string;
    createdAt: string;
    updatedAt: string;
    txHash: string;
    status: string;
  } | null;
  PaidFunds: Array<{
    amount: string;
    unit: string;
  }>;
  WithdrawnForSeller: Array<{
    amount: string;
    unit: string;
  }>;
  WithdrawnForBuyer: Array<{
    amount: string;
    unit: string;
  }>;
  PaymentSource: {
    id: string;
    network: Network;
    policyId: string | null;
    smartContractAddress: string;
    paymentType: string;
  };
  SellerWallet: {
    id: string;
    walletVkey: string;
  } | null;
  SmartContractWallet: {
    id: string;
    walletVkey: string;
    walletAddress: string;
  } | null;
  metadata: string | null;
}

export interface QueryPurchasesParams {
  limit?: number;
  cursorId?: string;
  network: Network;
  filterSmartContractAddress?: string;
  includeHistory?: boolean;
}

export interface QueryPurchasesResponse {
  Purchases: PurchaseResponse[];
}

export interface QueryPaymentSourcesParams {
  take?: number;
  cursorId?: string;
}

export interface PaymentSourceWallet {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
  note: string | null;
}

export interface PaymentSourceResponse {
  id: string;
  createdAt: string;
  updatedAt: string;
  network: Network;
  policyId: string | null;
  smartContractAddress: string;
  PaymentSourceConfig: {
    rpcProviderApiKey: string;
    rpcProvider: string;
  };
  lastIdentifierChecked: string | null;
  syncInProgress: boolean;
  lastCheckedAt: string | null;
  AdminWallets: Array<{
    walletAddress: string;
    order: number;
  }>;
  PurchasingWallets: PaymentSourceWallet[];
  SellingWallets: PaymentSourceWallet[];
  FeeReceiverNetworkWallet: {
    walletAddress: string;
  };
  feeRatePermille: number;
}

export interface QueryPaymentSourcesResponse {
  ExtendedPaymentSources: PaymentSourceResponse[];
}

export class ApiClient {
  private config: ApiClientConfig;

  constructor(config: ApiClientConfig) {
    this.config = {
      timeout: 30000, // 30 seconds default
      ...config,
    };
  }

  private async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          token: this.config.apiKey,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const jsonResponse: unknown = await response.json();

      // Handle wrapped API responses with { status: "success", data: {...} } format
      if (
        jsonResponse &&
        typeof jsonResponse === 'object' &&
        'status' in jsonResponse &&
        jsonResponse.status === 'success' &&
        'data' in jsonResponse
      ) {
        return (jsonResponse as { data: T }).data;
      }

      return jsonResponse as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        throw new Error(`API request failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Public, typed request helper for E2E tests.
   * Some flows need to call endpoints that don't yet have dedicated methods here.
   */
  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    return this.makeRequest<T>(endpoint, options);
  }

  async registerAgent(data: RegistrationData): Promise<RegistrationResponse> {
    return this.makeRequest<RegistrationResponse>('/api/v1/registry', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async queryRegistry(
    params: QueryRegistryParams,
  ): Promise<QueryRegistryResponse> {
    const searchParams = new URLSearchParams();

    if (params.cursorId) searchParams.set('cursorId', params.cursorId);
    searchParams.set('network', params.network);
    if (params.filterSmartContractAddress) {
      searchParams.set(
        'filterSmartContractAddress',
        params.filterSmartContractAddress,
      );
    }

    return this.makeRequest<QueryRegistryResponse>(
      `/api/v1/registry?${searchParams.toString()}`,
    );
  }

  async getRegistrationById(
    id: string,
    network: Network,
  ): Promise<RegistrationResponse | null> {
    try {
      const response = await this.queryRegistry({ network });
      const registration = response.Assets.find((asset) => asset.id === id);
      return registration || null;
    } catch (error) {
      console.error('Failed to get registration by ID:', error);
      return null;
    }
  }

  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    return this.makeRequest<{ status: string; timestamp: string }>(
      '/api/v1/health',
    );
  }

  async createPayment(data: CreatePaymentData): Promise<PaymentResponse> {
    return this.makeRequest<PaymentResponse>('/api/v1/payment', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async queryPayments(
    params: QueryPaymentsParams,
  ): Promise<QueryPaymentsResponse> {
    const searchParams = new URLSearchParams();

    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.cursorId) searchParams.set('cursorId', params.cursorId);
    searchParams.set('network', params.network);
    if (params.filterSmartContractAddress) {
      searchParams.set(
        'filterSmartContractAddress',
        params.filterSmartContractAddress,
      );
    }
    if (params.includeHistory !== undefined) {
      searchParams.set('includeHistory', params.includeHistory.toString());
    }

    return this.makeRequest<QueryPaymentsResponse>(
      `/api/v1/payment?${searchParams.toString()}`,
    );
  }

  async createPurchase(data: CreatePurchaseData): Promise<PurchaseResponse> {
    return this.makeRequest<PurchaseResponse>('/api/v1/purchase', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async queryPurchases(
    params: QueryPurchasesParams,
  ): Promise<QueryPurchasesResponse> {
    const searchParams = new URLSearchParams();

    if (params.limit) searchParams.set('limit', params.limit.toString());
    if (params.cursorId) searchParams.set('cursorId', params.cursorId);
    searchParams.set('network', params.network);
    if (params.filterSmartContractAddress) {
      searchParams.set(
        'filterSmartContractAddress',
        params.filterSmartContractAddress,
      );
    }
    if (params.includeHistory !== undefined) {
      searchParams.set('includeHistory', params.includeHistory.toString());
    }

    return this.makeRequest<QueryPurchasesResponse>(
      `/api/v1/purchase?${searchParams.toString()}`,
    );
  }

  async queryPaymentSources(
    params?: QueryPaymentSourcesParams,
  ): Promise<QueryPaymentSourcesResponse> {
    const searchParams = new URLSearchParams();

    if (params?.take) searchParams.set('take', params.take.toString());
    if (params?.cursorId) searchParams.set('cursorId', params.cursorId);

    const queryString = searchParams.toString();
    const endpoint = queryString
      ? `/api/v1/payment-source-extended?${queryString}`
      : '/api/v1/payment-source-extended';

    return this.makeRequest<QueryPaymentSourcesResponse>(endpoint);
  }
}

export default ApiClient;
