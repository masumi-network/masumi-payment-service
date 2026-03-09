type GeneratedApiResponse<T> =
  | {
      data?: {
        data?: T;
      };
    }
  | {
      data?: T;
    };

export function extractApiPayload<T>(
  response: GeneratedApiResponse<T> | null | undefined,
): T | undefined {
  const responseData = response?.data;

  if (!responseData) {
    return undefined;
  }

  if (
    typeof responseData === 'object' &&
    responseData !== null &&
    'data' in responseData &&
    Object.keys(responseData).length === 1
  ) {
    return (responseData as { data?: T }).data;
  }

  return responseData as T;
}
