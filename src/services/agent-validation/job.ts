import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { hashInput, hashInputDeprecated } from './hash';
import { checkInputSchema } from './input-schema';
import { DOCS, fail, pass, warn, type ValidationCheck, isJsonObject, type JsonObject, type JsonValue } from './types';

/**
 * Response validators for the job endpoints of MIP-003. Strictness follows what the
 * marketplace (Sokosumi) and this payment service actually require, since those are the
 * consumers that break: see start_job.schema.ts / status.schema.ts in sokosumi, and
 * purchases/shared.ts in this repo.
 */

const JOB_STATUSES = ['awaiting_payment', 'awaiting_input', 'running', 'completed', 'failed'] as const;
const TIME_KEYS = ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime'] as const;
const MAX_PAYMENT_SOURCE_INDEX = 24;
// POST /purchase (routes/api/purchases/shared.ts) rejects payment times that violate these gaps.
const MINUTE_MS = 60_000;
const MIN_PAY_BY_GAP_MS = 5 * MINUTE_MS;
const MIN_SUBMIT_RESULT_GAP_MS = 15 * MINUTE_MS;
const MIN_DISPUTE_GAP_MS = 15 * MINUTE_MS;
const MIN_SUBMIT_RESULT_AHEAD_MS = 15 * MINUTE_MS;
const MAX_PAY_BY_AGE_MS = 5 * MINUTE_MS;
// Anything below this is a Unix timestamp in seconds (the payment service uses milliseconds).
const MILLISECOND_THRESHOLD = 1e11;
const MIP_004_FIX =
	"Hash identifier_from_purchaser + ';' + the canonical (RFC 8785) JSON of input_data with SHA-256, as MIP-004 describes.";

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const jsonFail = (endpoint: string, label: string) =>
	fail(`agent.${endpoint}.json`, label, {
		detail: 'The response is not a JSON object.',
		fix: 'Return a JSON object with Content-Type application/json.',
		docsUrl: DOCS.agenticServiceApi,
	});

type StartJobContext = {
	/** The nonce we sent in the start_job request. */
	identifierFromPurchaser: string;
	/** The input_data we sent. */
	inputData: unknown;
	/** The on-chain agent identifier, once the agent is registered. */
	expectedAgentIdentifier?: string;
	/** Free agents only need to return an id. */
	isFreeAgent?: boolean;
	/** Clock for the time rules, in milliseconds. Defaults to Date.now(). */
	now?: number;
};

export function checkStartJobResponse(body: unknown, ctx: StartJobContext): ValidationCheck[] {
	const label = 'POST /start_job returns a JSON object';
	if (!isJsonObject(body)) return [jsonFail('start_job', label)];

	const checks: ValidationCheck[] = [pass('agent.start_job.json', label), checkJobId(body)];
	if (ctx.isFreeAgent) return checks;

	checks.push(...checkInputHashFields('start_job', body, ctx));
	checks.push(checkIdentifierFromPurchaser(body, ctx));
	checks.push(checkAgentIdentifier(body, ctx));
	checks.push(checkBlockchainIdentifier(body, ctx));
	checks.push(
		isNonEmptyString(body.sellerVKey)
			? pass('agent.start_job.seller_vkey', 'Response has sellerVKey')
			: fail('agent.start_job.seller_vkey', 'Response has sellerVKey', {
					detail: 'sellerVKey is missing.',
					fix: 'Return the sellerVKey of the payment that was created for this job.',
					docsUrl: DOCS.agenticServiceApi,
				}),
	);
	checks.push(...checkTimes(body, ctx.now ?? Date.now()));
	const paymentSource = checkPaymentSource(body);
	if (paymentSource) checks.push(paymentSource);
	return checks;
}

