import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

class ProbeSocket extends EventEmitter {
	close = jest.fn<() => void>();
}
const socket = new ProbeSocket();
const WebSocketMock = jest.fn<(url: string, options: object) => ProbeSocket>(() => socket);
jest.unstable_mockModule('ws', () => ({ default: WebSocketMock }));
const { probeHeadCurrentSlot } = await import('./head-session-ops');
const { MAX_HYDRA_WS_FRAME_BYTES } = await import('@/lib/hydra/hydra/schemas');

afterEach(() => {
	socket.removeAllListeners();
	jest.clearAllMocks();
});

describe('head clock probe transport', () => {
	it('limits frames before allocation and disables compression', async () => {
		const result = probeHeadCurrentSlot('ws://localhost:4001', 'head-1');
		expect(WebSocketMock).toHaveBeenCalledWith('ws://localhost:4001?history=no', {
			maxPayload: MAX_HYDRA_WS_FRAME_BYTES,
			perMessageDeflate: false,
		});
		socket.emit(
			'message',
			Buffer.from(JSON.stringify({ tag: 'Greetings', headId: 'head-1', chainSyncedStatus: 'InSync', currentSlot: 12 })),
			false,
		);
		await expect(result).resolves.toBe(12);
	});

	it('rejects a binary Greetings frame', async () => {
		const result = probeHeadCurrentSlot('ws://localhost:4001', 'head-1');
		socket.emit(
			'message',
			Buffer.from(JSON.stringify({ tag: 'Greetings', headId: 'head-1', chainSyncedStatus: 'InSync', currentSlot: 12 })),
			true,
		);
		await expect(result).resolves.toBeNull();
		expect(socket.close).toHaveBeenCalledTimes(1);
	});
});
