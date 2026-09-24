/**
 * Chrome introduced by the workbench redesign: the header status readouts,
 * the service / failing-only filters, keyboard navigation, copy-JSON, and the
 * Manage data dialog.
 *
 * Everything here reads from the same `state` the rest of the app uses, so no
 * new background messages were needed for any of it.
 */
import { api, elements, state } from './state.js';
import { escapeHtml, setHTML, rafThrottle } from './utils.js';
import { applySearch, selectRequest, serviceKey, uatVerdict, vendorBadge, formatBytes } from './requests.js';
import { toast } from './ui.js';
import { getServiceForDomain } from './allowlist.js';

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

const THEME_KEY = 'lo-theme';
const THEME_ORDER = ['system', 'light', 'dark'];

/**
 * Read the stored theme preference.
 * @returns {'system'|'light'|'dark'}
 */
function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_ORDER.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Apply a theme preference to the document and persist it.
 *
 * "system" removes the attribute so the stylesheet's prefers-color-scheme
 * media query takes over.
 * @param {'system'|'light'|'dark'} theme
 */
export function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {}
  const icons = {
    system: elements.themeIconSystem,
    light: elements.themeIconLight,
    dark: elements.themeIconDark
  };
  Object.entries(icons).forEach(([key, el]) => el?.classList.toggle('hidden', key !== theme));
  if (elements.themeToggle) {
    const label = theme === 'system' ? 'Theme: match system' : `Theme: ${theme}`;
    elements.themeToggle.title = label;
    elements.themeToggle.setAttribute('aria-label', label);
  }
}

/* ------------------------------------------------------------------ *
 * Header readouts
 * ------------------------------------------------------------------ */

/**
 * Requests belonging to the session currently on screen.
 * @returns {Array<object>}
 */
function sessionRequests() {
  const sessionId = state.settings?.selectedSessionId;
  return sessionId ? state.requests.filter(r => r.sessionId === sessionId) : state.requests;
}

/** Refresh the capture pill, UAT bar, allowlist count and failing count. */
export const refreshChrome = rafThrottle(() => {
  updateCaptureState();
  updateUatBar();
  updateAllowlistCount();
  updateFailingCount();
});

function updateCaptureState() {
  const dot = elements.captureStateDot;
  const label = elements.captureStateLabel;
  if (!dot || !label) return;
  const session = state.sessions.find(s => s.id === state.settings?.selectedSessionId);
  const capturing = !!session && !session.paused && !state.settings?.capturePaused;
  if (capturing) {
    dot.className = 'h-2 w-2 flex-none rounded-full bg-danger shadow-[0_0_0_3px_#f8514933]';
    label.textContent = 'Recording';
  } else if (session) {
    dot.className = 'h-2 w-2 flex-none rounded-full bg-muted';
    label.textContent = 'Paused';
  } else {
    dot.className = 'h-2 w-2 flex-none rounded-full bg-dim';
    label.textContent = 'Idle';
  }
}

function updateUatBar() {
  if (!elements.uatBarCount) return;
  let passing = 0;
  let failing = 0;
  for (const req of sessionRequests()) {
    for (const result of req.uat?.results || []) {
      if (result.applicable === false) continue;
      if (result.status === 'failed') failing += 1;
      else if (result.status === 'passed') passing += 1;
    }
  }
  const total = passing + failing;
  elements.uatBarCount.textContent = `${passing}/${total}`;
  if (elements.uatBarPass) elements.uatBarPass.style.flex = String(passing);
  if (elements.uatBarFail) elements.uatBarFail.style.flex = String(failing);
  if (elements.uatBarRest) elements.uatBarRest.style.flex = total ? '0' : '1';
}

function updateAllowlistCount() {
  if (!elements.allowlistCount) return;
  const count = (state.settings?.allowlist || []).filter(Boolean).length;
  elements.allowlistCount.textContent = String(count);
}

function updateFailingCount() {
  if (!elements.failingOnlyCount) return;
  const failing = sessionRequests().filter(req => uatVerdict(req) === 'fail').length;
  elements.failingOnlyCount.textContent = String(failing);
  elements.failingOnly?.classList.toggle('border-danger', state.failingOnly);
  elements.failingOnly?.classList.toggle('bg-danger/10', state.failingOnly);
}

/* ------------------------------------------------------------------ *
 * Service filter
 * ------------------------------------------------------------------ */

/**
 * Services present in the current session, with request counts.
 * @returns {Array<{ key: string, label: string, color: string, count: number }>}
 */
function detectedServices() {
  const found = new Map();
  for (const req of sessionRequests()) {
    const key = serviceKey(req);
    const existing = found.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const service = getServiceForDomain(req.domain);
    found.set(key, {
      key,
      label: service?.name || req.domain || 'Unknown',
      color: vendorBadge(req).color,
      count: 1
    });
  }
  return Array.from(found.values()).sort((a, b) => b.count - a.count);
}

