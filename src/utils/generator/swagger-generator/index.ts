import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from '@masumi/payment-core/zod';
import { registerAdminPaths } from './registrars/admin';
import { registerPaymentPaths } from './registrars/payments';
import { registerInvoiceAndPurchasePaths } from './registrars/invoices-purchases';
import { registerRegistrySupportPaths } from './registrars/registry-support';
// Colocated docs: these route areas keep their OpenAPI docs next to their
// schemas/handlers (src/routes/api/<area>/docs.ts). The remaining ./registrars
// files span multiple route areas and are migrated area-by-area.
import { registerRegistryInboxSupportPaths } from '@/routes/api/registry-inbox/docs';
import { registerMonitoringPaths } from '@/routes/api/monitoring/docs';
import { registerX402Paths } from '@/routes/api/x402/docs';
import { registerX402ManagementPaths } from '@/routes/api/x402/management-docs';
import { registerFundWalletPaths } from '@/routes/api/fund-wallet/docs';
import { registerFundDistributionPaths } from '@/routes/api/fund-distribution/docs';
import { registerHydraPaths } from '@/routes/api/hydra/docs';
import { registerHydraHeadChainCheckPath } from '@/routes/api/hydra/docs-head-chain-check';
import { registerHydraHeadRetirePath } from '@/routes/api/hydra/docs-head-retire';
import { registerHydraHeadPartialFanoutPath } from '@/routes/api/hydra/docs-head-partial-fanout';
import { registerRailReadinessPaths } from '@/routes/api/rail-readiness/docs';
import { registerTxSyncQuarantinePaths } from '@/routes/api/tx-sync-quarantine/docs';
import { registerRequestRepairPaths } from '@/routes/api/request-repair/docs';
import { registerReportPaths } from '@/routes/api/reports/docs';
import { registerReleaseStatusPaths } from '@/routes/api/release-status/docs';
import { registerSecurityStatusPaths } from '@/routes/api/security-status/docs';

extendZodWithOpenApi(z);

export function generateOpenAPI() {
	const registry = new OpenAPIRegistry();

	const apiKeyAuth = registry.registerComponent('securitySchemes', 'API-Key', {
		type: 'apiKey',
		in: 'header',
		name: 'token',
		description: 'API key authentication via header (token)',
	});

	registerAdminPaths({ registry, apiKeyAuth });
	registerPaymentPaths({ registry, apiKeyAuth });
	registerInvoiceAndPurchasePaths({ registry, apiKeyAuth });
	registerRegistrySupportPaths({ registry, apiKeyAuth });
	registerRegistryInboxSupportPaths({ registry, apiKeyAuth });
	registerMonitoringPaths({ registry, apiKeyAuth });
	registerX402Paths({ registry, apiKeyAuth });
	registerX402ManagementPaths({ registry, apiKeyAuth });
	registerFundWalletPaths({ registry, apiKeyAuth });
	registerFundDistributionPaths({ registry, apiKeyAuth });
	registerHydraPaths({ registry, apiKeyAuth });
	registerHydraHeadChainCheckPath({ registry, apiKeyAuth });
	registerHydraHeadRetirePath({ registry, apiKeyAuth });
	registerHydraHeadPartialFanoutPath({ registry, apiKeyAuth });
	registerRailReadinessPaths({ registry, apiKeyAuth });
	registerTxSyncQuarantinePaths({ registry, apiKeyAuth });
	registerRequestRepairPaths({ registry, apiKeyAuth });
	registerReportPaths({ registry, apiKeyAuth });
	registerReleaseStatusPaths({ registry, apiKeyAuth });
	registerSecurityStatusPaths({ registry, apiKeyAuth });

	return new OpenApiGeneratorV3(registry.definitions).generateDocument({
		openapi: '3.0.0',
		info: {
			version: '1.0.0',
			title: 'Masumi Payment Service API',
			description:
				'A comprehensive payment service API for the Masumi ecosystem, providing secure payment processing, agent registry management, and wallet operations.',
		},
		servers: [{ url: './../api/v1/' }],
	});
}
