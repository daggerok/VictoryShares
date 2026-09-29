import './load-update-data-config'; // JSON defaults; explicit process.env overrides.
#!/usr/bin/env bun
/// <reference types="bun" />
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';


/** VictoryShares static data updater. Bun only; official VCM JSON + Yahoo + optional SEC N-PORT-P. */

type JsonRecord = Record<string, unknown>;
type Range = { min?: number; max?: number; source: string };
type Fund = JsonRecord & {
  ticker: string; name: string; category: string; navValue: number | null; aumValue: number | null;
  terValue: number | null; dividendYield: number | null; secYield: number | null;
};
type Config = {
  maxFetches: number; requestSleep: number; concurrency: number; maxRetries: number;
  holdingsPageSize: number; historyPageSize: number; historyRange: string; tickers: Set<string>;
  aum: Range; ter: Range; dividendYield: Range; secYield: Range;
  performance: Record<string, Range>; totalReturn: Record<string, Range>;
  edgarFallback: boolean; skipYahoo: boolean; secUa: string;
};
type SheetRow = Record<string, string>;
type ChartDay = { date: string; close: number | null; adjClose: number | null; dividend: number | null };
type PageManifest = { pages: string[]; pageSize: number; totalRows: number; asOfDate: string | null; source: string };
type FundSnapshot = { digest: string; meta: JsonRecord };

const ISSUER_LIST_PAGE = 'https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list';
const ISSUER_OVERVIEW_PAGE = 'https://www.vcm.com/products-fa/victoryshares-etfs';
const ISSUER_API_FALLBACK = 'https://investorapi.vcm.com/search/products/ETF';
const VCM_API = 'https://investorapi.vcm.com/search/product';
const SEC_MF_TICKERS = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const SEC_BROWSE = 'https://www.sec.gov/cgi-bin/browse-edgar';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const API_ROOT = new URL('../api/victoryshares/', import.meta.url);
const INDEX_FILE = new URL('index.json', API_ROOT);
const STATE_FILE = new URL('update-state.json', API_ROOT);
const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category', 'Coupon', 'Maturity'];
const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount', 'Adj Close'];
const RETURN_PERIODS = ['YTD', '1Y', '3Y', '5Y', '10Y'];
const DEFAULTS = { requestSleep: 1, concurrency: 2, maxRetries: 2, holdingsPageSize: 250, historyPageSize: 1000 };

