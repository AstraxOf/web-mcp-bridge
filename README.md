<div align="center">

<img src="icons/icon128.png" width="96" alt="Web MCP Bridge">

# Web MCP Bridge

**Use your local MCP servers with ChatGPT, Gemini and Claude Web: no API keys, no extra subscriptions.**

[![English](https://img.shields.io/badge/English-Click-2563eb?style=flat-square)](README.md)
[![Español](https://img.shields.io/badge/Español-Clic-eab308?style=flat-square)](README.es.md)

[![CI](https://github.com/AstraxOf/web-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/AstraxOf/web-mcp-bridge/actions)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-0f766e?style=flat-square&logo=googlechrome&logoColor=white)
![License MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![Dependencies](https://img.shields.io/badge/extension%20deps-0-success?style=flat-square)
![Chrome | Edge | Brave](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Brave-116%2B-informational?style=flat-square)

[![Telegram](https://img.shields.io/badge/Telegram-Channel-26A5E4?style=flat-square&logo=telegram&logoColor=white)](https://t.me/AstraxMCP)
[![YouTube](https://img.shields.io/badge/YouTube-@AstraxOf-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://youtube.com/@AstraxOf)
[![Website](https://img.shields.io/badge/astrabots.pro-0f766e?style=flat-square&logo=googlechrome&logoColor=white)](https://astrabots.pro)
[![Core SDK](https://img.shields.io/badge/astrax--mcp-Python-3776AB?style=flat-square&logo=python&logoColor=white)](https://github.com/AstraxOf/astrax-mcp)
[![GitHub](https://img.shields.io/badge/GitHub-AstraxOf-181717?style=flat-square&logo=github)](https://github.com/AstraxOf)

</div>

---
<div align="center">
  <img src="assets/demo.gif" width="700" alt="Demostración de Web MCP Bridge">
</div>

Free AI chat UIs don't speak MCP. **Web MCP Bridge** adds it: the model asks for a tool with a JSON block,
the extension runs it on your local MCP server over WebSocket and pastes the result back into the chat.
By default you approve every call.

> [!IMPORTANT]
> Only connect MCP servers you trust. A tool with filesystem access can read whatever you allow it to.

## 🧩 Supported platforms

| Platform | Status | Adapter |
|---|---|---|
| ![ChatGPT](https://img.shields.io/badge/ChatGPT-74aa9c?style=for-the-badge&logo=openai&logoColor=white) | ✅ Supported | `adapters/chatgpt.js` |
| ![Gemini](https://img.shields.io/badge/Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white) | ✅ Supported | `adapters/gemini.js` |
| ![Claude](https://img.shields.io/badge/Claude-D97757?style=for-the-badge&logo=anthropic&logoColor=white) | ✅ Supported | `adapters/claude.js` |
| ![Perplexity](https://img.shields.io/badge/Perplexity-1FB8CD?style=for-the-badge&logo=perplexity&logoColor=white) · ![DeepSeek](https://img.shields.io/badge/DeepSeek-4D6BFE?style=for-the-badge) · ![Le Chat](https://img.shields.io/badge/Le%20Chat-FA520F?style=for-the-badge&logo=mistralai&logoColor=white) | 🗺️ Roadmap | [Contribute](CONTRIBUTING.md) |

## ✨ Skills at a glance

| | Skill | What it does |
|---|---|---|
| ![multi](https://img.shields.io/badge/Multi--MCP-0f766e?style=flat-square) | **Context control** | Register many servers, **1 active by default** (up to **5**). Only active servers' tools reach the model; the popup shows the approximate token cost. |
| ![perms](https://img.shields.io/badge/Permissions-dc2626?style=flat-square) | **Per-MCP permissions** | 3-state selector — *Allow always* · *Ask every time* · *Don't allow* — global and per server, in the popup and the in-page panel. |
| ![files](https://img.shields.io/badge/Attachments-7c3aed?style=flat-square) | **Nothing is dropped** | Images, audio and binary resources are attached to the chat as real files; long text is attached in full instead of truncated. |
| ![empty](https://img.shields.io/badge/Ships%20empty-475569?style=flat-square) | **No preinstalled MCP** | Add your own, or the bundled demo server with one click. |
| ![bg](https://img.shields.io/badge/Background--tab%20safe-0891b2?style=flat-square) | **Reliable in the background** | No step relies on page timers (throttled when hidden); delivery is verified and retried. |
| ![memory](https://img.shields.io/badge/Tool%20memory-ca8a04?style=flat-square) | **The AI doesn't forget** | A one-line reminder per message plus periodic full re-injection. |
| ![compact](https://img.shields.io/badge/Compact%20prompt-16a34a?style=flat-square) | **≈ 50 % fewer tokens** | Tools are described as `name(param: type)` signatures instead of JSON Schema. |
| ![adapter](https://img.shields.io/badge/Adapter%20pattern-2563eb?style=flat-square) | **~40 lines per platform** | A new platform is just a set of selectors. |
| ![secure](https://img.shields.io/badge/Secure%20by%20design-b91c1c?style=flat-square&logo=letsencrypt&logoColor=white) | **Locked down** | The Python bridge listens on `127.0.0.1`, only accepts `chrome-extension://` origins and supports a token. Websites can't reach your tools. |
| ![reliable](https://img.shields.io/badge/Reliability-9333ea?style=flat-square) | **No duplicates, auto-reconnect** | Per-call IDs, exponential backoff, keep-alive for the MV3 Service Worker, call history, light/dark UI. |

> [!TIP]
> Want to try it in 60 seconds? The repo ships with a **demo MCP server**. See [Quick start](#-quick-start-60-seconds).

## ⚡ One-time setup, then just a switch

Browsers can't launch local programs, so run this **once**. It keeps the bridge running in the background at login (Windows / macOS / Linux):

```bash
python server/install_service.py
```

Then load the extension. Use the **master switch in the popup** (or the in-page panel) to turn the bridge on/off; the icon shows `OFF` when disabled.
Remove auto-start with `python server/install_service.py --uninstall`.

## 🚀 Quick start (60 seconds)

```bash
pip install -r server/requirements.txt
python server/mcp_ws_bridge.py --port 8080 --name demo -- python server/examples/demo_mcp_server.py
```

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the popup and add your server (e.g. `astrax_mcp` at `ws://localhost:8080`), or click **Add demo server**.
3. Open ChatGPT / Gemini / Claude → open the **Web MCP Bridge** panel (bottom-left) → **Inject instructions**.
4. Ask *"What time is it? Use your tools."* and approve the call.

**Your own server:**

```bash
python server/mcp_ws_bridge.py --port 8080 -- python -m astrax_mcp
```

**Several at once:** see `server/servers.example.json` and `--config`.

## 📡 Call protocol

```json
{ "mcp_call": { "server": "server_name", "name": "tool_name", "arguments": { "arg1": "value" } } }
```

Results come back as:

```
[MCP_RESULT server="…" tool="…" status="ok|error|rejected"]
…
[/MCP_RESULT]
```

> [!NOTE]
> The content of `MCP_RESULT` is presented to the AI as *data*, not instructions (prompt-injection mitigation).

See the [Spanish README](README.es.md) for the architecture diagram, security model, selector-fix guide and roadmap.

## 🛠️ Development

```bash
npm test      # syntax, parser, prompt builder and bridge integration tests
npm run pack  # dist/web-mcp-bridge.zip
```

## 🤝 Community & Contributing

**Astrax** is open source and grows with its community. You're welcome to open issues, send pull requests, suggest ideas, try Astrax on other systems or MCP clients, and report bugs. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started — new adapters are the best first contribution.

[![Telegram Channel](https://img.shields.io/badge/Telegram-Official%20channel-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/AstraxMCP)
[![YouTube](https://img.shields.io/badge/YouTube-@AstraxOf-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtube.com/@AstraxOf)
[![Creator on Telegram](https://img.shields.io/badge/Creator-@RufusOficial-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/RufusOficial)
[![Email](https://img.shields.io/badge/Email-avpn497%40gmail.com-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:avpn497@gmail.com)

If you find the project useful, leave a ⭐ on the repository and subscribe to the channel.

<div align="center">

Made with 💙 by Rufus · [@AstraxOf](https://github.com/AstraxOf) · [astrabots.pro](https://astrabots.pro)

**[MIT License](LICENSE)**

</div>
