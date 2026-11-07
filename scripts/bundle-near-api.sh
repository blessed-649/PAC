#!/usr/bin/env bash
# Rebuild the browser bundle of near-api-js for the PAC demo site.
# near-api-js v5 ships no UMD dist build, so the site serves this local
# bundle (public/near-api-js.bundle.min.js) instead of a CDN script tag.
# Run from ~/workspace/pac. Requires esbuild (npx) and the devDependencies
# in package.json (buffer, util — Node-builtin shims for the browser build).
set -e
cd ~/workspace/pac || exit 1
npx esbuild build/near-api-entry.mjs --bundle --minify --format=iife \
  --platform=browser --define:global=window \
  --banner:js="window.process=window.process||{env:{},nextTick:function(){var a=arguments;setTimeout(function(){a[0].apply(null,Array.prototype.slice.call(a,1))},0)}};" \
  --outfile=public/near-api-js.bundle.min.js
ls -la public/near-api-js.bundle.min.js
echo "BUNDLE OK"
