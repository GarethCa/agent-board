#!/bin/sh
# The fake merge gate for tests: what a zone's gate command runs instead of a repo's real checks. It marks its
# steps as ADR-0013 says (`::gate steps|start|end`) and streams a few lines from each, quickly, so no test waits long.
#
#   fake-gate.sh pass      lint, test and e2e pass; test writes its output to a log it names (`log=`), in $TMPDIR,
#                          which it leaves there: the daemon may read it after the step has ended
#   fake-gate.sh fail      e2e fails, its last lines saying why, and the gate exits 1
#   fake-gate.sh slow      as pass, but test takes about 3 seconds, a line at a time, to watch it stream
#   fake-gate.sh hang      lint passes, then test starts a child that sleeps, and waits on it: for Stop
#   fake-gate.sh plain     no markers: two lines, then exit 0 (or exit 3 with `plain fail`)
#   fake-gate.sh baddir    one step whose log= names a directory, which can't be read as a log; it passes
#   fake-gate.sh flood     one step that prints about 11 MB, past the cap on a run's logs; it passes
#
# With FAKE_GATE_PID_FILE set, `hang` writes its sleeping child's pid there.
set -u
mode=${1:-pass}

if [ "$mode" = plain ]; then
  echo "checking everything"
  echo "pwd: $(pwd)"
  [ "${2:-}" = fail ] && exit 3
  exit 0
fi

if [ "$mode" = baddir ]; then
  echo "::gate start test log=/usr"
  echo "::gate end test pass"
  exit 0
fi

if [ "$mode" = flood ]; then
  echo "::gate start flood"
  head -c 11000000 /dev/zero | tr '\0' 'x' | fold -w 100
  echo
  echo "::gate end flood pass"
  exit 0
fi

echo "::gate steps lint test e2e"

echo "::gate start lint"
echo "lint: 12 files, no problems"
echo "::gate end lint pass"

if [ "$mode" = hang ]; then
  echo "::gate start test"
  sleep 600 &
  [ -n "${FAKE_GATE_PID_FILE:-}" ] && echo $! >"$FAKE_GATE_PID_FILE"
  echo "test: waiting"
  wait
  exit 1
fi

log=$(mktemp "${TMPDIR:-/tmp}/fake-gate-test.XXXXXX")
echo "::gate start test log=$log"
lines=3
[ "$mode" = slow ] && lines=12
i=1
while [ "$i" -le "$lines" ]; do
  echo "✓ src/case-$i.test.ts" >>"$log"
  [ "$mode" = slow ] && sleep 0.25
  i=$((i + 1))
done
echo "::gate end test pass"

echo "::gate start e2e"
echo "Running 18 tests using 2 workers"
if [ "$mode" = fail ]; then
  echo "✘ checkout.spec.ts:44 › pays for a cart with a sold-out item"
  echo "  Expected \"Out of stock\" to be visible"
  echo "1 failed, 17 passed (1.5m)"
  echo "::gate end e2e fail"
  exit 1
fi
echo "18 passed (1.5m)"
echo "::gate end e2e pass"
