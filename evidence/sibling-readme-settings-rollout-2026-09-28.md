# VictoryShares family README and repository-settings sync

Date: 2026-09-28 (America/New_York)

## About and repository settings

- Description: `VictoryShares ETF. A single-file client-side tool reading ./api/victoryshares (VCM public catalog/product JSON, SEC EDGAR N-PORT-P holdings fallback and Yahoo Finance adjusted market-price history) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist, CSV/TXT export. TailwindCSS, dark mode, Bun updater.`
- Homepage: `https://daggerok.github.io/VictoryShares/`
- Topics (20): `css csv dark-mode edgar etf finance github-pages holdings html json nport single-file static-api tailwindcss txt typescript victoryshares victoryshares-etfs watchlist yahoo-finance`
- Compared across the 18 sibling ETF repositories plus VictoryShares: all had public visibility, `main` default branch, issues enabled, Pages enabled, wiki/projects/downloads/discussions disabled, forking enabled, squash and rebase merges enabled, merge commits disabled, delete-branch-on-merge enabled, web commit sign-off disabled, update-branch enabled, auto-merge disabled, and squash-title preference disabled. No setting changes were needed for these common values.
- Branch-protection endpoint returned 404 for all 19 repositories (no branch-specific protection rules). Actions workflow defaults matched across the family: read-only `GITHUB_TOKEN` and no permission to approve pull requests. Pages configuration matched: legacy `main` branch root, HTTPS enforced; VictoryShares Pages API reports `built`.
- No secrets, Actions variables, protected settings, or Pages source values were copied or changed. The shared About fields and brand-specific topic names were aligned; provider/source text remains brand-specific.

## Sibling README PRs

Each PR changed only `README.md`, adding the VictoryShares row to the existing Brands table and Sibling applications table immediately before WisdomTree. The row formatting and existing content were left unchanged. All 18 default-branch READMEs were fetched after merge and both rows were confirmed present. All PRs were mergeable/clean, with no status contexts/check runs and no requested reviews; merged with squash.

- [daggerok/aberdeen PR #5](https://github.com/daggerok/aberdeen/pull/5) — merged; merge commit `2b2458f8f3cfa47b2ceae30121cac4f17a67197f`.
- [daggerok/Amplify PR #49](https://github.com/daggerok/Amplify/pull/49) — merged; merge commit `5427955f647c34b71f84e0bdb050e053d2f04975`.
- [daggerok/Capital-Group PR #2](https://github.com/daggerok/Capital-Group/pull/2) — merged; merge commit `bf436635412203a91fa3d60cfc404d2b08f5c4fc`.
- [daggerok/Fidelity PR #24](https://github.com/daggerok/Fidelity/pull/24) — merged; merge commit `527120cd158cfe29e6a0fa2af0280ab032741f90`.
- [daggerok/Franklin PR #23](https://github.com/daggerok/Franklin/pull/23) — merged; merge commit `ad05e7ef98b0fcdca64646cf787effc545053bcd`.
- [daggerok/Global-X PR #10](https://github.com/daggerok/Global-X/pull/10) — merged; merge commit `d7dbccd445334cdc62ba4a5fb271b9d3177bcb52`.
- [daggerok/Goldman-Sachs PR #19](https://github.com/daggerok/Goldman-Sachs/pull/19) — merged; merge commit `1485e19582e95042a40571e090926db8c1742b75`.
- [daggerok/Invesco PR #25](https://github.com/daggerok/Invesco/pull/25) — merged; merge commit `2822ebd8ff3d40ffbb17a8d282e1e45798828b57`.
- [daggerok/iShares PR #50](https://github.com/daggerok/iShares/pull/50) — merged; merge commit `3dceb33c1583e6f26e5700ee8caf05fd21880291`.
- [daggerok/JPMorgan PR #22](https://github.com/daggerok/JPMorgan/pull/22) — merged; merge commit `71c98f72e4d3b7788610fc5cb794443b5d18c444`.
- [daggerok/NEOS PR #20](https://github.com/daggerok/Neos/pull/20) — merged; merge commit `c8e9c2ede075488e768bfe73e13bcb73238d889d`.
- [daggerok/Northern-Trust PR #3](https://github.com/daggerok/Northern-Trust/pull/3) — merged; merge commit `d3634142852d62e00d2fa2dafde2605ece850ee8`.
- [daggerok/ProShares PR #22](https://github.com/daggerok/ProShares/pull/22) — merged; merge commit `a4f4b73b79954df088a030f4115a51d11d1878c9`.
- [daggerok/Schwab PR #18](https://github.com/daggerok/Schwab/pull/18) — merged; merge commit `f283e5bcbb2e0c4c1487aeaa077156c1070b448d`.
- [daggerok/SPDR PR #35](https://github.com/daggerok/SPDR/pull/35) — merged; merge commit `df7d3d97ccf15448dc1bc58298f5947ba2f74f4c`.
- [daggerok/VanEck PR #21](https://github.com/daggerok/VanEck/pull/21) — merged; merge commit `26c97b8b8a62f1b24209a5304d302d9cd9e7e0c1`.
- [daggerok/Vanguard PR #31](https://github.com/daggerok/Vanguard/pull/31) — merged; merge commit `e4e565b28d34beb8b28882bff87d243dd6d17941`.
- [daggerok/WisdomTree PR #31](https://github.com/daggerok/WisdomTree/pull/31) — merged; merge commit `f0cb848495d2bcb090aec014ccd5e4931d692c2f`.

## VictoryShares publication verification

- The user/`daggerok` merged target PR #1 on 2026-09-28 at 06:28:35 UTC; merge commit `242c0d13d900912999f36e7a2fac5e936fe8950f`. This merge is attributed to GitHub as `daggerok`, not to this agent.
- GitHub Pages API reports `built` from `main:/` with HTTPS enforced. Verified HTTP 200 for the root page, catalog JSON, VFLO metadata and USTB holdings page 005.
- The published catalog contains 25 funds. The current merged API tree contains metadata and pages for all 25 funds; aggregate index counts are 7,991 holdings and 6,668 history rows. The full-catalog data commits (`eef4a311`, `c3786a5d`, `f35bffcb`, `946fb62a`) are attributed by GitHub to `daggerok` and were not produced by the bounded smoke runs in the original implementation work.
- README now states the published site is available; the earlier three-fund seed caveat was removed because the merged current feed now has per-fund data for all 25 catalog entries.
