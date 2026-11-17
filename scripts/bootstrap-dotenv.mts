import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootstrapDotEnv } from '../src/infra/config/setup-dotenv.js';

const [envFile, templateFile] = process.argv.slice(2);
if (!envFile || !templateFile) throw new Error('Missing bootstrap configuration paths.');
try {
  console.log(bootstrapDotEnv(resolve(envFile), readFileSync(templateFile, 'utf8'), process.env));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Bootstrap configuration failed.';
  process.stderr.write(`[memphis-bootstrap] ${message}\n`);
  process.exitCode = 1;
}
