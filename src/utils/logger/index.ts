import { Logger } from 'winston';
import { buildDevLogger } from '@/utils/logger/dev.logger';
import { buildProdLogger } from '@/utils/logger/prod.logger';

let logger: Logger;
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev') {
	logger = buildDevLogger();
} else {
	logger = buildProdLogger();
}

export { logger };
