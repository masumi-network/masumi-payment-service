import { Network, PaymentSourceType, HotWalletType } from '@/generated/prisma/enums';

export interface ApiClientConfig {
	baseUrl: string;
	apiKey: string;
	timeout?: number;
}

export type FixedAgentPricing = {
	pricingType: 'Fixed';
	Pricing: Array<{
		unit: string;
		amount: string;
	}>;
};

export type FixedSupportedPaymentSourcePricing = {
	pricingType: 'Fixed';
	fixed: Array<{
		asset: string;
		amount: string;
	}>;
};

export interface CardanoSupportedPaymentSource {
	chain: 'Cardano';
	network: Network;
	paymentSourceType: PaymentSourceType;
	address: string;
	pricing: FixedSupportedPaymentSourcePricing;
}

// The API returns a Cardano/EVM union for supportedPaymentSources; e2e flows
// only REGISTER Cardano sources today, but response types must not lie the
// moment an x402 source appears on a queried agent.
export interface EvmSupportedPaymentSource {
	chain: 'EVM';
	network: string;
	scheme: string;
	payTo: string;
	resource?: string | null;
	extra?: Record<string, unknown> | null;
	pricing: {
		pricingType: 'Fixed' | 'Dynamic' | 'Free';
		fixed?: Array<{ asset: string; amount: string; decimals?: number | null }>;
		dynamic?: Array<{ asset: string; decimals?: number | null }>;
	};
}

export type SupportedPaymentSourceResponse = CardanoSupportedPaymentSource | EvmSupportedPaymentSource;

interface RegistrationDataBase {
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

export type RegistrationData = RegistrationDataBase &
	(
		| {
				AgentPricing: FixedAgentPricing;
				supportedPaymentSources?: never;
		  }
		| {
				AgentPricing?: never;
				supportedPaymentSources: CardanoSupportedPaymentSource[];
		  }
	);

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
	AgentPricing: FixedAgentPricing | null;
	agentIdentifier?: string | null;
	supportedPaymentSources?: SupportedPaymentSourceResponse[] | null;
	createdAt: string;
	updatedAt: string;
}

export interface QueryRegistryParams {
	cursorId?: string;
	network: Network;
	filterSmartContractAddress?: string;
	filterPaymentSourceType?: PaymentSourceType;
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
		AgentPricing: FixedAgentPricing | null;
		supportedPaymentSources?: SupportedPaymentSourceResponse[] | null;
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
	paymentSourceType?: PaymentSourceType;
	supportedPaymentSourceIndex?: number;
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
		paymentSourceType: PaymentSourceType;
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
	// Present on /api/v1/payment query responses; null when no tx is in flight
	// for this payment. Exposed here so batch-verification e2e specs can
	// assert that N concurrent payments share the same on-chain tx hash.
	CurrentTransaction?: {
		id: string;
		txHash: string | null;
		status: string;
	} | null;
	metadata: string | null;
}

export interface QueryPaymentsParams {
	limit?: number;
	cursorId?: string;
	network: Network;
	filterSmartContractAddress?: string;
	filterPaymentSourceType?: PaymentSourceType;
	includeHistory?: boolean;
}

export interface QueryPaymentsResponse {
	Payments: PaymentResponse[];
}

export interface CreatePurchaseData {
	blockchainIdentifier: string;
	network: Network;
	smartContractAddress?: string;
	inputHash: string;
	sellerVkey: string;
	agentIdentifier: string;
	Amounts?: Array<{ amount: string; unit: string }>;
	paymentSourceType?: PaymentSourceType;
	supportedPaymentSourceIndex?: number;
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
		paymentSourceType: PaymentSourceType;
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
	filterPaymentSourceType?: PaymentSourceType;
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
	paymentSourceType: PaymentSourceType;
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
	PurchasingWalletsCount: number;
	SellingWalletsCount: number;
	FeeReceiverNetworkWallet: {
		walletAddress: string;
	} | null;
	feeRatePermille: number;
}

export interface QueryPaymentSourcesResponse {
	ExtendedPaymentSources: PaymentSourceResponse[];
}

// Hot wallets are served by the dedicated /wallet/list endpoint, not embedded
// in the payment-source response.
export interface WalletListItem {
	id: string;
	paymentSourceId: string;
	type: HotWalletType;
	walletVkey: string;
	walletAddress: string;
	collectionAddress: string | null;
	note: string | null;
}

export interface QueryWalletsParams {
	take?: number;
	cursorId?: string;
	paymentSourceId?: string;
	walletType?: HotWalletType;
	walletVkey?: string;
	walletAddress?: string;
}

export interface QueryWalletsResponse {
	Wallets: WalletListItem[];
}

export class ApiClient {
	private config: ApiClientConfig;

