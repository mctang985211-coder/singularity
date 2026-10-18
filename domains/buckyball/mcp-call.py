#!/usr/bin/env python3
"""Call the repository's real stdio MCP server and poll asynchronous tasks."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def payload(result):
    for item in result.content:
        if item.type == "text":
            try:
                return json.loads(item.text)
            except ValueError:
                continue
    raise RuntimeError(f"MCP returned no JSON payload: {result}")


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    parser.add_argument("tool")
    parser.add_argument("arguments", help="JSON object")
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    root = args.repository.resolve()
    parameters = StdioServerParameters(command=str(root / "result/bin/python3"), args=["-u", str(root / "bbdev/mcp/__main__.py")], cwd=str(root),
        env={**os.environ, "NIX_QUIET": "1", "CARGO_NET_RETRY": "0"})
    evidence = {"version": 1, "transport": "stdio MCP", "repository": str(root), "tool": args.tool, "arguments": json.loads(args.arguments), "events": []}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    def record(event):
        evidence["events"].append(event)
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(event), flush=True)
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            response = payload(await session.call_tool(args.tool, json.loads(args.arguments)))
            record(response)
            trace = response.get("trace_id")
            if not trace:
                return 0 if response.get("success") else 1
            previous = None
            deadline = time.monotonic() + args.timeout
            cancelled = False
            while True:
                state = payload(await session.call_tool("bbdev_task_status", {"trace_id": trace}))
                encoded = json.dumps(state, sort_keys=True)
                if encoded != previous:
                    record(state)
                    previous = encoded
                if state.get("processing") is False or state.get("status") in ("success", "failure", "cancelled") or state.get("done") is True:
                    return 0 if state.get("status") == "success" or state.get("success") is True else 1
                if time.monotonic() > deadline and not cancelled:
                    record({"timeout": True, "cancel": payload(await session.call_tool("bbdev_task_cancel", {"trace_id": trace}))})
                    cancelled = True
                await asyncio.sleep(2)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
