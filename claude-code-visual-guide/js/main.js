/**
 * Claude Code Visual Guide — main.js
 * Shared JavaScript for all pages.
 */

'use strict';

/* ==========================================================================
   Utility Functions
   ========================================================================== */

/**
 * Format a token count with K/M abbreviation.
 * @param {number} n
 * @returns {string}
 */
function formatTokenCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Debounce a function call.
 * @param {Function} fn
 * @param {number} delay - milliseconds
 * @returns {Function}
 */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Throttle a function to at most once per interval.
 * @param {Function} fn
 * @param {number} interval - milliseconds
 * @returns {Function}
 */
function throttle(fn, interval) {
  let lastTime = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastTime >= interval) {
      lastTime = now;
      fn.apply(this, args);
    }
  };
}

/**
 * Query a single DOM element, scoped to a parent.
 * @param {string} selector
 * @param {Element|Document} [parent=document]
 * @returns {Element|null}
 */
function qs(selector, parent = document) {
  return parent.querySelector(selector);
}

/**
 * Query all DOM elements, returning a real Array.
 * @param {string} selector
 * @param {Element|Document} [parent=document]
 * @returns {Element[]}
 */
function qsa(selector, parent = document) {
  return Array.from(parent.querySelectorAll(selector));
}

/**
 * Clamp a number between min and max.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* ==========================================================================
   Navigation
   ========================================================================== */

function initNavigation() {
  const nav = qs('.nav');
  if (!nav) return;

  // Highlight active page link
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';
  qsa('.nav-link', nav).forEach(link => {
    const href = link.getAttribute('href');
    if (href && (href === currentPath || href.endsWith(currentPath))) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    }
  });

  // Mobile hamburger toggle
  const hamburger = qs('.nav-hamburger', nav);
  const mobileMenu = qs('.nav-mobile-menu');

  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => {
      const isOpen = hamburger.classList.toggle('open');
      mobileMenu.classList.toggle('open', isOpen);
      hamburger.setAttribute('aria-expanded', String(isOpen));
      document.body.style.overflow = isOpen ? 'hidden' : '';
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!mobileMenu.classList.contains('open')) return;
      if (!nav.contains(e.target) && !mobileMenu.contains(e.target)) {
        hamburger.classList.remove('open');
        mobileMenu.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      }
    });

    // Close mobile menu on link click
    qsa('.nav-link', mobileMenu).forEach(link => {
      link.addEventListener('click', () => {
        hamburger.classList.remove('open');
        mobileMenu.classList.remove('open');
        document.body.style.overflow = '';
      });
    });
  }

  // Smooth scroll for anchor links within the page
  document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a[href^="#"]');
    if (!anchor) return;
    const targetId = anchor.getAttribute('href').slice(1);
    const target = document.getElementById(targetId);
    if (target) {
      e.preventDefault();
      const navHeight = nav.offsetHeight;
      const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
      window.scrollTo({ top, behavior: 'smooth' });
      // Update URL without triggering scroll
      try { history.pushState(null, '', '#' + targetId); } catch (_) {}
    }
  });

  // Shrink nav shadow on scroll
  const handleScroll = throttle(() => {
    nav.classList.toggle('nav--scrolled', window.scrollY > 8);
  }, 50);
  window.addEventListener('scroll', handleScroll, { passive: true });
}

/* ==========================================================================
   Dark Mode (System Preference)
   ========================================================================== */

function initDarkMode() {
  // The site is dark by default. This just adds a data attribute for
  // any component that needs to know the OS preference.
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-color-scheme', prefersDark ? 'dark' : 'light');

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    document.documentElement.setAttribute('data-color-scheme', e.matches ? 'dark' : 'light');
  });
}

/* ==========================================================================
   Intersection Observer — Scroll Reveal
   ========================================================================== */

function initScrollReveal() {
  const elements = qsa('.reveal');
  if (!elements.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px',
  });

  elements.forEach(el => observer.observe(el));
}

