import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = (file) =>
  JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const workspace = readJson('package.json');
const packages = new Map(
  workspace.workspaces.map((directory) => {
    const manifest = readJson(`${directory}/package.json`);
    return [manifest.name, { directory, manifest }];
  }),
);

test('internal package dependencies resolve to this standalone checkout', () => {
  for (const { directory, manifest } of packages.values()) {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!name.startsWith('@qwen-code/')) continue;
      const dependency = packages.get(name);
      assert.ok(
        dependency,
        `${manifest.name} requires external Qwen source: ${name}`,
      );
      assert.equal(version, dependency.manifest.version);
      const resolved = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `console.log(import.meta.resolve(${JSON.stringify(name)}))`,
        ],
        { cwd: path.join(root, directory), encoding: 'utf8' },
      ).trim();
      assert.ok(
        realpathSync(fileURLToPath(resolved)).startsWith(
          realpathSync(path.join(root, dependency.directory)) + path.sep,
        ),
        `${manifest.name} must use the local ${name} build`,
      );
    }
  }
});

test('all public package exports and executable entrypoints are built', () => {
  const checkTarget = (directory, target) => {
    if (typeof target === 'string') {
      assert.ok(
        existsSync(path.join(root, directory, target)),
        `${directory}: ${target}`,
      );
    } else {
      for (const value of Object.values(target)) checkTarget(directory, value);
    }
  };
  for (const { directory, manifest } of packages.values()) {
    checkTarget(directory, manifest.exports ?? {});
    checkTarget(directory, manifest.bin ?? {});
  }
});

test('CI actions are pinned and local working directories exist', () => {
  for (const file of ['ci.yml', 'cd-cua-driver.yml']) {
    const workflow = parse(
      readFileSync(path.join(root, '.github/workflows', file), 'utf8'),
    );
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses && !step.uses.startsWith('./')) {
          assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/, step.uses);
        }
        const directory = step['working-directory'];
        if (directory && !directory.includes('${{')) {
          assert.ok(existsSync(path.join(root, directory)), directory);
        }
      }
    }
  }
});
