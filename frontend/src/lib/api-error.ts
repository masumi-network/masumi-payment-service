import { getOwnPlainObject, getOwnString, getOwnValue, isObject } from '@/lib/object-properties';

type ApiErrorMessageCandidates = {
  topLevelMessage: string | undefined;
  topLevelErrorValue: string | undefined;
  nestedErrorMessage: string | undefined;
  nestedDataMessage: string | undefined;
  nestedDataErrorMessage: string | undefined;
  nestedDataErrorValue: string | undefined;
};

function getApiErrorMessageCandidates(value: object): ApiErrorMessageCandidates {
  const nestedError = getOwnPlainObject(value, 'error');
  const nestedResponse = getOwnPlainObject(value, 'response');
  const nestedData = nestedResponse ? getOwnPlainObject(nestedResponse, 'data') : undefined;
  const nestedDataError = nestedData ? getOwnPlainObject(nestedData, 'error') : undefined;
  const topLevelErrorValue = getOwnValue(value, 'error');
  const nestedDataErrorValue = nestedData ? getOwnValue(nestedData, 'error') : undefined;

  return {
    topLevelMessage: getOwnString(value, 'message'),
    topLevelErrorValue: typeof topLevelErrorValue === 'string' ? topLevelErrorValue : undefined,
    nestedErrorMessage: nestedError ? getOwnString(nestedError, 'message') : undefined,
    nestedDataMessage: nestedData ? getOwnString(nestedData, 'message') : undefined,
    nestedDataErrorMessage: nestedDataError ? getOwnString(nestedDataError, 'message') : undefined,
    nestedDataErrorValue:
      typeof nestedDataErrorValue === 'string' ? nestedDataErrorValue : undefined,
  };
}

function getErrorInstanceApiMessage(value: object): string | undefined {
  const candidates = getApiErrorMessageCandidates(value);

  return (
    candidates.topLevelErrorValue ||
    candidates.nestedDataErrorMessage ||
    candidates.nestedDataErrorValue ||
    candidates.nestedDataMessage ||
    candidates.nestedErrorMessage
  );
}

function getPlainObjectApiMessage(value: object): string | undefined {
  const candidates = getApiErrorMessageCandidates(value);

  return (
    candidates.topLevelMessage ||
    candidates.topLevelErrorValue ||
    candidates.nestedErrorMessage ||
    candidates.nestedDataMessage ||
    candidates.nestedDataErrorMessage ||
    candidates.nestedDataErrorValue
  );
}

export function extractApiErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;

  if (typeof error === 'string') return error;

  if (isObject(error)) {
    const message =
      error instanceof Error ? getErrorInstanceApiMessage(error) : getPlainObjectApiMessage(error);
    const inheritedErrorMessage = error instanceof Error ? error.message : undefined;
    return message || inheritedErrorMessage || fallback;
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
