import { elements, state } from './state.js';
import { escapeHtml, formatDuration, formatTime, hashString, toTitleCase, highlightText, setHTML, rafThrottle } from './utils.js';
import { getServiceForDomain, getServiceInitials } from './allowlist.js';
import { bindPayloadActions, highlightJson, renderJson, tryParseFormEncoded, tryParseJsonString } from './payload.js';
import { setActiveTab, toggleSidebar } from './ui.js';
import { renderUatForRequest } from './uat.js';

const searchIndex = new WeakMap();

/**
 * Build (once) the lowercased text a request is searched against.
 *
 * Re-serialising every query and body on every keystroke made search
 * unusable on large sessions. The index is keyed on the request object and
 * on the body it was built from, so a replaced body rebuilds it.
 * @param {object} req
 * @returns {string}
 */
function getSearchText(req) {
  const cached = searchIndex.get(req);
  if (cached && cached.body === req.body) return cached.text;
  let payload = '';
  try {
    payload = `${JSON.stringify(req.query)} ${JSON.stringify(req.body)}`;
  } catch {
    payload = '';
  }
  const text = `${req.domain || ''} ${req.path || ''} ${req.url || ''} ${payload}`.toLowerCase();
  searchIndex.set(req, { body: req.body, text });
  return text;
}

/**
 * Apply search filters and re-render requests list.
 */
export function applySearch() {
  const term = state.search.trim().toLowerCase();
  const sessionId = state.settings?.selectedSessionId;
  const scoped = sessionId ? state.requests.filter(r => r.sessionId === sessionId) : [...state.requests];
  const services = state.serviceFilter || [];
  state.filtered = scoped.filter(req => {
    if (state.failingOnly && uatVerdict(req) !== 'fail') return false;
    if (services.length && !services.includes(serviceKey(req))) return false;
    if (term && !getSearchText(req).includes(term)) return false;
    return true;
  });
  state.filtered.sort((a, b) => (b.timeStamp || 0) - (a.timeStamp || 0));
  scheduleRenderList();
}

/**
 * Overall UAT verdict for a request.
 * @param {object} req
 * @returns {'pass'|'fail'|'none'}
 */
export function uatVerdict(req) {
  const results = req?.uat?.results || [];
  const applicable = results.filter(r => r.applicable !== false);
  if (!applicable.length) return 'none';
  return applicable.some(r => r.status === 'failed') ? 'fail' : 'pass';
}

/**
 * Stable grouping key for the service filter.
 * @param {object} req
 * @returns {string}
 */
export function serviceKey(req) {
  return req.serviceId || req.domain || 'unknown';
}

/**
 * Short vendor badge for a request, derived from the service catalog.
 * @param {object} req
 * @returns {{ code: string, color: string }}
 */
export function vendorBadge(req) {
  const service = getServiceForDomain(req.domain);
  if (service) {
    return {
      code: getServiceInitials(service.name || service.id),
      color: service.brandColor && /^#[0-9a-f]{3,8}$/i.test(service.brandColor) ? service.brandColor : '#8b949e'
    };
  }
  return { code: getServiceInitials(req.domain || ''), color: '#8b949e' };
}

/** Re-render the list at most once per frame. */
export const scheduleRenderList = rafThrottle(() => renderList());

const ICON_PASS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 text-ok" aria-label="Validation passed"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 4.5-5"></path></svg>';
const ICON_FAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4 text-danger" aria-label="Validation failed"><circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg>';
const ICON_NONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3" class="h-4 w-4 text-dim" aria-label="No validation checks"><circle cx="12" cy="12" r="9"></circle></svg>';

/**
 * Status glyph for a request's UAT verdict.
 * @param {object} req
 * @returns {string}
 */
function statusIcon(req) {
  const verdict = uatVerdict(req);
  if (verdict === 'pass') return ICON_PASS;
  if (verdict === 'fail') return ICON_FAIL;
  return ICON_NONE;
}

/**
 * Render request list grouped by page navigation.
 */
