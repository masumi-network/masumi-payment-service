import type { InputData, SampleValue } from './sample-input';

/** Editable JSON text for `input_data`: flat, one value per field id, the shape MIP-003 forms produce. */

export type InputJsonResult = { ok: true; data: InputData } | { ok: false; message: string };

function isFlatValue(value: unknown): value is SampleValue | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

export function parseInputJson(text: string): InputJsonResult {
  if (text.trim().length === 0) return { ok: true, data: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The input is not valid JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      message: 'The input must be a JSON object, for example {"topic": "cats"}.',
    };
  }
  const entries = Object.entries(value);
  const bad = entries.find(([, entry]) => !isFlatValue(entry));
  if (bad) {
    return {
      ok: false,
      message: `The value of "${bad[0]}" must be text, a number, true/false, null or a list of text. Nested objects are not supported.`,
    };
  }
  return { ok: true, data: Object.fromEntries(entries) as InputData };
}

export function formatInputJson(data: InputData): string {
  return JSON.stringify(data, null, 2);
}
