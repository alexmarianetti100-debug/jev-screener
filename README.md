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
   universe in two requests. Membership comes from the facts archive, not the ticker
   file. Exploded into one observation per (metric, period, filing),
   append-only. Then the daily index keeps it current.
2. **Eligibility** — derives the universe by the predicates above. No hand-written ticker list.
3. **Slice** — bind an `asOf` reader; read latest-known values.
4. **Metrics** — pure arithmetic: growth, margins and their trend, FCF conversion, pre-tax ROIC,
   net debt/EBITDA, dilution, accrual ratio, working-capital-versus-sales gaps.
5. **Peer context** — the metric distribution (min/p25/median/p75/max) across the **whole eligible
   universe** and within the company's sector.
6. **Judgment** — fetch price and filing text, then one jev call per eligible company with the
   full seven-question set.
7. **Assemble** — inclusion from `verdict.choice`, order from `attractiveness.score`.
8. **Persist** — every run is written to the `runs` table, in full.

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

A fully cached run touches neither the price source nor EDGAR and needs no API key at all, which is what
makes `screen_run` cheap enough to call from a conversation.

## Identity: the CIK, never the ticker

Observations are keyed on the CIK. Tickers are display labels held in a separate list,
and three facts from the live archive are why:

- **SEC's ticker file omits companies.** Exxon Mobil Corp, CIK 34088, is not in
  `company_tickers.json` at all. Deriving the universe from that file dropped one of
  the largest filers in the country. Membership now comes from `companyfacts.zip`'s own
  central directory — every filer with XBRL data — read from ~20,000 filenames without
  decompressing a byte. A filer with no ticker is still a filer, shown as `CIK…`.
- **It points familiar symbols at the wrong filer.** `XOM` maps to CIK 2115436,
  "ExxonMobil Holdings Corp", which has two revenue quarters and no 10-K. It is now
  ineligible and cannot be judged, but the mapping is SEC's and we report it faithfully
  rather than inventing a correction. `resolveTickers` surfaces a contested symbol as
  ambiguous and never silently picks one — quietly choosing between two filers that
  claim a symbol is how a screener ends up confidently describing the wrong company.
- **One filer carries several symbols.** 1,448 of them do; Alphabet has GOOGL, GOOG,
  GOOGM and GOOGN. Keeping only one meant a screen for an ordinary ticker returned
  nothing.

## Tag selection: coverage, not chain position

Each concept has an ordered chain of XBRL tags, but the chain no longer picks the
winner. Every tag is evaluated, normalised to periods, and the one with the most
current series wins — recency bucketed by reporting quarter, then period count, with
chain order only as a tie-break.

Taking the first tag with *any* data looked reasonable and was badly wrong. Lockheed
adopted ASC 606, tagged seven periods under `RevenueFromContractWithCustomerExcludingAssessedTax`
around the transition, then reported under `Revenues` ever after. The old rule picked
the seven-entry stub, so Lockheed appeared to have stopped reporting revenue in 2018,
failed the 12-quarter eligibility test, and vanished from the universe. Its capex was
broken the same way, stopping in 2013. Tags are still never mixed — splicing ASC 605
and ASC 606 revenue would join two different definitions — and the winning tag is
recorded on every observation, so the choice stays auditable.

## Observed behaviour on real data

Measured on a live ingest, 2026-09-21:

| | |
| --- | --- |
| Filers with XBRL data | 20,390 |
| Observations ingested | 5,864,257 |
| Database size | 1.9 GB (+ 2.8 GB of cached archives) |
| **Eligible universe** | **3,962** |
| Biggest eligibility failures | too few revenue quarters (12,674), 10-K older than 18 months (8,949), no operating cash flow (6,170), no 10-K on file (5,477), foreign issuer or fund (4,156) |
| Slice + eligibility pass | ~10 s |
| Judgment | 9,824 input tokens/company, ~$0.00041 each |
| Eligible filers SEC lists no ticker for | 310 |

So a full sweep is roughly **$1.60**. The cache means you pay that once per filing cycle, not
per run.

### Why there is no cheap pre-filter

There was one: a `triage` stage that saw a metrics row and no filing text, and answered
`advance | drop` for ~300 tokens. On the live universe it advanced 3,173 of 3,305 — **96%** — so
it was not filtering, it was adding a call.

Rewording it would not have helped, and it is worth being clear about why. The only inputs that
let you say "no" with conviction are the filing text and the valuation, and those are definitionally
what the second stage adds. jev was being asked to discriminate on evidence too thin to
discriminate on, and it declined to — which is well-calibrated behaviour, not a bug.

Removing the stage also closed a subtler hole: it made an inclusion decision on *worse*
information than judgment did, so a company could be dropped for a reason the full question set
would have overturned. One pass, one question set, nothing that judges blind.

**Two operational constraints worth knowing:**

- **DuckDB takes a single write lock per file**, so one ingest, screen or MCP server at a time. A
  second one fails fast with a message naming the holding PID.
- **The price source can be unreachable.** After `PRICE_SOURCE_FAILURE_LIMIT` consecutive
  failures a run stops asking, records the reason, and continues without multiples. This is not
  hypothetical: the previous source (Stooq) turned out to be unroutable from this network
  entirely — not down, blocked — and a per-ticker adapter meant 3,000 doomed requests to learn
  what the first twenty already established.

  The visible consequence is instructive: with no prices, jev answered `sufficiency: thin` for
  **every** company it judged. That is the `sufficiency` question doing exactly what it is for —
  the model telling you its evidence was incomplete, rather than quietly scoring anyway.

## Four limitations, stated plainly

**1. Prices are end-of-day, and a filer with no ticker has none.** Polygon's grouped endpoint
returns every US ticker's close for a day in one request, so the whole universe costs one call
rather than 3,652. But it is keyed by symbol, so the 310 eligible filers SEC lists no ticker for
— Exxon Mobil Corp among them — are judged on fundamentals and filing text with multiples
absent. A dead source trips a circuit breaker rather than stalling the run.

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
                                    # (one writer at a time — see above)

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
src/prices.ts        Polygon adapter, one request per trading day
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
built byte by byte in the test) and Polygon are all stubbed. `npm test` needs no network and no API
key.

## Data sources

Two, both free, neither needing an API key.

- **SEC EDGAR** — bulk `companyfacts.zip` and `submissions.zip`, the daily index for updates, and
  filing text fetched on demand for stage-2 survivors only. Throttled to 10 requests/second inside
  the adapter, not at the call sites. Sector comes from the SIC code in the submissions record.
- **Polygon** — grouped daily aggregates: one request returns every US ticker's close for a
  trading day, so a routine refresh is a single call and a two-year backfill about 500. The free
  tier's five requests a minute is ample at that shape. A completed trading day never changes, so
  its response is cached permanently; an empty one (weekend, holiday) is not cached, because that
  is indistinguishable from a day not yet fetched. Needs `POLYGON_API_KEY`; without it the price
  stage is skipped and the run says so.

Raw payloads are cached under `data/`, which is gitignored.

## The jev question sets

Bump `QUESTION_SET_VERSION` in `constants.ts` on any change to either set — wording, criteria,
ordering, additions or removals. Judgments are cached under that string, so a stale version
silently serves answers to a question you no longer ask.

State is the metrics row, both peer contexts, the multiples where a price was available, and an
MD&A / Risk Factors excerpt.

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
