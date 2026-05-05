# Ollama Flow Visualizer

Transparent Ollama proxy with live request/response monitoring dashboard.

Intercepts all requests to Ollama, logs them in real-time, and displays them in a group-by-prompt dashboard with tool call matching, streaming visibility, and duration tracking.

## Screenshots

![Ollama Flow Visualizer dashboard](docs/screenshots/dashboard.png)

*Grouped requests, tool calls, decoded responses, status indicators, and live streaming durations.*

## Features

- **Transparent proxy** — sits between OpenClaw (or any Ollama/OpenAI-compatible client) and Ollama. No client-side changes needed. Supports both native `/api/chat` and `/v1/chat/completions` endpoints.
- **Live dashboard** — Socket.IO-powered real-time UI at `http://<host>:8080`
- **Smart grouping** — groups requests by user prompt (same prompt = same group on the dashboard)
- **Thinking/reasoning extraction** — automatically extracts and displays `thinking` tokens from Ollama-native streaming chunks (Gemma 4, Qwen 3.5, etc.) and `reasoning_content` from OpenAI-compatible models. No raw JSON metadata in the response view.
- **Native Ollama API support** — full support for Ollama's native `/api/chat` protocol including multimodal (text + image) requests, thinking tokens, and tool calls
- **Tool call matching & output lookup** — tool calls (`df`, `cat`, `exec`...) and their outputs are automatically matched by `toolCallId`, even when the call and its output arrive in separate requests within the same group
- **Streaming support** — real-time duration updates for streaming responses
- **Error source identification** — automatically detects whether an error originated from Ollama (timeout, connection refused, 5xx) or the Agent (interrupted, tool failure)
- **Total control** — clear logs, expand request/response bodies, inspect error details, see tool execution traces

## Installation

### Prerequisites

- Node.js ≥ 18
- Ollama server running

### Install

```bash
git clone https://github.com/Paxy/Ollama-flow-visualizer.git
cd Ollama-flow-visualizer
npm install
```

## Configuration

All configuration is in `config.json`:

```json
{
  "proxy": {
    "host": "0.0.0.0",
    "port": 11435
  },
  "ollama": {
    "host": "172.16.100.5",
    "port": 11434
  },
  "dashboard": {
    "host": "0.0.0.0",
    "port": 8080
  },
  "limits": {
    "maxLogs": 500,
    "requestBodyMaxChars": 5000,
    "toolOutputMaxChars": 2000,
    "decodedTextMaxChars": 5000,
    "streamTimeoutMs": 600000
  }
}
```

| Field | Default | Description |
|---|---|---|
| `proxy.host` | `0.0.0.0` | Proxy listen address |
| `proxy.port` | `11435` | Proxy listen port |
| `ollama.host` | `172.16.100.5` | Ollama server host |
| `ollama.port` | `11434` | Ollama server port |
| `dashboard.port` | `8080` | Web dashboard port |
| `limits.maxLogs` | `500` | Max stored log entries |
| `limits.streamTimeoutMs` | `600000` | Stream timeout (10 min) |
| `limits.requestBodyMaxChars` | `5000` | Request body truncation |
| `limits.toolOutputMaxChars` | `2000` | Tool output truncation |

If `config.json` is missing, all defaults above are used.

## Running

### Direct

```bash
node server.js
```

### As a systemd service

Create `/etc/systemd/system/ollama-flow-visualizer.service`:

```ini
[Unit]
Description=Ollama Flow Visualizer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/ollama-flow-visualizer/server.js
Restart=always
RestartSec=10
WorkingDirectory=/opt/ollama-flow-visualizer
StandardOutput=append:/opt/ollama-flow-visualizer/proxy.log
StandardError=append:/opt/ollama-flow-visualizer/proxy.log

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ollama-flow-visualizer
```

### With a launcher script

Create `start-proxy.sh` (included in the repo):

```bash
#!/bin/bash
cd /path/to/ollama-flow-visualizer || exit 1
NODE=$(which node)
echo "[$(date)] Starting Ollama Flow Visualizer..."
exec $NODE server.js
```

## Configuring OpenClaw to use the proxy

Define the proxy as an Ollama-native provider in `openclaw.json`. Use `api: "ollama"` (native Ollama API, not OpenAI-compatible) — this is required for image support and thinking/reasoning extraction.

```json
{
  "providers": {
    "ollama2": {
      "baseUrl": "http://localhost:11435",
      "api": "ollama",
      "models": [
        {
          "id": "qwen3.5:35b-a3b",
          "name": "Qwen3.5 35B-A3B Q4_K_M (MoE)",
          "api": "ollama",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 16384
        },
        {
          "id": "gemma4:26b",
          "name": "Gemma 4 26B Q4_K_M",
          "api": "ollama",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 16384
        },
        {
          "id": "qwen3.6:27b-q4_K_M",
          "name": "Qwen3.6 27B Q4_K_M (local)",
          "api": "ollama",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "ollama2/qwen3.5:35b-a3b",
        "fallbacks": [
          "ollama2/gemma4:26b",
          "ollama2/qwen3.6:27b-q4_K_M"
        ]
      }
    }
  }
}
```

### Key notes

- `baseUrl` — points to the Flow Visualizer proxy (`http://localhost:11435`), **without `/v1` suffix** (native Ollama API)
- `api` — **must be `"ollama"`** (native Ollama API). OpenClaw's Ollama plugin handles the actual `/api/chat` protocol
- `apiKey` — **not needed** for Ollama native API (the proxy doesn't validate it)
- The model `id` must match the actual Ollama model name exactly (e.g. `gemma4:26b`)
- For models with image support, add `"image"` to the `input` array (e.g. `gemma4:26b`)
- The proxy transparently passes through all Ollama-native streaming chunks — thinking/reasoning tokens are extracted and displayed on the dashboard

#### Dual-provider setup (direct + proxy)

You can keep a direct Ollama provider as a fallback:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://172.16.100.5:11434",
      "api": "ollama",
      "models": [ /* same models, direct connection */ ]
    },
    "ollama2": {
      "baseUrl": "http://localhost:11435",
      "api": "ollama",
      "models": [ /* same models, via proxy */ ]
    }
  }
}
```

Agent fallback chain example (from our production setup):

```json
{
  "model": {
    "primary": "ollama2/qwen3.5:35b-a3b",
    "fallbacks": [
      "ollama2/gemma4:26b",
      "ollama/gemma4:26b",
      "ollama2/qwen3.6:27b-q4_K_M"
    ]
  }
}
```

This gives you monitored requests through the proxy first, with direct-to-Ollama fallback if the proxy is down.

Now OpenClaw sends all requests through the proxy, and they appear on the dashboard at `http://<proxy-host>:8080`.

## Dashboard

Open `http://<proxy-host>:8080` in any browser.

- **Groups** — requests are grouped by user prompt (click to expand)
- **Status indicators** — ✓ Completed / ⏳ Active / ⚠ Interrupted / ❌ Error
- **Tool calls** — each tool name with its arguments and output shown inline
- **Request/Response bodies** — expandable raw JSON with syntax highlighting
- **Summary bar** — global counts and data size at the top
- **Live updates** — durations update in real-time during streaming
- **Clear button** — clears all stored logs

## Architecture

```
OpenClaw / Client  →  Flow Visualizer (:11435)  →  Ollama (:11434)
                            ↓
                      Web Dashboard (:8080)
```

The proxy captures request body (system prompt, messages, tool definitions, tool calls) and response body (decoded text, tool results), groups them by prompt, and pushes updates to the browser via Socket.IO in real-time.

## License

MIT
