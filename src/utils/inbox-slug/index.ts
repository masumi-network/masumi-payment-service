export const RESERVED_INBOX_SLUGS = ['favicon.ico', 'robots.txt', 'sitemap.xml'] as const;

function stripDiacritics(value: string): string {
	return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeInboxSlug(value: string): string {
	return stripDiacritics(value)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
}

const normalizedReservedInboxSlugs = new Set(RESERVED_INBOX_SLUGS.map((slug) => normalizeInboxSlug(slug)));

export function isReservedInboxSlug(slug: string): boolean {
	return normalizedReservedInboxSlugs.has(normalizeInboxSlug(slug));
}
