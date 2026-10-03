/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPages, configureLanes, isSectionMissing, fundAgeAtLeast, fundPasses, getText, httpSettings, indexRow, main, nportIsUsable, paceRequest,
  parseHistoryRange, parseNportIdentity, rotateSelection, runUpdate, useApiRoot, yahooChartUrl, formatFrequencyPlaceholder, inferFrequency, parseAumRange, parseAtomFilings, parseCatalog,
  parseDistributionPayload, parseFundTickerRefs, parseHoldings, parseIssuerClientConfig, parseNportHoldings,
  pageBasenames, parsePremiumDiscount, parseRange, parseYahooChart, historyRows, returnsFromCatalog,
  CONTROL_NAMES, RETURNS_BASIS, cachedFundFromIndex, performanceDateIso, installSystemCa, isCertError, readConfig, resolveControls, runtimeControls,
} from './update-data';

const catalogFixture = [{
  ticker: 'VFLO', entity_long_name: 'VictoryShares Free Cash Flow ETF', asset_class: 'US Equity',
  latest_nav: '51.59', market_close: '51.60', net_assets: '10993961469', gross_exp_ratio: '0.44', net_expense_ratio: '0.39',
  inception_date: '06/21/2023', nav_as_of: '09/25/2026', monthly_performance_as_of_date: '08/31/2026', premium_discount_percentage: '-0.0043',
  performance: { monthly: { as_of: '08/31/2026', ytd_nav: '41.85', oneyear_nav: '51.00', threeyear_nav: '29.99', fiveyear_nav: null, tenyear_nav: null, since_inception_nav: '30.11' }, quarterly: {} },
}];

