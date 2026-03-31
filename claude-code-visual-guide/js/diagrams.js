/**
 * Claude Code Visual Guide — diagrams.js
 * SVG animation controller for interactive architecture diagrams.
 */

'use strict';

/* ==========================================================================
   DiagramController — Base Class
   ========================================================================== */

class DiagramController {
  /**
   * @param {Object} options
   * @param {number} [options.stepDuration=600]  - ms per auto-step
   * @param {boolean} [options.loop=false]
   */
  constructor(options = {}) {
    /** @type {SVGElement|null} */
    this.svg = null;

    /** @type {Element|null} */
    this.container = null;

    this._steps       = [];
    this._currentStep = -1;
    this._isPlaying   = false;
    this._timer       = null;
    this._labels      = [];

    this.stepDuration = options.stepDuration ?? 600;
    this.loop         = options.loop ?? false;

    /** When true, animatePath/show/hide/showLabel apply state immediately without transitions. */
    this.skipAnimations = false;

    this._listeners = {};
  }

  /* ------------------------------------------------------------------
     Lifecycle
  ------------------------------------------------------------------ */

  /**
   * Attach the controller to an SVG element and its wrapping container.
   * @param {SVGElement|string} svgElementOrSelector
   * @param {Element|string} [containerSelector]
   */
  init(svgElementOrSelector, containerSelector) {
    if (typeof svgElementOrSelector === 'string') {
      this.svg = document.querySelector(svgElementOrSelector);
    } else {
      this.svg = svgElementOrSelector;
    }

    if (!this.svg) {
      console.warn('[DiagramController] SVG element not found.');
      return this;
    }

    if (containerSelector) {
      this.container = typeof containerSelector === 'string'
        ? document.querySelector(containerSelector)
        : containerSelector;
    } else {
      this.container = this.svg.closest('.diagram-container') || this.svg.parentElement;
    }

    this._applyBaseStyles();
    this._emit('init');
    return this;
  }

  /**
   * Register the animation steps for this diagram.
   * Each step is a function (or object with {run, label}) called when that step is reached.
   * @param {Array<Function|{run:Function, label:string}>} steps
   */
  defineSteps(steps) {
    this._steps = steps.map(s => (typeof s === 'function' ? { run: s, label: '' } : s));
    return this;
  }

  /** Clean up the controller: stop playback, remove labels, reset state. */
  destroy() {
    this.pause();
    this._clearLabels();
    this.reset();
    this._listeners = {};
  }

  /* ------------------------------------------------------------------
     Playback Control
  ------------------------------------------------------------------ */

  /** Start auto-playing through steps. */
  play() {
    if (this._isPlaying) return this;
    if (this._steps.length === 0) return this;

    this._isPlaying = true;
    this._emit('play');
    this._scheduleNext();
    return this;
  }

  /** Pause auto-play. */
  pause() {
    if (!this._isPlaying) return this;
    this._isPlaying = false;
    clearTimeout(this._timer);
    this._timer = null;
    this._emit('pause');
    return this;
  }

  /** Toggle between play and pause. */
  togglePlay() {
    return this._isPlaying ? this.pause() : this.play();
  }

  /** Reset to initial state (step -1, all highlights cleared). */
  reset() {
    this.pause();
    this._currentStep = -1;
    this._clearAllHighlights();
    this._clearLabels();
    this._emit('reset');
    return this;
  }

  /** Advance one step forward. */
  stepForward() {
    const next = this._currentStep + 1;
    if (next >= this._steps.length) {
      if (this.loop) {
        this.reset();
        return this.stepForward();
      }
      this._emit('end');
      return this;
    }
    this._runStep(next);
    return this;
  }

  /** Go back one step. */
  stepBack() {
    const prev = this._currentStep - 1;
    if (prev < 0) return this;

    // Reset and replay up to prev synchronously with animations skipped,
    // so async effects (rAF, setTimeout) don't pile up and fire simultaneously.
    const target = prev;
    this.reset();
    this.skipAnimations = true;
    for (let i = 0; i <= target; i++) {
      this._runStep(i);
    }
    this.skipAnimations = false;
    this._currentStep = target;
    return this;
  }

  /** Jump directly to a step index (0-based). */
  goToStep(index) {
    const clamped = Math.max(0, Math.min(index, this._steps.length - 1));
    if (clamped < this._currentStep) {
      this.reset();
      for (let i = 0; i <= clamped; i++) this._runStep(i);
    } else {
      for (let i = this._currentStep + 1; i <= clamped; i++) this._runStep(i);
    }
    return this;
  }

  /* ------------------------------------------------------------------
     Internal step execution
  ------------------------------------------------------------------ */

