import type { Config } from '@jest/types';

const moduleNameMapper = {
	'@/(.*)': '<rootDir>/src/$1',
	'^(\\.{1,2}/.*)\\.js$': '$1',
};

const config: Config.InitialOptions = {
	verbose: true,
	moduleNameMapper,
	roots: ['<rootDir>/src'],
	extensionsToTreatAsEsm: ['.ts'],
	transform: {
		'^.+\\.tsx?$': [
			'ts-jest',
			{
				useESM: true,
				tsconfig: 'tsconfig.json',
			},
		],
	},
};
export default config;
