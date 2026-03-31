/**
 * Claude Code Visual Guide — emulator.js
 * Full interactive emulator: state machine, animation engine, scenario runner.
 */

'use strict';

/* ==========================================================================
   State Machine
   ========================================================================== */

const States = {
  IDLE:             'idle',
  BUILDING_REQUEST: 'building_request',
  SENDING:          'sending',
  WAITING_RESPONSE: 'waiting_response',
  STREAMING:        'streaming',
  PROCESSING_TOOL:  'processing_tool',
  LOOP_BACK:        'loop_back',
  DONE:             'done',
};

/* ==========================================================================
   Token Budget Constants
   ========================================================================== */

const TOKEN_BUDGETS = {
  sonnet: { max: 200000, label: 'claude-sonnet-4-5 (200K)' },
  opus:   { max: 200000, label: 'claude-opus-4   (200K)' },
};

// Base tokens for system prompt blocks (always present)
const BASE_TOKENS = {
  systemBlock0: 16,
  systemBlock1: 3500,
};

// Context option token costs
const CONTEXT_TOKENS = {
  superpowers:  1847,  // system-reminder with hooks/env
  skillCatalog: 634,   // skill listing injection
  claudeMd:     820,   // CLAUDE.md contents
  memory:       412,   // memory injections
  mcpServers:   290,   // MCP server list
};

// Tools cost (when loaded)
const TOOLS_TOKENS = 17500;

/* ==========================================================================
   Scenario Data
   ========================================================================== */

const SCENARIOS = {
  question: {
    id: 'question',
    label: 'Ask a question',
    userMessage: 'What is the difference between a skill and a tool in Claude Code?',
    usesTool: false,
    turns: [
      {
        response: [
          { type: 'text', text: 'In Claude Code, tools and skills serve different purposes:\n\n**Tools** are low-level capabilities built directly into the API — things like `Bash`, `Read`, `Edit`, `Glob`, and `Grep`. They are always available, defined via JSON schemas in the API request, and execute synchronously within the current context window.\n\n**Skills** are higher-level, composable sequences of tool calls bundled together. They live in a separate catalog (loaded via context injection) and can be invoked by name. A skill might combine `Glob` + `Read` + `Edit` to accomplish a compound task like "refactor all imports in a project".\n\nThe key distinction: tools are primitives, skills are workflows built from those primitives.' }
        ]
      }
    ]
  },

  bugfix: {
    id: 'bugfix',
    label: 'Fix a bug',
    userMessage: 'Fix the failing test in src/parser.test.js — it seems like the tokenizer is off by one.',
    usesTool: true,
    turns: [
      {
        response: [
          { type: 'text', text: "I'll investigate the failing test. Let me start by reading the test file and the tokenizer implementation." },
          { type: 'tool_use', id: 'tu_01', name: 'Read', input: { file_path: 'src/parser.test.js' } }
        ],
        toolResult: {
          id: 'tu_01',
          content: `// parser.test.js
describe('tokenizer', () => {
  it('should parse identifiers', () => {
    const tokens = tokenize('hello world');
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({ type: 'IDENT', value: 'hello', pos: 0 });
    expect(tokens[1]).toEqual({ type: 'IDENT', value: 'world', pos: 6 }); // FAILS: got pos: 5
  });
});`
        }
      },
      {
        response: [
          { type: 'text', text: "The test expects `pos: 6` for 'world' but gets `pos: 5`. Let me check the tokenizer." },
          { type: 'tool_use', id: 'tu_02', name: 'Read', input: { file_path: 'src/tokenizer.js' } }
        ],
        toolResult: {
          id: 'tu_02',
          content: `// tokenizer.js (excerpt)
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    if (/\\s/.test(src[i])) { i++; continue; } // bug: advances i BEFORE recording pos
    const start = i;
    // ...reads token...
  }
}`
        }
      },
      {
        response: [
          { type: 'text', text: "Found it — the whitespace-skip loop advances `i` without resetting `start`, so the position of the next token is off by the number of spaces consumed. Fixing:" },
          { type: 'tool_use', id: 'tu_03', name: 'Edit', input: {
              file_path: 'src/tokenizer.js',
              old_string: 'if (/\\s/.test(src[i])) { i++; continue; }',
              new_string: 'if (/\\s/.test(src[i])) { i++; continue; } // whitespace correctly skipped before start capture'
            }
          }
        ],
        toolResult: { id: 'tu_03', content: 'File edited successfully.' }
      },
      {
        response: [
          { type: 'text', text: "Actually the fix needs to be in how `start` is captured. Let me apply the correct patch:" },
          { type: 'tool_use', id: 'tu_04', name: 'Bash', input: { command: 'npx jest src/parser.test.js --no-coverage 2>&1 | tail -5', description: 'Run failing test' } }
        ],
        toolResult: {
          id: 'tu_04',
          content: `PASS src/parser.test.js
  tokenizer
    ✓ should parse identifiers (4 ms)

Test Suites: 1 passed, 1 total`
        }
      },
      {
        response: [
          { type: 'text', text: "All tests pass now. The root cause was that `start` was being captured after the whitespace-skip increment rather than before. The position is now correctly recorded as the index of the first character of each token." }
        ]
      }
    ]
  },

  research: {
    id: 'research',
    label: 'Research codebase',
    userMessage: 'Give me an overview of the authentication system in this codebase — how does it work end-to-end?',
    usesTool: true,
    turns: [
      {
        response: [
          { type: 'text', text: "I'll explore the codebase to map out the authentication system. Starting with a broad search." },
          { type: 'tool_use', id: 'tu_r1', name: 'Glob', input: { pattern: '**/auth*/**', path: 'src' } }
        ],
        toolResult: {
          id: 'tu_r1',
          content: `src/auth/index.js
src/auth/middleware.js
src/auth/jwt.js
src/auth/oauth.js
src/auth/session.js
src/auth/__tests__/auth.test.js`
        }
      },
      {
        response: [
          { type: 'text', text: "Good — there's a dedicated auth module. Let me read the entry point and middleware." },
          { type: 'tool_use', id: 'tu_r2', name: 'Read', input: { file_path: 'src/auth/index.js' } }
        ],
        toolResult: {
          id: 'tu_r2',
          content: `// auth/index.js
export { verifyToken } from './jwt.js';
export { oauthCallback } from './oauth.js';
export { sessionMiddleware } from './session.js';
export { requireAuth } from './middleware.js';`
        }
      },
      {
        response: [
          { type: 'text', text: "The auth system exports four main pieces. Let me read the middleware and JWT modules to understand the flow." },
          { type: 'tool_use', id: 'tu_r3', name: 'Bash', input: { command: 'grep -n "requireAuth\\|verifyToken\\|sessionMiddleware" src/**/*.js | head -20', description: 'Find auth usage across codebase' } }
        ],
        toolResult: {
          id: 'tu_r3',
          content: `src/routes/api.js:12: router.use(requireAuth);
src/routes/api.js:45: const user = await verifyToken(req.headers.authorization);
src/server.js:23: app.use(sessionMiddleware);
src/routes/auth.js:67: app.get('/auth/callback', oauthCallback);`
        }
      },
      {
        response: [
          { type: 'text', text: "Here's the authentication system end-to-end:\n\n**Entry point:** `src/server.js` mounts `sessionMiddleware` globally, which sets up session cookies.\n\n**OAuth flow:** `/auth/callback` is handled by `oauthCallback` in `src/auth/oauth.js`. After a successful OAuth exchange, a JWT is issued and stored in the session.\n\n**API protection:** All API routes use `requireAuth` middleware, which calls `verifyToken` to validate the JWT from the `Authorization` header.\n\n**Flow summary:**\n1. User visits OAuth provider → redirected to `/auth/callback`\n2. Server exchanges code for tokens, creates a JWT\n3. JWT stored in session cookie\n4. Subsequent API requests include JWT in header\n5. `requireAuth` validates JWT → request proceeds or returns 401" }
        ]
      }
    ]
  }
};

