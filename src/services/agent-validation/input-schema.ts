import { DOCS, fail, pass, warn, type ValidationCheck, isJsonObject } from './types';

/**
 * Validates an agent's input schema (GET /input_schema, or `input_schema` in GET /status)
 * against MIP-003 Attachment 01. Where the marketplace (Sokosumi) is stricter or looser than the
 * spec table, the marketplace wins, because that is what renders the form: e.g. every field needs a
 * `name`, bare-array schemas are not parsed, and a hidden field may omit its value.
 * Reference: sokosumi packages/masumi/src/schemas/input/{input,validation}.schema.ts
 */

const FIELD_TYPES = new Set([
	'text',
	'textarea',
	'number',
	'boolean',
	'option',
	'none',
	'email',
	'password',
	'tel',
	'url',
	'date',
	'datetime-local',
	'time',
	'month',
	'week',
	'color',
	'range',
	'file',
	'hidden',
	'search',
	'checkbox',
	'radio',
]);
const CHOICE_TYPES = new Set(['option', 'radio', 'multiselect']);
const VALIDATIONS = new Set(['min', 'max', 'format', 'accept', 'optional', 'step']);
const FORMATS = new Set(['email', 'url', 'nonempty', 'integer', 'tel_pattern']);
const ID = 'agent.input_schema';
const SHAPE_LABEL = 'Schema has input_data or input_groups';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const schemaFail = (id: string, label: string, detail: string, fix: string): ValidationCheck =>
	fail(`${ID}.${id}`, label, { detail, fix, docsUrl: DOCS.inputSchemaSpec });

const schemaWarn = (id: string, label: string, detail: string, fix: string): ValidationCheck =>
	warn(`${ID}.${id}`, label, { detail, fix, docsUrl: DOCS.inputSchemaSpec });

/**
 * pip-masumi (pydantic) serialises unset optional fields as explicit nulls, so a null
 * must read as "absent" or the reference SDK's own output would fail. Nulls inside
 * arrays are kept: they are real values there.
 */
function withoutNullKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutNullKeys);
	if (!isJsonObject(value)) return value;
	const entries = Object.entries(value).filter(([, entry]) => entry !== null);
	return Object.fromEntries(entries.map(([key, entry]) => [key, withoutNullKeys(entry)]));
}

export function checkInputSchema(rawSchema: unknown): ValidationCheck[] {
	const schema = withoutNullKeys(rawSchema);
	const resolved = resolveFields(schema);
	const { fields, groups } = resolved;
	if (fields == null) return resolved.checks;

	const fieldChecks = fields.flatMap((field, index) => checkField(field, index));
	return [
		...resolved.checks,
		...fieldChecks,
		checkUniqueIds(
			'unique_ids',
			'Field ids are unique',
			'Field',
			fields,
			'Ids must be unique across the whole schema, including groups.',
		),
		...(groups
			? [checkUniqueIds('unique_group_ids', 'Group ids are unique', 'Group', groups, 'Group ids must be unique.')]
			: []),
		...(fieldChecks.length === 0
			? [pass(`${ID}.fields`, 'Every field is valid', { detail: `${fields.length} field(s) checked.` })]
			: []),
	];
}

type ResolvedFields = { checks: ValidationCheck[]; fields?: unknown[]; groups?: unknown[] };

/** Finds the list of fields in whichever of the three shapes the agent used. */
function resolveFields(schema: unknown): ResolvedFields {
	if (Array.isArray(schema)) {
		return {
			checks: [
				schemaFail(
					'shape',
					SHAPE_LABEL,
					'The schema is a bare array. The marketplace parses only the object form, so buyers cannot load this schema.',
					'Return {"input_data": [...]} instead of a bare array.',
				),
			],
			fields: schema,
		};
	}
	if (!isJsonObject(schema)) {
		return {
			checks: [
				schemaFail(
					'shape',
					SHAPE_LABEL,
					'The schema is not a JSON object.',
					'Return {"input_data": [...]} from GET /input_schema.',
				),
			],
		};
	}
	const hasData = 'input_data' in schema;
	const hasGroups = 'input_groups' in schema;
	if (hasData === hasGroups) {
		return {
			checks: [
				schemaFail(
					'shape',
					SHAPE_LABEL,
					hasData ? 'Both input_data and input_groups are present.' : 'Neither input_data nor input_groups is present.',
					'Return either input_data or input_groups, not both.',
				),
			],
		};
	}
	const list = hasData ? schema.input_data : schema.input_groups;
	if (!Array.isArray(list)) {
		const key = hasData ? 'input_data' : 'input_groups';
		return {
			checks: [schemaFail('shape', SHAPE_LABEL, `${key} is not an array.`, `Make ${key} an array.`)],
		};
	}
	const shape = pass(`${ID}.shape`, SHAPE_LABEL);
	if (hasData) return { checks: [shape], fields: list };

	const groupChecks: ValidationCheck[] = [];
	const fields = collectGroupFields(list, groupChecks);
	return { checks: [shape, ...groupChecks], fields, groups: list };
}

