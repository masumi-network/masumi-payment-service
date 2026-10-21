import {
	pinnedRequest,
	type BlockCause,
	type PinnedRequestOptions,
	type PinnedRequestResult,
} from '@/utils/security/pinned-request';
import { checkApiBaseUrl, checkAvailabilityResponse } from './availability';
import { checkInputSchema } from './input-schema';
import { checkProvideInputResponse, checkStartJobResponse, checkStatusResponse } from './job';
import { DOCS, fail, isJsonObject, pass, warn, type JsonObject, type ValidationCheck } from './types';

/**
 * Calls one fixed MIP-003 endpoint of an agent and returns findings, not just the response.
 * The path suffix is fixed per endpoint and never caller-supplied; the base path comes from `apiBaseUrl`, so an admin can
 * reach any public URL they name. That is acceptable for an admin tool, and private addresses are never fetched.
 */

type ProbeEndpoint = 'availability' | 'input_schema' | 'demo' | 'start_job' | 'status' | 'provide_input';

type ProbeInput = {
	apiBaseUrl: string;
	endpoint: ProbeEndpoint;
	/** status and provide_input */
	jobId?: string;
	/** start_job and provide_input: the nonce sent, also used to recompute the MIP-004 hash. */
	identifierFromPurchaser?: string;
	/** start_job and provide_input: the input_data sent. */
	inputData?: JsonObject;
	/** provide_input: sha256 of the canonical input_schema from /status. */
	inputSchemaHash?: string;
	/** The on-chain agent identifier once registered. */
	expectedAgentIdentifier?: string;
	/** Free agents only return an id from start_job. */
	isFreeAgent?: boolean;
};

type ProbeResult = {
	httpStatus: number | null;
	durationMs: number;
	redirectedTo: string | null;
	/** First 20 000 characters of the response body. */
	bodyText: string | null;
	checks: ValidationCheck[];
};

type RequestFn = (url: string, options: PinnedRequestOptions) => Promise<PinnedRequestResult>;

// The registry gives up on /availability after 32 s, so probing waits as long.
const PROBE_TIMEOUT_MS = 32_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const BODY_TEXT_LIMIT = 20_000;
const ERROR_SNIPPET_LENGTH = 200;

type Plan = { path: string; method: 'GET' | 'POST'; body?: string } | { missing: ValidationCheck };

const missingInput = (endpoint: string, field: string, flag: string): { missing: ValidationCheck } => ({
	missing: fail(`agent.${endpoint}.${field}`, `The probe has the ${flag} it needs`, {
		detail: `POST/GET /${endpoint} cannot be probed without ${flag}.`,
		fix: `Provide ${flag}.`,
	}),
});

function buildPlan(input: ProbeInput): Plan {
	const { endpoint, jobId, identifierFromPurchaser } = input;
	switch (endpoint) {
		case 'availability':
		case 'input_schema':
		case 'demo':
			return { path: `/${endpoint}`, method: 'GET' };
		case 'status':
			return jobId
				? { path: `/status?job_id=${encodeURIComponent(jobId)}`, method: 'GET' }
				: missingInput('status', 'job_id', 'jobId');
		case 'start_job':
			return identifierFromPurchaser
				? {
						path: '/start_job',
						method: 'POST',
						body: JSON.stringify({
							identifier_from_purchaser: identifierFromPurchaser,
							input_data: input.inputData ?? {},
						}),
					}
				: missingInput('start_job', 'identifier_from_purchaser', 'identifierFromPurchaser');
		case 'provide_input':
			if (!jobId) return missingInput('provide_input', 'job_id', 'jobId');
			if (!identifierFromPurchaser)
				return missingInput('provide_input', 'identifier_from_purchaser', 'identifierFromPurchaser');
			// MIP-003 buyers always send it, and agents such as masumi-saas answer 400 without it.
			if (!input.inputSchemaHash) return missingInput('provide_input', 'input_schema_hash', 'inputSchemaHash');
			return {
				path: '/provide_input',
				method: 'POST',
				body: JSON.stringify({
					job_id: jobId,
					input_schema_hash: input.inputSchemaHash,
					input_data: input.inputData ?? {},
				}),
			};
	}
}

