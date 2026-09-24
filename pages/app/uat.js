import { elements, state } from './state.js';
import { escapeHtml, formatTime, setHTML } from './utils.js';
import { buildUatTemplate, validateUatConfig } from '../../lib/uat.js';

/**
 * Render UAT status for the selected request.
 * @param {object|null} req
 */
export function renderUatForRequest(req) {
  if (!elements.uatStatus) return;
  if (elements.uatOpenDrawer) elements.uatOpenDrawer.classList.add('hidden');
  if (!req) {
    setStatusLine('idle', 'Validation not enabled for this session.');
    return;
  }
  const uat = req.uat;
  if (!uat) {
    const session = state.sessions.find(s => s.id === state.settings?.selectedSessionId);
    const hasConfig = session?.site && state.uatConfigs?.[session.site];
    if (session?.uatEnabled && hasConfig) {
      setStatusLine('skipped', 'Validation skipped');
    } else {
      setStatusLine('idle', 'Validation not enabled for this session.');
    }
    return;
  }
  if (uat.status === 'pending') {
    setStatusLine('loading', 'Validation in progress');
    return;
  }
  if (!uat.results || !uat.results.length) {
    setStatusLine('skipped', 'Validation skipped');
    return;
  }
  const applicableResults = uat.results.filter(r => r.applicable !== false);
  if (!applicableResults.length) {
    setStatusLine('skipped', 'Validation skipped');
    if (elements.uatOpenDrawer) {
      elements.uatOpenDrawer.classList.remove('hidden');
      elements.uatOpenDrawer.onclick = () => openUatDrawer(req);
    }
    return;
  }
  const failed = applicableResults.filter(r => r.status === 'failed');
  if (failed.length) {
    setStatusLine('failed', 'Validation failed');
  } else {
    setStatusLine('passed', 'Validation passed');
  }
  if (elements.uatOpenDrawer) {
    elements.uatOpenDrawer.classList.remove('hidden');
    elements.uatOpenDrawer.onclick = () => openUatDrawer(req);
  }
}

/**
 * Render the UAT status line with icon and label.
 * @param {string} state
 * @param {string} label
 */
function setStatusLine(state, label) {
  if (!elements.uatStatus) return;
  const icons = {
    loading: ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4 flex-none animate-spin text-muted"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v2m0 8v2m6-6h-2M8 12H6m9.07-4.07-1.41 1.41M8.34 15.66l-1.41 1.41m0-8.48 1.41 1.41m6.32 6.32 1.41 1.41" /></svg>', 'text-muted'],
    passed: ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 flex-none text-ok"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 4.5-5"></path></svg>', 'text-ok'],
    failed: ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4 flex-none text-danger"><circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg>', 'text-danger'],
    skipped: ['<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3" class="h-4 w-4 flex-none text-dim"><circle cx="12" cy="12" r="9"></circle></svg>', 'text-muted']
  };
  const [icon, tone] = icons[state] || [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 flex-none text-dim"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
    'text-muted'
  ];
  setHTML(elements.uatStatus, `${icon}<span class="${tone}">${escapeHtml(label)}</span>`);
}

/**
 * Open the UAT assertion detail modal.
 * @param {object} result
 */
