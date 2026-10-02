# VictoryShares

One of the app's features lets you select VictoryShares ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size. Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/victoryshares` static feed (Victory Capital Management's VictoryShares ETF catalog and per-fund product JSON - published NAV returns, expenses, yields, current holdings and distributions - plus Yahoo Finance adjusted market-price history, VCM premium/discount data and SEC EDGAR N-PORT-P as a holdings fallback) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/VictoryShares#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/VictoryShares/>.

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
| Daily history | [Yahoo Finance chart API](https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}) provides market-price and adjusted-close history; VCM's `PremiumDiscount` endpoint adds dated premium/discount observations. This tested feed does not supply official daily NAV history, so the NAV column is intentionally blank rather than inferred from market price. Yahoo adjusted-close history can be revised by the provider. |
| Holdings fallback | SEC EDGAR Form N-PORT-P for Victory Portfolios II (CIK `0001547580`, file no. `811-22696`), only when VCM does not provide holdings. SEC requests use the `SEC_UA` User-Agent. An N-PORT snapshot may be less current than the issuer's daily holdings. |

### Metrics and caveats

The updater uses issuer-published NAV performance values for month-end and quarter-end. The catalog's cumulative 3-, 5- and 10-year Total Return columns are derived from the corresponding published annualized NAV returns using `(1 + annualized return)^years - 1`; 1-year and YTD use the published period return. Missing tenors stay unavailable. Yahoo data is a separate market-price history series, not an official NAV series.

- Every `funds[].metrics` ends with `returnsBasis` (never empty: states that returns are official VCM NAV returns, with 3-, 5- and 10-year total returns derived from the published annualized NAV returns, and that Yahoo is not used for returns) and `performanceAsOf` (ISO `YYYY-MM-DD` date of the issuer month-end performance table the returns come from, not the NAV date; `null` when the issuer publishes no performance table for the fund)
- Net assets, expense ratios, NAV, yields, distributions and returns are issuer-published values; Yahoo adjusted-close history is a market-price series and an estimate, not official NAV
- The Yahoo `NAV` history column is intentionally blank rather than inferred from market price
- Missing values stay unavailable (shown as a dash) and are never treated as zero; a filter with a bound excludes funds without that value
- Fund pages carry the as-of date and source of their holdings and history; an N-PORT-P fallback snapshot may be less current than issuer holdings
- A limited `TICKERS` run keeps the full published catalog and the data files of unselected funds

### Update controls

Keys of `scripts/update-data.config.json` (all values are strings); each is also an environment variable and an `advanced` key.

| Control | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` (all) | Funds per batch. With a positive value, processing resumes after the saved ticker cursor; `0` processes all eligible funds |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between request starts per worker lane |
| `CONCURRENCY` | `2` | Number of parallel fund workers |
| `MAX_RETRIES` | `2` | Retries after the initial request (integer >= 1); network errors and HTTP 408/425/429/5xx responses are retried |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily-history JSON page  |
| `HISTORY_RANGE` | `max` | Yahoo chart range: `max`, `10y`, `5y`, `2y`, `1y`, `6mo` or `3mo` |
| `TICKERS` | all (empty) | Space-, comma- or semicolon-separated ticker allowlist, e.g. `VFLO USTB UEVM` |
| `AUM` | `:` | Net Assets range; each bound may be a USD amount or use `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large` |
| `TER` | `:` | Gross expense-ratio range in percent (`min:max`) |
| `DIVIDEND_YIELD` | `:` | Published dividend-yield range in percent |
| `SEC_YIELD` | `:` | Published 30-day SEC yield range in percent |
| `PERFORMANCE_YTD`, `_1Y`, `_3Y`, `_5Y`, `_10Y` | `:` | Published NAV return ranges in percent (`PERFORMANCE_1Y` and so on); multi-year values are VCM annualized figures |
| `TOTAL_RETURN_YTD`, `_1Y`, `_3Y`, `_5Y`, `_10Y` | `:` | Total Return ranges in percent (`TOTAL_RETURN_1Y` and so on); multi-year values are derived from VCM annualized NAV returns as described above |
| `EDGAR_FALLBACK` | `true` | Use SEC N-PORT-P holdings when official VCM holdings are unavailable |
| `SKIP_YAHOO` | `false` | Skip Yahoo history requests; retain existing history when available |
| `VERBOSE` | `false` | Show per-request retries and fallback details |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | SEC User-Agent string with a contact, used for EDGAR fallback requests; redacted in logs |

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
| Invesco | invesco.com CSV downloads + Yahoo Finance | [Invesco](https://github.com/daggerok/Invesco) |
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