export function renderList() {
  const list = elements.requestList;
  if (!list) return;

  if (!state.filtered.length) {
    setHTML(list, '<div class="p-10 text-center text-sm text-muted">No requests match this filter.</div>');
  } else {
    const groups = groupRequestsByPageSessions(state.filtered)
      .sort((a, b) => (b.items[0]?.timeStamp || 0) - (a.items[0]?.timeStamp || 0));
    setHTML(list, groups.map(group => {
      const items = [...group.items].sort((a, b) => (b.timeStamp || 0) - (a.timeStamp || 0));
      const count = items.length;
      const fails = items.filter(req => uatVerdict(req) === 'fail').length;
      const collapsed = !!state.collapsedGroups[group.key];
      const rows = collapsed ? '' : items.map(req => {
        const selected = req.id === state.selectedId;
        const badge = vendorBadge(req);
        const eventLabel = getEventTypeLabel(req) || getAdobeAnalyticsContext(req) || req.path || '/';
        const statusText = req.statusCode ? String(req.statusCode) : 'pending';
        const statusTone = req.statusCode
          ? (req.statusCode < 400 ? 'text-ok' : 'text-danger')
          : 'text-dim';
        return `
          <button type="button" data-request-id="${escapeHtml(req.id)}"
            class="grid w-full grid-cols-[16px_46px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line-soft px-3 py-2 text-left hover:bg-surface ${selected ? 'bg-surface' : ''}"
            ${selected ? 'aria-current="true" style="box-shadow:inset 2px 0 0 #1f6feb"' : ''}>
            <span class="grid place-items-center">${statusIcon(req)}</span>
            <span class="vendor-code" style="border-color:${badge.color};color:${badge.color}">${escapeHtml(badge.code)}</span>
            <span class="flex min-w-0 flex-col leading-[1.35]">
              <span class="truncate font-mono text-[12.5px] font-semibold">${escapeHtml(eventLabel)}</span>
              <span class="truncate text-xs text-muted">${escapeHtml(`${req.domain || ''}${req.path || ''}`)}</span>
            </span>
            <span class="flex flex-col items-end leading-[1.35]">
              <span class="font-mono text-2xs text-muted">${escapeHtml(formatTime(req.timeStamp))}</span>
              <span class="font-mono text-2xs"><span class="text-muted">${escapeHtml(req.method || '')}</span> <span class="${statusTone}">${escapeHtml(statusText)}</span></span>
            </span>
          </button>
        `;
      }).join('');
      return `
        <div>
          <button type="button" data-group-key="${escapeHtml(group.key)}"
            class="sticky top-0 z-[1] flex w-full items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3 flex-none text-muted transition-transform" style="transform:${collapsed ? 'rotate(-90deg)' : 'none'}" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
            <span class="flex-none font-mono text-xs font-semibold">${escapeHtml(group.title)}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-muted">${escapeHtml(group.pageUrl || '')}</span>
            ${fails ? `<span class="pill-fail flex-none">${fails} failing</span>` : ''}
            <span class="flex-none whitespace-nowrap text-xs text-muted">${escapeHtml(group.subtitle)} · ${count} hit${count === 1 ? '' : 's'}</span>
          </button>
          ${rows}
        </div>
      `;
    }).join(''));
  }

  if (elements.requestCount) {
    elements.requestCount.textContent = `${state.filtered.length} request${state.filtered.length === 1 ? '' : 's'}`;
  }
  bindListDelegation(list);
}

let listDelegationBound = false;

/**
 * Attach a single delegated click handler for the whole list.
 *
 * The list is rebuilt constantly; binding one listener per row meant
 * thousands of listeners created and discarded per session.
 * @param {Element} list
 */
function bindListDelegation(list) {
  if (listDelegationBound) return;
  listDelegationBound = true;
  list.addEventListener('click', event => {
    const group = event.target.closest('button[data-group-key]');
    if (group && list.contains(group)) {
      const key = group.getAttribute('data-group-key');
      state.collapsedGroups[key] = !state.collapsedGroups[key];
      scheduleRenderList();
      return;
    }
    const button = event.target.closest('button[data-request-id]');
    if (!button || !list.contains(button)) return;
    const id = button.getAttribute('data-request-id');
    selectRequest(id);
    if (window.innerWidth < 1024) toggleSidebar(false);
  });
}

