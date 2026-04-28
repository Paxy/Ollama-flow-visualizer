const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ============================================================
// Configuration (from config.json, with defaults)
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  console.log(`[CFG] Loaded: ${CONFIG_PATH}`);
} catch (e) {
  console.warn(`[CFG] Cannot read ${CONFIG_PATH}, using defaults: ${e.message}`);
  config = {};
}

const PROXY_HOST  = config.proxy?.host || '0.0.0.0';
const PROXY_PORT  = config.proxy?.port || 11435;
const OLLAMA_HOST = config.ollama?.host || '172.16.100.5';
const OLLAMA_PORT = config.ollama?.port || 11434;
const WEB_PORT    = config.dashboard?.port || 8080;
const STREAM_TIMEOUT_MS = config.limits?.streamTimeoutMs || 600000;

const TARGET_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}`;

// ============================================================
// State (live logs)
// ============================================================
const MAX_LOGS = config.limits?.maxLogs || 500;
const REQ_BODY_MAX = config.limits?.requestBodyMaxChars || 5000;
const TOOL_OUT_MAX = config.limits?.toolOutputMaxChars || 2000;
const DECODED_MAX  = config.limits?.decodedTextMaxChars || 5000;
const requestLogs = [];

function addLog(entry) {
  const existingIndex = requestLogs.findIndex(l => l.id === entry.id);
  if (existingIndex >= 0) {
    requestLogs[existingIndex] = entry;
  } else {
    requestLogs.unshift(entry);
    if (requestLogs.length > MAX_LOGS) requestLogs.pop();
  }
  webClients.forEach(socket => {
    socket.emit('log-update', entry);
  });
}

// ============================================================
// Web server + Socket.IO
// ============================================================
const webApp = express();
const webServer = http.createServer(webApp);
const io = new SocketIOServer(webServer, { cors: { origin: '*' } });

webApp.use(express.static(path.join(__dirname, 'public')));

let webClients = [];

// REST API
webApp.get('/api/logs', (req, res) => {
  res.json(requestLogs.slice(0, 200));
});

webApp.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

webApp.delete('/api/logs', (req, res) => {
  requestLogs.length = 0;
  // Notify all web clients
  webClients.forEach(socket => socket.emit('init', []));
  res.json({ ok: true });
  console.log('[WEB] Logs cleared');
});

io.on('connection', (socket) => {
  console.log(`[WEB] Client connected: ${socket.id}`);
  webClients.push(socket);
  socket.emit('init', requestLogs.slice(0, 200));
  socket.on('disconnect', () => {
    webClients = webClients.filter(s => s.id !== socket.id);
    console.log(`[WEB] Client disconnected: ${socket.id}`);
  });
});

// ============================================================
// Proxy server (transparent pass-through)
// ============================================================
const proxyServer = http.createServer((req, res) => {
  const requestId = uuidv4().slice(0, 8);
  const timestamp = Date.now();
  const startTime = process.hrtime.bigint();

  // Log entry
  const logEntry = {
    id: requestId,
    timestamp: new Date(timestamp).toISOString(),
    method: req.method,
    path: req.url,
    targetPath: req.url,
    headers: { ...req.headers },
    requestBody: null,
    responseStatus: null,
    responseBody: null,
    responseHeaders: null,
    durationMs: 0,
    streaming: false,
    startTime: timestamp,
    error: null,
    activeTimer: null
  };

  // Setup live ticker — broadcast duration every ~1.5s while request is active
  let tickerId = null;
  let lastTick = 0;
  const startTick = (tickMs) => {
    lastTick = tickMs;
    tickerId = setInterval(() => {
      const nowMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      logEntry.durationMs = nowMs;
      webClients.forEach(socket => {
        socket.emit('live-duration', { id: logEntry.id, durationMs: nowMs });
      });
    }, 1500);
  };
  const stopTick = () => {
    if (tickerId) { clearInterval(tickerId); tickerId = null; }
  };

  // Collect body for logging
  const bodyChunks = [];
  req.on('data', chunk => { bodyChunks.push(chunk); });

  req.on('end', () => {
    const requestBodyBuffer = Buffer.concat(bodyChunks);

    // Log request body as string — truncate AFTER extraction for display only
    let requestBodyStr = null;
    try {
      requestBodyStr = requestBodyBuffer.toString('utf8');
    } catch (e) {
      requestBodyStr = null;
    }

    // Extract system context (hidden prefix) and user prompt from chat/generate requests
    logEntry.systemContext = null;
    logEntry.userPrompt = null;
    if (requestBodyStr) {
      try {
        const body = JSON.parse(requestBodyStr);

        // Helper: clean metadata from prompt text
        const cleanPrompt = function(text) {
          if (!text) return '';
          // Step 1: Strip entire "OpenClaw runtime context" block + Sender metadata
          // The context block is injected by OpenClaw AFTER the user's message
          let cleaned = text.replace(/\n*OpenClaw runtime context[\s\S]*?```(?:json)?[\s\S]*?```\s*/g, '');
          // Step 2: If no triple-backtick block was found, strip runtime context text greedily
          cleaned = cleaned.replace(/\n*OpenClaw runtime context for the immediately preceding user message\.[\s\S]*$/, '');
          // Step 3: Fallback — if everything got stripped, try targeted context removal
          if (!cleaned.trim() && text.trim()) {
            const fallback = text.replace(/\n*OpenClaw runtime context for the immediately preceding user message\.[\s\S]+?```(?:json)?[\s\S]*?```\s*/g, '').trim();
            cleaned = fallback;
          }
          // Step 4: Remove orphan Sender metadata blocks
          cleaned = cleaned.replace(/Sender \(untrusted metadata\):[\s\S]*?```(?:json)?[\s\S]*?```\n*/g, '');
          // Step 5: Remove timestamp markers [Day Date UTC+TZ]
          cleaned = cleaned.replace(/\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2}[^\]]*\]\s*/g, '');
          return cleaned.trim();
        };

        // Ollama /api/chat format: { messages: [{role, content}, ...] }
        if (body.messages && Array.isArray(body.messages)) {
          const extractText = function(content) {
            let text = '';
            if (typeof content === 'string') {
              text = content;
            } else if (Array.isArray(content)) {
              text = content.map(p => {
                if (typeof p === 'string') return p;
                if (p.text) return p.text;
                if (p.content) return p.content;
                return '';
              }).filter(Boolean).join(' ');
            } else if (typeof content === 'object' && content !== null) {
              const textFields = ['text', 'content', 'message'];
              for (const key of textFields) {
                if (content[key] && typeof content[key] === 'string') { text = content[key]; break; }
              }
            }
            return cleanPrompt(text);
          };
          const systemMsgs = body.messages.filter(m => m.role === 'system')
            .map(m => extractText(m.content)).filter(Boolean).join('\n\n');
          // Find the last non-empty user message (skip runtime-context-only messages)
          const userMsgs = body.messages.filter(m => m.role === 'user');
          let userPromptText = null;
          for (let i = userMsgs.length - 1; i >= 0; i--) {
            const t = extractText(userMsgs[i].content);
            if (t) { userPromptText = t; break; }
          }
          logEntry.systemContext = systemMsgs && systemMsgs.length > 0 ? systemMsgs : null;
          logEntry.userPrompt = userPromptText;
          // Extract tools from the request if present
          logEntry.tools = body.tools && Array.isArray(body.tools) && body.tools.length > 0 ? body.tools.map(t => t.function?.name || t.type || JSON.stringify(t).slice(0,80)) : null;
          
          // Extract tool_calls from assistant messages (what the agent asked to execute)
          const assistantMsgs = body.messages.filter(m => m.role === 'assistant' && m.tool_calls && Array.isArray(m.tool_calls));
          logEntry.requestToolCalls = assistantMsgs.map(m => m.tool_calls)
            .flat()
            .map(tc => ({
              id: tc.id || tc.toolCallId || null,
              function: {
                name: tc.function?.name || 'unknown',
                rawArgs: tc.function?.arguments || '{}'
              }
            }));
          
          // Extract tool results/outputs from tool role messages
          const toolMsgs = body.messages.filter(m => m.role === 'tool');
          logEntry.toolOutputs = toolMsgs.map(m => {
            let text = m.content || '';
            if (typeof text === 'string' && text.length > TOOL_OUT_MAX) text = text.slice(0, TOOL_OUT_MAX) + '...(truncated)';
            return { toolCallId: m.tool_call_id, content: text };
          });

          // Build request summary for clean frontend display
          const lastMsg = body.messages[body.messages.length - 1];
          const extractSummaryText = function(content) {
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) return content.filter(p => p.text).map(p => p.text).join(' ');
            if (content && typeof content === 'object' && content.text) return content.text;
            return '';
          };
          logEntry.requestSummary = {
            model: body.model || 'unknown',
            messageCount: body.messages.length,
            stream: body.stream === true,
            userPrompt: logEntry.userPrompt ? logEntry.userPrompt.slice(0, 500) : null,
            lastMessage: {
              role: lastMsg?.role || 'unknown',
              content: cleanPrompt(extractSummaryText(lastMsg?.content || '')).slice(0, 500)
            },
            hasTools: !!(body.tools && body.tools.length > 0),
            toolChoice: body.tool_choice || 'auto'
          };
        }
        // Ollama /api/generate format: { prompt: "..." , system: "..." }
        else if (body.prompt !== undefined) {
          logEntry.systemContext = body.system || null;
          logEntry.userPrompt = cleanPrompt(body.prompt || '');
        }
      } catch (e) {
        console.error(`[EXTRACT] Failed to parse request body: ${e.message}`);
      }
    }

    // Truncate body for display/API (extraction already used full body above)
    if (requestBodyStr) {
      logEntry.requestBody = requestBodyStr.length > REQ_BODY_MAX
        ? requestBodyStr.slice(0, REQ_BODY_MAX) + '...(truncated)'
        : requestBodyStr;
    } else {
      logEntry.requestBody = '(binary/raw data)';
    }

    // Emit pending log immediately, before sending to Ollama
    logEntry.requestSize = requestBodyBuffer.length;
    logEntry.status = 'pending';
    addLog(logEntry);

    // Detect if streaming — check body
    let bodyStream = false;
    if (requestBodyStr) {
      try {
        const b = JSON.parse(requestBodyStr);
        bodyStream = b.stream === true;
      } catch (e) {}
    }
    // /api/chat i /api/generate su uvek streaming (Ollama default)
    const isStreaming = req.url.includes('/api/generate') ||
                        req.url.includes('/api/chat') ||
                        req.url.includes('/api/pull') ||
                        req.url.includes('/api/push') ||
                        req.url.includes('/api/create') ||
                        (bodyStream && (req.url.includes('/v1/') || req.url.includes('/openai/v1/')));

    // Create request to Ollama (forward all client headers)
    // Filter 'connection' header to avoid conflicts with keep-alive pool
    const filteredHeaders = { ...req.headers };
    delete filteredHeaders['connection'];

    const proxyReq = http.request(TARGET_URL + req.url, {
      method: req.method,
      headers: {
        ...filteredHeaders,
        host: `${OLLAMA_HOST}:${OLLAMA_PORT}`,
        'content-length': requestBodyBuffer.length
      },
      timeout: 600000 // 10 min — enough for long pull/chat requests
    }, (proxyRes) => {
      logEntry.responseStatus = proxyRes.statusCode;
      logEntry.responseHeaders = proxyRes.headers;
      
      if (isStreaming) {
        // === STREAMING (pure passthrough) ===
        logEntry.streaming = true;
        logEntry.status = 'streaming';
        startTick();
        addLog(logEntry);
        
        let fullResponseRaw = '';
        let decodedText = '';
        // Ekstraktuj tool_calls iz streaming responza
        const partialToolCalls = []; // array of {function:{name,arguments}}
        
        // Forward everything directly, no transformation
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        
        proxyRes.on('data', (chunk) => {
          const chunkStr = chunk.toString('utf8');
          fullResponseRaw += chunkStr;
          res.write(chunk); // Čist passthrough
       
          // Log content (don't transform stream)
          const lines = chunkStr.split('\n').filter(l => l.trim() && !l.startsWith('data: [DONE]'));
          for (const line of lines) {
            try {
              let data = line;
              if (line.startsWith('data: ')) data = line.slice(6);
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.delta?.content || json.choices?.[0]?.delta?.reasoning || json.message?.content || json.message?.reasoning || json.response || '';
              if (content) decodedText += content;
              // Tool calls u stream-u
              const dToolCalls = json.choices?.[0]?.delta?.tool_calls || json.message?.tool_calls;
              if (Array.isArray(dToolCalls) && dToolCalls.length > 0) {
                for (const tc of dToolCalls) {
                  const idx = tc.index ?? partialToolCalls.length;
                  while (partialToolCalls.length <= idx) partialToolCalls.push({ function: { name: '', arguments: '' } });
                  if (tc.function?.name) partialToolCalls[idx].function.name = tc.function.name;
                  if (tc.function?.arguments) partialToolCalls[idx].function.arguments += tc.function.arguments;
                }
              }
            } catch (e) { /* ignore parse errors */ }
          }
          // Šalji live update svakih ~2s
          const nowMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
          if (Math.floor(nowMs / 2000) !== Math.floor((nowMs - chunkStr.length) / 2000)) {
            webClients.forEach(socket => {
              socket.emit('live-duration', { id: logEntry.id, durationMs: nowMs });
            });
          }
        });
        
    // Watchdog timer — ako streaming traje duze od 10 min, prekidamo
    const watchdogTimer = setTimeout(() => {
      logEntry.durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      logEntry.error = 'Stream timeout - no response after 10 minutes';
      logEntry.status = 'error';
      logEntry.decodedText = '';
      logEntry.responseBody = 'ERROR: Stream timed out after 10 minutes';
      logEntry.responseSize = 0;
      stopTick();
      addLog(logEntry);
      console.log(`[PROXY] ${req.method} ${req.url} → TIMEOUT (${logEntry.durationMs.toFixed(0)}ms) [STREAM TIMEOUT]`);
      try { proxyRes.destroy(); } catch(e) {}
      try { if (!res.writableEnded) res.end(); } catch(e) {}
    }, STREAM_TIMEOUT_MS);
        
        proxyRes.on('end', () => {
          clearTimeout(watchdogTimer);
          const endTime = process.hrtime.bigint();
          logEntry.durationMs = Number(endTime - startTime) / 1_000_000;
          
          const responseForLog = {
            raw: fullResponseRaw.length > TOOL_OUT_MAX 
              ? fullResponseRaw.slice(0, TOOL_OUT_MAX) + '...(truncated)' 
              : fullResponseRaw,
            decoded: decodedText.length > 3000 
              ? decodedText.slice(0, 3000) + '...(truncated)' 
              : decodedText,
            hasDecoded: decodedText.length > 0
          };
          
          // Finalizuj decoded tool_calls — match id from requestToolCalls by function name
          const finalToolCalls = partialToolCalls
            .filter(tc => tc.function && tc.function.name)
            .map(tc => {
              // Find matching requestToolCall by function name (not by index)
              let matchedId = null;
              const fnName = tc.function.name;
              if (logEntry.requestToolCalls) {
                const match = logEntry.requestToolCalls.find(rtc => rtc.function && rtc.function.name === fnName);
                if (match && match.id) matchedId = match.id;
              }
              return {
                id: matchedId,
                function: {
                  name: fnName,
                  arguments: (() => {
                    try { return JSON.parse(tc.function.arguments); } catch(e) { return tc.function.arguments; }
                  })()
                }
              };
            });
          // Only set toolCallsExec if we actually got tool calls (empty [] overwrites requestToolCalls)
          if (finalToolCalls.length > 0) {
            logEntry.toolCallsExec = finalToolCalls;
          }
          
          logEntry.responseSize = fullResponseRaw.length;
          logEntry.decodedText = decodedText;
          logEntry.responseBody = decodedText.length > 0
            ? decodedText.slice(0, DECODED_MAX)
            : (fullResponseRaw.length > DECODED_MAX ? fullResponseRaw.slice(0, DECODED_MAX) + '...(truncated)' : fullResponseRaw);
          logEntry.status = 'completed';
          stopTick();
          addLog(logEntry);
          console.log(`[PROXY] ${req.method} ${req.url} → ${proxyRes.statusCode} (${logEntry.durationMs.toFixed(0)}ms) [STREAM]`);
          res.end();
        });

        proxyRes.on('error', (err) => {
          clearTimeout(watchdogTimer);
          logEntry.error = err.message;
          logEntry.durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
          logEntry.status = 'error';
          stopTick();
          addLog(logEntry);
          console.log(`[PROXY ERROR] ${req.method} ${req.url} → ${err.message}`);
          if (!res.headersSent) res.writeHead(504);
          res.end();
        });

      } else {
        // === NON-STREAMING ===
        startTick();
        let fullResponse = '';

        proxyRes.on('data', (chunk) => {
          fullResponse += chunk;
        });

        proxyRes.on('end', () => {
          const endTime = process.hrtime.bigint();
          logEntry.durationMs = Number(endTime - startTime) / 1_000_000;

          try {
            let responseStr = fullResponse.toString('utf8');
            
            // Extract decoded text from non-streaming response (OpenAI / Ollama format)
            let decodedText = '';
            try {
              const resp = JSON.parse(responseStr);
              if (resp.message && resp.message.content) {
                decodedText = resp.message.content;
              } else if (resp.message && resp.message.reasoning) {
                decodedText = resp.message.reasoning;
              } else if (resp.choices && resp.choices[0] && resp.choices[0].message) {
                decodedText = resp.choices[0].message.content || resp.choices[0].message.reasoning || '';
              } else if (resp.response) {
                decodedText = resp.response;
              }
              // Extract tool_calls from non-streaming response
              const respTools = resp.message?.tool_calls || resp.choices?.[0]?.message?.tool_calls;
              if (Array.isArray(respTools) && respTools.length > 0) {
                logEntry.toolCallsExec = respTools.map(tc => {
                  // Find matching requestToolCall by function name
                  let matchedId = null;
                  const fnName = tc.function?.name || 'unknown';
                  if (logEntry.requestToolCalls) {
                    const match = logEntry.requestToolCalls.find(rtc => rtc.function && rtc.function.name === fnName);
                    if (match && match.id) matchedId = match.id;
                  }
                  return {
                    id: matchedId,
                    function: {
                      name: fnName,
                      arguments: (() => { try { return JSON.parse(tc.function?.arguments); } catch(e) { return tc.function?.arguments || ''; } })()
                    }
                  };
                });
              }
              if (decodedText) logEntry.decodedText = decodedText;
            } catch (e) { /* JSON parse failed for non-streaming decoded, ignore */ }
            
            logEntry.responseBody = decodedText
              ? decodedText.slice(0, DECODED_MAX)
              : (responseStr.length > DECODED_MAX ? responseStr.slice(0, DECODED_MAX) + '...(truncated)' : responseStr);
          } catch (e) {
            logEntry.responseBody = '(binary response)';
          }

          // Don't transform response, forward as-is
          let responseStr = fullResponse;

          const responseBuffer = Buffer.from(responseStr, 'utf8');
          logEntry.responseSize = responseBuffer.length;
          logEntry.status = 'completed';
          stopTick();
          addLog(logEntry);
          console.log(`[PROXY] ${req.method} ${req.url} → ${proxyRes.statusCode} (${logEntry.durationMs.toFixed(0)}ms)`);

          // Filter conflicting headers before sending to client
          const cleanHeaders = { ...proxyRes.headers };
          delete cleanHeaders['transfer-encoding'];
          delete cleanHeaders['content-length'];
          cleanHeaders['content-length'] = responseBuffer.length;
          res.writeHead(proxyRes.statusCode, cleanHeaders);
          res.end(responseBuffer);
        });
      }
    });

    proxyReq.on('error', (err) => {
      logEntry.error = err.message;
      logEntry.status = 'error';
      stopTick();
      addLog(logEntry);
      console.error(`[PROXY] ERROR: ${err.message}`);

      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    // Timeout protection
    proxyReq.on('timeout', () => {
      const endTime = process.hrtime.bigint();
      logEntry.durationMs = Number(endTime - startTime) / 1_000_000;
      logEntry.error = 'Timeout after 120s';
      logEntry.status = 'error';
      stopTick();
      addLog(logEntry);
      console.error(`[PROXY] TIMEOUT: ${req.method} ${req.url} (${logEntry.durationMs.toFixed(0)}ms)`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.statusCode = 504;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Proxy timeout - Ollama nije odgovorila na vreme' }));
      }
    });

    // Memory leak protection: if client disconnects, destroy proxy request
    res.on('close', () => {
      if (!res.writableEnded) {
        console.log(`[PROXY] Client disconnected: ${req.method} ${req.url} (id: ${requestId})`);
        proxyReq.destroy();
      }
    });

    proxyReq.write(requestBodyBuffer);
    proxyReq.end();
  });
});

// ============================================================
// Graceful shutdown
// ============================================================
function shutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}, closing...`);
  io.close();
  webServer.close(() => console.log('[SHUTDOWN] Web server closed'));
  if (proxyStarted) proxyServer.close(() => console.log('[SHUTDOWN] Proxy closed'));
  setTimeout(() => { console.log('[SHUTDOWN] Forced exit'); process.exit(0); }, 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================
// Startup (with graceful EADDRINUSE / error handling)
// ============================================================

let proxyStarted = false;

function tryListenProxy(host, port, retries, cb) {
  proxyServer.listen(port, host)
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[FATAL] Proxy port ${port} already in use. Cannot start proxy.`);
        console.error(`[FATAL] Kill the old process or use a different port.`);
        console.error(`[FATAL] Dashboard-only mode: web UI at :${WEB_PORT} still works.`);
        proxyStarted = false;
        cb(false);
      } else {
        console.error(`[FATAL] Proxy listen error: ${err.message}`);
        process.exit(1);
      }
    })
    .on('listening', () => {
      proxyStarted = true;
      cb(true);
    });
}

tryListenProxy(PROXY_HOST, PROXY_PORT, 0, (ok) => {
  if (ok) {
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║  🦾 Ollama Flow Visualizer v3.0            ║');
    console.log('╠═══════════════════════════════════════════╣');
    console.log(`║  Proxy:   http://${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`║  Target:  http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
    console.log(`║  Monitor: http://0.0.0.0:${WEB_PORT}`);
    console.log('╚═══════════════════════════════════════════╝');
  } else {
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║  🦾 Ollama Flow Visualizer v3.0            ║');
    console.log('║  ⚠ Proxy OFFLINE (port in use)            ║');
    console.log(`║  Monitor: http://0.0.0.0:${WEB_PORT}`);
    console.log('╚═══════════════════════════════════════════╝');
  }
});

function tryListenWeb(host, port) {
  webServer.listen(port, host)
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[FATAL] Dashboard port ${port} already in use. Cannot start.`);
        process.exit(1);
      } else {
        console.error(`[FATAL] Dashboard listen error: ${err.message}`);
        process.exit(1);
      }
    })
    .on('listening', () => {
      console.log(`[WEB] Dashboard at http://0.0.0.0:${port}`);
    });
}

tryListenWeb('0.0.0.0', WEB_PORT);