// Shared console contract (kept intentionally simple and stable).
const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test(process.env.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
function outputCount(value: unknown): unknown {
  return typeof value === 'number' ? value : Array.isArray(value) ? value.length : null;
}
function outputMoney(value: unknown): string {
  const number = toNumber(value);
  if (number === null) return 'null';
  for (const [suffix, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${suffix}`;
  }
  return `$${number.toFixed(2)}`;
}
function outputStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outputStable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(ticker: string): Promise<FundSnapshot> {
  const dir = new URL(`funds/${ticker}/`, API_ROOT);
  const digest = createHash('sha256');
  async function visit(path: URL): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = new URL(entry.name, path);
      if (entry.isDirectory()) await visit(new URL(`${entry.name}/`, path));
      else if (entry.name.endsWith('.json')) {
        const text = await readFile(child, 'utf8').catch(() => '');
        digest.update(entry.name);
        try { digest.update(outputContentKey(JSON.parse(text))); } catch { digest.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await readJson(new URL('meta.json', dir));
  return { digest: digest.digest('hex'), meta: isRecord(meta) ? meta : {} };
}
function outputFundLine(index: number, total: number, ticker: string, status: string, meta: JsonRecord, reason = ''): string {
  const num = (key: string, value: unknown): string => value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const line = [
    num('history', outputCount(meta.historyCount)), num('holdings', outputCount(meta.holdingsCount)),
    num('divs', outputCount(meta.distributionCount)), num('netAssets', outputMoney(meta.netAssets)),
    num('div', meta.dividendYield), num('sec', meta.secYield),
  ].filter(Boolean).join(' ');
  return `[ ${String(index).padStart(Math.max(2, String(total).length))}/${String(total).padEnd(Math.max(2, String(total).length))}  ] ${ticker.padEnd(5)} ${status.padEnd(9)}${line ? ` ${line}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(total: number) {
  let completed = 0, failures = 0, updated = 0, unchanged = 0;
  return {
    async result(ticker: string, before: FundSnapshot, meta: JsonRecord, status?: string, reason = ''): Promise<void> {
      const after = await outputInspectFund(ticker);
      const detected = before.digest === after.digest ? 'unchanged' : 'updated';
      const finalStatus = status ?? detected;
      if (finalStatus === 'failed') failures++;
      else if (finalStatus === 'updated') updated++;
      else unchanged++;
      console.log(outputFundLine(++completed, total, ticker, finalStatus, meta, reason));
    },
    summary: () => ({ completed, failures, updated, unchanged }),
  };
}
function outputPrintConfig(config: Config): void {
  const entries: [string, string][] = [
    ['MAX_FETCHES', String(config.maxFetches)], ['REQUEST_SLEEP', String(config.requestSleep)], ['CONCURRENCY', String(config.concurrency)],
    ['AUM', config.aum.source], ['DIVIDEND_YIELD', config.dividendYield.source], ['EDGAR_FALLBACK', String(config.edgarFallback)],
    ['HISTORY_PAGE_SIZE', String(config.historyPageSize)], ['HISTORY_RANGE', config.historyRange], ['HOLDINGS_PAGE_SIZE', String(config.holdingsPageSize)],
    ['MAX_RETRIES', String(config.maxRetries)], ['SEC_UA', config.secUa ? '<configured>' : '<not configured>'],
    ['SEC_YIELD', config.secYield.source], ['SKIP_YAHOO', String(config.skipYahoo)],
    ['TER', config.ter.source], ['TICKERS', [...config.tickers].join(',') || 'all'], ['VERBOSE', String(outputVerbose())],
    ...RETURN_PERIODS.map(period => [`PERFORMANCE_${period}`, config.performance[period].source] as [string, string]),
    ...RETURN_PERIODS.map(period => [`TOTAL_RETURN_${period}`, config.totalReturn[period].source] as [string, string]),
  ];
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  entries.sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
  console.log(`[ config   ] VictoryShares updater:\n${entries.map(([key, value]) => `              ${key}=${outputClean(value)}`).join('\n')}`);
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}

function isRecord(value: unknown): value is JsonRecord { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\u00ae|\u2122|&reg;|&#174;|&trade;|&#8482;/gi, '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/[,$%\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!text || /^(n\/?a|none|null|unknown|-)$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
function toIsoDate(value: unknown): string {
  const text = String(value ?? '').trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  return text;
}
function displayDate(value: unknown): string {
  const iso = toIsoDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(match[2])-1]} ${match[3]} ${match[1]}` : iso;
}
function tickerClean(value: unknown): string { return String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
function formatMoney(value: number | null): string {
  if (value === null) return '—';
  for (const [unit, scale] of [['T',1e12],['B',1e9],['M',1e6],['K',1e3]] as const) if (Math.abs(value) >= scale) return `$${(value/scale).toFixed(2)}${unit}`;
  return `$${value.toFixed(2)}`;
}
function formatPercent(value: number | null): string { return value === null ? '—' : `${value.toFixed(2)}%`; }

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
export function parseDecimal(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
export function parseRange(value: string | undefined, name = 'range'): Range {
  const source = value?.trim() || ':';
  if (source === ':' || source === '') return { source: ':' };
  if (!source.includes(':')) throw new Error(`${name} must be MIN:MAX (colon required)`);
  const [lo, hi, ...extra] = source.split(':');
  if (extra.length) throw new Error(`${name} has too many ':' separators`);
  const parse = (raw: string): number | undefined => {
    if (!raw.trim()) return undefined;
    const n = toNumber(raw);
    if (n === null) throw new Error(`${name} bound is not numeric`);
    return n;
  };
  const min = parse(lo), max = parse(hi);
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${name} minimum exceeds maximum`);
  return { min, max, source };
}
export function parseAumRange(value: string | undefined): Range {
  const raw = value?.trim() || ':';
  const presets: Record<string, string> = {
    nano: ':10M', micro: '10M:300M', small: '300M:2B', mid: '2B:10B', large: '10B:',
  };
  if (presets[raw.toLowerCase()]) return parseAumRange(presets[raw.toLowerCase()]);
  if (raw === ':') return { source: ':' };
  if (!raw.includes(':')) throw new Error('AUM must be MIN:MAX (colon required) or nano/micro/small/mid/large');
  const [lo, hi, ...extra] = raw.split(':');
  if (extra.length) throw new Error('AUM has too many separators');
  const parse = (part: string): string => {
    const text = part.trim();
    if (!text) return '';
    const m = /^([\d,.]+)\s*([KMBT])?$/i.exec(text);
    if (!m) throw new Error(`AUM bound is invalid: ${text}`);
    const amount = Number(m[1].replace(/,/g, '')) * ({ K:1e3, M:1e6, B:1e9, T:1e12 }[String(m[2] || '').toUpperCase() as 'K'|'M'|'B'|'T'] ?? 1);
    return String(amount);
  };
  return parseRange(`${parse(lo)}:${parse(hi)}`, 'AUM');
}
function inRange(value: number | null, range: Range): boolean {
  return value === null ? range.min === undefined && range.max === undefined : (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
}
function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const performance: Record<string, Range> = {}, totalReturn: Record<string, Range> = {};
  for (const period of RETURN_PERIODS) {
    performance[period] = parseRange(env[`PERFORMANCE_${period}`], `PERFORMANCE_${period}`);
    totalReturn[period] = parseRange(env[`TOTAL_RETURN_${period}`], `TOTAL_RETURN_${period}`);
  }
  const tickers = new Set((env.TICKERS ?? '').split(/[\s,]+/).map(tickerClean).filter(Boolean));
  const range = (key: string): Range => parseRange(env[key], key);
  return {
    maxFetches: parsePositiveInt(env.MAX_FETCHES, 0), requestSleep: parseDecimal(env.REQUEST_SLEEP, DEFAULTS.requestSleep),
    concurrency: Math.max(1, parsePositiveInt(env.CONCURRENCY, DEFAULTS.concurrency)), maxRetries: parsePositiveInt(env.MAX_RETRIES, DEFAULTS.maxRetries),
    holdingsPageSize: Math.max(1, parsePositiveInt(env.HOLDINGS_PAGE_SIZE, DEFAULTS.holdingsPageSize)),
    historyPageSize: Math.max(1, parsePositiveInt(env.HISTORY_PAGE_SIZE, DEFAULTS.historyPageSize)),
    historyRange: env.HISTORY_RANGE?.trim() || 'max', tickers, aum: parseAumRange(env.AUM), ter: range('TER'),
    dividendYield: range('DIVIDEND_YIELD'), secYield: range('SEC_YIELD'), performance, totalReturn,
    edgarFallback: !/^(0|false|no|off)$/i.test(env.EDGAR_FALLBACK ?? '1'),
    skipYahoo: /^(1|true|yes|on)$/i.test(env.SKIP_YAHOO ?? ''),
    secUa: env.SEC_UA?.trim() ?? '',
  };
}

/** Parse the official list client settings. The x-api-key is deliberately kept in memory only. */
export function parseIssuerClientConfig(html: string): { endpoint: string; apiKey: string } {
  const endpoint = /id=["']etfListEndpoint["'][^>]*value=["']([^"']+)/i.exec(html)?.[1]
    ?? /id=["']etfListEndpoint["'][^>]*value="([^"]+)/i.exec(html)?.[1];
  const apiKey = /id=["']etfListApiKey["'][^>]*value=["']([^"']+)/i.exec(html)?.[1]
    ?? /id=["']etfListApiKey["'][^>]*value="([^"]+)/i.exec(html)?.[1];
  if (!endpoint || !apiKey) throw new Error('Issuer list page did not expose the ETF catalog client settings');
  const url = new URL(endpoint, ISSUER_LIST_PAGE);
  if (url.protocol !== 'https:' || url.hostname !== 'investorapi.vcm.com') throw new Error('Unexpected issuer catalog API host');
  return { endpoint: url.toString(), apiKey };
}

export function parseCatalog(payload: unknown): Fund[] {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const result: Fund[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const ticker = tickerClean(raw.ticker);
    const name = cleanText(raw.entity_long_name);
    if (!ticker || !name) continue;
    const navValue = toNumber(raw.latest_nav);
    const aumValue = toNumber(raw.net_assets);
    const terValue = toNumber(raw.gross_exp_ratio);
    const yieldValue = toNumber(raw['30day_sec_yield']);
    result.push({
      ...raw, ticker, name,
      category: cleanText(raw.asset_class) || 'Uncategorized',
      navValue, aumValue, terValue,
      dividendYield: toNumber(raw.dividend_yield_percentage),
      secYield: yieldValue,
    });
  }
  return result.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function cachedFundFromIndex(item: JsonRecord): Fund {
  const metrics = isRecord(item.metrics) ? item.metrics : {};
  const returns = isRecord(item.returns) ? item.returns : {};
  const monthEnd = isRecord(returns.monthEnd) ? returns.monthEnd : {};
  const quarterEnd = isRecord(returns.quarterEnd) ? returns.quarterEnd : {};
  const toSourceReturns = (row: JsonRecord): JsonRecord => ({
    as_of: row.asOfDate, onemonth_nav: row.mo1, threemonth_nav: row.qtd,
    ytd_nav: row.ytd, oneyear_nav: row.yr1, threeyear_nav: row.yr3,
    fiveyear_nav: row.yr5, tenyear_nav: row.yr10, since_inception_nav: row.sinceInception,
  });
  return {
    ...item, ticker: String(item.ticker ?? ''), name: String(item.name ?? ''), category: String(item.category ?? ''),
    navValue: toNumber(item.navValue), aumValue: toNumber(item.aumValue), terValue: toNumber(item.terValue),
    dividendYield: toNumber(metrics.dividendYield), secYield: toNumber(metrics.secYield),
    gross_exp_ratio: item.terValue, net_expense_ratio: item.terValue,
    performance: { monthly: toSourceReturns(monthEnd), quarterly: toSourceReturns(quarterEnd) },
  };
}

export function parseDistributionPayload(payload: unknown): { headers: string[]; rows: string[][]; frequency: string | null; latest: number | null; date: string | null } {
  const record = isRecord(payload) ? payload : {};
  const rawRows = Array.isArray(record.distributions) ? record.distributions.filter(isRecord) : [];
  const headers = ['Declared Date', 'Record Date', 'Payable Date', 'Income Amount', 'Long-Term Capital Gains', 'Short-Term Capital Gains', 'Total Distribution', 'Return of Capital'];
  const rows = rawRows.map(row => [row.declared_date, row.record_date, row.payable_date, row.income_amt, row.long_term_capital_gains, row.short_term_capital_gains, row.total_distribution, row.return_of_capital].map(value => String(value ?? '')));
  const dated = rawRows.map(row => ({ row, date: toIsoDate(row.declared_date) })).filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date)).sort((a, b) => a.date.localeCompare(b.date));
  const latest = dated.at(-1);
  const amount = latest ? (toNumber(latest.row.income_amt) ?? 0) + (toNumber(latest.row.long_term_capital_gains) ?? 0) + (toNumber(latest.row.short_term_capital_gains) ?? 0) : null;
  return { headers, rows, frequency: inferFrequency(dated.map(item => item.date)), latest: amount && amount > 0 ? amount : null, date: latest?.date ?? null };
}
export function inferFrequency(isoDates: string[]): string | null {
  const dates = [...new Set(isoDates.filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
  if (dates.length < 2) return null;
  const gaps = dates.slice(1).map((date, i) => (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dates[i]}T00:00:00Z`)) / 86400000).filter(n => n > 0);
  if (!gaps.length) return null;
  const avg = gaps.reduce((sum, n) => sum + n, 0) / gaps.length;
  if (avg <= 45) return 'Monthly';
  if (avg <= 115) return 'Quarterly';
  if (avg <= 220) return 'Semi-annually';
  if (avg <= 400) return 'Annually';
  return 'Irregular';
}

export function parseHoldings(payload: unknown): { headers: string[]; rows: SheetRow[]; asOfDate: string | null } {
  const rawRows = Array.isArray(payload) ? payload.filter(isRecord) : isRecord(payload) && Array.isArray(payload.holdings) ? payload.holdings.filter(isRecord) : [];
  const rows = rawRows.map(raw => {
    const securityType = cleanText(raw.security_type);
    const rawTicker = cleanText(raw.stock_symbol);
    const ticker = /\s+[A-Z]{1,3}$/i.test(rawTicker) ? rawTicker.replace(/\s+[A-Z]{1,3}$/i, '') : rawTicker;
    const id = cleanText(raw.isin ?? raw.cusip ?? raw.sedol) || '-';
    return {
      Name: cleanText(raw.holding_name ?? raw.name) || '-', Ticker: ticker || '-', Identifier: id,
      Weight: cleanText(raw.portfolio_percentage) || '0', 'Market Value': cleanText(raw.market_value) || '0',
      'Shares Held': cleanText(raw.shares ?? raw.balance) || '-', 'Asset Category': securityType || '-',
      Coupon: cleanText(raw.coupon_rate) || '-', Maturity: cleanText(raw.maturity_date) || '-',
    };
  }).sort((a, b) => a.Ticker.localeCompare(b.Ticker) || a.Name.localeCompare(b.Name) || a.Identifier.localeCompare(b.Identifier));
  const asOf = rawRows.map(row => toIsoDate(row.as_of_date)).find(value => /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? null;
  return { headers: HOLDINGS_HEADERS, rows, asOfDate: asOf };
}

function arrayOfNumbers(value: unknown): (number | null)[] {
  return Array.isArray(value) ? value.map(toNumber) : [];
}
export function parseYahooChart(payload: unknown): ChartDay[] {
  if (!isRecord(payload)) return [];
  const chart = isRecord(payload.chart) ? payload.chart : {};
  const resultRows = Array.isArray(chart.result) ? chart.result : [];
  const first = isRecord(resultRows[0]) ? resultRows[0] : null;
  if (!first) return [];
  const timestamps = Array.isArray(first.timestamp) ? first.timestamp.map(value => Number(value)) : [];
  const indicators = isRecord(first.indicators) ? first.indicators : {};
  const quotes = Array.isArray(indicators.quote) && isRecord(indicators.quote[0]) ? indicators.quote[0] : {};
  const closes = arrayOfNumbers(quotes.close);
  const adjContainer = Array.isArray(indicators.adjclose) && isRecord(indicators.adjclose[0]) ? indicators.adjclose[0] : {};
  const adjusted = arrayOfNumbers(adjContainer.adjclose);
  const events = isRecord(first.events) ? first.events : {};
  const dividendEvents = isRecord(events.dividends) ? events.dividends : {};
  const dividendByDate = new Map<number, number>();
  for (const [stamp, raw] of Object.entries(dividendEvents)) {
    const item = isRecord(raw) ? raw : {};
    const epoch = Number(stamp);
    const amount = toNumber(item.amount);
    if (Number.isFinite(epoch) && amount !== null && amount > 0) dividendByDate.set(epoch, amount);
  }
  const days = timestamps.map((epoch, index) => {
    const close = closes[index] ?? null;
    const adj = adjusted[index] ?? close;
    return {
      date: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString().slice(0, 10) : '',
      close: close !== null ? round(close, 2) : null,
      adjClose: adj !== null ? round(adj, 2) : null,
      dividend: dividendByDate.get(epoch) ?? null,
    };
  }).filter(day => day.date && (day.close !== null || day.adjClose !== null));
  return days.sort((a, b) => a.date.localeCompare(b.date));
}
function round(value: number, digits: number): number { const scale = 10 ** digits; return Math.round((value + Number.EPSILON) * scale) / scale; }
export function historyRows(days: ChartDay[], premiumDiscount: Map<string, number> = new Map()): SheetRow[] {
  return days.map(day => ({
    Date: day.date, NAV: '', 'Market Price': day.close === null ? '' : day.close.toFixed(2),
    'Premium/Discount': premiumDiscount.has(day.date) ? `${(premiumDiscount.get(day.date) as number).toFixed(4)}%` : '',
    'Adj Close': day.adjClose === null ? '' : day.adjClose.toFixed(2),
  }));
}
export function parsePremiumDiscount(payload: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (!isRecord(payload) || !Array.isArray(payload.data)) return result;
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue;
    const date = toIsoDate(raw.effectiveDate);
    const value = toNumber(raw.premiumDiscountPercentage);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value !== null) result.set(date, value);
  }
  return result;
}

export function parseNportHoldings(xml: string): SheetRow[] {
  const decoded = String(xml).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const tag = (body: string, name: string): string => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(body)?.[1]?.trim() ?? '';
  const rows: SheetRow[] = [];
  for (const match of decoded.matchAll(/<invstOrSec>([\s\S]*?)<\/invstOrSec>/gi)) {
    const body = match[1];
    const identifier = tag(body, 'cusip') || /<(?:isin|sedol|other)[^>]*value="([^"]+)"/i.exec(body)?.[1] || '-';
    const name = tag(body, 'name') || tag(body, 'title') || '-';
    const value = tag(body, 'valUSD') || tag(body, 'curVal') || '0';
    rows.push({ Name: name, Ticker: '-', Identifier: identifier, Weight: tag(body, 'pctVal') || '0', 'Market Value': value, 'Shares Held': tag(body, 'balance') || '-', 'Asset Category': tag(body, 'assetCat') || '-', Coupon: '-', Maturity: '-' });
  }
  return rows;
}

