import { metadataToString, stringToMetadata, cleanMetadata } from './index';

describe('metadataToString', () => {
	it('should return undefined when input is undefined', () => {
		expect(metadataToString(undefined)).toBeUndefined();
	});

	it('should return the same string when input is a string', () => {
		const input = 'test string';
		expect(metadataToString(input)).toBe(input);
	});

	it('should join array of strings', () => {
		const input = ['this is ', 'a test ', 'string'];
		expect(metadataToString(input)).toBe('this is a test string');
	});

	it('should handle empty array', () => {
		expect(metadataToString([])).toBe('');
	});

	it('should handle array with empty strings', () => {
		expect(metadataToString(['', '', ''])).toBe('');
	});

	it('should handle array with single string', () => {
		expect(metadataToString(['single'])).toBe('single');
	});
});

describe('stringToMetadata', () => {
	it('should return undefined when input is undefined', () => {
		expect(stringToMetadata(undefined)).toBeUndefined();
	});

	it('should return undefined when input is null', () => {
		expect(stringToMetadata(null)).toBeUndefined();
	});

	it('should return the same string when input is a string', () => {
		const input = 'test string';
		expect(stringToMetadata(input, false)).toBe(input);
	});

	it('should return the same string as array when input is a string', () => {
		const input = 'test string';
		expect(stringToMetadata(input, true)).toEqual([input]);
	});

	it('should return the same string as array when input is a string', () => {
		const input = 'test string 1234567890 abcdefghijklmnopqrstuvwxyz 1234567890 1234567890';
		expect(stringToMetadata(input, false)).toEqual([
			'test string 1234567890 abcdefghijklmnopqrstuvwxyz 1234567890',
			' 1234567890',
		]);
	});

	it('should return the same string as array when input is a string', () => {
		const input = 'https://masumi-quickstart-exam-mainnet-2yvmp.ondigitalocean.app';
		expect(stringToMetadata(input)).toEqual(['https://masumi-quickstart-exam-mainnet-2yvmp.ondigitalocean.', 'app']);
	});
});

describe('cleanMetadata', () => {
	it('should return undefined when input is undefined', () => {
		expect(cleanMetadata(undefined)).toBeUndefined();
	});

	it('should return null when input is null', () => {
		expect(cleanMetadata(null)).toBeNull();
	});

	it('should return primitive values unchanged', () => {
		expect(cleanMetadata('string')).toBe('string');
		expect(cleanMetadata(123)).toBe(123);
		expect(cleanMetadata(true)).toBe(true);
		expect(cleanMetadata(false)).toBe(false);
	});

	it('should remove undefined property from objects', () => {
		const input = { a: 1, b: undefined, c: 'test' };
		const result = cleanMetadata(input);
		expect(result).toEqual({ a: 1, c: 'test' });
		expect(Object.keys(result as object)).not.toContain('b');
	});

	it('should remove undefined properties from nested objects', () => {
		const input = {
			level1: {
				a: undefined,
				b: 1,
				level2: {
					c: undefined,
					d: 2,
				},
			},
		};
		const result = cleanMetadata(input);
		expect(result).toEqual({
			level1: {
				b: 1,
				level2: {
					d: 2,
				},
			},
		});
	});

	it('should filter out undefined elements from arrays', () => {
		const input = [1, undefined, 2, undefined, 3];
		const result = cleanMetadata(input);
		expect(result).toEqual([1, 2, 3]);
	});

	it('should filter out undefined properties from objects within arrays', () => {
		const input = [{ a: 1, b: undefined }, undefined, { c: 2, d: undefined }];
		const result = cleanMetadata(input);
		expect(result).toEqual([{ a: 1 }, { c: 2 }]);
	});

	it('should handle complex nested structures with arrays and objects', () => {
		const input = {
			name: 'Test Agent',
			description: undefined,
			tags: ['ai', undefined, 'agent'],
			config: {
				retries: 3,
				timeout: undefined,
				metadata: [{ key: 'version', value: '1.0' }, undefined, { key: 'debug', value: undefined }],
			},
		};
		const result = cleanMetadata(input);
		expect(result).toEqual({
			name: 'Test Agent',
			tags: ['ai', 'agent'],
			config: {
				retries: 3,
				metadata: [{ key: 'version', value: '1.0' }, { key: 'debug' }],
			},
		});
	});
});
