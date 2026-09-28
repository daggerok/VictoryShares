/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  buildPages, formatFrequencyPlaceholder, inferFrequency, parseAumRange, parseAtomFilings, parseCatalog,
  parseDistributionPayload, parseFundTickerRefs, parseHoldings, parseIssuerClientConfig, parseNportHoldings,
  pageBasenames, parsePremiumDiscount, parseRange, parseYahooChart, historyRows, returnsFromCatalog,
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

const appSource = await readFile(new URL('../app.tsx', import.meta.url), 'utf8');
function extractAppFunction(name: string): (...args: any[]) => any {
  const text = appSource;
  const match = new RegExp(`\\nfunction ${name}\\(([^)]*)\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(text);
  if (!match) throw new Error(`${name} was not found in app.tsx`);
  const parameters = match[1].split(',').map(part => part.split(':')[0].split('=')[0].trim()).filter(Boolean).join(', ');
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`function ${name}(${parameters}) {${match[2]}\n}`);
  return new Function(`${js}; return ${name};`)();
}

describe('UI parity regression guards', () => {
  test('the copied app formats missing/dash frequencies as None and preserves explicit Unknown', () => {
    const format = extractAppFunction('formatDividendFrequency');
    for (const value of [null, undefined, '', '  ', '-', '‐', '‑', '‒', '–', '—', ' — ']) expect(format(value)).toBe('00 - None');
    expect(format('None')).toBe('00 - None');
    expect(format('Unknown')).toBe('00 - Unknown');
    expect(format('Monthly')).toBe('01 - Monthly');
  });

  test('header summary moves the rich detail nodes and shows alphabetized selected tickers, including all-selected', async () => {
    const text = await readFile(new URL('../app.tsx', import.meta.url), 'utf8');
    const match = /^([ \t]*)function renderHeaderSummary\(/m.exec(text);
    expect(match).not.toBeNull();
    const tail = text.slice(match!.index);
    const end = new RegExp('^' + match![1] + '}', 'm').exec(tail);
    expect(end).not.toBeNull();
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end!.index + end![0].length));
    const node = (value = ''): any => ({ textContent: value, childNodes: [], dataset: {}, listeners: {}, replaceChildren(...items: any[]) { this.childNodes = items; }, append(...items: any[]) { this.childNodes.push(...items); }, addEventListener(type: string, listener: any) { this.listeners[type] = listener; } });
    const panel = node(), subtitle = node(), details = node('rich source links');
    subtitle.append(details);
    const document = { getElementById: () => panel, createTextNode: node, createElement: () => node() };
    const render = new Function('document', js + '; return renderHeaderSummary;')(document);
    render(subtitle, new Set(['ZZZ', 'AAA']), 'AAA', () => {});
    expect(subtitle.childNodes.map((item: any) => item.textContent).join('')).toBe('2 selected: AAA, ZZZ');
    expect(panel.childNodes[0]).toBe(details);
    render(subtitle, new Set(['CCC', 'AAA', 'BBB']), 'BBB', () => {});
    expect(subtitle.childNodes.map((item: any) => item.textContent).join('')).toBe('3 selected: AAA, BBB, CCC');
    render(subtitle, new Set(), null, () => {});
    expect(subtitle.childNodes).toEqual([]);
  });

  test('hidden source panel retains mouse, keyboard, touch, Escape and viewport-safe behaviors', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toContain('id="app-summary" role="region" aria-label="ETF catalog information" hidden');
    expect(html).toContain("trigger.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') show(); })");
    expect(html).toContain("trigger.addEventListener('focus', show)");
    expect(html).toContain("event.key !== 'Escape'");
    expect(html).toContain('innerWidth - panel.offsetWidth - 16');
    expect(html).toContain('innerHeight - panel.offsetHeight - 16');
    expect(html).toContain("trigger.addEventListener('click'");
    expect(html).toContain('official VictoryShares ETF catalog and fund JSON');
    expect(html).toContain('Yahoo Finance (adjusted market-price history; no official daily NAV history)');
    expect(html).toContain('Victory Portfolios II, CIK 0001547580');
  });
});

describe('README and automation documentation guards', () => {
  test('keeps the pinned sibling README structure and reports the verified published site', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const headings = [...readme.matchAll(/^#{2,3} .+$/gm)].map(match => match[0]);
    expect(headings).toEqual([
      '## Using Bun', '## Updating the static VictoryShares data', '### Data sources', '### Update controls', '### Examples',
      '## TypeScript', '## Brands table', '## Sibling applications', '## License',
    ]);
    expect(readme).toContain('bunx degit daggerok/VictoryShares#main ./12345 && cd $_');
    expect(readme).toContain('bun test scripts/update-data.test.ts');
    expect(readme).toContain('The published application is available at <https://daggerok.github.io/VictoryShares/>.');
    expect(readme).not.toContain('deployment has not been verified');
    expect(readme).not.toContain('initial checked-in seed');
    const brandRows = [...readme.matchAll(/^\| \*\*(.+?)\*\* \|/gm)].map(match => match[1]);
    expect(brandRows.indexOf('VictoryShares')).toBe(brandRows.indexOf('Vanguard') + 1);
    expect(brandRows.indexOf('WisdomTree')).toBe(brandRows.indexOf('VictoryShares') + 1);
  });

  test('documents every updater environment variable and exposes a matching manual workflow input', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const workflow = await readFile(new URL('../.github/workflows/update-data.yml', import.meta.url), 'utf8');
    const envVars = [
      'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE',
      'TICKERS', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'PERFORMANCE_YTD', 'PERFORMANCE_1Y', 'PERFORMANCE_3Y',
      'PERFORMANCE_5Y', 'PERFORMANCE_10Y', 'TOTAL_RETURN_YTD', 'TOTAL_RETURN_1Y', 'TOTAL_RETURN_3Y', 'TOTAL_RETURN_5Y',
      'TOTAL_RETURN_10Y', 'EDGAR_FALLBACK', 'SEC_UA', 'SKIP_YAHOO', 'VERBOSE',
    ];
    for (const variable of envVars) expect(readme).toContain(`\`${variable}\``);
    const inputs = [...workflow.matchAll(/^      ([a-z][a-z0-9_]*):$/gm)].map(match => match[1]);
    for (const variable of envVars) {
      expect(inputs).toContain(variable.toLowerCase());
      expect(workflow).toMatch(new RegExp(`^      ${variable}: \\$\\{\\{ inputs\\.${variable.toLowerCase()} \\|\\| `, 'm'));
    }
    expect(workflow).toContain("cron: '0 0 * * 0'");
    expect(workflow).toContain('bun test scripts/update-data.test.ts');
    expect(workflow).not.toContain('bunx tsc');
  });
});