	constructor(config: ApiClientConfig) {
		this.config = {
			timeout: 30000, // 30 seconds default
			...config,
		};
	}

	private async makeRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
		const url = `${this.config.baseUrl}${endpoint}`;
		// Retry transient socket-level failures (server closed an idle
		// keep-alive socket, TCP RST, etc.). E2E globalSetup awaits ~30 min for
		// on-chain confirmations between API calls; any keep-alive socket the
		// undici fetch dispatcher kept open during that idle window is liable
		// to be closed by the server. The next fetch then surfaces as
		// `fetch failed: SocketError: other side closed` from undici.
		const maxRetries = 3;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
			try {
				const response = await fetch(url, {
					...options,
					signal: controller.signal,
					headers: {
						token: this.config.apiKey,
						'Content-Type': 'application/json',
						// Force a fresh TCP connection on each request. Keep-alive
						// sockets idle through long blockchain polls are the source
						// of the transient socket-closed errors. Cost is minimal
						// for an e2e workload.
						Connection: 'close',
						...options.headers,
					},
				});
				clearTimeout(timeoutId);

				if (!response.ok) {
					const errorText = await response.text();
					// HTTP-level errors (4xx/5xx) are deterministic — don't retry.
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
				// Match transient socket errors via MESSAGE CONTENT only — checking
				// `error.name === 'TypeError'` alone would also retry programmer
				// bugs like "x is not a function" which we want to surface
				// immediately. Undici wraps low-level socket errors as
				// `TypeError('fetch failed')`, so the 'fetch failed' fragment in
				// the message catches the intended case.
				const transientFragments = /fetch failed|SocketError|ECONNRESET|EPIPE|other side closed/i;
				const isTransient =
					error instanceof Error &&
					(transientFragments.test(error.message) ||
						transientFragments.test(String((error as { cause?: unknown }).cause ?? ''))) &&
					!/HTTP \d{3}:/.test(error.message);
				if (isTransient && attempt < maxRetries) {
					// Exponential backoff with jitter: 100ms, 250ms, 600ms (max).
					const delay = Math.floor(Math.random() * (100 * Math.pow(2, attempt) + 100));
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}
				if (error instanceof Error) {
					throw new Error(`API request failed: ${error.message}`);
				}
				throw error;
			}
		}
		throw new Error(`API request failed after ${maxRetries + 1} attempts`);
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

	async queryRegistry(params: QueryRegistryParams): Promise<QueryRegistryResponse> {
		const searchParams = new URLSearchParams();

		if (params.cursorId) searchParams.set('cursorId', params.cursorId);
		searchParams.set('network', params.network);
		if (params.filterSmartContractAddress) {
			searchParams.set('filterSmartContractAddress', params.filterSmartContractAddress);
		}
		if (params.filterPaymentSourceType) {
			searchParams.set('filterPaymentSourceType', params.filterPaymentSourceType);
		}

		return this.makeRequest<QueryRegistryResponse>(`/api/v1/registry?${searchParams.toString()}`);
	}

	async getRegistrationById(
		id: string,
		network: Network,
		paymentSourceType?: PaymentSourceType,
	): Promise<RegistrationResponse | null> {
		try {
			const response = await this.queryRegistry({
				network,
				filterPaymentSourceType: paymentSourceType ?? global.testConfig?.paymentSourceType,
			});
			const registration = response.Assets.find((asset) => asset.id === id);
			return registration || null;
		} catch (error) {
			console.error('Failed to get registration by ID:', error);
			return null;
		}
	}

	async healthCheck(): Promise<{ status: string; timestamp: string }> {
		return this.makeRequest<{ status: string; timestamp: string }>('/api/v1/health');
	}

	async createPayment(data: CreatePaymentData): Promise<PaymentResponse> {
		return this.makeRequest<PaymentResponse>('/api/v1/payment', {
			method: 'POST',
			body: JSON.stringify(data),
		});
	}

	async queryPayments(params: QueryPaymentsParams): Promise<QueryPaymentsResponse> {
		const searchParams = new URLSearchParams();

		if (params.limit) searchParams.set('limit', params.limit.toString());
		if (params.cursorId) searchParams.set('cursorId', params.cursorId);
		searchParams.set('network', params.network);
		if (params.filterSmartContractAddress) {
			searchParams.set('filterSmartContractAddress', params.filterSmartContractAddress);
		}
		if (params.filterPaymentSourceType) {
			searchParams.set('filterPaymentSourceType', params.filterPaymentSourceType);
		}
		if (params.includeHistory !== undefined) {
			searchParams.set('includeHistory', params.includeHistory.toString());
		}

		return this.makeRequest<QueryPaymentsResponse>(`/api/v1/payment?${searchParams.toString()}`);
	}

	async createPurchase(data: CreatePurchaseData): Promise<PurchaseResponse> {
		return this.makeRequest<PurchaseResponse>('/api/v1/purchase', {
			method: 'POST',
			body: JSON.stringify(data),
		});
	}