function checkRangeFilters(fund: Fund, config: Config): boolean {
  const monthly = isRecord(fund.performance) && isRecord(fund.performance.monthly) ? fund.performance.monthly : {};
  const navReturn = (key: string): number | null => toNumber(monthly[key]);
  const total: Record<string, number | null> = {
    YTD: navReturn('ytd_nav'), '1Y': navReturn('oneyear_nav'),
    '3Y': navReturn('threeyear_nav'), '5Y': navReturn('fiveyear_nav'), '10Y': navReturn('tenyear_nav'),
  };
  const annualized: Record<string, number | null> = { ...total };
  return inRange(fund.aumValue, config.aum) && inRange(fund.terValue, config.ter) &&
    inRange(fund.dividendYield, config.dividendYield) && inRange(fund.secYield, config.secYield) &&
    RETURN_PERIODS.every(period => inRange(annualized[period], config.performance[period]) && inRange(total[period], config.totalReturn[period]));
}

function fundSlug(name: string): string {
  return `victoryshares-${name.replace(/^VictoryShares\s*/i, '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-')}`;
}
function fundPageUrl(fund: Fund): string { return `${ISSUER_LIST_PAGE}/${fundSlug(fund.name)}`; }
function valueFrom(record: JsonRecord, ...keys: string[]): unknown { for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key]; return null; }
function formatIndexDate(value: unknown): string { return displayDate(value); }
function pageFile(kind: 'holdings' | 'history', page: number): string { return `${kind}/${String(page + 1).padStart(3, '0')}.json`; }
export function buildPages<T>(rows: T[], pageSize: number): T[][] {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer');
  const pages: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += pageSize) pages.push(rows.slice(offset, offset + pageSize));
  return pages;
}
export function pageBasenames(paths: string[]): Set<string> { return new Set(paths.map(path => path.split('/').at(-1) ?? path)); }

