import { Request, Response, NextFunction } from 'express';

export const allowSameOriginFraming = (_req: Request, res: Response, next: NextFunction) => {
	const contentSecurityPolicy = res.getHeader('Content-Security-Policy');
	if (typeof contentSecurityPolicy === 'string') {
		res.setHeader(
			'Content-Security-Policy',
			contentSecurityPolicy.replace(/frame-ancestors[^;]*/, "frame-ancestors 'self'"),
		);
	}
	res.setHeader('X-Frame-Options', 'SAMEORIGIN');
	next();
};
