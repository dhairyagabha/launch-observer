const api = globalThis.chrome || globalThis.browser;
const action = api.action || api.browserAction;

const SERVICE_CATALOG = [
  { id: 'adobe-edge', domains: ['edge.adobedc.net'] },
  { id: 'adobe-analytics', domains: ['omtrdc.net', '2o7.net'] },
  { id: 'google-analytics', domains: ['google-analytics.com', 'analytics.google.com'] },
  { id: 'google-ads', domains: ['googleadservices.com', 'doubleclick.net'] },
  { id: 'meta', domains: ['facebook.com', 'facebook.net'] },
  { id: 'tiktok', domains: ['tiktok.com', 'tiktokv.com', 'analytics.tiktok.com'] },
  { id: 'linkedin', domains: ['linkedin.com', 'licdn.com'] },
  { id: 'pinterest', domains: ['pinterest.com', 'pinimg.com'] },
  { id: 'snapchat', domains: ['snapchat.com', 'sc-static.net', 'tr.snapchat.com'] },
  { id: 'x', domains: ['twitter.com', 't.co', 'ads-twitter.com'] },
  { id: 'microsoft-ads', domains: ['bat.bing.com', 'bing.com'] },
  { id: 'baidu', domains: ['baidu.com', 'hm.baidu.com'] },
  { id: 'demandbase', domains: ['demandbase.com', 'tag.demandbase.com'] },
  { id: 'hotjar', domains: ['hotjar.com', 'hotjar.io'] },
  { id: 'segment', domains: ['segment.com', 'segment.io'] },
  { id: 'mixpanel', domains: ['mixpanel.com'] },
  { id: 'amplitude', domains: ['amplitude.com'] }
];

/**
 * Compare domain entries with subdomain support.
 * @param {string} entry
 * @param {string} domain
 * @returns {boolean}
 */
function domainMatches(entry, domain) {
  const left = (entry || '').toLowerCase();
  const right = (domain || '').toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith(`.${right}`)) return true;
  if (right.endsWith(`.${left}`)) return true;
  return false;
}

/**
 * Find the custom mapping for a domain.
 * @param {string} domain
 * @param {Array<object>} mappings
 * @returns {object|null}
 */
function getMappingForDomain(domain, mappings) {
  const list = Array.isArray(mappings) ? mappings : [];
  return list.find(item => domainMatches(item.domain, domain)) || null;
}

/**
 * Resolve a service ID for a domain.
 * @param {string} domain
 * @param {Array<object>} mappings
 * @returns {string|null}
 */
function resolveServiceIdForDomain(domain, mappings) {
  if (!domain) return null;
  const mapping = getMappingForDomain(domain, mappings);
  if (mapping && mapping.serviceId) return mapping.serviceId;
  const match = SERVICE_CATALOG.find(service => service.domains.some(serviceDomain => domainMatches(domain, serviceDomain)));
  return match ? match.id : null;
}

/**
 * Safely decode URI components without throwing.
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
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
function decodePlus(value) {
  if (value === undefined || value === null) return '';
  return value.replace(/\+/g, ' ');
}

/**
 * Parse key/value pairs from a raw query or form-encoded string.
 * @param {string} raw
 * @param {boolean} plusAsSpace
 * @returns {Array<object>}
 */
function parseKeyValuePairs(raw, plusAsSpace) {
  if (!raw) return [];
  return raw.split('&').filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    const rawKey = idx === -1 ? pair : pair.slice(0, idx);
    const rawValue = idx === -1 ? '' : pair.slice(idx + 1);
    const keySource = plusAsSpace ? decodePlus(rawKey) : rawKey;
    const valueSource = plusAsSpace ? decodePlus(rawValue) : rawValue;
    return {
      rawKey,
      rawValue,
      key: safeDecode(keySource),
      value: safeDecode(valueSource)
    };
  });
}

/**
 * Parse a URL into query params.
 * @param {string} url
 * @returns {{ raw: string, params: Array<object> }}
 */
function parseQueryString(url) {
  try {
    const parsed = new URL(url);
    const rawQuery = parsed.search ? parsed.search.slice(1) : '';
    return {
      raw: rawQuery,
      params: parseKeyValuePairs(rawQuery, true)
    };
  } catch {
    return { raw: '', params: [] };
  }
}

/**
 * Parse a formData object into key/value params.
 * @param {object} formData
 * @returns {{ raw: string, params: Array<object> }}
 */
function parseFormData(formData) {
  const params = [];
  Object.keys(formData || {}).forEach(key => {
    const values = Array.isArray(formData[key]) ? formData[key] : [formData[key]];
    values.forEach(value => {
      const rawValue = value || '';
      params.push({
        rawKey: key,
        rawValue,
        key,
        value: safeDecode(rawValue)
      });
    });
  });
  return { raw: '', params };
}

/**
 * Merge raw webRequest bytes entries into a single Uint8Array.
 * @param {Array<object>} rawEntries
 * @returns {Uint8Array}
 */
