import { api, elements, state } from './state.js';
import { escapeHtml, formatTime, setHTML } from './utils.js';
import { applySearch } from './requests.js';
import { toast } from './ui.js';

/**
 * Render the sessions list in the sidebar.
 */
export function renderSessions() {
  const list = elements.sessionList;
  if (!list) return;
  if (elements.sessionCount) {
    elements.sessionCount.textContent = `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'}`;
  }
  if (!state.sessions.length) {
    setHTML(list, '<div class="p-3 text-sm text-muted">No sessions yet.</div>');
    return;
  }
  const selectedId = state.settings?.selectedSessionId;
  const grouped = state.sessions.reduce((acc, session) => {
    const site = session.site || 'Unknown';
    acc[site] = acc[site] || [];
    acc[site].push(session);
    return acc;
  }, {});

  // One pass over the requests instead of a full scan per session row.
  const countsBySession = new Map();
  const failsBySession = new Map();
  for (const request of state.requests) {
    countsBySession.set(request.sessionId, (countsBySession.get(request.sessionId) || 0) + 1);
    const results = (request.uat?.results || []).filter(r => r.applicable !== false);
    if (results.some(r => r.status === 'failed')) {
      failsBySession.set(request.sessionId, (failsBySession.get(request.sessionId) || 0) + 1);
    }
  }

  setHTML(list, Object.entries(grouped).map(([site, siteSessions]) => {
    const sessionRows = siteSessions.map(session => {
      const count = countsBySession.get(session.id) || 0;
      const fails = failsBySession.get(session.id) || 0;
      const isSelected = session.id === selectedId;
      const uatLabel = !session.uatEnabled
        ? 'checks off'
        : (fails ? `${fails} failing` : 'checks ok');
      const uatTone = session.uatEnabled && fails ? 'text-danger' : 'text-muted';
      // The sidebar is bg-inset, and in the light theme --c-inset and
      // --c-surface are the same value, so the old bg-surface selection (and
      // its hover) painted the row the exact colour behind it and vanished.
      // Accent tint plus the rail marks the active row the way the request
      // list does, and both tokens differ from inset in either theme.
      return `
        <div class="group grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 rounded px-2 py-1.5 ${isSelected ? 'bg-accent/20 shadow-[inset_2px_0_0_rgb(var(--c-accent))]' : 'hover:bg-raised-hover'}">
          <button type="button" data-session-id="${escapeHtml(session.id)}" ${isSelected ? 'aria-current="true"' : ''} class="col-start-1 truncate text-left ${isSelected ? 'font-semibold' : ''}">${escapeHtml(session.name || 'Untitled')}</button>
          <span class="col-start-2 row-start-1 flex items-center gap-1">
            <span class="pill">${count}</span>
            <button type="button" data-rename-id="${escapeHtml(session.id)}" class="btn btn-icon h-5 w-5 opacity-0 group-hover:opacity-100" title="Rename session" aria-label="Rename session">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
            </button>
            <button type="button" data-delete-id="${escapeHtml(session.id)}" class="btn btn-icon btn-icon-danger h-5 w-5 opacity-0 group-hover:opacity-100" title="Delete session" aria-label="Delete session">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
            <button type="button" data-pause-id="${escapeHtml(session.id)}" class="btn btn-icon h-5 w-5 ${session.paused ? 'hidden' : 'opacity-0 group-hover:opacity-100'}" title="Stop listening" aria-label="Stop listening">
              <svg viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"></rect><rect x="6" y="4" width="4" height="16" rx="1"></rect></svg>
            </button>
          </span>
          <span class="col-span-2 text-xs text-muted">${escapeHtml(formatTime(session.createdAt))} · <span class="${uatTone}">${escapeHtml(uatLabel)}</span></span>
        </div>
      `;
    }).join('');
    return `
      <div class="flex flex-col gap-0.5">
        <div class="px-2 pb-1 text-xs font-semibold text-muted [text-wrap:pretty]">${escapeHtml(site)}</div>
        ${sessionRows}
      </div>
    `;
  }).join(''));

  bindSessionDelegation(list);
}

