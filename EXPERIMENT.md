# The experiment, registered before the data exists

This file is written while every horizon still reports `pending`. That is the point. The
decision rules below are fixed now, in public, with a commit date attached, so they cannot
be adjusted later to fit whatever showed up.

If you are reading this after results have landed, check the git history of this file. If
it changed after the first cohort resolved, treat the conclusions accordingly — and the
same applies to me.

---

## The question

**Does an LLM judgment layer select better than free, deterministic rules applied to the
same data?**

Not "does the screener make money". A rising market makes almost anything look like it
works, and this system is long-only, so beating zero is not evidence of anything.

## What is being compared

Every run persists a roster of **all** companies judged, not only the picks. Four numbers
come out of each horizon:

| | What it is |
| --- | --- |
| **`spread`** | `include` mean return − `exclude` mean return, same universe, same day |
| **`baselineSpread`** | The same, for the top *N* by cash conversion, *N* = however many jev included |
| **`vsMomentum`** | `include` mean − the top *N* by twelve-month momentum |
| **`vsMarket`** | `include` mean − SPY over the same window |

## Pre-registered decision rules

**Primary horizon: 6 months.** Chosen because the median `horizonBand` across the first
cohorts falls at 2.2 — "two to four quarters" — so that is the period the model itself says
its views resolve over. 1m, 3m, 1y and 2y are reported but secondary.

**The judgment layer works if, at 6 months, across at least four cohorts:**

1. `spread` is positive in a majority of cohorts, **and**
2. `vsMomentum` is positive in a majority of cohorts, **and**
3. the result survives the pessimistic delisting bound — `meanIfDelistedAreTotalLoss`,
   which counts every pick that stopped trading as a total loss.

**The judgment layer does not work if:**

- `vsMomentum` is negative in a majority of cohorts. The model is shown price behaviour;
  if it cannot beat ranking on that alone, it has learned to follow the trend. This is the
  most likely failure and the one worth naming loudest.
- `spread` is indistinguishable from zero once the delisting bound is applied.
- `baselineSpread` beats `spread`. Cash conversion is arithmetic over a filing. If it wins,
  the model is an expensive way to be worse than a ratio.

**Either outcome gets published here.** A negative result is the more useful contribution
and the rarer one, and it is the reason to register this in advance rather than after.

## What would invalidate the whole thing

- **Question-set drift.** Cohorts either side of an edit answer different questions.
  `questionSetFingerprint()` hashes every question and criterion and a test pins it; every
  break is recorded in the epoch table in [README.md](README.md). Cohorts are only pooled
  within an epoch.
- **Survivorship.** A pick that goes bankrupt leaves the price feed. Delisted names are
  counted, not dropped, and both bounds are reported.
- **Too few independent periods.** Overlapping holding windows are autocorrelated; four
  monthly cohorts are not four independent observations. Treated accordingly, which is why
  the bar is "a majority of at least four" rather than a *p*-value this design cannot
  honestly produce.

## What this cannot answer, ever

**Whether it would have worked historically.** The model recognises ~85% of these companies
from their filing prose, so anything it says about their past is partly recall. Measured,
not assumed — `npm run screen -- probe`. There is no backtest here and there will not be
one.

## Standing commitments

- The question set stays frozen within an epoch. Changes are recorded before the next run,
  never after seeing a result.
- Runs are immutable and never rewritten.
- The log below is append-only.

---

## Log

Newest last. Cohorts that were superseded are kept, because deleting them would make the
record look tidier than it was.

### 2026-09-21 — development, not measurement
Several runs at `2026-09-21.2` and `2026-09-22.1`. These were the sessions that found the
bugs: XBRL tags chosen by chain position rather than coverage, ticker used as identity,
filers priced by ETNs they issue, delisted picks silently dropped from grading. Not
comparable to anything and not pooled.

### 2026-09-22 — `a0c105d0`, superseded
3,962 judged, 940 included, at `2026-09-22.3`. The first run intended as a baseline.
Superseded six days later when price behaviour went into the state — a change that made the
epoch incomparable. Superseding a $2 run before any horizon resolved was the cheap version
of that mistake.

### 2026-09-28 — `b2a74f45`, **the first measured cohort**
3,939 judged, **802 included (20.4%)**, at `2026-09-22.4+30000`. Roster of all 3,939
persisted, momentum present on 3,047. Adding price behaviour made the screen *more*
selective — inclusion fell from 23.7%, and the share of picks with `sufficient` evidence
rose from 50% to 57%.

Horizons pending. The 6-month primary resolves around **2026-03-28**; the 1-month secondary
around **2026-10-28**.
