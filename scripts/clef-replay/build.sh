#!/bin/sh
# Bundles the judge's pure parts into <dir>/judge.mjs for collect, clef and analyze.
set -e
npx esbuild "$(dirname "$0")/entry.ts" --bundle --platform=node --format=esm --outfile="$1/judge.mjs" --log-level=warning
