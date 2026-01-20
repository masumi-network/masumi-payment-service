import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import { Network, RPCProvider } from '@/generated/prisma/client';
import { AuthContext } from '@/utils/middleware/auth-middleware';

export const getRpcProviderKeysSchemaInput = z.object({
  cursorId: z
    .string()
    .min(1)
    .max(250)
    .optional()
    .describe('Used to paginate through the rpc provider keys'),
  limit: z.coerce
    .number()
    .min(1)
    .max(100)
    .default(100)
    .describe('The number of rpc provider keys to return'),
});

export const rpcProviderKeyOutputSchema = z
  .object({
    id: z.string().describe('Unique identifier for the RPC provider key'),
    rpcProviderApiKey: z.string().describe('The RPC provider API key '),
    rpcProvider: z.nativeEnum(RPCProvider).describe('The RPC provider type '),
    createdAt: z
      .date()
      .describe('Timestamp when the RPC provider key was created'),
    updatedAt: z
      .date()
      .describe('Timestamp when the RPC provider key was last updated'),
    network: z
      .nativeEnum(Network)
      .describe('The Cardano network this RPC provider key is for'),
  })
  .openapi('RpcProviderKey');

export const getRpcProviderKeysSchemaOutput = z.object({
  RpcProviderKeys: z
    .array(rpcProviderKeyOutputSchema)
    .describe('List of RPC provider keys'),
});

export const queryRpcProviderKeysEndpointGet =
  adminAuthenticatedEndpointFactory.build({
    method: 'get',
    input: getRpcProviderKeysSchemaInput,
    output: getRpcProviderKeysSchemaOutput,
    handler: async ({
      input,
      ctx,
    }: {
      input: z.infer<typeof getRpcProviderKeysSchemaInput>;
      ctx: AuthContext;
    }) => {
      const rpcProviderKeys = await prisma.paymentSourceConfig.findMany({
        cursor: input.cursorId ? { id: input.cursorId } : undefined,
        take: input.limit,
        orderBy: { createdAt: 'asc' },
        where: {
          PaymentSource: {
            deletedAt: null,
            network: { in: ctx.networkLimit },
          },
        },
        include: {
          PaymentSource: { select: { network: true } },
        },
      });

      return {
        RpcProviderKeys: rpcProviderKeys.map((rpcProviderKey) => ({
          id: rpcProviderKey.id,
          rpcProviderApiKey: rpcProviderKey.rpcProviderApiKey,
          rpcProvider: rpcProviderKey.rpcProvider,
          createdAt: rpcProviderKey.createdAt,
          updatedAt: rpcProviderKey.updatedAt,
          network: rpcProviderKey.PaymentSource!.network,
        })),
      };
    },
  });