export function openUatDetail(result) {
  if (!elements.uatDetailDialog || !elements.uatDetailBody || !elements.uatDetailTitle) return;
  elements.uatDetailTitle.textContent = result.title || 'Assertion Details';

  const renderList = (items) => items.map(cond => {
    const actual = cond.actual && cond.actual.length ? cond.actual.join(', ') : '—';
    const expected = cond.expected !== undefined ? JSON.stringify(cond.expected) : '—';
    return `
      <div class="rounded border px-3 py-2">
        <div class="text-xs text-muted">${escapeHtml(cond.source)} · ${escapeHtml(cond.path || '(root)')} · ${escapeHtml(cond.operator)}</div>
        <div class="mt-1 text-sm"><span class="font-semibold">Expected:</span> ${escapeHtml(expected)}</div>
        <div class="text-sm"><span class="font-semibold">Actual:</span> ${escapeHtml(actual)}</div>
        <div class="mt-1 text-xs ${cond.passed ? 'text-ok' : 'text-danger'}">${cond.passed ? 'Passed' : 'Failed'}</div>
      </div>
    `;
  }).join('');

  const conditionsHtml = (result.conditions && result.conditions.length)
    ? `
      <div>
        <div class="text-xs font-semibold uppercase tracking-wide text-dim mb-2">Applicability conditions</div>
        <div class="space-y-2">${renderList(result.conditions)}</div>
      </div>
    `
    : '';

  const validationsHtml = (result.validations && result.validations.length)
    ? `
      <div>
        <div class="text-xs font-semibold uppercase tracking-wide text-dim mb-2">Validations</div>
        <div class="space-y-2">${renderList(result.validations)}</div>
      </div>
    `
    : '';

  const countHtml = result.count
    ? `
      <div class="rounded border px-3 py-2">
        <div class="text-xs text-muted">Count validation · ${escapeHtml(result.count.count || '')}</div>
        <div class="mt-1 text-sm"><span class="font-semibold">Expected:</span> ${escapeHtml(String(result.count.expected))}</div>
        <div class="text-sm"><span class="font-semibold">Actual:</span> ${escapeHtml(String(result.count.actual))}</div>
      </div>
    `
    : '';

  setHTML(elements.uatDetailBody, `
    <div class="space-y-3">
      ${conditionsHtml}
      ${validationsHtml}
      ${countHtml}
    </div>
  `);

  elements.uatDetailDialog.showModal();
}

/**
 * Close the UAT detail modal.
 */
export function closeUatDetail() {
  elements.uatDetailDialog?.close();
}

/**
 * Open the Validation results drawer for a request.
 * @param {object} req
 */
export function openUatDrawer(req) {
  if (!elements.uatDrawer || !elements.uatDrawerBody || !elements.uatDrawerOverlay) return;
  const uat = req?.uat;
  if (!uat || !uat.results?.length) return;
  if (elements.uatDrawerMeta) {
    elements.uatDrawerMeta.textContent = `${req.domain || ''} · ${formatTime(req.timeStamp)}`;
  }
  setHTML(elements.uatDrawerBody, renderUatDrawerResults(uat.results));
  elements.uatDrawer.classList.remove('translate-x-full');
  elements.uatDrawerOverlay.classList.remove('hidden');
  elements.uatDrawerOverlay.onclick = () => closeUatDrawer();
}

/**
 * Close the Validation results drawer.
 */
export function closeUatDrawer() {
  elements.uatDrawer?.classList.add('translate-x-full');
  elements.uatDrawerOverlay?.classList.add('hidden');
}

/**
 * Render results list for the UAT drawer.
 * @param {Array<object>} results
 * @returns {string}
 */
function renderUatDrawerResults(results) {
  const grouped = {
    failed: results.filter(r => r.status === 'failed' && r.applicable !== false),
    passed: results.filter(r => r.status === 'passed' && r.applicable !== false),
    skipped: results.filter(r => r.status === 'skipped' || r.applicable === false)
  };
  // Explicit class names: Tailwind cannot see a class built by interpolation,
  // so a `text-${tone}-700` form would be purged from the built stylesheet.
  const sections = [
    { key: 'failed', tone: 'text-danger' },
    { key: 'passed', tone: 'text-ok' },
    { key: 'skipped', tone: 'text-muted' }
  ];
  return sections.map(section => {
    const items = grouped[section.key];
    if (!items.length) return '';
    return `
      <details class="mb-4" open>
        <summary class="cursor-pointer flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide ${section.tone} mb-2">
          <span>${section.key}</span>
          <span class="flex items-center gap-1 text-dim">
            ${items.length}
            <svg viewBox="0 0 16 16" fill="currentColor" class="size-3 transition-transform group-open:rotate-180">
              <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </span>
        </summary>
        <div class="space-y-3">
          ${items.map(renderUatDrawerItem).join('')}
        </div>
      </details>
    `;
  }).join('');
}

/**
 * Render a single UAT drawer item.
 * @param {object} result
 * @returns {string}
 */
