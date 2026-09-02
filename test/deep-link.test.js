import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAttentionUrl, MAX_PARAMETER_LENGTH, parseDeepLink } from '../public/deep-link.js';

test('parseDeepLink reads attention metadata and normalizes status aliases', () => {
  const link = parseDeepLink('?view=attention&pane=pane%2F1&workspace=work%201&event=pane_agent_detected&status=needs-intervention&agent=codex');
  assert.deepEqual(link, {
    view: 'attention',
    pane: 'pane/1',
    workspace: 'work 1',
    event: 'pane_agent_detected',
    status: 'blocked',
    agent: 'codex',
    hasContext: true,
  });
});

test('parseDeepLink keeps older pane links compatible and rejects unsafe parameters', () => {
  const legacy = parseDeepLink('?pane=p1&workspace=w1');
  assert.equal(legacy.view, '');
  assert.equal(legacy.pane, 'p1');
  assert.equal(legacy.workspace, 'w1');
  assert.equal(legacy.hasContext, true);

  const oversized = parseDeepLink(`?view=attention&pane=${'x'.repeat(MAX_PARAMETER_LENGTH + 1)}`);
  assert.equal(oversized.pane, '');
  assert.equal(oversized.hasContext, false);

  const controls = parseDeepLink('?view=attention&pane=p1%00secret&status=done');
  assert.equal(controls.pane, '');
  assert.equal(controls.status, 'done');
  assert.equal(controls.hasContext, false);
});

test('buildAttentionUrl emits only bounded, encoded action metadata', () => {
  const url = buildAttentionUrl({
    pane_id: 'pane/1?x=1',
    workspace_id: 'work & one',
    event: 'pane_agent_detected',
    status: 'blocked',
    agent: 'codex',
  });
  assert.equal(url, '/?view=attention&pane=pane%2F1%3Fx%3D1&workspace=work+%26+one&event=pane_agent_detected&status=blocked&agent=codex');
  assert.doesNotMatch(url, /(?:output|read|title)=/);

  const unsafe = buildAttentionUrl({ pane: `p${'x'.repeat(MAX_PARAMETER_LENGTH + 1)}`, status: 'done' });
  assert.equal(unsafe, '/?view=attention&status=done');
});
