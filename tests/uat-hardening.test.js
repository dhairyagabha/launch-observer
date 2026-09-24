import test from 'node:test';
import assert from 'node:assert/strict';
import { getValueAtPath, resolveConditionValue, countAssertionMatches } from '../lib/uat/resolve.js';
import { evaluateCondition } from '../lib/uat/evaluate.js';

test('paths cannot walk the prototype chain', () => {
  const payload = { events: [{ name: 'a' }] };
  assert.equal(getValueAtPath(payload, '__proto__'), undefined);
  assert.equal(getValueAtPath(payload, 'constructor'), undefined);
  assert.equal(getValueAtPath(payload, 'constructor.prototype'), undefined);
  assert.equal(getValueAtPath(payload, 'events.constructor'), undefined);
  assert.equal(getValueAtPath(payload, 'events[0].toString'), undefined);
  // Own properties are still reachable, including array length.
  assert.equal(getValueAtPath(payload, 'events.length'), 1);
  assert.equal(getValueAtPath(payload, 'events[0].name'), 'a');
});

test('payload objects are parsed once per body', () => {
  let parses = 0;
  const raw = JSON.stringify({ a: { b: 'c' } });
  const body = {
    type: 'json',
    get raw() {
      parses += 1;
      return raw;
    },
    parsed: null
  };
  const request = { body };
  const condition = { source: 'payload', path: 'a.b', operator: 'equals', expected: 'c' };

  assert.deepEqual(resolveConditionValue(condition, request).values, ['c']);
  const afterFirst = parses;
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(resolveConditionValue(condition, request).values, ['c']);
  }
  assert.equal(parses, afterFirst, 'repeat resolution must not re-read the body');
  assert.equal(afterFirst, 1, 'the first resolution should read the body once');
});

test('replacing a body invalidates the cached payload', () => {
  const request = { body: { type: 'json', raw: JSON.stringify({ v: 1 }), parsed: null } };
  const condition = { source: 'payload', path: 'v' };
  assert.deepEqual(resolveConditionValue(condition, request).values, [1]);

  request.body = { type: 'json', raw: JSON.stringify({ v: 2 }), parsed: null };
  assert.deepEqual(resolveConditionValue(condition, request).values, [2]);
});

test('oversized regex patterns are rejected rather than run', () => {
  const condition = { operator: 'regex', expected: `${'a?'.repeat(600)}${'a'.repeat(600)}` };
  const started = Date.now();
  assert.equal(evaluateCondition(condition, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']), false);
  assert.ok(Date.now() - started < 1000, 'evaluation should not backtrack');
});

test('valid regex conditions still match', () => {
  const condition = { operator: 'regex', expected: '^form-(shown|sent)$' };
  assert.equal(evaluateCondition(condition, ['form-shown']), true);
  assert.equal(evaluateCondition(condition, ['form-closed']), false);
});

test('page-scope counting matches requests on the same navigation', () => {
  const assertion = {
    conditions: [],
    validations: [{ source: 'payload', path: 'eventType', operator: 'equals', expected: 'view' }]
  };
  const make = (navId, eventType) => ({
    pageUrl: 'https://example.com/a',
    navId,
    body: { type: 'json', raw: JSON.stringify({ eventType }), parsed: null }
  });
  const all = [make(1, 'view'), make(1, 'view'), make(1, 'click'), make(2, 'view')];

  assert.equal(countAssertionMatches(assertion, all, all[0], evaluateCondition), 2);
  assert.equal(countAssertionMatches(assertion, all, all[3], evaluateCondition), 1);
});
