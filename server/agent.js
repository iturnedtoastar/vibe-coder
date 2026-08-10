import { config } from './config.js';
import { availableTools, executeTool } from './tools.js';
import { anthropic } from './providers/anthropic.js';
import { openai } from './providers/openai.js';
import { google } from './providers/google.js';
import { CLI_AGENTS, makeCliProvider, availableCliAgents } from './providers/cli-agents.js';
import { ollama } from './providers/ollama.js';

export { availableCliAgents };

export const PROVIDERS = {
  anthropic,
  openai,
  google,
  // Models running locally via Ollama — no key, nothing leaves the machine.
  ollama,
  // Agent CLIs you're already signed into — no API key.
  ...Object.fromEntries(Object.keys(CLI_AGENTS).map((k) => [k, makeCliProvider(k)])),
};

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'run_command']);

/**
 * Cheap models, per provider.
 *
 * Most turns in a run are comprehension — digesting a file that was just read,
 * deciding what to look at next — not creation. A measured run showed the same
 * work costing $0.0006 on a small model against $0.1487 on a frontier one.
 * Planning and reading go here; writing code does not.
 */
export const CHEAP_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.5-flash',
};

/** The cheap counterpart of `model`, or null when there isn't a safe one. */
export function cheapModelFor(provider, model) {
  const cheap = CHEAP_MODELS[provider];
  if (!cheap || !model) return null;
  // Already on the cheap model — nothing to route down to.
  return model === cheap ? null : cheap;
}

export const SYSTEM_PROMPT = `You are Vibe Agent, the coding agent built into the Vibe Coder IDE.

You work inside a sandboxed workspace directory. Every path you use is relative
to that workspace root; you cannot read or write anything outside it, and
attempts to do so will be rejected.

Work efficiently. Every tool call resends the whole conversation, so a wasted
round-trip costs more than the call itself:
- A project map is provided with each request: the file tree plus the
  declarations each file defines. Use it instead of calling list_files, and to
  decide which files are worth reading. Only list a directory if the map says
  it was truncated.
- Read a file before editing it, but read the ones you actually need rather
  than surveying the codebase first.
- Batch independent tool calls into a single turn instead of one per turn.

How to work:
- Look before you edit — read_file gives you the current contents rather than
  what you assume they are.
- Use edit_file for targeted changes and write_file when creating a file or
  rewriting it end to end. Never write a partial file with placeholders like
  "// ... rest unchanged" — the file is saved exactly as you write it.
- Use run_command for real work: installing packages, running tests, git.
  Report what the command actually printed, including failures.
- Finish the task you were given. If part of it is blocked, complete the rest
  and say plainly what you left out and why.

Communicating:
- Lead with the outcome. The user sees your text between tool calls, not your
  reasoning or the raw tool results.
- Be concise and specific. Don't narrate routine actions or recap every file
  you touched; say what changed and what it means for them.
- Deliver what was asked at the scope intended. Make routine judgment calls
  yourself; check in only when different readings lead to materially different
  work.`;

/**
 * Provider-agnostic agent loop.
 *
 * Yields normalized events:
 *   {type:'text',        text}
 *   {type:'thinking',    text}
 *   {type:'tool_use',    id, name, input}
 *   {type:'tool_result', id, name, ok, content}
 *   {type:'done',        changedFiles, iterations}
 *   {type:'error',       message}
 */
