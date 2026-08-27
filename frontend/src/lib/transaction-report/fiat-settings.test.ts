import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NO_FIAT_CURRENCY,
  availableFiatCurrencies,
  getFiatIssue,
  isReportFiatCurrency,
  type ReportFiatCapability,
  fiatCurrencyFromUnit,
  fiatUnitFor,
  isFiatUnit,
} from './fiat-settings';

const DEMO: ReportFiatCapability = {
  isConfigured: true,
  isDemoKey: true,
  historyDays: 365,
  earliestPriceableDate: new Date('2025-08-25T00:00:00.000Z'),
  currencies: ['usd', 'eur'],
  modes: ['PeriodAverage', 'AccountingDate', 'TransactionTime'],
  attribution: 'Exchange rates by CoinGecko',
  setupHint: 'Set COINGECKO_API_KEY.',
};

describe('fiat settings', () => {
  it('offers only the currencies the service can price', () => {
    const values = availableFiatCurrencies(DEMO).map((option) => option.value);
    assert.deepEqual(values, ['usd', 'eur']);
  });

  it('offers every currency while the capability is unknown', () => {
    assert.ok(availableFiatCurrencies(null).length > 2);
  });

  it('reports no issue while no currency is picked', () => {
    assert.equal(getFiatIssue(DEMO, NO_FIAT_CURRENCY, new Date('2020-01-01T00:00:00Z')), null);
  });

  it('asks for setup when the service has no key', () => {
    const issue = getFiatIssue({ ...DEMO, isConfigured: false }, 'usd', new Date());
    assert.equal(issue?.kind, 'setup');
    assert.match(issue?.message ?? '', /COINGECKO_API_KEY/u);
  });

  it('refuses a range a demo key cannot price, naming the earliest day', () => {
    const issue = getFiatIssue(DEMO, 'usd', new Date('2024-01-01T00:00:00Z'));
    assert.equal(issue?.kind, 'range');
    assert.match(issue?.message ?? '', /2025-08-25/u);
  });

  it('accepts a range inside the demo window', () => {
    assert.equal(getFiatIssue(DEMO, 'usd', new Date('2026-08-01T00:00:00Z')), null);
  });

  it('places no range limit on a paid key', () => {
    const paid = { ...DEMO, isDemoKey: false, historyDays: null, earliestPriceableDate: null };
    assert.equal(getFiatIssue(paid, 'usd', new Date('2019-01-01T00:00:00Z')), null);
  });

  it('recognizes only supported currency codes', () => {
    assert.equal(isReportFiatCurrency('usd'), true);
    assert.equal(isReportFiatCurrency(NO_FIAT_CURRENCY), false);
  });
});

describe('fiat units', () => {
  it('round-trips a currency through its unit', () => {
    assert.equal(fiatUnitFor('eur'), 'fiat:eur');
    assert.equal(fiatCurrencyFromUnit('fiat:eur'), 'eur');
  });

  it('treats a real asset unit as no conversion', () => {
    assert.equal(fiatCurrencyFromUnit('lovelace'), null);
    assert.equal(isFiatUnit('lovelace'), false);
  });

  it('rejects a currency this report cannot produce', () => {
    assert.equal(fiatCurrencyFromUnit('fiat:xyz'), null);
    assert.equal(isFiatUnit('fiat:xyz'), false);
  });
});
