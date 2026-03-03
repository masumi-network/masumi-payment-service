import { Routing } from 'express-zod-api';
import { apiRouter } from '@/routes/api';

export const router: Routing = {
	api: apiRouter,
};