function checkJobId(body: JsonObject): ValidationCheck {
	const label = 'Response has the job id as "id"';
	if (isNonEmptyString(body.id)) return pass('agent.start_job.job_id', label);
	if (isNonEmptyString(body.job_id)) {
		return warn('agent.start_job.job_id', label, {
			detail: 'The id is returned as job_id. The marketplace accepts it, but MIP-003 names the field id.',
			fix: 'Return the job id as "id".',
			docsUrl: DOCS.agenticServiceApi,
		});
	}
	return fail('agent.start_job.job_id', label, {
		detail: 'No id was returned.',
		fix: 'Return {"id": "<job id>", …} from POST /start_job.',
		docsUrl: DOCS.agenticServiceApi,
	});
}

/** The input_hash field of a start_job or provide_input response, and whether it is the MIP-004 hash of our input. */
function checkInputHashFields(
	endpoint: 'start_job' | 'provide_input',
	body: JsonObject,
	ctx: { identifierFromPurchaser: string; inputData: unknown },
): ValidationCheck[] {
	const label = 'Response has input_hash';
	const id = `agent.${endpoint}.input_hash`;
	const snake = isNonEmptyString(body.input_hash) ? body.input_hash : null;
	const camel = isNonEmptyString(body.inputHash) ? body.inputHash : null;
	const returned = snake ?? camel;
	if (returned == null) {
		return [
			fail(id, label, {
				detail: 'No input_hash was returned.',
				fix: 'Return input_hash, the MIP-004 hash of the input you received.',
				docsUrl: DOCS.hashingSpec,
			}),
		];
	}

	const presence =
		snake != null
			? pass(id, label)
			: fail(id, label, {
					detail:
						'The hash is returned as inputHash. The marketplace response parser requires input_hash and does not accept inputHash, so buyers see an invalid response after the job has already started.',
					fix: 'Return the hash as "input_hash". Some SDK versions serialize it as inputHash; check yours.',
					docsUrl: DOCS.agenticServiceApi,
				});

	const matchesId = `agent.${endpoint}.input_hash_matches`;
	const matchesLabel = 'input_hash matches the MIP-004 hash of our input';
	const expected = hashInput(ctx.inputData, ctx.identifierFromPurchaser);
	let matches: ValidationCheck;
	if (returned === expected) {
		matches = pass(matchesId, matchesLabel);
	} else if (returned === hashInputDeprecated(ctx.inputData, ctx.identifierFromPurchaser)) {
		matches = warn(matchesId, matchesLabel, {
			detail:
				'The hash was computed without the ";" delimiter. The marketplace still accepts this older form, but it is deprecated.',
			fix: MIP_004_FIX,
			docsUrl: DOCS.hashingSpec,
		});
	} else {
		matches = fail(matchesId, matchesLabel, {
			detail: `The agent returned ${returned}, we expected ${expected}.`,
			fix: MIP_004_FIX,
			docsUrl: DOCS.hashingSpec,
		});
	}
	return [presence, matches];
}

function checkIdentifierFromPurchaser(body: JsonObject, ctx: StartJobContext): ValidationCheck {
	const label = 'Response echoes identifierFromPurchaser';
	return body.identifierFromPurchaser === ctx.identifierFromPurchaser
		? pass('agent.start_job.identifier_from_purchaser', label)
		: fail('agent.start_job.identifier_from_purchaser', label, {
				detail: `We sent ${ctx.identifierFromPurchaser}, the agent returned ${JSON.stringify(body.identifierFromPurchaser) ?? 'nothing'}.`,
				fix: 'Return the identifier_from_purchaser from the request as identifierFromPurchaser.',
				docsUrl: DOCS.agenticServiceApi,
			});
}

