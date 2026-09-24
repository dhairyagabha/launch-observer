import { parseKeyValuePairs, tryParseJson } from '../parse.js';

/**
 * Resolve condition value(s) from a request.
 * @param {object} condition
 * @param {object} request
 * @returns {{ used: boolean, values: Array<any> }}
 */
export function resolveConditionValue(condition, request) {
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
 * Memoized payload objects, keyed by the body object they were derived from.
 *
 * Resolving a payload re-parses `body.raw`, which is up to 200 KB of JSON. A
 * single request is resolved once per condition, per validation, per assertion
 * — and again for every request in the page group when counting page-scope
 * matches. Keying on the body object means a replaced body (hook payloads
 * overwrite `entry.body`) naturally misses the cache.
 *
 * @type {WeakMap<object, object|null>}
 */
const payloadCache = new WeakMap();

/**
 * Convert request body into a traversable object.
 * @param {object} request
 * @returns {object|null}
 */
function getPayloadObject(request) {
  const body = request?.body;
  if (!body) return null;
  if (payloadCache.has(body)) return payloadCache.get(body);
  const payload = buildPayloadObject(body);
  payloadCache.set(body, payload);
  return payload;
}

/**
 * Derive a traversable object from a request body.
 * @param {object} body
 * @returns {object|null}
 */
function buildPayloadObject(body) {
  const rawValue = body.raw;
  const raw = typeof rawValue === 'string' ? rawValue : null;
  if (raw !== null) {
    const json = tryParseJson(raw);
    if (json) return json;
  }
  if (body.parsed && typeof body.parsed === 'object') return body.parsed;
  if (raw !== null) {
    const form = parseKeyValuePairs(raw, true);
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
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function getValueAtPath(obj, path) {
  if (!path) return obj;
  const tokens = parsePath(path);
  let current = obj;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof token === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
    } else {
      // Paths address captured payload data only; never walk the prototype chain.
      if (BLOCKED_KEYS.has(token)) return undefined;
      if (typeof current !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
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
 * @param {(condition: object, values: Array<any>) => boolean} evaluateCondition
 * @returns {number}
 */
export function countAssertionMatches(assertion, allRequests, request, evaluateCondition) {
  if (!Array.isArray(allRequests)) return 0;
  const conditions = Array.isArray(assertion.conditions) ? assertion.conditions : [];
  const validations = Array.isArray(assertion.validations) ? assertion.validations : [];
  const anyLogic = assertion.conditionsLogic === 'any';
  const pageKey = pageKeyFor(request);
  let count = 0;
  for (const item of allRequests) {
    if (pageKeyFor(item) !== pageKey) continue;
    if (conditions.length) {
      const conditionsPass = anyLogic
        ? conditions.some(condition => evaluateCondition(condition, resolveConditionValue(condition, item).values))
        : conditions.every(condition => evaluateCondition(condition, resolveConditionValue(condition, item).values));
      if (!conditionsPass) continue;
    }
    const passes = validations.every(condition => evaluateCondition(condition, resolveConditionValue(condition, item).values));
    if (passes) count += 1;
  }
  return count;
}

/**
 * Build the page-navigation key a request belongs to.
 * @param {object} request
 * @returns {string}
 */
function pageKeyFor(request) {
  const base = request.pageUrl || request.url;
  return request.navId ? `${base}::${request.navId}` : base;
}
