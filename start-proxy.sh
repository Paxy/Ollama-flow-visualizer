#!/bin/bash
# Ollama Proxy launcher
# systemd restartuje ovaj skript ako padne (Restart=always, RestartSec=10)

cd /root/.openclaw/workspace/projects/ollama-flow-visualizer || exit 1

NODE=/root/.nvm/versions/node/v24.14.0/bin/node

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Ollama Flow Visualizer..."
exec $NODE server.js
