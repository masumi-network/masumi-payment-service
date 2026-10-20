import { DOCS, fail, pass, warn, isJsonObject, type JsonObject, type ValidationCheck } from './types';

/**
 * Validates Sokosumi coworker metadata (the `Coworker.metadata` JSON) the way the marketplace does.
 * A single invalid coworker makes Sokosumi's whole coworker list fail to load, so mistakes here are
 * worth catching before they are pasted in.
 * Reference: sokosumi apps/core/src/schemas/coworker.schema.ts and docs/coworker-metadata.md
 */

const ID = 'agent.coworker';
const KNOWN_KEYS = new Set(['channels', 'profile', 'offers']);
const PROFILE_LISTS = ['llm', 'capabilities', 'examples'] as const;
const CATEGORIES = new Set([
	'Research',
	'Planning',
	'Coordination',
	'Engineering',
	'Presentations',
	'Prototyping',
	'Writing',
	'Social',
]);
const OUTPUT_TYPES = ['pdf', 'image', 'slides', 'doc', 'sheet', 'text', 'html'];
// Spellings the marketplace normalizes to a canonical output type.
const OUTPUT_TYPE_ALIASES: Record<string, string> = {
	doc: 'doc',
	docx: 'doc',
	slides: 'slides',
	ppt: 'slides',
	pptx: 'slides',
	sheet: 'sheet',
	xls: 'sheet',
	xlsx: 'sheet',
	csv: 'sheet',
	pdf: 'pdf',
	image: 'image',
	png: 'image',
	jpg: 'image',
	jpeg: 'image',
	gif: 'image',
	webp: 'image',
	svg: 'image',
	text: 'text',
	md: 'text',
	markdown: 'text',
	html: 'html',
	htm: 'html',
};

const cwFail = (id: string, label: string, detail: string, fix: string): ValidationCheck =>
	fail(`${ID}.${id}`, label, { detail, fix, docsUrl: DOCS.coworkerMetadata });
const cwWarn = (id: string, label: string, detail: string, fix: string): ValidationCheck =>
	warn(`${ID}.${id}`, label, { detail, fix, docsUrl: DOCS.coworkerMetadata });

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === 'string');

export function checkCoworkerMetadata(value: unknown): ValidationCheck[] {
	if (!isJsonObject(value)) {
		return [
			cwFail(
				'json',
				'Metadata is a JSON object',
				'The metadata is not a JSON object.',
				'Use {"channels": {"email": "agent@example.com"}} as the starting point.',
			),
		];
	}
	const problems = [
		...checkUnknownKeys(value),
		...checkChannels(value.channels),
		...checkProfile(value.profile),
		...checkOffers(value.offers),
	];
	const hasProblem = problems.some((check) => check.status !== 'pass');
	return hasProblem
		? problems
		: [...problems, pass(`${ID}.valid`, 'Coworker metadata is valid', { docsUrl: DOCS.coworkerMetadata })];
}

function checkUnknownKeys(metadata: JsonObject): ValidationCheck[] {
	const unknown = Object.keys(metadata).filter((key) => !KNOWN_KEYS.has(key));
	if (unknown.length === 0) return [];
	return [
		cwWarn(
			'unknown_keys',
			'Metadata only uses known keys',
			`The marketplace ignores: ${unknown.join(', ')}.`,
			'Keep only channels, profile and offers.',
		),
	];
}

function checkChannels(channels: unknown): ValidationCheck[] {
	const label = 'channels is a map of provider to contact';
	if (!isJsonObject(channels)) {
		return [
			cwFail(
				'channels',
				label,
				channels === undefined ? 'channels is missing.' : 'channels is not an object.',
				'Add "channels": {"email": "agent@example.com"}. channels is the only required key.',
			),
		];
	}
	const invalid = Object.entries(channels).filter(([, contact]) => typeof contact !== 'string');
	if (invalid.length > 0) {
		return [
			cwFail(
				'channels',
				label,
				`These channels are not strings: ${invalid.map(([provider]) => provider).join(', ')}.`,
				'Use a plain string for every channel, e.g. "email": "agent@example.com".',
			),
		];
	}
	const links = Object.entries(channels).filter(
		([, contact]) => typeof contact === 'string' && /^\[.*\]\(.*\)$/.test(contact),
	);
	if (links.length > 0) {
		return [
			cwWarn(
				'channels',
				label,
				`These channels are Markdown links: ${links.map(([provider]) => provider).join(', ')}.`,
				'Use a bare address such as "agent@example.com", not a Markdown link.',
			),
		];
	}
	return [];
}

