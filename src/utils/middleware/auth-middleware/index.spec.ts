import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testMiddleware } from 'express-zod-api';
import { ApiKeyStatus, Network, Permission } from '@/generated/prisma/client';
import { generateSHA256Hash } from '@/utils/crypto';

type AnyMock = Mock<(...args: any[]) => any>;

jest.unstable_mockModule('@/utils/db', () => ({
  prisma: {
    apiKey: {
      findUnique: jest.fn(),
    },
  },
}));

const { authMiddleware } = await import('./index');
const { prisma } = await import('@/utils/db');
const mockFindUnique = prisma.apiKey.findUnique as AnyMock;

describe('authMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('should resolve successfully if valid token provided', async () => {
    mockFindUnique.mockResolvedValue({
      id: 1,
      permission: Permission.Admin,
      status: ApiKeyStatus.Active,
      tokenHash: generateSHA256Hash('valid'),
      token: 'valid',
      usageLimited: true,
      networkLimit: [],
    });
    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.Admin),
      requestProps: {
        method: 'POST',
        body: {},
        headers: { token: 'valid' },
      },
    });

    expect(responseMock.statusCode).toBe(200);
  });

  it('should throw 401 if no token provided read', async () => {
    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.Read),
      requestProps: { method: 'POST', body: {}, headers: {} },
    });

    expect(responseMock.statusCode).toBe(401);
  });
  it('should throw 401 if no token provided pay', async () => {
    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.ReadAndPay),
      requestProps: { method: 'POST', body: {}, headers: {} },
    });

    expect(responseMock.statusCode).toBe(401);
  });
  it('should throw 401 if no token provided admin', async () => {
    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.Admin),
      requestProps: { method: 'POST', body: {}, headers: {} },
    });

    expect(responseMock.statusCode).toBe(401);
  });
  it('should throw 401 if invalid token read', async () => {
    mockFindUnique.mockResolvedValue(null);

    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.Read),
      requestProps: {
        method: 'POST',
        body: {},
        headers: { token: 'invalid' },
      },
    });

    expect(responseMock.statusCode).toBe(401);
  });
  it('should throw 401 if invalid token pay', async () => {
    mockFindUnique.mockResolvedValue(null);

    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.ReadAndPay),
      requestProps: {
        method: 'POST',
        body: {},
        headers: { token: 'invalid' },
      },
    });

    expect(responseMock.statusCode).toBe(401);
  });
  it('should throw 401 if invalid token admin', async () => {
    mockFindUnique.mockResolvedValue(null);

    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.Admin),
      requestProps: {
        method: 'POST',
        body: {},
        headers: { token: 'invalid' },
      },
    });

    expect(responseMock.statusCode).toBe(401);
  });

  it('should throw 401 if pay required but user is read', async () => {
    mockFindUnique.mockResolvedValue({
      id: 1,
      permission: Permission.Read,
      status: ApiKeyStatus.Active,
      tokenHash: generateSHA256Hash('valid'),
      token: 'valid',
      usageLimited: true,
    });

    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.ReadAndPay),
      requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
    });

    expect(responseMock.statusCode).toBe(401);
  });
  it('should throw 401 if admin required but user is not admin', async () => {
    mockFindUnique.mockResolvedValue({
      id: 1,
      permission: Permission.ReadAndPay,
      status: ApiKeyStatus.Active,
      tokenHash: generateSHA256Hash('valid'),
      token: 'valid',
      usageLimited: true,
      networkLimit: [Network.Preprod],
    });

    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.Admin),
      requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
    });

    expect(responseMock.statusCode).toBe(401);
  });
  it('should throw 401 if token is revoked', async () => {
    mockFindUnique.mockResolvedValue({
      id: 1,
      permission: Permission.Admin,
      status: ApiKeyStatus.Revoked,
      tokenHash: generateSHA256Hash('valid'),
      token: 'valid',
      usageLimited: true,
      networkLimit: [Network.Preprod],
    });

    const { responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.Admin),
      requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
    });

    expect(responseMock.statusCode).toBe(401);
  });

  it('should pass validation with valid user token', async () => {
    const mockApiKey = {
      id: 1,
      permission: Permission.Read,
      status: ApiKeyStatus.Active,
      tokenHash: generateSHA256Hash('valid'),
      token: 'valid',
      usageLimited: true,
      networkLimit: [],
    };
    mockFindUnique.mockResolvedValue(mockApiKey);

    const { output } = await testMiddleware({
      middleware: authMiddleware(Permission.Read),
      requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
    });

    expect(output).toEqual({
      id: mockApiKey.id,
      permission: mockApiKey.permission,
      usageLimited: mockApiKey.usageLimited,
      networkLimit: mockApiKey.networkLimit,
    });
  });

  it('should pass validation with valid pay token', async () => {
    const mockApiKey = {
      id: 1,
      permission: Permission.ReadAndPay,
      status: ApiKeyStatus.Active,
      usageLimited: true,
      networkLimit: [],
    };
    mockFindUnique.mockResolvedValue(mockApiKey);

    const { output } = await testMiddleware({
      middleware: authMiddleware(Permission.ReadAndPay),
      requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
    });

    expect(output).toEqual({
      id: mockApiKey.id,
      permission: mockApiKey.permission,
      usageLimited: mockApiKey.usageLimited,
      networkLimit: [],
    });
  });
  it('should pass validation with valid admin token', async () => {
    const mockApiKey = {
      id: 1,
      permission: Permission.Admin,
      status: ApiKeyStatus.Active,
      usageLimited: false,
      networkLimit: [],
    };
    mockFindUnique.mockResolvedValue(mockApiKey);

    const { output } = await testMiddleware({
      middleware: authMiddleware(Permission.Admin),
      requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
    });

    expect(output).toEqual({
      id: mockApiKey.id,
      permission: mockApiKey.permission,
      networkLimit: [Network.Mainnet, Network.Preprod],
      usageLimited: false,
    });
  });
  it('should pass validation with valid network ', async () => {
    const mockApiKey = {
      id: 1,
      permission: Permission.ReadAndPay,
      status: ApiKeyStatus.Active,
      usageLimited: false,
      networkLimit: [Network.Preprod, Network.Mainnet],
    };
    mockFindUnique.mockResolvedValue(mockApiKey);

    const { output, responseMock } = await testMiddleware({
      middleware: authMiddleware(Permission.ReadAndPay),
      requestProps: { method: 'POST', body: {}, headers: { token: 'valid' } },
    });
    expect(responseMock.statusCode).toBe(200);

    expect(output).toEqual({
      id: mockApiKey.id,
      permission: mockApiKey.permission,
      networkLimit: mockApiKey.networkLimit,
      usageLimited: mockApiKey.usageLimited,
    });
  });
});
