#!/bin/bash
# PAC agent loop — run one decision cycle for each demo agent, staggered.
#
# Each agent wallet gets one sense -> think -> act -> remember cycle per
# run. The runner signs at most one arena action per agent per cycle and
# never spends below the 1 NEAR reserve. Safe to run on a schedule.
#
# Usage:
#   bash scripts/agent-loop.sh            # one cycle for degen, holder, sniper
#   bash scripts/agent-loop.sh --dry-run  # sense + think only, signs nothing
#   bash scripts/agent-loop.sh --agent holder
#
# To run it every hour, use the `pac-agent-loop` cron job (see README.md
# "Agent loop"), or run this script in a loop / systemd timer of your own.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/agent-runner.mjs --all "$@"