function renderUatDrawerItem(result) {
  const relevantValidations = (result.validations || []).filter(cond => cond.used);
  const validationsToShow = relevantValidations.length ? relevantValidations : (result.validations || []);
  const validationList = validationsToShow.map(cond => {
    const actual = cond.actual && cond.actual.length ? cond.actual.join(', ') : '—';
    const expected = cond.expected !== undefined ? JSON.stringify(cond.expected) : '—';
    return `
      <div class="rounded border border-line bg-surface px-3 py-2 text-xs text-muted">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="break-words font-semibold text-fg">${escapeHtml(cond.path || '(root)')}</div>
            <div class="text-[10px] uppercase tracking-wide text-dim">${escapeHtml(cond.source || 'payload')}</div>
          </div>
          <span class="pill shrink-0 font-mono text-2xs font-semibold">${escapeHtml(cond.operator)}</span>
        </div>
        <div class="mt-2 grid grid-cols-1 gap-1">
          <div class="break-words"><span class="font-semibold text-fg">Expected</span> <span class="text-muted">•</span> ${escapeHtml(expected)}</div>
          <div class="break-words"><span class="font-semibold text-fg">Actual</span> <span class="text-muted">•</span> ${escapeHtml(actual)}</div>
        </div>
      </div>
    `;
  }).join('');
  const conditionsList = (result.conditions && result.conditions.length)
    ? `<div class="rounded border border-line bg-canvas px-3 py-2 text-xs text-muted">
         <div class="text-[10px] uppercase tracking-wide text-dim mb-2">Applies when</div>
         <div class="space-y-2">
           ${(result.conditions || []).map(cond => {
             const expected = cond.expected !== undefined ? escapeHtml(String(cond.expected)) : '—';
             return `
               <div class="rounded border border-line bg-surface px-2 py-1.5">
                 <div class="flex items-start justify-between gap-2">
                   <div class="min-w-0">
                     <div class="break-words font-semibold text-fg">${escapeHtml(cond.path || '(root)')}</div>
                     <div class="text-[10px] uppercase tracking-wide text-dim">${escapeHtml(cond.source || 'payload')}</div>
                   </div>
                   <span class="pill shrink-0 font-mono text-2xs font-semibold">${escapeHtml(cond.operator || 'exists')}</span>
                 </div>
                 <div class="mt-2 grid grid-cols-1 gap-1">
                   <div class="break-words"><span class="font-semibold text-fg">Expected</span> <span class="text-muted">•</span> ${expected}</div>
                 </div>
               </div>
             `;
           }).join('')}
         </div>
       </div>`
    : '';
  const countBlock = result.count
    ? `<div class="rounded border border-line bg-canvas px-3 py-2 text-xs text-muted">
         <div class="text-[10px] uppercase tracking-wide text-dim">Count validation</div>
         <div class="mt-1"><span class="font-semibold text-fg">Mode</span> <span class="text-muted">•</span> ${escapeHtml(result.count.count)}</div>
         <div class="mt-1"><span class="font-semibold text-fg">Expected</span> <span class="text-muted">•</span> ${escapeHtml(String(result.count.expected))}</div>
         <div class="mt-1"><span class="font-semibold text-fg">Actual</span> <span class="text-muted">•</span> ${escapeHtml(String(result.count.actual))}</div>
       </div>`
    : '';
  return `
    <details class="rounded border border-line bg-surface p-3 group">
      <summary class="cursor-pointer text-sm font-semibold text-fg flex items-start justify-between gap-2">
        <div class="w-[80%] pr-2 min-w-0">
          <div class="break-words">${escapeHtml(result.title)}</div>
          ${result.description ? `<div class="text-xs font-normal text-muted mt-1">${escapeHtml(result.description)}</div>` : ''}
        </div>
        <span class="w-6 flex-shrink-0 text-right">
          <svg viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4 text-dim transition-transform group-open:rotate-180">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.94l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.24a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08Z" clip-rule="evenodd" />
          </svg>
        </span>
      </summary>
      <div class="mt-3 space-y-3">
        ${conditionsList}
        ${validationList}
        ${countBlock}
      </div>
    </details>
  `;
}

/**
 * Open the Validation report modal for the active session.
 */
