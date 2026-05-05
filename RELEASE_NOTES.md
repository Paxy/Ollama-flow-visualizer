# Ollama Flow Visualizer

Release notes for project: Ollama Flow Visualizer (https://github.com/Paxy/Ollama-flow-visualizer)

## v1.3
Release date: 2026-05-05
Tag: v1.3

### ⭐ New Features
- **Native Ollama API thinking/reasoning extraction**: Automatically extracts `thinking` tokens from Ollama-native `/api/chat` streaming chunks (field `message.thinking`) and `reasoning_content` from OpenAI-compatible models. Response body now shows only the decoded thinking/reasoning text, never raw JSON metadata.
- **Multimodal support**: The proxy transparently passes through image requests when using Ollama native API (`"input": ["text", "image"]` in model config)

### 🛠️ Bug Fixes
- **Raw JSON in thinking responses**: Fixed issue where streaming models (Gemma 4, Qwen 3.5 with thinking) would display raw JSON chunks in the response body instead of the decoded thinking text. The proxy now correctly extracts all `message.thinking` and `delta.thinking` fields across streaming and non-streaming responses.

### 📝 Documentation
- README updated for Ollama native API configuration (`api: "ollama"`), with production config examples
- Added dual-provider setup example (proxy + direct fallback)

### Stats
- 2 new features, 1 bug fix, 1 doc commit

---

## v1.2
Release date: 2026-04-29
Tag: v1.2

### ⭐ New Features
- **Request summary cards**: Expandable request cards with cleaner display and toggleable tool icons
- **Improved tool call/output matching**: Global ID map, deduplication of duplicate outputs, fallback to requestToolCalls for unmatched cases
- **Latest output placement**: Tool outputs now placed only in the newest request with matching toolCallId (via latestOutputReqById)
- **Chronological decoded text**: All unique decoded texts concatenated chronologically instead of picking the longest one (prevents truncation of multi-part responses)
- **Adaptation to current OpenClaw version**: Compatible with latest OpenClaw API changes

### 🛠️ Bug Fixes
- **Group status accuracy**: Group status now correctly based on newest request in the group (was incorrectly using oldest); error labels show the latest error
- **User-prompt expansion**: Fixed broken prompt expand (removed broken nextElementSibling, dropped redundant nested `<pre>`)
- **Correct ordering**: Groups sorted newest-first (descending), request rows oldest-first (ascending) for clear chronological flow
- **Scroll behavior**: Newest groups now at bottom, ✅ status indicators only show for completed requests, decoded sections auto-scroll to bottom
- **Debug & UI**: Fixed debug logs, corrected tool icons, improved request toggle behavior

### 📝 Documentation
- Added screenshots section to README with live dashboard views
- Updated dashboard screenshots with fresh example data

### 🔧 Chore
- `.gitignore` cleanup: added node_modules and proxy.log

### Stats
- 17 commits since v1.1.0
- 4 new features, 7 bug fixes, 6 chore/doc commits

---

## v1.1.0
Release date: 2026-04
Tag: v1.1.0

### ⭐ New Features
- Tool call deduplication to prevent duplicate tool outputs in the dashboard
- Error source identification: automatically distinguish between Ollama errors (timeout, connection refused, 5xx) and agent errors (interrupted, tool failure)

### 📝 Documentation
- Setup instructions with proxy server configuration examples
- Playwright dependency added and documented