function checkAgentIdentifier(body: JsonObject, ctx: StartJobContext): ValidationCheck {
	const label = 'Response agentIdentifier is the registered agent';
	if (!isNonEmptyString(body.agentIdentifier)) {
		return fail('agent.start_job.agent_identifier', label, {
			detail: 'agentIdentifier is missing.',
			fix: 'Return the agent identifier shown in the registry.',
			docsUrl: DOCS.agenticServiceApi,
		});
	}
	if (ctx.expectedAgentIdentifier != null && body.agentIdentifier !== ctx.expectedAgentIdentifier) {
		return fail('agent.start_job.agent_identifier', label, {
			detail: `The agent returned ${body.agentIdentifier}, it is registered as ${ctx.expectedAgentIdentifier}.`,
			fix: 'Set AGENT_IDENTIFIER in your agent to the identifier shown in the registry.',
			docsUrl: DOCS.registerAgent,
		});
	}
	return pass('agent.start_job.agent_identifier', label);
}

function checkBlockchainIdentifier(body: JsonObject, ctx: StartJobContext): ValidationCheck {
	const label = 'blockchainIdentifier is valid for this job';
	const problem = (detail: string, fix: string) =>
		fail('agent.start_job.blockchain_identifier', label, { detail, fix, docsUrl: DOCS.agenticServiceApi });

	if (!isNonEmptyString(body.blockchainIdentifier)) {
		return problem(
			'blockchainIdentifier is missing.',
			'Return the blockchainIdentifier of the payment created for this job.',
		);
	}
	let decoded: ReturnType<typeof decodeBlockchainIdentifier> = null;
	try {
		decoded = decodeBlockchainIdentifier(body.blockchainIdentifier);
	} catch {
		decoded = null;
	}
	if (decoded == null) {
		return problem(
			'The blockchainIdentifier cannot be decoded.',
			'Return the blockchainIdentifier exactly as the payment service created it, without changes.',
		);
	}
	if (decoded.purchaserId !== ctx.identifierFromPurchaser) {
		return problem(
			`The identifier was created for purchaser nonce ${decoded.purchaserId}, not for the identifier_from_purchaser we sent (${ctx.identifierFromPurchaser}).`,
			'Create the payment with the identifier_from_purchaser from the start_job request.',
		);
	}
	const expectedAgent =
		ctx.expectedAgentIdentifier ?? (isNonEmptyString(body.agentIdentifier) ? body.agentIdentifier : null);
	if (expectedAgent != null && decoded.agentIdentifier !== expectedAgent) {
		return problem(
			`The identifier embeds agent ${decoded.agentIdentifier ?? 'none'}, not ${expectedAgent}.`,
			'Create the payment for this agent: the agentIdentifier in the payment request must be the registered one.',
		);
	}
	return pass('agent.start_job.blockchain_identifier', label);
}

function parseTime(value: unknown): { time: number; wasString: boolean } | null {
	if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return { time: value, wasString: false };
	if (typeof value === 'string' && /^\d+$/.test(value)) return { time: Number(value), wasString: true };
	return null;
}