let sessionDelegationBound = false;

/**
 * Attach one delegated click handler for the whole session list.
 *
 * The list is rebuilt on every capture batch, so binding per row created and
 * discarded four listeners per session each time.
 * @param {Element} list
 */
function bindSessionDelegation(list) {
  if (sessionDelegationBound) return;
  sessionDelegationBound = true;
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-session-id], button[data-rename-id], button[data-delete-id], button[data-pause-id]');
    if (!button || !list.contains(button)) return;

    const pauseId = button.getAttribute('data-pause-id');
    if (pauseId) {
      event.stopPropagation();
      api.runtime.sendMessage({ type: 'pauseSession', id: pauseId }, () => {
        if (state.settings) {
          state.settings.capturePaused = true;
          state.settings.selectedSessionId = pauseId;
        }
        updateSessionSummary();
        toast('Stopped listening');
      });
      return;
    }

    const deleteId = button.getAttribute('data-delete-id');
    if (deleteId) {
      deleteSession(deleteId);
      return;
    }

    const renameId = button.getAttribute('data-rename-id');
    if (renameId) {
      const session = state.sessions.find(s => s.id === renameId);
      if (!session) return;
      state.sessionMode = 'update';
      state.sessionEditId = renameId;
      openSessionDialog(session);
      return;
    }

    const selectId = button.getAttribute('data-session-id');
    if (selectId) selectSession(selectId);
  });
}

/**
 * Select an existing session.
 * @param {string} id
 */
export function selectSession(id) {
  if (!id) return;
  api.runtime.sendMessage({ type: 'selectSession', id }, () => {
    if (state.settings) state.settings.selectedSessionId = id;
    state.selectedId = null;
    elements.details.classList.add('hidden');
    elements.details.classList.remove('flex');
    elements.observingState.classList.remove('hidden');
    elements.emptyState.classList.add('hidden');
    applySearch();
    renderSessions();
    updateSessionSummary();
  });
}

/**
 * Delete a session and its requests.
 * @param {string} id
 */
export function deleteSession(id) {
  api.runtime.sendMessage({ type: 'deleteSession', id }, () => {
    state.sessions = state.sessions.filter(s => s.id !== id);
    state.requests = state.requests.filter(r => r.sessionId !== id);
    if (state.settings?.selectedSessionId === id) {
      state.settings.selectedSessionId = state.sessions[0]?.id || null;
    }
    state.selectedId = null;
    elements.details.classList.add('hidden');
    elements.details.classList.remove('flex');
    if (state.settings?.selectedSessionId) {
      elements.observingState.classList.remove('hidden');
    } else {
      elements.emptyState.classList.remove('hidden');
    }
    applySearch();
    renderSessions();
    updateSessionSummary();
  });
}

/**
 * Build `<option>` markup for the known sites.
 *
 * Site names are user-entered, so every dropdown that lists them shares this
 * one escaped implementation.
 * @param {Array<string>} [sites]
 * @returns {string}
 */
export function siteOptionsHtml(sites = state.sites) {
  const unique = Array.from(new Set((sites || []).filter(Boolean))).sort();
  const options = unique.map(site => `<option value="${escapeHtml(site)}">${escapeHtml(site)}</option>`).join('');
  return options || '<option value="">Select a site</option>';
}

/**
 * Populate site dropdown options.
 */
export function buildSiteOptions() {
  const select = elements.sessionSiteSelect;
  if (!select) return;
  setHTML(select, siteOptionsHtml());
}

/**
 * Populate lock-tab selector options.
 */
export function populateTabOptions(preferredTabId) {
  if (!elements.sessionLockTab) return;
  api.tabs.query({}, tabs => {
    const filtered = tabs.filter(tab => !isExtensionTab(tab));
    state.tabsCache = filtered;
    const options = filtered.map(tab => ({
      id: String(tab.id),
      label: `${tab.title || tab.url || 'Untitled'}`
    }));
    setHTML(elements.sessionLockTab, options.map(opt => {
      return `<option value="${opt.id}">${escapeHtml(opt.label)}</option>`;
    }).join(''));
    if (preferredTabId !== null && preferredTabId !== undefined) {
      elements.sessionLockTab.value = String(preferredTabId);
    } else if (elements.sessionLockTab.options.length) {
      elements.sessionLockTab.selectedIndex = 0;
    }
  });
}

