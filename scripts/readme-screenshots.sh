#!/bin/sh
# Regenerates the README's screenshots in docs/assets/screenshots/ from the running app, driven by the fake claude over a
# seeded demo board and drawn the way the visual spec draws it. Look at each PNG that changed, then commit them.
#
#   sh scripts/readme-screenshots.sh
#
# Builds the app first; `pnpm --filter @agent-board/desktop readme:screenshots` alone skips the build. The same UI gives
# the same bytes: the spec pins what is random (tile tilt, branch hashes, counters) and waits for what is timed.
#
# On Linux with no display it runs on a virtual display (scripts/e2e-headless.sh). On a Mac the run is background-only,
# like all e2e. The Linear tab of Add zone needs a throwaway macOS keychain, so that shot is only made on a Mac and is
# left as it is elsewhere.
set -eu
cd "$(dirname "$0")/.."

pnpm build
run="pnpm --filter @agent-board/desktop readme:screenshots"
if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then run="sh scripts/e2e-headless.sh $run"; fi
$run
