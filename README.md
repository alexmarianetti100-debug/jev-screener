# jevproject

A TypeScript starter for TypeSafe AI's **jev** model, called through
[OpenRouter](https://openrouter.ai/~typesafe/jev-latest) with the official
[`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript).

jev answers *typed* questions about some state and returns a probability distribution for each
answer — not free text you have to parse. This project uses it to triage support tickets, and
exercises all three question types the SDK offers.

## Setup

```sh
npm install
cp .env.example .env   # then paste your OPENROUTER_API_KEY
```

Node 22 or newer. TypeScript runs directly through Node's built-in type stripping — no bundler.

### Providers

`src/client.ts` picks the transport from the environment:

- **`OPENROUTER_API_KEY` set** — requests go to `https://openrouter.ai/api/v1/systemone`.
  Model ids stay bare (`jev-latest`); OpenRouter maps them into its `typesafe/` namespace and
  reports back the concrete build it used, e.g. `typesafe/jev-1.13-20260917`.
- **otherwise** — the SDK's own defaults apply: `TYPESAFE_API_KEY` against `api.typesafe.ai`.

Switching providers is an env change only; no code in `src/triage.ts` cares which one is used.

One caveat when going through OpenRouter: `client.models.list()` rejects OpenRouter's Models API
response format. Browse [the model list](https://openrouter.ai/typesafe) on the web instead.
Nothing in this project calls it.

## Run

```sh
npm run dev                          # triages a built-in sample ticket
npm run dev -- "my login is broken"  # triage your own text
echo "refund me" | npm run dev       # or pipe it in
```

```sh
npm run check   # preflight: is the key live and can this account reach jev?
npm test        # unit tests, network stubbed — no API key needed
npm run typecheck
npm run build && npm start
```

## Preflight

`npm run check` is the "is this actually working?" command. It exits non-zero on the first hard
failure, so it also works as a CI or pre-deploy gate.

```
Transport
  ✓ OpenRouter → https://openrouter.ai/api/v1/systemone
Credentials
  ✓ key accepted — sk-or-v1-abc...xyz
  ✓ credit $250.00 of $250.00 remaining (used $0.000070)
  ✓ key valid until 2027-09-21 (365 days)
Model access
  ✓ round trip in 208 ms
  ✓ requested "jev-latest" → served by typesafe/jev-1.13-20260917
  ✓ usage 288 in / 20 out tokens
  ✓ typed answer well-formed — noul = 0.9900
  ✓ sanity check — "is this about billing?" answered yes at 99.0%
```

It separates three things that fail for different reasons: whether a key is configured at all,
whether OpenRouter accepts it (`GET /api/v1/key`, which also reports remaining credit and
expiry), and whether this account can actually reach jev. That last one needs a real round trip —
jev is a System One model and does **not** appear in OpenRouter's `/api/v1/models` listing, so a
model-list lookup would wrongly report it as unavailable. The check ends on an unambiguous
question, so a well-formed but nonsense answer is caught too.

## How it works

`src/triage.ts` declares the question set once:

| Question | Type | Returns |
| --- | --- | --- |
| `category` | `choice` | the picked label, its `confidence`, and `probabilities` per label |
| `urgency` | `score` | an expected `score` over an ordered rubric (may land between levels) |
| `frustrated` | `noul` | `noul`: probability of yes, from 0 to 1 |
| `needsHuman` | `noul` | same |

Answer types are **inferred from the criteria you write**. `answers.category.choice` is
`"billing" | "technical" | "account" | "other"`, not `string`, so a renamed label is a compile
error rather than a silent runtime miss. Try changing a label in `triageQuestions` and running
`npm run typecheck`.

`route()` in the same file turns those distributions into one decision. Thresholds live in your
code — the model reports how sure it is, you decide what to do about it. That's the split worth
keeping as this grows.

## Layout

```
src/client.ts       transport selection (OpenRouter vs. TypeSafe direct)
src/triage.ts       the question set, the typed call, and the routing rules
src/index.ts        CLI entry point and error handling
src/check.ts        preflight: key, credit, and live model access
src/triage.test.ts  triage + routing tests, against a stubbed fetch
src/client.test.ts  transport-selection tests
```

The SDK takes a `fetch` implementation, which is how the tests run offline — see `stubClient`
in `src/triage.test.ts`.

## Configuration

Set in `.env` (or the real environment); explicit options to `createClient()` win over both.

| Variable | Default |
| --- | --- |
| `OPENROUTER_API_KEY` | unset; setting it routes jev through OpenRouter |
| `TYPESAFE_API_KEY` | required *only* when `OPENROUTER_API_KEY` is unset |
| `TYPESAFE_BASE_URL` | `https://openrouter.ai/api`, else `https://api.typesafe.ai` |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` |
| `TYPESAFE_LOG_LEVEL` | `warn` (`debug` logs request bodies — unredacted) |

`.env` is gitignored and mode 600. Keep it that way.
