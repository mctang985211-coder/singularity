#!/usr/bin/env bash
# The two sides of one Ball verification, with the tool names the MCP server exposes.
set -euo pipefail

ball="${1:?usage: run_bemu.sh <ball> <chip>}"
chip="${2:?usage: run_bemu.sh <ball> <chip>}"

# Build the CTests first: both sides run the same binary.
bbdev_workload_build chip="$chip"
bbdev_bemu_sim chip="$chip" binary="${chip}_${ball}_test-baremetal"
