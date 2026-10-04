# VictoryShares

One of the app's features lets you select VictoryShares ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size. Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/victoryshares` static feed (Victory Capital Management's VictoryShares ETF catalog and per-fund product JSON - published NAV returns, expenses, yields, current holdings and distributions - plus Yahoo Finance adjusted market-price history, VCM premium/discount data and SEC EDGAR N-PORT-P as a holdings fallback) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/VictoryShares#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/VictoryShares/>.

### Column types and filters

Every column of the ETF catalog and of the Watchlist, Holdings, History and Distributions tabs has a type: text (`ABC`), number (`123`), percentage (`%`), money (`$`), date (`D`), date and time (`DT`) or time of day (`T`). The type is detected from the texts the column shows (80% of the filled cells must agree, otherwise text) and is written in the badge next to the column title: click it to cycle the type, Shift+click to return to auto-detection. Dates are read as `2024-06-15`, `6/15/2024`, `15.06.2024`, `Jun 15, 2024` or `15-Jun-2024`, date and time as `2024-06-15T09:30:00Z` or `2024-06-15 09:30`, time as `09:30`, `16:00:00` or `9:30 PM`

A row of filter inputs sits under the column headers (the `Filters` button hides it, `Clear filters` empties it). Filters of different columns are combined with AND, the search box applies on top, and Copy Tickers and the exports use the filtered rows. Filters and type overrides are remembered in the browser

Inside one filter: a space means AND, a comma means OR, a leading `!` means NOT, `?` matches an empty or unavailable value and `!?` a value that is there; a value that is unavailable matches only `?` and negated conditions. An unquoted space ends the value, so quote values that contain one (`>="2024-06-15 09:30"`)

| Type | Examples |
| --- | --- |
| Text | `bank` contains, `"two words"`, `!bank`, `=exact`, `^starts`, `ends$`, `/regex/`, `tech, health` |
| Number, percentage, money | `>10`, `>=10 <50`, `=22` (matches what rounds to 22), `!=22`, `10..50`, `..50`, `10..`, `>1B` and `K` `M` `B` `T` suffixes, an optional `$` or `%` |
| Date, date and time | `>2024-06-01`, `2024` (the whole year), `2024-06` (the whole month), `2024-01..2024-06`, `today`, `yesterday`, `-7d..` (the last 7 days), `+2w`, `-3m`, `-1y` |
| Time | `>09:30`, `09:30..16:00`, `=12:00` (the whole minute) |

The `Columns` menu next to `Filters` lists every column of the ETF table from the first to the last, all of them shown by default, with a search box and the `All`, `Clear`, `Toggle` and `Reset` buttons. `Use` and `Ticker` are listed but locked. Hiding a column only removes it from the table: the filters, the sorting, the exports and Copy Tickers still use it. The choice is remembered in the browser (localStorage, never the data) and the menu is shown on the ETF catalog only

## Updating the static VictoryShares data

Run the updater with Bun:

```bash
bun install --frozen-lockfile
bun test
bun scripts/update-data.ts
```

Every supported control has a default in `scripts/update-data.config.json`; the same file feeds local runs and the **Update VictoryShares ETF data** workflow. Run `bun scripts/update-data.ts --help` to print every control. The weekly scheduled run uses the file defaults as-is. Precedence, lowest to highest: file defaults < `advanced` JSON < nonblank manual inputs < protected Actions variable or environment (blank inputs inherit the file value). All supplied filters use **AND** logic.