/* ==========================================================================
   Code Block — Copy to Clipboard
   ========================================================================== */

function initCodeBlocks() {
  qsa('.code-block').forEach(block => {
    // Skip if copy button already exists
    if (qs('.code-block-copy', block)) return;

    const header = qs('.code-block-header', block);
    const pre = qs('pre', block);
    if (!pre) return;

    // Build header if missing
    let copyTarget = header;
    if (!copyTarget) {
      copyTarget = document.createElement('div');
      copyTarget.className = 'code-block-header';
      const langEl = document.createElement('span');
      langEl.className = 'code-block-lang';
      copyTarget.appendChild(langEl);
      block.insertBefore(copyTarget, block.firstChild);
    }

    // Create copy button
    const btn = document.createElement('button');
    btn.className = 'code-block-copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
        <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
      </svg>
      Copy
    `;

    btn.addEventListener('click', async () => {
      const text = pre.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
          </svg>
          Copied!
        `;
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
              <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
            </svg>
            Copy
          `;
        }, 2000);
      } catch (err) {
        console.warn('Copy failed:', err);
      }
    });

    copyTarget.appendChild(btn);
  });
}

/* ==========================================================================
   Collapsible Sections
   ========================================================================== */

function initCollapsibles() {
  qsa('.collapsible').forEach(collapsible => {
    const trigger = qs('.collapsible-trigger', collapsible);
    const body = qs('.collapsible-body', collapsible);
    if (!trigger || !body) return;

    // Set initial ARIA state
    const isOpen = collapsible.classList.contains('open');
    trigger.setAttribute('aria-expanded', String(isOpen));
    body.setAttribute('aria-hidden', String(!isOpen));

    trigger.addEventListener('click', () => {
      const opening = !collapsible.classList.contains('open');
      collapsible.classList.toggle('open', opening);
      trigger.setAttribute('aria-expanded', String(opening));
      body.setAttribute('aria-hidden', String(!opening));

      // Smooth height animation
      if (opening) {
        body.style.display = 'block';
        const height = body.scrollHeight;
        body.style.overflow = 'hidden';
        body.style.maxHeight = '0';
        requestAnimationFrame(() => {
          body.style.transition = 'max-height 300ms ease';
          body.style.maxHeight = height + 'px';
          setTimeout(() => {
            body.style.maxHeight = '';
            body.style.overflow = '';
            body.style.transition = '';
          }, 300);
        });
      } else {
        body.style.overflow = 'hidden';
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(() => {
          body.style.transition = 'max-height 250ms ease';
          body.style.maxHeight = '0';
          setTimeout(() => {
            body.style.display = 'none';
            body.style.maxHeight = '';
            body.style.overflow = '';
            body.style.transition = '';
          }, 250);
        });
      }
    });

    // Keyboard: Enter / Space
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        trigger.click();
      }
    });
  });
}

/* ==========================================================================
   Tab System
   ========================================================================== */

function initTabs() {
  qsa('.tabs').forEach(tabs => {
    const triggers = qsa('.tab-trigger', tabs);
    const panels   = qsa('.tab-content', tabs);

    function activateTab(index) {
      triggers.forEach((t, i) => {
        const active = i === index;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
        t.setAttribute('tabindex', active ? '0' : '-1');
      });
      panels.forEach((p, i) => {
        p.classList.toggle('active', i === index);
        p.setAttribute('aria-hidden', String(i !== index));
      });
    }

    triggers.forEach((trigger, i) => {
      trigger.setAttribute('role', 'tab');
      trigger.setAttribute('tabindex', i === 0 ? '0' : '-1');

      trigger.addEventListener('click', () => activateTab(i));

      trigger.addEventListener('keydown', (e) => {
        let next = i;
        if (e.key === 'ArrowRight') next = (i + 1) % triggers.length;
        else if (e.key === 'ArrowLeft') next = (i - 1 + triggers.length) % triggers.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = triggers.length - 1;
        else return;
        e.preventDefault();
        activateTab(next);
        triggers[next].focus();
      });
    });

    // Ensure first tab is active by default if none is
    if (!qs('.tab-trigger.active', tabs) && triggers.length) {
      activateTab(0);
    }
  });
}

/* ==========================================================================
   Step Navigator
   ========================================================================== */

class StepNavigator {
  /**
   * @param {Element} container - the .step-navigator element
   */
  constructor(container) {
    this.container  = container;
    this.panels     = qsa('.step-panel', container);
    this.indicators = qsa('.step-indicator', container);
    this.counter    = qs('.step-counter', container);
    this.prevBtn    = qs('[data-step-prev]', container);
    this.nextBtn    = qs('[data-step-next]', container);
    this.currentStep = 0;
    this.total       = this.panels.length;

    this._bind();
    this._render();
  }

  _bind() {
    if (this.prevBtn) {
      this.prevBtn.addEventListener('click', () => this.prev());
    }
    if (this.nextBtn) {
      this.nextBtn.addEventListener('click', () => this.next());
    }
    this.indicators.forEach((dot, i) => {
      dot.addEventListener('click', () => this.goTo(i));
    });

    // Keyboard arrow keys when container is focused
    this.container.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.next();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.prev();
      }
    });
  }

  _render() {
    this.panels.forEach((panel, i) => {
      panel.classList.toggle('active', i === this.currentStep);
      panel.setAttribute('aria-hidden', String(i !== this.currentStep));
    });

    this.indicators.forEach((dot, i) => {
      dot.classList.toggle('active', i === this.currentStep);
      dot.classList.toggle('completed', i < this.currentStep);
    });

    if (this.counter) {
      this.counter.textContent = `Step ${this.currentStep + 1} of ${this.total}`;
    }

    if (this.prevBtn) this.prevBtn.disabled = this.currentStep === 0;
    if (this.nextBtn) this.nextBtn.disabled = this.currentStep === this.total - 1;

    // Dispatch event for diagram synchronisation
    this.container.dispatchEvent(new CustomEvent('stepchange', {
      bubbles: true,
      detail: { step: this.currentStep, total: this.total }
    }));
  }

  goTo(index) {
    this.currentStep = clamp(index, 0, this.total - 1);
    this._render();
  }

  next() { this.goTo(this.currentStep + 1); }
  prev() { this.goTo(this.currentStep - 1); }
  reset() { this.goTo(0); }
}

function initStepNavigators() {
  qsa('.step-navigator').forEach(el => {
    el._stepNavigator = new StepNavigator(el);
  });
}

/* ==========================================================================
   Tooltip System (programmatic)
   ========================================================================== */

let activeTooltip = null;

function showTooltip(text, anchorElement, options = {}) {
  hideTooltip();

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.textContent = text;
  tooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  const rect = anchorElement.getBoundingClientRect();
  const { placement = 'top' } = options;
  const gap = 8;

  let top, left;

  // Initial render to measure
  tooltip.style.visibility = 'hidden';
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  tooltip.style.visibility = '';

  switch (placement) {
    case 'bottom':
      top  = rect.bottom + window.scrollY + gap;
      left = rect.left + window.scrollX + rect.width / 2 - tw / 2;
      break;
    case 'left':
      top  = rect.top + window.scrollY + rect.height / 2 - th / 2;
      left = rect.left + window.scrollX - tw - gap;
      break;
    case 'right':
      top  = rect.top + window.scrollY + rect.height / 2 - th / 2;
      left = rect.right + window.scrollX + gap;
      break;
    default: // top
      top  = rect.top + window.scrollY - th - gap;
      left = rect.left + window.scrollX + rect.width / 2 - tw / 2;
  }

  // Keep within viewport
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  top  = Math.max(8, top);

  tooltip.style.position = 'absolute';
  tooltip.style.top  = top + 'px';
  tooltip.style.left = left + 'px';
  tooltip.style.opacity = '0';
  tooltip.style.transition = 'opacity 150ms ease';
  requestAnimationFrame(() => { tooltip.style.opacity = '1'; });

  return tooltip;
}

function hideTooltip() {
  if (activeTooltip) {
    activeTooltip.style.opacity = '0';
    const el = activeTooltip;
    setTimeout(() => el.remove(), 150);
    activeTooltip = null;
  }
}

function initTooltipSystem() {
  // Auto-init elements with [data-tooltip-js] attribute for programmatic control
  document.addEventListener('mouseenter', (e) => {
    if (!e.target || typeof e.target.closest !== 'function') return;
    const el = e.target.closest('[data-tooltip-js]');
    if (!el) return;
    showTooltip(el.getAttribute('data-tooltip-js'), el, {
      placement: el.getAttribute('data-tooltip-placement') || 'top'
    });
  }, true);

  document.addEventListener('mouseleave', (e) => {
    if (!e.target || typeof e.target.closest !== 'function') return;
    if (e.target.closest('[data-tooltip-js]')) hideTooltip();
  }, true);

  document.addEventListener('focusout', (e) => {
    if (!e.target || typeof e.target.closest !== 'function') return;
    if (e.target.closest('[data-tooltip-js]')) hideTooltip();
  }, true);
}

/* ==========================================================================
   Token Count Bars (auto-render from data attributes)
   ========================================================================== */

function initTokenBars() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const fill = entry.target._tokenFill;
        const pct  = entry.target._tokenPct;
        if (fill) fill.style.width = pct + '%';
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  qsa('[data-token-bar]').forEach(el => {
    const value = parseInt(el.getAttribute('data-token-bar'), 10);
    const max   = parseInt(el.getAttribute('data-token-max') || '10000', 10);
    const color = el.getAttribute('data-token-color') || 'blue';
    const pct   = Math.min(100, (value / max) * 100);

    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = `progress-fill progress-fill-${color}`;
    fill.style.width = '0%';
    track.appendChild(fill);
    el.appendChild(track);

    // Store references for the observer and animate when scrolled into view
    el._tokenFill = fill;
    el._tokenPct  = pct;
    observer.observe(el);
  });
}

/* ==========================================================================
   JSON Syntax Highlighting (for pre.json-highlight blocks)
   ========================================================================== */

function initJsonHighlighting() {
  qsa('pre[data-lang="json"]').forEach(pre => {
    const raw = pre.textContent;
    if (window.PrismLite) {
      pre.innerHTML = window.PrismLite.highlightJSON(escapeHtml(raw));
    }
  });
}

/* ==========================================================================
   Badge helper — render tool type badges
   ========================================================================== */

/**
 * Create a colored badge element for a tool category.
 * @param {'builtin'|'plugin'|'mcp'} type
 * @param {string} [label]
 * @returns {HTMLElement}
 */
function createToolBadge(type, label) {
  const badge = document.createElement('span');
  badge.className = `badge badge-${type}`;
  const dot = document.createElement('span');
  dot.className = 'badge-dot';
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(label || type));
  return badge;
}

/* ==========================================================================
   Page Init
   ========================================================================== */

function init() {
  initDarkMode();
  initNavigation();
  initScrollReveal();
  initCodeBlocks();
  initCollapsibles();
  initTabs();
  initStepNavigators();
  initTooltipSystem();
  initTokenBars();
  initJsonHighlighting();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

/* ==========================================================================
   Public API
   ========================================================================== */

window.GuideUtils = {
  formatTokenCount,
  escapeHtml,
  debounce,
  throttle,
  qs,
  qsa,
  clamp,
  showTooltip,
  hideTooltip,
  createToolBadge,
  StepNavigator,
};
