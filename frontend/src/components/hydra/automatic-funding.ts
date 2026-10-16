import { adaToLovelace } from './ada-amount';

const MAX_FUNDING_LIMIT_LOVELACE = BigInt('9223372036854775807');
const LOVELACE_PER_ADA = BigInt('1000000');

export function fundingLovelaceToAda(value: string): string {
  const amount = BigInt(value);
  const fraction = (amount % LOVELACE_PER_ADA).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount / LOVELACE_PER_ADA}${fraction ? `.${fraction}` : ''}`;
}

export function parseAutomaticFundingLimit(value: string): string | null {
  const trimmed = value.trim();
  if (/^0+(\.0{1,6})?$/.test(trimmed)) return '0';
  const lovelace = adaToLovelace(trimmed);
  return lovelace !== null && BigInt(lovelace) <= MAX_FUNDING_LIMIT_LOVELACE ? lovelace : null;
}