/* ==========================================================================
   Helpers
   ========================================================================== */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function typewriter(el, text, charsPerFrame = 3, frameMs = 30) {
  el.textContent = '';
  let i = 0;
  while (i < text.length) {
    el.textContent += text.slice(i, i + charsPerFrame);
    i += charsPerFrame;
    await sleep(frameMs);
  }
}

function fadeIn(el, durationMs = 300) {
  el.style.opacity = '0';
  el.style.transform = 'translateY(6px)';
  el.style.transition = `opacity ${durationMs}ms ease, transform ${durationMs}ms ease`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
  });
}

/* ==========================================================================
   Emulator Class
   ========================================================================== */

class Emulator {
  constructor(options = {}) {
    this.leftPanel   = options.leftPanel   || null;
    this.centerPanel = options.centerPanel || null;
    this.rightPanel  = options.rightPanel  || null;
    this.statusBar   = options.statusBar   || null;

    this.state   = States.IDLE;
    this.model   = 'sonnet';
    this.turnCount   = 0;
    this.tokenCount  = 0;
    this.maxTokens   = TOKEN_BUDGETS.sonnet.max;
    this.cacheHit    = false;
    this.running     = false;
    this.stepMode    = false;
    this._stepResolve = null;
    this._aborted    = false;

    this.contextOptions = {
      superpowers:  true,
      skillCatalog: true,
      claudeMd:     false,
      memory:       false,
      mcpServers:   true,
    };

    this.currentScenario = null;
    this.messages = [];
  }

  /* -----------------------------------------------------------------------
     Init
  ----------------------------------------------------------------------- */

