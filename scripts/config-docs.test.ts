/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls } from './update-data';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'VFLO' }, { CONCURRENCY: 3, TICKERS: 'USTB' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('6'); expect(c.TICKERS).toBe('USTB');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ TICKERS: 'VFLO' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
  expect(readConfig(resolveControls({ MAX_RETRIES: 0 })).maxRetries).toBe(0);
  expect(readConfig(resolveControls({ HISTORY_RANGE: '5y' })).historyRange).toBe('5y');
});

test('safe resolver rejects unknown, invalid and environment-file injection values', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { HOLDINGS_PAGE_SIZE: 0 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { EDGAR_FALLBACK: 'x' }, { AUM: '1:2:3' }, { TER: '5' }, { TICKERS: ['VFLO'] }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, 'x')).toThrow();
  expect(() => resolveControls({}, {}, { TICKERS: { a: 1 } })).toThrow();
});

test('all controls defaulted in tracked JSON; controls, --help and README in sync', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
  for (const value of Object.values(file)) expect(typeof value).toBe('string');
  const doc = read('README.md');
  const help = read('scripts/update-data.ts');
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    expect(doc).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
    if (tenor) expect(doc).toContain('`' + tenor[1] + '_YTD`');
    const helpName = name.match(/^(PERFORMANCE|TOTAL_RETURN)_/) ? name.replace(/_(YTD|1Y|3Y|5Y|10Y)$/, '') + '_{YTD,1Y,3Y,5Y,10Y}' : name;
    expect(help).toContain(helpName);
  }
  expect(doc).toContain('scripts/update-data.config.json');
});

test('scheduled path (empty inputs and advanced) equals config defaults with VictoryShares values', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  expect(resolveControls(file, {}, {}, {})).toEqual(file);
  expect(file.SEC_UA).not.toMatch(/@/);
  const config = readConfig(resolveControls(file));
  expect(config.tickers.size).toBe(0);
  expect(config).toMatchObject({ maxFetches: 0, requestSleep: 1, concurrency: 2, maxRetries: 2, holdingsPageSize: 250, historyPageSize: 1000, historyRange: 'max', edgarFallback: true, skipYahoo: false, secUa: '' });
  expect(config.aum.source).toBe(':');
});

test('protected SEC_UA variable wins only when nonblank', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
  expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
  expect(() => resolveControls(file, {}, {}, { SEC_UA: 'a\nb' })).toThrow();
});

test('runtime controls read the tracked file and let env override it', async () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  expect(await runtimeControls({})).toEqual(file);
  expect((await runtimeControls({ TICKERS: 'VFLO', CONCURRENCY: '3' })).CONCURRENCY).toBe('3');
});

test('workflow: <= 25 inputs with advanced, fixed api/victoryshares output, protected SEC_UA, no input interpolation', () => {
  const actual = read('.github/workflows/update-data.yml');
  const names = [...actual.slice(actual.indexOf('    inputs:'), actual.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map(m => m[1]);
  expect(names.length).toBeLessThanOrEqual(25); expect(names).toContain('advanced');
  for (const name of names.filter(n => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as never);
  expect(actual).toContain("default: '{}'");
  expect(actual).toContain("cron: '0 0 * * 0'");
  expect(actual).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
  expect(actual).toContain('resolveControls(file, advanced, individual, protectedVars)');
  expect(actual).toContain('toJSON(inputs)');
  expect(actual).not.toMatch(/\$\{\{\s*inputs\./);
  expect(actual).not.toMatch(/OUTPUT_DIR|output_dir/i);
  expect(actual).not.toContain('bunx tsc');
  expect(actual.match(/git add (\S+)/g)).toEqual(['git add api/victoryshares']);
  expect(actual.match(/api\/[\w-]+/g)!.every(p => p === 'api/victoryshares')).toBe(true);
});