/**
 * Render key/value rows as a table.
 * @param {Array<{ key: string, value: string }>} params
 * @param {string} [searchTerm='']
 * @returns {string}
 */
export function renderKeyValueTable(params, searchTerm = '') {
  if (!params || !params.length) {
    return '<div class="text-sm text-muted">None</div>';
  }
  const rows = params.map(({ key, value }) => `
    <div class="row-sep grid grid-cols-[minmax(80px,0.7fr)_minmax(120px,1.6fr)] items-start gap-3 px-3 py-1.5 font-mono text-xs hover:bg-surface">
      <span class="[overflow-wrap:anywhere] text-json-key">${highlightText(String(key), searchTerm)}</span>
      <span class="[overflow-wrap:anywhere] text-fg">${highlightText(String(value), searchTerm)}</span>
    </div>
  `).join('');
  return `<div class="panel">${rows}</div>`;
}

/**
 * Select a request and render details.
 * @param {string} id
 */
export function selectRequest(id) {
  state.selectedId = id;
  const req = state.requests.find(item => item.id === id);
  if (!req) return;

  elements.emptyState.classList.add('hidden');
  elements.observingState.classList.add('hidden');
  elements.observingState.classList.remove('flex');
  elements.details.classList.remove('hidden');
  elements.details.classList.add('flex');

  const badge = vendorBadge(req);
  const service = getServiceForDomain(req.domain);
  if (elements.detailTitle) {
    elements.detailTitle.textContent = getEventTypeLabel(req) || getAdobeAnalyticsContext(req) || req.path || '/';
  }
  if (elements.detailDomain) {
    const vendorName = service?.name || req.domain || '';
    elements.detailDomain.textContent = [vendorName, formatTime(req.timeStamp)].filter(Boolean).join(' · ');
  }
  renderUatPill(req);

  const statusText = req.statusCode ? String(req.statusCode) : 'pending';
  const statusTone = req.statusCode
    ? (req.statusCode < 400 ? 'text-ok' : 'text-danger')
    : 'text-dim';
  const size = req.body?.raw ? formatBytes(req.body.raw.length) : '—';
  setHTML(elements.detailMeta, `
    <span class="flex-none border-r border-line bg-surface px-2.5 py-1 font-semibold">${escapeHtml(req.method || '')}</span>
    <span class="flex-none border-r border-line bg-surface px-2.5 py-1 font-semibold ${statusTone}">${escapeHtml(statusText)}</span>
    <span id="detail-url" class="min-w-0 flex-1 truncate px-2.5 py-1 text-fg" title="${escapeHtml(req.url || '')}">${escapeHtml(req.url || '')}</span>
    <span class="flex-none whitespace-nowrap border-l border-line px-2.5 py-1 text-muted">${escapeHtml(formatDuration(req.duration))} · ${escapeHtml(size)}</span>
  `);

  const queryParams = req.query?.params || [];
  updateTabCount(elements.tabCountQuery, queryParams.length);
  if (queryParams.length) {
    setHTML(elements.detailQuery, renderKeyValueTable(queryParams, state.querySearch));
    if (elements.queryTools) elements.queryTools.classList.remove('hidden');
    if (elements.querySearch) elements.querySearch.value = state.querySearch;
    scrollFirstMatch(elements.detailQuery);
  } else {
    setHTML(elements.detailQuery, '<div class="text-sm text-muted">None</div>');
    if (elements.queryTools) elements.queryTools.classList.add('hidden');
  }
  if (elements.payloadSearch) elements.payloadSearch.value = state.payloadSearch;

  const payloadNotice = req.body?.truncated
    ? '<div class="mb-3 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">Payload truncated for performance. Showing the first 200,000 characters.</div>'
    : '';

  if (!req.body) {
    setHTML(elements.detailPayload, '<div class="text-sm text-muted">No payload</div>');
    if (elements.payloadTools) elements.payloadTools.classList.add('hidden');
  } else if (req.body.type === 'json' && req.body.parsed) {
    setHTML(elements.detailPayload, `${payloadNotice}${renderJson(req.body.parsed, state.payloadSearch)}`);
    if (elements.payloadTools) elements.payloadTools.classList.remove('hidden');
    if (elements.payloadExpandTools) elements.payloadExpandTools.classList.remove('hidden');
    scrollFirstMatch(elements.detailPayload);
  } else if ((req.body.type === 'form' || req.body.type === 'formData') && req.body.parsed) {
    setHTML(elements.detailPayload, `${payloadNotice}${renderKeyValueTable(req.body.parsed.params || [], state.payloadSearch)}`);
    if (elements.payloadTools) elements.payloadTools.classList.remove('hidden');
    if (elements.payloadExpandTools) elements.payloadExpandTools.classList.add('hidden');
    scrollFirstMatch(elements.detailPayload);
  } else if (req.body.type === 'text' && req.body.raw) {
    const parsed = tryParseJsonString(req.body.raw);
    if (parsed) {
      setHTML(elements.detailPayload, `${payloadNotice}${renderJson(parsed, state.payloadSearch)}`);
      if (elements.payloadTools) elements.payloadTools.classList.remove('hidden');
      if (elements.payloadExpandTools) elements.payloadExpandTools.classList.remove('hidden');
      scrollFirstMatch(elements.detailPayload);
    } else {
      const formParsed = tryParseFormEncoded(req.body.raw);
      if (formParsed) {
        setHTML(elements.detailPayload, `${payloadNotice}${renderKeyValueTable(formParsed.params || [], state.payloadSearch)}`);
        if (elements.payloadTools) elements.payloadTools.classList.remove('hidden');
        if (elements.payloadExpandTools) elements.payloadExpandTools.classList.add('hidden');
        scrollFirstMatch(elements.detailPayload);
      } else {
        setHTML(elements.detailPayload, `${payloadNotice}<pre class="m-0 whitespace-pre-wrap break-all rounded border border-line bg-surface p-3.5 font-mono text-xs text-fg">${escapeHtml(req.body.raw || '')}</pre>`);
        if (elements.payloadTools) elements.payloadTools.classList.add('hidden');
      }
    }
  } else if (!req.body.raw && !req.body.parsed) {
    setHTML(elements.detailPayload, '<div class="text-sm text-muted">Payload unavailable</div>');
    if (elements.payloadTools) elements.payloadTools.classList.add('hidden');
  } else {
    setHTML(elements.detailPayload, `${payloadNotice}<pre class="m-0 whitespace-pre-wrap break-all rounded border border-line bg-surface p-3.5 font-mono text-xs text-fg">${escapeHtml(req.body.raw || '')}</pre>`);
    if (elements.payloadTools) elements.payloadTools.classList.add('hidden');
  }

  const headers = req.requestHeaders || [];
  updateTabCount(elements.tabCountHeaders, headers.length);
  if (headers.length) {
    setHTML(elements.detailHeaders, renderKeyValueTable(headers.map(h => ({ key: h.name, value: h.value || '' }))));
  } else {
    setHTML(elements.detailHeaders, '<div class="text-sm text-muted">No headers captured</div>');
  }

  const rawParts = [
    `URL: ${req.url}`,
    req.query?.raw ? `Query: ${req.query.raw}` : '',
    req.body?.raw ? `Body: ${req.body.raw}` : ''
  ].filter(Boolean).join('\n\n');

  if (req.body?.type === 'json' && req.body?.raw) {
    setHTML(elements.detailRaw, highlightJson(req.body.raw));
  } else {
    elements.detailRaw.textContent = rawParts;
  }

  bindPayloadActions();
  if (state.activeTab) {
    setActiveTab(state.activeTab);
  }
  renderUatForRequest(req);
  // Only the active-row highlight changes; fold it into the next frame.
  scheduleRenderList();
}