  _scheduleNext() {
    if (!this._isPlaying) return;
    this._timer = setTimeout(() => {
      this.stepForward();
      if (this._isPlaying && this._currentStep < this._steps.length - 1) {
        this._scheduleNext();
      } else if (this.loop && this._isPlaying) {
        this.reset();
        this._scheduleNext();
      } else {
        this._isPlaying = false;
        this._emit('end');
      }
    }, this.stepDuration);
  }

  _runStep(index) {
    this._currentStep = index;
    const step = this._steps[index];
    if (step && typeof step.run === 'function') {
      step.run(this, index);
    }
    this._emit('step', { step: index, label: step?.label || '' });
  }

  /* ------------------------------------------------------------------
     Highlight / Unhighlight
  ------------------------------------------------------------------ */

  /**
   * Add the 'highlighted' class (and optional colour variant) to an SVG element.
   * @param {string|Element} elementIdOrEl
   * @param {'blue'|'purple'|'cyan'|'green'|'orange'} [color='blue']
   */
  highlight(elementIdOrEl, color = 'blue') {
    const el = this._resolve(elementIdOrEl);
    if (!el) return this;
    el.classList.add('highlighted', `highlighted--${color}`);
    return this;
  }

  /**
   * Remove highlight classes from an element.
   * @param {string|Element} elementIdOrEl
   */
  unhighlight(elementIdOrEl) {
    const el = this._resolve(elementIdOrEl);
    if (!el) return this;
    el.classList.remove('highlighted', ...['blue','purple','cyan','green','orange'].map(c => `highlighted--${c}`));
    return this;
  }

  /**
   * Mark an element as the 'active' (currently executing) node.
   * @param {string|Element} elementIdOrEl
   */
  activate(elementIdOrEl) {
    // Remove previous active
    if (this.svg) {
      this.svg.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
    }
    const el = this._resolve(elementIdOrEl);
    if (el) el.classList.add('active');
    return this;
  }

  /** Remove all highlight/active states from the entire diagram. */
  _clearAllHighlights() {
    if (!this.svg) return;
    this.svg.querySelectorAll('.highlighted, .active, .diagram-path-flow, .diagram-path-draw').forEach(el => {
      el.classList.remove('highlighted', 'active', 'diagram-path-flow', 'diagram-path-draw');
      ['blue','purple','cyan','green','orange'].forEach(c => el.classList.remove(`highlighted--${c}`));
    });
  }

  /* ------------------------------------------------------------------
     Path Animation
  ------------------------------------------------------------------ */

