import express from 'express';
import { CONFIG } from '@/utils/config/';
import { logger } from '@/utils/logger/';
import { logInfo, logError } from '@/utils/logs';
import { initJobs } from '@/services/schedules';
import { createConfig, createServer } from 'express-zod-api';
import { router } from '@/routes/index';
import ui, { JsonObject } from 'swagger-ui-express';
import { generateOpenAPI } from '@/utils/generator/swagger-generator';
import { cleanupDB, initDB } from '@/utils/db';
import path from 'path';
import { requestLogger } from '@/utils/middleware/request-logger';
import fs from 'fs';

const __dirname = path.resolve();

async function initialize() {
  logInfo('Starting application initialization', { component: 'main' });

  try {
    await initDB();
    logInfo('Database initialized successfully', { component: 'database' });

    await initJobs();
    logInfo('Background jobs initialized successfully', {
      component: 'scheduler',
    });

    logger.info('Initialized all services');
    logInfo('All services initialized successfully', { component: 'main' });
  } catch (error) {
    logError(
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
    logInfo('Starting web server', { component: 'server' }, { port: PORT });
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
    logInfo(
      'Web server started successfully',
      { component: 'server' },
      { port: PORT },
    );
  })
  .catch((e) => {
    logError(
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
