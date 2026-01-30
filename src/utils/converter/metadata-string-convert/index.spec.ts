import { metadataToString, stringToMetadata } from './index';

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
