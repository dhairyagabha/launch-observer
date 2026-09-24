import { elements, state } from './state.js';
import { escapeHtml, setHTML } from './utils.js';

/**
 * Toggle the sidebar open/closed.
 * @param {boolean} open
 */
export function toggleSidebar(open) {
  if (!elements.sidebar) return;
  if (open) {
    elements.sidebar.classList.remove('translate-x-[-100%]');
    elements.mobileOverlay?.classList.remove('hidden');
  } else {
    elements.sidebar.classList.add('translate-x-[-100%]');
    elements.mobileOverlay?.classList.add('hidden');
  }
}

/**
 * Activate a detail tab and update UI state.
 * @param {string} tabId
 */
export function setActiveTab(tabId) {
  state.activeTab = tabId;
  if (elements.tabsSelect) elements.tabsSelect.value = tabId;
  elements.tabButtons.forEach(btn => {
    const isActive = btn.getAttribute('data-tab') === tabId;
    // .tab-button styles the active state from aria-current, so the only
    // thing to toggle here is the attribute itself.
    if (isActive) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.removeAttribute('aria-current');
    }
    btn.classList.toggle('text-muted', !isActive);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const isActive = panel.id === `tab-${tabId}`;
    panel.classList.toggle('hidden', !isActive);
    panel.classList.toggle('flex', isActive && panel.dataset.flex === 'true');
  });
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {string} [detail='']
 */
export function toast(message, detail = '') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'pointer-events-auto w-full overflow-hidden rounded-xl border border-line bg-surface shadow-[0_8px_24px_#010409]';
  setHTML(el, `
    <div class="flex items-start gap-3 p-3">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="mt-0.5 h-4 w-4 flex-none text-ok" aria-hidden="true">
        <circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 4.5-5"></path>
      </svg>
      <div class="min-w-0 flex-1">
        <p class="m-0 text-sm font-medium text-fg">${escapeHtml(message)}</p>
        ${detail ? `<p class="mt-0.5 text-xs text-muted">${escapeHtml(detail)}</p>` : ''}
      </div>
      <button type="button" class="btn btn-icon h-6 w-6 flex-none" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" class="h-3.5 w-3.5" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
      </button>
    </div>
  `);
  const closeBtn = el.querySelector('button');
  if (closeBtn) closeBtn.addEventListener('click', () => el.remove());
  stack.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
