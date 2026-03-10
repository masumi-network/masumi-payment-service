import { jest } from '@jest/globals';

const mockSetupTracing = jest.fn<() => Promise<void>>();
const mockStartApp = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('@/tracing', () => ({
	setupTracing: mockSetupTracing,
}));

jest.unstable_mockModule('@/app', () => ({
	startApp: mockStartApp,
}));

const { bootstrap } = await import('./index');

describe('bootstrap', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		process.env.NODE_ENV = 'test';
	});

	it('awaits tracing setup before starting the app', async () => {
		const callOrder: string[] = [];
		mockSetupTracing.mockImplementation(async () => {
			callOrder.push('tracing');
		});
		mockStartApp.mockImplementation(async () => {
			callOrder.push('app');
		});

		await bootstrap();

		expect(callOrder).toEqual(['tracing', 'app']);
	});

	it('rejects when app startup fails', async () => {
		mockSetupTracing.mockResolvedValue(undefined);
		mockStartApp.mockRejectedValue(new Error('startup failed'));

		await expect(bootstrap()).rejects.toThrow('startup failed');
	});
});
