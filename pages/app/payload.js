import { elements, state } from './state.js';
import { escapeHtml, highlightText } from './utils.js';
import { toast } from './ui.js';

/**
 * Render JSON value into an expandable tree.
 * @param {any} value
 * @param {string} [searchTerm='']
 * @returns {string}
 */
export function renderJson(value, searchTerm = '') {
  if (value === null || value === undefined) {
    return `<span class="text-dim">null</span>`;
  }
  if (typeof value !== 'object') {
    return `<span class="text-fg">${highlightText(String(value), searchTerm)}</span>`;
  }

  return `
    <div class="panel">
      ${renderJsonTree(value, '', 0, searchTerm)}
    </div>
  `;
}

/**
 * Render JSON nodes recursively as tree HTML.
 * @param {any} value
 * @param {string} [path='']
 * @param {number} [depth=0]
 * @param {string} [searchTerm='']
 * @returns {string}
 */
export function renderJsonTree(value, path = '', depth = 0, searchTerm = '') {
  if (value === null || value === undefined) {
    return `<div class="px-3 py-2 font-mono text-xs text-dim">null</div>`;
  }
  if (typeof value !== 'object') {
    return `<div class="px-3 py-2 font-mono text-xs text-fg">${highlightText(String(value), searchTerm)}</div>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      return `<div class="px-3 py-2 font-mono text-xs text-dim">[]</div>`;
    }
    return value.map((item, idx) => {
      const childPath = `${path}[${idx}]`;
      const { html, matched } = renderNode(item, childPath, depth + 1, searchTerm, `[${idx}]`);
      const open = shouldOpenNode(depth, searchTerm, matched);
      return `
        <details class="row-sep px-2 py-1 text-xs" ${open ? 'open' : ''}>
          <summary class="cursor-pointer font-mono font-semibold text-json-key">[${idx}]</summary>
          <div class="ml-3 mt-1">${html}</div>
        </details>
      `;
    }).join('');
  }

  const entries = Object.entries(value);
  if (!entries.length) {
    return `<div class="px-3 py-2 font-mono text-xs text-dim">{}</div>`;
  }
  return entries.map(([key, val]) => {
    const childPath = path ? `${path}.${key}` : key;
    const { html, matched, inline } = renderNode(val, childPath, depth + 1, searchTerm, key);
    if (inline) {
      return html;
    }
    const open = shouldOpenNode(depth, searchTerm, matched);
    return `
      <details class="row-sep px-2 py-1 text-xs" ${open ? 'open' : ''}>
        <summary class="cursor-pointer font-mono font-semibold text-json-key">${highlightText(key, searchTerm)}</summary>
        <div class="ml-3 mt-1">${html}</div>
      </details>
    `;
  }).join('');
}

/**
 * Render a single node with inline actions.
 * @param {any} value
 * @param {string} path
 * @param {number} depth
 * @param {string} searchTerm
 * @param {string} label
 * @returns {{ html: string, matched: boolean, inline: boolean }}
 */
export function renderNode(value, path, depth, searchTerm, label) {
  const matches = searchTerm ? nodeMatches(value, path, searchTerm) : false;
  if (value === null || value === undefined || typeof value !== 'object') {
    const display = String(value);
    const inline = `
      <div class="row-sep group flex items-center justify-between gap-2 px-2 py-1 font-mono text-xs hover:bg-surface">
        <div class="min-w-0">
          <span class="font-semibold text-json-key">${highlightText(label, searchTerm)}</span>
          <span class="text-dim">: </span>
          <span class="[overflow-wrap:anywhere] text-fg">${highlightText(display, searchTerm)}</span>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-2xs text-muted opacity-0 hover:bg-raised hover:text-fg group-hover:opacity-100 focus-visible:opacity-100" data-copy-value="${escapeHtml(display)}" title="Copy value">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" class="h-3.5 w-3.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
            </svg>
            Copy Value
          </button>
          <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-2xs text-muted opacity-0 hover:bg-raised hover:text-fg group-hover:opacity-100 focus-visible:opacity-100" data-copy-path="${escapeHtml(path)}" title="Copy path">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" class="h-3.5 w-3.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z" />
            </svg>
            Copy Path
          </button>
        </div>
      </div>
    `;
    return { html: inline, matched: matches, inline: true };
  }
  if (Array.isArray(value) && value.length === 0) {
    const inline = `
      <div class="row-sep px-2 py-1 font-mono text-xs">
        <span class="font-semibold text-json-key">${escapeHtml(label)}</span>
        <span class="text-dim">: </span>
        <span class="text-dim">[]</span>
      </div>
    `;
    return { html: inline, matched: matches, inline: true };
  }
  const html = renderJsonTree(value, path, depth, searchTerm);
  return { html, matched: matches, inline: false };
}

/**
 * Check whether a path/value matches a term.
 * @param {any} value
 * @param {string} path
 * @param {string} term
 * @returns {boolean}
 */
export function doesMatch(value, path, term) {
  const lower = term.toLowerCase();
  if (path.toLowerCase().includes(lower)) return true;
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return String(value).toLowerCase().includes(lower);
  return false;
}

/**
 * Recursively check nodes for a match.
 * @param {any} value
 * @param {string} path
 * @param {string} term
 * @returns {boolean}
 */
export function nodeMatches(value, path, term) {
  if (doesMatch(value, path, term)) return true;
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item, idx) => nodeMatches(item, `${path}[${idx}]`, term));
  }
  return Object.entries(value).some(([key, val]) => nodeMatches(val, path ? `${path}.${key}` : key, term));
}

/**
 * Decide whether to open a tree node.
 * @param {number} depth
 * @param {string} searchTerm
 * @param {boolean} matched
 * @returns {boolean}
 */
export function shouldOpenNode(depth, searchTerm, matched) {
  if (searchTerm) return matched;
  if (state.payloadExpand === 'all') return true;
  if (state.payloadExpand === 'none') return false;
  if (state.payloadExpand === 'level2') return depth <= 2;
  return depth <= 1;
}

/**
 * Bind copy actions in payload rendering.
 */
export function bindPayloadActions() {
  const container = elements.detailPayload;
  if (!container) return;
  container.querySelectorAll('[data-copy-path]').forEach(btn => {
    btn.addEventListener('click', () => {
      copyToClipboard(btn.getAttribute('data-copy-path') || '');
      toast('Path copied');
    });
  });
  container.querySelectorAll('[data-copy-value]').forEach(btn => {
    btn.addEventListener('click', () => {
      copyToClipboard(btn.getAttribute('data-copy-value') || '');
      toast('Value copied');
    });
  });
}

/**
 * Copy a string to clipboard if available.
 * @param {string} text
 */
export function copyToClipboard(text) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text);
  }
}

/**
 * Attempt to parse JSON safely from a string.
 * @param {string} value
 * @returns {object|null}
 */
export function tryParseJsonString(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Attempt to parse form-encoded payload.
 * @param {string} text
 * @returns {{ raw: string, params: Array<object> }|null}
 */
export function tryParseFormEncoded(text) {
  if (!text || typeof text !== 'string') return null;
  if (!text.includes('=')) return null;
  const params = text.split('&').filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    const rawKey = idx === -1 ? pair : pair.slice(0, idx);
    const rawValue = idx === -1 ? '' : pair.slice(idx + 1);
    const key = safeDecode(decodePlus(rawKey));
    const value = safeDecode(decodePlus(rawValue));
    return { rawKey, rawValue, key, value };
  });
  return params.length ? { raw: text, params } : null;
}

/**
 * Safely decode URI components without throwing.
 * @param {string} value
 * @returns {string}
 */
export function safeDecode(value) {
  if (value === undefined || value === null) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Replace plus signs with spaces.
 * @param {string} value
 * @returns {string}
 */
export function decodePlus(value) {
  if (value === undefined || value === null) return '';
  return value.replace(/\+/g, ' ');
}

/**
 * Pretty-print JSON with syntax highlighting.
 * @param {string} text
 * @returns {string}
 */
export function highlightJson(text) {
  try {
    const obj = JSON.parse(text);
    const pretty = JSON.stringify(obj, null, 2);
    return syntaxHighlight(pretty);
  } catch {
    return escapeHtml(text);
  }
}

/**
 * Apply token-based syntax highlighting to JSON string.
 * @param {string} json
 * @returns {string}
 */
export function syntaxHighlight(json) {
  const escaped = escapeHtml(json);
  return escaped.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?=\s*:))|("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?/g, match => {
    if (match.startsWith('"') && match.endsWith('"') && match.includes(':') === false) {
      return `<span class="token string">${match}</span>`;
    }
    if (match.startsWith('"') && match.endsWith('"') && match.includes(':')) {
      return `<span class="token key">${match}</span>`;
    }
    if (match === 'true' || match === 'false') {
      return `<span class="token boolean">${match}</span>`;
    }
    if (match === 'null') {
      return `<span class="token null">${match}</span>`;
    }
    return `<span class="token number">${match}</span>`;
  });
}
