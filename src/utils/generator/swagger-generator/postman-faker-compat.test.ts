import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const requireFromRoot = createRequire(join(root, 'package.json'));
const requireFromCollection = createRequire(requireFromRoot.resolve('postman-collection/package.json'));

type DynamicVariable = { generator: () => unknown };
const POSTMAN_DYNAMIC_VARIABLE_COUNT = 118;

it('uses patched Faker and keeps every Postman dynamic variable callable', () => {
	const fakerPackage = requireFromCollection('@faker-js/faker/package.json') as { version: string };
	expect(fakerPackage.version).toBe('10.5.0');

	const variables = requireFromCollection('./lib/superstring/dynamic-variables.js') as Record<string, DynamicVariable>;
	expect(Object.keys(variables)).toHaveLength(POSTMAN_DYNAMIC_VARIABLE_COUNT);
	for (const [name, variable] of Object.entries(variables)) {
		expect(typeof variable.generator).toBe('function');
		expect(variable.generator()).toBeDefined();
	}
});

it('converts the service OpenAPI document to a Postman collection', () => {
	const outputDirectory = mkdtempSync(join(tmpdir(), 'masumi-postman-'));
	const outputPath = join(outputDirectory, 'collection.json');
	try {
		execFileSync(
			process.execPath,
			[
				requireFromRoot.resolve('openapi-to-postmanv2/bin/openapi2postmanv2.js'),
				'-s',
				join(root, 'src/utils/generator/swagger-generator/openapi-docs.json'),
				'-o',
				outputPath,
				'-p',
				'-O',
				'parametersResolution=Example',
			],
			{ stdio: 'pipe' },
		);
		const collection = JSON.parse(readFileSync(outputPath, 'utf8')) as { info?: { name?: string }; item?: unknown[] };
		expect(collection.info?.name).toBe('Masumi Payment Service API');
		expect(collection.item?.length).toBeGreaterThan(0);
	} finally {
		rmSync(outputDirectory, { recursive: true, force: true });
	}
});
