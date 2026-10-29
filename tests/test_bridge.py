"""Prueba de integración: WebSocket → puente → servidor MCP demo (stdio)."""
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
PORT = 18765


async def rpc(ws, msg_id, method, params=None):
    await ws.send(json.dumps({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}}))
    while True:
        reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if reply.get("id") == msg_id:
            return reply


async def main():
    url = f"ws://127.0.0.1:{PORT}"

    # Cliente sin Origin (CLI): permitido
    async with websockets.connect(url) as ws:
        init = await rpc(ws, 1, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
        assert init["result"]["serverInfo"]["name"] == "demo-mcp", init
        await ws.send(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}))

        assert (await rpc(ws, 2, "ping"))["result"] == {}

        tools = (await rpc(ws, 3, "tools/list"))["result"]["tools"]
        assert {t["name"] for t in tools} == {"hora_actual", "sumar", "eco"}, tools

        res = (await rpc(ws, 4, "tools/call", {"name": "sumar", "arguments": {"a": 2, "b": 40}}))["result"]
        assert res["content"][0]["text"] == "42", res

        res = (await rpc(ws, 5, "tools/call", {"name": "eco", "arguments": {"texto": "ñandú ✓"}}))["result"]
        assert res["content"][0]["text"] == "ñandú ✓", res

    # Origin de una web: debe ser rechazado
    try:
        async with websockets.connect(url, origin="https://chatgpt.com") as ws:
            await asyncio.wait_for(ws.recv(), 3)
        raise AssertionError("Una web NO debería poder conectarse")
    except (websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus, websockets.exceptions.InvalidHandshake):
        pass

    # Origin de extensión: permitido
    async with websockets.connect(url, origin="chrome-extension://abcdefghijklmnop") as ws:
        assert (await rpc(ws, 1, "ping"))["result"] == {}

    print("✔ test_bridge: todo correcto")


if __name__ == "__main__":
    bridge = subprocess.Popen(
        [sys.executable, str(ROOT / "server/mcp_ws_bridge.py"), "--port", str(PORT), "--name", "demo", "--",
         sys.executable, str(ROOT / "server/examples/demo_mcp_server.py")],
        stderr=subprocess.PIPE,
    )
    try:
        time.sleep(1.5)
        asyncio.run(main())
    finally:
        bridge.terminate()
        bridge.wait(timeout=5)
