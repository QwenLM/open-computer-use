/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('.github/workflows/cd-cua-driver.yml', 'utf8');
const packageVerifier = readFileSync(
  'packages/cua-driver/scripts/verify-cua-sdk-package.mjs',
  'utf8',
);
const shellInstaller = readFileSync(
  'packages/cua-driver/scripts/_install-rust.sh',
  'utf8',
);
const powershellInstaller = readFileSync(
  'packages/cua-driver/scripts/install.ps1',
  'utf8',
);

describe('CUA SDK release workflow', () => {
  it('never publishes a manual dry run, including one dispatched on a native tag', () => {
    const release = parse(workflow);
    const cases = [
      ['push', 'refs/tags/cua-driver-rs-v0.28.0', undefined, true],
      ['push', 'refs/heads/main', undefined, false],
      ['push', 'refs/tags/other-v0.28.0', undefined, false],
      ['workflow_dispatch', 'refs/heads/main', true, false],
      ['workflow_dispatch', 'refs/tags/cua-driver-rs-v0.28.0', true, false],
      ['workflow_dispatch', 'refs/heads/main', false, true],
      ['pull_request', 'refs/tags/cua-driver-rs-v0.28.0', false, false],
    ];
    for (const name of [
      'release',
      'publish-sdk',
      'publish-browser',
      'publish-node-repl',
    ]) {
      const condition = release.jobs[name].if;
      const evaluate = new Function(
        'github',
        'inputs',
        'startsWith',
        `return (${condition});`,
      );
      for (const [event_name, ref, dry_run, expected] of cases) {
        expect(
          evaluate({ event_name, ref }, { dry_run }, (value, prefix) =>
            value.startsWith(prefix),
          ),
          `${name}: ${event_name} ${ref} dry_run=${dry_run}`,
        ).toBe(expected);
      }
    }
  });

  it('pins every action and keeps the Rust version explicit after pinning', () => {
    const release = parse(workflow);
    for (const job of Object.values(release.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
        if (step.uses.startsWith('dtolnay/rust-toolchain@')) {
          expect(step.with.toolchain).toBe('1.97.1');
        }
      }
    }
  });

  it('requires explicit target-repository configuration for test signing', () => {
    const release = parse(workflow);
    const windows = release.jobs['build-windows'];
    const signing = windows.steps.find(
      (step) => step.name === 'Test-sign UIAccess worker (dry run)',
    );
    expect(release.on.workflow_dispatch.inputs.test_sign_windows.default).toBe(
      false,
    );
    expect(windows.env.CUA_TEST_SIGNING).toContain(
      'inputs.test_sign_windows == true',
    );
    expect(signing.env.SIGNPATH_API_TOKEN).toBe(
      '${{ secrets.SIGNPATH_API_TOKEN }}',
    );
    const script = readFileSync(
      '.github/scripts/test-sign-cua-windows-worker.ps1',
      'utf8',
    );
    for (const name of [
      'SIGNPATH_ORGANIZATION_ID',
      'SIGNPATH_PROJECT_SLUG',
      'SIGNPATH_SIGNING_POLICY_SLUG',
      'SIGNPATH_ARTIFACT_CONFIGURATION_SLUG',
      'SIGNPATH_TEST_CERT_THUMBPRINT',
    ]) {
      expect(signing.env[name]).toBe(`\${{ vars.${name} }}`);
      expect(script).toContain(`$env:${name}`);
    }
    expect(script).not.toMatch(
      /(?:projectSlug|signingPolicySlug|artifactConfigurationSlug)\s*=\s*['"]/u,
    );
    expect(
      script.indexOf('is not configured for this repository'),
    ).toBeLessThan(script.indexOf('Invoke-WebRequest'));
  });

  it('keeps every native download and update route in this repository', () => {
    for (const path of [
      'packages/cua-driver/typescript/scripts/install-native.mjs',
      'packages/cua-driver/python/build_wheel.py',
      'packages/cua-driver/scripts/install.sh',
      'packages/cua-driver/scripts/_install-rust.sh',
      'packages/cua-driver/scripts/install.ps1',
      'packages/cua-driver/rust/crates/cua-driver/src/updater.rs',
      'packages/cua-driver/rust/crates/cua-driver/src/version_check.rs',
      'packages/cua-driver/rust/crates/cua-driver/src/skills.rs',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('QwenLM/open-computer-use');
      expect(source).not.toContain('QwenLM/qwen-code');
    }
    expect(workflow).not.toContain('docs/users/features/computer-use.md');
    expect(workflow).toContain(
      'https://github.com/QwenLM/open-computer-use/releases/download/',
    );
  });

  it('fails closed when a driver production dispatch disables notarization', () => {
    expect(workflow).toContain(
      '"${{ inputs.dry_run }}" != "true" && "${{ inputs.notarize }}" != "true"',
    );
  });

  it('requires Gatekeeper to accept the notarized app', () => {
    expect(workflow).toContain(
      'spctl -a -vv -t exec release/QwenCuaDriver.app',
    );
    expect(workflow).not.toMatch(/spctl[^\n]+\|\| true/u);
  });

  it('retries transient Debian mirror failures', () => {
    expect(workflow.match(/apt-get -o Acquire::Retries=3/g)).toHaveLength(2);
  });

  it('smokes the high-level ComputerUse runtime from a clean package', () => {
    expect(packageVerifier).toContain('await ComputerUse.create(');
    expect(packageVerifier).toContain('await computer.appCall("click"');
    expect(workflow).toContain('await ComputerUse.create(');
    expect(workflow).toContain('await computer.close()');
    const manifest = JSON.parse(
      readFileSync(
        'packages/cua-driver/typescript/computer-use/interface.json',
        'utf8',
      ),
    );
    for (const source of [packageVerifier, workflow]) {
      expect(source).toContain(
        `listing.tools.length !== ${manifest.tools.length}`,
      );
    }
  });

  it('keeps installer version assignments machine-rewritable', () => {
    expect(shellInstaller).toMatch(/^CUA_DRIVER_RS_BAKED_VERSION="[^"\n]+"$/mu);
    expect(powershellInstaller).toMatch(
      /^\$Script:CuaDriverRsBakedVersion = "[^"\n]+"$/mu,
    );
  });

  it('keeps historical Windows UIAccess assets installable', () => {
    expect(powershellInstaller).toContain(
      '$SignedUiaRequiredFrom = [version]"0.20.3"',
    );
    expect(powershellInstaller).toContain(
      '$LegacyUiaRequiredFrom = [version]"0.2.8"',
    );
    expect(powershellInstaller).toMatch(
      /\$requiresSignedUia = \[version\]\$version -ge \$SignedUiaRequiredFrom/,
    );
    expect(powershellInstaller).toMatch(
      /elseif \(\$requiresLegacyUia\) \{[\s\S]*?cua-driver-uia\.exe/,
    );
    expect(powershellInstaller).toContain(
      "@('qwen-cua-driver-uia.exe', 'cua-driver-uia.exe')",
    );
    expect(powershellInstaller).toMatch(
      /if \(\$requiresSignedUia\) \{[\s\S]*?release archive is missing required qwen-cua-driver-uia\.exe[\s\S]*?Get-AuthenticodeSignature/,
    );
  });
});
