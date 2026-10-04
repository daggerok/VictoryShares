#!/usr/bin/env bun
/// <reference types="bun" />
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';


// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

/** VictoryShares static data updater. Bun only; official VCM JSON + Yahoo + optional SEC N-PORT-P. */

type JsonRecord = Record<string, unknown>;
type Range = { min?: number; max?: number; source: string };
type Fund = JsonRecord & {
  ticker: string; name: string; category: string; navValue: number | null; aumValue: number | null;
  terValue: number | null; terGrossValue: number | null; dividendYield: number | null; secYield: number | null;
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
const DEFAULT_API_ROOT = new URL('../api/victoryshares/', import.meta.url);
let apiRoot = DEFAULT_API_ROOT;
/** Redirect every read and write (tests only; the production output directory is fixed). */
export function useApiRoot(url: URL): void { apiRoot = url; }
const indexUrl = (): URL => new URL('index.json', apiRoot);
const stateUrl = (): URL => new URL('update-state.json', apiRoot);
const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category', 'Coupon', 'Maturity'];
const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount', 'Adj Close'];
const RETURN_PERIODS = ['YTD', '1Y', '3Y', '5Y', '10Y'];
const DEFAULT_SEC_UA = 'daggerok ETF feed daggerok@gmail.com';
const SOFT_DEADLINE_MS = 25 * 60 * 1000;
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
  const dir = new URL(`funds/${ticker}/`, apiRoot);
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
/** HISTORY_RANGE is `max` or a whole number of years such as `5y` (1-99). */
export function parseHistoryRange(value: string | undefined): string {
  const text = value?.trim() ?? '';
  if (!text) return 'max';
  const normalized = text.toLowerCase();
  if (normalized === 'max' || /^[1-9]\d?y$/.test(normalized)) return normalized;
  throw new Error('HISTORY_RANGE: expected max or Ny (for example 10y, 5y, 1y)');
}
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const performance: Record<string, Range> = {}, totalReturn: Record<string, Range> = {};
  for (const period of RETURN_PERIODS) {
    performance[period] = parseRange(env[`PERFORMANCE_${period}`], `PERFORMANCE_${period}`);
    totalReturn[period] = parseRange(env[`TOTAL_RETURN_${period}`], `TOTAL_RETURN_${period}`);
  }
  const tickers = new Set((env.TICKERS ?? '').split(/[\s,]+/).map(tickerClean).filter(Boolean));
  const range = (key: string): Range => parseRange(env[key], key);
  return {
    maxFetches: parsePositiveInt(env.MAX_FETCHES, 0), requestSleep: parseDecimal(env.REQUEST_SLEEP, DEFAULTS.requestSleep),
    concurrency: Math.max(1, parsePositiveInt(env.CONCURRENCY, DEFAULTS.concurrency)), maxRetries: Math.max(1, parsePositiveInt(env.MAX_RETRIES, DEFAULTS.maxRetries)),
    holdingsPageSize: Math.max(1, parsePositiveInt(env.HOLDINGS_PAGE_SIZE, DEFAULTS.holdingsPageSize)),
    historyPageSize: Math.max(1, parsePositiveInt(env.HISTORY_PAGE_SIZE, DEFAULTS.historyPageSize)),
    historyRange: parseHistoryRange(env.HISTORY_RANGE), tickers, aum: parseAumRange(env.AUM), ter: range('TER'),
    dividendYield: range('DIVIDEND_YIELD'), secYield: range('SEC_YIELD'), performance, totalReturn,
    edgarFallback: !/^(0|false|no|off)$/i.test(env.EDGAR_FALLBACK ?? '1'),
    skipYahoo: /^(1|true|yes|on)$/i.test(env.SKIP_YAHOO ?? ''),
    // A blank SEC_UA never disables EDGAR silently: the standard contact applies.
    secUa: env.SEC_UA?.trim() || DEFAULT_SEC_UA,
  };
}

// File defaults and explicit overrides, same mechanism as the sibling updaters:
// allowlisted scalar controls only, so GitHub Actions can resolve them without
// interpolating user input into bash. Precedence: config file < advanced JSON <
// nonblank inputs < environment.
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE',
  'TICKERS', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap(prefix => RETURN_PERIODS.map(period => `${prefix}_${period}`)),
  'EDGAR_FALLBACK', 'SKIP_YAHOO', 'VERBOSE', 'USE_SYSTEM_CA', 'SEC_UA',
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
// Environment aliases of every control: VICTORYSHARES_<NAME> plus the legacy HISTORICAL_PAGE_SIZE. They sit in the
// environment layer; the plain name wins when both are set, and an explicitly empty alias counts as set.
export const ENV_ALIASES: Record<string, string[]> = { HISTORY_PAGE_SIZE: ['HISTORICAL_PAGE_SIZE'] };
export const envNames = (key: string): string[] => [key, `VICTORYSHARES_${key}`, ...(ENV_ALIASES[key] ?? [])];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = envNames(key).map(name => env[name]).find(candidate => candidate !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'MAX_RETRIES', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE']) {
    const v = result[key];
    if (v === undefined || v === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['EDGAR_FALLBACK', 'SKIP_YAHOO', 'VERBOSE']) {
    if (result[key] && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key])) throw new Error(`${key}: expected boolean`);
  }
  if (result.USE_SYSTEM_CA && !/^(auto|true|false)$/i.test(result.USE_SYSTEM_CA)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
  readConfig(result); // validate HISTORY_RANGE and every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
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
    // terValue is the NET expense ratio (after waivers); the gross ratio travels beside it.
    const grossValue = toNumber(raw.gross_exp_ratio);
    const terValue = toNumber(raw.net_expense_ratio) ?? grossValue;
    const terGrossValue = toNumber(raw.net_expense_ratio) === null ? null : grossValue;
    const yieldValue = toNumber(raw['30day_sec_yield']);
    result.push({
      ...raw, ticker, name,
      category: cleanText(raw.asset_class) || 'Uncategorized',
      navValue, aumValue, terValue, terGrossValue,
      dividendYield: toNumber(raw.dividend_yield_percentage),
      secYield: yieldValue,
    });
  }
  return result.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** ISO YYYY-MM-DD from an ISO/US date or a published display date such as "Aug 31 2026"; null when unparseable. */