  /**
   * Animate a path element with a drawing effect.
   * @param {string|Element} pathIdOrEl
   * @param {number} [duration=800] - ms
   * @param {'draw'|'flow'|'pulse'} [mode='draw']
   */
  animatePath(pathIdOrEl, duration = 800, mode = 'draw') {
    const el = this._resolve(pathIdOrEl);
    if (!el) return this;

    // Remove previous animation classes
    el.classList.remove('diagram-path-draw', 'diagram-path-flow', 'diagram-path-pulse');

    if (mode === 'draw') {
      const length = el.getTotalLength ? el.getTotalLength() : 500;
      if (this.skipAnimations) {
        // Apply end state immediately
        el.style.strokeDasharray  = length;
        el.style.strokeDashoffset = '0';
        el.style.transition = '';
      } else {
        el.style.strokeDasharray  = length;
        el.style.strokeDashoffset = length;
        el.style.transition = `stroke-dashoffset ${duration}ms ease`;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.style.strokeDashoffset = '0';
          });
        });
      }
    } else if (mode === 'flow') {
      el.classList.add('diagram-path-flow');
      el.style.animationDuration = `${duration}ms`;
    } else if (mode === 'pulse') {
      el.classList.add('diagram-path-pulse');
    }

    return this;
  }

  /**
   * Stop path animation and reset dash styles.
   * @param {string|Element} pathIdOrEl
   */
  stopPathAnimation(pathIdOrEl) {
    const el = this._resolve(pathIdOrEl);
    if (!el) return this;
    el.classList.remove('diagram-path-draw', 'diagram-path-flow', 'diagram-path-pulse');
    el.style.strokeDasharray  = '';
    el.style.strokeDashoffset = '';
    el.style.transition = '';
    return this;
  }

  /* ------------------------------------------------------------------
     Labels
  ------------------------------------------------------------------ */

  /**
   * Show a floating text label inside the SVG at (x, y).
   * @param {string} text
   * @param {number} x - SVG coordinate
   * @param {number} y - SVG coordinate
   * @param {Object} [opts]
   * @param {string} [opts.color='#e6edf3']
   * @param {string} [opts.fontSize='12']
   * @param {string} [opts.id]
   * @returns {SVGTextElement}
   */
  showLabel(text, x, y, opts = {}) {
    if (!this.svg) return null;

    const textEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    textEl.setAttribute('x', x);
    textEl.setAttribute('y', y);
    textEl.setAttribute('fill', opts.color || '#e6edf3');
    textEl.setAttribute('font-size', opts.fontSize || '12');
    textEl.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('dominant-baseline', 'middle');
    textEl.style.opacity = '0';
    textEl.style.transition = 'opacity 200ms ease';
    textEl.textContent = text;

    if (opts.id) textEl.id = opts.id;
    textEl.dataset.diagramLabel = 'true';

    this.svg.appendChild(textEl);
    this._labels.push(textEl);

    if (this.skipAnimations) {
      textEl.style.opacity = '1';
      textEl.style.transition = '';
    } else {
      requestAnimationFrame(() => { textEl.style.opacity = '1'; });
    }
    return textEl;
  }

  /** Remove a specific label by element or id. */
  removeLabel(labelIdOrEl) {
    const el = typeof labelIdOrEl === 'string' ? document.getElementById(labelIdOrEl) : labelIdOrEl;
    if (!el) return this;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
    this._labels = this._labels.filter(l => l !== el);
    return this;
  }

  /** Remove all floating labels. */
  _clearLabels() {
    this._labels.forEach(el => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    });
    this._labels = [];
  }

  /* ------------------------------------------------------------------
     Glow / Filter Effects
  ------------------------------------------------------------------ */

  /**
   * Apply a glow drop-shadow filter to an element.
   * @param {string|Element} elementIdOrEl
   * @param {string} [color='rgba(88,166,255,0.6)']
   * @param {number} [blur=8]
   */
  applyGlow(elementIdOrEl, color = 'rgba(88,166,255,0.6)', blur = 8) {
    const el = this._resolve(elementIdOrEl);
    if (!el) return this;
    el.style.filter = `drop-shadow(0 0 ${blur}px ${color})`;
    return this;
  }

  removeGlow(elementIdOrEl) {
    const el = this._resolve(elementIdOrEl);
    if (!el) return this;
    el.style.filter = '';
    return this;
  }

  /* ------------------------------------------------------------------
     SVG Group / Element Visibility
  ------------------------------------------------------------------ */

  /** Show a hidden SVG element (sets display:block / opacity:1). */
  show(elementIdOrEl, animated = true) {
    const el = this._resolve(elementIdOrEl);
    if (!el) return this;
    if (animated && !this.skipAnimations) {
      el.style.opacity = '0';
      el.style.display = '';
      el.style.transition = 'opacity 250ms ease';
      requestAnimationFrame(() => { el.style.opacity = '1'; });
    } else {
      el.style.display = '';
      el.style.opacity = '1';
      el.style.transition = '';
    }
    return this;
  }

  /** Hide an SVG element. */
  hide(elementIdOrEl, animated = true) {
    const el = this._resolve(elementIdOrEl);
    if (!el) return this;
    if (animated && !this.skipAnimations) {
      el.style.transition = 'opacity 200ms ease';
      el.style.opacity = '0';
      setTimeout(() => { el.style.display = 'none'; }, 200);
    } else {
      el.style.display = 'none';
      el.style.opacity = '0';
      el.style.transition = '';
    }
    return this;
  }

  /* ------------------------------------------------------------------
     Utilities
  ------------------------------------------------------------------ */

  /** Resolve an element by id string or return the element directly. */
  _resolve(elementIdOrEl) {
    if (!elementIdOrEl) return null;
    if (typeof elementIdOrEl === 'string') {
      // Try within the SVG first, then globally
      const inSvg = this.svg ? this.svg.getElementById(elementIdOrEl) : null;
      return inSvg || document.getElementById(elementIdOrEl);
    }
    return elementIdOrEl;
  }

  /** Apply base CSS class to the SVG for styling hooks. */
  _applyBaseStyles() {
    if (!this.svg) return;
    this.svg.classList.add('diagram-svg');

    // Ensure all <path>, <line>, <polyline> get the base class if they're meant to be diagram paths
    this.svg.querySelectorAll('[data-path]').forEach(el => el.classList.add('diagram-path'));
  }

  /* ------------------------------------------------------------------
     Event Emitter (simple)
  ------------------------------------------------------------------ */

  /**
   * Register a listener for a diagram event.
   * @param {'init'|'play'|'pause'|'reset'|'step'|'end'} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  /** Remove a listener. */
  off(event, handler) {
    if (!this._listeners[event]) return this;
    this._listeners[event] = this._listeners[event].filter(h => h !== handler);
    return this;
  }

  _emit(event, detail = {}) {
    const handlers = this._listeners[event] || [];
    handlers.forEach(h => h({ event, controller: this, ...detail }));

    // Also dispatch a DOM custom event from the container
    if (this.container) {
      this.container.dispatchEvent(new CustomEvent(`diagram:${event}`, {
        bubbles: true,
        detail: { controller: this, ...detail },
      }));
    }
  }

  /* ------------------------------------------------------------------
     State Accessors
  ------------------------------------------------------------------ */

  get currentStep() { return this._currentStep; }
  get totalSteps()  { return this._steps.length; }
  get isPlaying()   { return this._isPlaying; }
  get progress()    { return this._steps.length === 0 ? 0 : (this._currentStep + 1) / this._steps.length; }
}