  init() {
    this._renderLeft();
    this._renderCenterIdle();
    this._renderRightIdle();
    this._updateStatus();
    this._recalcTokens();
  }

  /* -----------------------------------------------------------------------
     Left Panel Render
  ----------------------------------------------------------------------- */

  _renderLeft() {
    if (!this.leftPanel) return;

    this.leftPanel.innerHTML = `
      <div class="ep-section">
        <div class="ep-section-title">Model</div>
        <div class="ep-model-group">
          <label class="ep-radio ${this.model === 'sonnet' ? 'active' : ''}" data-model="sonnet">
            <input type="radio" name="em-model" value="sonnet" ${this.model === 'sonnet' ? 'checked' : ''}>
            <span class="ep-radio-label">Sonnet 4.5</span>
            <span class="ep-radio-sub">200K ctx</span>
          </label>
          <label class="ep-radio ${this.model === 'opus' ? 'active' : ''}" data-model="opus">
            <input type="radio" name="em-model" value="opus" ${this.model === 'opus' ? 'checked' : ''}>
            <span class="ep-radio-label">Opus 4</span>
            <span class="ep-radio-sub">200K ctx</span>
          </label>
        </div>
      </div>

      <div class="ep-section">
        <div class="ep-section-title">Context Options</div>
        <div class="ep-toggle-list">
          <label class="ep-toggle" data-key="superpowers">
            <input type="checkbox" data-ctx="superpowers" ${this.contextOptions.superpowers ? 'checked' : ''}>
            <span class="ep-toggle-track"><span class="ep-toggle-thumb"></span></span>
            <span class="ep-toggle-info">
              <span class="ep-toggle-name">Superpowers</span>
              <span class="ep-toggle-tokens">+${(CONTEXT_TOKENS.superpowers / 1000).toFixed(1)}K tokens</span>
            </span>
          </label>
          <label class="ep-toggle" data-key="skillCatalog">
            <input type="checkbox" data-ctx="skillCatalog" ${this.contextOptions.skillCatalog ? 'checked' : ''}>
            <span class="ep-toggle-track"><span class="ep-toggle-thumb"></span></span>
            <span class="ep-toggle-info">
              <span class="ep-toggle-name">Skill Catalog</span>
              <span class="ep-toggle-tokens">+${(CONTEXT_TOKENS.skillCatalog / 1000).toFixed(1)}K tokens</span>
            </span>
          </label>
          <label class="ep-toggle" data-key="claudeMd">
            <input type="checkbox" data-ctx="claudeMd" ${this.contextOptions.claudeMd ? 'checked' : ''}>
            <span class="ep-toggle-track"><span class="ep-toggle-thumb"></span></span>
            <span class="ep-toggle-info">
              <span class="ep-toggle-name">CLAUDE.md</span>
              <span class="ep-toggle-tokens">+${(CONTEXT_TOKENS.claudeMd / 1000).toFixed(1)}K tokens</span>
            </span>
          </label>
          <label class="ep-toggle" data-key="memory">
            <input type="checkbox" data-ctx="memory" ${this.contextOptions.memory ? 'checked' : ''}>
            <span class="ep-toggle-track"><span class="ep-toggle-thumb"></span></span>
            <span class="ep-toggle-info">
              <span class="ep-toggle-name">Memory</span>
              <span class="ep-toggle-tokens">+${(CONTEXT_TOKENS.memory / 1000).toFixed(1)}K tokens</span>
            </span>
          </label>
          <label class="ep-toggle" data-key="mcpServers">
            <input type="checkbox" data-ctx="mcpServers" ${this.contextOptions.mcpServers ? 'checked' : ''}>
            <span class="ep-toggle-track"><span class="ep-toggle-thumb"></span></span>
            <span class="ep-toggle-info">
              <span class="ep-toggle-name">MCP Servers</span>
              <span class="ep-toggle-tokens">+${(CONTEXT_TOKENS.mcpServers / 1000).toFixed(1)}K tokens</span>
            </span>
          </label>
        </div>
      </div>

      <div class="ep-section">
        <div class="ep-section-title">Scenarios</div>
        <div class="ep-scenario-btns">
          <button class="ep-scenario-btn ${this.currentScenario?.id === 'question' ? 'active' : ''}" data-scenario="question">
            <span class="ep-scenario-icon">?</span>
            <span class="ep-scenario-text">Ask a question</span>
          </button>
          <button class="ep-scenario-btn ${this.currentScenario?.id === 'bugfix' ? 'active' : ''}" data-scenario="bugfix">
            <span class="ep-scenario-icon">&#128027;</span>
            <span class="ep-scenario-text">Fix a bug</span>
          </button>
          <button class="ep-scenario-btn ${this.currentScenario?.id === 'research' ? 'active' : ''}" data-scenario="research">
            <span class="ep-scenario-icon">&#128270;</span>
            <span class="ep-scenario-text">Research codebase</span>
          </button>
        </div>
      </div>

      <div class="ep-section">
        <div class="ep-section-title">Message</div>
        <textarea id="em-input" class="ep-textarea" placeholder="Type your message or pick a scenario above..." rows="4">${this.currentScenario ? this.currentScenario.userMessage : ''}</textarea>
        <div class="ep-input-actions">
          <button id="em-send" class="ep-btn ep-btn-primary" ${this.running ? 'disabled' : ''}>
            Send
          </button>
          <button id="em-reset" class="ep-btn ep-btn-ghost">
            Reset
          </button>
        </div>
      </div>
    `;

    this._bindLeft();
  }

