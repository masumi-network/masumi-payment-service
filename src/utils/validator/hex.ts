export function validateHexString(hexString: string) {
	if (hexString.length % 2 !== 0) {
		return false;
	}
	return /^[0-9a-fA-F]+$/.test(hexString);
}
