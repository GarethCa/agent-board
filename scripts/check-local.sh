#!/bin/sh
# The merge gate, run locally: what CI's `check` job runs, plus the Markdown lint and knip (unused files, exports and
# dependencies). Prints one result line per step and the commit it ran on, ready to paste into the PR. Exits non-zero if
# any step failed.
#
# The steps run in stages, the independent ones within a stage at the same time. First the pre-flight (scripts/preflight,
# about a second): the branch merges into origin/main with no conflict, no file holds a conflict marker, and the merged
# tree's migrations are numbered 1..n. Then lint, typecheck, Markdown lint, knip and the build; then the unit tests; then,
# once the build has passed, the native visual spec and the end-to-end tests. A failed pre-flight stops the gate there,
# and a failed lint, typecheck, Markdown lint or knip stops it before the unit tests: a run that cannot pass ends in a
# minute or two, not after the 35-minute heavy runs. The build's own failure stops only the visual and e2e steps.
# The heavy runs never overlap: the unit tests have 5-second timeouts and the e2e waits on app state, and both fail when
# starved. So the wall time is the build plus the slowest of the rest, not the sum. For the per-PR subset, see `pnpm check:pr`.
#
# Each step runs under its stage's wall-clock limit (scripts/deadline): past it, the step and everything it started are
# killed and its row says so. If the gate itself is killed, its steps are too.
# The visual and e2e steps hold the machine-wide e2e lock (scripts/e2e-lock), so gates in several worktrees take turns.
# The gate is native only: the visual spec runs on this machine's own baselines.
# On Linux with no display, the end-to-end tests run on a virtual display (scripts/e2e-headless.sh). Logs go to $CHECK_LOG_DIR (default: a temp dir).
#
# The visual and e2e tests get two retries: a test that passes on a retry passes the gate, and the table names it as
# flaky so it gets fixed. One that fails every try fails the gate. The e2e step's frame-time benchmark (the perf project)
# gets them too: a slow frame on a busy machine is the flakiest kind of failure. No run writes a screenshot baseline, as
# a retry would then pass against the one the first try wrote.
# A run in which every step passed on a clean tree writes a green stamp for its commit (scripts/gate-stamp), so a later
# step can trust that commit without a second run. $CHECK_STAMP_DIR moves the stamps.
#
# `--quick` runs all but the visual and e2e steps, which a change to text alone cannot break, and writes no stamp.
set -u
cd "$(dirname "$0")/.."

log_dir=${CHECK_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/agent-board-check.XXXXXX")}
mkdir -p "$log_dir"
commit=$(git rev-parse --short HEAD)
sha=$(git rev-parse HEAD)
dirty=$(git status --porcelain | head -n 1)
quick=
case "${1:-}" in
  --quick) quick=1 ;;
  "") ;;
  *) echo "usage: check-local.sh [--quick]" >&2; exit 2 ;;
esac
steps="preflight lint typecheck test build e2e visual markdownlint knip"
[ -n "$quick" ] && steps="preflight lint typecheck test build markdownlint knip"

# Retries, and a JSON report beside the log to read the flaky tests from.
playwright_args="--retries 2 --reporter list,json --update-snapshots none"
e2e="pnpm test:e2e $playwright_args"
# The visual run has its own output dir, a sibling of the e2e one (not inside it): Playwright empties its output dir at the
# start of a run, which would wipe the other run's.
visual="pnpm --filter @agent-board/desktop test:visual --output test-results-visual $playwright_args"
if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then
  e2e="sh scripts/e2e-headless.sh $e2e"
  visual="sh scripts/e2e-headless.sh $visual"
fi

