#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

function hasCommand(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

const hasOllamaCli = hasCommand('ollama');
const usingOllama =
  process.env.DEFAULT_PROVIDER === 'ollama' ||
  process.env.RUST_EMBED_MODE === 'ollama' ||
  (!process.env.DEFAULT_PROVIDER && !process.env.RUST_EMBED_MODE);

if (!hasOllamaCli && usingOllama) {
  console.warn('[memphis-install] Ollama CLI not found.');
  console.warn(
    '[memphis-install] Memphis will still install, but Ollama-backed features will be unavailable until installed.',
  );
  console.warn('[memphis-install] Install Ollama: https://ollama.com/download');
  console.warn(
    `[memphis-install] For local chat, pull: ollama pull ${process.env.OLLAMA_MODEL || 'qwen2.5-coder:0.5b'}`,
  );
  if (process.env.RUST_EMBED_MODE === 'ollama') {
    console.warn(
      `[memphis-install] For Ollama embeddings, pull: ollama pull ${process.env.RUST_EMBED_PROVIDER_MODEL || 'nomic-embed-text'}`,
    );
  }
}