/**
 * Show the pass/fail chip beside the request title.
 * @param {object} req
 */
function renderUatPill(req) {
  const pill = elements.uatPill;
  if (!pill) return;
  const results = req.uat?.results || [];
  const applicable = results.filter(r => r.applicable !== false);
  if (!applicable.length) {
    pill.className = 'pill-outline';
    pill.textContent = 'No checks';
    pill.classList.remove('hidden');
    return;
  }
  const failed = applicable.filter(r => r.status === 'failed').length;
  pill.className = failed ? 'pill-solid-fail' : 'pill-solid-pass';
  pill.textContent = failed
    ? `${failed} of ${applicable.length} failing`
    : `${applicable.length} passing`;
  pill.classList.remove('hidden');
}

/**
 * Show a count chip on a tab, hiding it at zero.
 * @param {Element|null} el
 * @param {number} count
 */
function updateTabCount(el, count) {
  if (!el) return;
  el.textContent = String(count);
  el.classList.toggle('hidden', !count);
}

/**
 * Format a byte count for the request meta bar.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Scroll to the first highlighted match within a container.
 * @param {Element} container
 */
function scrollFirstMatch(container) {
  if (!container) return;
  const mark = container.querySelector('mark');
  if (!mark) return;
  requestAnimationFrame(() => {
    mark.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/**
 * Extract parsed JSON from a request payload.
 * @param {object} req
 * @returns {object|null}
 */
export function extractPayloadJson(req) {
  if (!req || !req.body) return null;
  if (req.body.parsed && typeof req.body.parsed === 'object') return req.body.parsed;
  if (typeof req.body.raw === 'string') {
    return tryParseJsonString(req.body.raw);
  }
  return null;
}

/**
 * Derive a human-readable event type label.
 * @param {object} req
 * @returns {string}
 */
export function getEventTypeLabel(req) {
  const payload = extractPayloadJson(req);
  const eventType = payload?.events?.[0]?.xdm?.eventType || payload?.xdm?.eventType;
  if (!eventType) return '';
  const last = eventType.split('.').pop() || eventType;
  return toTitleCase(last);
}

/**
 * Create a request description line.
 * @param {object} req
 * @param {string} eventLabel
 * @returns {string}
 */
export function getRequestDescription(req, eventLabel) {
  const contextLabel = getAdobeAnalyticsContext(req);
  if (contextLabel) {
    return `${req.method} · ${contextLabel}${eventLabel ? ` · ${eventLabel}` : ''}`;
  }
  return `${req.method} · ${req.path}${eventLabel ? ` · ${eventLabel}` : ''}`;
}

/**
 * Extract Adobe Analytics context from request path.
 * @param {object} req
 * @returns {string}
 */
export function getAdobeAnalyticsContext(req) {
  if (!req?.path) return '';
  if (!req.path.startsWith('/b/ss/')) return '';
  const segments = req.path.split('/').filter(Boolean);
  if (segments.length < 3) return '';
  const rsids = segments[2] || '';
  const version = segments[4] || '';
  const rsidLabel = rsids ? `Report Suites: ${rsids.split(',').join(', ')}` : '';
  const versionLabel = version ? `Library: ${version}` : '';
  return [rsidLabel, versionLabel].filter(Boolean).join(' · ');
}

/**
 * Group requests by page navigation ID.
 * @param {Array<object>} requests
 * @returns {Array<object>}
 */
export function groupRequestsByPageSessions(requests) {
  const sorted = [...requests].sort((a, b) => (a.timeStamp || 0) - (b.timeStamp || 0));
  const groups = [];
  let current = null;

  sorted.forEach(req => {
    const pageUrl = req.pageUrl || req.documentUrl || req.initiator || req.url || req.path || '/';
    const navKey = req.navId ? `${pageUrl}::${req.navId}` : pageUrl;
    const newGroup = !current || current.key !== navKey;

    if (newGroup) {
      const displayUrl = pageUrl || req.url || req.path || '/';
      const title = getPathFromUrlSafe(displayUrl);
      const subtitle = formatTime(req.timeStamp);
      current = {
        key: navKey,
        title,
        pageUrl: displayUrl,
        subtitle,
        items: []
      };
      groups.push(current);
    }
    current.items.push(req);
  });
  return groups.reverse();
}

/**
 * Safely get pathname from a URL string.
 * @param {string} url
 * @returns {string}
 */
export function getPathFromUrlSafe(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname || '/';
  } catch {
    return url || '/';
  }
}
