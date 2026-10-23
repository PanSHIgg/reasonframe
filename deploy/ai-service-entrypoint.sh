#!/bin/sh
set -eu

# An explicit compose command (or docker run argument) always wins.
if [ "$#" -gt 0 ]; then
    exec "$@"
fi

if [ -n "${AI_SERVICE_ENTRYPOINT:-}" ]; then
    exec sh -c "${AI_SERVICE_ENTRYPOINT}"
fi

# Prefer an ai-service package script when the service provides one.
if [ -f /app/ai-service/package.json ]; then
    if node -e "const p=require('/app/ai-service/package.json');process.exit(p.scripts&&p.scripts.start?0:1)"; then
        cd /app/ai-service
        exec npm start
    fi
fi

# Otherwise find the compiled entrypoint or fall back to running TypeScript.
for candidate in \
    /app/ai-service/dist/src/index.js
do
    if [ -f "$candidate" ]; then
        exec node "$candidate"
    fi
done

if [ -f /app/ai-service/src/index.ts ]; then
    exec node --import tsx /app/ai-service/src/index.ts
fi

echo "ai-service: no start script or entrypoint found under /app" >&2
exit 1
