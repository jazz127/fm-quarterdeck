// CI selections are explicit; npm test remains the complete local suite.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertValidationRuntime } from './check-validation-runtime.mjs';

assertValidationRuntime();
const selections = JSON.parse(readFileSync(new URL('./test-selection.json', import.meta.url), 'utf8'));
const files = selections[process.argv[2]];
if (!Array.isArray(files) || files.length === 0) throw new Error('Select deterministic or integration tests');
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