function renderServiceFilter() {
  const menu = elements.serviceFilterOptions;
  if (!menu) return;
  const term = (state.serviceFilterSearch || '').trim().toLowerCase();
  const options = detectedServices().filter(o => !term || o.label.toLowerCase().includes(term));
  const selected = new Set(state.serviceFilter || []);

  if (!options.length) {
    setHTML(menu, '<div class="px-3 py-3 text-xs text-muted">No services captured yet.</div>');
  } else {
    setHTML(menu, options.map(option => {
      const on = selected.has(option.key);
      return `
        <button type="button" data-service-key="${escapeHtml(option.key)}"
          class="grid w-full grid-cols-[16px_8px_minmax(0,1fr)_auto] items-center gap-2.5 border-0 bg-transparent px-3 py-1.5 text-left text-sm text-fg hover:bg-raised">
          <span class="checkbox ${on ? 'checkbox-on' : ''}">
            ${on ? '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" class="h-2.5 w-2.5"><path d="M20 6 9 17l-5-5"></path></svg>' : ''}
          </span>
          <span class="h-2 w-2 rounded-full" style="background:${option.color}"></span>
          <span class="truncate">${escapeHtml(option.label)}</span>
          <span class="text-xs text-muted">${option.count}</span>
        </button>
      `;
    }).join(''));
  }

  const count = selected.size;
  if (elements.serviceFilterLabel) {
    elements.serviceFilterLabel.textContent = count ? `${count} service${count === 1 ? '' : 's'}` : 'All services';
  }
  elements.serviceFilterToggle?.classList.toggle('border-accent', count > 0);
}

function openServiceFilter() {
  renderServiceFilter();
  elements.serviceFilterMenu?.classList.remove('hidden');
  elements.serviceFilterBackdrop?.classList.remove('hidden');
  elements.serviceFilterSearch?.focus();
}

function closeServiceFilter() {
  elements.serviceFilterMenu?.classList.add('hidden');
  elements.serviceFilterBackdrop?.classList.add('hidden');
}

/* ------------------------------------------------------------------ *
 * Manage data
 * ------------------------------------------------------------------ */

const STORAGE_BUDGET_BYTES = 10 * 1024 * 1024;

async function renderDataDialog() {
  const counts = new Map();
  for (const req of state.requests) {
    const session = state.sessions.find(s => s.id === req.sessionId);
    const site = session?.site || 'Unknown';
    counts.set(site, (counts.get(site) || 0) + 1);
  }
  const sites = Array.from(new Set([...state.sites, ...counts.keys()])).filter(Boolean).sort();
  setHTML(elements.dataSites, sites.length
    ? sites.map(site => {
      const sessionsForSite = state.sessions.filter(s => s.site === site).length;
      const requestsForSite = counts.get(site) || 0;
      const hasConfig = !!state.uatConfigs?.[site];
      return `
        <div class="row-sep flex items-center gap-2.5 px-3 py-2.5">
          <span class="flex min-w-0 flex-1 flex-col leading-[1.35]">
            <span class="truncate font-medium">${escapeHtml(site)}</span>
            <span class="text-xs text-muted">${sessionsForSite} session${sessionsForSite === 1 ? '' : 's'} · ${requestsForSite} request${requestsForSite === 1 ? '' : 's'} · ${hasConfig ? 'Validation rules' : 'no Validation rules'}</span>
          </span>
        </div>
      `;
    }).join('')
    : '<div class="px-3 py-3 text-xs text-muted">No sites yet.</div>');

  // getBytesInUse is the real figure the browser enforces; fall back to a
  // JSON estimate where it is unavailable (Firefox MV2).
  let used = null;
  try {
    if (api.storage?.local?.getBytesInUse) {
      used = await new Promise(resolve => {
        const result = api.storage.local.getBytesInUse(null, bytes => {
          void api.runtime.lastError;
          resolve(bytes);
        });
        if (result && typeof result.then === 'function') result.then(resolve, () => resolve(null));
      });
    }
  } catch {
    used = null;
  }
  if (used === null || used === undefined) {
    try {
      used = new Blob([JSON.stringify(state.requests)]).size;
    } catch {
      used = 0;
    }
  }
  const pct = Math.min(100, Math.round((used / STORAGE_BUDGET_BYTES) * 100));
  if (elements.dataUsageLabel) {
    elements.dataUsageLabel.replaceChildren();
    const strong = document.createElement('span');
    strong.className = 'font-semibold text-fg';
    strong.textContent = formatBytes(used);
    elements.dataUsageLabel.append(strong, ` of ${formatBytes(STORAGE_BUDGET_BYTES)}`);
  }
  if (elements.dataUsageBar) elements.dataUsageBar.style.width = `${Math.max(pct, used ? 1 : 0)}%`;
  if (elements.dataUsageDetail) {
    elements.dataUsageDetail.textContent = `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'} · ${state.requests.length} captured request${state.requests.length === 1 ? '' : 's'}`;
  }
}

