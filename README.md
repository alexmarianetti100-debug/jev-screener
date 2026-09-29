# jev stock screener

A screener over the full universe of US operating companies (~4,000–5,000 names) where
**TypeScript computes facts and [jev](https://openrouter.ai/~typesafe/jev-latest) makes every
decision**, exposed as an MCP server so Claude can drive it conversationally.

There is no scoring function in this repository. No thresholds, no weights, no cutoffs, no
tie-breaks. A company is included because `verdict.choice === "include"`, and it ranks where it
ranks because of `attractiveness.score`. If you go looking for the rule that decides what is
good, you will not find one — that is the design, not an omission.

> Output is **candidates for human review**. This system never places orders and makes no buy or
> sell recommendation. Nothing it produces has been validated against realised returns — see
> [PAPER.md](PAPER.md) for what is and is not known, and [NOTICE](NOTICE).

[**PAPER.md**](PAPER.md) is the write-up: what the design rule is, what running it against 6.2
million real observations taught, and the two experiments measuring whether the model judges the
evidence or the company.

## Looking at it

```sh
npm run ui        # http://127.0.0.1:7373
```

A read-only local view of the last run: all 985 picks, filterable by ticker, sector or
evidence, sortable on every column, with a score histogram that makes the compression at
the top visible at a glance. Clicking a row opens its provenance — every computed metric
with the date it became knowable, then the raw observations newest-first with the XBRL
tag that actually matched.

That last view is the one thing a terminal was genuinely bad at, and the reason this
exists at all. It is also where the point-in-time discipline becomes obvious rather than
theoretical: prices carry one `knownAt`, the fundamentals beside them carry another.

Node's own http server, one inlined page, no framework and no build step. Three
constraints: it binds to loopback because there is no auth and a login would imply it
were safe to expose; every mutation verb is refused before routing, so **a page load
cannot start a screen**; and it calls the same readers the CLI and the MCP server call,
so the page cannot quietly disagree with the terminal.

## See it without credentials

```sh
npm install
npm run demo
```

Three fixture companies, a stubbed model, no keys and no network. The pipeline is
real — eligibility, metrics, peer distributions, the point-in-time slice, caching,
assembly and persistence all execute exactly as they do live. Only the two things that
cost money are replaced, and the stub is deliberately mechanical so nothing in its
output should be mistaken for what jev actually does.

## Setup

```sh
npm install
cp .env.example .env    # OPENROUTER_API_KEY, and EDGAR_USER_AGENT with your own address
npm run check           # confirms the key works and jev is reachable
npm run ingest          # ~5 min: two bulk ZIPs from SEC EDGAR
npm run ingest -- --prices-only   # just refresh closes, archives untouched
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
   net debt/EBITDA, dilution, accrual ratio, working-capital-versus-sales gaps, and — where
   enough closes are on file — momentum, trend and volatility.
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

Ingest is idempotent: re-reading an archive produces byte-identical observations, and a
compaction pass folds them back together rather than letting the table double. Append-only means
a restatement is a new row, not an overwrite — it does not mean the same fact belongs on file
twice.

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

Measured on a live ingest, 2026-09-22:

| | |
| --- | --- |
| Filers with XBRL data | 20,390 |
| Observations ingested | 6,207,389 |
| Database size | 1.9 GB (+ 2.8 GB of cached archives) |
| **Eligible universe** | **3,962** |
| Biggest eligibility failures | too few revenue quarters (12,674), 10-K older than 18 months (8,949), no operating cash flow (6,170), no 10-K on file (5,477), foreign issuer or fund (4,156) |
| Slice + eligibility pass | ~10 s |
| Judgment | ~12,650 input tokens/company |
| Eligible filers SEC lists no ticker for | 310 |
| Included by jev | **985 of 3,962 — 24.9%** |

Dated obligations, from the same ingest: 5,466 filers publish next-year debt maturities,
5,500 the year after, 6,665 a lease schedule, 3,661 a contract liability and 1,739 a
remaining performance obligation. Absent is the common case, and is sent to jev as null
rather than omitted — "no maturity schedule published" is a fact about the filing.

So a full sweep is roughly **$2**. The cache means you pay that once per filing cycle, not
per run: a month in which only a few hundred companies have filed costs a fraction of it,
and a re-run with nothing new costs nothing at all.

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

## The scorecard

```sh
npm run screen -- grade
```

Forward-only, because it has to be. The system cannot be backtested — jev's training
data may already contain what happened after any filing it reads — so grading starts the
day the first run was persisted and accumulates from there. That is why runs are written
in full and never rewritten, and why each one now carries a **roster** of every company
judged, not just the ones picked.

Three things it reports, and each exists to stop a specific way of fooling yourself:

- **The spread, not the level.** A bucket of picks going up proves nothing; the market
  goes up. The number that means something is `include` minus `exclude`, from the same
  universe on the same day.
- **The free baseline beside it.** The same universe ranked by cash conversion alone,
  size-matched to what jev included. If jev's ordering does not beat a ranking that costs
  nothing and needs no model, the judgment layer is decoration — and that is the most
  valuable thing this can tell you.
- **`pending`, not zero.** A horizon the price history does not reach yet reports the date
  it needs and no number. Horizons are 1m, 3m, 6m, 1y, 2y.
- **Momentum, beside the picks.** Once jev is shown price behaviour, beating cash
  conversion stops being enough to claim anything: momentum has a documented premium of
  its own, and a model handed the trend may simply be reproducing it. So the same universe
  is also ranked by twelve-month momentum alone, sized to what jev included, and reported
  as `vsMomentum`. Without that column, a screener that had merely learned to follow the
  trend would read as skill.
- **The market, beside the picks.** A cohort that rose 9% is not a result if the index
  rose 10%. `SPY` rides along on the same day files under a reserved CIK no real filer
  can hold, because its issuing trust is not an operating filer and cannot arrive through
  the normal path. Reports carry `market` and `vsMarket`, and the include-minus-exclude
  spread can be positive while every pick lost to simply owning the index.
- **Delisted names counted, not dropped.** A pick that goes bankrupt disappears from the
  price feed, and silently excluding it removes the worst outcomes from the record — the
  classic way a bad strategy reads as a good one. Bankruptcy and acquisition both end a
  series and point opposite ways, and there is no corporate-action data here to separate
  them, so both bounds are reported: `meanReturn` excludes them, `meanIfDelistedAreTotalLoss`
  counts each as −100%. A wide gap between the two means the result turns on names that
  stopped trading. A company still trading with no close near the horizon is a `gap` —
  missing data, not an outcome — and one that never had a price at all is `unpriced`.

`priceOn` only ever reads backwards from a target date, so grading cannot smuggle in the
look-ahead the store exists to prevent — there is a test for exactly that. Every report
carries caveats it should not be read without: one cohort proves nothing, overlapping
holding periods are autocorrelated, and returns are price-only so high-yield names are
understated.

Expect `pending` on every horizon for months. That is the honest answer, and having the
measurement written before the data arrives is the point — it cannot then be shaped to
fit whatever showed up.

## Keeping it running

`grade` needs two things to accumulate: closes to measure against, and cohorts to
measure. Neither happens on its own.

Two launchd agents in `~/Library/LaunchAgents` run `scripts/refresh.sh`:

| Agent | Runs | Does |
| --- | --- | --- |
| `com.jev.prices` | weekdays 17:30 | `refresh.sh prices` |
| `com.jev.screen` | the 1st, 09:00 | `refresh.sh screen` |

Both log to `data/cron.log`. launchd rather than cron because a Mac asleep at 17:30
makes cron skip the run, while launchd fires it on wake — and since each price run
refetches the last five days, a late run fills the gap. Load or reload one with
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jev.prices.plist`; fire it
by hand with `launchctl kickstart gui/$(id -u)/com.jev.prices`.

Keep the project out of `~/Desktop`, `~/Documents` and `~/Downloads`: macOS privacy
protection denies background jobs access to those folders, and the run fails with
"Operation not permitted".

A price run that asked for days and was refused every time **exits 1** and says so, so a
dead key surfaces as a failed job rather than as a log line nobody reads. Anything else
exits 0, including the ordinary case where every day was already on file. The window is
anchored on the last close the Eastern clock can have produced, not on UTC midnight:
asking for a day that has not traded earns a 403 from the free tier, which is
indistinguishable from a revoked key.

Weekday closes, and one screen a month. Monthly rather than weekly because a cohort is
only worth having if enough filings have landed to make it different from the last one,
and rather than quarterly because twelve cohorts a year is the difference between a
result in two years and a result in six.

Both are idempotent — a second run the same day does nothing — so a missed cron or a
double fire is harmless. The monthly screen costs little: vintage caching means only
companies that have filed since the last run are re-judged, and the rest come from cache
at zero tokens. The screen run grades itself immediately afterwards, so a broken
measurement surfaces next to the run that produced it rather than a quarter later.

One thing cron cannot fix: closes missed are gone. The bulk archive reaches back two
years on the free tier, so a long outage is recoverable, but not indefinitely.

## The freeze

A scorecard built across two different question sets measures a moving target. Cohorts
either side of an edit are not comparable, and averaging them is worse than having
neither. So the question set is frozen, and the freeze is enforced rather than promised:
`questionSetFingerprint()` hashes every question, criterion and rubric level, and a test
pins it. Reword anything and the build fails.

Breaking it is allowed. Breaking it *quietly* is not. Three steps, in order: bump
`QUESTION_SET_VERSION`, add a row below saying what changed and why, then update the
pinned fingerprint.

| Epoch | Fingerprint | Changed | Why |
| --- | --- | --- | --- |
| `2026-09-22.2+30000` | `577acd7794ca0418` | — | First frozen set. `verdict` asks about scarcity, the excerpt is 30,000 characters, and the horizon questions are in. |
| `2026-09-22.3+30000` | `577acd7794ca0418` | Dated obligations added to the state | `horizonBand` was resting on inference alone. Debt and lease maturity schedules and remaining performance obligations are contractual and dated, so the horizon can rest on something the filer committed to. The questions are untouched — the fingerprint is unchanged — but jev sees more, which is the same kind of break. Done deliberately before any forward data existed. **Measurement starts here.** |

| `2026-09-22.4+30000` | `577acd7794ca0418` | Price behaviour added to the state | The screener judged growth potential over a horizon while seeing nothing about price beyond a multiple. Momentum, trend and volatility are pure functions of the closes already on file, so they carry a real `knownAt` and full provenance — unlike an indicator fetched from a charting service, which is computed now on a series since adjusted and cannot be reconstructed for a past date. Questions untouched, fingerprint unchanged, but jev sees more. Taken now, five weeks before the first horizon resolves, which is when a break is cheapest. |

**The first measured cohort is run `b2a74f45`**, judged 2026-09-28 at this epoch: 3,939
companies, 802 included, a roster of all 3,939 persisted with momentum on 3,047 of them.
That is the run `grade` is read against, and the clock starts from it.

It replaced `a0c105d0` from six days earlier, which was superseded by adding price
behaviour. Superseding a two-dollar run before any horizon resolves is the cheap version
of that mistake; discovering the need for it afterwards would not have been. Earlier runs
stay in the table and stay readable, but they answered questions the screener no longer
asks, and pooling them with what follows would be the exact drift the freeze exists to
prevent.

Everything before this epoch was development, not measurement. Those runs are still in
the `runs` table and still readable, but they answered different questions and should
not be pooled with what comes after.

## Does it read the evidence, or the name?

`npm run screen -- probe` found jev identifies about **85%** of these companies from their
filing text, through redaction — against 25% chance on a four-way slate of same-sector,
nearest-revenue decoys. From metrics alone it identified **none**, abstaining on all 60.
Prose is the fingerprint; numbers are not.

Recognition is not reliance, though, and the gap between them is the whole question.
`npm run screen -- twins` judges each included company three times: the real filing, the
identical filing again, and the same prose with the numbers rewritten into those of a
deteriorating, more expensive business.

On 40 companies:

| | |
| --- | --- |
| Noise floor (two identical asks) | **0.04** attractiveness, **0** verdict flips |
| Perturbed | **−2.38** attractiveness, **40 of 40** verdicts flipped |
| Flipped to `exclude` | 38 |
| Turned `accounting: questionable` | 25 |
| Durability change | −1.58 |

A 64:1 signal-to-noise ratio, and every verdict moved. **jev reads the evidence.** The
25 companies whose accounting turned questionable are the correct response rather than a
confound: the perturbation makes an upbeat MD&A stop matching the accounts, and noticing
that is the job.

Two things this does *not* establish. It speaks to the **forward screen** only — in a
historical run the company's name carries the outcome as well as the evidence, so
recognition stops being incidental. And a deterministic noise floor means jev is
reproducible on identical input, not that it is right.

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
src/screen.ts        the jev question set, the typed call, result assembly
src/cache.ts         judgment cache keyed on input vintage and price presence
src/pool.ts          bounded-concurrency runner and rate limiter
src/cli.ts           the pipeline, plus ingest / screen / explain / coverage / grade
src/grade.ts         the forward-only scorecard
src/probe.ts         can jev identify these companies?
src/twins.ts         does it judge the evidence or the name?
src/demo.ts          fixtures and a stubbed model, for running without keys
src/serve.ts         the read-only local view
src/ui.ts            that view's page, inlined
src/ui-server.ts     its entry point, separate to break an import cycle
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