	async queryPurchases(params: QueryPurchasesParams): Promise<QueryPurchasesResponse> {
		const searchParams = new URLSearchParams();

		if (params.limit) searchParams.set('limit', params.limit.toString());
		if (params.cursorId) searchParams.set('cursorId', params.cursorId);
		searchParams.set('network', params.network);
		if (params.filterSmartContractAddress) {
			searchParams.set('filterSmartContractAddress', params.filterSmartContractAddress);
		}
		if (params.filterPaymentSourceType) {
			searchParams.set('filterPaymentSourceType', params.filterPaymentSourceType);
		}
		if (params.includeHistory !== undefined) {
			searchParams.set('includeHistory', params.includeHistory.toString());
		}

		return this.makeRequest<QueryPurchasesResponse>(`/api/v1/purchase?${searchParams.toString()}`);
	}

	async queryPaymentSources(params?: QueryPaymentSourcesParams): Promise<QueryPaymentSourcesResponse> {
		const searchParams = new URLSearchParams();

		if (params?.take) searchParams.set('take', params.take.toString());
		if (params?.cursorId) searchParams.set('cursorId', params.cursorId);

		const queryString = searchParams.toString();
		const endpoint = queryString ? `/api/v1/payment-source-extended?${queryString}` : '/api/v1/payment-source-extended';

		return this.makeRequest<QueryPaymentSourcesResponse>(endpoint);
	}

	async queryWallets(params?: QueryWalletsParams): Promise<QueryWalletsResponse> {
		const searchParams = new URLSearchParams();

		if (params?.take != null) searchParams.set('take', params.take.toString());
		if (params?.cursorId) searchParams.set('cursorId', params.cursorId);
		if (params?.paymentSourceId) searchParams.set('paymentSourceId', params.paymentSourceId);
		if (params?.walletType) searchParams.set('walletType', params.walletType);
		if (params?.walletVkey) searchParams.set('walletVkey', params.walletVkey);
		if (params?.walletAddress) searchParams.set('walletAddress', params.walletAddress);

		const queryString = searchParams.toString();
		const endpoint = queryString ? `/api/v1/wallet/list?${queryString}` : '/api/v1/wallet/list';

		return this.makeRequest<QueryWalletsResponse>(endpoint);
	}

	/**
	 * Resolve a single payment by `blockchainIdentifier` via the dedicated
	 * resolve endpoint. Prefer this over `queryPayments(...).find(...)` in
	 * tests — paginated listings can drop the target row as CI history
	 * accumulates. Returns `undefined` on 404 so the polling callers can
	 * treat the "not yet present" case uniformly.
	 */
	async resolvePaymentByBlockchainIdentifier(params: {
		blockchainIdentifier: string;
		network: Network;
		filterSmartContractAddress?: string;
		includeHistory?: boolean;
	}): Promise<PaymentResponse | undefined> {
		const body: Record<string, unknown> = {
			blockchainIdentifier: params.blockchainIdentifier,
			network: params.network,
		};
		if (params.filterSmartContractAddress != null) {
			body.filterSmartContractAddress = params.filterSmartContractAddress;
		}
		if (params.includeHistory != null) {
			body.includeHistory = params.includeHistory ? 'true' : 'false';
		}
		try {
			return await this.makeRequest<PaymentResponse>('/api/v1/payment/resolve-blockchain-identifier', {
				method: 'POST',
				body: JSON.stringify(body),
			});
		} catch (err) {
			if (err instanceof Error && /HTTP 404:/.test(err.message)) {
				return undefined;
			}
			throw err;
		}
	}

	/**
	 * Resolve a single purchase by `blockchainIdentifier`. See
	 * `resolvePaymentByBlockchainIdentifier` for rationale.
	 */
	async resolvePurchaseByBlockchainIdentifier(params: {
		blockchainIdentifier: string;
		network: Network;
		filterSmartContractAddress?: string;
		includeHistory?: boolean;
	}): Promise<PurchaseResponse | undefined> {
		const body: Record<string, unknown> = {
			blockchainIdentifier: params.blockchainIdentifier,
			network: params.network,
		};
		if (params.filterSmartContractAddress != null) {
			body.filterSmartContractAddress = params.filterSmartContractAddress;
		}
		if (params.includeHistory != null) {
			body.includeHistory = params.includeHistory ? 'true' : 'false';
		}
		try {
			return await this.makeRequest<PurchaseResponse>('/api/v1/purchase/resolve-blockchain-identifier', {
				method: 'POST',
				body: JSON.stringify(body),
			});
		} catch (err) {
			if (err instanceof Error && /HTTP 404:/.test(err.message)) {
				return undefined;
			}
			throw err;
		}
	}
}
