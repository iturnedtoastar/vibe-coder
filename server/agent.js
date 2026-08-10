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

export const SYSTEM_PROMPT = `You are Vibe Agent, the coding agent built into the Vibe Coder IDE.

You work inside a sandboxed workspace directory. Every path you use is relative
to that workspace root; you cannot read or write anything outside it, and
attempts to do so will be rejected.

How to work:
- Look before you edit. Use list_files and read_file to see the actual current
  state rather than assuming what a file contains.
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
  const tools = useTools && !adapter.usesOwnTools ? availableTools() : [];
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

      const results = [];
      for (const call of toolCalls) {
        if (signal?.aborted) return;
        yield { type: 'tool_use', id: call.id, name: call.name, input: call.input };

        const result = await executeTool(call.name, call.input);
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
