#!/usr/bin/env bash
#
# Keeps the measurement accumulating. Intended for cron.
#
#   prices  — every weekday. Closes are what `grade` measures against, and a day
#             missed is a day that can never be recovered: the archive is bulk, but
#             the free tier only reaches back two years.
#   screen  — monthly. `grade` needs cohorts; one run is not a track record, and a
#             single cohort cannot tell skill from a good month. Vintage caching
#             means most months re-judge only what has filed since the last run.
#
# Both are idempotent. Running twice does nothing the second time.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-prices}"
stamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

case "$mode" in
  prices)
    echo "[$(stamp)] prices"
    npm run --silent ingest -- --prices-only
    ;;
  screen)
    echo "[$(stamp)] screen"
    # A screen is the cohort. Grade right after so a broken measurement surfaces
    # next to the run that produced it rather than a quarter later.
    npm run --silent screen -- --limit=40
    npm run --silent screen -- grade
    ;;
  *)
    echo "usage: refresh.sh [prices|screen]" >&2
    exit 2
    ;;
esac
echo "[$(stamp)] done"
