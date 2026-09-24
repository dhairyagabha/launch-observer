/**
 * Format a timestamp for display.
 * @param {number} ts
 * @returns {string}
 */
export function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

/**
 * Format a duration in milliseconds.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number') return '—';
  return `${Math.round(ms)} ms`;
}

/**
 * Escape HTML entities.
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escape RegExp special characters.
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Highlight a term in text with <mark>.
 * @param {string} text
 * @param {string} term
 * @returns {string}
 */
export function highlightText(text, term) {
  if (!term) return escapeHtml(text);
  const safeTerm = escapeRegExp(term);
  if (!safeTerm) return escapeHtml(text);
  const regex = new RegExp(safeTerm, 'gi');
  let lastIndex = 0;
  let result = '';
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    result += escapeHtml(text.slice(lastIndex, index));
    result += `<mark class="bg-amber-100 text-slate-900 rounded px-0.5">${escapeHtml(match[0])}</mark>`;
    lastIndex = index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

/**
 * Coalesce rapid calls into one, run on the next animation frame.
 *
 * Capture bursts fire many list updates per second; the list only needs to
 * reach the screen once per frame.
 * @param {Function} fn
 * @returns {Function}
 */
export function rafThrottle(fn) {
  let scheduled = false;
  return function throttled(...args) {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn.apply(this, args);
    });
  };
}

/**
 * Delay a call until input settles.
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function}
 */
export function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}

/**
 * Create a stable numeric hash for a string.
 * @param {string} value
 * @returns {number}
 */
export function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Convert a string to title case.
 * @param {string} value
 * @returns {string}
 */
export function toTitleCase(value) {
  if (!value) return '';
  const spaced = value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.replace(/\b\w/g, c => c.toUpperCase());
}

const UNSAFE_URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);

/**
 * Strip anything executable from a parsed fragment.
 *
 * DOMParser does not run `<script>`, but inline handlers such as
 * `<img onerror=...>` do fire as soon as the node is adopted into the live
 * document, so they have to come off before that happens.
 * @param {DocumentFragment|Element} root
 */
function sanitizeFragment(root) {
  const elements = root.querySelectorAll('*');
  for (const element of elements) {
    if (element.tagName === 'SCRIPT') {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (UNSAFE_URL_ATTRS.has(name) && /^\s*javascript:/i.test(attr.value)) {
        element.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * Safely set HTML content by parsing into DOM nodes.
 * @param {Element} target
 * @param {string} html
 */
export function setHTML(target, html) {
  if (!target) return;
  const template = document.createElement('template');
  template.innerHTML = html;
  sanitizeFragment(template.content);
  target.replaceChildren(template.content);
}
