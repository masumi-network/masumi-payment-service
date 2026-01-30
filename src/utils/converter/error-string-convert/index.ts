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
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			return (error as any).toString() as string;
		} catch {
			return 'Unknown error';
		}
	}
	return 'Unknown error';
}
