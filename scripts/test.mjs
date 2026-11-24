import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Auch unter Windows ohne Shell-Globs ausführen. Jede Suite bekommt ihren eigenen Prozess.
const root = new URL('../', import.meta.url);
const suites = readdirSync(new URL('scripts/', root))
  .filter((name) => name.startsWith('test-') && name.endsWith('.ts'))
  .sort()
  .map((name) => `scripts/${name}`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=2', ...suites], {
  cwd: fileURLToPath(root), stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