# Run as agent-board's merge gate (AGENT_BOARD_GATE set), it marks its steps for the app's Gate tab (ADR-0013): each
# step's start, naming its log so the tab can follow it, and its end. Only with an absolute log dir, as the tab needs.
marks=
case "${AGENT_BOARD_GATE:-}:$log_dir" in 1:/*) marks=1 ;; esac
[ -n "$marks" ] && echo "::gate steps $steps"

# Run from inside an agent on a live board, the steps would inherit its AGENT_BOARD_* (where its hooks and socket are,
# who the agent is) and the tests' daemons, fakes and app would talk to that board. Keep only the run knobs,
# the list RUN_KNOBS in packages/fake-harness/src/board-guard.ts. packages/fake-harness/test/board-guard.test.ts checks the two
# match by reading the kept names from the one `case` line below, indented four spaces: keep that shape. A
# FORCE_HYPERLINK that carries agent-board's marker was set for the agent, not by the user, so it goes with the marker,
# as scrubBoardEnv drops it; kept, the tests' app would take it for the user's own.
if [ -n "${AGENT_BOARD_FORCED_HYPERLINK:-}" ]; then unset FORCE_HYPERLINK; fi
for var in $(env | sed -n 's/^\(AGENT_BOARD_[A-Za-z0-9_]*\)=.*/\1/p'); do
  case $var in
    AGENT_BOARD_GATE | AGENT_BOARD_E2E_WORKERS | AGENT_BOARD_E2E_LOCK | AGENT_BOARD_E2E_LOCK_WAIT_MIN | AGENT_BOARD_HEADED | AGENT_BOARD_E2E_SHOTS | AGENT_BOARD_VITEST_WORKERS) ;;
    *) unset "$var" ;;
  esac
done

# Each stage's wall-clock limit in minutes, about three times a usual run on a loaded machine. The unit tests get more:
# on a busy machine they took about 10 minutes when measured, longer if the process limit cuts the processes
# project's workers (scripts/vitest-workers), and a stuck test is caught within a minute or so by the watchdog anyway. The visual suite gets 20: it runs over 100 shots, about 6–7 minutes on 3 workers when the machine is quiet. The visual and e2e limits start once the e2e lock is held.
# CHECK_LIMIT_MIN sets them all (the gate's own test does: scripts/deadline/check-local.test.ts).
checks_min=${CHECK_LIMIT_MIN:-10}
test_min=${CHECK_LIMIT_MIN:-45}
visual_min=${CHECK_LIMIT_MIN:-20}
e2e_min=${CHECK_LIMIT_MIN:-30}
deadline="node scripts/deadline/main.ts"

# Runs a step in the background; its outcome and time land in $log_dir/<name>.result for the table below to read.
# A step that ran past its limit exits 124 and its log says so (scripts/deadline).
start() {
  name=$1
  shift
  (
    started=$(date +%s)
    [ -n "$marks" ] && echo "::gate start $name log=$log_dir/$name.log"
    "$@" >"$log_dir/$name.log" 2>&1
    code=$?
    outcome=FAIL
    [ $code = 0 ] && outcome=pass
    [ $code = 124 ] && grep -q '^deadline: stage' "$log_dir/$name.log" && outcome=TIMEOUT
    echo "$outcome $(($(date +%s) - started))" >"$log_dir/$name.result"
    [ -n "$marks" ] && if [ "$outcome" = pass ]; then echo "::gate end $name pass"; else echo "::gate end $name fail"; fi
    echo "$name: $outcome (log: $log_dir/$name.log)"
  ) &
}