function mergeRawBytes(rawEntries) {
  const total = rawEntries.reduce((sum, entry) => sum + (entry.bytes ? entry.bytes.byteLength : 0), 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  rawEntries.forEach(entry => {
    if (!entry.bytes) return;
    merged.set(new Uint8Array(entry.bytes), offset);
    offset += entry.bytes.byteLength;
  });
  return merged;
}

/**
 * Decode a Uint8Array into text.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeBytes(bytes) {
  if (!bytes || !bytes.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * Attempt to parse JSON safely.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse a webRequest requestBody into a structured representation.
 * @param {object} requestBody
 * @param {string} [contentType='']
 * @returns {object|null}
 */
function parseRawBody(requestBody, contentType = '') {
  if (requestBody.formData) {
    return {
      type: 'formData',
      contentType,
      parsed: parseFormData(requestBody.formData)
    };
  }

  if (requestBody.raw && requestBody.raw.length) {
    const bytes = mergeRawBytes(requestBody.raw);
    const text = decodeBytes(bytes);
    const lowerType = contentType.toLowerCase();

    if (lowerType.includes('application/json')) {
      const json = tryParseJson(text);
      return {
        type: 'json',
        contentType,
        raw: text,
        parsed: json
      };
    }

    if (lowerType.includes('application/x-www-form-urlencoded')) {
      return {
        type: 'form',
        contentType,
        raw: text,
        parsed: {
          raw: text,
          params: parseKeyValuePairs(text, true)
        }
      };
    }

    const json = tryParseJson(text);
    return {
      type: json ? 'json' : 'text',
      contentType,
      raw: text,
      parsed: json
    };
  }

  return null;
}

/**
 * Get hostname from a URL.
 * @param {string} url
 * @returns {string}
 */
function getDomainFromUrl(url) {
  return new URL(url).hostname;
}

/**
 * Get pathname from a URL.
 * @param {string} url
 * @returns {string}
 */
function getPathFromUrl(url) {
  const parsed = new URL(url);
  return parsed.pathname || '/';
}

/**
 * Normalize a raw UAT config into a consistent structure.
 * @param {object} config
 * @returns {object}
 */
function normalizeUatConfig(config) {
  if (!config || typeof config !== 'object') return { assertions: [] };
  const assertions = Array.isArray(config.assertions) ? config.assertions : [];
  const globalConfig = normalizeGlobalConfig(config.global || null);
  return {
    ...config,
    global: globalConfig,
    assertions: assertions.map(assertion => normalizeAssertion(assertion))
  };
}

/**
 * Normalize a single assertion definition.
 * @param {object} assertion
 * @returns {object}
 */
function normalizeAssertion(assertion) {
  const conditions = Array.isArray(assertion.conditions) ? assertion.conditions : [];
  const validations = Array.isArray(assertion.validations) ? assertion.validations : [];
  return {
    id: assertion.id || `assertion-${Math.random().toString(16).slice(2)}`,
    title: assertion.title || assertion.id || 'Assertion',
    description: assertion.description || '',
    conditionsLogic: assertion.conditionsLogic === 'any' ? 'any' : 'all',
    conditions: conditions.map(cond => normalizeCondition(cond)),
    validations: validations.map(cond => normalizeCondition(cond)),
    scope: assertion.scope === 'page' ? 'page' : 'request',
    count: assertion.count || null,
    value: Number.isFinite(assertion.value) ? assertion.value : assertion.value
  };
}

/**
 * Normalize global UAT rules.
 * @param {object|null} globalConfig
 * @returns {object}
 */
function normalizeGlobalConfig(globalConfig) {
  if (!globalConfig || typeof globalConfig !== 'object') {
    return {
      includeServices: [],
      excludeServices: [],
      includeConditions: [],
      excludeConditions: []
    };
  }
  const includeServices = Array.isArray(globalConfig.includeServices) ? globalConfig.includeServices : [];
  const excludeServices = Array.isArray(globalConfig.excludeServices) ? globalConfig.excludeServices : [];
  const includeConditions = Array.isArray(globalConfig.includeConditions) ? globalConfig.includeConditions : [];
  const excludeConditions = Array.isArray(globalConfig.excludeConditions) ? globalConfig.excludeConditions : [];
  return {
    includeServices,
    excludeServices,
    includeConditions: includeConditions.map(cond => normalizeCondition(cond)),
    excludeConditions: excludeConditions.map(cond => normalizeCondition(cond))
  };
}

/**
 * Normalize a single condition definition.
 * @param {object} condition
 * @returns {object}
 */
function normalizeCondition(condition) {
  const cond = condition || {};
  return {
    source: cond.source || 'payload',
    path: cond.path || '',
    operator: cond.operator || 'exists',
    expected: cond.expected
  };
}

/**
 * Evaluate all applicable assertions for a single request.
 * @param {object} request
 * @param {Array<object>} assertions
 * @param {Array<object>} allRequests
 * @param {{ global?: object|null, serviceId?: string|null }} [options]
 * @returns {Array<object>}
 */
function evaluateAssertionsForRequest(request, assertions, allRequests, options = {}) {
  if (!request || !Array.isArray(assertions)) return [];
  const results = [];
  const globalGate = evaluateGlobalGate(request, options.global || null, options.serviceId || null);
  if (globalGate.applicable === false) {
    return [];
  }
  assertions.forEach(assertion => {
    const isPageScope = assertion.scope === 'page';
    const { conditionResults, applicable } = resolveConditionResults(assertion.conditions || [], assertion.conditionsLogic || 'all', request);
    if (!applicable) {
      results.push({
        id: assertion.id,
        title: assertion.title,
        description: assertion.description,
        status: 'skipped',
        applicable: false,
        conditionsLogic: assertion.conditionsLogic,
        scope: assertion.scope,
        conditions: conditionResults,
        validations: [],
        count: null
      });
      return;
    }

    const { conditionResults: validationResults } = resolveConditionResults(assertion.validations || [], 'all', request, true);
    const validationsPassed = validationResults.every(c => c.passed);
    let passed = validationsPassed;

    let countResult = null;
    if (isPageScope && assertion.count && assertion.value !== undefined) {
      const count = countAssertionMatches(assertion, allRequests, request);
      const countPassed = evaluateCount(assertion.count, count, assertion.value);
      passed = countPassed;
      countResult = {
        count: assertion.count,
        expected: assertion.value,
        actual: count
      };
    }

    results.push({
      id: assertion.id,
      title: assertion.title,
      description: assertion.description,
      status: passed ? 'passed' : 'failed',
      applicable,
      conditionsLogic: assertion.conditionsLogic,
      scope: assertion.scope,
      conditions: conditionResults,
      validations: validationResults,
      count: countResult
    });
  });
  return results;
}

/**
 * Evaluate global include/exclude gates for a request.
 * @param {object} request
 * @param {object|null} globalConfig
 * @param {string|null} serviceId
 * @returns {{ applicable: boolean }}
 */
function evaluateGlobalGate(request, globalConfig, serviceId) {
  if (!globalConfig || typeof globalConfig !== 'object') return { applicable: true };
  const includeServices = Array.isArray(globalConfig.includeServices) ? globalConfig.includeServices : [];
  const excludeServices = Array.isArray(globalConfig.excludeServices) ? globalConfig.excludeServices : [];
  if (includeServices.length) {
    if (!serviceId || !includeServices.includes(serviceId)) {
      return { applicable: false };
    }
  }
  if (excludeServices.length && serviceId && excludeServices.includes(serviceId)) {
    return { applicable: false };
  }
  const excludeConditions = Array.isArray(globalConfig.excludeConditions) ? globalConfig.excludeConditions : [];
  if (excludeConditions.length) {
    const excludes = excludeConditions.some(condition => {
      const resolved = resolveConditionValue(condition, request);
      return evaluateCondition(condition, resolved.values);
    });
    if (excludes) return { applicable: false };
  }
  const includeConditions = Array.isArray(globalConfig.includeConditions) ? globalConfig.includeConditions : [];
  if (includeConditions.length) {
    const includes = includeConditions.every(condition => {
      const resolved = resolveConditionValue(condition, request);
      return evaluateCondition(condition, resolved.values);
    });
    if (!includes) return { applicable: false };
  }
  return { applicable: true };
}

/**
 * Resolve condition values and determine applicability/passing state.
 * @param {Array<object>} conditions
 * @param {string} logic
 * @param {object} request
 * @param {boolean} [forceApplicable=false]
 * @returns {{ conditionResults: Array<object>, applicable: boolean }}
 */
function resolveConditionResults(conditions, logic, request, forceApplicable = false) {
  const conditionResults = conditions.map(condition => {
    const resolved = resolveConditionValue(condition, request);
    const passed = evaluateCondition(condition, resolved.values);
    return {
      ...condition,
      passed,
      actual: resolved.values,
      used: resolved.used,
      evaluated: true
    };
  });
  if (!conditionResults.length) {
    return { conditionResults, applicable: forceApplicable ? true : true };
  }
  const passes = logic === 'any'
    ? conditionResults.some(c => c.passed)
    : conditionResults.every(c => c.passed);
  return { conditionResults, applicable: forceApplicable ? true : passes };
}


/**
 * Evaluate a single condition against resolved values.
 * @param {object} condition
 * @param {Array|any} values
 * @returns {boolean}
 */
function evaluateCondition(condition, values) {
  const operator = condition.operator || 'exists';
  const expected = condition.expected;
  const list = Array.isArray(values) ? values : [values];
  const hasValue = list.some(v => v !== undefined && v !== null && String(v).length > 0);

  switch (operator) {
    case 'exists':
      return hasValue;
    case 'not_exists':
      return !hasValue;
    case 'equals':
      return list.some(v => String(v) === String(expected));
    case 'contains':
      return list.some(v => String(v).includes(String(expected)));
    case 'starts_with':
      return list.some(v => String(v).startsWith(String(expected)));
    case 'ends_with':
      return list.some(v => String(v).endsWith(String(expected)));
    case 'regex': {
      try {
        const regex = new RegExp(String(expected));
        return list.some(v => regex.test(String(v)));
      } catch {
        return false;
      }
    }
    case 'in': {
      const expectedList = Array.isArray(expected) ? expected.map(String) : [String(expected)];
      return list.some(v => expectedList.includes(String(v)));
    }
    case 'not_in': {
      const expectedList = Array.isArray(expected) ? expected.map(String) : [String(expected)];
      return list.every(v => !expectedList.includes(String(v)));
    }
    case 'gt':
      return list.some(v => Number(v) > Number(expected));
    case 'gte':
      return list.some(v => Number(v) >= Number(expected));
    case 'lt':
      return list.some(v => Number(v) < Number(expected));
    case 'lte':
      return list.some(v => Number(v) <= Number(expected));
    case 'range': {
      const range = Array.isArray(expected) ? expected : [];
      return list.some(v => Number(v) >= Number(range[0]) && Number(v) <= Number(range[1]));
    }
    default:
      return false;
  }
}

/**
 * Resolve condition value(s) from a request.
 * @param {object} condition
 * @param {object} request
 * @returns {{ used: boolean, values: Array<any> }}
 */
function resolveConditionValue(condition, request) {
  const source = condition.source || 'payload';
  const path = condition.path || '';
  if (source === 'payload') {
    const payload = getPayloadObject(request);
    if (!payload) return { used: false, values: [] };
    const value = getValueAtPath(payload, path);
    return { used: value !== undefined, values: normalizeValues(value) };
  }
  if (source === 'query') {
    const params = (request.query && request.query.params) || [];
    const matches = params.filter(p => p.key === path).map(p => p.value);
    return { used: matches.length > 0, values: matches };
  }
  if (source === 'headers') {
    const headers = request.requestHeaders || [];
    const matches = headers.filter(h => h.name.toLowerCase() === path.toLowerCase()).map(h => h.value);
    return { used: matches.length > 0, values: matches };
  }
  if (source === 'raw') {
    const raw = request.body?.raw || '';
    return { used: raw.length > 0, values: [raw] };
  }
  return { used: false, values: [] };
}

/**
 * Convert request body into a traversable object.
 * @param {object} request
 * @returns {object|null}
 */
function getPayloadObject(request) {
  if (!request?.body) return null;
  if (typeof request.body.raw === 'string') {
    const json = tryParseJson(request.body.raw);
    if (json) return json;
  }
  if (request.body.parsed && typeof request.body.parsed === 'object') return request.body.parsed;
  if (typeof request.body.raw === 'string') {
    const form = parseKeyValuePairs(request.body.raw, true);
    if (form.length) return Object.fromEntries(form.map(item => [item.key, item.value]));
  }
  return null;
}

/**
 * Normalize resolved values into an array.
 * @param {any} value
 * @returns {Array<any>}
 */
function normalizeValues(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [JSON.stringify(value)];
  if (value === undefined) return [];
  return [value];
}

/**
 * Resolve a dotted/bracket path against an object.
 * @param {object} obj
 * @param {string} path
 * @returns {any}
 */
function getValueAtPath(obj, path) {
  if (!path) return obj;
  const tokens = parsePath(path);
  let current = obj;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof token === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
    } else {
      current = current[token];
    }
  }
  return current;
}

