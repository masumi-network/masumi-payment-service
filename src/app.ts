import express from 'express';
import { CONFIG } from '@/utils/config/';
import { logger } from '@/utils/logger/';
import { initJobs, stopJobs } from '@/services/monitoring';
import { createConfig, createServer } from 'express-zod-api';
import { router } from '@/routes/index';
import ui, { JsonObject } from 'swagger-ui-express';
import { generateOpenAPI } from '@/utils/generator/swagger-generator';
import { cleanupDB, initDB, prisma } from '@/utils/db';
import path from 'path';
import { requestTiming } from '@/utils/middleware/request-timing';
import { DEFAULTS } from '@/utils/config';
import { requestLogger } from '@/utils/middleware/request-logger';
import { generateApiKeySecureHash } from '@/utils/crypto/api-key-hash';
import { migrateApiKeyEncryption } from '@/utils/startup-migrations/api-key-encryption';
import { migrateWebhookEncryption } from '@/utils/startup-migrations/webhook-encryption';
import { blockchainStateMonitorService } from '@/services/monitoring';
import fs from 'fs';
import { getHydraConnectionManager } from './services/hydra-connection-manager/hydra-connection-manager.service';

const __dirname = path.resolve();

async function initialize() {
	await initDB();

	await migrateApiKeyEncryption();
	await migrateWebhookEncryption();

	const defaultAdminHash = await generateApiKeySecureHash(DEFAULTS.DEFAULT_ADMIN_KEY);
	const defaultKeyRow = await prisma.apiKey.findFirst({
		where: { tokenHash: defaultAdminHash },
		select: { id: true },
	});
	if (defaultKeyRow !== null) {
		logger.warn('*****************************************************************');
		logger.warn(
			'*  WARNING: The default insecure ADMIN_KEY "' + DEFAULTS.DEFAULT_ADMIN_KEY + '" is in use.           *',
		);
		logger.warn('*  This is a security risk. For production environments, please *');
		logger.warn('*  set a secure ADMIN_KEY in .env before seeding or change it in the admin tool now   *');
		logger.warn('*****************************************************************');
	}
	await initJobs();

	// Reconnect to any enabled Hydra heads that are reachable
	await getHydraConnectionManager().initialize();
	logger.info('Hydra connection manager initialized', { component: 'hydra' });

	// Start blockchain state monitoring
	await blockchainStateMonitorService.startMonitoring(30000); // Monitor every 30 seconds
	logger.info('Blockchain state monitoring service started', {
		component: 'monitoring',
		intervalSeconds: 30,
	});

	logger.info('All services initialized successfully', { component: 'main' });
}

