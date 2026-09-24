import { countAssertionMatches, resolveConditionValue } from './resolve.js';

/**
 * Evaluate all applicable assertions for a single request.
 * @param {object} request
 * @param {Array<object>} assertions
 * @param {Array<object>} allRequests
 * @param {{ global?: object|null, serviceId?: string|null }} [options]
 * @returns {Array<object>}
 */
export function evaluateAssertionsForRequest(request, assertions, allRequests, options = {}) {
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
    if (isPageScope && assertion.count && assertion.value != null) {
      const count = countAssertionMatches(assertion, allRequests, request, evaluateCondition);
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
export function evaluateGlobalGate(request, globalConfig, serviceId) {
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
 * Every operator `evaluateCondition` below implements.
 *
 * Declared next to the switch so the two cannot drift; the config validator
 * imports this rather than keeping its own copy.
 * @type {ReadonlyArray<string>}
 */
export const OPERATORS = Object.freeze([
  'exists', 'not_exists', 'equals', 'contains', 'starts_with', 'ends_with',
  'regex', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'range'
]);

/**
 * Operators that are meaningless without an `expected` value.
 * @type {ReadonlyArray<string>}
 */
export const OPERATORS_REQUIRING_EXPECTED = Object.freeze([
  'equals', 'contains', 'starts_with', 'ends_with', 'regex', 'in', 'not_in',
  'gt', 'gte', 'lt', 'lte', 'range'
]);

/**
 * Valid condition sources.
 * @type {ReadonlyArray<string>}
 */
export const SOURCES = Object.freeze(['payload', 'query', 'headers', 'raw']);

const MAX_REGEX_SOURCE = 1000;
const MAX_REGEX_SUBJECT = 10000;
const regexCache = new Map();

/**
 * Compile and cache a user-supplied regex from a UAT config.
 * @param {any} expected
 * @returns {RegExp|null}
 */
function compileRegex(expected) {
  const source = String(expected);
  if (!source || source.length > MAX_REGEX_SOURCE) return null;
  if (regexCache.has(source)) return regexCache.get(source);
  let regex = null;
  try {
    regex = new RegExp(source);
  } catch {
    regex = null;
  }
  // Configs hold a fixed set of patterns; the cache is bounded in practice.
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(source, regex);
  return regex;
}

/**
 * Evaluate a single condition against resolved values.
 * @param {object} condition
 * @param {Array|any} values
 * @returns {boolean}
 */
export function evaluateCondition(condition, values) {
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
      const regex = compileRegex(expected);
      if (!regex) return false;
      return list.some(v => {
        const subject = String(v);
        // Bound the subject: a catastrophically backtracking pattern from an
        // imported config would otherwise hang the background script.
        return regex.test(subject.length > MAX_REGEX_SUBJECT ? subject.slice(0, MAX_REGEX_SUBJECT) : subject);
      });
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
      const [min, max] = Array.isArray(expected) ? expected : [];
      return list.some(v => Number(v) >= Number(min) && Number(v) <= Number(max));
    }
    default:
      return false;
  }
}

/**
 * Evaluate count rule for page-level assertions.
 * @param {string} mode
 * @param {number} actual
 * @param {number} expected
 * @returns {boolean}
 */
export function evaluateCount(mode, actual, expected) {
  const expectedNumber = Number(expected);
  if (!Number.isFinite(expectedNumber)) return false;
  if (mode === 'at_least') return actual >= expectedNumber;
  if (mode === 'at_most') return actual <= expectedNumber;
  return actual === expectedNumber;
}