/* ------------------------------------------------------------------ *
 * Keyboard shortcuts
 * ------------------------------------------------------------------ */

/**
 * Move the selection through the visible request list.
 * @param {number} delta
 */
function moveSelection(delta) {
  const list = state.filtered;
  if (!list.length) return;
  const index = list.findIndex(req => req.id === state.selectedId);
  const next = index === -1
    ? (delta > 0 ? 0 : list.length - 1)
    : Math.max(0, Math.min(list.length - 1, index + delta));
  const req = list[next];
  if (!req) return;
  selectRequest(req.id);
  requestAnimationFrame(() => {
    elements.requestList
      ?.querySelector(`button[data-request-id="${CSS.escape(req.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  });
}

/** Copy the selected request's payload as JSON. */
export function copySelectedJson() {
  const req = state.requests.find(item => item.id === state.selectedId);
  if (!req) return;
  let text = '';
  try {
    const payload = req.body?.parsed && typeof req.body.parsed === 'object'
      ? req.body.parsed
      : Object.fromEntries((req.query?.params || []).map(p => [p.key, p.value]));
    text = JSON.stringify(payload, null, 2);
  } catch {
    text = req.body?.raw || req.url || '';
  }
  if (!text) return;
  navigator.clipboard?.writeText(text).then(() => {
    if (elements.copyJsonLabel) {
      elements.copyJsonLabel.textContent = 'Copied';
      setTimeout(() => {
        if (elements.copyJsonLabel) elements.copyJsonLabel.textContent = 'Copy JSON';
      }, 1400);
    }
  }, () => toast('Could not copy to clipboard'));
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

/** Attach every workbench interaction. Called once at startup. */
export function initWorkbench() {
  applyTheme(readTheme());
  elements.themeToggle?.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(readTheme()) + 1) % THEME_ORDER.length];
    applyTheme(next);
  });

  elements.serviceFilterToggle?.addEventListener('click', () => {
    const open = !elements.serviceFilterMenu?.classList.contains('hidden');
    if (open) closeServiceFilter();
    else openServiceFilter();
  });
  elements.serviceFilterBackdrop?.addEventListener('click', closeServiceFilter);
  elements.serviceFilterSearch?.addEventListener('input', event => {
    state.serviceFilterSearch = event.target.value || '';
    renderServiceFilter();
  });
  elements.serviceFilterClear?.addEventListener('click', () => {
    state.serviceFilter = [];
    renderServiceFilter();
    applySearch();
  });
  elements.serviceFilterOptions?.addEventListener('click', event => {
    const button = event.target.closest('button[data-service-key]');
    if (!button) return;
    const key = button.getAttribute('data-service-key');
    const next = new Set(state.serviceFilter || []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    state.serviceFilter = Array.from(next);
    renderServiceFilter();
    applySearch();
  });

  elements.failingOnly?.addEventListener('click', () => {
    state.failingOnly = !state.failingOnly;
    updateFailingCount();
    applySearch();
  });

  elements.copyJson?.addEventListener('click', copySelectedJson);

  elements.captureState?.addEventListener('click', () => {
    const session = state.sessions.find(s => s.id === state.settings?.selectedSessionId);
    if (!session) {
      elements.newSession?.click();
      return;
    }
    api.runtime.sendMessage({ type: 'pauseSession', id: session.id }, () => {
      if (state.settings) state.settings.capturePaused = true;
      session.paused = true;
      refreshChrome();
      toast('Stopped listening');
    });
  });

  elements.openData?.addEventListener('click', () => {
    void renderDataDialog();
    elements.dataDialog?.showModal();
  });
  elements.dataClose?.addEventListener('click', () => elements.dataDialog?.close());
  elements.dataDone?.addEventListener('click', () => elements.dataDialog?.close());

  window.addEventListener('keydown', event => {
    const tag = event.target?.tagName || '';
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || event.target?.isContentEditable;
    const modalOpen = !!document.querySelector('dialog[open]');

    if (event.key === 'Escape') {
      if (!elements.serviceFilterMenu?.classList.contains('hidden')) {
        closeServiceFilter();
        return;
      }
      if (typing) event.target.blur?.();
      return;
    }
    if (typing || modalOpen || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === '/') {
      event.preventDefault();
      elements.search?.focus();
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      elements.failingOnly?.click();
      return;
    }
    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault();
      copySelectedJson();
      return;
    }
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    }
  });
}
