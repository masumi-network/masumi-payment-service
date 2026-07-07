export function errorToString(error: unknown) {
	if (error instanceof Error) {
		return error.message;
	}
	if (error !== null && error !== undefined) {
		if (typeof error === 'object') {
			try {
				return JSON.stringify(error);
			} catch {
				return 'Unknown error';
			}
		}
		if (typeof error === 'string') {
			return error;
		}
		try {
			return (error as { toString(): string }).toString();
		} catch {
			return 'Unknown error';
		}
	}
	return 'Unknown error';
}
