#!/bin/sh
# Runs the end-to-end tests (or the command given) on a virtual X display, for Linux with no display: CI and build
# agents. A window manager runs on it when openbox is installed, as minimising and restoring windows need one.
set -eu
if [ "$#" -eq 0 ]; then set -- pnpm test:e2e; fi
if ! command -v openbox >/dev/null 2>&1; then
  echo "e2e-headless: openbox is not installed, so the tests that minimise windows will fail" >&2
fi
# xvfb-run -a takes the first free display from -n on; starting from a number of our own keeps two runs that start at
# once from picking the same one.
exec xvfb-run -n $((100 + $$ % 400)) -a sh -c '
  if command -v openbox >/dev/null 2>&1; then
    openbox >/dev/null 2>&1 &
    # Give it a moment to start managing windows before the first test opens one.
    sleep 1
  fi
  exec "$@"
' e2e-headless "$@"
