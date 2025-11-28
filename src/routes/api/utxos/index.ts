import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from 'zod';
import { $Enums, Network } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { errorToString } from 'advanced-retry';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const getUTXOSchemaInput = z.object({
  address: z.string().max(150).describe('The address to get the UTXOs for'),
  network: z.nativeEnum(Network),
  count: z
    .number({ coerce: true })
    .int()
    .min(1)
    .max(100)
    .default(10)
    .optional()
    .describe('The number of UTXOs to get'),
  page: z
    .number({ coerce: true })
    .int()
    .min(1)
    .max(100)
    .default(1)
    .optional()
    .describe('The page number to get'),
  order: z
    .enum(['asc', 'desc'])
    .default('desc')
    .optional()
    .describe('The order to get the UTXOs in'),
});

export const getUTXOSchemaOutput = z.object({
  Utxos: z.array(
    z.object({
      txHash: z.string(),
      address: z.string(),
      Amounts: z.array(
        z.object({
          unit: z
            .string()
            .describe(
              'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
            ),
          quantity: z
            .number({ coerce: true })
            .int()
            .min(0)
            .max(100000000000000)
            .describe(
              'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
            ),
        }),
      ),
      dataHash: z.string().nullable(),
      inlineDatum: z.string().nullable(),
      referenceScriptHash: z.string().nullable(),
      outputIndex: z.number({ coerce: true }).int().min(0).max(1000000000),
      block: z.string(),
    }),
  ),
});

export const queryUTXOEndpointGet = readAuthenticatedEndpointFactory.build({
  method: 'get',
  input: getUTXOSchemaInput,
  output: getUTXOSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof getUTXOSchemaInput>;
    options: {
      id: string;
      permission: $Enums.Permission;
      networkLimit: $Enums.Network[];
      usageLimited: boolean;
    };
  }) => {
    await checkIsAllowedNetworkOrThrowUnauthorized(
      options.networkLimit,
      input.network,
      options.permission,
    );
    const paymentSource = await prisma.paymentSource.findFirst({
      where: { network: input.network, deletedAt: null },
      include: { PaymentSourceConfig: true },
    });
    if (paymentSource == null) {
      throw createHttpError(404, 'Network not found');
    }
    try {
      const blockfrost = new BlockFrostAPI({
        projectId: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
      });
      const utxos = await blockfrost.addressesUtxos(input.address, {
        count: input.count,
        page: input.page,
        order: input.order,
      });
      return {
        Utxos: utxos.map((utxo) => ({
          txHash: utxo.tx_hash,
          address: utxo.address,
          Amounts: utxo.amount.map((amount) => ({
            unit: amount.unit,
            quantity: parseInt(amount.quantity),
          })),
          outputIndex: utxo.output_index,
          block: utxo.block,
          dataHash: utxo.data_hash,
          inlineDatum: utxo.inline_datum,
          referenceScriptHash: utxo.reference_script_hash,
        })),
      };
    } catch (error) {
      if (errorToString(error).includes('ValueNotConservedUTxO')) {
        throw createHttpError(404, 'Wallet not found');
      }
      throw createHttpError(500, 'Failed to get UTXOs');
    }
  },
});
