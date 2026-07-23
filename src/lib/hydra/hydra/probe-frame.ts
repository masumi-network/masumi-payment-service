import { HydraProtocolError } from './errors';
import { parseHydraJson } from './json';
import { MAX_HYDRA_WS_FRAME_BYTES } from './schemas';

/** Parse the first status-probe frame without accepting binary or oversized data. */
export function parseHydraWebSocketProbeFrame(data: unknown): unknown {
	if (typeof data !== 'string') {
		throw new HydraProtocolError('Hydra status probe rejected a non-text WebSocket frame');
	}
	if (Buffer.byteLength(data, 'utf8') > MAX_HYDRA_WS_FRAME_BYTES) {
		throw new HydraProtocolError(
			`Hydra status probe rejected a WebSocket frame over ${MAX_HYDRA_WS_FRAME_BYTES} bytes`,
		);
	}
	try {
		return parseHydraJson(data);
	} catch (error) {
		throw new HydraProtocolError('Hydra status probe received invalid JSON', { cause: error });
	}
}
