# Chat Capsule v1.0

**Move your AI work, not just your chat.**

> Capture the state of your work inside an AI conversation and package it into a portable, verifiable capsule that another AI conversation, account, or platform can continue from.

---

## What it does

Chat Capsule is a Chrome extension that:

1. **Captures** conversation content from ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok, and DeepSeek
2. **Normalizes** it into structured messages with rich content (code, tables, links)
3. **Validates** completeness and quality with a coverage score
4. **Compresses** it intelligently — preserving meaning, not just truncating characters
5. **Verifies** what was preserved so you know exactly what carries over
6. **Inserts** it directly into the next AI conversation

The local engine works without any AI API key. AI enhancement is optional.

---

## Quick start

1. Clone or download the repository
2. Open Chrome → `chrome://extensions` → Enable Developer mode
3. Click "Load unpacked" and select the repo root
4. Navigate to any supported AI conversation
5. Click the Chat Capsule icon

---

## Capsule modes

| Mode | Purpose | Uses AI |
|------|---------|---------|
| Compact | Fast handoff — goal + latest request + open tasks | No |
| Standard | Adds decisions + completed work + latest code | No |
| Extended | Adds recent verbatim conversation | No |
| Smart | Locally compressed, priority-ordered | No |
| AI Smart ✦ | AI-extracted structured state with evidence | Optional |
| Lossless | Everything captured verbatim | No |

---

## AI provider support

AI Smart mode supports any of these providers — **no provider is required for the core extension**:

| Provider | Protocol | Local |
|----------|----------|-------|
| Ollama (default) | OpenAI-compatible | ✅ Yes |
| Google Gemini | Gemini API | No |
| OpenAI | OpenAI-compatible | No |
| Anthropic Claude | Anthropic API | No |
| LiteLLM Gateway | OpenAI-compatible | Optional |
| Custom endpoint | OpenAI-compatible | Optional |

Configure in the **AI tab** of the extension popup. API keys are stored only in `chrome.storage.local` — never in source code.

### Using Gemini API

1. Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey)
2. Open Chat Capsule → AI tab
3. Select "Google Gemini" as provider
4. Paste your API key
5. Click "Test connection"

### Using Ollama (local, no API key)

```bash
# Install Ollama
curl https://ollama.ai/install.sh | sh

# Pull a model
ollama pull llama3.2

# Start (runs on port 11434)
ollama serve
```

Chat Capsule will auto-detect Ollama at `http://localhost:11434/v1`.

---

## Platform support

| Platform | Capture | Insert | Deep Capture |
|----------|---------|--------|--------------|
| ChatGPT | ✅ First-class | ✅ | ✅ |
| Claude | ✅ First-class | ✅ | ✅ |
| Gemini | ✅ First-class | ✅ | ✅ |
| Copilot | ✅ First-class | ✅ | — |
| Perplexity | ✅ First-class | ✅ | — |
| Grok | ✅ Adapter | ✅ | — |
| DeepSeek | ✅ Adapter | ✅ | — |
| Generic | ✅ Best-effort | ✅ | — |

---

## Security

- No API keys in source code
- Keys stored locally in `chrome.storage.local`
- No raw conversation content logged
- Captured content never used as AI instructions (prompt injection defense via XML delimiters)
- AI claims require evidence references validated against the actual transcript
- Export encryption: AES-GCM 256 with PBKDF2-SHA256 (600,000 iterations per OWASP)
- Minimal permissions: only `activeTab`, `scripting`, `storage`, `clipboardWrite`, `sidePanel`
- Optional host permissions for each AI platform

---

## Privacy

**Local core (always):**
- Capture
- Normalization
- Validation
- All non-AI capsule modes
- Import/export
- Encryption

**AI enhancement (optional, with confirmation):**
- AI Smart mode sends selected conversation content to your configured provider
- Local Ollama stays fully on-device
- Cloud providers show a confirmation dialog before sending anything

---

## Development

```bash
npm install          # Install jsdom for tests
npm test             # Run test suite (53 tests)
npm run lint         # Lint source files
npm run validate-manifest  # Validate manifest.json
```

### Project structure

```
chat-capsule/
├── manifest.json              # MV3 manifest
├── lib/
│   ├── capsule.js             # Core capsule engine (pure, testable)
│   └── capture.js             # Capture engine (legacy path)
├── extension/
│   ├── background/service-worker.js
│   ├── popup/popup.html|css|js
│   ├── content/capture-runtime.js   # Injected into AI pages
│   ├── ai/
│   │   ├── provider.js        # OpenAI-compatible abstraction
│   │   ├── prompts.js         # Structured prompts with injection defense
│   │   └── verifier.js        # Evidence validation
│   └── storage/               # IndexedDB + settings
├── tests/
│   ├── run.js                 # Test runner (53 tests)
│   └── fixtures/              # Per-platform HTML fixtures
└── docs/
```

---

## Capsule format (v1.0)

```json
{
  "format": "chat-capsule",
  "schemaVersion": 1,
  "id": "uuid",
  "source": { "platform": "ChatGPT", "conversationId": "...", "title": "...", "url": "..." },
  "capture": { "method": "dom-deep", "capturedAt": "...", "quality": 94 },
  "context": {
    "goal": "...", "currentState": "...", "decisions": [],
    "openTasks": [], "nextAction": "..."
  },
  "artifacts": [],
  "attachments": [],
  "transcript": [],
  "integrity": { "algorithm": "SHA-256", "hash": "..." }
}
```

---

## What Chat Capsule does NOT claim

- It does not "move" the original conversation
- It does not guarantee 100% accuracy
- It does not store your conversations (unless you explicitly save)
- The AI Smart mode does not invent facts — it omits rather than hallucinates

---

## Roadmap

| Version | Focus |
|---------|-------|
| v1.0 | ✅ Stable capture + local engine + AI enhancement |
| v1.1 | Side panel workflow |
| v1.2 | Backend LiteLLM gateway (self-hosted) |
| v1.3 | AI quality benchmark |