function checkTimes(body: JsonObject, now: number): ValidationCheck[] {
	const label = 'Response has the four payment times';
	const parsed = TIME_KEYS.map((key) => ({ key, value: parseTime(body[key]) }));
	const invalid = parsed.filter((entry) => entry.value == null);
	if (invalid.length > 0) {
		return [
			fail('agent.start_job.times', label, {
				detail: invalid.map((entry) => `${entry.key} is ${JSON.stringify(body[entry.key]) ?? 'missing'}`).join('; '),
				fix: `Return ${TIME_KEYS.join(', ')} as integer unix timestamps, as the payment service created them.`,
				docsUrl: DOCS.agenticServiceApi,
			}),
		];
	}
	const times = parsed.map((entry) => entry.value!);
	const checks: ValidationCheck[] = [
		times.some((entry) => entry.wasString)
			? warn('agent.start_job.times', label, {
					detail: 'Some times are numeric strings. The marketplace accepts them, MIP-003 specifies integers.',
					fix: 'Return the times as integers.',
					docsUrl: DOCS.agenticServiceApi,
				})
			: pass('agent.start_job.times', label),
	];
	const [payBy, submitResult, unlock, dispute] = times.map((entry) => entry.time);
	const secondsHint = times.some((entry) => entry.time < MILLISECOND_THRESHOLD)
		? ' These look like Unix seconds, but the payment service uses milliseconds.'
		: '';

	const gapProblems = [
		payBy > submitResult - MIN_PAY_BY_GAP_MS && 'payByTime must be at least 5 minutes before submitResultTime',
		submitResult > unlock - MIN_SUBMIT_RESULT_GAP_MS &&
			'submitResultTime must be at least 15 minutes before unlockTime',
		dispute < unlock + MIN_DISPUTE_GAP_MS && 'externalDisputeUnlockTime must be at least 15 minutes after unlockTime',
	].filter((problem): problem is string => typeof problem === 'string');
	checks.push(
		gapProblems.length === 0
			? pass('agent.start_job.times_ordered', 'Payment times are in order with the required gaps')
			: fail('agent.start_job.times_ordered', 'Payment times are in order with the required gaps', {
					detail: `${gapProblems.join('; ')}.${secondsHint}`,
					fix: 'Create the payment with payByTime at least 5 minutes before submitResultTime, submitResultTime at least 15 minutes before unlockTime, and externalDisputeUnlockTime at least 15 minutes after unlockTime. POST /purchase rejects anything else.',
					docsUrl: DOCS.agenticServiceApi,
				}),
	);

	const futureProblems = [
		payBy < now - MAX_PAY_BY_AGE_MS && 'payByTime is already in the past',
		submitResult < now + MIN_SUBMIT_RESULT_AHEAD_MS && 'submitResultTime is less than 15 minutes ahead',
	].filter((problem): problem is string => typeof problem === 'string');
	checks.push(
		futureProblems.length === 0
			? pass('agent.start_job.times_future', 'Payment times are still in the future')
			: fail('agent.start_job.times_future', 'Payment times are still in the future', {
					detail: `${futureProblems.join('; ')}.${secondsHint}`,
					fix: 'Create the payment with times that start from the current time, in milliseconds. POST /purchase rejects a payByTime more than 5 minutes old and a submitResultTime less than 15 minutes ahead.',
					docsUrl: DOCS.agenticServiceApi,
				}),
	);
	return checks;
}

function checkPaymentSource(body: JsonObject): ValidationCheck | null {
	const type = body.paymentSourceType;
	const index = body.supportedPaymentSourceIndex;
	if (type === undefined && index === undefined) return null;
	const label = 'Optional payment source fields are valid';
	// null and "None" mean "no Cardano source selected" and are legal.
	if (![undefined, null, 'None', 'Web3CardanoV1', 'Web3CardanoV2'].includes(type as string | null | undefined)) {
		return fail('agent.start_job.payment_source', label, {
			detail: `paymentSourceType ${JSON.stringify(type)} is not Web3CardanoV1, Web3CardanoV2, "None" or null. The marketplace rejects the whole response, after the job has started.`,
			fix: 'Return paymentSourceType exactly as the payment service created it.',
			docsUrl: DOCS.agenticServiceApi,
		});
	}
	const parsedIndex = index === undefined ? 0 : parseTime(index)?.time;
	if (parsedIndex == null || parsedIndex > MAX_PAYMENT_SOURCE_INDEX) {
		return warn('agent.start_job.payment_source', label, {
			detail: `supportedPaymentSourceIndex ${JSON.stringify(index)} is not an integer from 0 to ${MAX_PAYMENT_SOURCE_INDEX}. The buyer falls back to the default source.`,
			fix: 'Return supportedPaymentSourceIndex as the payment service created it.',
			docsUrl: DOCS.agenticServiceApi,
		});
	}
	return pass('agent.start_job.payment_source', label);
}

