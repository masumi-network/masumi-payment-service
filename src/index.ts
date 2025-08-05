import express from 'express';
import { CONFIG } from '@/utils/config/';
import { logger } from '@/utils/logger/';
// import { logger.info, logError } from '@/utils/logs';
import { initJobs } from '@/services/schedules';
import { createConfig, createServer } from 'express-zod-api';
import { router } from '@/routes/index';
import ui, { JsonObject } from 'swagger-ui-express';
import { generateOpenAPI } from '@/utils/generator/swagger-generator';
import { cleanupDB, initDB } from '@/utils/db';
import path from 'path';
import { requestTiming } from '@/utils/middleware/request-timing';
import { requestLogger } from '@/utils/middleware/request-logger';
import { blockchainStateMonitorService } from '@/services/monitoring/blockchain-state-monitor.service';
import fs from 'fs';

const __dirname = path.resolve();

async function initialize() {
  logger.info('Starting application initialization', { component: 'main' });

  try {
    await initDB();
    logger.info('Database initialized successfully', { component: 'database' });

    await initJobs();
    logger.info('Background jobs initialized successfully', {
      component: 'scheduler',
    });

    // Start blockchain state monitoring
    await blockchainStateMonitorService.startMonitoring(30000); // Monitor every 30 seconds
    logger.info('Blockchain state monitoring service started', {
      component: 'monitoring',
      intervalSeconds: 30,
    });

    logger.info('Initialized all services');
    logger.info('All services initialized successfully', { component: 'main' });
  } catch (error) {
    logger.error(
      'Failed to initialize services',
      { component: 'main' },
      undefined,
      error as Error,
    );
    throw error;
  }
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
            customfavIcon: '/assets/favicon.png',
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
        // Catch all routes for admin and serve index.html via rerouting
        app.get('/admin/*name', (req, res) => {
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
  })
  .catch((e) => {
    logger.error(
      'Application startup failed',
      { component: 'main' },
      undefined,
      e as Error,
    );
    throw e;
  })
  .finally(() => {
    void cleanupDB();
  });

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  blockchainStateMonitorService.stopMonitoring();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  blockchainStateMonitorService.stopMonitoring();
  process.exit(0);
});
