#!/usr/bin/env bun
/// <reference types="bun" />
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';


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
// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
type ChartDay = { date: string; close: number | null; adjClose: number | null; dividend: number | null; adjCloseRaw?: number | null };
type PageManifest = { pages: string[]; pageSize: number; totalRows: number; asOfDate: string | null; source: string };
type FundSnapshot = { digest: string; meta: JsonRecord };

const ISSUER_LIST_PAGE = 'https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list';
const ISSUER_OVERVIEW_PAGE = 'https://www.vcm.com/products-fa/victoryshares-etfs';
const ISSUER_API_FALLBACK = 'https://investorapi.vcm.com/search/products/ETF';
const VCM_API = 'https://investorapi.vcm.com/search/product';
const SEC_MF_TICKERS = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS = 'https://www.sec.gov/files/company_tickers.json';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DEFAULT_API_ROOT = new URL('../api/victoryshares/', import.meta.url);
let apiRoot = DEFAULT_API_ROOT;
/** Redirect every read and write (tests only; the production output directory is fixed). */
export function useApiRoot(url: URL): void { apiRoot = url; }
const indexUrl = (): URL => new URL('index.json', apiRoot);
const stateUrl = (): URL => new URL('update-state.json', apiRoot);
const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category', 'Coupon', 'Maturity'];
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];
const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount', 'Adj Close'];
const RETURN_PERIODS = ['YTD', '1Y', '3Y', '5Y', '10Y'];
const DEFAULT_SEC_UA = 'daggerok ETF feed daggerok@gmail.com';
const SOFT_DEADLINE_MS = 25 * 60 * 1000;
const DEFAULTS = { requestSleep: 1, concurrency: 2, maxRetries: 2, holdingsPageSize: 250, historyPageSize: 1000 };

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}