async function readJson(url: URL): Promise<unknown> { return readFile(url, 'utf8').then(JSON.parse).catch(() => null); }
async function samePublishedContent(url: URL, value: unknown): Promise<boolean> {
  const previous = await readJson(url);
  return previous !== null && outputContentKey(previous) === outputContentKey(value);
}
async function writeJsonIfChanged(url: URL, value: unknown): Promise<boolean> {
  if (await samePublishedContent(url, value)) return false;
  await mkdir(new URL('.', url), { recursive: true });
  await writeFile(url, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
  return true;
}
async function writePages(ticker: string, kind: 'holdings' | 'history', headers: string[], rows: SheetRow[], size: number, asOfDate: string | null, source: string): Promise<PageManifest> {
  const dir = new URL(`funds/${ticker}/`, API_ROOT);
  await mkdir(new URL(`${kind}/`, dir), { recursive: true });
  const pages: string[] = [];
  const chunks = buildPages(rows, size);
  for (const [index, chunk] of chunks.entries()) {
    const name = pageFile(kind, index);
    pages.push(name);
    await writeJsonIfChanged(new URL(name, dir), { headers, rows: chunk, asOfDate });
  }
  const keep = pageBasenames(pages);
  const folder = new URL(`${kind}/`, dir);
  for (const entry of await readdir(folder).catch(() => [])) if (entry.endsWith('.json') && !keep.has(entry)) await rm(new URL(entry, folder), { force: true });
  return { pages, pageSize: size, totalRows: rows.length, asOfDate, source };
}
async function previousRows(ticker: string, kind: 'holdings' | 'history'): Promise<{ headers: string[]; rows: SheetRow[] }> {
  const meta = await readJson(new URL(`funds/${ticker}/meta.json`, API_ROOT));
  const root = isRecord(meta) ? meta[kind] : null;
  if (!isRecord(root) || !Array.isArray(root.pages)) return { headers: kind === 'holdings' ? HOLDINGS_HEADERS : HISTORY_HEADERS, rows: [] };
  let headers: string[] = [], rows: SheetRow[] = [];
  for (const name of root.pages) {
    if (typeof name !== 'string') continue;
    const page = await readJson(new URL(`funds/${ticker}/${name}`, API_ROOT));
    if (!isRecord(page)) continue;
    if (Array.isArray(page.headers)) headers = page.headers.filter((value): value is string => typeof value === 'string');
    if (Array.isArray(page.rows)) rows.push(...page.rows.filter(isRecord).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? '')]))));
  }
  return { headers: headers.length ? headers : kind === 'holdings' ? HOLDINGS_HEADERS : HISTORY_HEADERS, rows };
}
async function previousIndex(): Promise<Map<string, JsonRecord>> {
  const data = await readJson(INDEX_FILE);
  const funds = isRecord(data) && Array.isArray(data.funds) ? data.funds : [];
  const result = new Map<string, JsonRecord>();
  for (const item of funds) if (isRecord(item) && typeof item.ticker === 'string') result.set(item.ticker, item);
  return result;
}
async function readCursor(): Promise<string> {
  const state = await readJson(STATE_FILE);
  return isRecord(state) && typeof state.lastProcessedTicker === 'string' ? state.lastProcessedTicker : '';
}