describe('VictoryShares source parsers', () => {
  test('reads public catalog rows and preserves NAV, AUM, TER and performance source fields', () => {
    const [fund] = parseCatalog(catalogFixture);
    expect(fund).toMatchObject({ ticker: 'VFLO', name: 'VictoryShares Free Cash Flow ETF', category: 'US Equity', navValue: 51.59, aumValue: 10993961469, terValue: 0.39, terGrossValue: 0.44 });
    expect(fund.performance).toEqual(catalogFixture[0].performance);
    expect(parseCatalog({ error: 'not a fund list' })).toEqual([]);
  });

  test('maps SEC ETF symbols to registrant/series IDs and keeps the newest Atom N-PORT-P entries', () => {
    const refs = parseFundTickerRefs({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [['1547580', 'S000073699', 'C000230775', 'VFLO']] });
    expect(refs.get('VFLO')).toEqual({ cik: '0001547580', seriesId: 'S000073699' });
    expect(parseFundTickerRefs({ fields: [], data: [] }).size).toBe(0);
    const filings = parseAtomFilings('<entry><filing-type>NPORT-P</filing-type><accession-number>0001004726-26-007544</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1547580/000100472626007544/</filing-href></entry><entry><filing-type>OTHER</filing-type><accession-number>0000000000-26-000001</accession-number></entry>');
    expect(filings).toEqual([{ cik: '1547580', accession: '0001004726-26-007544' }]);
  });

  test('validates the dynamic issuer client config without assuming a fixed key', () => {
    const parsed = parseIssuerClientConfig('<input id="etfListEndpoint" value="https://investorapi.vcm.com/search/products/ETF"><input id="etfListApiKey" value="public-client-key">');
    expect(parsed.endpoint).toBe('https://investorapi.vcm.com/search/products/ETF');
    expect(parsed.apiKey).toBe('public-client-key');
    expect(() => parseIssuerClientConfig('<html></html>')).toThrow('did not expose');
    expect(() => parseIssuerClientConfig('<input id="etfListEndpoint" value="https://other.example/x"><input id="etfListApiKey" value="x">')).toThrow('Unexpected issuer catalog API host');
  });

  test('derives cumulative total returns from official annualized return tenors', () => {
    const [fund] = parseCatalog(catalogFixture);
    const returns = returnsFromCatalog(fund);
    expect(returns.monthEnd.ytd).toBe(41.85);
    expect(returns.metrics.cagr3y).toBe(29.99);
    expect(returns.metrics.tr3y).toBeCloseTo(((1 + 0.2999) ** 3 - 1) * 100, 2);
    expect(returns.metrics.tr5y).toBeNull();
  });

  test('adds returnsBasis and performanceAsOf (performance table date, not the NAV date) at the end of metrics', () => {
    const [fund] = parseCatalog(catalogFixture);
    const { metrics } = returnsFromCatalog(fund);
    expect(Object.keys(metrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    expect(metrics.returnsBasis).toBe(RETURNS_BASIS);
    expect(String(metrics.returnsBasis)).not.toMatch(/^-?$|<TICKER>/);
    expect(metrics.performanceAsOf).toBe('2026-08-31');
    expect(returnsFromCatalog({ ...fund, monthly_performance_as_of_date: undefined }).metrics.performanceAsOf).toBeNull();
    expect(returnsFromCatalog({ ...fund, monthly_performance_as_of_date: '' }).metrics.performanceAsOf).toBeNull();
  });

  test('derives performanceAsOf offline from a published index row (display date -> ISO)', () => {
    expect(performanceDateIso('Aug 31 2026')).toBe('2026-08-31');
    expect(performanceDateIso('08/31/2026')).toBe('2026-08-31');
    expect(performanceDateIso('')).toBeNull();
    const row = { ticker: 'VFLO', name: 'x', category: 'y', returns: { monthEnd: { asOfDate: 'Aug 31 2026', yr1: 5 }, quarterEnd: { asOfDate: 'Jun 30 2026' } }, metrics: {} };
    expect(returnsFromCatalog(cachedFundFromIndex(row)).metrics.performanceAsOf).toBe('2026-08-31');
    const none = { ...row, returns: { monthEnd: { asOfDate: '' }, quarterEnd: { asOfDate: '' } } };
    expect(returnsFromCatalog(cachedFundFromIndex(none)).metrics.performanceAsOf).toBeNull();
  });

  test('paginates deterministic row sets without empty trailing pages', () => {
    expect(buildPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(buildPages([], 3)).toEqual([]);
    expect(pageBasenames(['holdings/001.json', 'holdings/002.json'])).toEqual(new Set(['001.json', '002.json']));
    expect(() => buildPages([1], 0)).toThrow('positive integer');
  });

  test('maps source holdings to shared Watchlist columns and supports fixed-income rows', () => {
    const parsed = parseHoldings([
      { holding_name: 'US TREASURY NOTE', stock_symbol: null, isin: 'US91282CFX12', security_type: 'TREASURY NOTE', market_value: '12500.5', portfolio_percentage: '2.5', shares: '12000', coupon_rate: '4.125', maturity_date: '2030-05-15', as_of_date: '09/28/2026' },
      { holding_name: 'BORGWARNER INC.', stock_symbol: 'BWA US', isin: 'US0997241064', security_type: 'COMMON STOCK', market_value: '9000', portfolio_percentage: '1.8', shares: '80', as_of_date: '09/28/2026' },
    ]);
    expect(parsed.headers).toContain('Identifier');
    expect(parsed.asOfDate).toBe('2026-09-28');
    expect(parsed.rows.find(row => row.Name === 'BORGWARNER INC.')).toMatchObject({ Ticker: 'BWA', Identifier: 'US0997241064' });
    expect(parsed.rows.find(row => row.Name === 'US TREASURY NOTE')).toMatchObject({ Ticker: '-', Coupon: '4.125', Maturity: '2030-05-15' });
  });

  test('keeps the official distribution columns and infers cadence from dated rows', () => {
    const parsed = parseDistributionPayload({ as_of_date: '07/10/2023', distributions: [
      { declared_date: '01/08/2026', record_date: '01/07/2026', payable_date: '01/09/2026', income_amt: '0.1', long_term_capital_gains: '0', short_term_capital_gains: '0', total_distribution: '0', return_of_capital: '0' },
      { declared_date: '02/08/2026', record_date: '02/07/2026', payable_date: '02/09/2026', income_amt: '0.2', long_term_capital_gains: '0', short_term_capital_gains: '0', total_distribution: '0', return_of_capital: '0' },
      { declared_date: '03/09/2026', record_date: '03/08/2026', payable_date: '03/10/2026', income_amt: '0.3', long_term_capital_gains: '0', short_term_capital_gains: '0', total_distribution: '0', return_of_capital: '0' },
    ] });
    expect(parsed.frequency).toBe('Monthly');
    expect(parsed.latest).toBeCloseTo(0.3);
    expect(parsed.rows.at(-1)?.[0]).toBe('03/09/2026');
    expect(parsed.headers).toEqual(['Declared Date', 'Record Date', 'Payable Date', 'Income Amount', 'Long-Term Capital Gains', 'Short-Term Capital Gains', 'Total Distribution', 'Return of Capital']);
    expect(inferFrequency([])).toBeNull();
  });

  test('parses Yahoo history, rounds adjusted close to cents, and merges issuer premium/discount by date', () => {
    const days = parseYahooChart({ chart: { result: [{
      timestamp: [1780000000, 1780086400],
      indicators: { quote: [{ close: [51.596, 52] }], adjclose: [{ adjclose: [51.594, 51.991] }] },
      events: { dividends: { '1780086400': { amount: 0.12 } } },
    }] } });
    expect(days).toHaveLength(2);
    expect(days.map(day => day.adjClose)).toEqual([51.59, 51.99]);
    expect(days[1].dividend).toBe(0.12);
    const premium = parsePremiumDiscount({ data: [{ effectiveDate: '05/30/2026', premiumDiscountPercentage: '-0.0254' }] });
    const rows = historyRows(days, premium);
    expect(rows[0]['NAV']).toBe('');
    expect(rows[0]['Market Price']).toBe('51.60');
    expect(rows[0]['Adj Close']).toBe('51.59');
    expect(parsePremiumDiscount(null).size).toBe(0);
  });

  test('parses SEC N-PORT fallback positions without inventing exchange tickers', () => {
    const rows = parseNportHoldings('<invstOrSec><name>US Treasury Note</name><cusip>91282CFX1</cusip><pctVal>1.20</pctVal><valUSD>1250000</valUSD><balance>1200000</balance><assetCat>DBT</assetCat></invstOrSec>');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Name: 'US Treasury Note', Ticker: '-', Identifier: '91282CFX1', Weight: '1.20', 'Market Value': '1250000' });
  });
});

describe('configuration and display normalization', () => {
  test('supports inclusive ranges, K/M/B/T AUM bounds and presets', () => {
    expect(parseRange('0.2:2').min).toBe(0.2);
    expect(parseAumRange('10M:2B')).toMatchObject({ min: 10000000, max: 2000000000 });
    expect(parseAumRange('small')).toMatchObject({ min: 300000000, max: 2000000000 });
    expect(() => parseRange('1')).toThrow('colon required');
    expect(() => parseRange('5:1')).toThrow('exceeds');
  });

  test('uses the requested None presentation placeholder and preserves Unknown', () => {
    for (const missing of [null, undefined, '', '  ', '-', '—']) expect(formatFrequencyPlaceholder(missing)).toBe('00 - None');
    expect(formatFrequencyPlaceholder('none')).toBe('00 - None');
    expect(formatFrequencyPlaceholder('unknown')).toBe('00 - Unknown');
    expect(formatFrequencyPlaceholder('Monthly')).toBe('01 - Monthly');
  });
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = () => JSON.parse(read('scripts/update-data.config.json'));

describe('control resolver', () => {
  test('precedence: file < advanced < nonblank input < env, explicit empty env clears', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'VFLO' }, { CONCURRENCY: 3, TICKERS: 'USTB' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('6');
    expect(c.TICKERS).toBe('USTB');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ TICKERS: 'VFLO' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'VFLO' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(readConfig(resolveControls({ HISTORY_RANGE: '5y' })).historyRange).toBe('5y');
  });

  test('rejects unknown keys, non-scalars, bad layers, invalid values and newline injection', () => {
    const bad: unknown[] = [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { HOLDINGS_PAGE_SIZE: 0 }, { HISTORY_PAGE_SIZE: 0 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { EDGAR_FALLBACK: 'x' }, { SKIP_YAHOO: 'x' }, { HISTORY_RANGE: '7d' }, { HISTORY_RANGE: '6mo' }, { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: '100y' }, { HISTORY_RANGE: '5' }, { HISTORY_RANGE: 'abc' }, { AUM: '1:2:3' }, { TER: '5' }, { TER: '5:1' }, { TICKERS: ['VFLO'] }, null, []];
    for (const value of bad) expect(() => resolveControls(value)).toThrow();
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, 'x')).toThrow();
    expect(() => resolveControls({}, {}, { TICKERS: { a: 1 } })).toThrow();
    expect(() => JSON.parse('{bad')).toThrow();
  });

  test('scheduled path (empty inputs and advanced) equals config defaults with VictoryShares values', async () => {
    const file = configFile();
    expect(resolveControls(file, {}, {}, {})).toEqual(file);
    expect(await runtimeControls({})).toEqual(file);
    expect((await runtimeControls({ CONCURRENCY: '3' })).CONCURRENCY).toBe('3');
    const config = readConfig(resolveControls(file));
    expect(config.tickers.size).toBe(0);
    expect(config).toMatchObject({ maxFetches: 0, requestSleep: 1, concurrency: 2, maxRetries: 2, holdingsPageSize: 250, historyPageSize: 1000, historyRange: 'max', edgarFallback: true, skipYahoo: false, secUa: 'daggerok ETF feed daggerok@gmail.com' });
    expect(config.aum.source).toBe(':');
  });

  test('protected SEC_UA wins when set, input wins over advanced', () => {
    const file = configFile();
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
  });
});

describe('config, README, --help and workflow parity', () => {
  test('config keys equal CONTROL_NAMES and every value is a string', () => {
    const file = configFile();
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file)) expect(typeof value).toBe('string');
  });

  test('README controls table and --help list every control', () => {
    const doc = read('README.md');
    const help = read('scripts/update-data.ts');
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
      expect(doc).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
      if (tenor) expect(doc).toContain('`' + tenor[1] + '_YTD`');
      const helpName = /^(PERFORMANCE|TOTAL_RETURN)_/.test(name) ? name.replace(/_(YTD|1Y|3Y|5Y|10Y)$/, '') + '_{YTD,1Y,3Y,5Y,10Y}' : name;
      expect(help).toContain(helpName);
    }
    expect(doc).toContain('scripts/update-data.config.json');
  });

  test('README keeps the standard structure and shared tables', () => {
    const readme = read('README.md');
    const headings = [...readme.matchAll(/^#{2,3} .+$/gm)].map(match => match[0]);
    expect(headings).toEqual([
      '## Using Bun', '## Updating the static VictoryShares data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples',
      '## TypeScript and verification', '## Brands table', '## Sibling applications', '## License',
    ]);
    expect(readme).toContain('bunx degit daggerok/VictoryShares#main ./12345 && cd $_');
    expect(readme).toContain('https://daggerok.github.io/VictoryShares/');
    const brandRows = [...readme.matchAll(/^\| \*\*(.+?)\*\* \|/gm)].map(match => match[1]);
    expect(brandRows.length).toBe(29);
    expect(brandRows.indexOf('WisdomTree')).toBe(brandRows.indexOf('VictoryShares') + 1);
  });

  test('workflow: <= 25 inputs with advanced, fixed api/victoryshares output, protected SEC_UA, hardened', () => {
    const actual = read('.github/workflows/update-data.yml');
    const names = [...actual.slice(actual.indexOf('    inputs:'), actual.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map(m => m[1]);
    expect(names.length).toBeLessThanOrEqual(25);
    expect(names).toContain('advanced');
    for (const name of names.filter(n => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as never);
    expect(actual).toContain("default: '{}'");
    expect(actual).toContain("cron: '0 0 * * 0'");
    expect(actual).toContain('timeout-minutes: 30');
    expect(actual).toContain('persist-credentials: false');
    expect(actual).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
    expect(actual).toContain('resolveControls(file, advanced, individual, protectedVars)');
    expect(actual).toContain('toJSON(inputs)');
    expect(actual).not.toMatch(/\$\{\{\s*inputs\./);
    expect(actual).not.toMatch(/OUTPUT_DIR|output_dir/i);
    expect(actual.match(/git add (\S+)/g)).toEqual(['git add api/victoryshares']);
    expect(actual.match(/api\/[\w-]+/g)!.every(p => p === 'api/victoryshares')).toBe(true);
  });
});

describe('TLS trust store (USE_SYSTEM_CA)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const reexecSpy = () => { const calls: number[] = []; return { calls, reexec: (() => { calls.push(1); throw new Error('reexec'); }) as () => never }; };

  test('resolver accepts auto/true/false case-insensitively, rejects maybe, defaults to auto', () => {
    expect(resolveControls(configFile()).USE_SYSTEM_CA).toBe('auto');
    for (const value of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(resolveControls({}, {}, {}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
    expect(() => resolveControls({}, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow();
  });

  test('isCertError detects codes, messages and nested causes only', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test('installSystemCa honors false/active, restarts for true, wraps fetch for auto', async () => {
    const { calls, reexec } = reexecSpy();
    installSystemCa('false', reexec, false);
    expect(globalThis.fetch).toBe(realFetch);
    installSystemCa('auto', reexec, true);
    expect(globalThis.fetch).toBe(realFetch);
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
    expect(calls.length).toBe(1);

    const ok = new Response('ok');
    globalThis.fetch = (async () => ok) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    expect(await fetch('https://example.test')).toBe(ok);
    expect(calls.length).toBe(1);

    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.test')).rejects.toThrow('ECONNRESET');
    expect(calls.length).toBe(1);

    globalThis.fetch = (async () => { throw Object.assign(new Error('x'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.test')).rejects.toThrow('reexec');
    expect(calls.length).toBe(2);
  });
});

describe('data contract', () => {
  const [vflo] = parseCatalog(catalogFixture);

  test('TER: terValue is the net ratio, terGrossValue the gross one; a single published number is the net/only value', () => {
    expect(vflo).toMatchObject({ terValue: 0.39, terGrossValue: 0.44 });
    const [onlyGross] = parseCatalog([{ ...catalogFixture[0], net_expense_ratio: null }]);
    expect(onlyGross).toMatchObject({ terValue: 0.44, terGrossValue: null });
    const [none] = parseCatalog([{ ...catalogFixture[0], net_expense_ratio: null, gross_exp_ratio: null }]);
    expect(none).toMatchObject({ terValue: null, terGrossValue: null });
    expect(cachedFundFromIndex({ ticker: 'X', name: 'X', terValue: 0.39, terGrossValue: 0.44 })).toMatchObject({ terValue: 0.39, terGrossValue: 0.44 });
  });

  test('metrics carry ytd and keep one fixed key set', () => {
    const { metrics } = returnsFromCatalog(vflo);
    expect(Object.keys(metrics)).toEqual(['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'dividendYieldText', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf']);
    expect(metrics.ytd).toBe(41.85);
    expect(metrics.tr1y).toBe(51);
  });

  test('horizons longer than the fund age and since-inception under one year are null, never a placeholder', () => {
    const young = { ...vflo, inception_date: '01/15/2026', monthly_performance_as_of_date: '08/31/2026', performance: { monthly: { ytd_nav: '4', oneyear_nav: '9', threeyear_nav: '8', fiveyear_nav: '7', tenyear_nav: '6', since_inception_nav: '12' }, quarterly: {} } };
    const { metrics } = returnsFromCatalog(young);
    expect(metrics).toMatchObject({ ytd: 4, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, siAnn: null });
    const twoYears = { ...young, inception_date: '08/01/2024' };
    expect(returnsFromCatalog(twoYears).metrics).toMatchObject({ tr1y: 9, tr3y: null, siAnn: 12 });
    expect(fundAgeAtLeast('2024-08-31', '2026-08-31', 2)).toBe(true);
    expect(fundAgeAtLeast('2024-09-01', '2026-08-31', 2)).toBe(false);
    expect(fundAgeAtLeast(null, '2026-08-31', 10)).toBe(true);
  });

  test('a fund without any return values has performanceAsOf null (VMHY/VMSD, incepted 2026-09-22)', () => {
    const fresh = { ...vflo, inception_date: '09/22/2026', monthly_performance_as_of_date: undefined, performance: undefined };
    const { metrics } = returnsFromCatalog(fresh as never);
    expect(metrics.performanceAsOf).toBeNull();
    expect(Object.entries(metrics).filter(([key, value]) => key !== 'returnsBasis' && value !== null)).toEqual([]);
    expect(String(metrics.returnsBasis).length).toBeGreaterThan(10);
  });

  test('missing holdings weight and market value stay empty instead of the string "0"', () => {
    const parsed = parseHoldings([{ holding_name: 'X', stock_symbol: 'X', security_type: 'COMMON STOCK', as_of_date: '10/02/2026' }]);
    expect(parsed.rows[0].Weight).toBe('');
    expect(parsed.rows[0]['Market Value']).toBe('');
    const nport = parseNportHoldings('<invstOrSec><name>A</name><cusip>1</cusip></invstOrSec>');
    expect(nport[0]).toMatchObject({ Weight: '', 'Market Value': '' });
    expect(parseHoldings([{ holding_name: 'X', portfolio_percentage: '0.00', market_value: '0' }]).rows[0]).toMatchObject({ Weight: '0.00', 'Market Value': '0' });
  });

  test('index rows: no meta -> dataFile null with every metrics key; distributions.dividend is a string', () => {
    const row = indexRow(vflo, null);
    expect(row.dataFile).toBeNull();
    expect(Object.keys(row.metrics as object)).toEqual(Object.keys(returnsFromCatalog(vflo).metrics));
    expect(row.terGrossValue).toBe(0.44);
    const withMeta = indexRow(vflo, { nav: { value: 51.6 }, aum: { value: 1 }, yields: { dividendYield: 2.5, secYield: 1.2 }, distributions: { frequency: 'Monthly', latestAmount: 0.125537 }, holdings: { totalRows: 3 }, history: { totalRows: 9 } });
    expect(withMeta.dataFile).toBe('./funds/VFLO/meta.json');
    expect(withMeta.distributions).toEqual({ frequency: 'Monthly', exDate: null, dividend: '0.125537' });
    expect(withMeta.metrics).toMatchObject({ dividendYield: 2.5, dividendYieldText: '2.50%', secYield: 1.2, secYieldText: '1.20%' });
    expect(withMeta).toMatchObject({ holdings: 3, history: 9 });
  });

  test('return filters exclude funds whose bounded value is null; unbounded filters keep them', () => {
    const fresh = { ...vflo, performance: undefined, monthly_performance_as_of_date: undefined } as never;
    const bounded = (key: string, value: string) => readConfig(resolveControls({}, {}, {}, { [key]: value }));
    expect(fundPasses(fresh, bounded('PERFORMANCE_1Y', '0:'))).toBe(false);
    expect(fundPasses(fresh, bounded('TOTAL_RETURN_YTD', ':50'))).toBe(false);
    expect(fundPasses(fresh, readConfig({}))).toBe(true);
    expect(fundPasses(vflo, bounded('PERFORMANCE_3Y', '20:'))).toBe(true);
    expect(fundPasses(vflo, bounded('PERFORMANCE_3Y', '40:'))).toBe(false);
    expect(fundPasses(vflo, bounded('TER', '0.4:0.5'))).toBe(false);
    expect(fundPasses(vflo, bounded('TER', '0.3:0.4'))).toBe(true);
  });
});

describe('controls', () => {
  test('HISTORY_RANGE is max or Ny, strictly validated', () => {
    expect(parseHistoryRange(undefined)).toBe('max');
    expect(parseHistoryRange('MAX')).toBe('max');
    expect(parseHistoryRange('10y')).toBe('10y');
    for (const bad of ['6mo', '3mo', '0y', '100y', '5', 'y', '1.5y', 'ytd']) expect(() => parseHistoryRange(bad)).toThrow('HISTORY_RANGE');
    expect(() => resolveControls({}, {}, {}, { HISTORY_RANGE: '6mo' })).toThrow('HISTORY_RANGE');
  });

  test('a blank SEC_UA falls back to the standard contact instead of silently skipping EDGAR', () => {
    expect(readConfig({ SEC_UA: '' }).secUa).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(readConfig({ SEC_UA: '   ' }).secUa).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(readConfig({ SEC_UA: 'me me@x.test' }).secUa).toBe('me me@x.test');
  });

  test('MAX_FETCHES window counts only eligible funds, resumes after the cursor and wraps around', () => {
    const funds = ['A', 'B', 'C', 'D', 'E'].map(ticker => ({ ticker }));
    const pick = (cursor: string, n = 2) => rotateSelection(funds, n, cursor).map(fund => fund.ticker);
    expect(pick('')).toEqual(['A', 'B']);
    expect(pick('B')).toEqual(['C', 'D']);
    expect(pick('D')).toEqual(['E', 'A']);
    expect(pick('E')).toEqual(['A', 'B']);
    expect(pick('ZZ')).toEqual(['A', 'B']);
    expect(rotateSelection(funds, 0, 'B')).toEqual(funds);
    expect(rotateSelection(funds, 9, 'B')).toEqual(funds);
    const filtered = funds.filter(fund => fund.ticker !== 'C');
    expect(rotateSelection(filtered, 2, 'B').map(fund => fund.ticker)).toEqual(['D', 'E']);
  });
});

describe('Yahoo request', () => {
  const now = 1_790_000_000;
  test('max asks for explicit daily bars from period1=0 (range=max returns weekly/monthly bars)', () => {
    const url = new URL(yahooChartUrl('VFLO', 'max', now));
    expect(url.searchParams.get('period1')).toBe('0');
    expect(url.searchParams.get('period2')).toBe(String(now + 86400));
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.has('range')).toBe(false);
  });

  test('Ny shrinks the request with an explicit period1', () => {
    const url = new URL(yahooChartUrl('VFLO', '5y', now));
    const period1 = Number(url.searchParams.get('period1'));
    const years = (now - period1) / (365.25 * 86400);
    expect(years).toBeGreaterThan(4.99);
    expect(years).toBeLessThan(5.01);
    expect(url.searchParams.has('range')).toBe(false);
  });
});

describe('dates are UTC, whatever the machine time zone', () => {
  const realTz = process.env.TZ;
  afterEach(() => { if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz; });
  test('same output east and west of UTC', () => {
    const run = () => ({
      perf: performanceDateIso('Jun 04 2026'), display: performanceDateIso('09/05/2026'),
      days: parseYahooChart({ chart: { result: [{ timestamp: [Date.UTC(2026, 8, 25, 23, 30) / 1000], indicators: { quote: [{ close: [10] }] } }] } }).map(day => day.date),
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

describe('N-PORT fallback identity and freshness', () => {
  const xml = '<genInfo><seriesId>S000073699</seriesId><repPdDate>2026-07-31</repPdDate></genInfo>';
  test('parses the series and report date', () => {
    expect(parseNportIdentity(xml)).toEqual({ seriesId: 'S000073699', repPdDate: '2026-07-31' });
    expect(parseNportIdentity('<x/>')).toEqual({ seriesId: null, repPdDate: null });
  });
  test('usable only for the same series and only when newer than the published holdings', () => {
    const id = parseNportIdentity(xml);
    expect(nportIsUsable(id, 'S000073699', null)).toBe(true);
    expect(nportIsUsable(id, 's000073699', '2026-06-30')).toBe(true);
    expect(nportIsUsable(id, 'S000073699', '2026-07-31')).toBe(false);
    expect(nportIsUsable(id, 'S000073699', '2026-09-30')).toBe(false);
    expect(nportIsUsable(id, 'S000099999', null)).toBe(false);
    expect(nportIsUsable({ seriesId: null, repPdDate: null }, 'S000073699', null)).toBe(false);
  });
});

describe('network: pacing and timeouts', () => {
  const saved = { ...httpSettings };
  afterEach(() => { Object.assign(httpSettings, saved); globalThis.fetch = realFetch; configureLanes(1, 1); });
  const realFetch = globalThis.fetch;

  test('lane slots are reserved synchronously: concurrent callers on one lane are spaced by REQUEST_SLEEP', async () => {
    configureLanes(1, 0.05);
    const t0 = Date.now();
    const times = await Promise.all([0, 1, 2, 3].map(async () => { await paceRequest(); return Date.now() - t0; }));
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(40);
  });

  test('two lanes let two callers start together, the third waits', async () => {
    configureLanes(2, 0.08);
    const t0 = Date.now();
    const times = await Promise.all([0, 1, 2].map(async () => { await paceRequest(); return Date.now() - t0; }));
    times.sort((a, b) => a - b);
    expect(times[1]).toBeLessThan(40);
    expect(times[2]).toBeGreaterThanOrEqual(70);
  });

  test('the timeout covers a body that never finishes, and every attempt is retried', async () => {
    Object.assign(httpSettings, { timeoutMs: 40, backoffMs: 1 });
    configureLanes(1, 0);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(new ReadableStream({ start() { /* never ends */ } })); }) as unknown as typeof fetch;
    await expect(getText('https://x.test/a', 'label', {}, readConfig({ MAX_RETRIES: '2' }))).rejects.toThrow('timed out after 40 ms');
    expect(calls).toBe(3);
  });

  test('a hanging request (no headers) times out too; 404 is not retried; 503 is', async () => {
    Object.assign(httpSettings, { timeoutMs: 40, backoffMs: 1 });
    configureLanes(1, 0);
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
  });
});

// --- pipeline tests: the whole run against an in-memory provider and a temporary api directory ---
type World = {
  tickers: string[]; navOf: Record<string, string>; failYahoo: Set<string>; failAll: boolean; yields: Record<string, unknown> | null;
  historyDays: number; chartUrls: string[]; inflight: number; peak: number; holdingsPages: number; sectionMissing: Set<string>;
};
const DAY = 86400;
const newWorld = (tickers: string[] = ['AAA', 'BBB', 'CCC', 'DDD']): World => ({
  tickers, navOf: {}, failYahoo: new Set(), failAll: false, yields: null, historyDays: 800, chartUrls: [], inflight: 0, peak: 0, holdingsPages: 1, sectionMissing: new Set(),
});
const catalogRow = (ticker: string, nav: string) => ({
  ticker, entity_long_name: `VictoryShares ${ticker} ETF`, asset_class: 'US Equity', latest_nav: nav, market_close: nav, net_assets: '1000000000',
  gross_exp_ratio: '0.44', net_expense_ratio: '0.39', inception_date: '06/21/2018', nav_as_of: '10/01/2026', monthly_performance_as_of_date: '08/31/2026',
  premium_discount_percentage: '0.01',
  performance: { monthly: { ytd_nav: '10', oneyear_nav: '12', threeyear_nav: '8', fiveyear_nav: '7', tenyear_nav: null, since_inception_nav: '9' }, quarterly: {} },
});
function yahooPayload(period1: number, days: number): unknown {
  const end = Math.floor(Date.now() / 1000 / DAY) * DAY + 14 * 3600;
  const stamps = Array.from({ length: days }, (_, i) => end - (days - 1 - i) * DAY).filter(stamp => stamp >= period1);
  return { chart: { result: [{ timestamp: stamps, indicators: { quote: [{ close: stamps.map((_, i) => 20 + i / 100) }], adjclose: [{ adjclose: stamps.map((_, i) => 20 + i / 100) }] }, events: {} }] } };
}
function installWorld(world: World): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    world.inflight++; world.peak = Math.max(world.peak, world.inflight);
    try {
      await new Promise(resolve => setTimeout(resolve, 3));
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (url.includes('victoryshares-etfs-list')) return new Response('<input id="etfListEndpoint" value="https://investorapi.vcm.com/search/products/ETF"/><input id="etfListApiKey" value="k"/>');
      if (url.endsWith('/search/products/ETF')) return json(world.tickers.map(ticker => catalogRow(ticker, world.navOf[ticker] ?? '25.00')));
      const product = /search\/product\/(\w+)\/(\w+)/.exec(url);
      if (product) {
        if (world.failAll) return new Response('down', { status: 500 });
        const [, ticker, endpoint] = product;
        if (world.sectionMissing.has(`${ticker}/${endpoint}`)) return new Response('{"errorDesc":"Section data not found"}', { status: 404 });
        if (endpoint === 'AllHoldings') return json(Array.from({ length: 3 * world.holdingsPages }, (_, i) => ({ holding_name: `${ticker} H${i}`, stock_symbol: `H${i} US`, isin: `US000${i}`, security_type: 'COMMON STOCK', market_value: '100', portfolio_percentage: '1.5', shares: '10', as_of_date: '10/02/2026' })));
        if (endpoint === 'Distributions') return json({ as_of_date: '10/01/2026', distributions: ['07/10/2026', '08/10/2026', '09/10/2026'].map(date => ({ declared_date: date, record_date: date, payable_date: date, income_amt: '0.1', long_term_capital_gains: '0', short_term_capital_gains: '0', total_distribution: '0', return_of_capital: '0' })) });
        if (endpoint === 'Yields') return json(world.yields ?? { as_of_date: '08/31/2026', thirtyday_sec_yield: '1.2', dividend_yield_percentage: '2.5' });
        if (endpoint === 'Overview') return json({ latest_nav: world.navOf[ticker] ?? '25.00', as_of: '10/01/2026', net_assets: '1000000000', nav_change: '0.1' });
        return json({ data: [{ effectiveDate: '09/25/2026', premiumDiscountPercentage: '0.05' }] });
      }
      const chart = /chart\/(\w+)\?(.*)/.exec(url);
      if (chart) {
        world.chartUrls.push(url);
        if (world.failYahoo.has(chart[1]) || world.failAll) return new Response('nope', { status: 500 });
        return json(yahooPayload(Number(new URLSearchParams(chart[2]).get('period1')), world.historyDays));
      }
      return new Response('not found', { status: 404 });
    } finally { world.inflight--; }
  }) as unknown as typeof fetch;
}
const readTree = (dir: string, base = dir): Record<string, string> => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? Object.entries(readTree(path, base)) : [[path.slice(base.length), readFileSync(path, 'utf8')]];
}));
const indexOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const controlsFor = (overrides: Record<string, string> = {}) => resolveControls(configFile(), {}, {}, { REQUEST_SLEEP: '0', MAX_RETRIES: '1', EDGAR_FALLBACK: 'false', ...overrides });

describe('pipeline (mocked fetch)', () => {
  const realFetch = globalThis.fetch;
  const saved = { ...httpSettings };
  const logs: string[] = [];
  const realConsole = { log: console.log, warn: console.warn, error: console.error };
  let dir = '';
  let summaryFile = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'victoryshares-'));
    useApiRoot(new URL(`file://${dir}/`));
    summaryFile = join(dir, '..', `summary-${Date.now()}-${Math.random()}.md`);
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    httpSettings.backoffMs = 1;
    logs.length = 0;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    console.warn = console.log; console.error = console.log;
  });
  afterEach(() => {
    process.exitCode = 0;
    Object.assign(console, realConsole);
    globalThis.fetch = realFetch;
    Object.assign(httpSettings, saved);
    delete process.env.GITHUB_STEP_SUMMARY;
    rmSync(dir, { recursive: true, force: true });
    rmSync(summaryFile, { force: true });
  });

  test('a one-ticker run keeps every other fund row and file', async () => {
    const world = newWorld(); installWorld(world);
    await runUpdate(controlsFor());
    const full = indexOf(dir);
    expect(full.funds.map((row: { ticker: string }) => row.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    const before = readTree(dir);
    world.navOf.BBB = '26.00';
    const summary = await runUpdate(controlsFor({ TICKERS: 'BBB' }));
    expect(summary.completed).toBe(1);
    const after = indexOf(dir);
    expect(after.funds).toHaveLength(4);
    expect(after.funds.find((row: { ticker: string }) => row.ticker === 'BBB').navValue).toBe(26);
    for (const ticker of ['AAA', 'CCC', 'DDD']) {
      expect(after.funds.find((row: { ticker: string }) => row.ticker === ticker)).toEqual(full.funds.find((row: { ticker: string }) => row.ticker === ticker));
    }
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
    await new Promise(resolve => setTimeout(resolve, 1100));
    const summary = await runUpdate(controlsFor());
    expect(summary.updated).toBe(0);
    expect(summary.indexChanged).toBe(false);
    expect(readTree(dir)).toEqual(before);
    for (const path of paths) expect(statSync(join(dir, path)).mtime.getTime()).toBe(old.getTime());
    expect(indexOf(dir).generatedAt).toBe(first.generatedAt);
    expect(readdirSync(join(dir, 'funds', 'AAA')).filter(name => name.endsWith('.tmp'))).toEqual([]);
  }, 20000);

  test('published rows: ytd, TER net/gross, string dividend, one metrics key set, daily history through the last bar', async () => {
    const world = newWorld(['AAA']); installWorld(world);
    await runUpdate(controlsFor());
    const [row] = indexOf(dir).funds;
    expect(row.metrics.ytd).toBe(10);
    expect(row).toMatchObject({ terValue: 0.39, terGrossValue: 0.44, dataFile: './funds/AAA/meta.json' });
    expect(row.distributions).toEqual({ frequency: 'Monthly', exDate: null, dividend: '0.1' });
    const meta = JSON.parse(readFileSync(join(dir, 'funds/AAA/meta.json'), 'utf8'));
    expect(meta.expenseRatio).toMatchObject({ value: 0.39, net: 0.39, gross: 0.44 });
    expect(meta.history.totalRows).toBe(800);
    const last = JSON.parse(readFileSync(join(dir, 'funds/AAA', meta.history.pages.at(-1)), 'utf8')).rows.at(-1);
    expect(last.Date).toBe(new Date().toISOString().slice(0, 10));
    expect(last['Premium/Discount']).toBe('');
  });

  test('in-flight requests peak at 1 with CONCURRENCY=1 and at N with CONCURRENCY=N', async () => {
    const one = newWorld(); installWorld(one);
    await runUpdate(controlsFor({ CONCURRENCY: '1' }));
    expect(one.peak).toBe(1);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
    const many = newWorld(); installWorld(many);
    await runUpdate(controlsFor({ CONCURRENCY: '3' }));
    expect(many.peak).toBe(3);
  });

  test('HISTORY_RANGE changes the real request and the published rows', async () => {
    const world = newWorld(['AAA']); installWorld(world);
    await runUpdate(controlsFor());
    const maxUrl = new URL(world.chartUrls.at(-1) as string);
    expect(maxUrl.searchParams.get('period1')).toBe('0');
    expect(maxUrl.searchParams.get('interval')).toBe('1d');
    const maxRows = JSON.parse(readFileSync(join(dir, 'funds/AAA/meta.json'), 'utf8')).history.totalRows;
    await runUpdate(controlsFor({ HISTORY_RANGE: '1y' }));
    const oneYear = new URL(world.chartUrls.at(-1) as string);
    const spanYears = (Date.now() / 1000 - Number(oneYear.searchParams.get('period1'))) / (365.25 * DAY);
    expect(spanYears).toBeGreaterThan(0.99);
    expect(spanYears).toBeLessThan(1.01);
    const oneYearRows = JSON.parse(readFileSync(join(dir, 'funds/AAA/meta.json'), 'utf8')).history.totalRows;
    expect(maxRows).toBe(800);
    expect(oneYearRows).toBeGreaterThan(360);
    expect(oneYearRows).toBeLessThan(370);
  });

  test('stale pages are removed after the new meta; a failed meta write leaves them in place', async () => {
    const world = newWorld(['AAA']); installWorld(world);
    await runUpdate(controlsFor({ HISTORY_PAGE_SIZE: '300' }));
    expect(readdirSync(join(dir, 'funds/AAA/history')).sort()).toEqual(['001.json', '002.json', '003.json']);
    await runUpdate(controlsFor({ HISTORY_PAGE_SIZE: '1000' }));
    expect(readdirSync(join(dir, 'funds/AAA/history')).sort()).toEqual(['001.json']);
    expect(JSON.parse(readFileSync(join(dir, 'funds/AAA/meta.json'), 'utf8')).history.pages).toEqual(['history/001.json']);

    // meta.json cannot be replaced (a directory sits there): pages are written, stale pages must survive
    rmSync(join(dir, 'funds/AAA/meta.json'));
    mkdirSync(join(dir, 'funds/AAA/meta.json/keep'), { recursive: true });
    const summary = await runUpdate(controlsFor({ HISTORY_PAGE_SIZE: '300' }));
    expect(summary.failures).toBe(1);
    expect(readdirSync(join(dir, 'funds/AAA/history')).sort()).toEqual(['001.json', '002.json', '003.json']);
    expect(readdirSync(join(dir, 'funds/AAA')).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  test('fund-level consistency: a failed required source keeps the whole fund, other funds update', async () => {
    const world = newWorld(['AAA', 'BBB']); installWorld(world);
    await runUpdate(controlsFor());
    const before = readTree(dir);
    const rowsBefore = indexOf(dir).funds;
    world.navOf = { AAA: '30.00', BBB: '31.00' };
    world.failYahoo.add('AAA');
    const summary = await runUpdate(controlsFor());
    expect(summary).toMatchObject({ failures: 1, updated: 1 });
    const after = readTree(dir);
    for (const path of Object.keys(before)) if (path.includes('/AAA/')) expect(after[path]).toBe(before[path]);
    const rows = indexOf(dir).funds;
    expect(rows.find((row: { ticker: string }) => row.ticker === 'AAA')).toEqual(rowsBefore.find((row: { ticker: string }) => row.ticker === 'AAA'));
    expect(rows.find((row: { ticker: string }) => row.ticker === 'BBB').navValue).toBe(31);
  });

  test('an honest null from the source is published as null, not replaced by the previous value', async () => {
    const world = newWorld(['AAA']); installWorld(world);
    await runUpdate(controlsFor());
    expect(indexOf(dir).funds[0].metrics).toMatchObject({ secYield: 1.2, dividendYield: 2.5 });
    world.yields = { as_of_date: '09/30/2026', thirtyday_sec_yield: null, dividend_yield_percentage: null };
    await runUpdate(controlsFor());
    const metrics = indexOf(dir).funds[0].metrics;
    expect(metrics.secYield).toBeNull();
    expect(metrics.secYieldText).toBeNull();
    // the declared yield is gone (honest null); the value is re-derived from the fresh distributions, never copied from the old file
    expect(metrics.dividendYield).toBe(4.8);
  });

  test('a new fund prints NEW FUNDS and a vanished one DROPPED FUNDS (summary file too); a truncated catalog drops nothing', async () => {
    const world = newWorld(['AAA', 'BBB', 'CCC', 'DDD']); installWorld(world);
    await runUpdate(controlsFor());
    world.tickers = ['AAA', 'BBB', 'CCC', 'EEE'];
    const summary = await runUpdate(controlsFor({ TICKERS: 'EEE' }));
    expect(summary.newFunds).toEqual(['EEE']);
    expect(summary.droppedFunds).toEqual(['DDD']);
    expect(logs.join('\n')).toContain('NEW FUNDS: EEE');
    expect(logs.join('\n')).toContain('DROPPED FUNDS: DDD');
    expect(readFileSync(summaryFile, 'utf8')).toContain('NEW FUNDS: EEE');
    expect(indexOf(dir).funds.map((row: { ticker: string }) => row.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'EEE']);
    expect(existsSync(join(dir, 'funds/DDD'))).toBe(false);
    expect(existsSync(join(dir, 'funds/EEE/meta.json'))).toBe(true);

    world.tickers = ['AAA'];
    const kept = await runUpdate(controlsFor({ TICKERS: 'AAA' }));
    expect(kept.droppedFunds).toEqual([]);
    expect(indexOf(dir).funds).toHaveLength(4);
    expect(logs.join('\n')).toContain('truncated');
  });

  test('a new fund that was not processed gets dataFile null and a full metrics object', async () => {
    const world = newWorld(['AAA']); installWorld(world);
    await runUpdate(controlsFor());
    world.tickers = ['AAA', 'ZZZ'];
    await runUpdate(controlsFor({ TICKERS: 'AAA' }));
    const zzz = indexOf(dir).funds.find((row: { ticker: string }) => row.ticker === 'ZZZ');
    expect(zzz.dataFile).toBeNull();
    expect(Object.keys(zzz.metrics)).toContain('ytd');
    expect(zzz.metrics.returnsBasis.length).toBeGreaterThan(10);
  });

  test('MAX_FETCHES walks the eligible funds with a persisted cursor and wraps; TICKERS runs leave it alone', async () => {
    const world = newWorld(['AAA', 'BBB', 'CCC', 'DDD']); installWorld(world);
    const cursor = () => JSON.parse(readFileSync(join(dir, 'update-state.json'), 'utf8')).lastProcessedTicker;
    await runUpdate(controlsFor({ MAX_FETCHES: '2' }));
    expect(existsSync(join(dir, 'funds/AAA/meta.json')) && existsSync(join(dir, 'funds/BBB/meta.json')) && !existsSync(join(dir, 'funds/CCC/meta.json'))).toBe(true);
    expect(cursor()).toBe('BBB');
    await runUpdate(controlsFor({ MAX_FETCHES: '2' }));
    expect(cursor()).toBe('DDD');
    expect(existsSync(join(dir, 'funds/DDD/meta.json'))).toBe(true);
    await runUpdate(controlsFor({ TICKERS: 'AAA', MAX_FETCHES: '1' }));
    expect(cursor()).toBe('DDD');
    await runUpdate(controlsFor({ MAX_FETCHES: '2' }));
    expect(cursor()).toBe('BBB');
    expect(indexOf(dir).funds).toHaveLength(4);
  });

  test('the soft deadline stops taking new funds and still writes the index', async () => {
    const world = newWorld(); installWorld(world);
    await runUpdate(controlsFor({ TICKERS: 'AAA' }));
    const summary = await runUpdate(controlsFor(), { deadlineMs: -1 });
    expect(summary).toMatchObject({ completed: 0, skipped: 4 });
    const rows = indexOf(dir).funds;
    expect(rows).toHaveLength(4);
    expect(rows.find((row: { ticker: string }) => row.ticker === 'AAA').dataFile).toBe('./funds/AAA/meta.json');
    expect(rows.find((row: { ticker: string }) => row.ticker === 'BBB').dataFile).toBeNull();
  });

  test('a brand-new fund whose Distributions section does not exist yet (404 Section data not found) is published; a later missing Overview keeps the fund', async () => {
    const world = newWorld(['AAA', 'BBB']); installWorld(world);
    world.sectionMissing.add('AAA/Distributions');
    const first = await runUpdate(controlsFor());
    expect(first).toMatchObject({ completed: 2, failures: 0 });
    const [row] = indexOf(dir).funds;
    expect(row).toMatchObject({ ticker: 'AAA', dataFile: './funds/AAA/meta.json' });
    expect(row.distributions).toEqual({ frequency: null, exDate: null, dividend: null });
    const bbb = indexOf(dir).funds[1];
    world.sectionMissing.add('BBB/Overview');
    world.navOf.BBB = '40.00';
    const second = await runUpdate(controlsFor());
    expect(second).toMatchObject({ completed: 2, failures: 1 });
    expect(indexOf(dir).funds[1]).toEqual(bbb);
    expect(isSectionMissing(Object.assign(new Error('x'), { status: 404, body: '{"errorDesc":"Section data not found"}' }))).toBe(true);
    expect(isSectionMissing(Object.assign(new Error('x'), { status: 404, body: 'Not Found' }))).toBe(false);
    expect(isSectionMissing(new Error('x'))).toBe(false);
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
});