function collectGroupFields(groups: unknown[], checks: ValidationCheck[]): unknown[] {
	return groups.flatMap((group, index) => {
		const label = isJsonObject(group) && isNonEmptyString(group.id) ? group.id : `#${index}`;
		if (
			!isJsonObject(group) ||
			!isNonEmptyString(group.id) ||
			!isNonEmptyString(group.title) ||
			!Array.isArray(group.input_data)
		) {
			checks.push(
				schemaFail(
					`group.${label}`,
					`Group ${label} has id, title and input_data`,
					'Each group needs a non-empty id, a title and an input_data array.',
					'Use {"id": "...", "title": "...", "input_data": [...]} for every group.',
				),
			);
			return [];
		}
		return group.input_data;
	});
}

function checkField(field: unknown, index: number): ValidationCheck[] {
	if (!isJsonObject(field)) {
		return [
			schemaFail(
				`field.${index}.shape`,
				`Field #${index} is an object`,
				'The field is not a JSON object.',
				'Describe every field as an object with id, type and name.',
			),
		];
	}
	const fid = isNonEmptyString(field.id) ? field.id : `#${index}`;
	return [
		...(isNonEmptyString(field.id)
			? []
			: [
					schemaFail(
						'field_id',
						`Field #${index} has an id`,
						'The field has no id.',
						'Give every field a unique, non-empty id.',
					),
				]),
		...(isNonEmptyString(field.name)
			? []
			: [
					schemaFail(
						`field.${fid}.name`,
						`Field ${fid} has a name`,
						'The field has no name. MIP-003 lists it as optional in one table and required in another; the marketplace rejects the schema without it.',
						'Add "name": "<label shown to the buyer>".',
					),
				]),
		...checkType(fid, field.type),
		...checkTypeData(fid, field.type, field.data),
		...checkValidations(fid, field.validations),
	];
}

function checkType(fid: string, type: unknown): ValidationCheck[] {
	const label = `Field ${fid} has a known type`;
	if (type === 'string') {
		return [
			schemaWarn(
				`field.${fid}.type`,
				label,
				'Type "string" appears in older MIP-003 examples. Attachment 01 calls it "text".',
				'Use "text" instead of "string".',
			),
		];
	}
	if (type === 'multiselect') {
		return [
			schemaWarn(
				`field.${fid}.type`,
				label,
				'multiselect is not listed in MIP-003 Attachment 01. The Sokosumi marketplace supports it; other buyers may not.',
				'Use "option" with min and max validations for portable multi-select.',
			),
		];
	}
	if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
		return [
			schemaFail(
				`field.${fid}.type`,
				label,
				`Type ${JSON.stringify(type) ?? 'is missing'} is not supported.`,
				`Use one of: ${[...FIELD_TYPES].join(', ')}.`,
			),
		];
	}
	return [];
}

function checkTypeData(fid: string, type: unknown, data: unknown): ValidationCheck[] {
	const record = isJsonObject(data) ? data : {};
	if (typeof type === 'string' && CHOICE_TYPES.has(type)) return checkChoices(fid, type, record.values);
	if (type === 'file' && record.outputFormat !== 'url') {
		return [
			schemaFail(
				`field.${fid}.output_format`,
				`Field ${fid} sets outputFormat to "url"`,
				`outputFormat is ${JSON.stringify(record.outputFormat) ?? 'missing'}; "url" is the only supported value.`,
				'Add "data": {"outputFormat": "url"}.',
			),
		];
	}
	if (type === 'checkbox' && !isJsonObject(data)) {
		return [
			schemaFail(
				`field.${fid}.data`,
				`Field ${fid} has a data object`,
				'A checkbox field has no data object. The marketplace rejects it, even when the object is empty.',
				'Add "data": {} (or {"label": "...", "default": false}).',
			),
		];
	}
	if (type === 'hidden' && (record.value === undefined || record.value === null)) {
		return [
			schemaWarn(
				`field.${fid}.value`,
				`Field ${fid} has a value`,
				'A hidden field has no data.value. Attachment 01 requires it; the Sokosumi marketplace tolerates a missing value.',
				'Add "data": {"value": "..."}.',
			),
		];
	}
	return [];
}

