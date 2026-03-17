import { Request, Response, NextFunction } from 'express';

export const requestTiming = (req: Request, res: Response, next: NextFunction) => {
	void req;
	res.locals.requestStartTime = Date.now();
	next();
};