export function openUatReport() {
  if (!elements.uatReportDialog) return;
  const session = state.sessions.find(s => s.id === state.settings?.selectedSessionId);
  if (!session) return;
  const requests = state.requests.filter(r => r.sessionId === session.id);
  const { results, summary } = collectUatReportResults(requests);
  const grouped = groupResultsByPagePath(results);

  elements.uatReportMeta.textContent = `${session.site} · ${session.name || 'Untitled'} · ${formatTime(session.createdAt)}`;

  const summaryCard = `
    <div class="rounded border border-line bg-surface p-4 mb-4">
      <div class="text-sm font-semibold">Summary</div>
      <div class="mt-2 grid grid-cols-2 gap-2 text-xs text-muted">
        <div>Total assertions: <span class="font-semibold text-fg">${summary.total}</span></div>
        <div>Passed: <span class="font-semibold text-ok">${summary.passed}</span></div>
        <div>Failed: <span class="font-semibold text-danger">${summary.failed}</span></div>
        <div>Requests evaluated: <span class="font-semibold text-fg">${summary.requests}</span></div>
      </div>
    </div>
  `;

  if (!results.length) {
    setHTML(elements.uatReportBody, `${summaryCard}<div class=\"text-sm text-muted\">No validation results for this session.</div>`);
  } else {
    setHTML(elements.uatReportBody, `${summaryCard}${renderUatReportGroups(grouped)}`);
  }

  elements.uatReportDialog.showModal();
}

/**
 * Collect Validation results and summary for a session.
 * @param {Array<object>} requests
 * @returns {{ results: Array<object>, summary: object }}
 */
function collectUatReportResults(requests) {
  const items = [];
  let passed = 0;
  let failed = 0;
  let requestCount = 0;
  requests.forEach(req => {
    if (!req.uat || !req.uat.results || !req.uat.results.length) return;
    requestCount += 1;
    req.uat.results.forEach(result => {
      if (result.applicable === false || result.status === 'skipped') return;
      if (result.status === 'passed') passed += 1;
      if (result.status === 'failed') failed += 1;
      items.push({
        requestId: req.id,
        requestUrl: req.url,
        pageUrl: req.pageUrl || '',
        pagePath: getPathFromUrlSafe(req.pageUrl || ''),
        timeStamp: req.timeStamp,
        result
      });
    });
  });
  return {
    results: items,
    summary: {
      total: passed + failed,
      passed,
      failed,
      requests: requestCount
    }
  };
}

/**
 * Group Validation results by page path.
 * @param {Array<object>} results
 * @returns {Array<{ path: string, items: Array<object> }>}
 */