function checkChoices(fid: string, type: string, values: unknown): ValidationCheck[] {
	const id = `field.${fid}.values`;
	const label = `Field ${fid} lists its choices`;
	if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === 'string')) {
		return [
			schemaFail(
				id,
				label,
				`A ${type} field needs a non-empty list of choices.`,
				'Set data.values to the choices, e.g. "data": {"values": ["Option 1", "Option 2"]}.',
			),
		];
	}
	const duplicates = [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
	if (duplicates.length > 0) {
		return [
			schemaFail(
				id,
				label,
				`Duplicate choice(s): ${duplicates.join(', ')}. The marketplace requires every choice to be unique.`,
				'Remove the repeated entries from data.values.',
			),
		];
	}
	return [];
}

function checkValidations(fid: string, validations: unknown): ValidationCheck[] {
	if (validations === undefined) return [];
	if (!Array.isArray(validations)) {
		return [
			schemaFail(
				`field.${fid}.validation`,
				`Field ${fid} validations are a list`,
				'validations is not an array.',
				'Use "validations": [{"validation": "min", "value": "3"}].',
			),
		];
	}
	return validations.flatMap((entry, index) => checkValidationEntry(fid, entry, index));
}

function checkValidationEntry(fid: string, entry: unknown, index: number): ValidationCheck[] {
	const id = `field.${fid}.validation.${index}`;
	const label = `Field ${fid} validation #${index} is valid`;
	if (!isJsonObject(entry) || typeof entry.validation !== 'string' || !VALIDATIONS.has(entry.validation)) {
		return [
			schemaFail(
				id,
				label,
				`Unknown validation ${JSON.stringify(isJsonObject(entry) ? entry.validation : entry)}.`,
				`Use one of: ${[...VALIDATIONS].join(', ')}.`,
			),
		];
	}
	const { validation, value } = entry;
	if (validation === 'format' && value === 'tel-pattern') {
		return [
			schemaWarn(
				id,
				label,
				'MIP-003 spells this format "tel-pattern", but the Sokosumi marketplace only parses "tel_pattern".',
				'Use "tel_pattern" so the marketplace accepts the field.',
			),
		];
	}
	if (validation === 'format' && !(typeof value === 'string' && FORMATS.has(value))) {
		return [
			schemaFail(id, label, `Unknown format ${JSON.stringify(value)}.`, `Use one of: ${[...FORMATS].join(', ')}.`),
		];
	}
	if (validation === 'optional' && value !== 'true' && value !== 'false') {
		return [
			schemaFail(
				id,
				label,
				`The optional validation has value ${JSON.stringify(value)}. The marketplace accepts only "true" or "false".`,
				'Use {"validation": "optional", "value": "true"}.',
			),
		];
	}
	if (typeof value !== 'string') {
		return [
			schemaWarn(
				id,
				label,
				`The value of "${validation}" is ${JSON.stringify(value)}, not a string.`,
				'Send validation values as strings, e.g. "20".',
			),
		];
	}
	if (validation === 'min' && Number(value) < 1) {
		return [
			schemaWarn(
				id,
				label,
				`min is ${value}. MIP-003 requires min to be at least 1 when set.`,
				'Remove min, or mark the field optional instead of using min 0.',
			),
		];
	}
	return [];
}

function checkUniqueIds(id: string, label: string, noun: string, items: unknown[], hint: string): ValidationCheck {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const item of items) {
		if (!isJsonObject(item) || !isNonEmptyString(item.id)) continue;
		if (seen.has(item.id)) duplicates.add(item.id);
		seen.add(item.id);
	}
	return duplicates.size === 0
		? pass(`${ID}.${id}`, label)
		: schemaFail(
				id,
				label,
				`Duplicate ${noun.toLowerCase()} id(s): ${[...duplicates].join(', ')}. ${hint}`,
				`Rename the duplicates so each ${noun.toLowerCase()} has its own id.`,
			);
}
