import { jest } from '@jest/globals';

const mockEmit = jest.fn();
const mockWinstonDebug = jest.fn();
const mockWinstonInfo = jest.fn();
const mockWinstonWarn = jest.fn();
const mockWinstonError = jest.fn();
const mockWinstonLog = jest.fn();

jest.unstable_mockModule('@opentelemetry/api-logs', () => ({
	logs: {
		getLogger: jest.fn(() => ({
			emit: mockEmit,
		})),
	},
	SeverityNumber: {
		DEBUG: 5,
		INFO: 9,
		WARN: 13,
		ERROR: 17,
		FATAL: 21,
	},
}));

jest.unstable_mockModule('@/utils/logger', () => ({
	logger: {
		debug: mockWinstonDebug,
		info: mockWinstonInfo,
		warn: mockWinstonWarn,
		error: mockWinstonError,
		log: mockWinstonLog,
	},
}));

const { logInfo, logWarn } = await import('./logs');

describe('logs helper', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('routes warn logs to Winston warn without preformatting the message', () => {
		logWarn(
			'Wallet entered low balance during interval check',
			{ component: 'wallet_low_balance_monitor' },
			{ network: 'Preprod' },
		);

		expect(mockEmit).toHaveBeenCalledWith(
			expect.objectContaining({
				severityText: 'WARN',
				body: 'Wallet entered low balance during interval check',
				attributes: expect.objectContaining({
					component: 'wallet_low_balance_monitor',
					network: 'Preprod',
					level: 'warn',
				}),
			}),
		);
		expect(mockWinstonWarn).toHaveBeenCalledWith('Wallet entered low balance during interval check', {
			component: 'wallet_low_balance_monitor',
			network: 'Preprod',
		});
		expect(mockWinstonInfo).not.toHaveBeenCalled();
	});

	it('routes info logs to Winston info with raw message text', () => {
		logInfo('Starting scheduled monitoring cycle', { component: 'wallet_low_balance_monitor' });

		expect(mockWinstonInfo).toHaveBeenCalledWith('Starting scheduled monitoring cycle', {
			component: 'wallet_low_balance_monitor',
		});
		expect(mockWinstonWarn).not.toHaveBeenCalled();
		expect(mockWinstonInfo.mock.calls[0]?.[0]).toBe('Starting scheduled monitoring cycle');
	});
});