export function performanceDateIso(value: unknown): string | null {
  const iso = toIsoDate(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const match = /^([A-Za-z]{3}) (\d{1,2}) (\d{4})$/.exec(iso);
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  return match && month >= 0 ? `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}` : null;
}

export const RETURNS_BASIS = 'official VictoryShares (VCM) NAV returns from the published month-end performance table; cumulative 3-, 5- and 10-year total returns derived from the published annualized NAV returns; yields are issuer-published; Yahoo market-price history is not used for returns';

export function cachedFundFromIndex(item: JsonRecord): Fund {
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
    terGrossValue: toNumber(item.terGrossValue),
    gross_exp_ratio: item.terGrossValue ?? item.terValue, net_expense_ratio: item.terValue,
    inception_date: isoFromDisplay(item.inceptionDate),
    performance: { monthly: toSourceReturns(monthEnd), quarterly: toSourceReturns(quarterEnd) },
    monthly_performance_as_of_date: monthEnd.asOfDate,
    quarterly_performance_as_of_date: quarterEnd.asOfDate,
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
      Weight: cleanText(raw.portfolio_percentage), 'Market Value': cleanText(raw.market_value),
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
    const value = tag(body, 'valUSD') || tag(body, 'curVal');
    rows.push({ Name: name, Ticker: '-', Identifier: identifier, Weight: tag(body, 'pctVal'), 'Market Value': value, 'Shares Held': tag(body, 'balance') || '-', 'Asset Category': tag(body, 'assetCat') || '-', Coupon: '-', Maturity: '-' });
  }
  return rows;
}

function fundSlug(name: string): string {
  return `victoryshares-${name.replace(/^VictoryShares\s*/i, '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-')}`;
}
function fundPageUrl(fund: Fund): string { return `${ISSUER_LIST_PAGE}/${fundSlug(fund.name)}`; }
function valueFrom(record: JsonRecord, ...keys: string[]): unknown { for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key]; return null; }
function pageFile(kind: 'holdings' | 'history', page: number): string { return `${kind}/${String(page + 1).padStart(3, '0')}.json`; }
export function buildPages<T>(rows: T[], pageSize: number): T[][] {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer');
  const pages: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += pageSize) pages.push(rows.slice(offset, offset + pageSize));
  return pages;
}
export function pageBasenames(paths: string[]): Set<string> { return new Set(paths.map(path => path.split('/').at(-1) ?? path)); }
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** ISO timestamp without milliseconds. */
const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

async function readJson(url: URL): Promise<unknown> { return readFile(url, 'utf8').then(JSON.parse).catch(() => null); }
async function samePublishedContent(url: URL, value: unknown): Promise<boolean> {
  const previous = await readJson(url);
  return previous !== null && outputContentKey(previous) === outputContentKey(value);
}
/** Write through a temporary file and rename so readers never see a half-written JSON file. */
async function writeJsonAtomic(url: URL, value: unknown): Promise<void> {
  await mkdir(new URL('.', url), { recursive: true });
  const tmp = new URL(`${url.pathname.split('/').at(-1)}.${process.pid}.tmp`, url);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
    await rename(tmp, url);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
/** Writes only when the content (ignoring generatedAt/catalogReadAt stamps) changed. */
async function writeJsonIfChanged(url: URL, value: unknown): Promise<boolean> {
  if (await samePublishedContent(url, value)) return false;
  await writeJsonAtomic(url, value);
  return true;
}

type PagePlan = { kind: 'holdings' | 'history'; headers: string[]; rows: SheetRow[]; size: number; asOfDate: string | null; source: string };
function planManifest(plan: PagePlan): PageManifest {
  return { pages: buildPages(plan.rows, plan.size).map((_, index) => pageFile(plan.kind, index)), pageSize: plan.size, totalRows: plan.rows.length, asOfDate: plan.asOfDate, source: plan.source };
}
async function writePlanPages(ticker: string, plan: PagePlan): Promise<void> {
  const dir = new URL(`funds/${ticker}/`, apiRoot);
  for (const [index, chunk] of buildPages(plan.rows, plan.size).entries()) {
    await writeJsonIfChanged(new URL(pageFile(plan.kind, index), dir), { headers: plan.headers, rows: chunk, asOfDate: plan.asOfDate });
  }
}
/** Stale pages go only after the new meta.json (which no longer references them) is on disk. */
async function removeStalePages(ticker: string, kind: 'holdings' | 'history', pages: string[]): Promise<void> {
  const keep = pageBasenames(pages);
  const folder = new URL(`funds/${ticker}/${kind}/`, apiRoot);
  for (const entry of await readdir(folder).catch(() => [])) if (entry.endsWith('.json') && !keep.has(entry)) await rm(new URL(entry, folder), { force: true });
}
async function previousRows(ticker: string, kind: 'holdings' | 'history'): Promise<{ headers: string[]; rows: SheetRow[] }> {
  const meta = await readJson(new URL(`funds/${ticker}/meta.json`, apiRoot));
  const root = isRecord(meta) ? meta[kind] : null;
  if (!isRecord(root) || !Array.isArray(root.pages)) return { headers: kind === 'holdings' ? HOLDINGS_HEADERS : HISTORY_HEADERS, rows: [] };
  let headers: string[] = [], rows: SheetRow[] = [];
  for (const name of root.pages) {
    if (typeof name !== 'string') continue;
    const page = await readJson(new URL(`funds/${ticker}/${name}`, apiRoot));
    if (!isRecord(page)) continue;
    if (Array.isArray(page.headers)) headers = page.headers.filter((value): value is string => typeof value === 'string');
    if (Array.isArray(page.rows)) rows.push(...page.rows.filter(isRecord).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? '')]))));
  }
  return { headers: headers.length ? headers : kind === 'holdings' ? HOLDINGS_HEADERS : HISTORY_HEADERS, rows };
}
async function previousIndex(): Promise<Map<string, JsonRecord>> {
  const data = await readJson(indexUrl());
  const funds = isRecord(data) && Array.isArray(data.funds) ? data.funds : [];
  const result = new Map<string, JsonRecord>();
  for (const item of funds) if (isRecord(item) && typeof item.ticker === 'string') result.set(item.ticker, item);
  return result;
}
async function readCursor(): Promise<string> {
  const state = await readJson(stateUrl());
  return isRecord(state) && typeof state.lastProcessedTicker === 'string' ? state.lastProcessedTicker : '';
}