/* ==========================================================================
   ControlBar — Wires diagram controls UI to a DiagramController instance
   ========================================================================== */

class ControlBar {
  /**
   * @param {DiagramController} controller
   * @param {Element|string} barElementOrSelector - .diagram-controls element
   */
  constructor(controller, barElementOrSelector) {
    this.ctrl = controller;
    this.bar  = typeof barElementOrSelector === 'string'
      ? document.querySelector(barElementOrSelector)
      : barElementOrSelector;

    if (!this.bar) return;
    this._bind();
    this._updateButtons();

    controller.on('step', () => this._updateButtons());
    controller.on('reset', () => this._updateButtons());
    controller.on('play', () => this._updateButtons());
    controller.on('pause', () => this._updateButtons());
    controller.on('end', () => this._updateButtons());
  }

  _bind() {
    const get = (sel) => this.bar.querySelector(sel);

    const playBtn     = get('[data-ctrl="play"]');
    const resetBtn    = get('[data-ctrl="reset"]');
    const prevBtn     = get('[data-ctrl="prev"]');
    const nextBtn     = get('[data-ctrl="next"]');
    const stepCounter = get('[data-ctrl="counter"]');

    if (playBtn)  playBtn.addEventListener('click',  () => this.ctrl.togglePlay());
    if (resetBtn) resetBtn.addEventListener('click', () => this.ctrl.reset());
    if (prevBtn)  prevBtn.addEventListener('click',  () => { this.ctrl.pause(); this.ctrl.stepBack(); });
    if (nextBtn)  nextBtn.addEventListener('click',  () => { this.ctrl.pause(); this.ctrl.stepForward(); });

    this._stepCounter = stepCounter;
  }

  _updateButtons() {
    const get = (sel) => this.bar ? this.bar.querySelector(sel) : null;
    const playBtn = get('[data-ctrl="play"]');
    const prevBtn = get('[data-ctrl="prev"]');
    const nextBtn = get('[data-ctrl="next"]');

    if (playBtn) {
      playBtn.setAttribute('aria-label', this.ctrl.isPlaying ? 'Pause' : 'Play');
      playBtn.classList.toggle('active', this.ctrl.isPlaying);
      playBtn.innerHTML = this.ctrl.isPlaying ? _iconPause() : _iconPlay();
    }

    if (prevBtn) prevBtn.disabled = this.ctrl.currentStep <= 0;
    if (nextBtn) nextBtn.disabled = this.ctrl.currentStep >= this.ctrl.totalSteps - 1;

    if (this._stepCounter && this.ctrl.totalSteps > 0) {
      const s = this.ctrl.currentStep;
      this._stepCounter.textContent =
        s < 0 ? `0 / ${this.ctrl.totalSteps}` : `${s + 1} / ${this.ctrl.totalSteps}`;
    }
  }
}

/* ==========================================================================
   Auto-init: wire controls to diagrams found in the DOM
   ========================================================================== */

function initDiagramControlBars() {
  document.querySelectorAll('.diagram-container').forEach(container => {
    const svg  = container.querySelector('svg[data-diagram]');
    const bar  = container.querySelector('.diagram-controls');
    if (!svg) return;

    const ctrl = new DiagramController({
      stepDuration: parseInt(svg.getAttribute('data-step-duration') || '700', 10),
      loop: svg.hasAttribute('data-loop'),
    });

    ctrl.init(svg, container);

    // Attach steps defined inline via a global function named by data-diagram attribute
    const diagramName = svg.getAttribute('data-diagram');
    const setupFn = window[`setupDiagram_${diagramName}`];
    if (typeof setupFn === 'function') setupFn(ctrl);

    if (bar) new ControlBar(ctrl, bar);

    // Store on element for external access
    container._diagramController = ctrl;
    svg._controller = ctrl;
  });
}

/* ==========================================================================
   SVG Icon helpers for control buttons
   ========================================================================== */

function _iconPlay() {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2 2.5l8 3.5-8 3.5V2.5z"/></svg>`;
}

function _iconPause() {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="3" height="8" rx="1"/><rect x="7" y="2" width="3" height="8" rx="1"/></svg>`;
}

/* ==========================================================================
   Init on DOM ready
   ========================================================================== */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDiagramControlBars);
} else {
  initDiagramControlBars();
}

/* ==========================================================================
   Exports
   ========================================================================== */

window.DiagramController = DiagramController;
window.ControlBar = ControlBar;