/** Fund lines through the shared reporter, counted for the run result (exit code and return value). */
function createRunReporter(total: number) {
  const reporter = outputCreateReporter(apiRoot, total);
  const counts = { completed: 0, failures: 0, updated: 0, unchanged: 0 };
  return {
    async result(ticker: string, before: FundSnapshot, meta: JsonRecord, status?: string, reason = ''): Promise<void> {
      const final = status ?? (before.digest === (await outputInspectFund(apiRoot, ticker)).digest ? 'unchanged' : 'updated');
      counts.completed++;
      if (final === 'failed') counts.failures++;
      else if (final === 'updated') counts.updated++;
      else counts.unchanged++;
      await reporter.result(ticker, before, final, reason, meta);
    },
    summary: () => ({ ...counts }),
    summaryLine: (startedAt: number): string => reporter.summary(startedAt),
  };
}
/** The `[ config ]` block: the parsed config under the canonical environment names (SEC_UA is redacted). */
function printUpdaterConfig(config: Config): void {
  outputPrintConfig('VictoryShares', {
    maxFetches: config.maxFetches, requestSleep: config.requestSleep, concurrency: config.concurrency,
    aumRange: config.aum, dividendYieldRange: config.dividendYield, edgarFallback: config.edgarFallback,
    historyPageSize: config.historyPageSize, historyRange: config.historyRange, holdingsPageSize: config.holdingsPageSize,
    maxRetries: config.maxRetries, SEC_UA: config.secUa, secYieldRange: config.secYield, skipYahoo: config.skipYahoo,
    terRange: config.ter, tickers: config.tickers, performanceRanges: config.performance, totalReturnRanges: config.totalReturn,
  });
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
  // calendar text, never the local time zone (shared calendar-dates block); an ISO date with any suffix keeps its date part
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  return calendarIso(text) ?? (iso ? `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}` : text);
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
      dividendYieldBasis: yieldBasisOf(toNumber(raw.dividend_yield_percentage), null),
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

/** Which definition stands behind dividendYield: null exactly when the yield is null. */
export const YIELD_BASES = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'] as const;
export type YieldBasis = typeof YIELD_BASES[number];
/**
 * Maps a stored code (or, for older meta.json files, the dividendYieldKind text) to a code.
 * VCM publishes dividend_yield_percentage without a definition -> official-other; the updater's own
 * latest distribution x payments per year / price estimate -> indicated.
 */
export function yieldBasisOf(value: number | null, basis: unknown, kind?: unknown): YieldBasis | null {
  if (value === null) return null;
  const known = YIELD_BASES.find(code => code === basis);
  if (known) return known;
  return /^indicated/i.test(String(kind ?? '')) ? 'indicated' : 'official-other';
}

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
    dividendYield: toNumber(metrics.dividendYield), dividendYieldBasis: yieldBasisOf(toNumber(metrics.dividendYield), metrics.dividendYieldBasis), secYield: toNumber(metrics.secYield),
    terGrossValue: toNumber(item.terGrossValue),
    gross_exp_ratio: item.terGrossValue ?? item.terValue, net_expense_ratio: item.terValue,
    inception_date: isoFromDisplay(item.inceptionDate),
    // The catalog-only quote fields: without them a run on the cached catalog rewrote every processed fund with a null
    // market price and premium/discount (USTB $49.92 and 0.07% -> null). The published values are kept with their date.
    latest_nav: toNumber(item.navValue), net_assets: toNumber(item.aumValue),
    market_close: toNumber(item.closePrice), premium_discount_percentage: toNumber(item.premiumDiscount),
    nav_as_of: typeof item.asOfDate === 'string' && item.asOfDate !== '—' ? item.asOfDate : null,
    exchange: item.exchange === '—' ? '' : item.exchange,
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

/** Bloomberg U.S. composite and venue codes VCM appends to a symbol (`BWA US`, `KGC U`): the bare symbol is the U.S. listing. */
const US_EXCHANGE_CODE = /\s+(US|UN|UW|UQ|UR|UA|UP|UF|UV|U)$/;
/** Security types that never carry an exchange ticker: debt, mortgage pools, cash, futures, preferreds. */
const NO_TICKER_TYPE = /BOND|MORTGAGE|MUNICIPAL|TREASURY|FNMA|FHLMC|GNMA|YANKEE|COMMERCIAL PAPER|INFLATION|NOTE|BILL|CURRENCY|CASH|FUTURE|PREFERRED/i;
/**
 * The published ticker of a VCM holding (open-items etfs VS-1): a bare symbol only for a U.S. listing - a U.S. exchange code is
 * stripped (`BWA US` -> BWA), a U.S. security type without a code stays as it is (`HON`). A foreign listing keeps its exchange
 * code (`MRK GY`, `GSK L`), so Merck KGaA is never published as MRK next to Merck & Co.; a foreign stock without a code is a
 * local symbol (`TS` = Tesco) and gets '-'. Debt, mortgage, cash, futures and preferred rows get '-'.
 */
export function holdingTicker(rawTicker: string, securityType: string): string {
  const symbol = cleanText(rawTicker).toUpperCase();
  if (!symbol || NO_TICKER_TYPE.test(securityType)) return '';
  if (US_EXCHANGE_CODE.test(symbol)) return symbol.replace(US_EXCHANGE_CODE, '');
  if (/\s+[A-Z]{1,2}$/.test(symbol)) return symbol;
  return /FOREIGN/i.test(securityType) ? '' : symbol;
}

export function parseHoldings(payload: unknown): { headers: string[]; rows: SheetRow[]; asOfDate: string | null } {
  const rawRows = Array.isArray(payload) ? payload.filter(isRecord) : isRecord(payload) && Array.isArray(payload.holdings) ? payload.holdings.filter(isRecord) : [];
  const rows = rawRows.map(raw => {
    const securityType = cleanText(raw.security_type);
    const rawTicker = cleanText(raw.stock_symbol);
    const ticker = holdingTicker(rawTicker, securityType);
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
      adjCloseRaw: adj,
    };
  }).filter(day => day.date && (day.close !== null || day.adjClose !== null));
  return days.sort((a, b) => a.date.localeCompare(b.date));
}
function round(value: number, digits: number): number { const scale = 10 ** digits; return Math.round((value + Number.EPSILON) * scale) / scale; }
// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE = 1e-4;
export function historyRows(days: ChartDay[], premiumDiscount: Map<string, number> = new Map(), published: SheetRow[] = []): SheetRow[] {
  const publishedAdj = new Map(published.map(row => [row.Date, row['Adj Close']]));
  return days.map(day => {
    const prior = publishedAdj.get(day.date), priorAdj = prior ? toNumber(prior) : null, raw = day.adjCloseRaw ?? day.adjClose;
    let adj = day.adjClose === null ? '' : day.adjClose.toFixed(2);
    if (prior !== undefined && priorAdj !== null && raw !== null && adj !== prior && Math.abs(raw - priorAdj) <= 0.005 + ADJ_CLOSE_NOISE) adj = prior;
    return {
      Date: day.date, NAV: '', 'Market Price': day.close === null ? '' : day.close.toFixed(2),
      'Premium/Discount': premiumDiscount.has(day.date) ? `${(premiumDiscount.get(day.date) as number).toFixed(4)}%` : '',
      'Adj Close': adj,
    };
  });
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

/** One run's SEC state: the two SEC ticker tables (each loaded once) and the N-PORT reader cache (submissions and documents). */
let secState: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };
/** A fresh SEC state for a run (runUpdate and tests). */
export function resetSecState(): void { secState = { funds: null, names: null, reader: new Map() }; }
/** SEC's ticker -> registrant CIK + series id table, loaded once per run (a failed load is asked again by the next fund). */
function loadFundTickerTable(config: Config): Promise<Map<string, NportSeriesRef>> {
  if (!secState.funds) {
    const loading = getJson(SEC_MF_TICKERS, '[edgar   ] fund ticker table', secHeaders(config), config).then(payload => parseSecFundTickers(payload));
    secState.funds = loading;
    loading.catch(() => { if (secState.funds === loading) secState.funds = null; });
  }
  return secState.funds;
}
/** SEC's company name -> ticker table for the N-PORT rows, loaded once per run. */
function loadCompanyNames(config: Config): Promise<Map<string, string>> {
  if (!secState.names) {
    const loading = getJson(SEC_COMPANY_TICKERS, '[edgar   ] company ticker table', secHeaders(config), config).then(payload => parseSecCompanyNames(payload));
    secState.names = loading;
    loading.catch(() => { if (secState.names === loading) secState.names = null; });
  }
  return secState.names;
}
/**
 * The VictoryShares holdings sheet of an N-PORT filing (HOLDINGS_HEADERS): a missing number stays empty (never 0), a missing
 * text is '-'; tickers come from nportTickers (U.S. equities only).
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): SheetRow[] {
  return filing.positions.map((position, index) => ({
    Name: position.name || '-', Ticker: tickers[index] || '-', Identifier: nportIdentifier(position) || '-',
    Weight: nportCell(position.weight), 'Market Value': nportCell(position.value, 2), 'Shares Held': nportCell(position.balance) || '-',
    'Asset Category': position.assetCat || '-', Coupon: nportCell(position.coupon) || '-', Maturity: position.maturity || '-',
  }));
}
/** The fund's own newest N-PORT-P filing (shared nport-reader block), used only when strictly newer than the published holdings. */
async function fetchEdgarHoldings(ticker: string, config: Config, published: { asOf: string | null; rows: number }): Promise<{ rows: SheetRow[]; asOfDate: string | null }> {
  const none = { rows: [] as SheetRow[], asOfDate: null };
  if (!config.edgarFallback) return none;
  try {
    const ref = (await loadFundTickerTable(config)).get(ticker);
    const read = ref
      ? await readNportHoldings({ ticker, cik: ref.cik, seriesId: ref.seriesId }, published, (url, label) => getText(url, `[edgar   ] ${label}`, { ...secHeaders(config), Accept: 'application/json, application/xml, text/xml' }, config), { cache: secState.reader })
      : { problem: `${ticker}: not in the SEC fund ticker table` };
    if ('problem' in read) {
      outputNote(`[ edgar    ] ${read.problem}`);
      return none;
    }
    return { rows: nportHoldingsSheet(read.filing, nportTickers(read.filing.positions, await loadCompanyNames(config).catch(() => null))), asOfDate: read.filing.repPdDate || null };
  } catch (error) {
    outputNote(`[ edgar    ] ${ticker}: ${errorText(error)}`);
    return none;
  }
}

