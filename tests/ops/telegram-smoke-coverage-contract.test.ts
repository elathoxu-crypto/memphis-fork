import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = YAML.parse(
  readFileSync(new URL('../../.github/workflows/telegram-smoke.yml', import.meta.url), 'utf8'),
) as {
  jobs: {
    configuration: { outputs: Record<string, string>; steps: { id: string; run: string }[] };
    smoke: { needs: string; if: string; steps: { run?: string }[] };
  };
};

describe('telegram-smoke workflow reports real coverage', () => {
  it('requires configured credentials before starting the live smoke job', () => {
    const { configuration, smoke } = workflow.jobs;
    expect(configuration.outputs.configured).toBe('${{ steps.check.outputs.configured }}');
    expect(smoke.needs).toBe('configuration');
    expect(smoke.if).toBe("needs.configuration.outputs.configured == 'true'");
    expect(smoke.steps.some((step) => step.run?.includes('telegram smoke-test'))).toBe(true);
  });

  it.each([
    ['', '', 'false'],
    ['test-token', '', 'false'],
    ['', 'test-chat', 'false'],
    ['test-token', 'test-chat', 'true'],
  ])('reports credential availability for token %j and chat %j', (token, chat, configured) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'telegram-smoke-'));
    const output = path.join(directory, 'output');
    const summary = path.join(directory, 'summary');
    try {
      const check = workflow.jobs.configuration.steps.find((step) => step.id === 'check');
      expect(check).toBeDefined();
      const result = spawnSync('bash', ['-e', '-c', check!.run], {
        env: {
          ...process.env,
          BOT_TOKEN: token,
          CHAT_ID: chat,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(`configured=${configured}\n`);
      if (configured === 'false') {
        expect(readFileSync(summary, 'utf8')).toContain('Telegram live smoke skipped');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
