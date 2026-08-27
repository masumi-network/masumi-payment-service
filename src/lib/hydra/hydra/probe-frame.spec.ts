import { describe, expect, it } from '@jest/globals';
import { HydraProtocolError } from './errors';
import { parseHydraWebSocketProbeFrame } from './probe-frame';
import { MAX_HYDRA_WS_FRAME_BYTES } from './schemas';

describe('parseHydraWebSocketProbeFrame', () => {
	it('parses a bounded text status frame', () => {
		expect(parseHydraWebSocketProbeFrame('{"tag":"Greetings","headStatus":"Idle"}')).toEqual({
			tag: 'Greetings',
			headStatus: 'Idle',
		});
	});

	it('rejects binary frames instead of copying them into text', () => {
		expect(() => parseHydraWebSocketProbeFrame(Buffer.from('{"tag":"Greetings"}'))).toThrow(HydraProtocolError);
	});

	it('rejects oversized text before JSON parsing', () => {
		const oversized = ' '.repeat(MAX_HYDRA_WS_FRAME_BYTES + 1);
		expect(() => parseHydraWebSocketProbeFrame(oversized)).toThrow(`over ${MAX_HYDRA_WS_FRAME_BYTES} bytes`);
	});

	it('rejects malformed JSON', () => {
		expect(() => parseHydraWebSocketProbeFrame('{')).toThrow('invalid JSON');
	});
});
