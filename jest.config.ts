import type { Config } from '@jest/types';
// Sync object
const moduleNameMapper = {
	'@/(.*)': '<rootDir>/src/$1',
	'^(\\.{1,2}/.*)\\.js$': '$1',
};

const config: Config.InitialOptions = {
	preset: 'ts-jest/presets/default-esm',
	verbose: true,
	moduleNameMapper,
	roots: ['<rootDir>/src'],
	extensionsToTreatAsEsm: ['.ts'],
	globals: {
		'ts-jest': {
			useESM: true,
			tsconfig: 'tsconfig.json',
		},
	},
};
export default config;