The workflow exposes 24 controls as individual inputs; every other control (for example `TOTAL_RETURN_10Y`) is reachable through the `advanced` JSON input, e.g. `{"TOTAL_RETURN_10Y": "50:"}`. Output always goes to `api/victoryshares`.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all listed VictoryShares ETFs) | [`https://investorapi.vcm.com/search/products/ETF`](https://investorapi.vcm.com/search/products/ETF), the JSON behind the [official VictoryShares ETF list](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) and [VictoryShares overview](https://www.vcm.com/products-fa/victoryshares-etfs). The updater acquires the public client configuration from the issuer page at runtime; no API key is stored in the repository. |
| Holdings per fund | `https://investorapi.vcm.com/search/product/{TICKER}/AllHoldings` (for example, [VFLO](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list/victoryshares-free-cash-flow-etf)). |
| Fund details, yields, distributions and premium/discount | `https://investorapi.vcm.com/search/product/{TICKER}/{Overview|Yields|Distributions|PremiumDiscount}`. NAV, expense, assets, performance and distribution values are published by VCM. |
| Daily history | [Yahoo Finance chart API](https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}) provides market-price and adjusted-close history as DAILY bars (explicit `period1`/`period2` with `interval=1d`; the `range=max` shortcut returns weekly, monthly or hourly bars depending on the fund's age, so it is never used); VCM's `PremiumDiscount` endpoint adds dated premium/discount observations. This tested feed does not supply official daily NAV history, so the NAV column is intentionally blank rather than inferred from market price. Yahoo adjusted-close history can be revised by the provider. |
| Holdings fallback | SEC EDGAR Form N-PORT-P for Victory Portfolios II (CIK `0001547580`, file no. `811-22696`), only when VCM does not provide holdings. SEC requests use the `SEC_UA` User-Agent. The filing must carry the fund's own series id and a report date newer than the published holdings, otherwise it is ignored. |

### Metrics and caveats

The updater uses issuer-published NAV performance values for month-end and quarter-end. The catalog's cumulative 3-, 5- and 10-year Total Return columns are derived from the corresponding published annualized NAV returns using `(1 + annualized return)^years - 1`; 1-year and YTD use the published period return. Missing tenors stay unavailable. Yahoo data is a separate market-price history series, not an official NAV series.

- Every `funds[].metrics` ends with `returnsBasis` (never empty: states that returns are official VCM NAV returns, with 3-, 5- and 10-year total returns derived from the published annualized NAV returns, and that Yahoo is not used for returns) and `performanceAsOf` (ISO `YYYY-MM-DD` date of the issuer month-end performance table the returns come from, not the NAV date; `null` when the issuer publishes no performance table for the fund)
- Net assets, expense ratios, NAV, yields, distributions and returns are issuer-published values; Yahoo adjusted-close history is a market-price series and an estimate, not official NAV
- The Yahoo `NAV` history column is intentionally blank rather than inferred from market price
- Every `funds[].metrics` has the same keys: `ytd`, `tr1y`, `tr3y`, `tr5y`, `tr10y`, `cagr3y`, `cagr5y`, `cagr10y`, `siAnn`, `dividendYield`, `dividendYieldText`, `secYield`, `secYieldText`, `returnsBasis`, `performanceAsOf`. `ytd` is the published year-to-date NAV return. Horizons longer than the fund's age and `siAnn` for funds younger than one year are `null`; `performanceAsOf` is `null` when the fund has no published returns (for example VMHY and VMSD, incepted 2026-09-22)
- Missing values stay unavailable (shown as a dash) and are never treated as zero; a filter with a bound excludes funds without that value. A provider-published real `0.00%` (for example the GFLW 30-day SEC yield) stays `0`
- Missing holdings `Weight` or `Market Value` stay empty instead of becoming `"0"`
- Expense ratio: `terValue` is the NET expense ratio (after waivers; the gross value when it is the only one published) and `terGrossValue` is the GROSS ratio when published; `meta.json` `expenseRatio` carries `value`/`net` (net) and `gross`. The `TER` filter applies to the net ratio
- `distributions.dividend` is a string (or `null`), like every other feed
- A fund is either fully updated or fully kept: it is built completely in memory and written once (pages, then `meta.json`, then stale pages are removed, then the index row). When a required source (Overview, Yields, Distributions, AllHoldings or its EDGAR fallback, PremiumDiscount, Yahoo) fails for a fund that already has published data, none of its files or its index row change. Funds not selected in a run keep their published row verbatim. A source that answers with an honest `null` is published as `null`, never replaced by an older value
- A rerun with identical upstream data changes nothing: files are compared without `generatedAt` and written only on change (through a temporary file and rename); `generatedAt` is ISO UTC without milliseconds
- Tickers in the live catalog that are not in the published index are printed as `NEW FUNDS: A, B`; tickers that vanished from a successfully read, non-truncated catalog are printed as `DROPPED FUNDS: X` (also appended to `$GITHUB_STEP_SUMMARY`) and removed with their `funds/<T>/` folder. A catalog with fewer than half of the published funds is treated as truncated and drops nothing
- Every request has a 45 s timeout that covers headers and body; the run stops starting new funds after 25 minutes and still writes the index; the exit code is non-zero when every selected fund failed
- Fund pages carry the as-of date and source of their holdings and history; an N-PORT-P fallback snapshot may be less current than issuer holdings
- A limited `TICKERS` run keeps the full published catalog and the data files of unselected funds

### Update controls

Keys of `scripts/update-data.config.json` (all values are strings); each is also an environment variable and an `advanced` key. Every control also reads `VICTORYSHARES_<NAME>` from the environment (for example `VICTORYSHARES_CONCURRENCY=7`), and `HISTORICAL_PAGE_SIZE` is an alias of `HISTORY_PAGE_SIZE`. Aliases sit in the environment layer: the plain name wins when both are set, an explicitly empty alias counts as set, and validation is the same.

| Control | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` (all) | Funds per batch, counted among the funds that pass the filters. With a positive value, processing resumes after the saved ticker cursor and wraps around; `0` processes all eligible funds. A `TICKERS` run never touches the cursor |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between request starts per worker lane |
| `CONCURRENCY` | `2` | Number of parallel fund workers |
| `MAX_RETRIES` | `2` | Retries after the initial request (integer >= 1); timeouts, network errors and HTTP 408/425/429/5xx responses are retried |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily-history JSON page  |
| `HISTORY_RANGE` | `max` | Yahoo history length: `max` or a whole number of years such as `10y`, `5y`, `1y`; sent as explicit `period1`/`period2` with daily bars (anything else is an error) |
| `TICKERS` | all (empty) | Space-, comma- or semicolon-separated ticker allowlist, e.g. `VFLO USTB UEVM` |
| `AUM` | `:` | Net Assets range; each bound may be a USD amount or use `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large` |
| `TER` | `:` | Net expense-ratio range in percent (`min:max`) |
| `DIVIDEND_YIELD` | `:` | Published dividend-yield range in percent |
| `SEC_YIELD` | `:` | Published 30-day SEC yield range in percent |
| `PERFORMANCE_YTD`, `_1Y`, `_3Y`, `_5Y`, `_10Y` | `:` | Published NAV return ranges in percent (`PERFORMANCE_1Y` and so on); multi-year values are VCM annualized figures |
| `TOTAL_RETURN_YTD`, `_1Y`, `_3Y`, `_5Y`, `_10Y` | `:` | Total Return ranges in percent (`TOTAL_RETURN_1Y` and so on); multi-year values are derived from VCM annualized NAV returns as described above |
| `EDGAR_FALLBACK` | `true` | Use SEC N-PORT-P holdings when official VCM holdings are unavailable |
| `SKIP_YAHOO` | `false` | Skip Yahoo history requests; retain existing history when available |
| `VERBOSE` | `false` | Show per-request retries and fallback details |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | SEC User-Agent string with a contact, used for EDGAR fallback requests; redacted in logs. A blank value uses the default contact |

`TICKERS` combines with AUM, TER, yield and return filters using AND logic. An explicitly set environment variable wins over every file or input value, even when empty (an empty value clears the control).

For GitHub Actions runs, the optional repository variable `SEC_UA` (**Settings -> Secrets and variables -> Actions -> Variables**) overrides the default User-Agent. It is read by scheduled and manual runs, wins over any file, `advanced` or input value when nonblank, and is not a dispatch input.

### Examples

```bash
bun scripts/update-data.ts --help
MAX_FETCHES=10 bun scripts/update-data.ts
TICKERS="VFLO USTB UEVM" bun scripts/update-data.ts
AUM="1B:" TER=":0.5" bun scripts/update-data.ts
PERFORMANCE_1Y="15:" bun scripts/update-data.ts
```

Workflow `advanced` input example: `{"HISTORY_PAGE_SIZE": "500", "SKIP_YAHOO": "true"}`

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

`bun test` also covers the resolver, the config/README/`--help` parity and the workflow structure checks.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com fund pages and sitemap + official Invesco fund API (monthly returns, NAV, AUM, yields, daily holdings, expense ratio) + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT - same as all sibling ETF repositories.](./LICENSE)

VictoryShares and Victory Capital Management and the fund names/tickers referenced here are trademarks of their respective owners. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by Victory Capital Management or VictoryShares. All data is reproduced from Victory Capital Management's public fund pages and data, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
