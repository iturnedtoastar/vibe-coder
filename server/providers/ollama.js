import { openai } from './openai.js';

/**
 * Ollama — models running locally on this machine.
 *
 * No API key, no network, nothing leaves the box. Ollama exposes an
 * OpenAI-compatible endpoint at /v1, so the transport is the existing OpenAI
 * adapter pointed somewhere else; only discovery and defaults live here.
 *
 * Tool calling depends on the model, not on Ollama — llama3.1, qwen2.5-coder,
 * mistral-nemo and friends support it; many smaller models do not, and will
 * simply answer in prose instead of editing files.
 */

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

function apiBase(baseUrl) {
  const host = (baseUrl || DEFAULT_HOST).replace(/\/+$/, '').replace(/\/v1$/, '');
  return host;
}

/** Is a local Ollama server up, and what has it got? Cached briefly. */
let cache = { at: 0, running: false, models: [] };

export async function ollamaStatus({ baseUrl, force = false } = {}) {
  if (!force && Date.now() - cache.at < 10000) return cache;

  try {
    const res = await fetch(`${apiBase(baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    cache = {
      at: Date.now(),
      running: true,
      models: (data.models || []).map((m) => ({
        name: m.name,
        size: m.size,
        family: m.details?.family || '',
      })),
    };
  } catch {
    cache = { at: Date.now(), running: false, models: [] };
  }
  return cache;
}

export const ollama = {
  id: 'ollama',
  label: 'Ollama (local)',
  defaultModel: '',
  local: true,

  toHistory: openai.toHistory,
  pushAssistant: openai.pushAssistant,
  pushToolResults: openai.pushToolResults,

  async *turn(opts) {
    const base = `${apiBase(opts.baseUrl)}/v1`;

    let model = opts.model;
    if (!model) {
      // No model chosen: use whatever is installed, preferring a coder model.
      const { models } = await ollamaStatus({ baseUrl: opts.baseUrl });
      if (!models.length) {
        yield {
          type: 'error',
          message: 'No Ollama models installed. Run `ollama pull qwen2.5-coder` in the terminal.',
        };
        return { assistant: null, toolCalls: [], stop: 'error' };
      }
      model = (models.find((m) => /coder|code/i.test(m.name)) || models[0]).name;
    }

    // Ollama ignores the key but the OpenAI client shape requires one.
    const turn = openai.turn({ ...opts, model, baseUrl: base, apiKey: opts.apiKey || 'ollama' });

    let step = await turn.next();
    while (!step.done) {
      yield step.value;
      step = await turn.next();
    }
    return step.value;
  },
};
