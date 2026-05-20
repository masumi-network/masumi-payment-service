import endpointFactory from './endpoint-factory';
import { authMiddleware } from './auth-middleware';

export const adminAuthenticatedEndpointFactory = endpointFactory.addMiddleware(authMiddleware({ canAdmin: true }));
export const payAuthenticatedEndpointFactory = endpointFactory.addMiddleware(authMiddleware({ canPay: true }));
export const readAuthenticatedEndpointFactory = endpointFactory.addMiddleware(authMiddleware({ canRead: true }));
export const unauthenticatedEndpointFactory = endpointFactory;

export { authMiddleware, checkIsAllowedNetworkOrThrowUnauthorized, type AuthContext } from './auth-middleware';
