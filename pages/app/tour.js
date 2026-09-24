import { api, elements } from './state.js';

const TOUR_KEY = 'tourCompleted';

const steps = [
  {
    id: 'start-session',
    target: '[data-tour="start-session"]',
    title: 'Start a New Session',
    body: 'Click “Start New Session” to begin. Choose a Site, optionally name the session, and select a tab to listen on.'
  },
  {
    id: 'allowlist',
    target: '[data-tour="allowlist"]',
    title: 'Manage the Allowlist',
    body: 'Use Manage Allowlist to include Adobe Experience Platform (AEP) Edge, Adobe Analytics, or any custom domains.'
  },
  {
    id: 'uat-assertions',
    target: '[data-tour="uat-assertions"]',
    title: 'Validation Rules',
    body: 'Import your site’s validation rules JSON here, then turn on “Run validations” when starting a session to see pass/fail results.'
  },
  {
    id: 'sessions',
    target: '[data-tour="sessions"]',
    title: 'Sessions Sidebar',
    body: 'Sessions are grouped by Site. You can rename, pause, or delete a session from this list.'
  },
  {
    id: 'requests',
    target: '[data-tour="requests"]',
    title: 'Requests List',
    body: 'Requests are grouped by page. The icon shows the service initials (brand hint) to help you quickly identify the source.'
  },
  {
    id: 'search-requests',
    target: '[data-tour="search-requests"]',
    title: 'Search Requests',
    body: 'Use the search bar to filter by domain, path, or payload values.'
  },
  {
    id: 'details',
    target: '[data-tour="details"]',
    title: 'Read the Report',
    body: 'Select a request to see headers, query parameters, and payload details on the right.'
  },
  {
    id: 'payload-search',
    target: '[data-tour="payload-search"]',
    title: 'Search Payload',
    body: 'After selecting a request, use the payload search to quickly find a key or value.'
  }
];

let activeIndex = 0;
let overlay;
let spotlight;
let card;
let titleEl;
let bodyEl;
let stepEl;
let nextBtn;
let backBtn;
let skipBtn;
let finishBtn;

/**
 * Initialize the onboarding tour.
 */
export function initTour() {
  overlay = document.getElementById('tour-overlay');
  spotlight = document.getElementById('tour-spotlight');
  card = document.getElementById('tour-card');
  titleEl = document.getElementById('tour-title');
  bodyEl = document.getElementById('tour-body');
  stepEl = document.getElementById('tour-step');
  nextBtn = document.getElementById('tour-next');
  backBtn = document.getElementById('tour-back');
  skipBtn = document.getElementById('tour-skip');
  finishBtn = document.getElementById('tour-finish');

  if (!overlay || !spotlight || !card) return;

  nextBtn?.addEventListener('click', () => goTo(activeIndex + 1));
  backBtn?.addEventListener('click', () => goTo(activeIndex - 1));
  skipBtn?.addEventListener('click', () => endTour(true));
  finishBtn?.addEventListener('click', () => endTour(true));

  window.addEventListener('resize', positionCurrent);
  document.addEventListener('scroll', positionCurrent, true);

  const tourButton = document.getElementById('start-tour');
  if (tourButton) {
    tourButton.addEventListener('click', () => startTour(true));
  }

  try {
    api.storage?.local?.get?.(TOUR_KEY, result => {
      void api.runtime?.lastError;
      if (!result || !result[TOUR_KEY]) startTour(false);
    });
  } catch {}
}

/**
 * Start the tour.
 * @param {boolean} manual
 */
export function startTour(manual) {
  if (!overlay) return;
  // Mark the tour seen as soon as it auto-starts. Persisting only on
  // Skip/Finish meant closing the window mid-tour left the flag unset, so it
  // reappeared on every reload.
  if (!manual) markTourSeen();
  overlay.classList.remove('hidden');
  activeIndex = 0;
  goTo(activeIndex);
}

/** Record that the tour has been shown. */
function markTourSeen() {
  try {
    api.storage?.local?.set?.({ [TOUR_KEY]: true });
  } catch {}
}

/**
 * Navigate to a specific tour step.
 * @param {number} index
 */
function goTo(index) {
  if (index < 0) return;
  if (index >= steps.length) {
    endTour(true);
    return;
  }
  activeIndex = index;
  renderStep();
}

/**
 * Render the current tour step UI.
 */
function renderStep() {
  const step = steps[activeIndex];
  const target = document.querySelector(step.target);

  titleEl.textContent = step.title;
  bodyEl.textContent = step.body;
  stepEl.textContent = `Step ${activeIndex + 1} of ${steps.length}`;

  backBtn.disabled = activeIndex === 0;
  nextBtn.classList.toggle('hidden', activeIndex === steps.length - 1);
  finishBtn.classList.toggle('hidden', activeIndex !== steps.length - 1);

  if (!target) {
    spotlight.classList.add('hidden');
    card.style.top = '20%';
    card.style.left = '50%';
    card.style.transform = 'translateX(-50%)';
    return;
  }

  spotlight.classList.remove('hidden');
  positionForTarget(target);
}

/**
 * Reposition spotlight and card for current step.
 */
function positionCurrent() {
  if (!overlay || overlay.classList.contains('hidden')) return;
  const step = steps[activeIndex];
  const target = document.querySelector(step.target);
  if (!target) return;
  positionForTarget(target);
}

/**
 * Position spotlight and card relative to a target element.
 * @param {Element} target
 */
function positionForTarget(target) {
  const rect = target.getBoundingClientRect();
  const padding = 8;
  const margin = 16;
  const spotlightRect = {
    top: Math.max(rect.top - padding, 8),
    left: Math.max(rect.left - padding, 8),
    width: Math.min(rect.width + padding * 2, window.innerWidth - 16),
    height: Math.min(rect.height + padding * 2, window.innerHeight - 16)
  };

  spotlight.style.top = `${spotlightRect.top}px`;
  spotlight.style.left = `${spotlightRect.left}px`;
  spotlight.style.width = `${spotlightRect.width}px`;
  spotlight.style.height = `${spotlightRect.height}px`;

  const cardRect = card.getBoundingClientRect();
  const belowTop = spotlightRect.top + spotlightRect.height + 16;
  const aboveTop = spotlightRect.top - cardRect.height - 16;

  let top = belowTop;
  if (belowTop + cardRect.height > window.innerHeight && aboveTop > 8) {
    top = aboveTop;
  }

  let left = spotlightRect.left;
  if (left + cardRect.width > window.innerWidth - margin) {
    left = window.innerWidth - cardRect.width - margin;
  }
  left = Math.max(left, margin);

  if (top + cardRect.height > window.innerHeight - margin) {
    top = window.innerHeight - cardRect.height - margin;
  }
  top = Math.max(top, margin);

  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
  card.style.transform = 'translateX(0)';
}

/**
 * End the tour and optionally persist completion.
 * @param {boolean} persist
 */
function endTour(persist) {
  overlay.classList.add('hidden');
  if (persist) markTourSeen();
}