// One independently paced lane per worker; do not serialize all workers behind one shared gate.
let laneTimes: number[] = [0];
let requestSleepMs = 1000;
async function paceRequest(): Promise<void> {
  let lane = 0;
  for (let i = 1; i < laneTimes.length; i++) if (laneTimes[i] < laneTimes[lane]) lane = i;
  const now = Date.now();
  const wait = Math.max(0, laneTimes[lane] - now);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  laneTimes[lane] = Date.now() + requestSleepMs;
}
async function fetchRetry(url: string, label: string, headers: Record<string, string>, config: Config, retries = config.maxRetries): Promise<Response> {
  let last: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await paceRequest();
    try {
      const response = await fetch(url, { headers, redirect: 'follow' });
      if (response.ok) return response;
      last = new Error(`HTTP ${response.status} ${response.statusText}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) { last = error; }
    if (attempt < retries) {
      const wait = Math.min(15000, 750 * (2 ** attempt));
      outputNote(`[ retry    ] ${label}: retry ${attempt + 1}/${retries} in ${wait}ms`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : String(last)}`);
}
async function getText(url: string, label: string, headers: Record<string, string>, config: Config): Promise<string> {
  return (await fetchRetry(url, label, headers, config)).text();
}
async function getJson(url: string, label: string, headers: Record<string, string>, config: Config): Promise<unknown> {
  const text = await getText(url, label, headers, config);
  try { return JSON.parse(text); } catch { throw new Error(`${label}: response was not valid JSON`); }
}
const VCM_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; VictoryShares ETF data updater)', Accept: 'application/json, text/html;q=0.9' };
function issuerApiHeaders(apiKey: string): Record<string, string> { return { ...VCM_HEADERS, 'x-api-key': apiKey }; }
function yahooHeaders(): Record<string, string> { return { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36', Accept: 'application/json' }; }
function secHeaders(config: Config): Record<string, string> { return { 'User-Agent': config.secUa, Accept: 'application/json, application/atom+xml, application/xml;q=0.9' }; }
async function loadApiKey(config: Config): Promise<{ endpoint: string; apiKey: string }> {
  const html = await getText(ISSUER_LIST_PAGE, '[issuer   ] list page', { ...VCM_HEADERS, Accept: 'text/html' }, config);
  return parseIssuerClientConfig(html);
}

async function fetchProduct(ticker: string, endpoint: string, key: string, config: Config): Promise<unknown> {
  return getJson(`${VCM_API}/${encodeURIComponent(ticker)}/${endpoint}`, `[product  ] ${ticker} ${endpoint}`, issuerApiHeaders(key), config);
}
async function fetchYahoo(ticker: string, range: string, config: Config): Promise<ChartDay[]> {
  const allowed = new Set(['max', '10y', '5y', '2y', '1y', '6mo', '3mo']);
  const selectedRange = allowed.has(range) ? range : 'max';
  const query = new URLSearchParams({ range: selectedRange, interval: '1d', events: 'div,splits' });
  return parseYahooChart(await getJson(`${YAHOO_CHART}/${encodeURIComponent(ticker)}?${query}`, `[chart    ] ${ticker}`, yahooHeaders(), config));
}

export function parseFundTickerRefs(payload: unknown): Map<string, { cik: string; seriesId: string }> {
  const result = new Map<string, { cik: string; seriesId: string }>();
  if (!isRecord(payload) || !Array.isArray(payload.fields) || !Array.isArray(payload.data)) return result;
  const fields = payload.fields.map(String);
  const index = (key: string): number => fields.indexOf(key);
  const ti = index('symbol'), ci = index('cik'), si = index('seriesId');
  for (const row of payload.data) {
    if (!Array.isArray(row)) continue;
    const ticker = tickerClean(row[ti]);
    const cik = String(row[ci] ?? '').replace(/\D/g, '');
    const seriesId = String(row[si] ?? '').toUpperCase();
    if (ticker && cik && seriesId) result.set(ticker, { cik: cik.padStart(10, '0'), seriesId });
  }
  return result;
}
export function parseAtomFilings(xml: string): { cik: string; accession: string }[] {
  const result: { cik: string; accession: string }[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const body = match[1];
    const form = /<(?:filing-type|type)>([\s\S]*?)<\/(?:filing-type|type)>/i.exec(body)?.[1]?.trim();
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = /<accession-number>([\s\S]*?)<\/accession-number>/i.exec(body)?.[1]?.trim();
    const href = /<filing-href>([\s\S]*?)<\/filing-href>/i.exec(body)?.[1] ?? '';
    const cik = /\/edgar\/data\/(\d+)\//i.exec(href)?.[1] ?? '';
    if (accession && cik) result.push({ cik, accession });
  }
  return result;
}
async function fetchEdgarHoldings(ticker: string, config: Config): Promise<{ rows: SheetRow[]; asOfDate: string | null }> {
  if (!config.edgarFallback) return { rows: [], asOfDate: null };
  if (!config.secUa) {
    outputNote(`[ edgar    ] ${ticker}: SEC fallback not attempted; configure SEC_UA with a valid organizational contact`);
    return { rows: [], asOfDate: null };
  }
  try {
    const lookup = await getJson(SEC_MF_TICKERS, '[edgar   ] fund ticker table', secHeaders(config), config);
    const ref = parseFundTickerRefs(lookup).get(ticker);
    if (!ref) return { rows: [], asOfDate: null };
    const params = new URLSearchParams({ action: 'getcompany', CIK: ref.seriesId, type: 'NPORT-P', owner: 'include', count: '10', output: 'atom' });
    const atom = await getText(`${SEC_BROWSE}?${params}`, `[edgar   ] ${ticker} N-PORT-P index`, secHeaders(config), config);
    const latest = parseAtomFilings(atom)[0];
    if (!latest) return { rows: [], asOfDate: null };
    const primary = `${SEC_ARCHIVES}/${Number(latest.cik)}/${latest.accession.replace(/-/g, '')}/primary_doc.xml`;
    const xml = await getText(primary, `[edgar   ] ${ticker} N-PORT-P`, { ...secHeaders(config), Accept: 'application/xml,text/xml' }, config);
    return { rows: parseNportHoldings(xml), asOfDate: toIsoDate(/<repPdDate>([\s\S]*?)<\/repPdDate>/i.exec(xml)?.[1]) || null };
  } catch (error) {
    outputNote(`[ edgar    ] ${ticker}: ${error instanceof Error ? error.message : String(error)}`);
    return { rows: [], asOfDate: null };
  }
}

export function returnsFromCatalog(fund: Fund): { monthEnd: JsonRecord; quarterEnd: JsonRecord; metrics: JsonRecord } {
  const performance = isRecord(fund.performance) ? fund.performance : {};
  const monthly = isRecord(performance.monthly) ? performance.monthly : {};
  const quarterly = isRecord(performance.quarterly) ? performance.quarterly : {};
  const mapReturn = (source: JsonRecord, date: unknown): JsonRecord => ({
    asOfDate: displayDate(date), mo1: toNumber(source.onemonth_nav), qtd: toNumber(source.threemonth_nav),
    ytd: toNumber(source.ytd_nav), yr1: toNumber(source.oneyear_nav), yr3: toNumber(source.threeyear_nav),
    yr5: toNumber(source.fiveyear_nav), yr10: toNumber(source.tenyear_nav), sinceInception: toNumber(source.since_inception_nav),
  });
  const monthEnd = mapReturn(monthly, valueFrom(fund, 'monthly_performance_as_of_date'));
  const quarterEnd = mapReturn(quarterly, valueFrom(fund, 'quarterly_performance_as_of_date'));
  const cagr3y = toNumber(monthly.threeyear_nav), cagr5y = toNumber(monthly.fiveyear_nav), cagr10y = toNumber(monthly.tenyear_nav);
  const total = (cagr: number | null, years: number): number | null => cagr === null ? null : round(((1 + cagr / 100) ** years - 1) * 100, 2);
  return {
    monthEnd, quarterEnd,
    metrics: {
      tr1y: toNumber(monthly.oneyear_nav), tr3y: total(cagr3y, 3), tr5y: total(cagr5y, 5), tr10y: total(cagr10y, 10),
      cagr3y, cagr5y, cagr10y, siAnn: toNumber(monthly.since_inception_nav),
      dividendYield: fund.dividendYield, dividendYieldText: fund.dividendYield === null ? null : formatPercent(fund.dividendYield),
      secYield: fund.secYield, secYieldText: fund.secYield === null ? null : formatPercent(fund.secYield),
    },
  };
}
function catalogIndexEntry(fund: Fund, previous: JsonRecord | undefined): JsonRecord {
  const meta = previous;
  const returns = returnsFromCatalog(fund);
  const raw = (key: string): unknown => fund[key];
  const nav = toNumber(raw('latest_nav'));
  const close = toNumber(raw('market_close'));
  const aum = toNumber(raw('net_assets'));
  const ter = toNumber(raw('gross_exp_ratio'));
  const inception = displayDate(raw('inception_date'));
  const aumDisplay = formatMoney(aum);
  const holdings = isRecord(meta?.holdings) ? toNumber(meta.holdings.totalRows) ?? 0 : 0;
  const history = isRecord(meta?.history) ? toNumber(meta.history.totalRows) ?? 0 : 0;
  const yieldMeta = isRecord(meta?.yields) ? meta.yields : {};
  const dividendYield = toNumber(yieldMeta.dividendYield) ?? toNumber(meta?.dividendYield) ?? fund.dividendYield;
  const secYield = toNumber(yieldMeta.secYield) ?? toNumber(meta?.secYield) ?? fund.secYield;
  const metrics = { ...returns.metrics, dividendYield, secYield };
  const distributionMeta = isRecord(meta?.distributions) ? meta.distributions : {};
  return {
    ticker: fund.ticker, name: fund.name, category: fund.category, fundPage: fundPageUrl(fund), dataFile: `./funds/${fund.ticker}/meta.json`,
    ter: formatPercent(ter), terValue: ter, nav: nav === null ? '—' : `$${nav.toFixed(2)}`, navValue: nav,
    aum: aumDisplay, aumValue: aum, asOfDate: displayDate(raw('nav_as_of')),
    inceptionDate: inception, exchange: cleanText(raw('exchange')) || '—',
    closePrice: close === null ? '—' : `$${close.toFixed(2)}`,
    premiumDiscount: formatPercent(toNumber(raw('premium_discount_percentage'))),
    cusip: cleanText(raw('cusip')) || null, isin: cleanText(raw('isin')) || null,
    distributions: { frequency: distributionMeta.frequency ?? null, exDate: '', dividend: distributionMeta.latestAmount ?? '' },
    returns: { monthEnd: returns.monthEnd, quarterEnd: returns.quarterEnd }, metrics,
    holdings, history,
  };
}
function metricForFilter(fund: Fund, period: string, total: boolean): number | null {
  const monthly = isRecord(fund.performance) && isRecord(fund.performance.monthly) ? fund.performance.monthly : {};
  const key: Record<string, string> = { YTD: 'ytd_nav', '1Y': 'oneyear_nav', '3Y': 'threeyear_nav', '5Y': 'fiveyear_nav', '10Y': 'tenyear_nav' };
  const value = toNumber(monthly[key[period]]);
  if (value === null || !total || period === 'YTD' || period === '1Y') return value;
  return round(((1 + value / 100) ** Number.parseInt(period, 10) - 1) * 100, 2);
}
function fundPasses(fund: Fund, config: Config): boolean {
  if (!inRange(fund.aumValue, config.aum) || !inRange(fund.terValue, config.ter) || !inRange(fund.dividendYield, config.dividendYield) || !inRange(fund.secYield, config.secYield)) return false;
  return RETURN_PERIODS.every(period => inRange(metricForFilter(fund, period, false), config.performance[period]) && inRange(metricForFilter(fund, period, true), config.totalReturn[period]));
}

async function createMeta(fund: Fund, key: string, config: Config): Promise<JsonRecord> {
  const [holdPayload, distributionPayload, overviewPayload, yieldPayload, pdPayload] = await Promise.all([
    fetchProduct(fund.ticker, 'AllHoldings', key, config).catch(error => { outputNote(`[ holdings ] ${fund.ticker}: ${String(error)}`); return null; }),
    fetchProduct(fund.ticker, 'Distributions', key, config).catch(error => { outputNote(`[ history  ] ${fund.ticker} distributions: ${String(error)}`); return null; }),
    fetchProduct(fund.ticker, 'Overview', key, config).catch(error => { outputNote(`[ product  ] ${fund.ticker} overview: ${String(error)}`); return null; }),
    fetchProduct(fund.ticker, 'Yields', key, config).catch(error => { outputNote(`[ product  ] ${fund.ticker} yields: ${String(error)}`); return null; }),
    fetchProduct(fund.ticker, 'PremiumDiscount', key, config).catch(error => { outputNote(`[ history  ] ${fund.ticker} premium/discount: ${String(error)}`); return null; }),
  ]);
  const overview = isRecord(overviewPayload) ? overviewPayload : {};
  const yields = isRecord(yieldPayload) ? yieldPayload : {};
  let distributions = parseDistributionPayload(distributionPayload);
  let distributionSource = 'VCM Distributions JSON (declared, record, payable dates and reported amount fields)';
  if (!distributions.rows.length) {
    const priorMeta = await readJson(new URL(`funds/${fund.ticker}/meta.json`, API_ROOT));
    const prior = isRecord(priorMeta) && isRecord(priorMeta.distributions) ? priorMeta.distributions : null;
    if (prior && Array.isArray(prior.rows) && prior.rows.length) {
      const headers = Array.isArray(prior.headers) ? prior.headers.map(String) : [];
      const rows = prior.rows.filter(Array.isArray).map(row => row.map(String));
      distributions = {
        headers: headers.length ? headers : distributions.headers, rows,
        frequency: typeof prior.frequency === 'string' ? prior.frequency : null,
        latest: toNumber(prior.latestAmount), date: typeof prior.latestDate === 'string' ? prior.latestDate : null,
      };
      distributionSource = 'previously published VCM distributions (retained because the current response was empty/unavailable)';
    }
  }
  const official = parseHoldings(holdPayload);
  let holdRows = official.rows, holdingSource = 'VCM AllHoldings JSON';
  let holdingsAsOf = official.asOfDate;
  if (!holdRows.length) {
    const sec = await fetchEdgarHoldings(fund.ticker, config);
    if (sec.rows.length) { holdRows = sec.rows; holdingsAsOf = sec.asOfDate; holdingSource = `SEC EDGAR N-PORT-P (Victory Portfolios II, CIK 0001547580; ${sec.asOfDate ?? 'report date unavailable'})`; }
  }
  if (!holdRows.length) {
    const previous = await previousRows(fund.ticker, 'holdings');
    if (previous.rows.length) { holdRows = previous.rows; holdingSource = 'previously published VictoryShares holdings (source fallback)'; }
  }
  const previousHistory = await previousRows(fund.ticker, 'history');
  let days: ChartDay[] = [], freshHistory = false;
  if (!config.skipYahoo) {
    try { days = await fetchYahoo(fund.ticker, config.historyRange, config); freshHistory = days.length > 0; }
    catch (error) { outputNote(`[ chart    ] ${fund.ticker}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!days.length && previousHistory.rows.length) {
    days = previousHistory.rows.map(row => ({ date: row.Date ?? '', close: toNumber(row['Market Price']), adjClose: toNumber(row['Adj Close']), dividend: null })).filter(row => Boolean(row.date));
  }
  const premium = parsePremiumDiscount(pdPayload);
  const hManifest = await writePages(fund.ticker, 'holdings', official.headers, holdRows, config.holdingsPageSize, holdingsAsOf, holdingSource);
  const hRows = freshHistory ? historyRows(days, premium) : previousHistory.rows;
  const historySource = freshHistory ? 'Yahoo Finance adjusted market-price chart + VCM PremiumDiscount API (NAV is not provided in the Yahoo price series)' : previousHistory.rows.length ? 'previously published history retained because Yahoo was unavailable or skipped' : 'Yahoo Finance history unavailable; no prior history has been published';
  const yManifest = await writePages(fund.ticker, 'history', HISTORY_HEADERS, hRows, config.historyPageSize, days.at(-1)?.date ?? null, historySource);
  const returns = returnsFromCatalog(fund);
  const nav = toNumber(valueFrom(overview, 'latest_nav')) ?? fund.navValue;
  const navChange = toNumber(valueFrom(overview, 'nav_change'));
  const market = toNumber(valueFrom(fund, 'market_close'));
  const aum = toNumber(valueFrom(overview, 'net_assets')) ?? fund.aumValue;
  const terGross = toNumber(fund.gross_exp_ratio), terNet = toNumber(fund.net_expense_ratio);
  const secYield = toNumber(valueFrom(yields, 'thirtyday_sec_yield')) ?? fund.secYield;
  const declaredYield = toNumber(valueFrom(yields, 'dividend_yield_percentage')) ?? fund.dividendYield;
  const annualPayments: Record<string, number> = { Monthly: 12, Quarterly: 4, 'Semi-annually': 2, Annually: 1 };
  const indicatedYield = distributions.latest !== null && distributions.frequency && annualPayments[distributions.frequency] && market !== null && market > 0
    ? round((distributions.latest * annualPayments[distributions.frequency] / market) * 100, 2) : null;
  const dividendYield = declaredYield ?? indicatedYield;
  const meta: JsonRecord = {
    ticker: fund.ticker, name: fund.name, category: fund.category,
    source: {
      fundPage: fundPageUrl(fund), catalog: ISSUER_LIST_PAGE, issuerOverview: ISSUER_OVERVIEW_PAGE,
      catalogApi: ISSUER_API_FALLBACK, productApi: `${VCM_API}/{TICKER}/{AllHoldings|Overview|Yields|Distributions|PremiumDiscount}`,
      yahooChart: `${YAHOO_CHART}/${fund.ticker}`, holdingsSource: holdingSource, historySource,
      distributionSource,
      provider: 'Victory Capital Management / VictoryShares public JSON + Yahoo Finance chart + SEC EDGAR N-PORT-P (holdings fallback only)',
    },
    identifiers: { cusip: cleanText(fund.cusip) || null, isin: cleanText(fund.isin) || cleanText(overview.isin) || null, iopv: cleanText(fund.iopv) || null },
    inception: { fundInceptionDate: toIsoDate(fund.inception_date) || null, shareClassInceptionDate: toIsoDate(fund.inception_date) || null, exchange: cleanText(fund.exchange) || null },
    expenseRatio: { display: formatPercent(terGross), value: terGross, gross: terGross, net: terNet },
    nav: { display: nav === null ? null : `$${nav.toFixed(2)}`, value: nav, asOfDate: displayDate(valueFrom(overview, 'as_of', 'nav_as_of') ?? fund.nav_as_of), change: navChange },
    marketPrice: { display: market === null ? null : `$${market.toFixed(2)}`, value: market, asOfDate: displayDate(fund.nav_as_of) },
    premiumDiscount: { display: formatPercent(toNumber(fund.premium_discount_percentage)), value: toNumber(fund.premium_discount_percentage) },
    aum: { display: formatMoney(aum), value: aum, asOfDate: displayDate(valueFrom(overview, 'as_of') ?? fund.nav_as_of), source: 'VCM ETF catalog / Overview JSON' },
    yields: {
      dividendYield, dividendYieldText: dividendYield === null ? null : formatPercent(dividendYield),
      dividendYieldKind: declaredYield !== null
        ? `VCM published dividend yield${displayDate(valueFrom(yields, 'dividend_yield_percentage_as_of_date', 'as_of_date')) ? ` as of ${displayDate(valueFrom(yields, 'dividend_yield_percentage_as_of_date', 'as_of_date'))}` : ''}`
        : indicatedYield !== null ? 'Indicated from the latest reported distribution per share x inferred payments per year / market price' : null,
      distributionRate: toNumber(yields.twelve_month_distribution_rate), secYield, secYieldText: secYield === null ? null : formatPercent(secYield),
      secYieldKind: secYield === null ? null : `VCM 30-day SEC yield as of ${displayDate(valueFrom(yields, 'as_of_date') ?? fund.nav_as_of)}`,
      unsubsidizedSecYield: toNumber(yields.thirtyday_sec_unsubsidized_yield),
    },
    returns: { derivedFrom: 'VCM published NAV performance series', monthEnd: returns.monthEnd, quarterEnd: returns.quarterEnd },
    distributions: {
      frequency: distributions.frequency, latestAmount: distributions.latest,
      asOfDate: displayDate(isRecord(distributionPayload) ? distributionPayload.as_of_date : null),
      headers: distributions.headers, rows: distributions.rows,
      source: 'VCM Distributions API; API provides declared/record/payable dates, not an ex-date field',
    },
    holdings: hManifest, history: yManifest,
    holdingsCount: hManifest.totalRows, historyCount: yManifest.totalRows, distributionCount: distributions.rows.length,
    netAssets: aum, dividendYield, secYield,
  };
  return meta;
}

async function mergePreviousFund(fund: Fund, previous: JsonRecord | undefined): Promise<Fund> {
  if (previous) {
    const holds = isRecord(previous.holdings) ? toNumber(previous.holdings.totalRows) : null;
    const history = isRecord(previous.history) ? toNumber(previous.history.totalRows) : null;
    fund.holdings = holds ?? 0; fund.history = history ?? 0;
    const dist = isRecord(previous.distributions) ? previous.distributions : {};
    fund.distributions = { frequency: dist.frequency ?? null, exDate: '', dividend: dist.latestAmount ?? '' };
  } else { fund.holdings = 0; fund.history = 0; fund.distributions = { frequency: null, exDate: '', dividend: '' }; }
  return fund;
}

async function processFund(fund: Fund, key: string, config: Config, reporter: ReturnType<typeof outputCreateReporter>): Promise<JsonRecord> {
  const before = await outputInspectFund(fund.ticker);
  let meta: JsonRecord;
  try { meta = await createMeta(fund, key, config); }
  catch (error) {
    const previous = before.meta;
    meta = Object.keys(previous).length ? previous : { ticker: fund.ticker, name: fund.name, holdings: { pages: [], totalRows: 0 }, history: { pages: [], totalRows: 0 }, distributions: { headers: [], rows: [] } };
    await reporter.result(fund.ticker, before, meta, 'failed', error instanceof Error ? error.message : String(error));
    return meta;
  }
  await writeJsonIfChanged(new URL(`funds/${fund.ticker}/meta.json`, API_ROOT), meta);
  await reporter.result(fund.ticker, before, meta);
  return meta;
}
async function mapWithConcurrency<T>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) { const index = next++; if (index >= items.length) return; await work(items[index], index); }
  });
  await Promise.all(workers);
}
function printHelp(): void {
  console.log(`VictoryShares ETF updater\n\nUsage: bun ./scripts/update-data.ts [--help]\n\nEnvironment controls:\n  MAX_FETCHES=0             Number of funds to process (0 = all eligible; resumes after saved ticker cursor)\n  TICKERS="VFLO USTB UEVM" Only process the named tickers\n  REQUEST_SLEEP=1           Minimum seconds between request starts per worker lane\n  CONCURRENCY=2             Parallel fund workers (default conservative)\n  MAX_RETRIES=2             Retries after initial request\n  HOLDINGS_PAGE_SIZE=250    Rows per static holdings page\n  HISTORY_PAGE_SIZE=1000    Rows per static price-history page\n  HISTORY_RANGE=max         Yahoo range: max, 10y, 5y, 2y, 1y, 6mo or 3mo\n  AUM=:                     AUM min:max (K/M/B/T suffixes) or nano/micro/small/mid/large\n  TER=: DIVIDEND_YIELD=: SEC_YIELD=:  Inclusive numeric min:max percentages\n  PERFORMANCE_{YTD,1Y,3Y,5Y,10Y}=: Annualized NAV-return filters\n  TOTAL_RETURN_{YTD,1Y,3Y,5Y,10Y}=: Cumulative-return filters\n  EDGAR_FALLBACK=1          Use SEC N-PORT-P only if official holdings are unavailable\n  SEC_UA=<contact>          Required valid SEC User-Agent/contact for EDGAR fallback requests\n  SKIP_YAHOO=1              Do not call Yahoo; retain prior history if available\n  VERBOSE=1                 Show per-request retry/fallback details\n`);
}

async function main(): Promise<void> {
  if (process.argv.some(arg => arg === '-h' || arg === '--help')) { printHelp(); return; }
  const config = readConfig();
  requestSleepMs = config.requestSleep * 1000;
  laneTimes = new Array(Math.max(1, config.concurrency)).fill(0);
  outputPrintConfig(config);
  const previous = await previousIndex();
  let catalog: Fund[] = [];
  let api: { endpoint: string; apiKey: string } | null = null;
  try {
    api = await loadApiKey(config);
    catalog = parseCatalog(await getJson(api.endpoint, '[catalog  ] VictoryShares ETF list', issuerApiHeaders(api.apiKey), config));
    console.log(`[ catalog  ] ${catalog.length} VictoryShares ETFs (VCM public ETF JSON API)`);
  } catch (error) {
    console.warn(`[ catalog  ] ${error instanceof Error ? error.message : String(error)} — retaining the published catalog`);
  }
  let usingCachedCatalog = false;
  if (!catalog.length) {
    usingCachedCatalog = true;
    catalog = [...previous.values()].map(cachedFundFromIndex).filter(fund => Boolean(fund.ticker));
  }
  if (!catalog.length) throw new Error('No current or previously published catalog is available');
  if (!usingCachedCatalog) {
    const known = new Set(catalog.map(fund => fund.ticker));
    for (const item of previous.values()) if (!known.has(String(item.ticker ?? ''))) catalog.push(cachedFundFromIndex(item));
  }
  const catalogWithCachedCounts = await Promise.all(catalog.map(fund => mergePreviousFund(fund, previous.get(fund.ticker))));
  const fullCatalog = catalogWithCachedCounts;
  catalog = catalogWithCachedCounts;
  const deferredDividend = config.dividendYield.min !== undefined || config.dividendYield.max !== undefined;
  const deferredSec = config.secYield.min !== undefined || config.secYield.max !== undefined;
  for (const fund of fullCatalog) {
    const cached = previous.get(fund.ticker);
    const oldMetrics = isRecord(cached?.metrics) ? cached.metrics : {};
    if (fund.dividendYield === null) fund.dividendYield = toNumber(oldMetrics.dividendYield);
    if (fund.secYield === null) fund.secYield = toNumber(oldMetrics.secYield);
  }
  const deferredFunds = fullCatalog.filter(fund => (deferredDividend && fund.dividendYield === null) || (deferredSec && fund.secYield === null));
  let filtersDeferred = false;
  if (api && deferredFunds.length) {
    filtersDeferred = true;
    const apiKey = api.apiKey;
    await mapWithConcurrency(deferredFunds, config.concurrency, async fund => {
      const [yieldPayload, distPayload] = await Promise.all([
        fetchProduct(fund.ticker, 'Yields', apiKey, config).catch(() => null),
        deferredDividend && fund.dividendYield === null ? fetchProduct(fund.ticker, 'Distributions', apiKey, config).catch(() => null) : Promise.resolve(null),
      ]);
      const yields = isRecord(yieldPayload) ? yieldPayload : {};
      if (fund.secYield === null) fund.secYield = toNumber(yields.thirtyday_sec_yield);
      if (fund.dividendYield === null) {
        const sourceYield = toNumber(yields.dividend_yield_percentage);
        const parsed = parseDistributionPayload(distPayload);
        const payments: Record<string, number> = { Monthly: 12, Quarterly: 4, 'Semi-annually': 2, Annually: 1 };
        const marketPrice = toNumber(fund.market_close);
        const indicated = sourceYield ?? (parsed.latest !== null && parsed.frequency && payments[parsed.frequency] && marketPrice !== null && marketPrice > 0
          ? round(parsed.latest * payments[parsed.frequency] / marketPrice * 100, 2) : null);
        fund.dividendYield = indicated;
      }
    });
  }
  const eligible = fullCatalog.filter(fund => fundPasses(fund, config));
  const selectedByTicker = config.tickers.size ? eligible.filter(fund => config.tickers.has(fund.ticker)) : eligible;
  outputPrintFilter(selectedByTicker.length, fullCatalog.length, filtersDeferred);
  if (config.tickers.size) {
    const missing = [...config.tickers].filter(ticker => !fullCatalog.some(fund => fund.ticker === ticker));
    if (missing.length) throw new Error(`Requested ticker(s) not in VCM catalog: ${missing.join(', ')}`);
    const filtered = [...config.tickers].filter(ticker => fullCatalog.some(fund => fund.ticker === ticker && !eligible.includes(fund)));
    if (filtered.length) throw new Error(`Requested ticker(s) were excluded by configured filters: ${filtered.join(', ')}`);
  }
  let selected = selectedByTicker;
  if (!config.tickers.size && config.maxFetches > 0 && selected.length > config.maxFetches) {
    const cursor = await readCursor();
    const start = Math.max(0, selected.findIndex(fund => fund.ticker > cursor) || 0);
    const rotated = [...selected.slice(start), ...selected.slice(0, start)];
    selected = rotated.slice(0, config.maxFetches);
  }
  const oldEntries = new Map(previous);
  const savedMeta = new Map<string, JsonRecord>();
  const reporter = outputCreateReporter(selected.length);
  const activeApiKey = api?.apiKey ?? '';
  await mapWithConcurrency(selected, config.concurrency, async fund => {
    if (!api) {
      const before = await outputInspectFund(fund.ticker);
      const meta = before.meta;
      savedMeta.set(fund.ticker, meta);
      await reporter.result(fund.ticker, before, meta, Object.keys(meta).length ? 'unchanged' : 'failed', Object.keys(meta).length ? '' : 'no provider access or cached fund data');
      return;
    }
    savedMeta.set(fund.ticker, await processFund(fund, activeApiKey, config, reporter));
  });
  const indexFunds: JsonRecord[] = [];
  for (const fund of fullCatalog) {
    const existing = oldEntries.get(fund.ticker);
    const wasRequested = selected.some(item => item.ticker === fund.ticker);
    if (existing && (usingCachedCatalog || (config.tickers.size > 0 && !wasRequested))) { indexFunds.push(existing); continue; }
    const previousMeta = savedMeta.get(fund.ticker) ?? oldEntries.get(fund.ticker);
    const entry = catalogIndexEntry(fund, previousMeta);
    if (!selected.some(item => item.ticker === fund.ticker) && existing) {
      // Preserve all non-catalog derived fields for unrequested funds.
      entry.holdings = existing.holdings ?? entry.holdings;
      entry.history = existing.history ?? entry.history;
      entry.distributions = existing.distributions ?? entry.distributions;
    }
    indexFunds.push(entry);
  }
  const totalHoldings = indexFunds.reduce((sum, row) => sum + (toNumber(row.holdings) ?? 0), 0);
  const totalHistory = indexFunds.reduce((sum, row) => sum + (toNumber(row.history) ?? 0), 0);
  const indexValue = {
    generatedAt: new Date().toISOString(),
    source: {
      provider: 'VictoryShares ETFs (Victory Capital Management)', market: 'us', site: 'https://www.vcm.com',
      catalog: ISSUER_LIST_PAGE, issuerOverview: ISSUER_OVERVIEW_PAGE,
      catalogApi: ISSUER_API_FALLBACK, productApi: `${VCM_API}/{TICKER}/{AllHoldings|Overview|Yields|Distributions|PremiumDiscount}`,
      history: 'Yahoo Finance public chart API (adjusted market-price history; not official NAV)',
      holdings: 'VCM AllHoldings JSON; SEC EDGAR Form N-PORT-P for Victory Portfolios II (CIK 0001547580) as fallback',
    },
    counts: { funds: indexFunds.length, holdings: totalHoldings, history: totalHistory },
    funds: indexFunds,
  };
  const changed = await writeJsonIfChanged(INDEX_FILE, indexValue);
  if (config.maxFetches > 0 && !config.tickers.size && selected.length) {
    await writeJsonIfChanged(STATE_FILE, { lastProcessedTicker: selected.at(-1)?.ticker ?? null });
  }
  const result = reporter.summary();
  console.log(`[ done     ] ${result.updated} funds updated, ${result.failures} failures`);
  console.log(`[ done     ] counts: evaluated=${result.completed} unchanged=${result.unchanged} funds=${indexFunds.length} holdings=${totalHoldings} history=${totalHistory} index=${changed ? 'updated' : 'unchanged'}`);
}

if (import.meta.main) {
  main().catch(error => { console.error(`[ done     ] fatal: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}

// Exported deterministic normalization for tests.
export function formatFrequencyPlaceholder(value: unknown): string {
  const raw = String(value ?? '').trim();
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\\s+/g, ' ');
  if (!normalized || normalized === '-') return '00 - None';
  if (normalized === 'monthly') return '01 - Monthly';
  if (normalized === 'quarterly') return '04 - Quarterly';
  if (normalized === 'semi-annual' || normalized === 'semi-annually' || normalized === 'semiannual') return '06 - Semi-annually';
  if (normalized === 'annual' || normalized === 'annually') return '12 - Annually';
  if (normalized === 'none') return '00 - None';
  if (normalized === 'unknown') return '00 - Unknown';
  if (normalized === 'irregular') return '99 - Irregular';
  return raw;
}