/**
 * Parse a path like "a.b[0].c" into tokens.
 * @param {string} path
 * @returns {Array<string|number>}
 */
function parsePath(path) {
  const tokens = [];
  path.split('.').forEach(segment => {
    const parts = segment.split(/\[|\]/).filter(Boolean);
    parts.forEach(part => {
      const index = Number(part);
      if (!Number.isNaN(index) && part.trim() !== '') {
        tokens.push(index);
      } else {
        tokens.push(part);
      }
    });
  });
  return tokens.filter(t => t !== '');
}

/**
 * Count request matches for count-based assertions on the same page navigation.
 * @param {object} assertion
 * @param {Array<object>} allRequests
 * @param {object} request
 * @returns {number}
 */
function countAssertionMatches(assertion, allRequests, request) {
  if (!Array.isArray(allRequests)) return 0;
  const pageKey = request.navId ? `${request.pageUrl || request.url}::${request.navId}` : (request.pageUrl || request.url);
  return allRequests.filter(item => {
    const key = item.navId ? `${item.pageUrl || item.url}::${item.navId}` : (item.pageUrl || item.url);
    if (key !== pageKey) return false;
    const conditions = Array.isArray(assertion.conditions) ? assertion.conditions : [];
    const validations = Array.isArray(assertion.validations) ? assertion.validations : [];
    if (conditions.length) {
      const conditionResults = conditions.map(condition => {
        const resolved = resolveConditionValue(condition, item);
        return evaluateCondition(condition, resolved.values);
      });
      const conditionsPass = (assertion.conditionsLogic === 'any')
        ? conditionResults.some(Boolean)
        : conditionResults.every(Boolean);
      if (!conditionsPass) return false;
    }
    const results = validations.map(condition => {
      const resolved = resolveConditionValue(condition, item);
      return evaluateCondition(condition, resolved.values);
    });
    return results.every(Boolean);
  }).length;
}

/**
 * Evaluate count rule for page-level assertions.
 * @param {string} mode
 * @param {number} actual
 * @param {number} expected
 * @returns {boolean}
 */
function evaluateCount(mode, actual, expected) {
  const expectedNumber = Number(expected);
  if (!Number.isFinite(expectedNumber)) return false;
  if (mode === 'at_least') return actual >= expectedNumber;
  if (mode === 'at_most') return actual <= expectedNumber;
  return actual === expectedNumber;
}

const DEFAULT_ALLOWLIST = [
  'edge.adobedc.net'
];

const DEFAULT_SETTINGS = {
  allowlist: DEFAULT_ALLOWLIST,
  capturePaused: false,
  maxEntries: 2000,
  selectedSessionId: null,
  enableHooks: false,
  debugHooks: false,
  serviceMappings: []
};

let settings = { ...DEFAULT_SETTINGS };
let requests = [];
let requestIndex = new Map();
let sessions = [];
let sites = [];
let currentSessionId = null;
let navState = new Map();
let tabUrlCache = new Map();
const payloadCacheByUrlTab = new Map();
let uatConfigs = {};
const hookQueueByTabUrl = new Map();
const hookQueueByUrl = new Map();
let lastRequestAt = Date.now();
let idlePrompted = false;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function debugHookLog(...args) {
  if (!settings?.debugHooks) return;
  console.log('[Launch Observer Hooks]', ...args);
}

/**
 * Promise wrapper for storage.get (MV2 compatibility).
 * @param {Array<string>} keys
 * @returns {Promise<object>}
 */
function storageGet(keys) {
  return new Promise(resolve => {
    try {
      const result = api.storage.local.get(keys, data => resolve(data || {}));
      if (result && typeof result.then === 'function') {
        result.then(data => resolve(data || {})).catch(() => resolve({}));
      }
    } catch {
      resolve({});
    }
  });
}

/**
 * Promise wrapper for storage.set (MV2 compatibility).
 * @param {object} value
 * @returns {Promise<void>}
 */
function storageSet(value) {
  return new Promise(resolve => {
    try {
      const result = api.storage.local.set(value, () => resolve());
      if (result && typeof result.then === 'function') {
        result.then(() => resolve()).catch(() => resolve());
      }
    } catch {
      resolve();
    }
  });
}

/**
 * Promise wrapper for tabs.query (MV2 compatibility).
 * @param {object} queryInfo
 * @returns {Promise<Array<object>>}
 */
