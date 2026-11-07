#!/usr/bin/env bash
# Build PAC contracts (token first, then arena embeds the token WASM).
# Run from ~/workspace/pac. Exit 0 only if both WASMs exist.
# Note: cargo-near writes to the workspace target dir
# (target/near/pac_token/pac_token.wasm, target/near/pac_arena/pac_arena.wasm).
set -u
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TERM_COLOR=never
mkdir -p "$HOME/.tmp"
export TMPDIR="$HOME/.tmp" TMP="$HOME/.tmp" TEMP="$HOME/.tmp"
cd ~/workspace/pac || exit 1

echo "=== token ==="
cd contracts/token || exit 1
cargo near build non-reproducible-wasm || exit 2
test -f ../../target/near/pac_token/pac_token.wasm || { echo "TOKEN WASM NOT FOUND"; exit 3; }
cp ../../target/near/pac_token/pac_token.wasm ../arena/token.wasm
echo "token wasm copied to contracts/arena/token.wasm"
cd ~/workspace/pac || exit 1

echo "=== arena ==="
cd contracts/arena || exit 1
cargo near build non-reproducible-wasm || exit 4
test -f ../../target/near/pac_arena/pac_arena.wasm || { echo "ARENA WASM NOT FOUND"; exit 5; }
cd ~/workspace/pac || exit 1

echo "=== output ==="
ls -la target/near/pac_token/pac_token.wasm target/near/pac_arena/pac_arena.wasm
sha256sum target/near/pac_token/pac_token.wasm target/near/pac_arena/pac_arena.wasm
echo "BUILD OK"