function registerShutdownHandlers() {
	const shutdown = async (signal: string) => {
		try {
			logger.info(`Received ${signal}. Shutting down gracefully...`);
			await stopJobs();
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
}

export async function startApp() {
	logger.info('Initializing services');
	await initialize();

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

			const replacer = (_key: string, value: unknown): unknown => {
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
				customCss = fs.readFileSync(path.join(__dirname, 'public/assets/swagger-custom.css'), 'utf8');
			} catch {
				logger.warn('Custom CSS file not found, using default styling');
			}

			logger.info('************** Now serving the API documentation at localhost:' + PORT + '/docs **************');

			// Serve static assets
			app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

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
						displayRequestDuration: true,
						deepLinking: true,
						filter: true,
						validatorUrl: 'none',
						docExpansion: 'list',
						defaultModelsExpandDepth: 0,
						syntaxHighlight: {
							activate: true,
							theme: 'agate',
						},
					},
					customJsStr: `
								// hide the default Swagger branding text inside the topbar link
								document.addEventListener('DOMContentLoaded', function() {
									var topbarLink = document.querySelector('.topbar-wrapper .link');
								if (topbarLink) topbarLink.style.display = 'none';
							});
							document.addEventListener('keydown', function(e) {
								if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
									e.preventDefault();
									var filterInput = document.querySelector('.operation-filter-input');
									if (filterInput) {
										filterInput.focus();
										filterInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
									}
								}
							});

							// Enhanced filter: match tags, paths, and descriptions
							(function() {
								var input, debounceTimer;
								function waitForFilter() {
									input = document.querySelector('.operation-filter-input');
									if (!input) return setTimeout(waitForFilter, 300);
									input.setAttribute('placeholder', 'Filter by tag, endpoint, or description...');
									// Clone and replace to strip Swagger's built-in event listeners
									var clone = input.cloneNode(true);
									var parent = input.parentNode;
									parent.replaceChild(clone, input);
									input = clone;
									// Wrap input with a container for the clear button
									var wrapper = document.createElement('div');
									wrapper.className = 'filter-wrapper';
									input.parentNode.insertBefore(wrapper, input);
									wrapper.appendChild(input);
									var clearBtn = document.createElement('button');
									clearBtn.className = 'filter-clear-btn';
									clearBtn.type = 'button';
									clearBtn.innerHTML = '&times;';
									clearBtn.title = 'Clear filter';
									clearBtn.style.display = 'none';
									wrapper.appendChild(clearBtn);
									function updateClearBtn() {
										clearBtn.style.display = input.value ? '' : 'none';
									}
									input.addEventListener('input', function() {
										updateClearBtn();
										clearTimeout(debounceTimer);
										debounceTimer = setTimeout(applyFilter, 150);
									});
									clearBtn.addEventListener('click', function() {
										input.value = '';
										updateClearBtn();
										applyFilter();
										input.focus();
									});
								}
								function applyFilter() {
									var query = (input.value || '').toLowerCase().trim();
									var sections = document.querySelectorAll('.opblock-tag-section');
									sections.forEach(function(section) {
										if (!query) {
											section.style.display = '';
											section.querySelectorAll('.opblock').forEach(function(op) { op.style.display = ''; });
											return;
										}
										var tag = (section.querySelector('.opblock-tag') || {}).textContent || '';
										var tagMatch = tag.toLowerCase().indexOf(query) !== -1;
										var ops = section.querySelectorAll('.opblock');
										var anyOpMatch = false;
										ops.forEach(function(op) {
											var path = (op.querySelector('.opblock-summary-path') || {}).textContent || '';
											var desc = (op.querySelector('.opblock-summary-description') || {}).textContent || '';
											var method = (op.querySelector('.opblock-summary-method') || {}).textContent || '';
											var match = path.toLowerCase().indexOf(query) !== -1
												|| method.toLowerCase().indexOf(query) !== -1
												|| tagMatch
												|| desc.toLowerCase().indexOf(query) !== -1;
											op.style.display = match ? '' : 'none';
											if (match) anyOpMatch = true;
										});
										section.style.display = (tagMatch || anyOpMatch) ? '' : 'none';
									});
								}
								waitForFilter();
							})();

							// Sync the built-in dark-mode toggle (lightbulb) with data-theme
							(function() {
								var ready = false;
								function getOldBg() {
									var el = document.querySelector('.swagger-ui');
									return el ? getComputedStyle(el).backgroundColor : null;
								}
								function syncTheme() {
									var isDark = document.documentElement.classList.contains('dark-mode')
										|| (!ready && window.matchMedia('(prefers-color-scheme: dark)').matches);
									var oldBg = ready ? getOldBg() : null;
									document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
									if (ready && oldBg) {
										var overlay = document.createElement('div');
										overlay.className = 'theme-fade-overlay';
										overlay.style.backgroundColor = oldBg;
										document.body.appendChild(overlay);
										requestAnimationFrame(function() {
											overlay.classList.add('fade-out');
											overlay.addEventListener('transitionend', function() {
												overlay.remove();
											});
										});
									}
								}
								// Initial sync - no overlay
								syncTheme();
								// Start observing only after a delay so startup class changes are ignored
								setTimeout(function() {
									ready = true;
									var observer = new MutationObserver(function(mutations) {
										mutations.forEach(function(m) {
											if (m.attributeName === 'class') syncTheme();
										});
									});
									observer.observe(document.documentElement, { attributes: true });
								}, 750);
							})();
						`,
				}),
			);
			app.get('/api-docs', (_, res) => {
				res.json(JSON.parse(docsString));
			});

			//serve the static admin files
			const adminDistDir = path.resolve(__dirname, 'frontend/dist');
			app.use('/admin', express.static(adminDistDir));
			app.use('/_next', express.static(path.join(adminDistDir, '_next')));
			// Catch all routes for admin and serve the correct HTML file for each route
			app.get('/admin/*name', (req, res, next) => {
				// Skip static files (files with extensions)
				if (req.path.match(/\.[a-zA-Z0-9]+$/)) {
					return next();
				}

				const routeName = req.path.replace('/admin/', '').replace(/\/$/, '');

				const htmlFile = routeName === '' ? 'index.html' : `${routeName}.html`;
				const requestedPath = path.resolve(adminDistDir, htmlFile);

				// Ensure resolved path stays inside frontend/dist (prevents path traversal)
				const relativeToBase = path.relative(adminDistDir, requestedPath);
				const isOutsideBase = relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase);

				if (isOutsideBase || !fs.existsSync(requestedPath)) {
					res.sendFile(path.join(adminDistDir, '404.html'));
					return;
				}
				res.sendFile(requestedPath);
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

	await createServer(serverConfig, router);
	logger.info('Web server started successfully', { component: 'server' }, { port: PORT });
	registerShutdownHandlers();
}