function tabsQuery(queryInfo) {
  return new Promise(resolve => {
    try {
      const result = api.tabs.query(queryInfo, tabs => resolve(tabs || []));
      if (result && typeof result.then === 'function') {
        result.then(tabs => resolve(tabs || [])).catch(() => resolve([]));
      }
    } catch {
      resolve([]);
    }
  });
}

/**
 * Load persisted extension state from storage.
 * @returns {Promise<void>}
 */
async function loadState() {
  const stored = await storageGet(['settings', 'requests', 'sessions', 'sites', 'currentSessionId', 'uatConfigs', 'lastRequestAt', 'idlePrompted']);
  if (stored.settings) settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  if (Array.isArray(stored.requests)) {
    requests = stored.requests;
    requestIndex = new Map(requests.map(r => [r.requestId, r]));
  }
  if (Array.isArray(stored.sessions)) sessions = stored.sessions;
  if (Array.isArray(stored.sites)) sites = stored.sites;
  if (stored.currentSessionId) currentSessionId = stored.currentSessionId;
  if (stored.uatConfigs && typeof stored.uatConfigs === 'object') {
    uatConfigs = Object.fromEntries(Object.entries(stored.uatConfigs).map(([key, value]) => [key, normalizeUatConfig(value)]));
  }
  if (stored.lastRequestAt) lastRequestAt = stored.lastRequestAt;
  if (stored.idlePrompted !== undefined) idlePrompted = !!stored.idlePrompted;
  if (!currentSessionId) currentSessionId = sessions[0]?.id || null;
  if (!settings.selectedSessionId) settings.selectedSessionId = currentSessionId;
}

/**
 * Persist extension state to storage.
 * @returns {Promise<void>}
 */
function saveState() {
  return storageSet({ settings, requests, sessions, sites, currentSessionId, uatConfigs, lastRequestAt, idlePrompted });
}

/**
 * Check whether a URL matches the allowlist.
 * @param {string} url
 * @returns {boolean}
 */
function isAllowed(url) {
  try {
    const domain = getDomainFromUrl(url);
    return settings.allowlist.some(entry => {
      const trimmed = entry.trim();
      if (!trimmed) return false;
      if (domain === trimmed) return true;
      return domain.endsWith(`.${trimmed}`);
    });
  } catch {
    return false;
  }
}

/**
 * Trim request list to max entries.
 */
function trimRequests() {
  if (requests.length <= settings.maxEntries) return;
  requests = requests.slice(-settings.maxEntries);
  requestIndex = new Map(requests.map(r => [r.requestId, r]));
}

/**
 * Create a new request entry from webRequest details.
 * @param {object} details
 */
function addRequest(details) {
  const sessionId = currentSessionId || settings.selectedSessionId;
  const nav = navState.get(details.tabId) || {};
  const cachedUrl = tabUrlCache.get(details.tabId);
  const requestId = getRequestIdFromUrl(details.url);
  const cachedPayload = requestId ? pullCachedPayload(requestId) : pullCachedPayloadByUrl(details.tabId, details.url, details.timeStamp);
  const hookMatch = pullHookPayload(details.tabId, details.url, details.timeStamp)
    || pullHookPayloadByUrl(details.url, details.timeStamp);
  const cachedBody = hookMatch?.payload || cachedPayload?.payload || null;
  const cachedPageUrl = hookMatch?.pageUrl || cachedPayload?.pageUrl || '';
  const pageUrl = nav.pageUrl
    || nav.pendingUrl
    || cachedUrl
    || details.documentUrl
    || details.initiator
    || cachedPageUrl
    || extractPageUrlFromRequest(details.url)
    || null;
  const session = sessions.find(s => s.id === sessionId);
  const uatConfig = session?.site ? uatConfigs[session.site] : null;
  const entry = {
    id: `${details.requestId}:${details.timeStamp}`,
    requestId: details.requestId,
    sessionId,
    tabId: details.tabId,
    frameId: details.frameId,
    method: details.method,
    url: details.url,
    documentUrl: details.documentUrl || null,
    initiator: details.initiator || null,
    domain: getDomainFromUrl(details.url),
    serviceId: resolveServiceIdForDomain(getDomainFromUrl(details.url), settings.serviceMappings || []),
    path: getPathFromUrl(details.url),
    timeStamp: details.timeStamp,
    startTime: details.timeStamp,
    statusCode: null,
    statusLine: null,
    duration: null,
    requestHeaders: [],
    query: parseQueryString(details.url),
    body: cachedBody,
    pageUrl,
    navId: nav.navId || null,
    uat: session?.uatEnabled && uatConfig ? { status: 'pending', results: [] } : null
  };

  if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
    entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
  }
  requests.push(entry);
  requestIndex.set(details.requestId, entry);
  lastRequestAt = Date.now();
  idlePrompted = false;
  trimRequests();
  saveState();
  api.runtime.sendMessage({ type: 'requestAdded', request: entry });
}

/**
 * Update a request entry and broadcast changes.
 * @param {string} requestId
 * @param {object} patch
 */
function updateRequest(requestId, patch) {
  const entry = requestIndex.get(requestId);
  if (!entry) return;
  Object.assign(entry, patch);
  if (!entry.pageUrl && entry.body) {
    entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
  }
  evaluateUatForRequest(entry);
  saveState();
  api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
}

/**
 * Check whether a request entry looks like WebSDK.
 * @param {object} entry
 * @returns {boolean}
 */
function isWebsdkRequest(entry) {
  if (!entry) return false;
  const params = entry.query?.params || [];
  return params.some(param => String(param.key).toLowerCase() === 'configid');
}

/**
 * Attach a WebSDK hook payload to the most recent matching request.
 * @param {number} tabId
 * @param {object} payload
 * @param {string} pageUrl
 * @param {number} hookTs
 */
function attachWebsdkPayloadToRecent(tabId, payload, pageUrl, hookTs) {
  if (!payload) return;
  const now = Date.now();
  const candidates = requests.filter(entry => entry.tabId === tabId && isWebsdkRequest(entry));
  if (!candidates.length) return;
  const filtered = candidates.filter(entry => Math.abs((hookTs || now) - (entry.timeStamp || now)) < 20000);
  if (!filtered.length) return;
  const entry = filtered.reduce((best, item) => {
    if (!best) return item;
    return (item.timeStamp || 0) > (best.timeStamp || 0) ? item : best;
  }, null);
  if (!entry) return;
  if (!shouldReplaceBody(entry.body, payload)) return;
  debugHookLog('attach: websdk recent', { tabId, id: entry.id, hookTs });
  entry.body = payload;
  if ((!entry.pageUrl || entry.pageUrl === '/') && pageUrl) entry.pageUrl = pageUrl;
  if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
    entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
  }
  evaluateUatForRequest(entry);
  saveState();
  api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
}

/**
 * Evaluate UAT assertions for a request entry.
 * @param {object} entry
 */
function evaluateUatForRequest(entry) {
  if (!entry) return;
  const session = sessions.find(s => s.id === entry.sessionId);
  if (!session || !session.uatEnabled) {
    entry.uat = null;
    return;
  }
  const config = session.site ? uatConfigs[session.site] : null;
  if (!config || !Array.isArray(config.assertions)) {
    entry.uat = { status: 'not-applicable', results: [] };
    return;
  }
  const sessionRequests = requests.filter(r => r.sessionId === entry.sessionId);
  const results = evaluateAssertionsForRequest(entry, config.assertions, sessionRequests, {
    global: config.global || null,
    serviceId: entry.serviceId || null
  });
  if (!results.length) {
    entry.uat = { status: 'not-applicable', results: [] };
    return;
  }
  entry.uat = { status: 'done', results };
}

