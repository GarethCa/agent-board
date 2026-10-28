#!/bin/sh
# Records the promo's board shots: one video and one cue log per storyboard shot (apps/desktop/e2e/capture/shot-*.spec.ts),
# driven by the fake agents over a seeded demo board, so no tokens are spent. The app paints offscreen at two device
# pixels per CSS pixel and its frames go to ffmpeg at 60 fps.
#
#   sh scripts/promo-capture.sh             every shot
#   sh scripts/promo-capture.sh shot-04     the shots whose file names match
#
# PROMO_OUT is where they go (default apps/desktop/test-results/promo), PROMO_FFMPEG the ffmpeg to use (one with
# prores_videotoolbox, or the encoder PROMO_ENCODER names: prores, prores-sw, h264, x264) and PROMO_SIZE the window's
# CSS size (default 1152x648). Builds the app first. One shot at a time: two recordings at once drop frames. Never run
# by a gate.
set -eu
cd "$(dirname "$0")/.."

pnpm build
shots="e2e/capture/shot-"
if [ $# -gt 0 ]; then shots=""; for shot in "$@"; do shots="$shots e2e/capture/$shot"; done; fi
# shellcheck disable=SC2086 # one argument per shot
pnpm --filter @agent-board/desktop exec playwright test --project promo --workers 1 $shots
