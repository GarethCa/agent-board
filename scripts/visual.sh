#!/bin/sh
# The visual spec on this machine, for the platform's own baselines (`-darwin` on a Mac, `-linux` on Linux).
#
#   sh scripts/visual.sh check             compare this platform's baselines (the default)
#   sh scripts/visual.sh update            rewrite them
#
# Native only.
#
# Look at each PNG that changed, then commit them. Run `pnpm build` first (the spec drives the built app). On Linux with no
# display it runs on a virtual display (scripts/e2e-headless.sh). On a Mac the native run is background-only, like all e2e.
set -eu
cd "$(dirname "$0")/.."

mode=${1:-check}
case $mode in
  check | update) ;;
  *)
    echo "usage: sh scripts/visual.sh [check|update]" >&2
    exit 1
    ;;
esac

platform=darwin
if [ "$(uname -s)" = Linux ]; then platform=linux; fi

run="pnpm --filter @agent-board/desktop test:visual"
if [ "$mode" = update ]; then
  run="$run --update-snapshots"
  # Regenerate from nothing, so a baseline for a shot that no longer exists is removed.
  rm -f apps/desktop/e2e/visual.spec.ts-snapshots/*-visual-"$platform".png
fi
if [ "$platform" = linux ] && [ -z "${DISPLAY:-}" ]; then run="sh scripts/e2e-headless.sh $run"; fi
$run