/**
 * Stop the active session due to idle timeout.
 * @param {string} [reason='idle']
 */
function stopActiveSession(reason = 'idle') {
  const sessionId = settings.selectedSessionId || currentSessionId;
  if (!sessionId) return;
  const session = sessions.find(s => s.id === sessionId);
  if (session) session.paused = true;
  settings.selectedSessionId = null;
  currentSessionId = null;
  settings.capturePaused = true;
  idlePrompted = false;
  saveState();
  api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
  api.runtime.sendMessage({ type: 'settingsUpdated', settings });
  api.runtime.sendMessage({ type: 'sessionStopped', reason, sessionId });
}

/**
 * Trigger idle modal if no requests were captured recently.
 */
function checkForIdleSession() {
  if (settings.capturePaused) return;
  const sessionId = settings.selectedSessionId || currentSessionId;
  if (!sessionId) return;
  if (idlePrompted) return;
  if (Date.now() - lastRequestAt < IDLE_TIMEOUT_MS) return;
  idlePrompted = true;
  saveState();
  api.runtime.sendMessage({ type: 'sessionIdle', sessionId });
}

api.runtime.onInstalled?.addListener(() => {
  loadState();
});

api.runtime.onStartup?.addListener(() => {
  loadState();
});

action?.onClicked.addListener(async () => {
  const url = api.runtime.getURL('pages/app.html');
  const tabs = await tabsQuery({ url });
  if (tabs.length) {
    await api.tabs.update(tabs[0].id, { active: true });
    return;
  }
  await api.tabs.create({ url });
});

/**
 * End active session if the app tab is closed.
 * @returns {Promise<void>}
 */
async function endActiveSessionIfClosed() {
  const url = api.runtime.getURL('pages/app.html');
  const tabs = await tabsQuery({ url });
  if (tabs.length) return;
  stopActiveSession('ui-closed');
}

