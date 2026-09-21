# jev stock screener

A screener over the full universe of US operating companies (~4,000–5,000 names) where
**TypeScript computes facts and [jev](https://openrouter.ai/~typesafe/jev-latest) makes every
decision**, exposed as an MCP server so Claude can drive it conversationally.

There is no scoring function in this repository. No thresholds, no weights, no cutoffs, no
tie-breaks. A company is included because `verdict.choice === "include"`, and it ranks where it
ranks because of `attractiveness.score`. If you go looking for the rule that decides what is
good, you will not find one — that is the design, not an omission.

> Output is **candidates for human review**. This system never places orders and makes no buy or
> sell recommendation.

## Setup

```sh
npm install
cp .env.example .env    # OPENROUTER_API_KEY, and EDGAR_USER_AGENT with your own address
npm run check           # confirms the key works and jev is reachable
npm run ingest          # ~5 min: two bulk ZIPs from SEC EDGAR
npm run screen          # the full pipeline
```

Node 22 or newer. TypeScript runs through Node's built-in type stripping — no bundler.

The SEC requires a descriptive `User-Agent` naming the operator and blocks anonymous automated
traffic, so `EDGAR_USER_AGENT` is not optional.

## The rule this is built around

**TypeScript computes facts. jev makes decisions.**

Code may do arithmetic and carry provenance. Code may not decide what is good, what passes, what
ranks higher, or what is confident enough. Three consequences follow, and they are worth stating
plainly because each one is a place the design could quietly rot:

| Concern | Belongs to | Read as |
| --- | --- | --- |
| Can we evaluate this company at all? | code | eligibility predicates |
| Is this company any good? | jev | `verdict.choice`, argmax |
| Where does it rank? | jev | `attractiveness.score`, expected value |

Discrete decisions are `choice` questions read via `.choice` — never a probability compared to a
threshold. Ordered ones are `score` questions read via `.score` — never a weighted formula. `noul`
answers may be shown to you but never drive control flow.

Two tests enforce this mechanically. `no decision threshold has crept into the judgment path`
scans the source for comparisons against fractional literals and for `noul` in control flow;
`the only tunable numbers live in constants.ts` pins the exact list of permitted constants. Both
fail the build if violated — verified by injecting a threshold and watching it break.

### Eligibility is not judgment

Eligibility answers *can we evaluate this company*, using only the **presence, recency and
completeness** of data:

- files 10-K/10-Q rather than 20-F, 40-F or N-CSR
- has a 10-K filed within 18 months
- has at least 12 quarters of revenue observations
- has net income, operating cash flow and total assets on file

Never its values. "Revenue growth above X" or "market cap above Y" would make this file the
screener, which is exactly what it must not be. A company with catastrophic numbers is eligible;
jev is the one that decides what to do about them.

## How it runs

1. **Ingest** — two bulk ZIPs from EDGAR (`companyfacts.zip`, `submissions.zip`) cover the entire
   universe in two requests. Exploded into one observation per (metric, period, filing),
   append-only. Then the daily index keeps it current.
2. **Eligibility** — derives the universe by the predicates above. No hand-written ticker list.
3. **Slice** — bind an `asOf` reader; read latest-known values.
4. **Metrics** — pure arithmetic: growth, margins and their trend, FCF conversion, pre-tax ROIC,
   net debt/EBITDA, dilution, accrual ratio, working-capital-versus-sales gaps.
5. **Peer context** — the metric distribution (min/p25/median/p75/max) across the **whole eligible
   universe** and within the company's sector.
6. **Stage 1, triage** — one jev call per eligible company, ~300 tokens, no filing text. One
   question: `advance`.
7. **Stage 2, judgment** — for survivors only, fetch price and filing text, then ask the full
   seven-question set (~15,000 tokens).
8. **Assemble** — inclusion from `verdict.choice`, order from `attractiveness.score`.
9. **Persist** — every run is written to the `runs` table, in full.

### Why the peer context is computed once

`attractiveness.score` values are comparable across calls only if every call saw the *same*
yardstick. The distributions are therefore computed once over the entire eligible universe and
passed identically into every call. A per-batch distribution would make a company's score depend
on which companies happened to be in its batch, and the ranking would silently stop meaning
anything. `peers.test.ts` asserts that a one-ticker screen still sees the full universe.

### The judgment cache is what makes this affordable

A judgment is a pure function of (company, question set, input vintage). Keyed that way, an entry
expires when a **new filing lands** — not when time passes. Steady state is therefore whichever
companies filed since the last run, roughly 40–60 a day, rather than 5,000.

Market data is deliberately excluded from the vintage. A closing price is new every trading day,
so counting it would expire every judgment nightly and undo the whole thing. The trade-off is
real: a cached verdict was formed against the multiples of the day it was made, so a company
whose price has moved sharply carries a stale valuation until its next filing.

A fully cached run touches neither Stooq nor EDGAR and needs no API key at all, which is what
makes `screen_run` cheap enough to call from a conversation.

## Four limitations, stated plainly

**1. Triage sees no price.** Stooq has no bulk endpoint, so prices are fetched only for triage
survivors. Stage 1 therefore judges operating fundamentals with no valuation multiple whatsoever —
a company is advanced because of what the business looks like, never because it looks cheap.
Multiples exist only at stage 2. `ingest --prices-all` refreshes the full eligible universe if you
would rather pay that cost on a schedule.

**2. This screener judges quality, not mispricing.** There is no free consensus-estimate feed
worth using, so nothing here knows what the market expects. It can tell you a business looks
durable and well-run; it cannot tell you that is not already in the price.

**3. It cannot be backtested.** There is no deterministic component — every decision comes from a
model whose training data may already contain what happened after the filings it is reading. A run
against a past `asOf` measures hindsight, not skill. So `asOf` more than 7 days old **refuses to
run** unless `allowContaminated: true` is passed, in which case every result is stamped
`contaminated: true` with a notice saying it must not be used to evaluate performance.

Forward-only grading is the only honest scorecard this system can have, and it cannot be
backfilled. That is why every run is persisted as it happened.

**4. XBRL tagging is messy.** Filers tag the same concept differently. Each concept has an ordered
fallback chain, and the tag that actually matched is recorded on every observation, so the mapping
is auditable after the fact rather than taken on trust.

## Point-in-time or nothing

The unit of data is an `Observation`:

```ts
{ value, metric, entity, validAt, knownAt, source, reliability, tag? }
```

`validAt` is the period described; `knownAt` is when it became knowable (EDGAR's `filed` field;
for prices, the close date). `reliability` is `audited | reported | market | jev`.

Observations are readable **only** through a reader bound to an `asOf`, filtering `knownAt <= asOf`
with the latest revision winning. There is deliberately no "give me the latest" accessor on the
store — that is the call site where look-ahead would enter. The store is append-only: a
restatement is a new row, never an overwrite, so asking "what did we know in June?" keeps working
after the number changes in August.

Derived figures compose their provenance rather than asserting it: a computed ratio is knowable
only once its last input was, and is no more reliable than its weakest input. A price-derived
multiple is therefore `market`, never `audited`.

## MCP tools

Three, all read-only. None triggers a sweep; ingest and the nightly screen are jobs you schedule.

```sh
npm run mcp     # stdio
```

| Tool | Returns |
| --- | --- |
| `screen_run({ tickers?, sector?, asOf?, limit? })` | included picks in jev's order, each with its full verdict distribution and attractiveness score. `limit` truncates output only — presentation, never selection. |
| `explain_pick({ ticker, asOf? })` | every observation with its `knownAt` and XBRL tag, every jev answer with its complete distribution, and whether it came from cache. |
| `coverage_status()` | universe size, eligibility counts and why companies were excluded, per-source last successful fetch, recent failures, cache hit rate. |

Register it with Claude Code:

```sh
claude mcp add jev-screener -- node --env-file-if-exists=.env /absolute/path/to/src/mcp.ts
```

## Commands

```sh
npm run ingest                      # backfill from the bulk ZIPs
npm run ingest -- --prices-all      # also refresh prices for the whole universe (slow)
npm run screen                      # full pipeline, ranked picks
npm run screen -- --ticker=AAPL,MSFT --limit=10
npm run screen -- --sector=retail
npm run screen -- --as-of=2024-06-30 --allow-contaminated
npm run screen -- explain --ticker=AAPL
npm run screen -- coverage
npm run mcp                         # MCP server on stdio

npm run check                       # is the key live and is jev reachable?
npm test                            # offline; no network, no API key
npm run typecheck
```

## Layout

```
src/constants.ts     every permitted operational constant, in one place
src/observation.ts   branded units, Observation<T>, the as-of reader
src/store.ts         DuckDB schema, point-in-time reads, runs + judgment cache
src/edgar.ts         bulk ZIP ingest (incl. a ZIP64 reader), throttle, tag resolver, SIC
src/prices.ts        Stooq adapter, lazy per-survivor fetch
src/universe.ts      eligibility predicates (presence/recency/completeness only)
src/metrics.ts       arithmetic only, zero judgment
src/peers.ts         universe-wide and sector metric distributions
src/screen.ts        both jev question sets, the typed calls, result assembly
src/cache.ts         judgment cache keyed on input vintage
src/pool.ts          bounded-concurrency runner and rate limiter
src/cli.ts           the pipeline, plus ingest / screen / explain / coverage
src/mcp.ts           MCP stdio server
```

There is deliberately no `scoring.ts`. If you find yourself wanting one, the design has been
violated.

The tests are offline: jev, EDGAR (including the bulk ZIP path, exercised against real archives
built byte by byte in the test) and Stooq are all stubbed. `npm test` needs no network and no API
key.

## Data sources

Two, both free, neither needing an API key.

- **SEC EDGAR** — bulk `companyfacts.zip` and `submissions.zip`, the daily index for updates, and
  filing text fetched on demand for stage-2 survivors only. Throttled to 10 requests/second inside
  the adapter, not at the call sites. Sector comes from the SIC code in the submissions record.
- **Stooq** — keyless daily OHLCV CSV, fetched lazily at ~2 requests/second and cached.

Raw payloads are cached under `data/`, which is gitignored.

## The jev question sets

Bump `QUESTION_SET_VERSION` in `constants.ts` on any change to either set — wording, criteria,
ordering, additions or removals. Judgments are cached under that string, so a stale version
silently serves answers to a question you no longer ask.

**Stage 1** — state is the metrics row plus both peer contexts. No filing text.

- `advance` — `choice` over `advance | drop`

**Stage 2** — adds multiples and an MD&A / Risk Factors excerpt.

- `verdict` — `choice` over `include | watch | exclude` — *this is the screen*
- `attractiveness` — `score` — *this is the rank key*
- `durability` — `score`, three-year revenue durability
- `accountingQuality` — `choice` over `clean | questionable | deteriorating`
- `dominantRisk` — `choice` over `demand | margin | balanceSheet | regulatory | none`
- `managementCandor` — `choice` over `direct | guarded | evasive`
- `sufficiency` — `choice` over `sufficient | thin | insufficient`

An `insufficient` answer excludes the company **by jev's own verdict** — it has said its verdict
should not be relied on — not by a confidence cutoff applied in code.

## Providers

`src/client.ts` picks the transport from the environment:

- **`OPENROUTER_API_KEY` set** — requests go to `https://openrouter.ai/api/v1/systemone`. Model ids
  stay bare (`jev-latest`); OpenRouter maps them into its `typesafe/` namespace and reports the
  concrete build it used, e.g. `typesafe/jev-1.13-20260917`.
- **otherwise** — the SDK's own defaults: `TYPESAFE_API_KEY` against `api.typesafe.ai`.

Switching is an env change only. One caveat through OpenRouter: `client.models.list()` rejects
OpenRouter's Models API response format, and System One models do not appear in
`/api/v1/models` at all. Browse [the model list](https://openrouter.ai/typesafe) on the web
instead; nothing here calls it.

## The support-ticket demo

The original starter is still here and still runs — `src/triage.ts` and `src/index.ts` triage a
support ticket through the same SDK, and are the shortest way to see all three question types.

```sh
npm run dev -- "my login is broken"
```

Note that `route()` in `triage.ts` encodes decisions as hardcoded thresholds. The screener
deliberately inverts that. It is kept as a contrast, not a pattern to copy.
