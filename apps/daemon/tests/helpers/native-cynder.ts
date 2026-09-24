import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeCynderConsumer, type NativeCynderConfig } from '../../src/foldy-deployments/native-cynder.js';
const dirs: string[] = [];
export async function cleanup() { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); }
export async function setup(overrides: Partial<NativeCynderConfig> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-cynder-test-')); dirs.push(dir);
  const helper = path.join(dir, 'unused-helper'); await writeFile(helper, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const control = path.join(dir, 'control.json'); await writeFile(control, '{}');
  // Install fixture bytes under protected ancestry, independent of checkout/nvm modes.
  const consumer = path.join(dir, 'consumer.ts');
  await writeFile(consumer, await readFile(fileURLToPath(new URL('../fixtures/native-cynder-consumer.ts', import.meta.url))), { mode: 0o700 });
  const runtime = path.join(dir, 'node');
  await writeFile(runtime, await readFile(process.execPath), { mode: 0o700 });
  const config: NativeCynderConfig = { consumerPath: consumer, pythonPath: runtime, origin: 'https://cynder.example', dataRoot: dir,
    consumerSha256: createHash('sha256').update(await readFile(consumer)).digest('hex'), admittedActions: ['DELETE'],
    signerHelper: helper, paymentHelper: helper, expectedPayee: '0x' + 'c'.repeat(40), timeoutMs: 5000,
    helperEnvironment: { CYNDER_SIGNER_FIXTURE_FILE: control }, ...overrides };
  const bridge = new NativeCynderConsumer(config);
  const input = { operationId: '1'.repeat(64), request: { type: 'DELETE', deployment_id: 'dep_' + 'e'.repeat(32) },
    idempotencyKey: 'test-key', reviewedStateDigest: '2'.repeat(64) };
  const budget = { budgetId: 'budget-1', perActionCap: 10, totalCap: 20 };
  const calls = async () => (await readFile(path.join(dir, 'foldy-native-cynder', 'consumer', 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] });
  const mode = (value: string) => writeFile(control, JSON.stringify({ mode: value }));
  const quoted = async () => { await bridge.prepare(input); return bridge.challenge(input.operationId, budget); };
  return { bridge, config, input, budget, calls, mode, quoted, dir };
}
