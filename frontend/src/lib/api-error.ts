import { getOwnPlainObject, getOwnString, getOwnValue, isObject } from '@/lib/object-properties';

function getErrorInstanceApiMessage(value: object): string | undefined {
  const nestedError = getOwnPlainObject(value, 'error');
  const nestedResponse = getOwnPlainObject(value, 'response');
  const nestedData = nestedResponse ? getOwnPlainObject(nestedResponse, 'data') : undefined;
  const nestedDataError = nestedData ? getOwnPlainObject(nestedData, 'error') : undefined;
  const nestedDataErrorValue = nestedData ? getOwnValue(nestedData, 'error') : undefined;

  return (
    (nestedDataError ? getOwnString(nestedDataError, 'message') : undefined) ||
    (typeof nestedDataErrorValue === 'string' ? nestedDataErrorValue : undefined) ||
    (nestedData ? getOwnString(nestedData, 'message') : undefined) ||
    (nestedError ? getOwnString(nestedError, 'message') : undefined)
  );
}

function getPlainObjectApiMessage(value: object): string | undefined {
  const nestedError = getOwnPlainObject(value, 'error');
  const nestedResponse = getOwnPlainObject(value, 'response');
  const nestedData = nestedResponse ? getOwnPlainObject(nestedResponse, 'data') : undefined;
  const nestedDataError = nestedData ? getOwnPlainObject(nestedData, 'error') : undefined;
  const nestedDataErrorValue = nestedData ? getOwnValue(nestedData, 'error') : undefined;

  return (
    getOwnString(value, 'message') ||
    (nestedError ? getOwnString(nestedError, 'message') : undefined) ||
    (nestedData ? getOwnString(nestedData, 'message') : undefined) ||
    (nestedDataError ? getOwnString(nestedDataError, 'message') : undefined) ||
    (typeof nestedDataErrorValue === 'string' ? nestedDataErrorValue : undefined)
  );
}

export function extractApiErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;

  if (typeof error === 'string') return error;

  if (isObject(error)) {
    const message =
      error instanceof Error ? getErrorInstanceApiMessage(error) : getPlainObjectApiMessage(error);
    return message || (error instanceof Error ? error.message : fallback);
  }

  return fallback;
}

export function mapInvoiceApiErrorMessage(rawMessage: string): string {
  if (rawMessage.includes('Missing currency conversion mapping')) {
    return 'Missing currency conversion. Add CurrencyConversion values or configure COINGECKO_API_KEY on the server.';
  }
  if (rawMessage.includes('Missing conversion for units:')) {
    if (rawMessage.includes('COINGECKO_API_KEY')) {
      return rawMessage;
    }
    return `${rawMessage} Provide conversion mapping for every unit or configure COINGECKO_API_KEY.`;
  }
  return rawMessage;
}