export async function probeAgentEndpoint(input: ProbeInput, request: RequestFn = pinnedRequest): Promise<ProbeResult> {
	const urlChecks = checkApiBaseUrl(input.apiBaseUrl);
	if (urlChecks.some((check) => check.status === 'fail')) return emptyResult(urlChecks);

	const plan = buildPlan(input);
	if ('missing' in plan) return emptyResult([...urlChecks, plan.missing]);

	// Same normalization as the registry: trim, URL.toString(), drop one trailing slash. The URL checks above
	// have already parsed this string, so it cannot throw here.
	const base = new URL(input.apiBaseUrl.trim()).toString().replace(/\/$/, '');
	const url = `${base}${plan.path}`;
	const result = await request(url, {
		method: plan.method,
		body: plan.body,
		timeoutMs: PROBE_TIMEOUT_MS,
		maxBytes: MAX_RESPONSE_BYTES,
	});

	if (result.kind === 'blocked') return emptyResult(blockedChecks(urlChecks, result.cause, result.reason));
	if (result.kind === 'error') {
		return {
			httpStatus: null,
			durationMs: result.durationMs,
			redirectedTo: null,
			bodyText: null,
			checks: [...urlChecks, ...failedRequestChecks(input.endpoint, result.error, result.durationMs)],
		};
	}

	const isRedirect = result.status >= 300 && result.status < 400 && result.location != null;
	return {
		httpStatus: result.status,
		durationMs: result.durationMs,
		redirectedTo: isRedirect ? result.location : null,
		bodyText: result.body.length > 0 ? result.body.slice(0, BODY_TEXT_LIMIT) : null,
		checks: [...urlChecks, ...checkResponse(input, plan.method, result)],
	};
}

const withoutCheck = (checks: ValidationCheck[], id: string) => checks.filter((check) => check.id !== id);

function blockedChecks(urlChecks: ValidationCheck[], cause: BlockCause, reason: string): ValidationCheck[] {
	switch (cause) {
		case 'blocked_address':
			return [
				...withoutCheck(urlChecks, 'agent.url.public_host'),
				fail('agent.url.public_host', 'URL host is publicly reachable', {
					detail: `${reason}. The registry marks such an agent Invalid.`,
					fix: 'Expose your agent publicly (a cloud deployment, or a tunnel such as ngrok) and register that URL.',
					docsUrl: DOCS.registerAgent,
				}),
			];
		case 'unresolvable':
			return [
				...urlChecks,
				fail('agent.url.resolves', 'URL hostname resolves', {
					detail: `${reason}. The registry marks an agent whose hostname does not resolve Offline.`,
					fix: 'Check the hostname for typos and that a public DNS record exists for it.',
					docsUrl: DOCS.registerAgent,
				}),
			];
		case 'other':
			return [
				...withoutCheck(urlChecks, 'agent.url.valid'),
				fail('agent.url.valid', 'URL is a valid absolute http(s) URL', {
					detail: `${reason}.`,
					fix: 'Use a plain https://host/path URL without credentials.',
					docsUrl: DOCS.registerAgent,
				}),
			];
	}
}

const emptyResult = (checks: ValidationCheck[]): ProbeResult => ({
	httpStatus: null,
	durationMs: 0,
	redirectedTo: null,
	bodyText: null,
	checks,
});