function checkProfile(profile: unknown): ValidationCheck[] {
	if (profile === undefined) return [];
	if (!isJsonObject(profile)) {
		return [
			cwFail(
				'profile',
				'profile is an object',
				'profile is not an object.',
				'Use an object with llm, hosting, capabilities and examples.',
			),
		];
	}
	const checks: ValidationCheck[] = [];
	for (const key of PROFILE_LISTS) {
		if (profile[key] !== undefined && !isStringList(profile[key])) {
			checks.push(
				cwFail(
					`profile.${key}`,
					`profile.${key} is a list of strings`,
					`${key} is not a list of strings.`,
					`Use "${key}": ["...", "..."].`,
				),
			);
		}
	}
	if (profile.hosting !== undefined && typeof profile.hosting !== 'string') {
		checks.push(
			cwFail(
				'profile.hosting',
				'profile.hosting is a string',
				'hosting is not a string.',
				'Use a text such as "EU · Frankfurt".',
			),
		);
	}
	return checks;
}

function checkOffers(offers: unknown): ValidationCheck[] {
	if (offers === undefined) return [];
	if (!Array.isArray(offers)) {
		return [
			cwFail(
				'offers',
				'offers is a list',
				'offers is not an array.',
				'Use "offers": [{"title": "...", "prompt": "..."}].',
			),
		];
	}
	return offers.flatMap((offer, index) => checkOffer(offer, index));
}

function checkOffer(offer: unknown, index: number): ValidationCheck[] {
	const base = `offers.${index}`;
	if (!isJsonObject(offer)) {
		return [
			cwFail(
				base,
				`Offer #${index} is an object`,
				'The offer is not an object.',
				'Use {"title": "...", "prompt": "..."}.',
			),
		];
	}
	const checks: ValidationCheck[] = [];
	for (const key of ['title', 'prompt']) {
		if (typeof offer[key] !== 'string') {
			checks.push(
				cwFail(
					`${base}.${key}`,
					`Offer #${index} has a ${key}`,
					`${key} is ${offer[key] === undefined ? 'missing' : 'not a string'}.`,
					`Add "${key}": "..." (required).`,
				),
			);
		}
	}
	for (const key of ['category', 'description', 'deliverable']) {
		if (offer[key] !== undefined && typeof offer[key] !== 'string') {
			checks.push(
				cwFail(
					`${base}.${key}`,
					`Offer #${index} ${key} is a string`,
					`${key} is not a string.`,
					`Use text for ${key}.`,
				),
			);
		}
	}
	if (typeof offer.category === 'string' && !CATEGORIES.has(offer.category)) {
		checks.push(
			cwWarn(
				`${base}.category`,
				`Offer #${index} uses a known category`,
				`"${offer.category}" is not a themed category, so the card renders neutrally.`,
				`Use one of: ${[...CATEGORIES].join(', ')} (spelled exactly).`,
			),
		);
	}
	return [...checks, ...checkOutputs(base, offer.outputs)];
}

function checkOutputs(base: string, outputs: unknown): ValidationCheck[] {
	if (outputs === undefined) return [];
	if (!Array.isArray(outputs)) {
		return [
			cwFail(
				`${base}.outputs`,
				'outputs is a list',
				'outputs is not an array.',
				'Use "outputs": [{"type": "pdf", "url": "https://..."}].',
			),
		];
	}
	return outputs.flatMap((output, index) => checkOutput(`${base}.outputs.${index}`, output));
}

/** "offers.0.outputs.1" as words, so a finding says which output it is about. */
function outputName(base: string): string {
	const match = /offers\.(\d+)\.outputs\.(\d+)/.exec(base);
	return match ? `Offer #${match[1]} output #${match[2]}` : 'Output';
}

function checkOutput(base: string, output: unknown): ValidationCheck[] {
	const name = outputName(base);
	if (!isJsonObject(output)) {
		return [
			cwFail(
				base,
				`${name} is an object`,
				'The output is not an object.',
				'Use {"type": "pdf", "url": "https://..."}.',
			),
		];
	}
	const checks: ValidationCheck[] = [];
	const normalized = typeof output.type === 'string' ? OUTPUT_TYPE_ALIASES[output.type.toLowerCase()] : undefined;
	if (normalized === undefined) {
		checks.push(
			cwFail(
				`${base}.type`,
				`${name} has a known type`,
				`type is ${JSON.stringify(output.type) ?? 'missing'}.`,
				`Use one of: ${OUTPUT_TYPES.join(', ')} (common file extensions such as docx or png are also accepted).`,
			),
		);
	}
	for (const key of ['url', 'label', 'text']) {
		if (output[key] !== undefined && typeof output[key] !== 'string') {
			checks.push(
				cwFail(`${base}.${key}`, `${name} ${key} is a string`, `${key} is not a string.`, `Use text for ${key}.`),
			);
		}
	}
	if (normalized !== undefined && output.url === undefined && output.text === undefined) {
		checks.push(
			cwWarn(
				`${base}.content`,
				`${name} has something to preview`,
				'The output has neither a url nor inline text, so the preview is empty.',
				'Add "url" for a hosted file, or "text" for inline Markdown or HTML.',
			),
		);
	}
	return checks;
}
