export function extractApiErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;

  if (typeof error === 'string') return error;

  if (error instanceof Error) {
    const anyError = error as Error & {
      response?: { data?: { error?: { message?: string } | string; message?: string } };
      error?: { message?: string } | string;
    };

    const nestedMessage =
      (typeof anyError.response?.data?.error === 'object' &&
      anyError.response?.data?.error &&
      'message' in anyError.response.data.error &&
      typeof anyError.response.data.error.message === 'string'
        ? anyError.response.data.error.message
        : undefined) ||
      (typeof anyError.response?.data?.error === 'string'
        ? anyError.response.data.error
        : undefined) ||
      anyError.response?.data?.message ||
      (typeof anyError.error === 'object' &&
      anyError.error &&
      'message' in anyError.error &&
      typeof anyError.error.message === 'string'
        ? anyError.error.message
        : undefined);

    return nestedMessage || anyError.message || fallback;
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;

    const nestedError =
      typeof record.error === 'object' && record.error !== null
        ? (record.error as Record<string, unknown>)
        : null;
    const nestedResponse =
      typeof record.response === 'object' && record.response !== null
        ? (record.response as Record<string, unknown>)
        : null;
    const nestedData =
      nestedResponse && typeof nestedResponse.data === 'object' && nestedResponse.data !== null
        ? (nestedResponse.data as Record<string, unknown>)
        : null;
    const nestedDataError =
      nestedData && typeof nestedData.error === 'object' && nestedData.error !== null
        ? (nestedData.error as Record<string, unknown>)
        : null;

    const message =
      (typeof record.message === 'string' ? record.message : undefined) ||
      (nestedError && typeof nestedError.message === 'string' ? nestedError.message : undefined) ||
      (nestedData && typeof nestedData.message === 'string' ? nestedData.message : undefined) ||
      (nestedDataError && typeof nestedDataError.message === 'string'
        ? nestedDataError.message
        : undefined) ||
      (nestedData && typeof nestedData.error === 'string' ? nestedData.error : undefined);

    return message || fallback;
  }

  return fallback;
}

export function mapInvoiceApiErrorMessage(rawMessage: string): string {
  if (rawMessage.includes('Missing currency conversion mapping')) {
    return 'Missing currency conversion. Add currencyConversion values or configure COINGECKO_API_KEY on the server.';
  }
  if (rawMessage.includes('Missing conversion for units:')) {
    if (rawMessage.includes('COINGECKO_API_KEY')) {
      return rawMessage;
    }
    return `${rawMessage} Provide conversion mapping for every unit or configure COINGECKO_API_KEY.`;
  }
  return rawMessage;
}