# A reused log dir keeps the last run's results and Playwright reports, which would count as this run's.
rm -f "$log_dir"/*.result "$log_dir/visual.json" "$log_dir/e2e.json" "$log_dir/test.json"
# A Mac that sleeps mid-run freezes the tests, and they wake to find their timeouts gone: keep it awake until this
# gate exits, and say beside the table if it slept anyway (scripts/machine-sleep).
gate_started=$(date +%s)
node scripts/machine-sleep/main.ts keep-awake $$
battery=$(node scripts/machine-sleep/main.ts battery)
[ -n "$battery" ] && echo "$battery"
outcome_of() { cut -d' ' -f1 "$log_dir/$1.result" 2>/dev/null; }
# Why a step has no result: set when a stage is skipped, read by the table below.
not_run="the build failed"
# Stage 0: the pre-flight, alone. On its failure nothing else runs: the merged tree is not the one the steps would check.
start preflight $deadline preflight "$checks_min" -- pnpm preflight
wait
if [ "$(outcome_of preflight)" != pass ]; then
  not_run="the pre-flight failed"
  echo "lint, typecheck, test, build, e2e, visual, markdownlint, knip: not run, $not_run"
else
# Stage 1: the cheap steps and the build, together.
start build $deadline build "$checks_min" -- pnpm build
start lint $deadline lint "$checks_min" -- pnpm lint
start typecheck $deadline typecheck "$checks_min" -- pnpm typecheck
start markdownlint $deadline markdownlint "$checks_min" -- pnpm dlx markdownlint-cli2@0.23.2
start knip $deadline knip "$checks_min" -- pnpm knip
wait
quick_failed=
for name in lint typecheck markdownlint knip; do [ "$(outcome_of "$name")" = pass ] || quick_failed=1; done
if [ -n "$quick_failed" ]; then
  # The unit, visual and e2e runs would take half an hour to end in a gate that has already failed.
  not_run="a quick check failed"
  echo "test, e2e, visual: not run, $not_run"
else
# Stage 2: the unit tests alone. They have 5-second timeouts and run slower than that beside anything heavy.
# The JSON report names the failed files for the result record below.
start test $deadline test "$test_min" -- pnpm test --reporter=default --reporter=json "--outputFile.json=$log_dir/test.json"
wait
if [ -n "$quick" ]; then
  :
elif [ "$(outcome_of build)" = pass ]; then
  # Stage 3: the Electron runs. The native visual run goes first, alone of the Electron runs: its screenshots differ when
  # the e2e's apps are launching beside it. Its own spec files share its workers (3, or 2 when the load is high); five
  # clean runs in a row (166 shots, 6 to 7 minutes each, no retries, load 6 to 15) showed that is stable, and the gate's two
  # retries absorb the rare load flake. Then the e2e.
  start visual env PLAYWRIGHT_JSON_OUTPUT_FILE="$log_dir/visual.json" node scripts/e2e-lock/main.ts visual -- $deadline visual "$visual_min" -- sh -c "$visual"
  wait
  start e2e env PLAYWRIGHT_JSON_OUTPUT_FILE="$log_dir/e2e.json" node scripts/e2e-lock/main.ts e2e -- $deadline e2e "$e2e_min" -- sh -c "$e2e"
  wait
else
  # The e2e drives the built app; with the build broken it would test a stale one.
  echo "e2e, visual: not run, the build failed"
fi
fi
fi

failed=0
results=""
limit_of() {
  case $1 in test) echo "$test_min" ;; visual) echo "$visual_min" ;; e2e) echo "$e2e_min" ;; *) echo "$checks_min" ;; esac
}
row() {
  name=$1
  if [ -f "$log_dir/$name.result" ]; then
    read -r outcome seconds <"$log_dir/$name.result"
    [ "$outcome" = pass ] || failed=1
    [ "$outcome" = TIMEOUT ] && outcome="FAIL: over its $(limit_of "$name") min limit"
    flaky_count=0
    [ -f "$log_dir/$name.json" ] && flaky_count=$(node scripts/e2e-flaky/main.ts "$log_dir/$name.json" | wc -l | tr -d ' ')
    [ "$flaky_count" != 0 ] && outcome="$outcome, $flaky_count flaky"
    results="$results| \`$name\` | $outcome | ${seconds}s |
"
  else
    results="$results| \`$name\` | not run: $not_run | |
"
    failed=1
  fi
}
for name in $steps; do row "$name"; done
flaky=$(node scripts/e2e-flaky/main.ts "$log_dir/visual.json" "$log_dir/e2e.json")

echo
echo "${quick:+Quick }Local checks on \`$commit\`${dirty:+ (with uncommitted changes)}, $(uname -s):"
echo
echo "| Step | Result | Time |"
echo "| --- | --- | --- |"
printf '%s' "$results"
if [ -n "$flaky" ]; then
  echo
  echo "Flaky, passed on a retry (fix them; they don't fail the gate):"
  echo
  printf '%s\n' "$flaky" | sed 's/^/- /'
fi
# The result record says what this run found, per step and failed file, so `pnpm check:pr --recheck` after a fix
# reruns only that and what the fix touched (scripts/gate-results). Passed or not, but only from a whole run on a tree
# that was clean and on the same commit from start to end.
if [ -z "$quick" ] && [ -z "$dirty" ] && [ -z "$(git status --porcelain | head -n 1)" ] && [ "$(git rev-parse HEAD)" = "$sha" ]; then
  echo
  node scripts/gate-results/main.ts write "$sha" "$log_dir" $steps
fi
# The stamp says this commit passed: only with every step run and passed, on a tree that was clean and on the same
# commit from start to end.
if [ -z "$quick" ] && [ $failed = 0 ] && [ -z "$dirty" ] && [ -z "$(git status --porcelain | head -n 1)" ] && [ "$(git rev-parse HEAD)" = "$sha" ]; then
  echo
  node scripts/gate-stamp/main.ts write "$sha"
fi
node scripts/machine-sleep/main.ts note "$gate_started"
# Read again: plugged in or unplugged since the start, the end is what the next run inherits.
battery=$(node scripts/machine-sleep/main.ts battery)
[ -n "$battery" ] && printf '\n%s\n' "$battery"
exit $failed
