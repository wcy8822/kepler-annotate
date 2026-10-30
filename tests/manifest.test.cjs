const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('MV3 按点击注入，无自动运行，所有代码随包携带', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.equal(m.manifest_version, 3);
  for (const p of ['activeTab', 'scripting', 'storage']) assert(m.permissions.includes(p));
  assert(!m.content_scripts && !m.externally_connectable);
  assert(!m.content_security_policy?.extension_pages?.includes('unsafe-eval'));
  for (const f of [m.background.service_worker, 'kp-annotate.js', 'kp-annotate-project.js', 'kp-annotate-store.js', 'kp-annotate.css', 'vendor/jszip.min.js']) assert(fs.existsSync(path.join(root, f)), f);
});
