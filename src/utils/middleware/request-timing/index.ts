import { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    startTime?: number;
  }
}

export const requestTiming = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  req.startTime = Date.now();
  next();
};
