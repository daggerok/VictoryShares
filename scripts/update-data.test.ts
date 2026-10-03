/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROL_NAMES, RETURNS_BASIS, buildPages, cachedFundFromIndex, configureLanes, formatFrequencyPlaceholder, fundAgeAtLeast, fundPasses,
  getText, historyRows, httpSettings, indexRow, inferFrequency, installSystemCa, isCertError, isSectionMissing, main, nportIsUsable,
  pageBasenames, paceRequest, parseAtomFilings, parseAumRange, parseCatalog, parseDistributionPayload, parseFundTickerRefs,
  parseHistoryRange, parseHoldings, parseIssuerClientConfig, parseNportHoldings, parseNportIdentity, parsePremiumDiscount, parseRange,
  parseYahooChart, performanceDateIso, readConfig, resolveControls, returnsFromCatalog, rotateSelection, runUpdate, runtimeControls,
  useApiRoot, yahooChartUrl,
} from './update-data';

// ---------------------------------------------------------------------------
// Shared setup: clean environment, pinned TZ, restored fetch / exit code / console / clock
// ---------------------------------------------------------------------------
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = (): Record<string, string> => JSON.parse(read('scripts/update-data.config.json'));
const realFetch = globalThis.fetch;
const realExitCode = process.exitCode;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;
const savedHttp = { ...httpSettings };
const savedEnv = { ...process.env };
const tempDirs: string[] = [];
const isControlVar = (key: string): boolean =>
  (CONTROL_NAMES as readonly string[]).includes(key) || ['NODE_USE_SYSTEM_CA', 'ETF_UPDATER_SYSTEM_CA', 'GITHUB_STEP_SUMMARY'].includes(key);

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (isControlVar(key)) delete process.env[key];
  process.env.TZ = 'UTC';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  Date.now = realNow;
  process.exitCode = realExitCode ?? 0;
  Object.assign(console, realConsole);
  Object.assign(httpSettings, savedHttp);
  configureLanes(1, 1);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake clock: Date.now and setTimeout advance together, so paced waits are exact and instant. */
function fakeClock(): { waits: number[] } {
  let clock = 1_800_000_000_000;
  const waits: number[] = [];
  Date.now = () => clock;
  globalThis.setTimeout = ((callback: () => void, ms = 0) => { waits.push(ms); clock += ms; return realSetTimeout(callback, 0); }) as unknown as typeof setTimeout;
  return { waits };
}

const catalogFixture = [{
  ticker: 'VFLO', entity_long_name: 'VictoryShares Free Cash Flow ETF', asset_class: 'US Equity',
  latest_nav: '51.59', market_close: '51.60', net_assets: '10993961469', gross_exp_ratio: '0.44', net_expense_ratio: '0.39',
  inception_date: '06/21/2023', nav_as_of: '09/25/2026', monthly_performance_as_of_date: '08/31/2026', premium_discount_percentage: '-0.0043',
  performance: { monthly: { as_of: '08/31/2026', ytd_nav: '41.85', oneyear_nav: '51.00', threeyear_nav: '29.99', fiveyear_nav: null, tenyear_nav: null, since_inception_nav: '30.11' }, quarterly: {} },
}];
const [vflo] = parseCatalog(catalogFixture);

