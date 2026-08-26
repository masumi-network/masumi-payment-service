import { Request, Response, NextFunction } from 'express';

// Search engines must never index this service, so every response carries a
// noindex directive. robots.txt must keep crawling ALLOWED: a crawler only
// honors noindex on a page it is permitted to fetch. A `Disallow: /` would
// hide the directive from crawlers, and externally linked URLs could then
// still appear in search results as URL-only stubs.
export const robotsNoindex = (_req: Request, res: Response, next: NextFunction) => {
	res.setHeader('X-Robots-Tag', 'noindex, nofollow');
	next();
};

export const serveRobotsTxt = (_req: Request, res: Response) => {
	res.type('text/plain').send('User-agent: *\nAllow: /\n');
};
