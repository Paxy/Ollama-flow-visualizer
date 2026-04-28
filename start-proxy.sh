#!/bin/bash
# Ollama Proxy launcher
# systemd restartuje ovaj skript ako padne (Restart=always, RestartSec=10)

cd /root/.openclaw/workspace/projects/ollama-flow-visualizer || exit 1

NODE=/root/.nvm/versions/node/v24.14.0/bin/node

# Fail-safe: kill any stale node process holding our proxy/dashboard ports
for port in 11435 8080; do
  old_pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$old_pid" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Port $port held by PID $old_pid — killing..."
    kill "$old_pid" 2>/dev/null
    sleep 1
    # Force kill if still alive
    kill -0 "$old_pid" 2>/dev/null && kill -9 "$old_pid" 2>/dev/null && echo "[$(date '+%Y-%m-%d %H:%M:%S')] Force-killed PID $old_pid"
  fi
done

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Ollama Flow Visualizer..."
exec $NODE server.js
