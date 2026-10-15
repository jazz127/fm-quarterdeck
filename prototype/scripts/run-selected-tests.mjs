// CI selections are explicit; npm test remains the complete local suite.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertValidationRuntime } from './check-validation-runtime.mjs';

assertValidationRuntime();
const selections = JSON.parse(readFileSync(new URL('./test-selection.json', import.meta.url), 'utf8'));
const files = selections[process.argv[2]];
if (!Array.isArray(files) || files.length === 0) throw new Error('Select deterministic or integration tests');
// Opt-in observer preloads into this same Node runner and its original workers.
// The workflow enables it for one exact PR synchronize transition only.
const observer = process.argv[2] === 'integration' && process.env.FM_HISTORY_VALIDATION_OBSERVER === '1'
  ? ['--require', fileURLToPath(new URL('./history-validation-observer.cjs', import.meta.url))] : [];
const result = spawnSync(process.execPath, [...observer, '--test', ...files], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
