/**
 * The one canned extension state shared by the jsdom tests and the browser
 * preview harness (scripts/preview.mjs), so the two can never disagree about
 * what the app is rendering.
 *
 * Deliberately free of jsdom and of any DOM API: the preview server imports
 * it in a plain Node process.
 */

/**
 * Build a canned extension state for the stubs to serve.
 * @returns {object}
 */
export function sampleState() {
  const now = Date.now();
  const payload = name => ({
    events: [{ xdm: { eventType: 'web.webpagedetails.pageViews', web: { webPageDetails: { name, URL: 'https://example.com/checkout' } } } }]
  });
  const results = fail => ([
    {
      id: 'a1', title: 'Datastream id is production', description: '', status: 'passed',
      applicable: true, scope: 'request', conditions: [],
      validations: [{ source: 'query', path: 'configId', operator: 'equals', expected: 'abc-123', actual: ['abc-123'], passed: true }],
      count: null
    },
    {
      id: 'a2', title: 'Page name is present', description: '', status: fail ? 'failed' : 'passed',
      applicable: true, scope: 'request', conditions: [],
      validations: [{ source: 'payload', path: 'events[0].xdm.web.webPageDetails.name', operator: 'exists', actual: fail ? [] : ['Checkout'], passed: !fail }],
      count: null
    }
  ]);
  const mk = (i, over = {}) => ({
    id: `r${i}:${now - i * 1000}`,
    requestId: `r${i}`,
    sessionId: 's1',
    tabId: 1,
    frameId: 0,
    method: 'POST',
    statusCode: 204,
    duration: 40,
    url: `https://edge.adobedc.net/ee/v2/interact?configId=abc-123&requestId=r${i}`,
    domain: 'edge.adobedc.net',
    serviceId: 'adobe-edge',
    path: '/ee/v2/interact',
    timeStamp: now - i * 1000,
    startTime: now - i * 1000,
    pageUrl: 'https://example.com/checkout',
    navId: 1,
    requestHeaders: [{ name: 'content-type', value: 'application/json' }],
    query: { raw: 'configId=abc-123', params: [{ key: 'configId', value: 'abc-123' }] },
    body: { type: 'json', contentType: 'application/json', raw: JSON.stringify(payload('Checkout')), parsed: payload('Checkout') },
    uat: { status: 'done', results: results(false) },
    ...over
  });

  const requests = [
    mk(1),
    mk(2, { uat: { status: 'done', results: results(true) } }),
    mk(3, { domain: 'www.google-analytics.com', serviceId: 'google-analytics', path: '/g/collect', uat: { status: 'done', results: [] } })
  ];
  const sessions = [
    { id: 's1', name: 'Checkout flow', site: 'Production', lockTabId: 1, paused: false, createdAt: now - 60000, uatEnabled: true },
    { id: 's2', name: 'Smoke test', site: 'Staging', lockTabId: null, paused: true, createdAt: now - 90000, uatEnabled: false }
  ];
  const settings = {
    allowlist: ['edge.adobedc.net', 'google-analytics.com'],
    capturePaused: false, maxEntries: 2000, selectedSessionId: 's1',
    enableHooks: true, debugHooks: false, serviceMappings: []
  };
  return {
    settings, requests, sessions,
    sites: ['Production', 'Staging'],
    currentSessionId: 's1',
    uatConfigs: { Production: { siteId: 'Production', global: null, assertions: [] } }
  };
}