// ===========================================================================
describe('controls', () => {
  test('precedence: file < advanced < nonblank input < env, explicit empty env clears, protected SEC_UA wins', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'VFLO' }, { CONCURRENCY: 3, TICKERS: 'USTB' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
    expect([c.CONCURRENCY, c.TICKERS]).toEqual(['6', 'USTB']);
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ TICKERS: 'VFLO' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'VFLO' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls(configFile(), { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    expect(resolveControls(configFile(), { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
  });

  test('strict validation: bad ranges, HISTORY_RANGE, MAX_RETRIES < 1, unknown keys, non-scalars, CR/LF/NUL', () => {
    for (const value of [
      { UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { SEC_UA: 'x\rfoo' }, { SEC_UA: 'x\0bad' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 },
      { MAX_FETCHES: 1.5 }, { HOLDINGS_PAGE_SIZE: 0 }, { HISTORY_PAGE_SIZE: 0 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' },
      { EDGAR_FALLBACK: 'x' }, { SKIP_YAHOO: 'x' }, { HISTORY_RANGE: '7d' }, { HISTORY_RANGE: '6mo' }, { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: '100y' },
      { HISTORY_RANGE: '5' }, { AUM: '1:2:3' }, { TER: '5' }, { TER: '5:1' }, { TICKERS: ['VFLO'] }, { TICKERS: { a: 1 } }, null, [],
    ]) {
      expect(() => resolveControls(value)).toThrow();
      if (value && !Array.isArray(value)) expect(() => resolveControls({}, value)).toThrow();
    }
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow();
    expect(() => resolveControls({}, 'x')).toThrow();
    expect([parseHistoryRange(undefined), parseHistoryRange('MAX'), parseHistoryRange('10y')]).toEqual(['max', 'max', '10y']);
    for (const bad of ['6mo', '3mo', '0y', '100y', '5', 'y', '1.5y', 'ytd']) expect(() => parseHistoryRange(bad)).toThrow('HISTORY_RANGE');
  });

  test('config file: keys equal CONTROL_NAMES and --help, values are strings, the scheduled path equals the defaults', async () => {
    const file = configFile();
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file)) expect(typeof value).toBe('string');
    expect(resolveControls(file, {}, {}, {})).toEqual(file);
    expect(await runtimeControls({})).toEqual(file);
    expect((await runtimeControls({ CONCURRENCY: '3' })).CONCURRENCY).toBe('3');
    const lines: string[] = [];
    console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
    await main({}, ['bun', 'update-data.ts', '--help']);
    const help = lines.join('\n');
    for (const name of CONTROL_NAMES) expect(help).toContain(/^(PERFORMANCE|TOTAL_RETURN)_/.test(name) ? name.replace(/_(YTD|1Y|3Y|5Y|10Y)$/, '') + '_{YTD,1Y,3Y,5Y,10Y}' : name);
    const config = readConfig(resolveControls(file));
    expect(config.tickers.size).toBe(0);
    expect(config).toMatchObject({ maxFetches: 0, requestSleep: 1, concurrency: 2, maxRetries: 2, holdingsPageSize: 250, historyPageSize: 1000, historyRange: 'max', edgarFallback: true, skipYahoo: false });
    expect(config.aum.source).toBe(':');
  });

  test('SEC_UA defaults to the daggerok contact, a blank value falls back to it', () => {
    expect(configFile().SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect([readConfig(resolveControls(configFile())).secUa, readConfig({ SEC_UA: '' }).secUa, readConfig({ SEC_UA: '   ' }).secUa]).toEqual(Array(3).fill('daggerok ETF feed daggerok@gmail.com'));
    expect(readConfig({ SEC_UA: 'me me@x.test' }).secUa).toBe('me me@x.test');
  });

  test('inclusive ranges, K/M/B/T AUM bounds and presets', () => {
    expect(parseRange('0.2:2').min).toBe(0.2);
    expect(parseAumRange('10M:2B')).toMatchObject({ min: 10000000, max: 2000000000 });
    expect(parseAumRange('small')).toMatchObject({ min: 300000000, max: 2000000000 });
    expect(() => parseRange('1')).toThrow('colon required');
    expect(() => parseRange('5:1')).toThrow('exceeds');
  });

  test('return and TER filters exclude funds whose bounded value is null, unbounded filters keep them', () => {
    const fresh = { ...vflo, performance: undefined, monthly_performance_as_of_date: undefined } as never;
    const bounded = (key: string, value: string) => readConfig(resolveControls({}, {}, {}, { [key]: value }));
    expect([fundPasses(fresh, bounded('PERFORMANCE_1Y', '0:')), fundPasses(fresh, bounded('TOTAL_RETURN_YTD', ':50')), fundPasses(fresh, readConfig({}))]).toEqual([false, false, true]);
    expect([['PERFORMANCE_3Y', '20:'], ['PERFORMANCE_3Y', '40:'], ['TER', '0.4:0.5'], ['TER', '0.3:0.4']].map(([key, value]) => fundPasses(vflo, bounded(key, value)))).toEqual([true, false, false, true]);
  });

  test('MAX_FETCHES window counts only eligible funds, resumes after the cursor and wraps around', () => {
    const funds = ['A', 'B', 'C', 'D', 'E'].map((ticker) => ({ ticker }));
    const pick = (cursor: string, n = 2) => rotateSelection(funds, n, cursor).map((fund) => fund.ticker);
    expect([pick(''), pick('B'), pick('D'), pick('E'), pick('ZZ')]).toEqual([['A', 'B'], ['C', 'D'], ['E', 'A'], ['A', 'B'], ['A', 'B']]);
    expect([rotateSelection(funds, 0, 'B'), rotateSelection(funds, 9, 'B')]).toEqual([funds, funds]);
    expect(rotateSelection(funds.filter((fund) => fund.ticker !== 'C'), 2, 'B').map((fund) => fund.ticker)).toEqual(['D', 'E']);
  });

  test('USE_SYSTEM_CA: auto by default, case-insensitive, restart only on certificate errors', async () => {
    expect(resolveControls(configFile()).USE_SYSTEM_CA).toBe('auto');
    for (const value of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect([isCertError({ code: 'ECONNRESET' }), isCertError(new Error('HTTP 403 Forbidden')), isCertError(null)]).toEqual([false, false, false]);
    console.error = () => {};
    const calls: number[] = [];
    const reexec = (() => { calls.push(1); throw new Error('reexec'); }) as () => never;
    installSystemCa('false', reexec, false);
    installSystemCa('auto', reexec, true);
    expect(globalThis.fetch).toBe(realFetch);
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.test')).rejects.toThrow('ECONNRESET');
    expect(calls).toHaveLength(1);
    globalThis.fetch = (async () => { throw Object.assign(new Error('x'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.test')).rejects.toThrow('reexec');
    expect(calls).toHaveLength(2);
  });
});

// ===========================================================================
describe('parsing', () => {
  test('catalog rows keep NAV, AUM, performance fields; TER is net with gross beside it, one published number is the only value', () => {
    expect(vflo).toMatchObject({ ticker: 'VFLO', name: 'VictoryShares Free Cash Flow ETF', category: 'US Equity', navValue: 51.59, aumValue: 10993961469, terValue: 0.39, terGrossValue: 0.44 });
    expect(vflo.performance).toEqual(catalogFixture[0].performance);
    expect(parseCatalog({ error: 'not a fund list' })).toEqual([]);
    expect(parseCatalog([{ ...catalogFixture[0], latest_nav: 'n/a', net_assets: 'abc', gross_exp_ratio: '' }])[0]).toMatchObject({ navValue: null, aumValue: null, terGrossValue: null });
    expect(parseCatalog([{ ...catalogFixture[0], net_expense_ratio: null }])[0]).toMatchObject({ terValue: 0.44, terGrossValue: null });
    expect(parseCatalog([{ ...catalogFixture[0], net_expense_ratio: null, gross_exp_ratio: null }])[0]).toMatchObject({ terValue: null, terGrossValue: null });
    expect(cachedFundFromIndex({ ticker: 'X', name: 'X', terValue: 0.39, terGrossValue: 0.44 })).toMatchObject({ terValue: 0.39, terGrossValue: 0.44 });
  });

  test('the dynamic issuer client config is validated without assuming a fixed key', () => {
    const parsed = parseIssuerClientConfig('<input id="etfListEndpoint" value="https://investorapi.vcm.com/search/products/ETF"><input id="etfListApiKey" value="public-client-key">');
    expect([parsed.endpoint, parsed.apiKey]).toEqual(['https://investorapi.vcm.com/search/products/ETF', 'public-client-key']);
    expect(() => parseIssuerClientConfig('<html></html>')).toThrow('did not expose');
    expect(() => parseIssuerClientConfig('<input id="etfListEndpoint" value="https://other.example/x"><input id="etfListApiKey" value="x">')).toThrow('Unexpected issuer catalog API host');
  });

  test('holdings map to the shared columns incl. fixed income; a missing weight or value stays empty, a real "0" stays "0"', () => {
    const parsed = parseHoldings([
      { holding_name: 'US TREASURY NOTE', stock_symbol: null, isin: 'US91282CFX12', security_type: 'TREASURY NOTE', market_value: '12500.5', portfolio_percentage: '2.5', shares: '12000', coupon_rate: '4.125', maturity_date: '2030-05-15', as_of_date: '09/28/2026' },
      { holding_name: 'BORGWARNER INC.', stock_symbol: 'BWA US', isin: 'US0997241064', security_type: 'COMMON STOCK', market_value: '9000', portfolio_percentage: '1.8', shares: '80', as_of_date: '09/28/2026' },
    ]);
    expect([parsed.headers.includes('Identifier'), parsed.asOfDate]).toEqual([true, '2026-09-28']);
    expect(parsed.rows.find((row) => row.Name === 'BORGWARNER INC.')).toMatchObject({ Ticker: 'BWA', Identifier: 'US0997241064' });
    expect(parsed.rows.find((row) => row.Name === 'US TREASURY NOTE')).toMatchObject({ Ticker: '-', Coupon: '4.125', Maturity: '2030-05-15' });
    const missing = parseHoldings([{ holding_name: 'X', stock_symbol: 'X', security_type: 'COMMON STOCK', as_of_date: '10/02/2026' }]);
    expect([missing.rows[0].Weight, missing.rows[0]['Market Value']]).toEqual(['', '']);
    expect(parseNportHoldings('<invstOrSec><name>A</name><cusip>1</cusip></invstOrSec>')[0]).toMatchObject({ Weight: '', 'Market Value': '' });
    expect(parseHoldings([{ holding_name: 'X', portfolio_percentage: '0.00', market_value: '0' }]).rows[0]).toMatchObject({ Weight: '0.00', 'Market Value': '0' });
    expect(buildPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(buildPages([], 3)).toEqual([]);
    expect(pageBasenames(['holdings/001.json', 'holdings/002.json'])).toEqual(new Set(['001.json', '002.json']));
    expect(() => buildPages([1], 0)).toThrow('positive integer');
  });

  test('official distribution columns are kept and the cadence is inferred from dated rows', () => {
    const row = (date: string, amount: string) => ({ declared_date: date, record_date: date, payable_date: date, income_amt: amount, long_term_capital_gains: '0', short_term_capital_gains: '0', total_distribution: '0', return_of_capital: '0' });
    const parsed = parseDistributionPayload({ as_of_date: '07/10/2023', distributions: [row('01/08/2026', '0.1'), row('02/08/2026', '0.2'), row('03/09/2026', '0.3')] });
    expect([parsed.frequency, parsed.rows.at(-1)?.[0], inferFrequency([])]).toEqual(['Monthly', '03/09/2026', null]);
    expect(parsed.latest).toBeCloseTo(0.3);
    expect(parsed.headers).toEqual(['Declared Date', 'Record Date', 'Payable Date', 'Income Amount', 'Long-Term Capital Gains', 'Short-Term Capital Gains', 'Total Distribution', 'Return of Capital']);
  });

  test('Yahoo history is parsed, adjusted close rounded to cents and issuer premium/discount merged by date', () => {
    const days = parseYahooChart({ chart: { result: [{
      timestamp: [1780000000, 1780086400],
      indicators: { quote: [{ close: [51.596, 52] }], adjclose: [{ adjclose: [51.594, 51.991] }] },
      events: { dividends: { '1780086400': { amount: 0.12 } } },
    }] } });
    expect([days.length, days.map((day) => day.adjClose), days[1].dividend]).toEqual([2, [51.59, 51.99], 0.12]);
    const rows = historyRows(days, parsePremiumDiscount({ data: [{ effectiveDate: '05/30/2026', premiumDiscountPercentage: '-0.0254' }] }));
    expect([rows[0]['NAV'], rows[0]['Market Price'], rows[0]['Adj Close'], parsePremiumDiscount(null).size]).toEqual(['', '51.60', '51.59', 0]);
  });

  test('SEC: ETF symbols map to registrant and series, Atom keeps N-PORT-P only, N-PORT positions never invent tickers', () => {
    expect(parseFundTickerRefs({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [['1547580', 'S000073699', 'C000230775', 'VFLO']] }).get('VFLO')).toEqual({ cik: '0001547580', seriesId: 'S000073699' });
    expect(parseFundTickerRefs({ fields: [], data: [] }).size).toBe(0);
    expect(parseAtomFilings('<entry><filing-type>NPORT-P</filing-type><accession-number>0001004726-26-007544</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1547580/000100472626007544/</filing-href></entry><entry><filing-type>OTHER</filing-type><accession-number>0000000000-26-000001</accession-number></entry>')).toEqual([{ cik: '1547580', accession: '0001004726-26-007544' }]);
    const rows = parseNportHoldings('<invstOrSec><name>US Treasury Note</name><cusip>91282CFX1</cusip><pctVal>1.20</pctVal><valUSD>1250000</valUSD><balance>1200000</balance><assetCat>DBT</assetCat></invstOrSec>');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Name: 'US Treasury Note', Ticker: '-', Identifier: '91282CFX1', Weight: '1.20', 'Market Value': '1250000' });
  });

  test('dates are UTC whatever the machine time zone', () => {
    const run = () => ({
      perf: performanceDateIso('Jun 04 2026'), display: performanceDateIso('09/05/2026'),
      days: parseYahooChart({ chart: { result: [{ timestamp: [Date.UTC(2026, 8, 25, 23, 30) / 1000], indicators: { quote: [{ close: [10] }] } }] } }).map((day) => day.date),
      freq: inferFrequency(['2026-01-31', '2026-02-28', '2026-03-31']),
    });
    process.env.TZ = 'Pacific/Kiritimati';
    const east = run();
    process.env.TZ = 'Pacific/Pago_Pago';
    const west = run();
    expect(east).toEqual(west);
    expect(east).toEqual({ perf: '2026-06-04', display: '2026-09-05', days: ['2026-09-25'], freq: 'Monthly' });
  });
});

// ===========================================================================
describe('metrics', () => {
  test('cumulative 3Y/5Y/10Y total returns are derived from the official annualized tenors; unpublished tenors stay null', () => {
    const returns = returnsFromCatalog(vflo);
    expect([returns.monthEnd.ytd, returns.metrics.cagr3y, returns.metrics.tr5y, returns.metrics.ytd, returns.metrics.tr1y]).toEqual([41.85, 29.99, null, 41.85, 51]);
    expect(returns.metrics.tr3y).toBeCloseTo(((1 + 0.2999) ** 3 - 1) * 100, 2);
  });

  test('returnsBasis and performanceAsOf end the metrics with one fixed key set; performanceAsOf is the table date, never the NAV date', () => {
    const { metrics } = returnsFromCatalog(vflo);
    expect(Object.keys(metrics)).toEqual(['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'dividendYieldText', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf']);
    expect([metrics.returnsBasis, metrics.performanceAsOf]).toEqual([RETURNS_BASIS, '2026-08-31']);
    expect(String(metrics.returnsBasis)).not.toMatch(/^-?$|<TICKER>/);
    expect([undefined, ''].map((value) => returnsFromCatalog({ ...vflo, monthly_performance_as_of_date: value }).metrics.performanceAsOf)).toEqual([null, null]);
    expect([performanceDateIso('Aug 31 2026'), performanceDateIso('08/31/2026'), performanceDateIso('')]).toEqual(['2026-08-31', '2026-08-31', null]);
    const row = { ticker: 'VFLO', name: 'x', category: 'y', returns: { monthEnd: { asOfDate: 'Aug 31 2026', yr1: 5 }, quarterEnd: { asOfDate: 'Jun 30 2026' } }, metrics: {} };
    expect(returnsFromCatalog(cachedFundFromIndex(row)).metrics.performanceAsOf).toBe('2026-08-31');
    expect(returnsFromCatalog(cachedFundFromIndex({ ...row, returns: { monthEnd: { asOfDate: '' }, quarterEnd: { asOfDate: '' } } })).metrics.performanceAsOf).toBeNull();
  });

  test('horizons longer than the fund age and since-inception under one year are null, never a placeholder', () => {
    const young = { ...vflo, inception_date: '01/15/2026', monthly_performance_as_of_date: '08/31/2026', performance: { monthly: { ytd_nav: '4', oneyear_nav: '9', threeyear_nav: '8', fiveyear_nav: '7', tenyear_nav: '6', since_inception_nav: '12' }, quarterly: {} } };
    expect(returnsFromCatalog(young).metrics).toMatchObject({ ytd: 4, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, siAnn: null });
    expect(returnsFromCatalog({ ...young, inception_date: '08/01/2024' }).metrics).toMatchObject({ tr1y: 9, tr3y: null, siAnn: 12 });
    expect([fundAgeAtLeast('2024-08-31', '2026-08-31', 2), fundAgeAtLeast('2024-09-01', '2026-08-31', 2), fundAgeAtLeast(null, '2026-08-31', 10)]).toEqual([true, false, true]);
    const { metrics } = returnsFromCatalog({ ...vflo, inception_date: '09/22/2026', monthly_performance_as_of_date: undefined, performance: undefined } as never);
    expect(metrics.performanceAsOf).toBeNull();
    expect(Object.entries(metrics).filter(([key, value]) => key !== 'returnsBasis' && value !== null)).toEqual([]);
  });

  test('index rows: no meta gives dataFile null with every metrics key, with meta the published values travel along as strings', () => {
    const row = indexRow(vflo, null);
    expect([row.dataFile, row.terGrossValue]).toEqual([null, 0.44]);
    expect(Object.keys(row.metrics as object)).toEqual(Object.keys(returnsFromCatalog(vflo).metrics));
    const withMeta = indexRow(vflo, { nav: { value: 51.6 }, aum: { value: 1 }, yields: { dividendYield: 2.5, secYield: 1.2 }, distributions: { frequency: 'Monthly', latestAmount: 0.125537 }, holdings: { totalRows: 3 }, history: { totalRows: 9 } });
    expect(withMeta.dataFile).toBe('./funds/VFLO/meta.json');
    expect(withMeta.distributions).toEqual({ frequency: 'Monthly', exDate: null, dividend: '0.125537' });
    expect(withMeta.metrics).toMatchObject({ dividendYield: 2.5, dividendYieldText: '2.50%', secYield: 1.2, secYieldText: '1.20%' });
    expect(withMeta).toMatchObject({ holdings: 3, history: 9 });
  });

  test('frequency placeholder: None for blanks, Unknown preserved, known cadences coded', () => {
    for (const missing of [null, undefined, '', '  ', '-', '—']) expect(formatFrequencyPlaceholder(missing)).toBe('00 - None');
    expect(['none', 'unknown', 'Monthly'].map(formatFrequencyPlaceholder)).toEqual(['00 - None', '00 - Unknown', '01 - Monthly']);
  });
});

// ===========================================================================
// Pipeline: the whole run against an in-memory provider and a per-test temp api directory
// ===========================================================================
type World = {
  tickers: string[]; navOf: Record<string, string>; failYahoo: Set<string>; failAll: boolean; yields: Record<string, unknown> | null;
  historyDays: number; chartUrls: string[]; inflight: number; peak: number; holdingsPages: number; sectionMissing: Set<string>; end: number;
};
const DAY = 86400;
const newWorld = (tickers: string[] = ['AAA', 'BBB', 'CCC', 'DDD']): World => ({
  tickers, navOf: {}, failYahoo: new Set(), failAll: false, yields: null, historyDays: 800, chartUrls: [], inflight: 0, peak: 0, holdingsPages: 1, sectionMissing: new Set(),
  end: Math.floor(Date.now() / 1000 / DAY) * DAY + 14 * 3600,
});
const catalogRow = (ticker: string, nav: string) => ({
  ticker, entity_long_name: `VictoryShares ${ticker} ETF`, asset_class: 'US Equity', latest_nav: nav, market_close: nav, net_assets: '1000000000',
  gross_exp_ratio: '0.44', net_expense_ratio: '0.39', inception_date: '06/21/2018', nav_as_of: '10/01/2026', monthly_performance_as_of_date: '08/31/2026',
  premium_discount_percentage: '0.01',
  performance: { monthly: { ytd_nav: '10', oneyear_nav: '12', threeyear_nav: '8', fiveyear_nav: '7', tenyear_nav: null, since_inception_nav: '9' }, quarterly: {} },
});
function yahooPayload(world: World, period1: number): unknown {
  const stamps = Array.from({ length: world.historyDays }, (_, i) => world.end - (world.historyDays - 1 - i) * DAY).filter((stamp) => stamp >= period1);
  return { chart: { result: [{ timestamp: stamps, indicators: { quote: [{ close: stamps.map((_, i) => 20 + i / 100) }], adjclose: [{ adjclose: stamps.map((_, i) => 20 + i / 100) }] }, events: {} }] } };
}
function installWorld(world: World): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    world.inflight++; world.peak = Math.max(world.peak, world.inflight);
    try {
      await new Promise((resolve) => realSetTimeout(resolve, 3));
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (url.includes('victoryshares-etfs-list')) return new Response('<input id="etfListEndpoint" value="https://investorapi.vcm.com/search/products/ETF"/><input id="etfListApiKey" value="k"/>');
      if (url.endsWith('/search/products/ETF')) return json(world.tickers.map((ticker) => catalogRow(ticker, world.navOf[ticker] ?? '25.00')));
      const product = /search\/product\/(\w+)\/(\w+)/.exec(url);
      if (product) {
        if (world.failAll) return new Response('down', { status: 500 });
        const [, ticker, endpoint] = product;
        if (world.sectionMissing.has(`${ticker}/${endpoint}`)) return new Response('{"errorDesc":"Section data not found"}', { status: 404 });
        if (endpoint === 'AllHoldings') return json(Array.from({ length: 3 * world.holdingsPages }, (_, i) => ({ holding_name: `${ticker} H${i}`, stock_symbol: `H${i} US`, isin: `US000${i}`, security_type: 'COMMON STOCK', market_value: '100', portfolio_percentage: '1.5', shares: '10', as_of_date: '10/02/2026' })));
        if (endpoint === 'Distributions') return json({ as_of_date: '10/01/2026', distributions: ['07/10/2026', '08/10/2026', '09/10/2026'].map((date) => ({ declared_date: date, record_date: date, payable_date: date, income_amt: '0.1', long_term_capital_gains: '0', short_term_capital_gains: '0', total_distribution: '0', return_of_capital: '0' })) });
        if (endpoint === 'Yields') return json(world.yields ?? { as_of_date: '08/31/2026', thirtyday_sec_yield: '1.2', dividend_yield_percentage: '2.5' });
        if (endpoint === 'Overview') return json({ latest_nav: world.navOf[ticker] ?? '25.00', as_of: '10/01/2026', net_assets: '1000000000', nav_change: '0.1' });
        return json({ data: [{ effectiveDate: '09/25/2026', premiumDiscountPercentage: '0.05' }] });
      }
      const chart = /chart\/(\w+)\?(.*)/.exec(url);
      if (chart) {
        world.chartUrls.push(url);
        if (world.failYahoo.has(chart[1]) || world.failAll) return new Response('nope', { status: 500 });
        return json(yahooPayload(world, Number(new URLSearchParams(chart[2]).get('period1'))));
      }
      return new Response('not found', { status: 404 });
    } finally { world.inflight--; }
  }) as unknown as typeof fetch;
}
const readTree = (dir: string, base = dir): Record<string, string> => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? Object.entries(readTree(path, base)) : [[path.slice(base.length), readFileSync(path, 'utf8')]];
}));
const indexOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const metaOf = (dir: string, ticker: string) => JSON.parse(readFileSync(join(dir, 'funds', ticker, 'meta.json'), 'utf8'));
const controlsFor = (overrides: Record<string, string> = {}) => resolveControls(configFile(), {}, {}, { REQUEST_SLEEP: '0', MAX_RETRIES: '1', EDGAR_FALLBACK: 'false', ...overrides });
const rowOf = (dir: string, ticker: string) => indexOf(dir).funds.find((row: { ticker: string }) => row.ticker === ticker);

describe('pipeline', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'victoryshares-'));
    tempDirs.push(dir);
    useApiRoot(new URL(`file://${dir}/`));
    httpSettings.backoffMs = 1;
    console.log = console.warn = console.error = () => {};
  });

  test('published rows: ytd, TER net and gross, string dividend, one metrics key set, dataFile, daily history through the last bar', async () => {
    const world = newWorld(['AAA', 'BBB']); installWorld(world);
    await runUpdate(controlsFor());
    const [row, other] = indexOf(dir).funds;
    expect(row.metrics.ytd).toBe(10);
    expect(row).toMatchObject({ terValue: 0.39, terGrossValue: 0.44, dataFile: './funds/AAA/meta.json' });
    expect(row.distributions).toEqual({ frequency: 'Monthly', exDate: null, dividend: '0.1' });
    expect(Object.keys(other.metrics)).toEqual(Object.keys(row.metrics));
    const meta = metaOf(dir, 'AAA');
    expect(meta.expenseRatio).toMatchObject({ value: 0.39, net: 0.39, gross: 0.44 });
    expect(meta.history.totalRows).toBe(800);
    const last = JSON.parse(readFileSync(join(dir, 'funds/AAA', meta.history.pages.at(-1)), 'utf8')).rows.at(-1);
    expect([last.Date, last['Premium/Discount']]).toEqual([new Date(world.end * 1000).toISOString().slice(0, 10), '']);
  });

  test('a one-ticker run keeps every other fund row and file', async () => {
    const world = newWorld(); installWorld(world);
    await runUpdate(controlsFor());
    const full = indexOf(dir);
    expect(full.funds.map((row: { ticker: string }) => row.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    const before = readTree(dir);
    world.navOf.BBB = '26.00';
    expect((await runUpdate(controlsFor({ TICKERS: 'BBB' }))).completed).toBe(1);
    const after = indexOf(dir);
    expect(after.funds).toHaveLength(4);
    expect(rowOf(dir, 'BBB').navValue).toBe(26);
    for (const ticker of ['AAA', 'CCC', 'DDD']) expect(rowOf(dir, ticker)).toEqual(full.funds.find((row: { ticker: string }) => row.ticker === ticker));
    const now = readTree(dir);
    for (const path of Object.keys(before)) if (!path.includes('/BBB/') && path !== '/index.json') expect(now[path]).toBe(before[path]);
    expect(existsSync(join(dir, 'update-state.json'))).toBe(false);
  });

  test('a second identical run writes nothing (content and modification times) and keeps generatedAt', async () => {
    const world = newWorld(); installWorld(world);
    await runUpdate(controlsFor());
    const first = indexOf(dir);
    expect(first.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const old = new Date('2001-01-01T00:00:00Z');
    const paths = Object.keys(readTree(dir));
    for (const path of paths) utimesSync(join(dir, path), old, old);
    const before = readTree(dir);
    const summary = await runUpdate(controlsFor());
    expect([summary.updated, summary.indexChanged]).toEqual([0, false]);
    expect(readTree(dir)).toEqual(before);
    for (const path of paths) expect(statSync(join(dir, path)).mtime.getTime()).toBe(old.getTime());
    expect(indexOf(dir).generatedAt).toBe(first.generatedAt);
    expect(readdirSync(join(dir, 'funds', 'AAA')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a failed required source keeps the whole fund as published, other funds update', async () => {
    const world = newWorld(['AAA', 'BBB']); installWorld(world);
    await runUpdate(controlsFor());
    const before = readTree(dir);
    const rowsBefore = indexOf(dir).funds;
    world.navOf = { AAA: '30.00', BBB: '31.00' };
    world.failYahoo.add('AAA');
    expect(await runUpdate(controlsFor())).toMatchObject({ failures: 1, updated: 1 });
    const after = readTree(dir);
    for (const path of Object.keys(before)) if (path.includes('/AAA/')) expect(after[path]).toBe(before[path]);
    expect(rowOf(dir, 'AAA')).toEqual(rowsBefore.find((row: { ticker: string }) => row.ticker === 'AAA'));
    expect(rowOf(dir, 'BBB').navValue).toBe(31);
  });

  test('an honest null from the source is published as null, not replaced by the previous value', async () => {
    const world = newWorld(['AAA']); installWorld(world);
    await runUpdate(controlsFor());
    expect(indexOf(dir).funds[0].metrics).toMatchObject({ secYield: 1.2, dividendYield: 2.5 });
    world.yields = { as_of_date: '09/30/2026', thirtyday_sec_yield: null, dividend_yield_percentage: null };
    await runUpdate(controlsFor());
    const metrics = indexOf(dir).funds[0].metrics;
    expect([metrics.secYield, metrics.secYieldText]).toEqual([null, null]);
    // the declared yield is gone (honest null); the value is re-derived from the fresh distributions, never copied from the old file
    expect(metrics.dividendYield).toBe(4.8);
  });

  test('a new fund is announced and a vanished one dropped, a truncated catalog drops nothing, an unprocessed new fund has dataFile null', async () => {
    const world = newWorld(['AAA', 'BBB', 'CCC', 'DDD']); installWorld(world);
    await runUpdate(controlsFor());
    world.tickers = ['AAA', 'BBB', 'CCC', 'EEE'];
    const summary = await runUpdate(controlsFor({ TICKERS: 'EEE' }));
    expect([summary.newFunds, summary.droppedFunds]).toEqual([['EEE'], ['DDD']]);
    expect(indexOf(dir).funds.map((row: { ticker: string }) => row.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'EEE']);
    expect([existsSync(join(dir, 'funds/DDD')), existsSync(join(dir, 'funds/EEE/meta.json'))]).toEqual([false, true]);
    world.tickers = ['AAA'];
    expect((await runUpdate(controlsFor({ TICKERS: 'AAA' }))).droppedFunds).toEqual([]);
    expect(indexOf(dir).funds).toHaveLength(4);
    world.tickers = ['AAA', 'ZZZ'];
    await runUpdate(controlsFor({ TICKERS: 'AAA' }));
    const zzz = rowOf(dir, 'ZZZ');
    expect(zzz.dataFile).toBeNull();
    expect(Object.keys(zzz.metrics)).toEqual(Object.keys(rowOf(dir, 'AAA').metrics));
    expect(zzz.metrics.returnsBasis.length).toBeGreaterThan(10);
  });

  test('MAX_FETCHES walks the eligible funds with a persisted cursor and wraps, TICKERS runs leave it alone', async () => {
    const world = newWorld(['AAA', 'BBB', 'CCC', 'DDD']); installWorld(world);
    const cursor = () => JSON.parse(readFileSync(join(dir, 'update-state.json'), 'utf8')).lastProcessedTicker;
    await runUpdate(controlsFor({ MAX_FETCHES: '2' }));
    expect(['AAA', 'BBB', 'CCC'].map((t) => existsSync(join(dir, `funds/${t}/meta.json`)))).toEqual([true, true, false]);
    expect(cursor()).toBe('BBB');
    await runUpdate(controlsFor({ MAX_FETCHES: '2' }));
    expect(cursor()).toBe('DDD');
    await runUpdate(controlsFor({ TICKERS: 'AAA', MAX_FETCHES: '1' }));
    expect(cursor()).toBe('DDD');
    await runUpdate(controlsFor({ MAX_FETCHES: '2' }));
    expect(cursor()).toBe('BBB');
    expect(indexOf(dir).funds).toHaveLength(4);
  });

  test('the soft deadline stops taking new funds and still writes the index with every row', async () => {
    const world = newWorld(); installWorld(world);
    await runUpdate(controlsFor({ TICKERS: 'AAA' }));
    expect(await runUpdate(controlsFor(), { deadlineMs: -1 })).toMatchObject({ completed: 0, skipped: 4 });
    expect(indexOf(dir).funds).toHaveLength(4);
    expect([rowOf(dir, 'AAA').dataFile, rowOf(dir, 'BBB').dataFile]).toEqual(['./funds/AAA/meta.json', null]);
  });

  test('a brand-new fund whose Distributions section does not exist yet is published, a later missing Overview keeps the fund', async () => {
    const world = newWorld(['AAA', 'BBB']); installWorld(world);
    world.sectionMissing.add('AAA/Distributions');
    expect(await runUpdate(controlsFor())).toMatchObject({ completed: 2, failures: 0 });
    expect(rowOf(dir, 'AAA')).toMatchObject({ dataFile: './funds/AAA/meta.json', distributions: { frequency: null, exDate: null, dividend: null } });
    const bbb = rowOf(dir, 'BBB');
    world.sectionMissing.add('BBB/Overview');
    world.navOf.BBB = '40.00';
    expect(await runUpdate(controlsFor())).toMatchObject({ completed: 2, failures: 1 });
    expect(rowOf(dir, 'BBB')).toEqual(bbb);
    expect([isSectionMissing(Object.assign(new Error('x'), { status: 404, body: '{"errorDesc":"Section data not found"}' })), isSectionMissing(Object.assign(new Error('x'), { status: 404, body: 'Not Found' })), isSectionMissing(new Error('x'))]).toEqual([true, false, false]);
  });

  test('exit code is non-zero only when every selected fund failed', async () => {
    const world = newWorld(['AAA', 'BBB']); installWorld(world);
    world.failAll = true;
    const env = { REQUEST_SLEEP: '0', MAX_RETRIES: '1', EDGAR_FALLBACK: 'false', USE_SYSTEM_CA: 'false' };
    await main(env, ['bun', 'update-data.ts']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    world.failAll = false;
    await main(env, ['bun', 'update-data.ts']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(indexOf(dir).funds).toHaveLength(2);
  });

  test('an unknown ticker or a ticker excluded by a filter is an error before any write', async () => {
    const world = newWorld(['AAA']); installWorld(world);
    await expect(runUpdate(controlsFor({ TICKERS: 'NOPE' }))).rejects.toThrow('not in VCM catalog');
    await expect(runUpdate(controlsFor({ TICKERS: 'AAA', AUM: '2B:' }))).rejects.toThrow('excluded by configured filters');
    expect(existsSync(join(dir, 'index.json'))).toBe(false);
  });

  test('stale pages are removed after the new meta; a failed meta write leaves them in place', async () => {
    const world = newWorld(['AAA']); installWorld(world);
    await runUpdate(controlsFor({ HISTORY_PAGE_SIZE: '300' }));
    expect(readdirSync(join(dir, 'funds/AAA/history')).sort()).toEqual(['001.json', '002.json', '003.json']);
    await runUpdate(controlsFor({ HISTORY_PAGE_SIZE: '1000' }));
    expect(readdirSync(join(dir, 'funds/AAA/history')).sort()).toEqual(['001.json']);
    expect(metaOf(dir, 'AAA').history.pages).toEqual(['history/001.json']);
    // meta.json cannot be replaced (a directory sits there): pages are written, stale pages must survive
    rmSync(join(dir, 'funds/AAA/meta.json'));
    mkdirSync(join(dir, 'funds/AAA/meta.json/keep'), { recursive: true });
    expect((await runUpdate(controlsFor({ HISTORY_PAGE_SIZE: '300' }))).failures).toBe(1);
    expect(readdirSync(join(dir, 'funds/AAA/history')).sort()).toEqual(['001.json', '002.json', '003.json']);
    expect(readdirSync(join(dir, 'funds/AAA')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('N-PORT fallback: the series must match and the report must be newer than the published holdings', () => {
    const xml = '<genInfo><seriesId>S000073699</seriesId><repPdDate>2026-07-31</repPdDate></genInfo>';
    expect(parseNportIdentity(xml)).toEqual({ seriesId: 'S000073699', repPdDate: '2026-07-31' });
    expect(parseNportIdentity('<x/>')).toEqual({ seriesId: null, repPdDate: null });
    const id = parseNportIdentity(xml);
    expect([
      nportIsUsable(id, 'S000073699', null), nportIsUsable(id, 's000073699', '2026-06-30'), nportIsUsable(id, 'S000073699', '2026-07-31'),
      nportIsUsable(id, 'S000073699', '2026-09-30'), nportIsUsable(id, 'S000099999', null), nportIsUsable({ seriesId: null, repPdDate: null }, 'S000073699', null),
    ]).toEqual([true, true, false, false, false, false]);
  });
});

// ===========================================================================
describe('network', () => {
  beforeEach(() => { httpSettings.timeoutMs = 40; httpSettings.backoffMs = 1; configureLanes(1, 0); });

  test('lane slots are reserved synchronously: one lane spaces callers by REQUEST_SLEEP, two lanes let two start together', async () => {
    const clock = fakeClock();
    configureLanes(1, 0.05);
    await Promise.all([0, 1, 2, 3].map(() => paceRequest()));
    expect(clock.waits).toEqual([50, 50, 50]);
    clock.waits.length = 0;
    configureLanes(2, 0.08);
    await Promise.all([0, 1, 2].map(() => paceRequest()));
    expect(clock.waits).toEqual([80]);
  });

  test('the timeout covers a body that never finishes and every attempt is retried', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(new ReadableStream({ start() { /* never ends */ } })); }) as unknown as typeof fetch;
    await expect(getText('https://x.test/a', 'label', {}, readConfig({ MAX_RETRIES: '2' }))).rejects.toThrow('timed out after 40 ms');
    expect(calls).toBe(3);
  });

  test('a hanging request times out too, 404 is not retried, 503 is, retries are bounded', async () => {
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    await expect(getText('https://x.test/a', 'label', {}, readConfig({ MAX_RETRIES: '1' }))).rejects.toThrow('timed out');
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('no', { status: 404 }); }) as unknown as typeof fetch;
    await expect(getText('https://x.test/a', 'label', {}, readConfig({ MAX_RETRIES: '3' }))).rejects.toThrow('HTTP 404');
    expect(calls).toBe(1);
    calls = 0;
    globalThis.fetch = (async () => (++calls < 3 ? new Response('busy', { status: 503 }) : new Response('ok'))) as unknown as typeof fetch;
    expect(await getText('https://x.test/a', 'label', {}, readConfig({ MAX_RETRIES: '3' }))).toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('busy', { status: 503 }); }) as unknown as typeof fetch;
    await expect(getText('https://x.test/a', 'label', {}, readConfig({ MAX_RETRIES: '2' }))).rejects.toThrow('HTTP 503');
    expect(calls).toBe(3);
  });

  test('in-flight requests peak at 1 with CONCURRENCY=1 and at N with CONCURRENCY=N', async () => {
    const run = async (concurrency: string): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), 'victoryshares-peak-'));
      tempDirs.push(dir);
      useApiRoot(new URL(`file://${dir}/`));
      const world = newWorld(); installWorld(world);
      console.log = console.warn = console.error = () => {};
      await runUpdate(controlsFor({ CONCURRENCY: concurrency }));
      return world.peak;
    };
    expect(await run('1')).toBe(1);
    expect(await run('3')).toBe(3);
  });

  test('HISTORY_RANGE changes the real request (explicit period1/period2 and daily bars) and the published rows', async () => {
    const now = 1_790_000_000;
    const max = new URL(yahooChartUrl('VFLO', 'max', now));
    expect([max.searchParams.get('period1'), max.searchParams.get('period2'), max.searchParams.get('interval'), max.searchParams.has('range')]).toEqual(['0', String(now + 86400), '1d', false]);
    const five = new URL(yahooChartUrl('VFLO', '5y', now));
    expect(Math.round((now - Number(five.searchParams.get('period1'))) / (365.25 * 86400))).toBe(5);
    expect(five.searchParams.has('range')).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'victoryshares-range-'));
    tempDirs.push(dir);
    useApiRoot(new URL(`file://${dir}/`));
    const world = newWorld(['AAA']); installWorld(world);
    console.log = console.warn = console.error = () => {};
    await runUpdate(controlsFor());
    const maxUrl = new URL(world.chartUrls.at(-1) as string);
    expect([maxUrl.searchParams.get('period1'), maxUrl.searchParams.get('interval'), metaOf(dir, 'AAA').history.totalRows]).toEqual(['0', '1d', 800]);
    await runUpdate(controlsFor({ HISTORY_RANGE: '1y' }));
    const oneYear = new URL(world.chartUrls.at(-1) as string);
    expect(Math.round((Date.now() / 1000 - Number(oneYear.searchParams.get('period1'))) / (365.25 * DAY))).toBe(1);
    const rows = metaOf(dir, 'AAA').history.totalRows;
    expect(rows).toBeGreaterThan(360);
    expect(rows).toBeLessThan(370);
  });
});