export function checkStatusResponse(body: unknown): ValidationCheck[] {
	const label = 'GET /status returns a JSON object';
	if (!isJsonObject(body)) return [jsonFail('status', label)];

	const status = body.status;
	if (typeof status !== 'string' || !(JOB_STATUSES as readonly string[]).includes(status)) {
		return [
			fail('agent.status.status_value', 'status is a MIP-003 job status', {
				detail: `status is ${JSON.stringify(status) ?? 'missing'}. The marketplace rejects any other value.`,
				fix: `Use one of: ${JOB_STATUSES.join(', ')}.`,
				docsUrl: DOCS.agenticServiceApi,
			}),
		];
	}
	return [
		pass('agent.status.json', label),
		pass('agent.status.status_value', 'status is a MIP-003 job status', { detail: status }),
		...checkStatusInputSchema(status, body.input_schema),
		...checkStatusResult(status, body.result),
	];
}

// The marketplace parses input_schema whenever it is present, not only while awaiting input.
function checkStatusInputSchema(status: string, schema: JsonValue | undefined): ValidationCheck[] {
	if (status !== 'awaiting_input') return schema == null ? [] : checkInputSchema(schema);
	if (schema == null || (Array.isArray(schema) && schema.length === 0)) {
		return [
			fail('agent.status.input_schema', 'input_schema is present while awaiting_input', {
				detail: 'The job awaits input but no input_schema was returned, so the buyer cannot render a form.',
				fix: 'Return input_schema in GET /status whenever the status is awaiting_input.',
				docsUrl: DOCS.humanInTheLoop,
			}),
		];
	}
	return [
		pass('agent.status.input_schema', 'input_schema is present while awaiting_input'),
		...checkInputSchema(schema),
	];
}

function checkStatusResult(status: string, result: JsonValue | undefined): ValidationCheck[] {
	if (status === 'completed') {
		return [
			isNonEmptyString(result)
				? pass('agent.status.result', 'result is a non-empty string when completed')
				: fail('agent.status.result', 'result is a non-empty string when completed', {
						detail: `result is ${result === undefined ? 'missing' : JSON.stringify(result)}.`,
						fix: 'Return the result as a non-empty string. Serialize structured results to a JSON string.',
						docsUrl: DOCS.agenticServiceApi,
					}),
		];
	}
	if (result != null && typeof result !== 'string') {
		return [
			fail('agent.status.result', 'result is a string when present', {
				detail: `result is ${JSON.stringify(result)}. The marketplace parser accepts only a string or null for result at every status.`,
				fix: 'Return result as a string (serialize structured data to JSON) or omit it until the job completes.',
				docsUrl: DOCS.agenticServiceApi,
			}),
		];
	}
	return [];
}

type ProvideInputContext = { identifierFromPurchaser: string; inputData: unknown };

export function checkProvideInputResponse(body: unknown, ctx: ProvideInputContext): ValidationCheck[] {
	const label = 'POST /provide_input returns a JSON object';
	if (!isJsonObject(body)) return [jsonFail('provide_input', label)];

	const signatureLabel = 'Response has a signature';
	let signature: ValidationCheck;
	if (typeof body.signature !== 'string') {
		signature = fail('agent.provide_input.signature', signatureLabel, {
			detail:
				'The signature is missing. The marketplace response parser requires a signature string, so buyers see an invalid response.',
			fix: 'Return "signature": "<Ed25519 signature of the input>". An empty string is accepted but cannot be verified.',
			docsUrl: DOCS.agenticServiceApi,
		});
	} else if (body.signature.length === 0) {
		signature = warn('agent.provide_input.signature', signatureLabel, {
			detail: 'The signature is empty. MIP-003 describes an Ed25519 signature over the input; buyers cannot verify it.',
			fix: 'Sign the input hash with the agent key.',
			docsUrl: DOCS.agenticServiceApi,
		});
	} else {
		signature = pass('agent.provide_input.signature', signatureLabel);
	}
	return [pass('agent.provide_input.json', label), ...checkInputHashFields('provide_input', body, ctx), signature];
}
