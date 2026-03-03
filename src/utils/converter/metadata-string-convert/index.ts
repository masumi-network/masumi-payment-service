//internal helper to transform metadata strings as they can be either a string of length<63 or an array of strings <63
//e.g ["this is a very long ","string ","on the registry"] -> "this is a very long string on the registry"
export function metadataToString(value: string | string[] | undefined) {
	if (value == undefined) return undefined;
	if (typeof value === 'string') return value;
	return value.join('');
}
export function stringToMetadata(s: string | undefined | null, forceArray: boolean = true) {
	if (s == undefined || s == null) {
		return '';
	}
	if (s.length <= 60 && forceArray == false) {
		return s;
	}
	//split every 60 characters
	const arr = [];
	for (let i = 0; i < s.length; i += 60) {
		arr.push(s.slice(i, i + 60));
	}
	return arr;
}
