import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAssertionsForRequest } from '../lib/uat/evaluate.js';

const assertion = {
  id: 'medallia-form-shown',
  conditionsLogic: 'all',
  conditions: [
    {
      source: 'payload',
      path: 'events[0].xdm.web.webInteraction.name',
      operator: 'equals',
      expected: 'Medallia Form Shown'
    }
  ],
  validations: [
    {
      source: 'payload',
      path: 'events[0].xdm.eventType',
      operator: 'equals',
      expected: 'web.webinteraction.linkClicks'
    }
  ],
  scope: 'request'
};

const payload = {
  events: [
    {
      xdm: {
        eventType: 'web.webinteraction.linkClicks',
        web: {
          webInteraction: {
            name: 'Medallia Form Shown',
            linkClicks: { value: 1 }
          }
        }
      }
    }
  ]
};

const raw = JSON.stringify(payload);

function evaluate(body) {
  const request = {
    body,
    pageUrl: 'https://www.qa.thermofisher.com/us/en/home.html'
  };
  return evaluateAssertionsForRequest(request, [assertion], [request])[0];
}

test('resolves path values from parsed JSON', () => {
  const result = evaluate({ type: 'json', raw, parsed: payload });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.conditions[0].actual, ['Medallia Form Shown']);
});

test('falls back to valid raw JSON when parsed payload is empty', () => {
  const result = evaluate({ type: 'text', raw, parsed: {} });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.conditions[0].actual, ['Medallia Form Shown']);
});

test('falls back to valid raw JSON when parsed payload is a form wrapper', () => {
  const result = evaluate({
    type: 'form',
    raw,
    parsed: { raw: '', params: [] }
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.conditions[0].actual, ['Medallia Form Shown']);
});

test('uses parsed payload when raw body is unavailable', () => {
  const result = evaluate({ type: 'json', parsed: payload });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.conditions[0].actual, ['Medallia Form Shown']);
});