/**
 * A HISTORY_RANGE window never shrinks the published history (and with it the published series): the published days older
 * than the first fresh day are put in front (shared windowed-chart block, Adj Close rescaled by the overlapping days). Null
 * when the window cannot be joined: the fund is then kept as published.
 */
export function windowedDays(days: ChartDay[], published: ReadonlyArray<SheetRow>): ChartDay[] | null {
  const fresh = days.filter(day => day.close !== null && day.adjClose !== null)
    .map(day => ({ date: day.date, close: day.close as number, adjClose: day.adjClose as number, volume: 0, adjCloseRaw: day.adjCloseRaw ?? undefined }));
  const merged = mergeWindowedChart({ days: fresh, dividends: [] }, published.map(row => ({ Date: row.Date, Close: row['Market Price'], 'Adj Close': row['Adj Close'] })));
  if (!merged) return null;
  const first = days.length ? days[0].date : '';
  const older: ChartDay[] = merged.days.filter(day => day.date < first).map(day => ({ date: day.date, close: day.close, adjClose: day.adjClose, dividend: null, adjCloseRaw: day.adjCloseRaw ?? day.adjClose }));
  return older.concat(days);
}

/** ISO date from a published display or US date (`Jun 25 2025`, `06/25/2025`); null when unparseable. */
function isoFromDisplay(value: unknown): string | null { return value === undefined || value === null || value === '' ? null : performanceDateIso(value); }
export function returnsFromCatalog(fund: Fund): { monthEnd: JsonRecord; quarterEnd: JsonRecord; metrics: JsonRecord } {
  const performance = isRecord(fund.performance) ? fund.performance : {};
  const monthly = isRecord(performance.monthly) ? performance.monthly : {};
  const quarterly = isRecord(performance.quarterly) ? performance.quarterly : {};
  const inception = performanceDateIso(fund.inception_date);
  // Horizons longer than the fund's age and since-inception figures under one year are unavailable: null, never a placeholder.
  const mapReturn = (source: JsonRecord, date: unknown): JsonRecord => {
    const asOf = performanceDateIso(date);
    // the shared "younger than one year" rule (calendar-dates block): no horizon the fund is too young for
    return withoutYoungReturns({
      asOfDate: asOf ? displayDate(asOf) : null, mo1: toNumber(source.onemonth_nav), qtd: toNumber(source.threemonth_nav),
      ytd: toNumber(source.ytd_nav), yr1: toNumber(source.oneyear_nav), yr3: toNumber(source.threeyear_nav),
      yr5: toNumber(source.fiveyear_nav), yr10: toNumber(source.tenyear_nav), sinceInception: toNumber(source.since_inception_nav),
    }, inception, asOf, { yr1: 1, yr3: 3, yr5: 5, yr10: 10, sinceInception: 1 });
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
      dividendYieldBasis: yieldBasisOf(fund.dividendYield, fund.dividendYieldBasis),
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
    metrics: { ...returns.metrics, dividendYield, dividendYieldText: textPercent(dividendYield), dividendYieldBasis: yieldBasisOf(dividendYield, meta ? yieldsMeta.dividendYieldBasis : fund.dividendYieldBasis, yieldsMeta.dividendYieldKind), secYield, secYieldText: textPercent(secYield) },
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
    const sec = await fetchEdgarHoldings(fund.ticker, config, { asOf: publishedHoldingsAsOf, rows: previousHoldings.rows.length });
    if (sec.rows.length) { holdRows = sec.rows; holdingsAsOf = sec.asOfDate; holdingSource = `SEC EDGAR N-PORT-P (Victory Portfolios II, CIK 0001547580; ${sec.asOfDate ?? 'report date unavailable'})`; }
  }
  if (!holdRows.length && previousHoldings.rows.length) failures.push(`[holdings ] ${fund.ticker}: no current rows from VCM or SEC`);

  const previousHistory = await previousRows(fund.ticker, 'history');
  let days: ChartDay[] = [];
  if (!config.skipYahoo) {
    try {
      days = await fetchYahoo(fund.ticker, config.historyRange, config);
      // A HISTORY_RANGE window never shrinks the published history
      const windowed = config.historyRange !== 'max' && days.length ? windowedDays(days, previousHistory.rows) : days;
      if (!windowed) { days = []; failures.push(`[chart    ] ${fund.ticker}: chart window does not join the published history (${config.historyRange})`); }
      else days = windowed;
    } catch (error) { failures.push(errorText(error)); }
    if (!days.length && previousHistory.rows.length && !failures.some(text => text.startsWith('[chart'))) failures.push(`[chart    ] ${fund.ticker}: no price rows`);
  }
  // A fund with published data is kept untouched when any required source failed. A brand-new fund whose holdings failed
  // (VCM and N-PORT gave no rows) is not published either, even when Yahoo answered: it fails and keeps a catalog-only
  // index row (dataFile null), never an `updated` meta with 0 holdings.
  if (failures.length && (prior || !holdRows.length)) throw new Error(failures.join('; '));
  // Fresh holdings (VCM or the N-PORT fallback; never retained) that look broken - no weight column, non-numeric weights,
  // a bad weight sum, half the rows gone - never replace the published ones; a new fund is then not written at all.
  const publishedHoldingsRows = prior && isRecord(prior.holdings) ? toNumber(prior.holdings.totalRows) : null;
  const publishedWeights = previousHoldings.rows.length ? holdingsWeightCount(previousHoldings.headers, previousHoldings.rows) : null;
  const holdingsProblem = holdingsGuard(official.headers, holdRows, publishedHoldingsRows, HOLDINGS_GUARD_RELAX[fund.ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights);
  if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${prior ? 'kept the previous complete data' : 'no data published for this fund yet'}`);

  const premium = parsePremiumDiscount(pdPayload);
  const freshHistory = days.length > 0;
  const retainedHistory = !freshHistory && config.skipYahoo ? previousHistory.rows : [];
  const hRows = freshHistory ? historyRows(days, premium, previousHistory.rows) : retainedHistory;
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
  const payloadYield = toNumber(valueFrom(yields, 'dividend_yield_percentage'));
  const declaredYield = payloadYield ?? fund.dividendYield;
  const declaredBasis = payloadYield !== null ? 'official-other' : yieldBasisOf(fund.dividendYield, fund.dividendYieldBasis);
  const payments = distributions.frequency ? ANNUAL_PAYMENTS[distributions.frequency] : undefined;
  const indicatedYield = distributions.latest !== null && payments && market !== null && market > 0 ? round((distributions.latest * payments / market) * 100, 2) : null;
  const dividendYield = declaredYield ?? indicatedYield;
  const dividendYieldBasis = declaredYield !== null ? declaredBasis : yieldBasisOf(indicatedYield, 'indicated');
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
      dividendYieldBasis,
      dividendYieldKind: declaredYield !== null && dividendYieldBasis !== 'indicated'
        ? `VCM published dividend yield${yieldDate ? ` as of ${yieldDate}` : ''}`
        : dividendYield !== null ? 'Indicated from the latest reported distribution per share x inferred payments per year / market price' : null,
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
async function processFund(fund: Fund, key: string, config: Config, reporter: ReturnType<typeof createRunReporter>): Promise<FundOutcome> {
  const before = await outputInspectFund(apiRoot, fund.ticker);
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
  resetSecState();
  printUpdaterConfig(config);
  const previous = await previousIndex();
  let catalog: Fund[] = [];
  let api: { endpoint: string; apiKey: string } | null = null;
  try {
    api = await loadApiKey(config);
    catalog = parseCatalog(await getJson(api.endpoint, '[catalog  ] VictoryShares ETF list', issuerApiHeaders(api.apiKey), config));
  } catch (error) {
    console.warn(`[ catalog  ] ${errorText(error).replace(/^\[[^\]]*\]\s*/, '')} - retaining the published catalog`);
  }
  const catalogRead = catalog.length > 0;
  const usingCachedCatalog = !catalogRead;
  if (usingCachedCatalog) catalog = [...previous.values()].map(cachedFundFromIndex).filter(fund => Boolean(fund.ticker));
  if (!catalog.length) throw new Error('No current or previously published catalog is available');

  const liveTickers = new Set(catalog.map(fund => fund.ticker));
  // Q27: a TICKERS entry outside the live catalog and the published funds stops the run before any fund request
  assertKnownTickers(config.tickers.size ? Array.from(config.tickers) : null, knownTickers(catalogRead ? Array.from(liveTickers) : null, Array.from(previous.values())), 'the VCM catalog or published feed');
  let droppedFunds: string[] = [];
  if (catalogRead) {
    const absent = [...previous.keys()].filter(ticker => !liveTickers.has(ticker)).sort();
    const truncated = previous.size > 0 && catalog.length < Math.ceil(previous.size / 2);
    if (truncated && absent.length) {
      console.warn(`[ catalog  ] catalog looks truncated (${catalog.length} of ${previous.size} published funds): keeping every published fund`);
      for (const ticker of absent) catalog.push(cachedFundFromIndex(previous.get(ticker) as JsonRecord));
    } else {
      // A closed fund the issuer no longer lists keeps its published row and files: closed funds are never pruned.
      const closedAbsent = absent.filter(ticker => closedFund(CLOSED_FUNDS, ticker) !== null);
      for (const ticker of closedAbsent) catalog.push(cachedFundFromIndex(previous.get(ticker) as JsonRecord));
      droppedFunds = absent.filter(ticker => closedAbsent.indexOf(ticker) < 0);
    }
  }
  catalog.sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(`[ catalog  ] ${catalog.length} VictoryShares ETFs (${catalogRead ? 'VCM public ETF JSON API' : 'previously published catalog'})`);
  const notices: string[] = [];
  if (droppedFunds.length) notices.push(`DROPPED FUNDS: ${droppedFunds.join(', ')}`);
  for (const notice of notices) console.log(`[ catalog  ] ${notice}`);
  await appendStepSummary(notices.map(notice => `- ${notice}`));

  const deferredDividend = config.dividendYield.min !== undefined || config.dividendYield.max !== undefined;
  const deferredSec = config.secYield.min !== undefined || config.secYield.max !== undefined;
  // A closed fund is never fetched, not even for a data-dependent filter.
  const deferredFunds = catalog.filter(fund => !closedFund(CLOSED_FUNDS, fund.ticker) && ((deferredDividend && fund.dividendYield === null) || (deferredSec && fund.secYield === null)));
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
        const published = toNumber(yields.dividend_yield_percentage);
        fund.dividendYieldBasis = published !== null ? 'official-other' : 'indicated';
        fund.dividendYield = published ?? (parsed.latest !== null && payments && marketPrice !== null && marketPrice > 0 ? round(parsed.latest * payments / marketPrice * 100, 2) : null);
      }
    });
  }
  const eligible = catalog.filter(fund => fundPasses(fund, config));
  // Closed funds leave the queue here, before the MAX_FETCHES window and any per-fund request: never fetched, guarded or reported.
  const selectedByTicker = withoutClosedFunds(config.tickers.size ? eligible.filter(fund => config.tickers.has(fund.ticker)) : eligible, fund => fund.ticker, CLOSED_FUNDS);
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
  const reporter = createRunReporter(selected.length);
  const activeApiKey = api?.apiKey ?? '';
  const started = await mapWithConcurrency(selected, config.concurrency, async fund => {
    if (!api) {
      const before = await outputInspectFund(apiRoot, fund.ticker);
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
  const indexRows: JsonRecord[] = [];
  for (const fund of catalog) {
    const outcome = outcomes.get(fund.ticker);
    const existing = previous.get(fund.ticker);
    if (outcome?.ok) indexRows.push(indexRow(fund, outcome.meta));
    else if (existing) indexRows.push(existing);
    else {
      const meta = await readJson(new URL(`funds/${fund.ticker}/meta.json`, apiRoot));
      indexRows.push(indexRow(fund, isRecord(meta) ? meta : null));
    }
  }
  // A closed fund keeps its published row plus status 'closed', closedDate and closedSource.
  const indexFunds = markClosedFunds(indexRows, CLOSED_FUNDS);
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
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const report = newFundsReport(Array.from(previous.values()), indexFunds);
  const newFundLines = newFundsLines(report);
  for (const line of newFundLines) console.log(line);
  if (newFundLines.length) await appendStepSummary(['### NEW FUNDS', '', ...newFundLines]);
  const newFunds = report.published;
  for (const ticker of droppedFunds) await rm(new URL(`funds/${ticker}/`, apiRoot), { recursive: true, force: true });
  if (rotating && started > 0) await writeJsonIfChanged(stateUrl(), { lastProcessedTicker: selected[started - 1].ticker });
  const result = reporter.summary();
  console.log(reporter.summaryLine(startedAt));
  console.log(outputCounts(indexFunds.length, totalHoldings, totalHistory));
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

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for an equity row (assetCat EC or EP) traded in USD with a U.S. ISIN or none, and never one ticker on two
 *   different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/** A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped). */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const text = value.toFixed(digits);
  return text.indexOf('.') < 0 ? text : text.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/** A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*\/\s*[A-Za-z]{2,3}\s*\/?)+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ');
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|NV|AG|SE|SPA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/** SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too). */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
  }
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to an equity row (assetCat EC or
 * EP) traded in USD (or with no currency) whose ISIN is U.S. or missing: first the filer's own `<ticker value>`, else the
 * SEC issuer-name table (`names`) when the row has a CUSIP or a U.S. ISIN. A ticker that lands on two different securities
 * (Alphabet A and C, an ordinary share and its ADR) is dropped from the name-matched rows; when the filer itself gave it
 * to two securities it is dropped from all of them. Bonds, cash, funds and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = (position.assetCat === 'EC' || position.assetCat === 'EP') && !position.derivative;
    const usd = !position.currency || position.currency === 'USD';
    if (!equity || !usd || (position.isin && position.isin.slice(0, 2) !== 'US')) return '';
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker)) {
      fromFiler[index] = true;
      return position.ticker;
    }
    if (!names || !(/^[0-9A-Z]{9}$/.test(position.cusip) || /^US[0-9A-Z]{10}$/.test(position.isin))) return '';
    const key = nportNameKey(position.name);
    return names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  return tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
