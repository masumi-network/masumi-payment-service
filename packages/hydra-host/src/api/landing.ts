/**
 * The control plane's one human-facing surface: a browser landing on the
 * Host's root (or a mistyped path) learns what it reached and where to go,
 * instead of a bare `{"error":"not found"}`.
 *
 * Deliberately static. The page is unauthenticated, so it must reveal nothing
 * a stranger could use: no slot usage, no nodes, no versions — those live
 * behind the token-gated `capabilities` endpoint. API clients are unaffected:
 * anything that does not explicitly ask for HTML keeps getting JSON.
 *
 * Styling follows the Masumi brand used by the payment service's docs theme:
 * the orange-to-pink gradient as the single accent, the round Masumi mark,
 * dark surfaces matching the Swagger page next door.
 */

/**
 * Whether the request is a genuine browser navigation.
 *
 * Matches an EXPLICIT html media type rather than a general accepts() check:
 * curl, health probes and API clients send `Accept: * / *`, which must keep
 * receiving JSON they can parse. Browsers always name `text/html` outright.
 */
export function wantsHtmlDocument(acceptHeader: string | undefined): boolean {
	return /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(acceptHeader ?? '');
}

/** The Masumi mark, inlined so the page needs no asset round trip. */
const MASUMI_MARK = `<svg width="44" height="44" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Masumi">
<circle cx="24" cy="24" r="24" fill="#FF003D"/>
<path d="M34.685 37C36.6411 37 38.2283 35.4016 38.2283 33.4281V26.2859L40 24.5L38.2283 22.7141V15.5719C38.2283 13.5984 36.6427 12 34.685 12M14.315 12C12.3573 12 10.7717 13.5984 10.7717 15.5719V22.7141L9 24.5L10.7717 26.2859V33.4281C10.7717 35.4016 12.3573 37 14.315 37M18.3001 24.5C18.3001 24.9314 17.9531 25.2812 17.5251 25.2812C17.0971 25.2812 16.7501 24.9314 16.7501 24.5C16.7501 24.0686 17.0971 23.7188 17.5251 23.7188C17.9531 23.7188 18.3001 24.0686 18.3001 24.5ZM25.2752 24.5C25.2752 24.9314 24.9281 25.2812 24.5002 25.2812C24.0722 25.2812 23.7251 24.9314 23.7251 24.5C23.7251 24.0686 24.0722 23.7188 24.5002 23.7188C24.9281 23.7188 25.2752 24.0686 25.2752 24.5ZM32.2502 24.5C32.2502 24.9314 31.9032 25.2812 31.4752 25.2812C31.0473 25.2812 30.7002 24.9314 30.7002 24.5C30.7002 24.0686 31.0473 23.7188 31.4752 23.7188C31.9032 23.7188 32.2502 24.0686 32.2502 24.5Z" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const PAGE_STYLE = `
	:root {
		--bg: #0b0d10; --surface: #12151a; --border: #232830;
		--text: #e8eaed; --muted: #9aa1ab;
		--brand-gradient: linear-gradient(135deg, #ff6400 0%, #fa008c 100%);
	}
	* { box-sizing: border-box; }
	body { font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0;
	       min-height: 100vh; padding: 4rem 1.5rem; background: var(--bg); color: var(--text);
	       display: flex; justify-content: center; align-items: flex-start; }
	main { max-width: 42rem; width: 100%; background: var(--surface); border: 1px solid var(--border);
	       border-radius: 14px; overflow: hidden; }
	.accent { height: 4px; background: var(--brand-gradient); }
	.inner { padding: 2.25rem 2.5rem 2.5rem; }
	header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
	header svg { flex: none; }
	h1 { font-size: 1.35rem; margin: 0; letter-spacing: -0.01em; }
	.badge { display: inline-block; margin-top: 0.3rem; border: 1px solid var(--border); border-radius: 999px;
	         padding: 0.1rem 0.6rem; font-size: 0.75rem; color: var(--muted); }
	p { line-height: 1.6; color: var(--muted); margin: 1rem 0 0; font-size: 0.95rem; }
	code { background: #1a1e24; border: 1px solid var(--border); border-radius: 5px;
	       padding: 0.1rem 0.35rem; font-size: 0.85em; color: var(--text); }
	nav { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 1.75rem; }
	nav a { display: inline-block; text-decoration: none; color: var(--text); font-size: 0.875rem;
	        border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.9rem;
	        transition: border-color 0.15s ease, transform 0.15s ease; }
	nav a:hover { border-color: #fa008c66; transform: translateY(-1px); }
	nav a.primary { background: var(--brand-gradient); border: none; color: #fff; font-weight: 600; }
	footer { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid var(--border);
	         font-size: 0.8rem; color: var(--muted); }
	footer a { color: var(--muted); }
`;

function pageShell(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="/docs/assets/favicon.svg" />
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
	<div class="accent"></div>
	<div class="inner">
${body}
	</div>
</main>
</body>
</html>
`;
}

export function renderHostLandingPage(options: { network: string }): string {
	return pageShell(
		'Masumi Hydra Host',
		`	<header>
		${MASUMI_MARK}
		<div>
			<h1>Masumi Hydra Host</h1>
			<span class="badge">network: ${options.network}</span>
		</div>
	</header>
	<p>
		This is the control plane of a Hydra Host: a token-gated API that
		provisions and supervises <code>hydra-node</code> processes for the
		Masumi payment service, and proxies their APIs to the service that
		operates them.
	</p>
	<p>
		Every endpoint requires an <code>Authorization: Bearer</code> token
		issued by this Host's operator &mdash; there is nothing to browse here
		without one. Hosts are operated through a Masumi payment service.
	</p>
	<nav>
		<a class="primary" href="/docs">API documentation</a>
		<a href="/openapi.json">OpenAPI specification</a>
		<a href="https://github.com/masumi-network/masumi-payment-service/tree/main/docs">Masumi payment service docs</a>
		<a href="https://hydra.family/head-protocol/">Hydra protocol</a>
	</nav>
	<footer>
		Part of the <a href="https://masumi.network">Masumi</a> network stack &middot;
		<a href="https://github.com/masumi-network/masumi-payment-service">GitHub repository</a>
	</footer>`,
	);
}

export function renderNotFoundPage(): string {
	return pageShell(
		'Not found · Masumi Hydra Host',
		`	<header>
		${MASUMI_MARK}
		<div>
			<h1>404 &mdash; not found</h1>
		</div>
	</header>
	<p>No such page on this Hydra Host's control plane.</p>
	<nav>
		<a class="primary" href="/">What is this server?</a>
		<a href="/docs">API documentation</a>
	</nav>`,
	);
}