  _bindLeft() {
    if (!this.leftPanel) return;

    // Model radios
    this.leftPanel.querySelectorAll('input[name="em-model"]').forEach(radio => {
      radio.addEventListener('change', () => {
        this.model = radio.value;
        this.maxTokens = TOKEN_BUDGETS[this.model].max;
        this.leftPanel.querySelectorAll('.ep-radio').forEach(l => l.classList.remove('active'));
        radio.closest('.ep-radio').classList.add('active');
        this._recalcTokens();
        this._updateStatus();
      });
    });

    // Context toggles
    this.leftPanel.querySelectorAll('input[data-ctx]').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.getAttribute('data-ctx');
        this.contextOptions[key] = cb.checked;
        this._recalcTokens();
        this._updateStatus();
        // Update center panel if visible
        if (this.state !== States.IDLE) this._refreshCenterContextLines();
      });
    });

    // Scenario buttons
    this.leftPanel.querySelectorAll('.ep-scenario-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.running) return;
        const key = btn.getAttribute('data-scenario');
        this.currentScenario = SCENARIOS[key];
        const ta = this.leftPanel.querySelector('#em-input');
        if (ta) ta.value = this.currentScenario.userMessage;
        this.leftPanel.querySelectorAll('.ep-scenario-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Send button
    const sendBtn = this.leftPanel.querySelector('#em-send');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        const ta = this.leftPanel.querySelector('#em-input');
        const msg = ta ? ta.value.trim() : '';
        if (!msg || this.running) return;
        this._run(msg);
      });
    }

    // Enter in textarea
    const ta = this.leftPanel.querySelector('#em-input');
    if (ta) {
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const msg = ta.value.trim();
          if (msg && !this.running) this._run(msg);
        }
      });
    }

    // Reset button
    const resetBtn = this.leftPanel.querySelector('#em-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.reset());
    }
  }

  /* -----------------------------------------------------------------------
     Token Calculation
  ----------------------------------------------------------------------- */

  _recalcTokens() {
    let total = BASE_TOKENS.systemBlock0 + BASE_TOKENS.systemBlock1;
    total += TOOLS_TOKENS;
    for (const [key, enabled] of Object.entries(this.contextOptions)) {
      if (enabled) total += CONTEXT_TOKENS[key];
    }
    // Add conversation history estimate
    total += this.turnCount * 800;
    this.tokenCount = total;
    return total;
  }

  /* -----------------------------------------------------------------------
     Status Bar
  ----------------------------------------------------------------------- */

  _updateStatus(stateLabel) {
    if (!this.statusBar) return;
    const tokens  = this.tokenCount;
    const max     = this.maxTokens;
    const pct     = Math.min(100, (tokens / max) * 100);
    const label   = stateLabel || this._stateLabel();

    const barColor = pct > 80 ? 'var(--accent-red)' : pct > 50 ? 'var(--accent-orange)' : 'var(--accent-blue)';

    this.statusBar.innerHTML = `
      <div class="esb-tokens">
        <span class="esb-token-count">${this._formatNum(tokens)}</span>
        <span class="esb-token-sep">/</span>
        <span class="esb-token-max">${this._formatNum(max)}</span>
        <span class="esb-token-label">tokens</span>
        <div class="esb-bar-track">
          <div class="esb-bar-fill" style="width:${pct.toFixed(1)}%; background:${barColor};"></div>
        </div>
      </div>
      <div class="esb-badges">
        <span class="esb-cache ${this.cacheHit ? 'hit' : 'miss'}">${this.cacheHit ? 'CACHE HIT' : 'CACHE MISS'}</span>
        <span class="esb-state">${label}</span>
      </div>
      <div class="esb-controls">
        <button id="em-step-btn" class="ep-btn ep-btn-sm ${this.stepMode ? 'active' : ''}" title="Toggle step mode">
          Step ${this.stepMode ? 'ON' : 'OFF'}
        </button>
        <button id="em-play-btn" class="ep-btn ep-btn-sm ep-btn-primary" ${!this.running || !this.stepMode ? 'disabled' : ''}>
          Next &rsaquo;
        </button>
        <button id="em-reset-sb" class="ep-btn ep-btn-sm ep-btn-ghost">
          Reset
        </button>
      </div>
    `;

    // Bind status bar controls
    const stepBtn = this.statusBar.querySelector('#em-step-btn');
    if (stepBtn) {
      stepBtn.addEventListener('click', () => {
        this.stepMode = !this.stepMode;
        this._updateStatus();
      });
    }
    const playBtn = this.statusBar.querySelector('#em-play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        if (this._stepResolve) {
          const resolve = this._stepResolve;
          this._stepResolve = null;
          resolve();
        }
      });
    }
    const resetSb = this.statusBar.querySelector('#em-reset-sb');
    if (resetSb) resetSb.addEventListener('click', () => this.reset());
  }

  _stateLabel() {
    switch (this.state) {
      case States.IDLE:             return 'Idle — ready';
      case States.BUILDING_REQUEST: return 'Building request...';
      case States.SENDING:          return 'Sending to API...';
      case States.WAITING_RESPONSE: return 'Waiting for response...';
      case States.STREAMING:        return 'Streaming response...';
      case States.PROCESSING_TOOL:  return 'Executing tool...';
      case States.LOOP_BACK:        return 'Looping back...';
      case States.DONE:             return 'Turn complete';
      default:                      return '';
    }
  }

  _formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  /* -----------------------------------------------------------------------
     Step helper
  ----------------------------------------------------------------------- */

  async _maybeStep(label) {
    this._updateStatus(label);
    if (this.stepMode) {
      await new Promise(resolve => {
        this._stepResolve = resolve;
        // Re-render to enable Next button
        this._updateStatus(label);
      });
    }
  }

  /* -----------------------------------------------------------------------
     Center Panel
  ----------------------------------------------------------------------- */

  _renderCenterIdle() {
    if (!this.centerPanel) return;
    this.centerPanel.innerHTML = `
      <div class="ec-idle">
        <div class="ec-idle-icon">&#9654;</div>
        <div class="ec-idle-text">Pick a scenario or type a message to see the full API request build in real time.</div>
      </div>
    `;
  }

  async _animateBuildRequest(userMessage) {
    if (!this.centerPanel) return;
    this.centerPanel.innerHTML = `
      <div class="ec-header">
        <span class="ec-method">POST</span>
        <span class="ec-endpoint">/v1/messages</span>
        <span class="ec-beta-badge">beta</span>
      </div>
      <div class="ec-request-body" id="ec-body"></div>
    `;
    const body = this.centerPanel.querySelector('#ec-body');

    // -- System block
    const sysSection = this._makeSection('system', '');
    body.appendChild(sysSection);
    fadeIn(sysSection);
    await sleep(200);

    const sysContent = sysSection.querySelector('.ec-section-content');

    const block0 = this._makeRequestBlock('Block 0: Identity', '16 tokens', true, '"You are a Claude agent built on Anthropic\'s Claude Agent SDK."');
    sysContent.appendChild(block0);
    fadeIn(block0);
    await sleep(150);

    const block1 = this._makeRequestBlock('Block 1: Instructions', '3,500 tokens', true, '14,000 chars of policy, tone, tool-use rules, environment info...');
    sysContent.appendChild(block1);
    fadeIn(block1);
    await sleep(300);

    // -- Tools block
    const toolsSection = this._makeSection('tools', '');
    body.appendChild(toolsSection);
    fadeIn(toolsSection);
    await sleep(200);

    const toolsContent = toolsSection.querySelector('.ec-section-content');
    const toolsBar = document.createElement('div');
    toolsBar.className = 'ec-tools-bar';
    toolsBar.innerHTML = `
      <div class="ec-tools-row">
        <span class="ec-tool-badge built-in">16 built-in tools</span>
        <span class="ec-tool-badge plugin">15 plugin tools</span>
        <span class="ec-tool-badge mcp">MCP: deferred</span>
      </div>
      <div class="ec-tools-total">Total: ~17,500 tokens</div>
    `;
    toolsContent.appendChild(toolsBar);
    fadeIn(toolsBar);
    await sleep(300);

    // -- Messages block
    const msgsSection = this._makeSection('messages', '');
    body.appendChild(msgsSection);
    fadeIn(msgsSection);
    await sleep(200);

    this._centerMsgsEl = msgsSection.querySelector('.ec-section-content');
    await this._appendUserTurnToCenter(userMessage);
  }

  async _appendUserTurnToCenter(userMessage) {
    if (!this._centerMsgsEl) return;
    const turnEl = document.createElement('div');
    turnEl.className = 'ec-turn';
    turnEl.innerHTML = `<div class="ec-turn-label">turn ${this.turnCount + 1} — <span class="ec-role user">user</span></div>`;
    this._centerMsgsEl.appendChild(turnEl);
    fadeIn(turnEl);
    await sleep(150);

    // Context injection blocks
    if (this.contextOptions.superpowers) {
      const sr1 = this._makeAccordionBlock('system-reminder', `${CONTEXT_TOKENS.superpowers.toLocaleString()} tokens`, 'SessionStart hook, environment block, hooks configuration');
      turnEl.appendChild(sr1);
      fadeIn(sr1);
      await sleep(100);
    }
    if (this.contextOptions.skillCatalog) {
      const sr2 = this._makeAccordionBlock('system-reminder', `${CONTEXT_TOKENS.skillCatalog.toLocaleString()} tokens`, 'Available skill catalog — 42 skills across 8 categories');
      turnEl.appendChild(sr2);
      fadeIn(sr2);
      await sleep(100);
    }
    if (this.contextOptions.claudeMd) {
      const sr3 = this._makeAccordionBlock('system-reminder', `${CONTEXT_TOKENS.claudeMd.toLocaleString()} tokens`, 'CLAUDE.md project configuration and conventions');
      turnEl.appendChild(sr3);
      fadeIn(sr3);
      await sleep(100);
    }
    if (this.contextOptions.memory) {
      const sr4 = this._makeAccordionBlock('system-reminder', `${CONTEXT_TOKENS.memory.toLocaleString()} tokens`, 'Memory injections from previous sessions');
      turnEl.appendChild(sr4);
      fadeIn(sr4);
      await sleep(100);
    }
    if (this.contextOptions.mcpServers) {
      const sr5 = this._makeAccordionBlock('system-reminder', `${CONTEXT_TOKENS.mcpServers.toLocaleString()} tokens`, 'Available MCP servers and deferred tool list');
      turnEl.appendChild(sr5);
      fadeIn(sr5);
      await sleep(100);
    }

    // User message text
    const msgEl = document.createElement('div');
    msgEl.className = 'ec-message-block';
    msgEl.innerHTML = `<span class="ec-block-type">text</span><span class="ec-block-content">${esc(userMessage)}</span>`;
    turnEl.appendChild(msgEl);
    fadeIn(msgEl);
  }

  async _appendAssistantTurnToCenter(responseBlocks) {
    if (!this._centerMsgsEl) return;
    const turnEl = document.createElement('div');
    turnEl.className = 'ec-turn';
    turnEl.innerHTML = `<div class="ec-turn-label">turn ${this.turnCount} — <span class="ec-role assistant">assistant</span></div>`;
    this._centerMsgsEl.appendChild(turnEl);
    fadeIn(turnEl);

    for (const block of responseBlocks) {
      await sleep(80);
      const el = document.createElement('div');
      el.className = 'ec-message-block';
      if (block.type === 'text') {
        el.innerHTML = `<span class="ec-block-type">text</span><span class="ec-block-content muted">${esc(block.text.slice(0, 60))}${block.text.length > 60 ? '...' : ''}</span>`;
      } else if (block.type === 'tool_use') {
        el.innerHTML = `<span class="ec-block-type tool">tool_use</span><span class="ec-block-content"><strong>${esc(block.name)}</strong>(${esc(JSON.stringify(block.input).slice(0, 40))}...)</span>`;
      }
      turnEl.appendChild(el);
      fadeIn(el);
    }
  }

  async _appendToolResultToCenter(toolResult) {
    if (!this._centerMsgsEl) return;
    const turnEl = document.createElement('div');
    turnEl.className = 'ec-turn';
    turnEl.innerHTML = `<div class="ec-turn-label">turn ${this.turnCount} — <span class="ec-role user">user (tool_result)</span></div>`;
    this._centerMsgsEl.appendChild(turnEl);
    fadeIn(turnEl);

    await sleep(80);
    const el = document.createElement('div');
    el.className = 'ec-message-block';
    el.innerHTML = `<span class="ec-block-type result">tool_result</span><span class="ec-block-content muted">${esc(String(toolResult.content).slice(0, 60))}...</span>`;
    turnEl.appendChild(el);
    fadeIn(el);
  }

  _makeSection(key, contentHtml) {
    const el = document.createElement('div');
    el.className = 'ec-section';
    el.dataset.key = key;
    el.innerHTML = `
      <div class="ec-section-key">${key}:</div>
      <div class="ec-section-bracket open">[</div>
      <div class="ec-section-content">${contentHtml}</div>
      <div class="ec-section-bracket close">]</div>
    `;
    return el;
  }

  _makeRequestBlock(label, tokens, cached, preview) {
    const el = document.createElement('div');
    el.className = 'ec-req-block';
    el.innerHTML = `
      <div class="ec-req-block-header">
        <span class="ec-req-block-label">${esc(label)}</span>
        <span class="ec-req-block-tokens">${esc(tokens)}</span>
        ${cached ? '<span class="ec-cache-badge">CACHED</span>' : ''}
      </div>
      <div class="ec-req-block-preview">${esc(preview)}</div>
    `;
    return el;
  }

  _makeAccordionBlock(type, tokens, preview) {
    const id = 'acc-' + Math.random().toString(36).slice(2, 7);
    const el = document.createElement('div');
    el.className = 'ec-accordion';
    el.innerHTML = `
      <button class="ec-accordion-trigger" aria-expanded="false" aria-controls="${id}">
        <span class="ec-accordion-chevron">&#9654;</span>
        <span class="ec-accordion-type">&lt;${esc(type)}&gt;</span>
        <span class="ec-accordion-tokens">${esc(tokens)}</span>
      </button>
      <div class="ec-accordion-body" id="${id}" hidden>
        <div class="ec-accordion-content">${esc(preview)}</div>
      </div>
    `;
    const btn = el.querySelector('.ec-accordion-trigger');
    const body = el.querySelector('.ec-accordion-body');
    const chevron = el.querySelector('.ec-accordion-chevron');
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
      chevron.style.transform = open ? '' : 'rotate(90deg)';
    });
    return el;
  }

  _refreshCenterContextLines() {
    // Called when context toggles change during an active session
    // Minimal: just recalculate tokens and update status
    this._recalcTokens();
    this._updateStatus();
  }

  /* -----------------------------------------------------------------------
     Right Panel
  ----------------------------------------------------------------------- */

  _renderRightIdle() {
    if (!this.rightPanel) return;
    this.rightPanel.innerHTML = `
      <div class="er-idle">
        <div class="er-idle-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </div>
        <div class="er-idle-text">Response stream will appear here</div>
      </div>
    `;
  }

  _initRightStream() {
    if (!this.rightPanel) return;
    this.rightPanel.innerHTML = `
      <div class="er-stream-header">
        <span class="er-stream-label">Response Stream</span>
        <span class="er-stream-indicator" id="er-spinner">
          <span class="er-dot"></span>
          <span class="er-dot"></span>
          <span class="er-dot"></span>
        </span>
      </div>
      <div class="er-stream-body" id="er-body"></div>
    `;
  }

  async _streamTextBlock(text) {
    const body = this.rightPanel && this.rightPanel.querySelector('#er-body');
    if (!body) return;

    const block = document.createElement('div');
    block.className = 'er-text-block';
    const pre = document.createElement('pre');
    block.appendChild(pre);
    body.appendChild(block);
    fadeIn(block);

    // Typewriter
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      pre.textContent += (i === 0 ? '' : ' ') + words[i];
      body.scrollTop = body.scrollHeight;
      await sleep(18 + Math.random() * 12);
    }
  }

  async _streamToolUseBlock(toolName, toolInput) {
    const body = this.rightPanel && this.rightPanel.querySelector('#er-body');
    if (!body) return;

    const block = document.createElement('div');
    block.className = 'er-tool-block';
    block.innerHTML = `
      <div class="er-tool-header">
        <span class="er-tool-icon">&#9881;</span>
        <span class="er-tool-name">${esc(toolName)}</span>
        <span class="er-tool-type">tool_use</span>
      </div>
      <pre class="er-tool-input">${esc(JSON.stringify(toolInput, null, 2))}</pre>
    `;
    body.appendChild(block);
    fadeIn(block);
    body.scrollTop = body.scrollHeight;
    await sleep(200);
  }

  async _streamToolResult(toolResult) {
    const body = this.rightPanel && this.rightPanel.querySelector('#er-body');
    if (!body) return;

    // Divider
    const divider = document.createElement('div');
    divider.className = 'er-divider';
    divider.textContent = 'tool_result';
    body.appendChild(divider);
    fadeIn(divider);
    await sleep(100);

    const block = document.createElement('div');
    block.className = 'er-result-block';
    const pre = document.createElement('pre');
    pre.textContent = toolResult.content;
    block.appendChild(pre);
    body.appendChild(block);
    fadeIn(block);
    body.scrollTop = body.scrollHeight;
    await sleep(200);
  }

  async _streamLoopBack() {
    const body = this.rightPanel && this.rightPanel.querySelector('#er-body');
    if (!body) return;
    const el = document.createElement('div');
    el.className = 'er-loop-badge';
    el.innerHTML = `<span class="er-loop-arrow">&#8635;</span> Sending tool result back to Claude...`;
    body.appendChild(el);
    fadeIn(el);
    body.scrollTop = body.scrollHeight;
    await sleep(600);
  }

  _streamDone() {
    const body = this.rightPanel && this.rightPanel.querySelector('#er-body');
    if (!body) return;
    const el = document.createElement('div');
    el.className = 'er-done-badge';
    el.innerHTML = `<span class="er-done-check">&#10003;</span> Turn complete`;
    body.appendChild(el);
    fadeIn(el);

    // Hide spinner
    const spinner = this.rightPanel.querySelector('#er-spinner');
    if (spinner) spinner.style.display = 'none';

    body.scrollTop = body.scrollHeight;
  }

  /* -----------------------------------------------------------------------
     "Send" animation
  ----------------------------------------------------------------------- */

  async _animateSend() {
    if (!this.centerPanel) return;
    const header = this.centerPanel.querySelector('.ec-header');
    if (!header) return;
    header.classList.add('sending');
    await sleep(500);
    header.classList.remove('sending');
    header.classList.add('sent');
  }

  /* -----------------------------------------------------------------------
     Main Run Loop
  ----------------------------------------------------------------------- */

  async _run(userMessage) {
    if (this.running) return;
    this.running = true;
    this._aborted = false;
    this.messages = [];
    this._centerMsgsEl = null;

    // Disable send button
    const sendBtn = this.leftPanel && this.leftPanel.querySelector('#em-send');
    if (sendBtn) sendBtn.disabled = true;

    try {
      // Pick scenario or generic
      const scenario = this.currentScenario || SCENARIOS.question;

      // ---- PHASE 1: Build Request ----
      this._setState(States.BUILDING_REQUEST);
      await this._maybeStep('Building request...');
      await this._animateBuildRequest(userMessage);
      this._recalcTokens();
      this._updateStatus('Request built');
      await sleep(400);

      // ---- PHASE 2: Send ----
      this._setState(States.SENDING);
      this._initRightStream();
      await this._maybeStep('Sending to API...');
      await this._animateSend();
      this.cacheHit = true; // simulate cache hit after first call
      await sleep(300);

      // ---- PHASE 3+: Turn loop ----
      const turns = scenario.turns;
      for (let t = 0; t < turns.length; t++) {
        if (this._aborted) break;
        const turn = turns[t];
        this.turnCount++;

        // Waiting
        this._setState(States.WAITING_RESPONSE);
        this._updateStatus('Waiting for response...');
        await sleep(this.stepMode ? 200 : 700);

        // Stream response
        this._setState(States.STREAMING);
        await this._maybeStep('Streaming response...');

        for (const block of turn.response) {
          if (this._aborted) break;
          if (block.type === 'text') {
            await this._streamTextBlock(block.text);
          } else if (block.type === 'tool_use') {
            await this._streamToolUseBlock(block.name, block.input);
          }
          await sleep(100);
        }

        // Update center with assistant turn
        await this._appendAssistantTurnToCenter(turn.response);

        // Tool execution
        if (turn.toolResult && !this._aborted) {
          this._setState(States.PROCESSING_TOOL);
          await this._maybeStep('Executing tool...');
          await sleep(this.stepMode ? 100 : 800);
          await this._streamToolResult(turn.toolResult);
          await this._appendToolResultToCenter(turn.toolResult);

          this.turnCount++;
          this._recalcTokens();
          this._updateStatus('Tool executed');
          await sleep(200);

          // Loop back (if more turns remain)
          if (t < turns.length - 1 && !this._aborted) {
            this._setState(States.LOOP_BACK);
            await this._maybeStep('Looping back...');
            await this._streamLoopBack();
            await sleep(this.stepMode ? 100 : 500);

            // Animate another send
            this._setState(States.SENDING);
            this._updateStatus('Sending to API...');
            await this._animateSend();
            await sleep(300);
          }
        }
      }

      // Done
      if (!this._aborted) {
        this._setState(States.DONE);
        this._streamDone();
        this._updateStatus('Turn complete');
      }

    } finally {
      this.running = false;
      const sendBtn2 = this.leftPanel && this.leftPanel.querySelector('#em-send');
      if (sendBtn2) sendBtn2.disabled = false;
      this._updateStatus();
    }
  }

  _setState(s) {
    this.state = s;
    this._updateStatus();
    // Pulse the status bar
    if (this.statusBar) {
      this.statusBar.classList.remove('pulse');
      void this.statusBar.offsetWidth;
      this.statusBar.classList.add('pulse');
    }
  }

  /* -----------------------------------------------------------------------
     Reset
  ----------------------------------------------------------------------- */

  reset() {
    this._aborted = true;
    if (this._stepResolve) {
      const r = this._stepResolve;
      this._stepResolve = null;
      r();
    }
    this.running    = false;
    this.state      = States.IDLE;
    this.turnCount  = 0;
    this.cacheHit   = false;
    this.messages   = [];
    this._centerMsgsEl = null;

    this._recalcTokens();
    this._renderLeft();
    this._renderCenterIdle();
    this._renderRightIdle();
    this._updateStatus();
  }
}

/* ==========================================================================
   Public API
   ========================================================================== */

window.Emulator = Emulator;
window.SCENARIOS = SCENARIOS;
