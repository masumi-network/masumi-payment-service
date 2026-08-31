import { z } from 'zod';
import { convertDecimalToBaseUnits } from '@/lib/convertDecimalToBaseUnits';
import { creditDeltas, creditRowProblem } from '@/lib/api-key-credit-units';

/** Mirrors updateAPIKeySchemaInput.UsageCreditsToAddOrRemove.max(25). */
export const MAX_USAGE_CREDIT_DELTAS = 25;

type StoredCredit = { unit: string; amount: string };
type EditableCredit = { unit: string; amount: string; decimals: number };

export function usageCreditDeltas(
  usageLimited: boolean,
  current: StoredCredit[],
  next: EditableCredit[],
): Array<{ unit: string; amount: string }> {
  if (!usageLimited) return [];
  return creditDeltas(
    current,
    next.map((credit) => ({
      unit: credit.unit,
      amount: convertDecimalToBaseUnits(credit.amount, credit.decimals),
    })),
  );
}

/** Build validation from the balances this key currently stores. */
export function buildUpdateApiKeySchema(currentCredits: StoredCredit[]) {
  const fundedUnits = new Set(currentCredits.map((credit) => credit.unit));

  return z
    .object({
      newToken: z
        .string()
        .min(15, 'Token must be at least 15 characters')
        .optional()
        .or(z.literal('')),
      status: z.enum(['Active', 'Revoked']),
      usageLimited: z.boolean(),
      credits: z.array(z.object({ unit: z.string(), amount: z.string(), decimals: z.number() })),
      walletScopeEnabled: z.boolean(),
      walletScopeIds: z.array(z.string()),
      x402WalletScopeEnabled: z.boolean(),
      x402WalletScopeIds: z.array(z.string()),
      evmChains: z.array(z.string()),
    })
    .superRefine((value, context) => {
      // An unlimited key ignores stored credits and sends no credit deltas.
      if (!value.usageLimited) return;

      let hasInvalidCredit = false;
      value.credits.forEach((credit, index) => {
        const problem = creditRowProblem(credit, fundedUnits);
        if (problem === undefined) return;
        hasInvalidCredit = true;
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: problem,
          path: ['credits', index, 'amount'],
        });
      });
      if (hasInvalidCredit) return;

      const deltas = usageCreditDeltas(true, currentCredits, value.credits);
      if (deltas.length > MAX_USAGE_CREDIT_DELTAS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Change at most ${MAX_USAGE_CREDIT_DELTAS} balances in one update.`,
          path: ['credits', 'root'],
        });
      }
    });
}

export type UpdateApiKeyFormValues = z.infer<ReturnType<typeof buildUpdateApiKeySchema>>;
