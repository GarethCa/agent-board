#!/bin/sh
# The merge gate, run locally: what CI's `check` job runs, plus the Markdown lint and knip (unused files, exports and
# dependencies). Prints one result line per step and the commit it ran on, ready to paste into the PR. Exits non-zero if
# any step failed; the other steps still run.
#
# The steps run in stages, the independent ones within a stage at the same time: lint, typecheck, Markdown lint, knip and the build;
# then the unit tests; then, once the build has passed, the native visual spec and the end-to-end tests.
# The heavy runs never overlap: the unit tests have 5-second timeouts and the e2e waits on app state, and both fail when
# starved. So the wall time is the build plus the slowest of the rest, not the sum. For the per-PR subset, see `pnpm check:pr`.
#
# The gate is native only: the visual spec runs on this machine's own baselines.
# On Linux with no display, the end-to-end tests run on a virtual display (scripts/e2e-headless.sh). Logs go to $CHECK_LOG_DIR (default: a temp dir).
set -u
cd "$(dirname "$0")/.."

log_dir=${CHECK_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/agent-board-check.XXXXXX")}
mkdir -p "$log_dir"
commit=$(git rev-parse --short HEAD)
dirty=$(git status --porcelain | head -n 1)

e2e="pnpm test:e2e"
# The visual run has its own output dir, a sibling of the e2e one (not inside it): Playwright empties its output dir at the
# start of a run, which would wipe the other run's.
visual="pnpm --filter @agent-board/desktop test:visual --output test-results-visual"
if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then
  e2e="sh scripts/e2e-headless.sh"
  visual="sh scripts/e2e-headless.sh $visual"
fi

# Runs a step in the background; its outcome and time land in $log_dir/<name>.result for the table below to read.
start() {
  name=$1
  shift
  (
    started=$(date +%s)
    if "$@" >"$log_dir/$name.log" 2>&1; then outcome=pass; else outcome=FAIL; fi
    echo "$outcome $(($(date +%s) - started))" >"$log_dir/$name.result"
    echo "$name: $outcome (log: $log_dir/$name.log)"
  ) &
}

rm -f "$log_dir"/*.result
# Stage 1: the cheap steps and the build, together.
start build pnpm build
start lint pnpm lint
start typecheck pnpm typecheck
start markdownlint pnpm dlx markdownlint-cli2@0.23.2
start knip pnpm knip
wait
# Stage 2: the unit tests alone. They have 5-second timeouts and run slower than that beside anything heavy.
start test pnpm test
wait
if [ "$(cut -d' ' -f1 "$log_dir/build.result")" = pass ]; then
  # Stage 3: the Electron runs. The native visual run goes first, alone (about ten seconds): its screenshots differ when
  # other apps are launching beside it. Then the e2e.
  start visual sh -c "$visual"
  wait
  start e2e sh -c "$e2e"
  wait
else
  # The e2e drives the built app; with the build broken it would test a stale one.
  echo "e2e, visual: not run, the build failed"
fi

failed=0
results=""
row() {
  name=$1
  if [ -f "$log_dir/$name.result" ]; then
    read -r outcome seconds <"$log_dir/$name.result"
    [ "$outcome" = pass ] || failed=1
    results="$results| \`$name\` | $outcome | ${seconds}s |
"
  else
    results="$results| \`$name\` | not run: the build failed | |
"
    failed=1
  fi
}
for name in lint typecheck test build e2e visual markdownlint knip; do row "$name"; done

echo
echo "Local checks on \`$commit\`${dirty:+ (with uncommitted changes)}, $(uname -s):"
echo
echo "| Step | Result | Time |"
echo "| --- | --- | --- |"
printf '%s' "$results"
exit $failed
