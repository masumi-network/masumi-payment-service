/**
 * The control plane's one human-facing surface: a browser landing on the
 * Host's root (or a mistyped path) learns what it reached and where to go,
 * instead of a bare `{"error":"not found"}`.
 *
 * Deliberately static. The page is unauthenticated, so it must reveal nothing
 * a stranger could use: no slot usage, no node list, no versions — those live
 * behind the token-gated `capabilities` endpoint. API clients are unaffected:
 * anything that does not explicitly ask for HTML keeps getting JSON.
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

const PAGE_STYLE = `
	body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 4rem 1.5rem;
	       background: #0b0d10; color: #e6e8eb; display: flex; justify-content: center; }
	main { max-width: 40rem; }
	h1 { font-size: 1.4rem; margin: 0 0 0.75rem; }
	p { line-height: 1.55; color: #b7bcc2; margin: 0 0 0.75rem; }
	code { background: #16191d; border-radius: 4px; padding: 0.1rem 0.35rem; font-size: 0.9em; }
	a { color: #8ab4f8; }
	.badge { display: inline-block; border: 1px solid #2c3138; border-radius: 999px;
	         padding: 0.15rem 0.6rem; font-size: 0.8rem; color: #b7bcc2; margin-bottom: 1.25rem; }
`;

export function renderHostLandingPage(options: { network: string }): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Masumi Hydra Host</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
	<h1>Masumi Hydra Host</h1>
	<span class="badge">network: ${options.network}</span>
	<p>
		This is the control plane of a Hydra Host: a token-gated API that
		provisions and supervises <code>hydra-node</code> processes for the
		Masumi payment service, and proxies their APIs to the service that
		operates them.
	</p>
	<p>
		Every endpoint requires an <code>Authorization: Bearer</code> token
		issued by this Host's operator &mdash; there is nothing to browse here
		without one. Hosts are operated through a Masumi payment service, whose
		own API is documented by its Swagger UI at <code>/docs</code>.
	</p>
	<p>
		Documentation:
		<a href="https://github.com/masumi-network/masumi-payment-service/tree/main/docs">masumi-payment-service/docs</a>
	</p>
</main>
</body>
</html>
`;
}

export function renderNotFoundPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Not found &middot; Masumi Hydra Host</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
	<h1>404 &mdash; not found</h1>
	<p>No such page on this Hydra Host's control plane.</p>
	<p><a href="/">What is this server?</a></p>
</main>
</body>
</html>
`;
}