export async function* runAgent({
  provider,
  model,
  apiKey,
  baseUrl,
  messages,
  system,
  useTools = true,
  // Planning looks at the project but must not change it. With this set the
  // mutating tools are never offered, so a plan cannot quietly become an edit.
  readOnly = false,
  sessionId,
  onSession,
  previewContext,
  signal,
}) {
  const adapter = PROVIDERS[provider];
  if (!adapter) {
    yield { type: 'error', message: `Unknown provider: ${provider}` };
    return;
  }
  // Claude Code authenticates through your terminal login, so it is the one
  // provider that needs no key.
  if (!apiKey && !adapter.usesOwnTools && !adapter.local) {
    yield {
      type: 'error',
      message: `No API key for ${provider}. Add one in Settings, or set it in server/.env.`,
    };
    return;
  }

  // Providers that run their own agent loop supply their own tools; handing
  // them ours would be meaningless and executing anything on their behalf wrong.
  let tools = useTools && !adapter.usesOwnTools ? availableTools() : [];
  if (readOnly) tools = tools.filter((t) => !MUTATING_TOOLS.has(t.name));
  const history = adapter.toHistory(messages);
  const changedFiles = new Set();

  // A run is many turns; usage events arrive per turn, so total them up.
  const usage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costUsd: 0, durationMs: 0, turns: 0,
    // Which billing world this ran in. CLI providers bill against a
    // subscription; API providers bill per token.
    source: adapter.usesOwnTools ? 'cli' : (adapter.local ? 'local' : 'api'),
  };
  let sawCost = false;
  const startedAt = Date.now();

  const accumulate = (event) => {
    usage.inputTokens += event.inputTokens || 0;
    usage.outputTokens += event.outputTokens || 0;
    usage.cacheReadTokens += event.cacheReadTokens || 0;
    usage.cacheWriteTokens += event.cacheWriteTokens || 0;
    usage.durationMs += event.durationMs || 0;
    usage.turns += event.turns || 0;
    if (event.models) usage.models = event.models;
    if (typeof event.costUsd === 'number') { usage.costUsd += event.costUsd; sawCost = true; }
  };

  const finalUsage = () => ({
    ...usage,
    costUsd: sawCost ? usage.costUsd : null,
    // API providers report no wall time, so measure it here.
    durationMs: usage.durationMs || (Date.now() - startedAt),
  });

  try {
    for (let iteration = 0; iteration < config.agent.maxIterations; iteration++) {
      const turn = adapter.turn({
        model: model || adapter.defaultModel,
        apiKey,
        baseUrl,
        system: system || SYSTEM_PROMPT,
        history,
        tools,
        sessionId,
        onSession,
        previewContext,
        signal,
      });

      // Forward stream events, then collect the generator's return value.
      let step = await turn.next();
      while (!step.done) {
        if (step.value?.type === 'usage') accumulate(step.value);
        yield step.value;
        step = await turn.next();
      }
      const { assistant, toolCalls, stop } = step.value;

      adapter.pushAssistant(history, assistant);

      if (stop === 'refusal' || !toolCalls || toolCalls.length === 0) {
        yield {
          type: 'done',
          changedFiles: [...changedFiles],
          iterations: iteration + 1,
          usage: finalUsage(),
        };
        return;
      }

      // Reads have no side effects and dominate a typical batch, so they run
      // together instead of queueing behind each other — four file reads take
      // as long as the slowest one, not the sum. Anything that mutates stays
      // strictly sequential: two edits to one file must not interleave, and a
      // command's effect has to land before the next call observes it.
      const reads = toolCalls.filter((c) => !MUTATING_TOOLS.has(c.name));
      const writes = toolCalls.filter((c) => MUTATING_TOOLS.has(c.name));

      for (const call of toolCalls) {
        yield { type: 'tool_use', id: call.id, name: call.name, input: call.input };
      }

      const outcomes = new Map();
      if (reads.length) {
        const settled = await Promise.all(
          reads.map(async (call) => [call.id, await executeTool(call.name, call.input)])
        );
        for (const [id, result] of settled) outcomes.set(id, result);
      }

      for (const call of writes) {
        if (signal?.aborted) return;
        outcomes.set(call.id, await executeTool(call.name, call.input));
      }

      if (signal?.aborted) return;

      // Reported in the order the model asked for them, whatever order they
      // actually finished in — the transcript has to match the request.
      const results = [];
      for (const call of toolCalls) {
        const result = outcomes.get(call.id);
        if (result.ok && MUTATING_TOOLS.has(call.name)) {
          if (call.input?.path) changedFiles.add(call.input.path);
          else changedFiles.add('*');
        }

        results.push({ id: call.id, name: call.name, ok: result.ok, content: result.content });
        yield {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          ok: result.ok,
          content: result.content,
        };
      }

      adapter.pushToolResults(history, results);
    }

    yield {
      type: 'text',
      text: `\n[Stopped after ${config.agent.maxIterations} tool iterations without finishing. Send another message to continue.]\n`,
    };
    yield {
      type: 'done',
      changedFiles: [...changedFiles],
      iterations: config.agent.maxIterations,
      usage: finalUsage(),
    };
  } catch (err) {
    if (signal?.aborted) return;
    yield { type: 'error', message: err?.message || String(err) };
  }
}
