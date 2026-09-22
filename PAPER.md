# A stock screener where the code computes and the model decides

**What happens when you forbid a codebase from making judgments, hand every decision
to a language model, and then try to find out whether it works.**

---

## The premise

Most quantitative screeners are a scoring function wearing a trench coat. Somewhere in
the source there is a line like `score = 0.25 * growth + 0.20 * margin + …`, and those
weights are the screener. They were chosen by a person, usually by intuition, and they
are rarely revisited because nobody can say what the right numbers are.

This project takes the opposite position. **TypeScript computes facts. The model makes
every decision.** There is no scoring function in the repository — no thresholds, no
weights, no cutoffs, no tie-breaks. A company is included because the model answered
`include`, and it ranks where it ranks because the model returned that score.

The model is [jev](https://openrouter.ai/~typesafe/jev-latest), which answers *typed*
questions and returns a probability distribution over each answer rather than free text.
That matters: a screener needs discrete decisions and ordered rankings, and jev provides
both natively with calibrated uncertainty attached.

The rule is enforced rather than promised. Two tests scan the judgment path for
comparisons against fractional literals and for probability values reaching control
flow, and a third pins the exact list of permitted constants — every one of which must
be operational (a throttle, a timeout, a page size) rather than a claim about what makes
a company good. Injecting `verdict.confidence > 0.65` anywhere in the pipeline fails the
build.

Two derived rules make this workable:

- **Discrete decisions are `choice` questions read via argmax.** Never a probability
  compared to a threshold.
- **Orderings are `score` questions read via expected value.** Never a weighted formula.

## Why this is interesting

Not because it makes money — nobody knows whether it does, and a central finding of the
project is that **this cannot be known from historical data**. It is interesting for
three other reasons.

**It makes a falsifiable claim about LLM judgment.** If you hand every decision to a
model, you can measure whether the model is deciding *from the evidence* or from what it
already knows. Most systems that put an LLM in a decision loop never ask. This one asks,
with controls, and gets a number.

**It takes point-in-time correctness seriously and then discovers that isn't enough.**
The data layer is rigorously honest — every observation carries when it became knowable,
and no read is possible without an as-of date. That machinery is necessary and, against
a language model, insufficient, for reasons that turn out to be unfixable.

**Every serious bug was found by running it, not by testing it.** The test suite grew to
193 tests and never caught the defects that mattered. They surfaced against 6.2 million
real observations, and that pattern is the most transferable thing here.

---

## Architecture

```
SEC EDGAR bulk archives ──┐
                          ├──> DuckDB (bitemporal) ──> metrics ──> peer context ──┐
Polygon grouped daily  ───┘         6.21M rows        (arithmetic)                │
                                                                                   ▼
                                                                          jev (9 questions)
                                                                                   │
                                        picks ◄── assemble ◄── verdict + attractiveness
                                          │
                                          ├──> persisted run (immutable, with full roster)
                                          ├──> MCP server (3 read-only tools)
                                          ├──> local web view (read-only)
                                          └──> grade (forward-only scorecard)
```

**Ingest.** Two bulk ZIPs give the entire universe in two requests — 20,390 filers,
6.21 million observations. Per-company API calls are reserved for the few hundred
filings actually read.

**Eligibility.** Narrows to 3,962 evaluable companies using predicates that reference
only the *presence, recency and completeness* of data — never its value. "Has twelve
quarters of revenue" is a question about our inputs. "Has revenue growth above 10%"
would be a statement about the business, and would quietly make that file the screener.

**Metrics.** Pure arithmetic: growth, margins and their trends, cash conversion, ROIC,
leverage, dilution, accrual ratio, working-capital-versus-sales gaps, and valuation
multiples where a price exists.

**Dated obligations.** Everything above describes a period that has already closed. Debt
and lease maturity schedules and remaining performance obligations are contractual and
dated — they say when money must be found and how much revenue is already booked — and
they are what lets a horizon rest on something the filer committed to rather than on
inference. Coverage on the live universe: 5,466 filers publish next-year debt maturities,
6,665 a lease schedule, 1,739 an RPO. Absent is the common case and is sent as null
rather than omitted, because "no maturity schedule published" is itself a fact.

**Peer context.** Distributions across the whole eligible universe and within the
company's sector, computed once and passed identically to every call — because
`attractiveness` scores are only comparable if every call saw the same yardstick.

**Judgment.** One call per company with nine questions: verdict, attractiveness,
durability, accounting quality, dominant risk, management candour and evidence
sufficiency, plus two asking when the view would settle and by what mechanism.

**Persistence.** Every run is written in full and never rewritten, carrying a roster of
every company judged — not just the picks. A scorecard needs what was passed over.

---

## The epistemic machinery

### Point-in-time or nothing

The unit of data carries two dates:

```ts
{ value, metric, entity, validAt, knownAt, source, reliability, tag }
```

`validAt` is the period the fact describes. `knownAt` is when it became knowable — for
filings, EDGAR's `filed` date; for prices, the close date. A 10-K for FY2025 filed in
February 2026 has `validAt: 2025-12-31, knownAt: 2026-02-14`. Storing only one of those
is how every fraudulent backtest gets built.

There is exactly one read path, and it requires an as-of date. There is deliberately no
"just give me the latest" accessor, because that is the call site where look-ahead would
enter.

### Identity is the CIK, never the ticker

This took a live run to learn. Tickers are display labels: they get reassigned, a filer
can carry dozens at once, and SEC's own ticker file is wrong in ways that matter.

- **It omits companies.** Exxon Mobil Corp, CIK 34088, is not in `company_tickers.json`
  at all. Deriving the universe from that file dropped one of the largest filers in the
  country.
- **It points familiar symbols at the wrong filer.** `XOM` maps to CIK 2115436,
  "ExxonMobil Holdings Corp", which has two quarters of revenue and no 10-K.
- **One filer carries many symbols.** 1,448 of them do. Bank of Montreal lists `BMO`
  plus dozens of ETNs it issues; ProShares Trust II lists dozens of leveraged ETFs.

That last one produced the most alarming bug in the project. Every listed symbol was
mapped to the issuer's CIK, so **one filer carried 45 closes a day spanning $2.62 to
$172.60**, and which one a slice picked was arbitrary. Its price — and therefore its P/E
— was noise. The bug systematically made multi-listed financials look cheap, because a
preferred share trading near $25 against common trading far higher produces a
spectacular-looking earnings multiple.

Universe membership now comes from the facts archive's own directory, read from
filenames without decompressing anything, and tickers are labels attached afterwards.
A contested symbol is reported as ambiguous rather than silently resolved — quietly
choosing between two filers that claim a symbol is how a screener ends up confidently
describing the wrong company.

### XBRL tags are chosen by coverage, not by chain position

Filers tag the same concept differently, so each concept has an ordered fallback chain.
The original rule — first tag with any data wins — looked reasonable and was badly
wrong.

Lockheed Martin adopted ASC 606, tagged seven periods under
`RevenueFromContractWithCustomerExcludingAssessedTax` around the transition, then
reported under `Revenues` ever after. The old rule picked the seven-entry stub, so
**Lockheed appeared to have stopped reporting revenue in 2018**, failed the
twelve-quarter eligibility test, and vanished from the universe entirely. Its capex was
broken the same way, stopping in 2013.

Every tag is now evaluated and the most current series wins — recency bucketed by
reporting quarter, then period count, with chain order only as a tie-break. Lockheed's
revenue went from 2 periods ending 2018-06-24 to 38 ending 2026-06-28. Roughly 505
filers were affected.

### The cache key has to describe the evidence

Judgments are cached on `(entity, questionSetVersion, inputVintage, hasPrice)`. The
vintage deliberately excludes price *levels* — a close is new every afternoon, and
counting it would expire every judgment nightly.

But *whether a price existed* is stable in a way the level is not, and a verdict formed
with no valuation is an answer to different evidence than one formed with multiples.
Without that flag in the key, the first would be served in place of the second forever.

The same reasoning folds the filing-excerpt size into the version string. It is not part
of the question, but it changes what the model sees, and the cache cannot see it.

---

## What running it taught

The test suite reached 193 tests. It never caught a single one of the defects below.
They all appeared against real data.

| Bug | How it presented | Why tests missed it |
|---|---|---|
| Stale XBRL tag selection | Lockheed's revenue stopped in 2018 | Needed a filer with a transitional tag stub |
| Ticker as identity | Exxon absent; XOM a shell; 45 closes for one filer | Needed SEC's real, wrong ticker file |
| Eight-hour price stall | 3,652 sequential requests to an unreachable host | Needed the host to become unreachable |
| Heap exhaustion | Two multi-million-row slices held at once | Needed the live universe |
| Eight-fold row duplication | Every run re-appended the same closes | Needed several runs |
| Survivorship in grading | Delisted picks silently dropped | Needed a delisting, i.e. months |
| A chat tool spending $2 | MCP `screen_run` ran the full pipeline | Needed the tool called for real |
| A demo that screened nothing | Hard-coded fixture dates fell in the future | Needed the calendar to move |
| A deadlocked module graph | UI started, printed nothing, exited 13 | Needed the entry point, not the unit |

That last one is worth expanding. The MCP tool's own description said it "does not
trigger a sweep." The code called the full pipeline. The first live probe timed out at
sixty seconds, **kept running server-side, judged 3,962 companies, and spent $2.17
returning nothing.** A chat message could start a fifteen-minute batch job, and the
documentation asserted the opposite.

The survivorship bug deserves the same attention because it had not yet done damage. A
pick that goes bankrupt disappears from the price feed, so the grading code found no
exit price and skipped it. The worst outcomes would have been removed from the record
and everything remaining would have read better for it — the classic way a bad strategy
comes out looking good. Nothing would have flagged it. The numbers would simply have
been wrong, for months, in the flattering direction.

**The transferable lesson:** tests verify what you thought of. Real data is what tells
you what you didn't.

---

## The contamination problem

Here is where the project stops being an engineering exercise.

The obvious way to evaluate a screener is to run it on the past and compare its
predictions against what happened. The data layer supports this exactly: set the as-of
date to 2024 and the slice contains only what was filed by then.

**It does not work, and it cannot be made to work.**

jev was trained on text through some cutoff. Ask it about a 2022 filing and it may
already know the company collapsed in 2023. It does not need to recall this
consciously — its sense of what durable growth looks like, what candid management sounds
like, which accruals read as questionable, was shaped by having seen how thousands of
such situations turned out.

This is categorically worse than ordinary look-ahead bias. Ordinary look-ahead is a
leaking field: find it, remove it, re-run. **This leak is in the weights.** There is no
field to remove and no way to size the error. You get an excellent-looking backtest and
no basis for believing any of it.

So the project ran two experiments to find out how bad it is.

### Experiment 1: can it recognise the companies?

Recognition is how hindsight gets in. A model that knows the name knows how the story
ended.

jev answers in types and never free text, so it cannot be asked to name a company and
checked against a string. Instead it receives four candidates — the real filer plus three
decoys from the same sector at the nearest revenue — and picks one. Chance is 25%.
Sector, ticker and label are withheld, since any of them would collapse four candidates
to one. The truth's slot derives from the CIK rather than a random draw, so a run is
reproducible and cannot be re-rolled until it says something convenient.

Two conditions, sampled across the entire revenue range:

| Condition | Correct | Abstained | Accuracy |
|---|---|---|---|
| Metrics only | 0 / 60 | **60** | **0%** |
| Metrics + redacted filing text | 51 / 60 | 8 | **85%** |

Financial ratios identify nobody — jev abstained on all sixty rather than guessing.
Prose identifies almost everybody, through redaction, and when it committed to a name it
was right 51 times out of 52.

Recognition was also **roughly flat across the revenue range** — about 80% for the
smallest third, 95% for the largest. It is not a mega-cap effect, which kills the obvious
fallback: restricting a historical run to obscure companies buys nothing.

Redaction is leaky by construction, and the test suite documents why. "Chipotlane"
shares a stem with "Chipotle" but not a prefix, so a word-prefix match cannot reach it —
and matching a shorter stem would swallow "applied" and "appliance" along with it,
removing the business content the test needs.

### Experiment 2: does it *use* what it recognises?

Recognition is not reliance. A model can know which company it is looking at and still
answer from the numbers in front of it. That gap is the untested link between "it
recognises them" and "its judgments are contaminated."

Each included company was judged three times: the real filing, the **identical filing
again**, and the same prose with the numbers rewritten into those of a deteriorating,
more expensive business. The repeat condition is load-bearing — jev returns
distributions, so without measuring how much two identical asks disagree there is no way
to tell a real movement from variance.

On 40 companies, 457 metrics rewritten:

| | Attractiveness | Verdict flips |
|---|---|---|
| Noise floor (identical asks) | **0.04** | **0** |
| Perturbed | **−2.38** | **40 of 40** |

Thirty-eight flipped to `exclude`. Durability fell 1.58. Twenty-five turned
`accounting: questionable` — which is the correct response rather than a confound, since
the perturbation stops the MD&A matching the accounts, and noticing that mismatch is the
job.

**A 64:1 signal-to-noise ratio, and not one verdict held.** jev reads the evidence.

### What the two together establish

For the **forward** screen: recognition is incidental to what jev concludes. It knows who
it is looking at, and it answers from the numbers anyway.

For a **historical** screen: nothing changes. There the name carries the *outcome*, not
just context, so recognition stops being incidental. The backtest question is closed.

The only clean remaining path is a model whose training cutoff predates the test window.
Only one jev build is exposed, so that is a question for the vendor rather than something
to engineer around.

---

## What the screen actually produces

From 3,962 eligible companies, jev includes about 25%, ranked with real separation
(0.23 to 3.97 on a five-level rubric). The top of the list reads as a quality screen —
high-ROIC compounders in software, semiconductors, financial data and medical
devices — and it surfaces genuine mid-caps rather than only mega-caps.

Getting there required two corrections that the system diagnosed itself.

**The first question set included 97% of the universe.** `verdict` asked whether a
company was "worth a person's time now", and almost any solvent filer with twelve
quarters of history is worth *somebody's* time. Adding valuation data did not move the
rate at all, which ruled out thin evidence and left the wording. Rephrased around
scarcity — does this company earn one of few places, rather than merely deserve one —
the rate fell to 25%.

**Every single pick reported `sufficiency: thin`.** All of them, with no prices. Adding
multiples moved it to 88% thin. Widening the filing excerpt from 12,000 to 30,000
characters moved it to 18%. The model had been telling us, unanimously and correctly,
that its evidence was inadequate — and the fix was more filing text, not more numbers.

Both of those are negative results the system reported about itself, and both were more
useful than any pick.

---

## What is not known

**Whether it works.** No pick has been held for a day. The scorecard reports `pending` on
every horizon and will for months.

**Whether jev is right.** The twins experiment shows it responds to evidence and is
reproducible on identical input. Neither of those is correctness.

**Whether the factor set has any edge.** Cash conversion, accrual ratios, margin trends
and share-count discipline are documented quality factors — real, modest, and public for
decades. The novel component is screening 4,000 filings on whether management discusses
problems directly, and that is unmeasured.

The scorecard is built to answer these honestly when it can. It reports the spread
between what was included and what was passed over — a bucket of picks going up says
nothing on its own, because the market goes up. It grades a free deterministic baseline
alongside, because if the model cannot beat ranking by cash conversion, the judgment
layer is decoration. It compares against the index, because a cohort that rose 9% is not
a result if the market rose 10%. It counts delisted names rather than dropping them, and
reports both bounds since bankruptcy and acquisition both end a price series in opposite
directions. And it says `pending` rather than zero.

Expect that for four to eight quarters. The measurement was written before the data
exists, deliberately: written afterwards, it can be shaped to fit whatever showed up.

---

## Limitations

**No consensus estimates.** There is no free feed worth using, so nothing here knows what
the market expects. It can say a business looks durable and well-run; it cannot say that
is not already in the price.

**Prices are end-of-day and symbol-keyed.** The 310 eligible filers SEC lists no ticker
for — Exxon Mobil Corp among them — are judged without multiples.

**Returns are price-only.** No dividends, which understates high-yield names.

**One cohort is not significance.** Overlapping holding periods across runs are
autocorrelated, and repeated cohorts are fewer independent observations than they appear.

**Nothing has been measured at the frozen question set yet.** Every persisted run
predates the epoch the scorecard should be read against — the dated obligations went in
after them. The first measured cohort is the next scheduled screen.

**The model is a single point of failure.** One vendor, one build, no fallback, and its
judgments cannot be audited beyond the distributions it returns.

---

## Reproducing

```sh
npm install
npm run demo            # no keys, no network — fixtures and a stubbed model
```

That last one is the honest entry point. Reproducing the real thing needs three
credentials, one of them a model with a single exposed build, which is a barrier for
anyone deciding whether to care. `npm run demo` runs the actual pipeline — eligibility,
metrics, peer distributions, the point-in-time slice, caching, assembly and
persistence — against three fixture companies, and replaces only the two things that
cost money.

For the real universe:

```sh
cp .env.example .env    # OPENROUTER_API_KEY, POLYGON_API_KEY, EDGAR_USER_AGENT
npm run check           # is the key live and is jev reachable
npm run ingest          # ~15 min, 2.8 GB of bulk archives
npm run screen          # the full pipeline
npm run screen -- grade # the scorecard
npm run ui              # a read-only local view at 127.0.0.1:7373
npm run screen -- probe # can jev identify these companies?
npm run screen -- twins # does it judge the evidence or the name?
```

Both experiments in this paper are commands, not one-off scripts. Anyone can re-run them
and get their own numbers.

A full sweep of 3,962 companies costs roughly $2 and fifteen minutes. With vintage
caching, a monthly re-run costs a fraction of that, because only companies that have
filed since the last run are re-judged.

Total spend building and running everything described here — every ingest, every full
sweep, both experiments and every false start: **$7.72**.

---

## Closing

The interesting result is not the pick list. It is that a system built to make its own
reasoning auditable ended up auditing itself into a corner: it can tell you exactly where
every number came from and when it was knowable, it can demonstrate that its judgment
layer responds to evidence rather than reputation — and it still cannot tell you whether
it works, because the only honest test runs forward and takes years.

That is not a flaw in the build. It is what intellectual honesty costs when the judge is
a model that has already read the future you wanted to test against.
