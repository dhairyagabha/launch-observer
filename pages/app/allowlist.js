import { elements, state } from './state.js';
import { escapeHtml, setHTML } from './utils.js';
import { SERVICE_CATALOG, domainMatches, getMappingForDomain, resolveServiceForDomain } from '../../lib/services.js';

export const DEFAULT_SERVICE_IDS = SERVICE_CATALOG.filter(service => service.default).map(service => service.id);
export const DEFAULT_ALLOWLIST = buildAllowlistFromServices(DEFAULT_SERVICE_IDS);

/**
 * Render the popular services list UI.
 * @param {Array<string>} allowlist
 */
export function renderAllowlistServices(allowlist) {
  if (!elements.allowlistServices) return;
  const selectedIds = Array.isArray(state.allowlistSelectedServiceIds) && state.allowlistSelectedServiceIds.length
    ? state.allowlistSelectedServiceIds
    : getSelectedServiceIds(allowlist);
  const selected = new Set(selectedIds);
  const term = (state.allowlistServiceSearch || '').trim().toLowerCase();
  const filtered = term
    ? SERVICE_CATALOG.filter(service => {
      const haystack = [service.name, ...(service.domains || [])].join(' ').toLowerCase();
      return haystack.includes(term);
    })
    : SERVICE_CATALOG;

  updateServiceSummary(selected.size);

  if (!filtered.length) {
    setHTML(elements.allowlistServices, '<div class="p-3 text-sm text-muted">No services found.</div>');
    return;
  }

  setHTML(elements.allowlistServices, `
    <div class="max-h-[320px] overflow-y-auto">
      ${filtered.map(service => {
        const on = selected.has(service.id);
        const code = getServiceInitials(service.name || service.id);
        const valid = /^#[0-9a-f]{3,8}$/i.test(service.brandColor || '');
        const color = valid && !isNearWhite(service.brandColor) ? service.brandColor : '#8b949e';
        const inputId = `service-${service.id}`;
        return `
          <div class="row-sep grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2 hover:bg-surface">
            <span class="vendor-code" style="border-color:${color};color:${color}">${escapeHtml(code)}</span>
            <label for="${inputId}" class="flex min-w-0 cursor-pointer flex-col leading-[1.35]">
              <span class="font-medium">${escapeHtml(service.name)}</span>
              <span class="truncate font-mono text-2xs text-muted">${escapeHtml((service.domains || []).join(', '))}</span>
            </label>
            <span class="relative flex-none">
              <input id="${inputId}" type="checkbox" data-service-id="${escapeHtml(service.id)}" class="peer sr-only" ${on ? 'checked' : ''} />
              <label for="${inputId}" class="switch peer-checked:justify-end peer-checked:border-ok-solid peer-checked:bg-ok-solid peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
                <span class="switch-knob"></span>
              </label>
            </span>
          </div>
        `;
      }).join('')}
    </div>
  `);

  elements.allowlistServices.querySelectorAll('input[data-service-id]').forEach(input => {
    input.addEventListener('change', () => {
      const id = input.getAttribute('data-service-id');
      const next = new Set(state.allowlistSelectedServiceIds || selectedIds);
      if (input.checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      state.allowlistSelectedServiceIds = Array.from(next);
      updateServiceSummary(next.size);
    });
  });
}

/**
 * Update the "N of M enabled" line above the service list.
 * @param {number} count
 */
function updateServiceSummary(count) {
  if (!elements.allowlistServiceSummary) return;
  elements.allowlistServiceSummary.textContent = `${count} of ${SERVICE_CATALOG.length} enabled`;
}

/**
 * Render custom allowlist domain rows.
 * @param {Array<string>} entries
 * @param {Array<object>} mappings
 */
export function renderAllowlistFields(entries, mappings) {
  const list = elements.allowlistFields;
  list.replaceChildren();
  if (!entries.length) {
    list.appendChild(createAllowlistRow('', null));
    return;
  }
  entries.forEach(value => {
    const mapping = getMappingForDomain(value, mappings);
    list.appendChild(createAllowlistRow(value, mapping));
  });
}

/**
 * Create a single allowlist row element.
 * @param {string} [value='']
 * @param {object|null} [mapping=null]
 * @returns {HTMLDivElement}
 */
export function createAllowlistRow(value = '', mapping = null) {
  const row = document.createElement('div');
  row.className = 'flex flex-col';
  row.setAttribute('data-mapping-row', 'true');
  const options = [
    { value: 'none', label: 'No service' },
    ...SERVICE_CATALOG.map(service => ({ value: service.id, label: service.name })),
    { value: 'custom', label: 'Custom service…' }
  ];
  const currentServiceId = mapping?.serviceId || (mapping?.customName ? 'custom' : 'none');
  setHTML(row, `
    <div class="row-sep grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_32px] items-center gap-2 p-2">
      <input data-domain class="input font-mono text-xs" value="${escapeHtml(value)}" placeholder="collect.example.com" />
      <select data-service class="select">
        ${options.map(opt => `<option value="${escapeHtml(opt.value)}" ${opt.value === currentServiceId ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-icon btn-icon-danger" title="Remove" aria-label="Remove domain">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    </div>
    <input data-custom-name class="input mx-2 mb-2 hidden w-[calc(100%-1rem)]" placeholder="Custom service name" value="${escapeHtml(mapping?.customName || '')}" />
  `);
  const removeButton = row.querySelector('button');
  const serviceSelect = row.querySelector('select[data-service]');
  const customInput = row.querySelector('input[data-custom-name]');
  const updateCustomVisibility = () => {
    if (!customInput || !serviceSelect) return;
    if (serviceSelect.value === 'custom') {
      customInput.classList.remove('hidden');
      customInput.focus();
    } else {
      customInput.classList.add('hidden');
      customInput.value = '';
    }
  };
  if (serviceSelect) {
    serviceSelect.addEventListener('change', updateCustomVisibility);
    updateCustomVisibility();
  }
  if (removeButton) removeButton.addEventListener('click', () => {
    row.remove();
  });
  return row;
}

/**
 * Get service IDs matching the allowlist.
 * @param {Array<string>} allowlist
 * @returns {Array<string>}
 */
export function getSelectedServiceIds(allowlist) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  return SERVICE_CATALOG.filter(service => service.domains.some(domain => allowlistHasDomain(list, domain)))
    .map(service => service.id);
}

/**
 * Get custom domain entries not covered by selected services.
 * @param {Array<string>} allowlist
 * @returns {Array<string>}
 */
export function getCustomAllowlistEntries(allowlist) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  const selectedServiceIds = getSelectedServiceIds(list);
  const serviceDomains = buildAllowlistFromServices(selectedServiceIds);
  return list.filter(domain => !isDomainCovered(domain, serviceDomains));
}

/**
 * Build a domain allowlist from selected service IDs.
 * @param {Array<string>} serviceIds
 * @returns {Array<string>}
 */
export function buildAllowlistFromServices(serviceIds) {
  const domains = [];
  serviceIds.forEach(id => {
    const service = SERVICE_CATALOG.find(item => item.id === id);
    if (service) domains.push(...service.domains);
  });
  return dedupeDomains(domains);
}

/**
 * Deduplicate domain list (case-insensitive).
 * @param {Array<string>} domains
 * @returns {Array<string>}
 */
export function dedupeDomains(domains) {
  const seen = new Set();
  return domains
    .map(domain => domain.trim())
    .filter(Boolean)
    .filter(domain => {
      const key = domain.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Determine if allowlist covers a domain.
 * @param {Array<string>} allowlist
 * @param {string} domain
 * @returns {boolean}
 */
export function allowlistHasDomain(allowlist, domain) {
  return allowlist.some(entry => domainMatches(entry, domain));
}

/**
 * Compare domain entries with subdomain support.
 * @param {string} entry
 * @param {string} domain
 * @returns {boolean}
 */
/**
 * Check if a domain is covered by service domains.
 * @param {string} domain
 * @param {Array<string>} serviceDomains
 * @returns {boolean}
 */
export function isDomainCovered(domain, serviceDomains) {
  return serviceDomains.some(serviceDomain => domainMatches(domain, serviceDomain));
}

/**
 * Find the custom mapping for a domain.
 * @param {string} domain
 * @param {Array<object>} mappings
 * @returns {object|null}
 */

/**
 * Resolve a service catalog entry for a domain.
 * @param {string} domain
 * @returns {object|null}
 */
export function getServiceForDomain(domain) {
  return resolveServiceForDomain(domain, state.settings?.serviceMappings || []);
}

/**
 * Accept only a literal hex colour for inline style output.
 * @param {any} value
 * @returns {string}
 */
function safeCssColor(value) {
  if (typeof value !== 'string') return '';
  return /^#[0-9a-f]{3,8}$/i.test(value.trim()) ? value.trim() : '';
}

/**
 * Whether a brand colour is too light to sit behind white text.
 * @param {string} hexColor
 * @returns {boolean}
 */
export function isNearWhite(hexColor) {
  const hex = String(hexColor || '').replace('#', '');
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return r > 230 && g > 230 && b > 230;
}

/**
 * Create initials from a service name.
 * @param {string} label
 * @returns {string}
 */
export function getServiceInitials(label) {
  if (!label) return 'SR';
  const words = label.replace(/[()]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return 'SR';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

