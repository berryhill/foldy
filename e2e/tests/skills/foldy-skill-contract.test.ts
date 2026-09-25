import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const bundles = [
  ['foldy-server-operator', 'Foldy Server'],
  ['foldy-instance-operator', 'Foldy instance'],
] as const;

describe('portable Foldy operator skills', () => {
  it.each(bundles)('%s is a discoverable product-owned functional skill', (name) => {
    const content = read(`skills/${name}/SKILL.md`);
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain(`name: ${name}\n`);
    expect(content).toMatch(/description: Use when /);
    expect(content).toContain('  mode: utility');
    expect(content).toContain('## Verification');
    expect(content).not.toContain('sk-');
    expect(content).not.toContain('github_pat_');
    expect(content).not.toContain('silas-workstation');
  });

  it('keeps factory and instance authority separate, without advertising native hosting as ready', () => {
    const server = read('skills/foldy-server-operator/SKILL.md');
    const instance = read('skills/foldy-instance-operator/SKILL.md');
    const contract = read('docs/foldy/essential-mvi-contract.json');
    const routes = read('apps/daemon/src/routes/foldy-native-deployment.ts');
    expect(contract).toContain('The complete golden path passes browser, MCP, security, accessibility, restore, upgrade, and teardown evidence against one deployed instance.');
    expect(routes).toContain('FOLDY_OWNER_NOT_CONFIGURED');
    expect(server).toContain('FOLDY_OWNER_NOT_CONFIGURED');
    expect(server).toContain('FOLDY_CYNDER_NOT_CONFIGURED');
    expect(server).toContain('foldyActivation: not_verified');
    expect(instance).toContain('od foldy instance');
    expect(instance).toContain('not the workstation Foldy Server');
    expect(instance).toContain('one deployed instance');
  });
});
