/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildPages, formatFrequencyPlaceholder, inferFrequency, parseAumRange, parseAtomFilings, parseCatalog,
  parseDistributionPayload, parseFundTickerRefs, parseHoldings, parseIssuerClientConfig, parseNportHoldings,
  pageBasenames, parsePremiumDiscount, parseRange, parseYahooChart, historyRows, returnsFromCatalog,
  CONTROL_NAMES, readConfig, resolveControls, runtimeControls,
} from './update-data';

const catalogFixture = [{
  ticker: 'VFLO', entity_long_name: 'VictoryShares Free Cash Flow ETF', asset_class: 'US Equity',
  latest_nav: '51.59', market_close: '51.60', net_assets: '10993961469', gross_exp_ratio: '0.44', net_expense_ratio: '0.39',
  inception_date: '06/21/2023', nav_as_of: '09/25/2026', premium_discount_percentage: '-0.0043',
  performance: { monthly: { as_of: '08/31/2026', ytd_nav: '41.85', oneyear_nav: '51.00', threeyear_nav: '29.99', fiveyear_nav: null, tenyear_nav: null, since_inception_nav: '30.11' }, quarterly: {} },
}];

describe('VictoryShares source parsers', () => {
  test('reads public catalog rows and preserves NAV, AUM, TER and performance source fields', () => {
    const [fund] = parseCatalog(catalogFixture);
    expect(fund).toMatchObject({ ticker: 'VFLO', name: 'VictoryShares Free Cash Flow ETF', category: 'US Equity', navValue: 51.59, aumValue: 10993961469, terValue: 0.44 });
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
    const bad: unknown[] = [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { HOLDINGS_PAGE_SIZE: 0 }, { HISTORY_PAGE_SIZE: 0 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { EDGAR_FALLBACK: 'x' }, { SKIP_YAHOO: 'x' }, { HISTORY_RANGE: '7y' }, { AUM: '1:2:3' }, { TER: '5' }, { TER: '5:1' }, { TICKERS: ['VFLO'] }, null, []];
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
