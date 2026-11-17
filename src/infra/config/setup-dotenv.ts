import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

import { parse } from 'dotenv';

import { withConfigurationWriteLock } from './config-transaction.js';
import { writePrivateAtomicFile } from './private-atomic-file.js';
import { resolveVaultJournals, resolveVaultPath } from '../storage/vault-paths.js';

function readExisting(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function hasVaultData(env: NodeJS.ProcessEnv): boolean {
  return (['vault-state.json', 'vault-entries.json'] as const).some((name) => {
    try {
      lstatSync(resolveVaultPath(name, env));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  });
}

function assertFreshVaultConfig(environments: NodeJS.ProcessEnv[]): void {
  if (environments.some(hasVaultData)) {
    throw new Error(
      'Vault data already exists. Restore its matching .env from a verified backup or use memphis vault pepper-rotate with the existing configuration.',
    );
  }
}

function withSetupConfig<T>(
  path: string,
  proposed: string,
  rawEnv: NodeJS.ProcessEnv,
  run: (current: string | undefined, environments: NodeJS.ProcessEnv[]) => T,
): T {
  const environmentsFor = (current: string | undefined) => [
    { ...rawEnv, MEMPHIS_ENV_FILE: path },
    { ...parse(current ?? ''), ...rawEnv, MEMPHIS_ENV_FILE: path },
    { ...parse(proposed), ...rawEnv, MEMPHIS_ENV_FILE: path },
  ];
  const journalsFor = (environments: NodeJS.ProcessEnv[]) =>
    new Set(environments.flatMap((env) => [...resolveVaultJournals(env).paths]));
  const journals = journalsFor(environmentsFor(readExisting(path)));
  return withConfigurationWriteLock([...journals], () => {
    const current = readExisting(path);
    const environments = environmentsFor(current);
    for (const journal of journalsFor(environments)) {
      if (!journals.has(journal)) throw new Error('Vault paths changed during setup. Retry setup.');
    }
    return run(current, environments);
  });
}

export function writeSetupDotEnv(
  path: string,
  content: string,
  rawEnv: NodeJS.ProcessEnv,
  replace: boolean,
): void {
  withSetupConfig(path, content, rawEnv, (current, environments) => {
    if (current !== undefined && !replace) throw new Error('The configuration already exists.');
    assertFreshVaultConfig(environments);
    writePrivateAtomicFile(path, content, { exclusive: current === undefined });
  });
}

export function bootstrapDotEnv(
  path: string,
  template: string,
  rawEnv: NodeJS.ProcessEnv,
): boolean {
  return withSetupConfig(path, template, rawEnv, (current, environments) => {
    const starting = current ?? template;
    const parsed = parse(starting);
    // Refuse before publishing any config change, even an unrelated default.
    if (current === undefined || !parsed.MEMPHIS_VAULT_PEPPER?.trim()) {
      assertFreshVaultConfig(environments);
    }

    const defaults: Record<string, string> = {
      MEMPHIS_API_TOKEN: randomBytes(24).toString('base64url'),
      MEMPHIS_VAULT_PEPPER: `memphis-${randomBytes(16).toString('hex')}`,
      MEMPHIS_AGENT_NAME: rawEnv.MEMPHIS_AGENT_NAME || 'Memphis Agent',
      MEMPHIS_OWNER_NAME: rawEnv.MEMPHIS_OWNER_NAME || 'local operator',
      RUST_CHAIN_ENABLED: 'true',
      RUST_EMBED_PERSIST_ENABLED: 'true',
      ...(rawEnv.MEMPHIS_TELEGRAM_BOT_TOKEN ? { MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'true' } : {}),
    };
    const missing = Object.entries(defaults).filter(([key]) => !parsed[key]?.trim());
    if (missing.length === 0 && current !== undefined) return false;
    if (missing.some(([, value]) => /[\r\n]/.test(value))) {
      throw new Error('Bootstrap configuration values must not contain newlines.');
    }
    const missingKeys = new Set(missing.map(([key]) => key));
    const retained = starting.split(/\r?\n/).filter((line) => {
      const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
      return key === undefined || !missingKeys.has(key);
    });
    const appended = `${retained.join('\n').trimEnd()}\n${missing
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n')}\n`;
    const next = parse(appended);
    if (
      missing.some(([key, value]) => next[key] !== value) ||
      Object.entries(parsed).some(([key, value]) => !missingKeys.has(key) && next[key] !== value)
    ) {
      throw new Error('Bootstrap could not preserve the existing configuration.');
    }
    writePrivateAtomicFile(path, appended, { exclusive: current === undefined });
    return missing.some(([key]) => key === 'MEMPHIS_VAULT_PEPPER' || key === 'MEMPHIS_API_TOKEN');
  });
}
