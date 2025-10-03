import express from 'express';
import { CONFIG } from '@/utils/config/';
import { logger } from '@/utils/logger/';
// import { logger.info, logError } from '@/utils/logs';
import { initJobs } from '@/services/schedules';
import { createConfig, createServer } from 'express-zod-api';
import { router } from '@/routes/index';
import ui, { JsonObject } from 'swagger-ui-express';
import { generateOpenAPI } from '@/utils/generator/swagger-generator';
import { cleanupDB, initDB, prisma } from '@/utils/db';
import path from 'path';
import { requestTiming } from '@/utils/middleware/request-timing';
import { DEFAULTS } from './../src/utils/config';
import { requestLogger } from '@/utils/middleware/request-logger';
import { blockchainStateMonitorService } from '@/services/monitoring/blockchain-state-monitor.service';
import fs from 'fs';

const __dirname = path.resolve();

async function initialize() {
  await initDB();
  const defaultKey = await prisma.apiKey.findUnique({
    where: {
      token: DEFAULTS.DEFAULT_ADMIN_KEY,
    },
  });
  if (defaultKey) {
    logger.warn(
      '*****************************************************************',
    );
    logger.warn(
      '*  WARNING: The default insecure ADMIN_KEY "' +
        DEFAULTS.DEFAULT_ADMIN_KEY +
        '" is in use.           *',
    );
    logger.warn(
      '*  This is a security risk. For production environments, please *',
    );
    logger.warn(
      '*  set a secure ADMIN_KEY in .env before seeding or change it in the admin tool now   *',
    );
    logger.warn(
      '*****************************************************************',
    );
  }
  await initJobs();

  // Start blockchain state monitoring
  await blockchainStateMonitorService.startMonitoring(30000); // Monitor every 30 seconds
  logger.info('Blockchain state monitoring service started', {
    component: 'monitoring',
    intervalSeconds: 30,
  });

  logger.info('All services initialized successfully', { component: 'main' });
}
logger.info('Initializing services');
initialize()
  .then(async () => {
    const PORT = CONFIG.PORT;
    logger.info('Starting web server', { component: 'server' }, { port: PORT });
    const serverConfig = createConfig({
      inputSources: {
        //read from body on get requests
        get: ['query', 'params'],
        post: ['body', 'params'],
        put: ['body', 'params'],
        patch: ['body', 'params'],
        delete: ['body', 'params'],
      },
      startupLogo: false,
      beforeRouting: ({ app }) => {
        // Add request logger middleware
        app.use(requestTiming);
        app.use(requestLogger);

        const replacer = (key: string, value: unknown): unknown => {
          if (typeof value === 'bigint') {
            return value.toString();
          }
          if (value instanceof Date) {
            return value.toISOString();
          }
          return value;
        };
        const docs = generateOpenAPI();
        const docsString = JSON.stringify(docs, replacer, 4);

        // Read custom CSS
        let customCss = '';
        try {
          customCss = fs.readFileSync(
            path.join(__dirname, 'public/assets/swagger-custom.css'),
            'utf8',
          );
        } catch {
          logger.warn('Custom CSS file not found, using default styling');
        }

        logger.info(
          '************** Now serving the API documentation at localhost:' +
            PORT +
            '/docs **************',
        );

        // Serve static assets
        app.use(
          '/assets',
          express.static(path.join(__dirname, 'public/assets')),
        );

        app.use(
          '/docs',
          ui.serve,
          ui.setup(JSON.parse(docsString) as JsonObject, {
            explorer: false,
            customSiteTitle: 'Payment Service API Documentation',
            customfavIcon: '/assets/swagger_favicon.svg',
            customCss: customCss,
            swaggerOptions: {
              persistAuthorization: true,
              tryItOutEnabled: true,
            },
          }),
        );
        app.get('/api-docs', (_, res) => {
          res.json(JSON.parse(docsString));
        });

        //serve the static admin files
        app.use('/admin', express.static('frontend/dist'));
        app.use('/_next', express.static('frontend/dist/_next'));
        // Catch all routes for admin and serve index.html via rerouting (excluding static files)
        app.get('/admin/*name', (req, res, next) => {
          // Skip static files (files with extensions)
          if (req.path.match(/\.[a-zA-Z0-9]+$/)) {
            return next();
          }
          res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
        });
      },
      http: {
        listen: PORT,
      },
      cors: ({ defaultHeaders }) => ({
        ...defaultHeaders,
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '5000',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH',
        'Access-Control-Expose-Headers': 'Content-Range, X-Total-Count',
      }),
      logger: logger,
    });

    void createServer(serverConfig, router);
    logger.info(
      'Web server started successfully',
      { component: 'server' },
      { port: PORT },
    );

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      try {
        logger.info(`Received ${signal}. Shutting down gracefully...`);
        blockchainStateMonitorService.stopMonitoring();
        await cleanupDB();
      } catch (e) {
        logger.error('Error during shutdown', e);
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  })
  .catch((e) => {
    logger.error(
      'Application startup failed',
      { component: 'main' },
      undefined,
      e as Error,
    );
    throw e;
  });