/**
 * Resolve selected lock-tab ID.
 * @returns {number|null}
 */
export function getSelectedTabId() {
  const value = elements.sessionLockTab?.value;
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Check whether a tab is the extension UI.
 * @param {object} tab
 * @returns {boolean}
 */
export function isExtensionTab(tab) {
  const url = tab.url || '';
  return url.startsWith('chrome-extension://') || url.startsWith('moz-extension://');
}

/**
 * Resolve selected site from dialog inputs.
 * @returns {string}
 */
export function getSelectedSite() {
  const useNew = !elements.sessionSiteInput.classList.contains('hidden') && elements.sessionSiteInput.value.trim();
  const site = useNew ? elements.sessionSiteInput.value.trim() : (elements.sessionSiteSelect.value || '').trim();
  return site;
}

/**
 * Open the session modal for create/rename.
 * @param {object} session
 */
export function openSessionDialog(session) {
  buildSiteOptions();
  populateTabOptions(session?.lockTabId);
  elements.sessionSiteInput.classList.add('hidden');
  elements.sessionSiteError.classList.add('hidden');
  if (elements.sessionTabError) elements.sessionTabError.classList.add('hidden');
  elements.sessionNameInput.value = session?.name || '';
  elements.sessionDialogTitle.textContent = state.sessionMode === 'update' ? 'Update Session' : 'Start Session';
  if (elements.sessionSave) {
    elements.sessionSave.textContent = state.sessionMode === 'update' ? 'Update' : 'Start';
  }

  if (session?.site) {
    const options = Array.from(elements.sessionSiteSelect.options).map(opt => opt.value);
    if (options.includes(session.site)) {
      elements.sessionSiteSelect.value = session.site;
    } else {
      elements.sessionSiteInput.classList.remove('hidden');
      elements.sessionSiteInput.value = session.site;
    }
  }
  if (elements.sessionUatToggle) {
    elements.sessionUatToggle.checked = !!session?.uatEnabled;
  }
  updateUatToggle();
  elements.sessionDialog.showModal();
}

/**
 * Update the session summary line.
 */
export function updateSessionSummary() {
  if (!elements.sessionSummary) return;
  const session = state.sessions.find(s => s.id === state.settings?.selectedSessionId);
  if (!session) {
    elements.sessionSummary.textContent = '';
    return;
  }
  if (state.settings?.capturePaused) {
    elements.sessionSummary.textContent = 'Stopped listening';
    return;
  }
  const tabLabel = getTabLabel(session.lockTabId);
  elements.sessionSummary.textContent = `${session.site} · ${session.name || 'Untitled'} · ${tabLabel}`;
}

/**
 * Get label for the locked tab selection.
 * @param {number|null} lockTabId
 * @returns {string}
 */
export function getTabLabel(lockTabId) {
  if (lockTabId === null || lockTabId === undefined) return 'All tabs';
  const tab = state.tabsCache.find(t => t.id === lockTabId);
  if (tab) return tab.title || tab.url || `Tab ${lockTabId}`;
  return `Tab ${lockTabId}`;
}

/**
 * Update UAT toggle availability and helper text.
 */
export function updateUatToggle() {
  if (!elements.sessionUatToggle || !elements.sessionUatNote) return;
  const site = getSelectedSite();
  const config = site ? state.uatConfigs?.[site] : null;
  if (!config) {
    elements.sessionUatToggle.checked = false;
    elements.sessionUatToggle.disabled = true;
    elements.sessionUatNote.textContent = 'No validation rules for this site. Import rules to enable.';
    return;
  }
  elements.sessionUatToggle.disabled = false;
  const count = Array.isArray(config.assertions) ? config.assertions.length : 0;
  elements.sessionUatNote.textContent = `Uses ${count} assertion${count === 1 ? '' : 's'} for this site.`;
}
