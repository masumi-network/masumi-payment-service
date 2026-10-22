import { HydraHostRequestError } from './client';

/** The Host's answer for a node it does not have, as opposed to a wrong URL. */
const NODE_GONE_DETAIL = 'no such node';

/** The Host no longer has this node, for example one removed by hand after its head went Final. */
export function isHostNodeGone(error: unknown): boolean {
	// The status alone is not enough: a base URL missing a proxy prefix also
	// answers 404, and would then report a node that still exists as gone.
	return error instanceof HydraHostRequestError && error.status === 404 && error.message.includes(NODE_GONE_DETAIL);
}
