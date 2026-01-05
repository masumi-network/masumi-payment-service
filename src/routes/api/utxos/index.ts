import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { $Enums, Network } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { errorToString } from 'advanced-retry';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const getUTXOSchemaInput = z.object({
  address: z.string().max(150).describe('The address to get the UTXOs for'),
  network: z.nativeEnum(Network).describe('The Cardano network'),
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

export const utxoOutputSchema = z
  .object({
    txHash: z.string().describe('Transaction hash containing this UTXO'),
    address: z.string().describe('Cardano address holding this UTXO'),
    Amounts: z
      .array(
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
      )
      .describe('List of assets and amounts in this UTXO'),
    dataHash: z
      .string()
      .nullable()
      .describe('Hash of the datum attached to this UTXO. Null if no datum'),
    inlineDatum: z
      .string()
      .nullable()
      .describe(
        'Inline datum data in CBOR hex format. Null if no inline datum',
      ),
    referenceScriptHash: z
      .string()
      .nullable()
      .describe(
        'Hash of the reference script attached to this UTXO. Null if no reference script',
      ),
    outputIndex: z
      .number({ coerce: true })
      .int()
      .min(0)
      .max(1000000000)
      .describe('Output index of this UTXO in the transaction'),
    block: z.string().describe('Block hash where this UTXO was created'),
  })
  .openapi('Utxo');
export const getUTXOSchemaOutput = z.object({
  Utxos: z
    .array(utxoOutputSchema)
    .describe('List of UTXOs for the specified address'),
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
      include: { PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
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
      if (
        errorToString(error).includes('ValueNotConservedUTxO') ||
        (errorToString(error).toLowerCase().includes('not') &&
          errorToString(error).toLowerCase().includes('found')) ||
        ((error as { statusCode?: number | string })
          .statusCode as unknown as number) == 404
      ) {
        throw createHttpError(404, 'Address not found');
      }
      throw createHttpError(500, 'Failed to get UTXOs');
    }
  },
});
