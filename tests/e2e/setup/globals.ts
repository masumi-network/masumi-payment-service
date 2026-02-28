import type { ApiClient } from '../utils/apiClient';
import type { ConfirmedAgent } from '../helperFunctions';
import type { getTestEnvironment } from '../fixtures/testData';

declare global {
	// eslint-disable-next-line no-var
	var testApiClient: ApiClient;
	// eslint-disable-next-line no-var
	var testConfig: ReturnType<typeof getTestEnvironment>;
	// eslint-disable-next-line no-var
	var testAgent: ConfirmedAgent;
	// eslint-disable-next-line no-var
	var __e2eErrorHandlersInstalled: boolean | undefined;
}

export {};