function failedRequestChecks(endpoint: ProbeEndpoint, error: string, durationMs: number): ValidationCheck[] {
	if (endpoint === 'availability') {
		return checkAvailabilityResponse({ httpStatus: null, error, redirectedTo: null, durationMs, body: undefined });
	}
	const optional = endpoint === 'demo';
	return [
		(optional ? warn : fail)(`agent.${endpoint}.reachable`, `/${endpoint} is reachable`, {
			detail: `The request failed: ${error}.`,
			fix: 'Check that the agent is running and reachable from the internet.',
			docsUrl: DOCS.agenticServiceApi,
		}),
	];
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

type ResponseResult = Extract<PinnedRequestResult, { kind: 'response' }>;

function checkResponse(input: ProbeInput, method: string, result: ResponseResult): ValidationCheck[] {
	const { endpoint } = input;
	const body = parseJson(result.body);
	const isOk = result.status >= 200 && result.status < 300;
	const isRedirect = result.status >= 300 && result.status < 400 && result.location != null;

	if (endpoint === 'availability') {
		return checkAvailabilityResponse(
			{
				httpStatus: result.status,
				error: null,
				redirectedTo: isRedirect ? result.location : null,
				durationMs: result.durationMs,
				body,
			},
			input.expectedAgentIdentifier,
		);
	}

	const label = `${method} /${endpoint} answers with 2xx`;
	const optional = endpoint === 'demo';
	const problem = optional ? warn : fail;
	if (!isOk) {
		const detail = isRedirect
			? `Answered HTTP ${result.status}, redirecting to ${result.location}. Redirects are not followed, so buyers and the registry cannot use this URL.`
			: `Answered HTTP ${result.status}: ${result.body.replace(/\s+/g, ' ').slice(0, ERROR_SNIPPET_LENGTH)}`;
		return [
			problem(`agent.${endpoint}.reachable`, label, {
				detail,
				fix: failureFix(method, endpoint, result.body),
				docsUrl: DOCS.agenticServiceApi,
			}),
		];
	}

	const checks: ValidationCheck[] = [pass(`agent.${endpoint}.reachable`, label)];
	if (body === undefined) {
		checks.push(
			problem(`agent.${endpoint}.json`, `${method} /${endpoint} returns JSON`, {
				detail: 'The body is not valid JSON.',
				fix: 'Return JSON with Content-Type application/json.',
				docsUrl: DOCS.agenticServiceApi,
			}),
		);
		return checks;
	}
	return [...checks, ...validateBody(input, body)];
}

function validateBody(input: ProbeInput, body: unknown): ValidationCheck[] {
	const identifierFromPurchaser = input.identifierFromPurchaser ?? '';
	const inputData = input.inputData ?? {};
	switch (input.endpoint) {
		case 'input_schema':
			return checkInputSchema(body);
		case 'status':
			return checkStatusResponse(body);
		case 'start_job':
			return checkStartJobResponse(body, {
				identifierFromPurchaser,
				inputData,
				expectedAgentIdentifier: input.expectedAgentIdentifier,
				isFreeAgent: input.isFreeAgent,
			});
		case 'provide_input':
			return checkProvideInputResponse(body, { identifierFromPurchaser, inputData });
		case 'demo':
			return [checkDemoShape(body)];
		case 'availability':
			return [];
	}
}

function checkDemoShape(body: unknown): ValidationCheck {
	const record = isJsonObject(body) ? body : {};
	const hasInput = isJsonObject(record.input);
	const hasResult = isJsonObject(record.output) && typeof record.output.result === 'string';
	return hasInput && hasResult
		? pass('agent.demo.shape', 'GET /demo returns {input, output: {result}}')
		: warn('agent.demo.shape', 'GET /demo returns {input, output: {result}}', {
				detail: 'The optional /demo response is missing input or output.result.',
				fix: 'Return {"input": {...}, "output": {"result": "..."}} so buyers can preview your agent.',
				docsUrl: DOCS.agenticServiceApi,
			});
}

/** The node rejects a V2 payment that does not name a source; SDKs that predate V2 (pip-masumi 1.2.0) never send it. */
function failureFix(method: string, endpoint: string, body: string): string {
	if (body.includes('supportedPaymentSourceIndex')) {
		return 'Your agent calls POST /payment without supportedPaymentSourceIndex (and paymentSourceType), which a V2 payment source requires. Send both in the payment request, or use an SDK version that supports V2; the V1 payment source does not need them.';
	}
	return `Make ${method} /${endpoint} answer 200.`;
}
