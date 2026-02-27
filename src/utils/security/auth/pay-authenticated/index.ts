import { authMiddleware } from '@/utils/middleware/auth-middleware';
import endpointFactory from '@/utils/generator/endpoint-factory';

export const payAuthenticatedEndpointFactory = endpointFactory.addMiddleware(
  authMiddleware('pay'),
);
