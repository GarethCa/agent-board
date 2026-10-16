#!/bin/sh
# Updates this checkout and installs the new app as ~/Applications/agent-board.app. Needs Node 24+ (it runs TypeScript directly).
set -e
exec node "$(dirname "$0")/update-app/main.ts" "$@"
