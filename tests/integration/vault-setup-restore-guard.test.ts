import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'dotenv';
import { describe, expect, it, vi } from 'vitest';

import { restoreBackup } from '../../src/infra/cli/commands/backup.js';
import { bootstrapDotEnv, writeSetupDotEnv } from '../../src/infra/config/setup-dotenv.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const template = 'MEMPHIS_VAULT_PEPPER=\nMEMPHIS_API_TOKEN=\n';
const pepper = 'synthetic-state-reader-pepper';

describe('setup and ordinary restore protect the existing vault', () => {
  it('initializes a fresh private dotenv exactly once', () => {
    const { root, env } = createIsolatedTestRuntime(process.env, resolve('.'));
    try {
      const path = env.MEMPHIS_ENV_FILE!;
      rmSync(path);
      expect(bootstrapDotEnv(path, template, env)).toBe(true);
      const bytes = readFileSync(path, 'utf8');
      expect(parse(bytes).MEMPHIS_VAULT_PEPPER).toMatch(/^memphis-[a-f0-9]{32}$/);
      expect(bytes.match(/^MEMPHIS_VAULT_PEPPER=/gm)).toHaveLength(1);
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(bootstrapDotEnv(path, template, env)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses clobbering setup, missing dotenv bootstrap and ordinary restore; fresh process retains DID and secret', async () => {
    const { root, env } = createIsolatedTestRuntime(process.env, resolve('.'));
    try {
      const path = env.MEMPHIS_ENV_FILE!;
      const state = env.MEMPHIS_VAULT_STATE_PATH!;
      const entries = env.MEMPHIS_VAULT_ENTRIES_PATH!;
      const didPath = join(env.MEMPHIS_DATA_DIR!, 'did.json');
      const dotenv = `MEMPHIS_VAULT_PEPPER=${pepper}\n`;
      writeFileSync(path, dotenv);
      writeFileSync(join(root, '.env.example'), template);
      writeFileSync(state, readFileSync('tests/fixtures/vault-state-v2.synthetic.json'));
      const seed = Buffer.alloc(32, 3);
      const privateKey = createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
        format: 'der',
        type: 'pkcs8',
      });
      const publicKeyHex = createPublicKey(privateKey)
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('hex');
      const did = `did:key:ed25519:${publicKeyHex}`;
      writeFileSync(didPath, JSON.stringify({ did }));
      writeFileSync(
        entries,
        JSON.stringify(
          [
            ['first', 'synthetic-first-credential'],
            ['did_seed', seed.toString('hex')],
          ].map(([key, value], index) => {
            const iv = Buffer.alloc(12, 4 + index);
            const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), iv);
            const encrypted = Buffer.concat([cipher.update(value), cipher.final()]).toString(
              'base64',
            );
            const fields = { key, encrypted, iv: iv.toString('base64') };
            return {
              ...fields,
              fingerprint: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
              tag: cipher.getAuthTag().toString('base64'),
              id: `fixture-${index}`,
              createdAt: '2026-10-16T00:00:00Z',
            };
          }),
        ),
      );
      const preserved = [path, state, entries, didPath].map((file) => readFileSync(file));

      expect(() => writeSetupDotEnv(path, template, env, true)).toThrow(
        /Vault data already exists/,
      );
      writeFileSync(path, template);
      expect(() => bootstrapDotEnv(path, template, env)).toThrow(/Vault data already exists/);
      expect(readFileSync(path, 'utf8')).toBe(template);
      writeFileSync(path, dotenv);
      renameSync(path, `${path}.verified`);
      expect(() => bootstrapDotEnv(path, template, env)).toThrow(/Vault data already exists/);
      const bootstrap = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/bootstrap-dotenv.mts', path, join(root, '.env.example')],
        { env, encoding: 'utf8', timeout: 45_000 },
      );
      expect(bootstrap.status).toBe(1);
      expect(bootstrap.stderr).toContain('Vault data already exists');
      const init = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/infra/cli/index.ts', 'init', '--non-interactive', '--json'],
        { env, encoding: 'utf8', timeout: 45_000 },
      );
      expect(init.status).not.toBe(0);
      expect(init.stderr).toContain('Vault data already exists');
      expect(existsSync(path)).toBe(false);
      renameSync(`${path}.verified`, path);

      for (const key of [
        'MEMPHIS_ENV_FILE',
        'MEMPHIS_RUNTIME_ROOT',
        'MEMPHIS_DATA_DIR',
        'MEMPHIS_VAULT_STATE_PATH',
        'MEMPHIS_VAULT_ENTRIES_PATH',
      ]) {
        vi.stubEnv(key, env[key]!);
      }
      await expect(
        restoreBackup({
          file: join(root, 'not-opened.tar.gz'),
          memphisRoot: env.MEMPHIS_DATA_DIR!,
        }),
      ).rejects.toThrow(/Restore refused: this archive does not carry a protected vault/);

      const reader = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
          import { createPrivateKey, createPublicKey } from 'node:crypto';
          import { readFileSync } from 'node:fs';
          import { join } from 'node:path';
          import { loadDotEnvFromInstallRoot } from './src/infra/config/env.ts';
          import { readVaultSecretByKey } from './src/security/vault-boundary.ts';
          loadDotEnvFromInstallRoot();
          const read = (key) => readVaultSecretByKey(key, {surface:'cli', command:'fixture'});
          const first = read('first');
          const seed = read('did_seed');
          if (!first.found || first.plaintext !== 'synthetic-first-credential' || !seed.found || !seed.plaintext) process.exit(2);
          const privateKey = createPrivateKey({
            key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed.plaintext,'hex')]),
            format: 'der', type: 'pkcs8',
          });
          const publicKey = createPublicKey(privateKey).export({format:'der', type:'spki'}).subarray(-32).toString('hex');
          const stored = JSON.parse(readFileSync(join(process.env.MEMPHIS_DATA_DIR, 'did.json'),'utf8'));
          if (stored.did !== 'did:key:ed25519:' + publicKey) process.exit(3);
          console.log('VAULT_AND_DID_OK');
        `,
        ],
        { env, encoding: 'utf8', timeout: 45_000 },
      );
      expect(reader.stderr).not.toContain(pepper);
      expect(reader.stdout.trim()).toBe('VAULT_AND_DID_OK');
      expect([path, state, entries, didPath].map((file) => readFileSync(file))).toEqual(preserved);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
