import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('published harness documentation', () => {
  it('is included in the npm package', () => {
    const output = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8' });
    const packages = JSON.parse(output) as Array<{ files: Array<{ path: string }> }> | Record<string, { files: Array<{ path: string }> }>;
    const entries = Array.isArray(packages) ? packages : Object.values(packages);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.files.map(file => file.path)).toContain('docs/harness-acp-client.md');
  });
});
