// Plain types only: the pure validators must stay importable without express-zod-api (ESM-only,
// not loadable under Jest). The zod/OpenAPI schema for this shape lives in the route's schemas.ts.

/**
 * fail = will break registry listing or payment; warn = spec drift or risk;
 * skipped = not applicable yet.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export type ValidationCheck = {
	/** Stable id, e.g. "agent.availability.type" */
	id: string;
	status: CheckStatus;
	/** What was checked */
	label: string;
	/** What was observed */
	detail: string | null;
	/** What to change to resolve it */
	fix: string | null;
	docsUrl: string | null;
};

type CheckExtras = { detail?: string; fix?: string; docsUrl?: string };

const makeCheck =
	(status: CheckStatus) =>
	(id: string, label: string, extras: CheckExtras = {}): ValidationCheck => ({
		id,
		status,
		label,
		detail: extras.detail ?? null,
		fix: extras.fix ?? null,
		docsUrl: extras.docsUrl ?? null,
	});

export const pass = makeCheck('pass');
export const warn = makeCheck('warn');
export const fail = makeCheck('fail');
export const skipped = makeCheck('skipped');

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const DOCS_ROOT = 'https://www.masumi.network/dev/masumi/documentation';

export const DOCS = {
	agenticServiceApi: `${DOCS_ROOT}/technical-documentation/agentic-service-api`,
	humanInTheLoop: `${DOCS_ROOT}/how-to-guides/human-in-the-loop`,
	registryMetadata: `${DOCS_ROOT}/technical-documentation/registry-metadata-standard`,
	registerAgent: `${DOCS_ROOT}/get-started/register-agent`,
	quickstart: `${DOCS_ROOT}/how-to-guides/_quickstart`,
	inputSchemaSpec:
		'https://github.com/masumi-network/masumi-improvement-proposals/blob/main/MIPs/MIP-003/MIP-003-Attachement-01.md',
	coworkerMetadata: 'https://github.com/masumi-network/sokosumi/blob/main/docs/coworker-metadata.md',
	hashingSpec: 'https://github.com/masumi-network/masumi-improvement-proposals/blob/main/MIPs/MIP-004/MIP-004.md',
} as const;