function groupResultsByPagePath(results) {
  const map = new Map();
  results.forEach(item => {
    const key = item.pagePath || '/';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return Array.from(map.entries()).map(([path, items]) => ({
    path,
    items: items.sort((a, b) => (b.timeStamp || 0) - (a.timeStamp || 0))
  })).sort((a, b) => (b.items[0]?.timeStamp || 0) - (a.items[0]?.timeStamp || 0));
}

/**
 * Render grouped Validation report sections.
 * @param {Array<{ path: string, items: Array<object> }>} groups
 * @returns {string}
 */
function renderUatReportGroups(groups) {
  return groups.map(group => `
    <div class="mb-4">
      <div class="flex items-center justify-between text-xs font-semibold text-muted mb-2">
        <span class="truncate">${escapeHtml(group.path)}</span>
        <span class="text-dim">${group.items.length} result${group.items.length === 1 ? '' : 's'}</span>
      </div>
      ${group.items.map(renderUatReportCard).join('')}
    </div>
  `).join('');
}

/**
 * Render a Validation report card.
 * @param {object} item
 * @returns {string}
 */
function renderUatReportCard(item) {
  const result = item.result;
  const statusClass = result.status === 'passed' ? 'text-ok' : 'text-danger';
  const validationsToShow = (result.validations && result.validations.length) ? result.validations : [];
  const validationList = validationsToShow.map(cond => {
    const actual = cond.actual && cond.actual.length ? cond.actual.join(', ') : '—';
    const expected = cond.expected !== undefined ? JSON.stringify(cond.expected) : '—';
    return `
      <li class="text-xs text-muted">
        <span class="font-semibold">${escapeHtml(cond.path || '(root)')}</span> · ${escapeHtml(cond.operator)} · expected ${escapeHtml(expected)} · actual ${escapeHtml(actual)}
      </li>
    `;
  }).join('');
  const applicabilityList = (result.conditions && result.conditions.length)
    ? `<ul class="mt-2 space-y-1">
         ${result.conditions.map(cond => {
           const expected = cond.expected !== undefined ? ` ${escapeHtml(String(cond.expected))}` : '';
           return `
             <li class="text-xs text-muted">
               Applies when ${escapeHtml(cond.path || '(root)')} ${escapeHtml(cond.operator)}${expected}
             </li>
           `;
         }).join('')}
       </ul>`
    : '';

  const countBlock = result.count
    ? `<div class="text-xs text-muted">Count ${escapeHtml(result.count.count)}: expected ${escapeHtml(String(result.count.expected))}, actual ${escapeHtml(String(result.count.actual))}</div>`
    : '';

  return `
    <div class="rounded border border-line bg-surface p-4 mb-4">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-sm font-semibold">${escapeHtml(result.title)}</div>
        </div>
        <div class="text-xs font-semibold ${statusClass}">${result.status.toUpperCase()}</div>
      </div>
      ${applicabilityList}
      <ul class="mt-2 space-y-1">${validationList}</ul>
      ${countBlock ? `<div class="mt-2">${countBlock}</div>` : ''}
    </div>
  `;
}

/**
 * Export Validation report as a printable PDF.
 */
export function exportUatPdf() {
  const session = state.sessions.find(s => s.id === state.settings?.selectedSessionId);
  if (!session) return;
  const requests = state.requests.filter(r => r.sessionId === session.id);
  const { results, summary } = collectUatReportResults(requests);
  const grouped = groupResultsByPagePath(results);
  const doc = window.open('', '_blank');
  if (!doc) return;
  const summaryBlock = `
    <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:16px;">
      <div style="font-weight:600;margin-bottom:6px;">Summary</div>
      <div style="font-size:12px;color:#475569;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;">
        <div>Total assertions: <strong>${summary.total}</strong></div>
        <div>Passed: <strong style="color:#047857;">${summary.passed}</strong></div>
        <div>Failed: <strong style="color:#b91c1c;">${summary.failed}</strong></div>
        <div>Requests evaluated: <strong>${summary.requests}</strong></div>
      </div>
    </div>
  `;
  const body = results.length
    ? `${summaryBlock}${renderUatReportGroups(grouped)}`
    : `${summaryBlock}<div style="color:#64748b;font-size:14px;">No validation results for this session.</div>`;

  doc.document.write(`<!doctype html>
    <html>
      <head>
        <title>Launch Observer Validation Report</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 32px; color: #0f172a; }
          h1 { font-size: 22px; margin-bottom: 4px; }
          .meta { color: #64748b; font-size: 12px; margin-bottom: 16px; }
          .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
          .header { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
          .logo { width:32px; height:32px; background:#0f172a; color:#fff; border-radius:8px; display:flex; align-items:center; justify-content:center; }
          .logo svg { width:18px; height:18px; }
          .title { font-size:20px; font-weight:600; }
          .site { color:#64748b; font-size:12px; margin-top:2px; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
            </svg>
          </div>
          <div>
            <div class="title">Launch Observer — Validation Report</div>
            <div class="site">Site: ${escapeHtml(session.site)}</div>
          </div>
        </div>
        <div class="meta">${escapeHtml(session.name || 'Untitled')} · ${escapeHtml(formatTime(session.createdAt))}</div>
        ${body.replaceAll('class="rounded border border-line bg-surface p-4 mb-4"', 'class="card"')}
      </body>
    </html>`);
  doc.document.close();
  doc.focus();
  doc.print();
}

/**
 * Safely get pathname from a URL string.
 * @param {string} url
 * @returns {string}
 */
function getPathFromUrlSafe(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname || '/';
  } catch {
    return url || '/';
  }
}

/**
 * Download a sample UAT template JSON file.
 */
export function buildTemplateDownload() {
  const template = buildUatTemplate('example-site');
  const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'uat-template.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
