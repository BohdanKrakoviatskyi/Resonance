import assert from 'node:assert/strict';
import test from 'node:test';
import { integrationOptions } from './integration-options.ts';

test('places the check icon only on the selected integration state', () => {
  assert.deepEqual(integrationOptions(false, 'Enabled', 'Disabled'), [
    { value: 'on', label: 'Enabled' },
    { value: 'off', label: 'Disabled', icon: 'check' },
  ]);
  assert.deepEqual(integrationOptions(true, 'Enabled', 'Disabled'), [
    { value: 'on', label: 'Enabled', icon: 'check' },
    { value: 'off', label: 'Disabled' },
  ]);
});
