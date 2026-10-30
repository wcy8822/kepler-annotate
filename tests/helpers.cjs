'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');

const TEST_THREAD_UUID = '12345678-1234-4234-9234-123456789abc';
const browserExecutablePath = () => process.env.KEPLER_E2E_CHROME || chromium.executablePath();
const pythonExecutable = () => process.env.KEPLER_TEST_PYTHON || 'python3';
const temporaryDirectory = name => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-' + name + '-')));

function runPythonTests() {
  // Dotted filenames are not importable by unittest discovery; execute each suite directly.
  const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.py')).sort();
  if (!files.length) throw Error('No Python test suites found');
  for (const name of files) {
    const result = spawnSync(pythonExecutable(), ['-B', path.join(__dirname, name)], {
      stdio: 'inherit', cwd: path.resolve(__dirname, '..'), env: process.env
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status || 1;
  }
  return 0;
}

module.exports = {TEST_THREAD_UUID, chromium, browserExecutablePath, pythonExecutable, temporaryDirectory};
if (require.main === module) {
  if (process.argv[2] !== 'python') throw Error('Usage: node tests/helpers.cjs python');
  process.exitCode = runPythonTests();
}