api.tabs.onRemoved.addListener(() => {
  endActiveSessionIfClosed();
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    endActiveSessionIfClosed();
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  if (message.type === 'getSettings') {
    sendResponse({ settings });
    return true;
  }
  if (message.type === 'getState') {
    sendResponse({ settings, requests, sessions, sites, currentSessionId, uatConfigs });
    return true;
  }
  if (message.type === 'setSettings') {
    settings = { ...settings, ...message.settings };
    saveState();
    api.runtime.sendMessage({ type: 'settingsUpdated', settings });
    sendResponse({ ok: true, settings });
    return true;
  }
  if (message.type === 'idleExtend') {
    lastRequestAt = Date.now();
    idlePrompted = false;
    saveState();
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'idleStop') {
    stopActiveSession('idle');
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'setUatConfig') {
    const site = (message.site || '').trim();
    if (!site || !message.config) {
      sendResponse({ ok: false });
      return true;
    }
    if (!sites.includes(site)) sites.unshift(site);
    uatConfigs = { ...uatConfigs, [site]: normalizeUatConfig(message.config) };
    requests.forEach(entry => {
      const session = sessions.find(s => s.id === entry.sessionId);
      if (!session || !session.uatEnabled) return;
      if (session.site !== site) return;
      evaluateUatForRequest(entry);
      api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
    });
    saveState();
    api.runtime.sendMessage({ type: 'sitesUpdated', sites });
    api.runtime.sendMessage({ type: 'uatConfigsUpdated', uatConfigs });
    sendResponse({ ok: true, uatConfigs });
    return true;
  }
  if (message.type === 'clearRequests') {
    const targetSession = settings.selectedSessionId || currentSessionId;
    if (targetSession) {
      requests = requests.filter(r => r.sessionId !== targetSession);
      requestIndex = new Map(requests.map(r => [r.requestId, r]));
    } else {
      requests = [];
      requestIndex = new Map();
    }
    saveState();
    api.runtime.sendMessage({ type: 'requestsCleared' });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'startSession') {
    const site = (message.site || '').trim();
    if (!site) {
      sendResponse({ ok: false, error: 'site_required' });
      return true;
    }
    const name = (message.name || '').trim() || `Session ${sessions.length + 1}`;
    const previousId = settings.selectedSessionId || currentSessionId;
    if (previousId) {
      const previous = sessions.find(s => s.id === previousId);
      if (previous) previous.paused = true;
    }
    const session = createSession(name, site, message.lockTabId || null, !!message.uatEnabled);
    sessions.unshift(session);
    if (!sites.includes(site)) sites.unshift(site);
    currentSessionId = session.id;
    settings.selectedSessionId = session.id;
    settings.capturePaused = false;
    lastRequestAt = Date.now();
    idlePrompted = false;
    saveState();
    api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
    api.runtime.sendMessage({ type: 'settingsUpdated', settings });
    api.runtime.sendMessage({ type: 'sitesUpdated', sites });
    sendResponse({ ok: true, session });
    return true;
  }
  if (message.type === 'renameSession') {
    const session = sessions.find(s => s.id === message.id);
    if (session) session.name = message.name || session.name;
    saveState();
    api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'updateSession') {
    const session = sessions.find(s => s.id === message.id);
    if (!session) {
      sendResponse({ ok: false });
      return true;
    }
    if (message.name !== undefined) session.name = message.name || session.name;
    if (message.site) session.site = message.site;
    if (message.lockTabId !== undefined) session.lockTabId = message.lockTabId;
    if (message.uatEnabled !== undefined) session.uatEnabled = !!message.uatEnabled;
    saveState();
    api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
    sendResponse({ ok: true, session });
    return true;
  }
  if (message.type === 'selectSession') {
    const session = sessions.find(s => s.id === message.id);
    if (session) {
      settings.selectedSessionId = message.id;
      settings.capturePaused = !!session.paused;
      saveState();
      api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
      api.runtime.sendMessage({ type: 'settingsUpdated', settings });
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'pauseSession') {
    const session = sessions.find(s => s.id === message.id);
    if (session) {
      settings.selectedSessionId = session.id;
      currentSessionId = session.id;
      session.paused = true;
      settings.capturePaused = true;
      idlePrompted = false;
      saveState();
      api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
      api.runtime.sendMessage({ type: 'settingsUpdated', settings });
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'deleteSession') {
    const id = message.id;
    if (!id) {
      sendResponse({ ok: false });
      return true;
    }
    sessions = sessions.filter(s => s.id !== id);
    requests = requests.filter(r => r.sessionId !== id);
    requestIndex = new Map(requests.map(r => [r.requestId, r]));
    if (settings.selectedSessionId === id) {
      settings.selectedSessionId = sessions[0]?.id || null;
    }
    if (currentSessionId === id) {
      currentSessionId = settings.selectedSessionId || null;
    }
    idlePrompted = false;
    saveState();
    api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'clearSessions') {
    sessions = [];
    requests = [];
    requestIndex = new Map();
    currentSessionId = null;
    settings.selectedSessionId = null;
    idlePrompted = false;
    saveState();
    api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'clearAllData') {
    sessions = [];
    requests = [];
    requestIndex = new Map();
    sites = [];
    uatConfigs = {};
    currentSessionId = null;
    settings.selectedSessionId = null;
    settings.capturePaused = true;
    idlePrompted = false;
    saveState();
    api.runtime.sendMessage({ type: 'sessionsUpdated', sessions, currentSessionId });
    api.runtime.sendMessage({ type: 'sitesUpdated', sites });
    api.runtime.sendMessage({ type: 'uatConfigsUpdated', uatConfigs });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'capturedPayload') {
    if (!message.payload) {
      sendResponse({ ok: false });
      return true;
    }
    if (settings.capturePaused || !settings.selectedSessionId) {
      debugHookLog('drop: no active session', { url: message.url, requestId: message.requestId });
      sendResponse({ ok: false });
      return true;
    }
    if (!settings.enableHooks) {
      debugHookLog('drop: hooks disabled', { url: message.url, requestId: message.requestId });
      sendResponse({ ok: false });
      return true;
    }
    if (message.url && !isAllowed(message.url)) {
      debugHookLog('drop: url not allowed', { url: message.url });
      sendResponse({ ok: false });
      return true;
    }
    debugHookLog('capturedPayload', {
      url: message.url,
      requestId: message.requestId,
      hookTs: message.hookTs,
      tabId: sender?.tab?.id,
      pageUrl: message.pageUrl
    });
    if (message.requestId) cachePayload(message.requestId, message.payload, message.pageUrl || '');
    if (message.url && sender?.tab?.id !== undefined) {
      cachePayloadByUrl(sender.tab.id, message.url, message.payload, message.pageUrl || '');
      cacheHookPayload(sender.tab.id, message.url, message.payload, message.pageUrl || '', message.hookTs || 0);
    }
    if (message.requestId) attachPayloadToRequests(message.requestId, message.payload, message.pageUrl || '');
    if (message.url && sender?.tab?.id !== undefined) {
      attachPayloadToRequestsByUrl(sender.tab.id, message.url, message.payload, message.pageUrl || '');
    }
    if (message.url) {
      attachHookPayloadToRecent(message.url, sender?.tab?.id, message.payload, message.pageUrl || '', message.hookTs || 0);
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'pageContext') {
    if (settings.capturePaused || !settings.selectedSessionId) {
      debugHookLog('drop: no active session (pageContext)', { url: message.url, requestId: message.requestId });
      sendResponse({ ok: false });
      return true;
    }
    if (!settings.enableHooks) {
      debugHookLog('drop: hooks disabled (pageContext)', { url: message.url, requestId: message.requestId });
      sendResponse({ ok: false });
      return true;
    }
    if (message.url && !isAllowed(message.url)) {
      debugHookLog('drop: url not allowed (pageContext)', { url: message.url });
      sendResponse({ ok: false });
      return true;
    }
    debugHookLog('pageContext', {
      url: message.url,
      requestId: message.requestId,
      hookTs: message.hookTs,
      tabId: sender?.tab?.id,
      pageUrl: message.pageUrl
    });
    if (message.requestId) cachePageContext(message.requestId, message.pageUrl || '');
    if (message.url && sender?.tab?.id !== undefined) {
      cachePageContextByUrl(sender.tab.id, message.url, message.pageUrl || '');
    }
    if (message.requestId) attachPageContextToRequests(message.requestId, message.pageUrl || '');
    if (message.url && sender?.tab?.id !== undefined) {
      attachPageContextToRequestsByUrl(sender.tab.id, message.url, message.pageUrl || '');
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'hookReady') {
    debugHookLog('hook: ready', { tabId: sender?.tab?.id });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'hookCall') {
    debugHookLog('hook: call', { tabId: sender?.tab?.id, kind: message.kind, url: message.url });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'capturedWebsdk') {
    if (!message.payload) {
      sendResponse({ ok: false });
      return true;
    }
    if (settings.capturePaused || !settings.selectedSessionId) {
      debugHookLog('drop: no active session (websdk)', { tabId: sender?.tab?.id });
      sendResponse({ ok: false });
      return true;
    }
    if (!settings.enableHooks) {
      debugHookLog('drop: hooks disabled (websdk)', { tabId: sender?.tab?.id });
      sendResponse({ ok: false });
      return true;
    }
    debugHookLog('capturedWebsdk', { tabId: sender?.tab?.id, hookTs: message.hookTs });
    const tabId = sender?.tab?.id;
    if (tabId !== undefined) {
      attachWebsdkPayloadToRecent(tabId, message.payload, message.pageUrl || '', message.hookTs || 0);
    }
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

api.webRequest.onBeforeRequest.addListener(
  details => {
    if (settings.capturePaused) return;
    if (!isAllowed(details.url)) return;
    const sessionId = settings.selectedSessionId || currentSessionId;
    if (!sessionId) return;
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    if (session?.lockTabId !== null && session?.lockTabId !== undefined) {
      if (details.tabId !== session.lockTabId) return;
    }
    addRequest(details);
    if (settings.debugHooks) {
      debugHookLog('webRequest', {
        url: details.url,
        requestId: details.requestId,
        tabId: details.tabId,
        frameId: details.frameId,
        type: details.type,
        documentUrl: details.documentUrl,
        initiator: details.initiator
      });
    }

    if (details.requestBody) {
      const entry = requestIndex.get(details.requestId);
      if (entry) {
        const parsedBody = parseRawBody(details.requestBody, '');
        if (parsedBody) {
          entry.body = parsedBody;
          if (!entry.pageUrl) {
            entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
          }
        }
        if (settings.debugHooks && (!entry.body || !entry.body.parsed)) {
          debugHookLog('body missing after parse', {
            url: entry.url,
            requestId: entry.requestId,
            tabId: entry.tabId,
            documentUrl: entry.documentUrl,
            initiator: entry.initiator
          });
        }
        evaluateUatForRequest(entry);
        saveState();
        api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

api.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  const existing = navState.get(details.tabId) || { navId: 0, pageUrl: null };
  navState.set(details.tabId, {
    navId: (existing.navId || 0) + 1,
    pageUrl: existing.pageUrl || null,
    pendingUrl: details.url,
    pendingAt: details.timeStamp || Date.now()
  });
  tabUrlCache.set(details.tabId, details.url);
});

api.webNavigation.onCompleted.addListener(details => {
  if (details.frameId !== 0) return;
  const existing = navState.get(details.tabId) || { navId: 0 };
  navState.set(details.tabId, {
    navId: existing.navId || 0,
    pageUrl: existing.pendingUrl || details.url,
    pendingUrl: null,
    pendingAt: null
  });
  tabUrlCache.set(details.tabId, details.url);
});

api.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  const existing = navState.get(details.tabId) || { navId: 0 };
  navState.set(details.tabId, {
    navId: (existing.navId || 0) + 1,
    pageUrl: details.url,
    pendingUrl: null,
    pendingAt: null
  });
  tabUrlCache.set(details.tabId, details.url);
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    tabUrlCache.set(tabId, changeInfo.url);
  }
  if (changeInfo.status === 'complete' && tab?.url) {
    tabUrlCache.set(tabId, tab.url);
  }
});

api.tabs.onRemoved.addListener(tabId => {
  tabUrlCache.delete(tabId);
  navState.delete(tabId);
  Array.from(hookQueueByTabUrl.keys()).forEach(key => {
    if (key.startsWith(`${tabId}::`)) hookQueueByTabUrl.delete(key);
  });
});

const payloadCache = new Map();
const PAYLOAD_TTL_MS = 2 * 60 * 1000;

/**
 * Cache payload by requestId.
 * @param {string} requestId
 * @param {object} payload
 * @param {string} [pageUrl='']
 */
function cachePayload(requestId, payload, pageUrl = '') {
  const existing = payloadCache.get(requestId);
  payloadCache.set(requestId, {
    payload,
    pageUrl: pageUrl || existing?.pageUrl || '',
    ts: Date.now()
  });
  prunePayloadCache();
}

/**
 * Cache page context by requestId without a payload.
 * @param {string} requestId
 * @param {string} pageUrl
 */
function cachePageContext(requestId, pageUrl = '') {
  if (!requestId || !pageUrl) return;
  const existing = payloadCache.get(requestId);
  if (existing?.payload) return;
  payloadCache.set(requestId, { payload: null, pageUrl, ts: Date.now() });
  prunePayloadCache();
}
/**
 * Pull cached payload by requestId (one-time).
 * @param {string} requestId
 * @returns {object|null}
 */
function pullCachedPayload(requestId) {
  const entry = payloadCache.get(requestId);
  if (!entry) return null;
  if (Date.now() - entry.ts > PAYLOAD_TTL_MS) {
    payloadCache.delete(requestId);
    return null;
  }
  payloadCache.delete(requestId);
  return entry || null;
}

/**
 * Prune expired payload entries.
 */
function prunePayloadCache() {
  const now = Date.now();
  for (const [key, value] of payloadCache.entries()) {
    if (now - value.ts > PAYLOAD_TTL_MS) payloadCache.delete(key);
  }
}

/**
 * Cache payload by tab + URL.
 * @param {number} tabId
 * @param {string} url
 * @param {object} payload
 * @param {string} [pageUrl='']
 */
function cachePayloadByUrl(tabId, url, payload, pageUrl = '') {
  if (tabId === undefined || !url) return;
  const list = payloadCacheByUrlTab.get(tabId) || [];
  list.push({ url, payload, pageUrl, ts: Date.now() });
  payloadCacheByUrlTab.set(tabId, list);
  prunePayloadCacheByUrl(tabId);
}

function cacheHookPayload(tabId, url, payload, pageUrl = '', hookTs = 0) {
  if (tabId === undefined || !url) return;
  const key = `${tabId}::${url}`;
  const list = hookQueueByTabUrl.get(key) || [];
  list.push({ payload, pageUrl, ts: hookTs || Date.now() });
  hookQueueByTabUrl.set(key, list);
  pruneHookQueue(key);

  const urlList = hookQueueByUrl.get(url) || [];
  urlList.push({ payload, pageUrl, ts: hookTs || Date.now() });
  hookQueueByUrl.set(url, urlList);
  pruneHookQueueByUrl(url);
}

function pullHookPayload(tabId, url, timeStamp) {
  if (tabId === undefined || !url) return null;
  const key = `${tabId}::${url}`;
  const list = hookQueueByTabUrl.get(key) || [];
  if (!list.length) return null;
  const now = Date.now();
  const matchIndex = list.findIndex(entry => Math.abs((timeStamp || now) - entry.ts) < 20000);
  if (matchIndex === -1) return null;
  const [entry] = list.splice(matchIndex, 1);
  hookQueueByTabUrl.set(key, list);
  debugHookLog('pull: hookQueue tab+url', { url, tabId, hookTs: entry.ts });
  return entry;
}

function pruneHookQueue(key) {
  const list = hookQueueByTabUrl.get(key) || [];
  const now = Date.now();
  const filtered = list.filter(entry => now - entry.ts <= PAYLOAD_TTL_MS);
  hookQueueByTabUrl.set(key, filtered);
}

function pullHookPayloadByUrl(url, timeStamp) {
  if (!url) return null;
  const list = hookQueueByUrl.get(url) || [];
  if (!list.length) return null;
  const now = Date.now();
  const matchIndex = list.findIndex(entry => Math.abs((timeStamp || now) - entry.ts) < 20000);
  if (matchIndex === -1) return null;
  const [entry] = list.splice(matchIndex, 1);
  hookQueueByUrl.set(url, list);
  debugHookLog('pull: hookQueue url', { url, hookTs: entry.ts });
  return entry;
}

function pruneHookQueueByUrl(url) {
  const list = hookQueueByUrl.get(url) || [];
  const now = Date.now();
  const filtered = list.filter(entry => now - entry.ts <= PAYLOAD_TTL_MS);
  hookQueueByUrl.set(url, filtered);
}

/**
 * Cache page context by tab + URL without a payload.
 * @param {number} tabId
 * @param {string} url
 * @param {string} pageUrl
 */
function cachePageContextByUrl(tabId, url, pageUrl = '') {
  if (tabId === undefined || !url || !pageUrl) return;
  const list = payloadCacheByUrlTab.get(tabId) || [];
  const existing = list.find(entry => entry.url === url && entry.payload);
  if (existing) return;
  list.push({ url, payload: null, pageUrl, ts: Date.now() });
  payloadCacheByUrlTab.set(tabId, list);
  prunePayloadCacheByUrl(tabId);
}

/**
 * Pull cached payload for a tab + URL near a timestamp.
 * @param {number} tabId
 * @param {string} url
 * @param {number} timeStamp
 * @returns {object|null}
 */
function pullCachedPayloadByUrl(tabId, url, timeStamp) {
  if (tabId === undefined || !url) return null;
  const list = payloadCacheByUrlTab.get(tabId) || [];
  const now = Date.now();
  const matchIndex = list.findIndex(entry => entry.url === url && Math.abs((timeStamp || now) - entry.ts) < 15000);
  if (matchIndex === -1) return null;
  const [entry] = list.splice(matchIndex, 1);
  payloadCacheByUrlTab.set(tabId, list);
  return entry || null;
}

/**
 * Prune expired payload cache entries for a tab.
 * @param {number} tabId
 */
function prunePayloadCacheByUrl(tabId) {
  const list = payloadCacheByUrlTab.get(tabId) || [];
  const now = Date.now();
  const filtered = list.filter(entry => now - entry.ts <= PAYLOAD_TTL_MS);
  payloadCacheByUrlTab.set(tabId, filtered);
}

/**
 * Extract requestId query param from URL.
 * @param {string} url
 * @returns {string|null}
 */
function getRequestIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('requestId');
  } catch {
    return null;
  }
}

/**
 * Attempt to infer a page URL from known query params.
 * @param {string} url
 * @returns {string|null}
 */
function extractPageUrlFromRequest(url) {
  try {
    const parsed = new URL(url);
    const candidates = [
      'dl',
      'documentLocation',
      'document_location',
      'page_location',
      'pageLocation',
      'u',
      'url'
    ];
    for (const key of candidates) {
      const value = parsed.searchParams.get(key);
      if (!value) continue;
      const decoded = decodeURIComponent(value);
      if (decoded.startsWith('http')) return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt to infer a page URL from a request payload.
 * @param {object} body
 * @returns {string|null}
 */
function extractPageUrlFromPayload(body) {
  if (!body) return null;
  const payload = body.parsed && typeof body.parsed === 'object' ? body.parsed : null;
  if (!payload) return null;
  const candidates = [
    payload?.events?.[0]?.web?.webPageDetails?.URL,
    payload?.events?.[0]?.xdm?.web?.webPageDetails?.URL,
    payload?.xdm?.web?.webPageDetails?.URL,
    payload?.web?.webPageDetails?.URL
  ];
  const found = candidates.find(value => typeof value === 'string' && value.startsWith('http'));
  return found || null;
}

/**
 * Attach cached payload to matching requests by requestId.
 * @param {string} requestId
 * @param {object} payload
 * @param {string} [pageUrl='']
 */
function attachPayloadToRequests(requestId, payload, pageUrl = '') {
  if (!requestId) return;
  let updated = false;
  requests.forEach(entry => {
    if (!shouldReplaceBody(entry.body, payload)) return;
    const idInUrl = getRequestIdFromUrl(entry.url);
    if (idInUrl && idInUrl === requestId) {
      debugHookLog('attach: requestId match', { requestId, url: entry.url, id: entry.id });
      entry.body = payload;
      if ((!entry.pageUrl || entry.pageUrl === '/') && pageUrl) entry.pageUrl = pageUrl;
      if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
        entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
      }
      evaluateUatForRequest(entry);
      updated = true;
      api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
    }
  });
  if (updated) saveState();
}

/**
 * Attach cached payload to matching requests by tab and URL.
 * @param {number} tabId
 * @param {string} url
 * @param {object} payload
 * @param {string} [pageUrl='']
 */
function attachPayloadToRequestsByUrl(tabId, url, payload, pageUrl = '') {
  if (tabId === undefined || !url) return;
  let updated = false;
  requests.forEach(entry => {
    if (!shouldReplaceBody(entry.body, payload)) return;
    if (entry.tabId !== tabId) return;
    if (entry.url !== url) return;
    debugHookLog('attach: tab+url match', { url, tabId, id: entry.id });
    entry.body = payload;
    if ((!entry.pageUrl || entry.pageUrl === '/') && pageUrl) entry.pageUrl = pageUrl;
    if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
      entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
    }
    evaluateUatForRequest(entry);
    updated = true;
    api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
  });
  if (updated) saveState();
}

/**
 * Attach page URL context to requests by requestId.
 * @param {string} requestId
 * @param {string} pageUrl
 */
function attachPageContextToRequests(requestId, pageUrl = '') {
  if (!requestId || !pageUrl) return;
  let updated = false;
  requests.forEach(entry => {
    if (entry.pageUrl && entry.pageUrl !== '/') return;
    const idInUrl = getRequestIdFromUrl(entry.url);
    if (idInUrl && idInUrl === requestId) {
      entry.pageUrl = pageUrl;
      updated = true;
      api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
    }
  });
  if (updated) saveState();
}

/**
 * Attach page URL context to requests by tab and URL.
 * @param {number} tabId
 * @param {string} url
 * @param {string} pageUrl
 */
function attachPageContextToRequestsByUrl(tabId, url, pageUrl = '') {
  if (tabId === undefined || !url || !pageUrl) return;
  let updated = false;
  requests.forEach(entry => {
    if (entry.pageUrl && entry.pageUrl !== '/') return;
    if (entry.tabId !== tabId) return;
    if (entry.url !== url) return;
    entry.pageUrl = pageUrl;
    updated = true;
    api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
  });
  if (updated) saveState();
}

function attachHookPayloadToRecent(url, tabId, payload, pageUrl, hookTs) {
  if (!url || !payload) return;
  const now = Date.now();
  const candidates = requests.filter(entry => entry.url === url);
  if (!candidates.length) return;
  const filtered = candidates
    .filter(entry => tabId === undefined || entry.tabId === tabId)
    .filter(entry => Math.abs((hookTs || now) - (entry.timeStamp || now)) < 20000);
  if (!filtered.length) return;
  const entry = filtered.reduce((best, item) => {
    if (!best) return item;
    return (item.timeStamp || 0) > (best.timeStamp || 0) ? item : best;
  }, null);
  if (!entry) return;
  if (!shouldReplaceBody(entry.body, payload)) return;
  debugHookLog('attach: recent url match', { url, tabId, id: entry.id, hookTs });
  entry.body = payload;
  if ((!entry.pageUrl || entry.pageUrl === '/') && pageUrl) entry.pageUrl = pageUrl;
  if ((!entry.pageUrl || entry.pageUrl === '/') && entry.body) {
    entry.pageUrl = extractPageUrlFromPayload(entry.body) || entry.pageUrl;
  }
  evaluateUatForRequest(entry);
  saveState();
  api.runtime.sendMessage({ type: 'requestUpdated', request: entry });
}

/**
 * Check whether a request body is empty.
 * @param {object|null} body
 * @returns {boolean}
 */
function isBodyEmpty(body) {
  if (!body) return true;
  if (body.parsed) {
    if (Array.isArray(body.parsed?.params)) return body.parsed.params.length === 0;
    if (typeof body.parsed === 'object') return Object.keys(body.parsed).length === 0;
    return false;
  }
  if (typeof body.raw === 'string') return body.raw.length === 0;
  return false;
}

/**
 * Decide whether to replace an existing body with a hook payload.
 * @param {object|null} existing
 * @param {object|null} incoming
 * @returns {boolean}
 */
function shouldReplaceBody(existing, incoming) {
  if (!incoming) return false;
  if (isBodyEmpty(existing)) return true;
  if (!existing) return true;
  const incomingParsed = incoming.parsed && typeof incoming.parsed === 'object' ? incoming.parsed : null;
  const existingParsed = existing?.parsed && typeof existing.parsed === 'object' ? existing.parsed : null;
  if (!incomingParsed) return false;
  const incomingHasEvents = !!(incomingParsed.events || incomingParsed.xdm || incomingParsed._experience || incomingParsed.data);
  if (!incomingHasEvents) return false;
  const existingHasEvents = !!(existingParsed?.events || existingParsed?.xdm || existingParsed?._experience || existingParsed?.data);
  if (!existingHasEvents) return true;
  const existingRawLen = typeof existing?.raw === 'string' ? existing.raw.length : 0;
  const incomingRawLen = typeof incoming?.raw === 'string' ? incoming.raw.length : 0;
  return incomingRawLen > existingRawLen && incomingHasEvents;
}

api.webRequest.onBeforeSendHeaders.addListener(
  details => {
    if (settings.capturePaused) return;
    if (!isAllowed(details.url)) return;
    const headers = (details.requestHeaders || []).map(h => ({
      name: h.name,
      value: h.value
    }));
    const contentTypeHeader = headers.find(h => h.name.toLowerCase() === 'content-type');
    const contentType = contentTypeHeader ? contentTypeHeader.value : '';
    const entry = requestIndex.get(details.requestId);
    if (entry && entry.body && entry.body.contentType === '') entry.body.contentType = contentType;
    updateRequest(details.requestId, { requestHeaders: headers });
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

api.webRequest.onCompleted.addListener(
  details => {
    if (!isAllowed(details.url)) return;
    const entry = requestIndex.get(details.requestId);
    const duration = entry ? details.timeStamp - entry.startTime : null;
    updateRequest(details.requestId, {
      statusCode: details.statusCode,
      statusLine: details.statusLine || null,
      duration
    });
  },
  { urls: ['<all_urls>'] }
);

api.webRequest.onErrorOccurred.addListener(
  details => {
    if (!isAllowed(details.url)) return;
    updateRequest(details.requestId, {
      statusCode: null,
      statusLine: details.error || 'error'
    });
  },
  { urls: ['<all_urls>'] }
);

loadState();
setInterval(() => {
  checkForIdleSession();
}, 60 * 1000);

/**
 * Create a new session object.
 * @param {string} name
 * @param {string} site
 * @param {number|null} lockTabId
 * @param {boolean} uatEnabled
 * @returns {object}
 */
function createSession(name, site, lockTabId, uatEnabled) {
  return {
    id: `session-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name,
    site,
    lockTabId: lockTabId ?? null,
    paused: false,
    createdAt: Date.now(),
    uatEnabled: !!uatEnabled
  };
}
