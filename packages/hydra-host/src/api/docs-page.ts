/**
 * The Swagger UI layer over `/openapi.json`: the same documentation
 * experience as the payment service's `/docs`, self-hosted so it works with
 * no external requests. The UI bundle comes from `swagger-ui-dist`; the
 * theme is the payment service's Swagger theme, copied into this package's
 * `public/` (with the app-CSP font-face dropped) so the Host stays
 * self-contained in its container.
 *
 * Assets are served from an allow-list by exact name — there is no directory
 * walking, so a crafted path cannot escape into the package.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromHere = createRequire(import.meta.url);

function swaggerDistDir(): string {
	return path.dirname(requireFromHere.resolve('swagger-ui-dist/package.json'));
}

function hostPublicDir(): string {
	// src/api/ (tsx) and dist/api/ (built) both sit two levels below the
	// package root, so the same relative walk finds public/ in either layout.
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
}

const ASSETS: Readonly<Record<string, { source: 'dist' | 'host'; contentType: string }>> = {
	'swagger-ui.css': { source: 'dist', contentType: 'text/css; charset=utf-8' },
	'swagger-ui.css.map': { source: 'dist', contentType: 'application/json' },
	'swagger-ui-bundle.js': { source: 'dist', contentType: 'text/javascript; charset=utf-8' },
	'swagger-ui-bundle.js.map': { source: 'dist', contentType: 'application/json' },
	'swagger-custom.css': { source: 'host', contentType: 'text/css; charset=utf-8' },
	'favicon.svg': { source: 'host', contentType: 'image/svg+xml' },
};

/** Absolute file path and content type for an allow-listed asset, else null. */
export function resolveDocsAsset(name: string): { filePath: string; contentType: string } | null {
	// Own-property check: a bare index would also match inherited
	// Object.prototype names ('constructor', '__proto__', …) and hand a
	// function to the readFile path below.
	if (!Object.hasOwn(ASSETS, name)) return null;
	const asset = ASSETS[name];
	const baseDir = asset.source === 'dist' ? swaggerDistDir() : hostPublicDir();
	return { filePath: path.join(baseDir, name), contentType: asset.contentType };
}

/**
 * The `/docs` shell. Mirrors the payment service's swagger-ui-express setup:
 * same swaggerOptions, same topbar suppression, same cmd/ctrl-K filter focus.
 * `explorer: false` there means no standalone preset here — BaseLayout only.
 */
export function renderSwaggerDocsPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Masumi Hydra Host API Documentation</title>
<link rel="icon" type="image/svg+xml" href="/docs/assets/favicon.svg" />
<link rel="stylesheet" href="/docs/assets/swagger-ui.css" />
<link rel="stylesheet" href="/docs/assets/swagger-custom.css" />
</head>
<body>
<div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script>
	window.onload = function () {
		window.ui = SwaggerUIBundle({
			url: '/openapi.json',
			dom_id: '#swagger-ui',
			presets: [SwaggerUIBundle.presets.apis],
			layout: 'BaseLayout',
			persistAuthorization: false,
			tryItOutEnabled: true,
			displayRequestDuration: true,
			deepLinking: true,
			filter: true,
			validatorUrl: 'none',
			docExpansion: 'list',
			defaultModelsExpandDepth: 0,
			syntaxHighlight: { activate: true, theme: 'agate' },
		});
	};
	document.addEventListener('keydown', function (e) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			var filterInput = document.querySelector('.operation-filter-input');
			if (filterInput) {
				filterInput.focus();
				filterInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		}
	});
</script>
</body>
</html>
`;
}