// One independently paced lane per worker. A slot is reserved synchronously (before any await),
// so concurrent callers can never claim the same lane slot.
let laneTimes: number[] = [0];
let requestSleepMs = 1000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export async function paceRequest(): Promise<void> {
  let lane = 0;
  for (let i = 1; i < laneTimes.length; i++) if (laneTimes[i] < laneTimes[lane]) lane = i;
  const now = Date.now();
  const start = Math.max(now, laneTimes[lane]);
  laneTimes[lane] = start + requestSleepMs;
  if (start > now) await sleep(start - now);
}
export function configureLanes(lanes: number, sleepSeconds: number): void {
  laneTimes = new Array(Math.max(1, lanes)).fill(0);
  requestSleepMs = sleepSeconds * 1000;
}
/** Network knobs; tests shrink them. The timeout covers the response headers AND the body. */
export const httpSettings = { timeoutMs: 45000, backoffMs: 750 };
function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) { abort(); work.catch(() => undefined); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const RETRYABLE_STATUS = (status: number): boolean => status >= 500 || status === 429 || status === 408 || status === 425;
export async function getText(url: string, label: string, headers: Record<string, string>, config: Config, retries = config.maxRetries): Promise<string> {
  let last: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await paceRequest();
    const signal = AbortSignal.timeout(httpSettings.timeoutMs);
    try {
      const response = await raceSignal(fetch(url, { headers, redirect: 'follow', signal }), signal);
      if (response.ok) return await raceSignal(response.text(), signal);
      const body = await raceSignal(response.text(), signal).catch(() => '');
      last = Object.assign(new Error(`HTTP ${response.status} ${response.statusText}`), { status: response.status, body: body.slice(0, 200) });
      if (!RETRYABLE_STATUS(response.status)) break;
    } catch (error) {
      last = (error as { name?: string } | null)?.name === 'TimeoutError' ? new Error(`timed out after ${httpSettings.timeoutMs} ms`) : error;
    }
    if (attempt < retries) {
      const wait = Math.min(15000, httpSettings.backoffMs * (2 ** attempt));
      outputNote(`[ retry    ] ${label}: retry ${attempt + 1}/${retries} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw Object.assign(new Error(`${label}: ${errorText(last)}`), { status: (last as { status?: number } | null)?.status, body: (last as { body?: string } | null)?.body });
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
/**
 * Yahoo ignores `range=max` granularity guarantees (it returns weekly, monthly or hourly bars depending on the
 * fund's age), so the request always uses explicit period1/period2 with interval=1d.
 * `max` -> period1=0; `Ny` -> period1 = N calendar years before now.
 */
export function yahooChartUrl(ticker: string, range: string, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const years = /^(\d+)y$/.exec(range)?.[1];
  let period1 = 0;
  if (years) {
    const from = new Date(nowSeconds * 1000);
    from.setUTCFullYear(from.getUTCFullYear() - Number(years));
    period1 = Math.floor(from.getTime() / 1000);
  }
  const query = new URLSearchParams({ period1: String(period1), period2: String(nowSeconds + 86400), interval: '1d', events: 'div,splits' });
  return `${YAHOO_CHART}/${encodeURIComponent(ticker)}?${query}`;
}
async function fetchYahoo(ticker: string, range: string, config: Config): Promise<ChartDay[]> {
  return parseYahooChart(await getJson(yahooChartUrl(ticker, range), `[chart    ] ${ticker}`, yahooHeaders(), config));
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
/** Series id and report date of an N-PORT-P primary document. */
export function parseNportIdentity(xml: string): { seriesId: string | null; repPdDate: string | null } {
  const tag = (name: string): string | null => new RegExp(`<${name}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(xml)?.[1] || null;
  const date = tag('repPdDate');
  return { seriesId: tag('seriesId')?.toUpperCase() ?? null, repPdDate: date ? toIsoDate(date) : null };
}
/** An N-PORT fallback is usable only for the same series and only when it is newer than what is published. */
export function nportIsUsable(identity: { seriesId: string | null; repPdDate: string | null }, expectedSeriesId: string, publishedAsOf: string | null): boolean {
  if (identity.seriesId !== expectedSeriesId.toUpperCase() || !identity.repPdDate) return false;
  return !publishedAsOf || identity.repPdDate > publishedAsOf;
}
async function fetchEdgarHoldings(ticker: string, config: Config, publishedAsOf: string | null): Promise<{ rows: SheetRow[]; asOfDate: string | null }> {
  const none = { rows: [] as SheetRow[], asOfDate: null };
  if (!config.edgarFallback) return none;
  try {
    const lookup = await getJson(SEC_MF_TICKERS, '[edgar   ] fund ticker table', secHeaders(config), config);
    const ref = parseFundTickerRefs(lookup).get(ticker);
    if (!ref) return none;
    const params = new URLSearchParams({ action: 'getcompany', CIK: ref.seriesId, type: 'NPORT-P', owner: 'include', count: '10', output: 'atom' });
    const atom = await getText(`${SEC_BROWSE}?${params}`, `[edgar   ] ${ticker} N-PORT-P index`, secHeaders(config), config);
    const latest = parseAtomFilings(atom)[0];
    if (!latest) return none;
    const primary = `${SEC_ARCHIVES}/${Number(latest.cik)}/${latest.accession.replace(/-/g, '')}/primary_doc.xml`;
    const xml = await getText(primary, `[edgar   ] ${ticker} N-PORT-P`, { ...secHeaders(config), Accept: 'application/xml,text/xml' }, config);
    const identity = parseNportIdentity(xml);
    if (!nportIsUsable(identity, ref.seriesId, publishedAsOf)) {
      outputNote(`[ edgar    ] ${ticker}: N-PORT-P ignored (series ${identity.seriesId ?? 'unknown'} vs ${ref.seriesId}, report date ${identity.repPdDate ?? 'unknown'}, published ${publishedAsOf ?? 'none'})`);
      return none;
    }
    return { rows: parseNportHoldings(xml), asOfDate: identity.repPdDate };
  } catch (error) {
    outputNote(`[ edgar    ] ${ticker}: ${errorText(error)}`);
    return none;
  }
}

/** ISO date from a published display or US date (`Jun 25 2025`, `06/25/2025`); null when unparseable. */
function isoFromDisplay(value: unknown): string | null { return value === undefined || value === null || value === '' ? null : performanceDateIso(value); }
/** True when the fund was already `years` old on `asOfIso`; an unknown inception or date trusts the provider. */
export function fundAgeAtLeast(inceptionIso: string | null, asOfIso: string | null, years: number): boolean {
  const match = inceptionIso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(inceptionIso) : null;
  if (!match || !asOfIso) return true;
  return asOfIso >= `${String(Number(match[1]) + years).padStart(4, '0')}-${match[2]}-${match[3]}`;
}
export function returnsFromCatalog(fund: Fund): { monthEnd: JsonRecord; quarterEnd: JsonRecord; metrics: JsonRecord } {
  const performance = isRecord(fund.performance) ? fund.performance : {};
  const monthly = isRecord(performance.monthly) ? performance.monthly : {};
  const quarterly = isRecord(performance.quarterly) ? performance.quarterly : {};
  const inception = performanceDateIso(fund.inception_date);
  // Horizons longer than the fund's age and since-inception figures under one year are unavailable: null, never a placeholder.
  const mapReturn = (source: JsonRecord, date: unknown): JsonRecord => {
    const asOf = performanceDateIso(date);
    const horizon = (key: string, years: number): number | null => fundAgeAtLeast(inception, asOf, years) ? toNumber(source[key]) : null;
    return {
      asOfDate: asOf ? displayDate(asOf) : null, mo1: toNumber(source.onemonth_nav), qtd: toNumber(source.threemonth_nav),
      ytd: toNumber(source.ytd_nav), yr1: horizon('oneyear_nav', 1), yr3: horizon('threeyear_nav', 3),
      yr5: horizon('fiveyear_nav', 5), yr10: horizon('tenyear_nav', 10), sinceInception: horizon('since_inception_nav', 1),
    };
  };
  const monthEnd = mapReturn(monthly, valueFrom(fund, 'monthly_performance_as_of_date'));
  const quarterEnd = mapReturn(quarterly, valueFrom(fund, 'quarterly_performance_as_of_date'));
  const cagr3y = toNumber(monthEnd.yr3), cagr5y = toNumber(monthEnd.yr5), cagr10y = toNumber(monthEnd.yr10);
  const total = (cagr: number | null, years: number): number | null => cagr === null ? null : round(((1 + cagr / 100) ** years - 1) * 100, 2);
  const values = {
    ytd: toNumber(monthEnd.ytd), tr1y: toNumber(monthEnd.yr1), tr3y: total(cagr3y, 3), tr5y: total(cagr5y, 5), tr10y: total(cagr10y, 10),
    cagr3y, cagr5y, cagr10y, siAnn: toNumber(monthEnd.sinceInception),
  };
  const hasReturns = Object.values(values).some(value => value !== null);
  return {
    monthEnd, quarterEnd,
    metrics: {
      ...values,
      dividendYield: fund.dividendYield, dividendYieldText: fund.dividendYield === null ? null : formatPercent(fund.dividendYield),
      secYield: fund.secYield, secYieldText: fund.secYield === null ? null : formatPercent(fund.secYield),
      // performanceAsOf describes the returns above: no returns, no date.
      returnsBasis: RETURNS_BASIS, performanceAsOf: hasReturns ? performanceDateIso(valueFrom(fund, 'monthly_performance_as_of_date')) : null,
    },
  };
}
const OPTIONAL_SECTIONS = new Set(['Distributions', 'Yields', 'PremiumDiscount']);
/** True for VCM's "no data in this section" answer (HTTP 404 with errorDesc "Section data not found"). */
export function isSectionMissing(error: unknown): boolean {
  const e = error as { status?: unknown; body?: unknown } | null;
  return e?.status === 404 && /section data not found/i.test(String(e.body ?? ''));
}
const ANNUAL_PAYMENTS: Record<string, number> = { Monthly: 12, Quarterly: 4, 'Semi-annually': 2, Annually: 1 };
const textPercent = (value: number | null): string | null => value === null ? null : formatPercent(value);

/**
 * One index row, built from the catalog record and (when the fund has published files) its meta.json,
 * so the row and the meta always describe the same run. A fund without meta.json gets dataFile null
 * and a complete metrics object (every key present, unavailable values null).
 */
export function indexRow(fund: Fund, meta: JsonRecord | null): JsonRecord {
  const returns = returnsFromCatalog(fund);
  const sub = (key: string): JsonRecord => meta && isRecord(meta[key]) ? meta[key] as JsonRecord : {};
  const navMeta = sub('nav'), aumMeta = sub('aum'), yieldsMeta = sub('yields'), distributionMeta = sub('distributions');
  const nav = meta ? toNumber(navMeta.value) : toNumber(fund.latest_nav);
  const aum = meta ? toNumber(aumMeta.value) : toNumber(fund.net_assets);
  const close = toNumber(fund.market_close);
  const dividendYield = meta ? toNumber(yieldsMeta.dividendYield) : fund.dividendYield;
  const secYield = meta ? toNumber(yieldsMeta.secYield) : fund.secYield;
  const latestAmount = toNumber(distributionMeta.latestAmount);
  const navDate = meta ? valueFrom(navMeta, 'asOfDate') : displayDate(fund.nav_as_of);
  return {
    ticker: fund.ticker, name: fund.name, category: fund.category, fundPage: fundPageUrl(fund),
    dataFile: meta ? `./funds/${fund.ticker}/meta.json` : null,
    ter: formatPercent(fund.terValue), terValue: fund.terValue, terGross: textPercent(fund.terGrossValue), terGrossValue: fund.terGrossValue,
    nav: nav === null ? '—' : `$${nav.toFixed(2)}`, navValue: nav, aum: formatMoney(aum), aumValue: aum,
    asOfDate: navDate ? String(navDate) : displayDate(fund.nav_as_of),
    inceptionDate: displayDate(fund.inception_date), exchange: cleanText(fund.exchange) || '—',
    closePrice: close === null ? '—' : `$${close.toFixed(2)}`,
    premiumDiscount: formatPercent(toNumber(fund.premium_discount_percentage)),
    cusip: cleanText(fund.cusip) || null, isin: cleanText(fund.isin) || null,
    distributions: { frequency: typeof distributionMeta.frequency === 'string' ? distributionMeta.frequency : null, exDate: null, dividend: latestAmount === null ? null : String(latestAmount) },
    returns: { monthEnd: returns.monthEnd, quarterEnd: returns.quarterEnd },
    metrics: { ...returns.metrics, dividendYield, dividendYieldText: textPercent(dividendYield), secYield, secYieldText: textPercent(secYield) },
    holdings: meta ? toNumber(sub('holdings').totalRows) ?? 0 : 0,
    history: meta ? toNumber(sub('history').totalRows) ?? 0 : 0,
  };
}
function metricForFilter(fund: Fund, period: string, total: boolean): number | null {
  const metrics = returnsFromCatalog(fund).metrics;
  const key: Record<string, [string, string]> = { YTD: ['ytd', 'ytd'], '1Y': ['tr1y', 'tr1y'], '3Y': ['cagr3y', 'tr3y'], '5Y': ['cagr5y', 'tr5y'], '10Y': ['cagr10y', 'tr10y'] };
  return toNumber(metrics[key[period][total ? 1 : 0]]);
}
/** Bounded ranges exclude funds whose value is null (inRange). */
export function fundPasses(fund: Fund, config: Config): boolean {
  if (!inRange(fund.aumValue, config.aum) || !inRange(fund.terValue, config.ter) || !inRange(fund.dividendYield, config.dividendYield) || !inRange(fund.secYield, config.secYield)) return false;
  return RETURN_PERIODS.every(period => inRange(metricForFilter(fund, period, false), config.performance[period]) && inRange(metricForFilter(fund, period, true), config.totalReturn[period]));
}
/** MAX_FETCHES window over the funds that pass the filters: starts after the saved cursor and wraps around. */
export function rotateSelection<T extends { ticker: string }>(eligible: T[], maxFetches: number, cursor: string): T[] {
  if (maxFetches <= 0 || eligible.length <= maxFetches) return eligible;
  const next = eligible.findIndex(fund => fund.ticker > cursor);
  const from = next < 0 ? 0 : next;
  return [...eligible.slice(from), ...eligible.slice(0, from)].slice(0, maxFetches);
}

type FundBuild = { meta: JsonRecord; holdings: PagePlan; history: PagePlan };

/** Compute one fund completely in memory. Throws (nothing is written) when a required source failed and the fund already has published data. */
async function buildFund(fund: Fund, key: string, config: Config, prior: JsonRecord | null): Promise<FundBuild> {
  const failures: string[] = [];
  const product = async (endpoint: string): Promise<unknown> => {
    try { return await fetchProduct(fund.ticker, endpoint, key, config); }
    catch (error) {
      // A brand-new fund has no distributions, yields or premium/discount yet: VCM answers 404 {"errorDesc":"Section data not found"}.
      if (OPTIONAL_SECTIONS.has(endpoint) && isSectionMissing(error)) return {};
      failures.push(errorText(error));
      return null;
    }
  };
  // Sequential on purpose: one fund never has more than one request in flight, so CONCURRENCY is the real parallelism.
  const holdPayload = await product('AllHoldings');
  const distributionPayload = await product('Distributions');
  const overviewPayload = await product('Overview');
  const yieldPayload = await product('Yields');
  const pdPayload = await product('PremiumDiscount');
  const overview = isRecord(overviewPayload) ? overviewPayload : {};
  const yields = isRecord(yieldPayload) ? yieldPayload : {};
  const priorDistributions = prior && isRecord(prior.distributions) ? prior.distributions : null;
  let distributions = parseDistributionPayload(distributionPayload);
  let distributionSource = 'VCM Distributions JSON (declared, record, payable dates and reported amount fields)';
  if (distributionPayload !== null && !distributions.rows.length && priorDistributions && Array.isArray(priorDistributions.rows) && priorDistributions.rows.length) {
    const headers = Array.isArray(priorDistributions.headers) ? priorDistributions.headers.map(String) : [];
    distributions = {
      headers: headers.length ? headers : distributions.headers, rows: priorDistributions.rows.filter(Array.isArray).map(row => row.map(String)),
      frequency: typeof priorDistributions.frequency === 'string' ? priorDistributions.frequency : null,
      latest: toNumber(priorDistributions.latestAmount), date: typeof priorDistributions.latestDate === 'string' ? priorDistributions.latestDate : null,
    };
    distributionSource = 'previously published VCM distributions (retained because the current response was empty)';
  }
  const official = parseHoldings(holdPayload);
  const previousHoldings = await previousRows(fund.ticker, 'holdings');
  const publishedHoldingsAsOf = prior && isRecord(prior.holdings) && typeof prior.holdings.asOfDate === 'string' ? prior.holdings.asOfDate : null;
  let holdRows = official.rows, holdingSource = 'VCM AllHoldings JSON', holdingsAsOf = official.asOfDate;
  if (!holdRows.length) {
    const sec = await fetchEdgarHoldings(fund.ticker, config, previousHoldings.rows.length ? publishedHoldingsAsOf : null);
    if (sec.rows.length) { holdRows = sec.rows; holdingsAsOf = sec.asOfDate; holdingSource = `SEC EDGAR N-PORT-P (Victory Portfolios II, CIK 0001547580; ${sec.asOfDate ?? 'report date unavailable'})`; }
  }
  if (!holdRows.length && previousHoldings.rows.length) failures.push(`[holdings ] ${fund.ticker}: no current rows from VCM or SEC`);

  const previousHistory = await previousRows(fund.ticker, 'history');
  let days: ChartDay[] = [];
  if (!config.skipYahoo) {
    try { days = await fetchYahoo(fund.ticker, config.historyRange, config); }
    catch (error) { failures.push(errorText(error)); }
    if (!days.length && previousHistory.rows.length && !failures.some(text => text.startsWith('[chart'))) failures.push(`[chart    ] ${fund.ticker}: no price rows`);
  }
  // A fund with published data is kept untouched when any required source failed; a brand-new fund is published only when it has something to show.
  if (failures.length && (prior || (!holdRows.length && !days.length))) throw new Error(failures.join('; '));

  const premium = parsePremiumDiscount(pdPayload);
  const freshHistory = days.length > 0;
  const retainedHistory = !freshHistory && config.skipYahoo ? previousHistory.rows : [];
  const hRows = freshHistory ? historyRows(days, premium) : retainedHistory;
  const historyAsOf = freshHistory ? days.at(-1)?.date ?? null : retainedHistory.at(-1)?.Date ?? null;
  const historySource = freshHistory
    ? 'Yahoo Finance daily adjusted market-price chart (explicit period1/period2, interval 1d) + VCM PremiumDiscount API (NAV is not provided in the Yahoo price series)'
    : retainedHistory.length ? 'previously published history retained because SKIP_YAHOO is set' : 'Yahoo Finance history unavailable; no history has been published';
  const holdings: PagePlan = { kind: 'holdings', headers: official.headers, rows: holdRows, size: config.holdingsPageSize, asOfDate: holdingsAsOf, source: holdingSource };
  const history: PagePlan = { kind: 'history', headers: HISTORY_HEADERS, rows: hRows, size: config.historyPageSize, asOfDate: historyAsOf, source: historySource };
  const hManifest = planManifest(holdings), yManifest = planManifest(history);

  const returns = returnsFromCatalog(fund);
  const nav = toNumber(valueFrom(overview, 'latest_nav')) ?? fund.navValue;
  const navChange = toNumber(valueFrom(overview, 'nav_change'));
  const market = toNumber(valueFrom(fund, 'market_close'));
  const aum = toNumber(valueFrom(overview, 'net_assets')) ?? fund.aumValue;
  const secYield = toNumber(valueFrom(yields, 'thirtyday_sec_yield')) ?? fund.secYield;
  const declaredYield = toNumber(valueFrom(yields, 'dividend_yield_percentage')) ?? fund.dividendYield;
  const payments = distributions.frequency ? ANNUAL_PAYMENTS[distributions.frequency] : undefined;
  const indicatedYield = distributions.latest !== null && payments && market !== null && market > 0 ? round((distributions.latest * payments / market) * 100, 2) : null;
  const dividendYield = declaredYield ?? indicatedYield;
  const yieldDate = displayDate(valueFrom(yields, 'dividend_yield_percentage_as_of_date', 'as_of_date'));
  const meta: JsonRecord = {
    ticker: fund.ticker, name: fund.name, category: fund.category,
    source: {
      fundPage: fundPageUrl(fund), catalog: ISSUER_LIST_PAGE, issuerOverview: ISSUER_OVERVIEW_PAGE,
      catalogApi: ISSUER_API_FALLBACK, productApi: `${VCM_API}/{TICKER}/{AllHoldings|Overview|Yields|Distributions|PremiumDiscount}`,
      yahooChart: `${YAHOO_CHART}/${fund.ticker}`, holdingsSource: holdingSource, historySource: historySource,
      distributionSource,
      provider: 'Victory Capital Management / VictoryShares public JSON + Yahoo Finance chart + SEC EDGAR N-PORT-P (holdings fallback only)',
    },
    identifiers: { cusip: cleanText(fund.cusip) || null, isin: cleanText(fund.isin) || cleanText(overview.isin) || null, iopv: cleanText(fund.iopv) || null },
    inception: { fundInceptionDate: toIsoDate(fund.inception_date) || null, shareClassInceptionDate: toIsoDate(fund.inception_date) || null, exchange: cleanText(fund.exchange) || null },
    // value/net = NET expense ratio (after waivers); gross is published beside it when the issuer provides both.
    expenseRatio: { display: formatPercent(fund.terValue), value: fund.terValue, net: fund.terValue, gross: fund.terGrossValue },
    nav: { display: nav === null ? null : `$${nav.toFixed(2)}`, value: nav, asOfDate: displayDate(valueFrom(overview, 'as_of', 'nav_as_of') ?? fund.nav_as_of), change: navChange },
    marketPrice: { display: market === null ? null : `$${market.toFixed(2)}`, value: market, asOfDate: displayDate(fund.nav_as_of) },
    premiumDiscount: { display: formatPercent(toNumber(fund.premium_discount_percentage)), value: toNumber(fund.premium_discount_percentage) },
    aum: { display: formatMoney(aum), value: aum, asOfDate: displayDate(valueFrom(overview, 'as_of') ?? fund.nav_as_of), source: 'VCM ETF catalog / Overview JSON' },
    yields: {
      dividendYield, dividendYieldText: textPercent(dividendYield),
      dividendYieldKind: declaredYield !== null
        ? `VCM published dividend yield${yieldDate ? ` as of ${yieldDate}` : ''}`
        : indicatedYield !== null ? 'Indicated from the latest reported distribution per share x inferred payments per year / market price' : null,
      distributionRate: toNumber(yields.twelve_month_distribution_rate), secYield, secYieldText: textPercent(secYield),
      secYieldKind: secYield === null ? null : `VCM 30-day SEC yield as of ${displayDate(valueFrom(yields, 'as_of_date') ?? fund.nav_as_of)}`,
      unsubsidizedSecYield: toNumber(yields.thirtyday_sec_unsubsidized_yield),
    },
    returns: { derivedFrom: 'VCM published NAV performance series', monthEnd: returns.monthEnd, quarterEnd: returns.quarterEnd, returnsBasis: returns.metrics.returnsBasis, performanceAsOf: returns.metrics.performanceAsOf },
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
  return { meta, holdings, history };
}

/** Pages first, then meta.json, then stale pages (only after the meta that no longer references them). */
async function commitFund(ticker: string, build: FundBuild): Promise<void> {
  await writePlanPages(ticker, build.holdings);
  await writePlanPages(ticker, build.history);
  await writeJsonIfChanged(new URL(`funds/${ticker}/meta.json`, apiRoot), build.meta);
  await removeStalePages(ticker, 'holdings', planManifest(build.holdings).pages);
  await removeStalePages(ticker, 'history', planManifest(build.history).pages);
}

type FundOutcome = { ok: boolean; meta: JsonRecord | null };
async function processFund(fund: Fund, key: string, config: Config, reporter: ReturnType<typeof outputCreateReporter>): Promise<FundOutcome> {
  const before = await outputInspectFund(fund.ticker);
  const prior = Object.keys(before.meta).length ? before.meta : null;
  let build: FundBuild;
  try {
    build = await buildFund(fund, key, config, prior);
    await commitFund(fund.ticker, build);
  } catch (error) {
    await reporter.result(fund.ticker, before, prior ?? { ticker: fund.ticker }, 'failed', errorText(error));
    return { ok: false, meta: prior };
  }
  await reporter.result(fund.ticker, before, build.meta);
  return { ok: true, meta: build.meta };
}
/** Hands out items in order; stops taking new ones once `stop()` says so. Returns how many were started (always a prefix). */
async function mapWithConcurrency<T>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<void>, stop: () => boolean = () => false): Promise<number> {
  let next = 0, started = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (!stop()) {
      const index = next++;
      if (index >= items.length) return;
      started++;
      await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return started;
}
async function appendStepSummary(lines: string[]): Promise<void> {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file && lines.length) await appendFile(file, `${lines.join('\n')}\n`, 'utf8').catch(() => undefined);
}
function printHelp(): void {
  console.log(`VictoryShares ETF updater\n\nUsage: bun ./scripts/update-data.ts [--help]\n\nDefaults come from scripts/update-data.config.json; any explicitly set environment variable below overrides the file value (an empty value clears the control).\n\nEvery control also reads VICTORYSHARES_<NAME> from the environment (the plain name wins when both are set); HISTORICAL_PAGE_SIZE is an alias of HISTORY_PAGE_SIZE.\n\nControls:\n  MAX_FETCHES=0             Number of funds to process (0 = all eligible; resumes after the saved ticker cursor and wraps around)\n  TICKERS="VFLO USTB UEVM" Only process the named tickers\n  REQUEST_SLEEP=1           Minimum seconds between request starts per worker lane\n  CONCURRENCY=2             Parallel fund workers (default conservative)\n  MAX_RETRIES=2             Retries after initial request (integer >= 1)\n  HOLDINGS_PAGE_SIZE=250    Rows per static holdings page\n  HISTORY_PAGE_SIZE=1000    Rows per static price-history page\n  HISTORY_RANGE=max         Yahoo daily bars: max or Ny (for example 10y, 5y, 1y)\n  AUM=:                     AUM min:max (K/M/B/T suffixes) or nano/micro/small/mid/large\n  TER=: DIVIDEND_YIELD=: SEC_YIELD=:  Inclusive numeric min:max percentages (TER is the net expense ratio)\n  PERFORMANCE_{YTD,1Y,3Y,5Y,10Y}=: Annualized NAV-return filters\n  TOTAL_RETURN_{YTD,1Y,3Y,5Y,10Y}=: Cumulative-return filters\n  EDGAR_FALLBACK=1          Use SEC N-PORT-P only if official holdings are unavailable\n  SEC_UA=<ua string>        SEC User-Agent with a contact for EDGAR fallback requests (redacted in logs; blank uses the default contact)\n  SKIP_YAHOO=1              Do not call Yahoo; retain prior history if available\n  VERBOSE=1                 Show per-request retry/fallback details\n  USE_SYSTEM_CA=auto        TLS trust store: auto restarts once with Bun --use-system-ca on an untrusted-certificate error, true always uses it, false never restarts\n`);
}

export type RunSummary = { completed: number; failures: number; updated: number; unchanged: number; skipped: number; indexChanged: boolean; newFunds: string[]; droppedFunds: string[] };

/** One full update run over already-resolved controls. Never sets process.exitCode (main does). */
export async function runUpdate(controls: Record<string, string>, options: { deadlineMs?: number } = {}): Promise<RunSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.deadlineMs ?? SOFT_DEADLINE_MS);
  const config = readConfig(controls);
  configureLanes(config.concurrency, config.requestSleep);
  outputPrintConfig(config);
  const previous = await previousIndex();
  let catalog: Fund[] = [];
  let api: { endpoint: string; apiKey: string } | null = null;
  try {
    api = await loadApiKey(config);
    catalog = parseCatalog(await getJson(api.endpoint, '[catalog  ] VictoryShares ETF list', issuerApiHeaders(api.apiKey), config));
    console.log(`[ catalog  ] ${catalog.length} VictoryShares ETFs (VCM public ETF JSON API)`);
  } catch (error) {
    console.warn(`[ catalog  ] ${errorText(error)} - retaining the published catalog`);
  }
  const catalogRead = catalog.length > 0;
  const usingCachedCatalog = !catalogRead;
  if (usingCachedCatalog) catalog = [...previous.values()].map(cachedFundFromIndex).filter(fund => Boolean(fund.ticker));
  if (!catalog.length) throw new Error('No current or previously published catalog is available');

  const liveTickers = new Set(catalog.map(fund => fund.ticker));
  const newFunds = catalogRead && previous.size ? catalog.filter(fund => !previous.has(fund.ticker)).map(fund => fund.ticker) : [];
  let droppedFunds: string[] = [];
  if (catalogRead) {
    const absent = [...previous.keys()].filter(ticker => !liveTickers.has(ticker)).sort();
    const truncated = previous.size > 0 && catalog.length < Math.ceil(previous.size / 2);
    if (truncated && absent.length) {
      console.warn(`[ catalog  ] catalog looks truncated (${catalog.length} of ${previous.size} published funds): keeping every published fund`);
      for (const ticker of absent) catalog.push(cachedFundFromIndex(previous.get(ticker) as JsonRecord));
    } else droppedFunds = absent;
  }
  catalog.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const notices: string[] = [];
  if (newFunds.length) notices.push(`NEW FUNDS: ${newFunds.join(', ')}`);
  if (droppedFunds.length) notices.push(`DROPPED FUNDS: ${droppedFunds.join(', ')}`);
  for (const notice of notices) console.log(`[ catalog  ] ${notice}`);
  await appendStepSummary(notices.map(notice => `- ${notice}`));

  const deferredDividend = config.dividendYield.min !== undefined || config.dividendYield.max !== undefined;
  const deferredSec = config.secYield.min !== undefined || config.secYield.max !== undefined;
  const deferredFunds = catalog.filter(fund => (deferredDividend && fund.dividendYield === null) || (deferredSec && fund.secYield === null));
  let filtersDeferred = false;
  if (api && deferredFunds.length) {
    filtersDeferred = true;
    const apiKey = api.apiKey;
    await mapWithConcurrency(deferredFunds, config.concurrency, async fund => {
      const yieldPayload = await fetchProduct(fund.ticker, 'Yields', apiKey, config).catch(() => null);
      const distPayload = deferredDividend && fund.dividendYield === null ? await fetchProduct(fund.ticker, 'Distributions', apiKey, config).catch(() => null) : null;
      const yields = isRecord(yieldPayload) ? yieldPayload : {};
      if (fund.secYield === null) fund.secYield = toNumber(yields.thirtyday_sec_yield);
      if (fund.dividendYield === null) {
        const parsed = parseDistributionPayload(distPayload);
        const payments = parsed.frequency ? ANNUAL_PAYMENTS[parsed.frequency] : undefined;
        const marketPrice = toNumber(fund.market_close);
        fund.dividendYield = toNumber(yields.dividend_yield_percentage) ?? (parsed.latest !== null && payments && marketPrice !== null && marketPrice > 0 ? round(parsed.latest * payments / marketPrice * 100, 2) : null);
      }
    });
  }
  const eligible = catalog.filter(fund => fundPasses(fund, config));
  const selectedByTicker = config.tickers.size ? eligible.filter(fund => config.tickers.has(fund.ticker)) : eligible;
  outputPrintFilter(selectedByTicker.length, catalog.length, filtersDeferred);
  if (config.tickers.size) {
    const missing = [...config.tickers].filter(ticker => !catalog.some(fund => fund.ticker === ticker));
    if (missing.length) throw new Error(`Requested ticker(s) not in VCM catalog: ${missing.join(', ')}`);
    const filtered = [...config.tickers].filter(ticker => catalog.some(fund => fund.ticker === ticker && !eligible.includes(fund)));
    if (filtered.length) throw new Error(`Requested ticker(s) were excluded by configured filters: ${filtered.join(', ')}`);
  }
  const rotating = !config.tickers.size && config.maxFetches > 0 && selectedByTicker.length > config.maxFetches;
  const selected = config.tickers.size ? selectedByTicker : rotateSelection(selectedByTicker, config.maxFetches, rotating ? await readCursor() : '');

  const outcomes = new Map<string, FundOutcome>();
  const reporter = outputCreateReporter(selected.length);
  const activeApiKey = api?.apiKey ?? '';
  const started = await mapWithConcurrency(selected, config.concurrency, async fund => {
    if (!api) {
      const before = await outputInspectFund(fund.ticker);
      const has = Object.keys(before.meta).length > 0;
      await reporter.result(fund.ticker, before, before.meta, has ? 'unchanged' : 'failed', has ? '' : 'no provider access or cached fund data');
      return;
    }
    outcomes.set(fund.ticker, await processFund(fund, activeApiKey, config, reporter));
  }, () => Date.now() >= deadline);
  const skipped = selected.length - started;
  if (skipped > 0) console.warn(`[ deadline ] soft deadline reached: ${skipped} fund(s) not started, their published data is kept`);

  // Rows: processed funds come from this run; every other fund keeps its published row verbatim
  // (a fund is either fully updated or fully kept); a fund without any published row gets a catalog-only row.
  const indexFunds: JsonRecord[] = [];
  for (const fund of catalog) {
    const outcome = outcomes.get(fund.ticker);
    const existing = previous.get(fund.ticker);
    if (outcome?.ok) indexFunds.push(indexRow(fund, outcome.meta));
    else if (existing) indexFunds.push(existing);
    else {
      const meta = await readJson(new URL(`funds/${fund.ticker}/meta.json`, apiRoot));
      indexFunds.push(indexRow(fund, isRecord(meta) ? meta : null));
    }
  }
  const totalHoldings = indexFunds.reduce((sum, row) => sum + (toNumber(row.holdings) ?? 0), 0);
  const totalHistory = indexFunds.reduce((sum, row) => sum + (toNumber(row.history) ?? 0), 0);
  const indexValue = {
    generatedAt: nowIso(),
    source: {
      provider: 'VictoryShares ETFs (Victory Capital Management)', market: 'us', site: 'https://www.vcm.com',
      catalog: ISSUER_LIST_PAGE, issuerOverview: ISSUER_OVERVIEW_PAGE,
      catalogApi: ISSUER_API_FALLBACK, productApi: `${VCM_API}/{TICKER}/{AllHoldings|Overview|Yields|Distributions|PremiumDiscount}`,
      history: 'Yahoo Finance public chart API (daily adjusted market-price bars; not official NAV)',
      holdings: 'VCM AllHoldings JSON; SEC EDGAR Form N-PORT-P for Victory Portfolios II (CIK 0001547580) as fallback',
    },
    counts: { funds: indexFunds.length, holdings: totalHoldings, history: totalHistory },
    funds: indexFunds,
  };
  const indexChanged = await writeJsonIfChanged(indexUrl(), indexValue);
  for (const ticker of droppedFunds) await rm(new URL(`funds/${ticker}/`, apiRoot), { recursive: true, force: true });
  if (rotating && started > 0) await writeJsonIfChanged(stateUrl(), { lastProcessedTicker: selected[started - 1].ticker });
  const result = reporter.summary();
  console.log(`[ done     ] ${result.updated} funds updated, ${result.failures} failures`);
  console.log(`[ done     ] counts: evaluated=${result.completed} unchanged=${result.unchanged} funds=${indexFunds.length} holdings=${totalHoldings} history=${totalHistory} index=${indexChanged ? 'updated' : 'unchanged'}`);
  return { ...result, skipped, indexChanged, newFunds, droppedFunds };
}

export async function main(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): Promise<void> {
  if (argv.some(arg => arg === '-h' || arg === '--help')) { printHelp(); return; }
  const controls = await runtimeControls(env);
  if (controls.VERBOSE !== undefined) process.env.VERBOSE = controls.VERBOSE;
  installSystemCa((controls.USE_SYSTEM_CA || 'auto').toLowerCase());
  const summary = await runUpdate(controls);
  if (summary.completed > 0 && summary.failures === summary.completed) {
    console.error('[ done     ] every selected fund failed');
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch(error => { console.error(`[ done     ] fatal: ${errorText(error)}`); process.exitCode = 1; });
}

// Exported deterministic normalization for tests.
export function formatFrequencyPlaceholder(value: unknown): string {
  const raw = String(value ?? '').trim();
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
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
