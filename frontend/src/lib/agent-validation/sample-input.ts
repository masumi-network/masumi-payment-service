import { getOwnValue, isPlainObject, type RuntimeValue } from '../object-properties';

/**
 * Reads an agent's input schema (input_data or input_groups) and invents plausible input for it, so a
 * developer can run a job, or answer a human-in-the-loop request, without typing every field by hand.
 * The result is only a starting point: the wizard shows it as editable JSON.
 */

export type SchemaField = {
  id: string;
  name: string;
  type: string;
  values: string[];
  description: string | null;
  optional: boolean;
  defaultValue: RuntimeValue;
  fixedValue: string | null;
  min: number | null;
  max: number | null;
};

export type SampleValue = string | number | boolean | string[];

/** `input_data` as the API takes it: one flat value per field id. */
export type InputData = Record<string, SampleValue | null>;

function numberValidation(field: RuntimeValue, name: string): number | null {
  const validations = isPlainObject(field) ? getOwnValue(field, 'validations') : undefined;
  if (!Array.isArray(validations)) return null;
  for (const entry of validations) {
    if (!isPlainObject(entry) || getOwnValue(entry, 'validation') !== name) continue;
    const value = getOwnValue(entry, 'value');
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toField(entry: RuntimeValue): SchemaField | null {
  if (!isPlainObject(entry)) return null;
  const id = getOwnValue(entry, 'id');
  if (typeof id !== 'string' || id.length === 0) return null;
  const type = getOwnValue(entry, 'type');
  const name = getOwnValue(entry, 'name');
  const data = getOwnValue(entry, 'data');
  const dataObject = isPlainObject(data) ? data : null;
  const values = dataObject ? getOwnValue(dataObject, 'values') : undefined;
  const description = dataObject ? getOwnValue(dataObject, 'description') : undefined;
  const fixed = dataObject ? getOwnValue(dataObject, 'value') : undefined;
  const validations = getOwnValue(entry, 'validations');
  const isOptional =
    Array.isArray(validations) &&
    validations.some(
      (validation) =>
        isPlainObject(validation) &&
        getOwnValue(validation, 'validation') === 'optional' &&
        getOwnValue(validation, 'value') === 'true',
    );
  return {
    id,
    name: typeof name === 'string' ? name : id,
    type: typeof type === 'string' ? type : 'text',
    values: Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string')
      : [],
    description: typeof description === 'string' ? description : null,
    optional: isOptional,
    defaultValue: dataObject ? getOwnValue(dataObject, 'default') : undefined,
    fixedValue: typeof fixed === 'string' ? fixed : null,
    min: numberValidation(entry, 'min'),
    max: numberValidation(entry, 'max'),
  };
}

/** All fields of a schema in order, with groups flattened. Unusable entries are skipped, never thrown on. */
export function schemaFields(schema: RuntimeValue): SchemaField[] {
  if (!isPlainObject(schema)) return [];
  const data = getOwnValue(schema, 'input_data');
  const groups = getOwnValue(schema, 'input_groups');
  const entries: RuntimeValue[] = Array.isArray(data)
    ? data
    : Array.isArray(groups)
      ? groups.flatMap((group) => {
          const inner = isPlainObject(group) ? getOwnValue(group, 'input_data') : undefined;
          return Array.isArray(inner) ? inner : [];
        })
      : [];
  return entries.flatMap((entry) => {
    const field = toField(entry);
    return field ? [field] : [];
  });
}

const FIXED_SAMPLES: Record<string, string> = {
  email: 'test@example.com',
  url: 'https://example.com',
  tel: '+10000000000',
  date: '2025-01-01',
  'datetime-local': '2025-01-01T12:00',
  time: '12:00',
  month: '2025-01',
  week: '2025-W01',
  color: '#336699',
  file: 'https://example.com/file.pdf',
};

function sampleText(field: SchemaField): string {
  const base = 'sample text'.padEnd(field.min ?? 0, 'x');
  return field.max != null ? base.slice(0, Math.max(field.max, 0)) : base;
}

function sampleChoice(field: SchemaField, multiple: boolean): string | string[] {
  if (!multiple) return field.values[0] ?? '';
  return field.values.slice(0, Math.max(field.min ?? 1, 1));
}

function sampleValue(field: SchemaField): SampleValue | undefined {
  const preset = field.defaultValue;
  if (typeof preset === 'string' || typeof preset === 'number' || typeof preset === 'boolean')
    return preset;
  if (field.type === 'none') return undefined;
  if (field.type === 'hidden') return field.fixedValue ?? '';
  if (field.type in FIXED_SAMPLES) return FIXED_SAMPLES[field.type];
  switch (field.type) {
    case 'number':
    case 'range': {
      const base = field.min ?? 1;
      return field.max != null && base > field.max ? field.max : base;
    }
    case 'boolean':
    case 'checkbox':
      return true;
    case 'option':
      return sampleChoice(field, (field.max ?? 1) > 1);
    case 'radio':
      return sampleChoice(field, false);
    case 'multiselect':
      return sampleChoice(field, true);
    default:
      return sampleText(field);
  }
}

/** Sample `input_data` for a schema: one value per field, display-only fields left out. */
export function sampleInputFor(schema: RuntimeValue): Record<string, SampleValue> {
  const input: Record<string, SampleValue> = {};
  for (const field of schemaFields(schema)) {
    const value = sampleValue(field);
    if (value !== undefined) input[field.id] = value;
  }
  return input;
}
