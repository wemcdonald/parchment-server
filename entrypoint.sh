#!/bin/sh
# Run parchment-saves in the background; if it exits, take nginx down too
# so docker restart kicks in.
set -e

/usr/local/bin/parchment-saves &
SAVES_PID=$!

trap 'kill -TERM $SAVES_PID 2>/dev/null; wait $SAVES_PID 2>/dev/null; exit' TERM INT

# Watchdog: if saves binary dies, kill nginx (PID 1 will exit).
(
    wait $SAVES_PID
    rc=$?
    echo "parchment-saves exited (rc=$rc), shutting down" >&2
    kill -TERM 1 2>/dev/null
) &

exec nginx -g 'daemon off;'
