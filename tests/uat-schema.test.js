import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUatConfig, validateUatConfig, buildUatTemplate } from '../lib/uat/schema.js';
import { OPERATORS, OPERATORS_REQUIRING_EXPECTED, SOURCES, evaluateCondition } from '../lib/uat/evaluate.js';

const baseAssertion = (overrides = {}) => ({
  id: 'a1',
  validations: [{ source: 'payload', path: 'x', operator: 'exists' }],
  ...overrides
});

test('the shipped template validates', () => {
  assert.deepEqual(validateUatConfig(buildUatTemplate('example')), []);
});

test('an unknown operator is reported instead of silently failing', () => {
  const errors = validateUatConfig({
    assertions: [baseAssertion({ validations: [{ path: 'x', operator: 'equal', expected: 'y' }] })]
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown operator "equal"/);
});

test('an unknown source is reported', () => {
  const errors = validateUatConfig({
    assertions: [baseAssertion({ validations: [{ source: 'payloads', path: 'x', operator: 'exists' }] })]
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown source "payloads"/);
});

test('every declared operator is actually implemented', () => {
  for (const operator of OPERATORS) {
    const errors = validateUatConfig({
      assertions: [baseAssertion({
        validations: [{
          path: 'x',
          operator,
          expected: operator === 'range' ? [1, 2] : 'v'
        }]
      })]
    });
    assert.deepEqual(errors, [], `operator ${operator} should validate`);
    // Reaching the switch default would mean the list and the switch disagree.
    assert.equal(typeof evaluateCondition({ operator, expected: 'v' }, ['v']), 'boolean');
  }
});

test('operators needing an expected value are a subset of all operators', () => {
  for (const operator of OPERATORS_REQUIRING_EXPECTED) {
    assert.ok(OPERATORS.includes(operator), `${operator} missing from OPERATORS`);
  }
  assert.ok(SOURCES.includes('payload'));
});

test('range requires a two-number expected value', () => {
  const bad = validateUatConfig({
    assertions: [baseAssertion({ validations: [{ path: 'x', operator: 'range', expected: 5 }] })]
  });
  assert.match(bad[0], /\[min, max\]/);

  const good = validateUatConfig({
    assertions: [baseAssertion({ validations: [{ path: 'x', operator: 'range', expected: [1, 5] }] })]
  });
  assert.deepEqual(good, []);
});

test('an invalid regex is reported at import time', () => {
  const errors = validateUatConfig({
    assertions: [baseAssertion({ validations: [{ path: 'x', operator: 'regex', expected: '([' }] })]
  });
  assert.match(errors[0], /invalid regular expression/);
});

test('duplicate assertion ids are reported', () => {
  const errors = validateUatConfig({
    assertions: [baseAssertion(), baseAssertion()]
  });
  assert.match(errors[0], /reuses id "a1"/);
});

test('page-scope assertions need a count and numeric value', () => {
  const errors = validateUatConfig({
    assertions: [baseAssertion({ scope: 'page' })]
  });
  assert.equal(errors.length, 2);
  assert.match(errors.join(' '), /valid count/);
  assert.match(errors.join(' '), /numeric value/);
});

test('count values are coerced to numbers on normalize', () => {
  const config = normalizeUatConfig({
    assertions: [baseAssertion({ scope: 'page', count: 'exactly', value: '2' })]
  });
  assert.equal(config.assertions[0].value, 2);

  const missing = normalizeUatConfig({ assertions: [baseAssertion()] });
  assert.equal(missing.assertions[0].value, null);
});

test('global gates are validated like assertion conditions', () => {
  const errors = validateUatConfig({
    global: { includeConditions: [{ path: 'x', operator: 'nope' }] },
    assertions: [baseAssertion()]
  });
  assert.match(errors[0], /Global include condition 1 has unknown operator/);
});
