import { spawnSync } from 'node:child_process';
import { spawnCommand } from '../spawn-win.js';
import { config, getWorkspaceRoot } from '../config.js';

/**
 * Agent CLIs as providers — no API keys.
 *
 * Each of these is an agent you're already signed into in the terminal. We run
 * it headlessly in the open folder and translate its event stream into the
 * app's normalized events. They bring their own tools and their own agent
 * loop, so this module never executes tools on their behalf.
 *
 * Conversation continuity uses each CLI's own session/resume flag rather than
 * replaying our message history.
 */

const isWin = process.platform === 'win32';

/** Map each CLI's tool names onto ours so the UI renders one vocabulary. */
const COMMON_TOOLS = {
  Read: 'read_file', read_file: 'read_file', ReadFile: 'read_file', view_file: 'read_file',
  Write: 'write_file', write_file: 'write_file', create_file: 'write_file',
  Edit: 'edit_file', edit_file: 'edit_file', replace: 'edit_file', str_replace: 'edit_file',
  Bash: 'run_command', run_command: 'run_command', run_terminal_command: 'run_command', Shell: 'run_command',
  Glob: 'search', Grep: 'search', grep_search: 'search', search: 'search',
  LS: 'list_files', list_dir: 'list_files', ListDir: 'list_files',
};

const normalizeTool = (name) => COMMON_TOOLS[name] || name;

export const CLI_AGENTS = {
  'claude-code': {
    label: 'Claude Code',
    bin: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
    models: [
      { value: '', label: 'Whatever Claude Code is set to' },
      { value: 'claude-opus-5', label: 'Claude Opus 5' },
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    args({ model, sessionId }) {
      const a = [
        '-p',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--permission-mode', config.agent.allowBash ? 'bypassPermissions' : 'acceptEdits',
      ];
      if (model) a.push('--model', model);
      if (sessionId) a.push('--resume', sessionId);
      return a;
    },
    parse(msg, emit) {
      if (msg.type === 'system' && msg.subtype === 'init') return emit.session(msg.session_id);

      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          emit.text(ev.delta.text);
        }
        return;
      }
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content || []) {
          if (b.type !== 'tool_use') continue;
          const i = b.input || {};
          emit.tool(b.id, normalizeTool(b.name), {
            path: i.file_path || i.path, command: i.command, pattern: i.pattern,
          });
        }
        return;
      }
      if (msg.type === 'user') {
        for (const b of msg.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          emit.result(b.tool_use_id, !b.is_error, typeof b.content === 'string' ? b.content : '');
        }
        return;
      }
      if (msg.type === 'result') {
        emit.session(msg.session_id);
        if (msg.is_error) emit.fail(msg.result || msg.subtype || 'Claude Code reported an error.');
      }
    },
  },

  antigravity: {
    label: 'Antigravity',
    bin: 'agy',
    install: 'Install Antigravity from antigravity.google',
    models: [{ value: '', label: 'Whatever Antigravity is set to' }],
    // `-p` takes its value inline; with the prompt on stdin the CLI reads the
    // next flag as the prompt instead. It's a real .exe, so passing the prompt
    // as an argument never touches a shell.
    promptAsArg: true,
    args({ model, sessionId }) {
      // Antigravity has an explicit workspace that is not simply the cwd —
      // without --add-dir it searches elsewhere and reports the file missing.
      const a = ['--output-format', 'stream-json', '--add-dir', getWorkspaceRoot()];
      if (config.agent.allowBash) a.push('--dangerously-skip-permissions');
      else a.push('--mode', 'accept-edits');
      if (model) a.push('--model', model);
      if (sessionId) a.push('--conversation', sessionId);
      return a;
    },
    parse(msg, emit) {
      if (msg.event === 'init') return emit.session(msg.conversation_id || msg.init?.conversation_id);

      if (msg.event === 'step_update') {
        const step = msg.step_update || {};
        if (step.conversation_id) emit.session(step.conversation_id);

        if (step.text_delta) emit.text(step.text_delta);

        // Tool steps aren't a fixed shape across versions; match on whatever
        // names a tool rather than assuming one field.
        const toolName = step.tool_name || step.tool || step.tool_call?.name;
        if (toolName) {
          const input = step.tool_input || step.tool_call?.input || {};
          const id = `${step.step_index ?? 0}`;
          if (step.state === 'DONE' && step.tool_result !== undefined) {
            emit.result(id, !step.error, String(step.tool_result).slice(0, 400));
          } else {
            emit.tool(id, normalizeTool(toolName), {
              path: input.file_path || input.path,
              command: input.command,
              pattern: input.pattern || input.query,
            });
          }
        }
        return;
      }

      if (msg.event === 'result') {
        const r = msg.result || {};
        emit.session(r.conversation_id);
        if (r.status && r.status !== 'SUCCESS') {
          emit.fail(r.error || r.response || `Antigravity finished with status ${r.status}.`);
        }
      }
    },
  },

  codex: {
    label: 'Codex (OpenAI)',
    bin: 'codex',
    install: 'npm i -g @openai/codex',
    models: [{ value: '', label: 'Whatever Codex is set to' }],
    // Codex is not installed here, so its JSON event schema is unverified.
    // Plain text output streams reliably regardless of version, so use that
    // rather than guessing at a structure — you lose the itemised tool chips,
    // not the answer.
    promptAsArg: true,
    promptFlag: null,        // codex takes the prompt positionally after `exec`
    rawText: true,
    args({ model }) {
      const a = ['exec', '--skip-git-repo-check'];
      if (config.agent.allowBash) a.push('--dangerously-bypass-approvals-and-sandbox');
      if (model) a.push('--model', model);
      return a;
    },
    parse() { /* raw text mode */ },
  },
};

/**
 * Resolve a CLI on PATH, preferring a real executable over a shim.
 *
 * This matters for more than tidiness: Node refuses to spawn .cmd/.ps1 shims
 * directly, so those have to go through cmd.exe — where the prompt, if passed
 * as an argument, is exposed to shell metacharacters. A .exe can be spawned
 * directly with no shell in the middle.
 */
const presence = new Map();

function resolveCli(key) {
  if (presence.has(key)) return presence.get(key);

  const spec = CLI_AGENTS[key];
  let info = { available: false, path: null, needsShell: false };

  if (spec) {
    const probe = isWin ? 'where' : 'which';
    const res = spawnSync(probe, [spec.bin], { encoding: 'utf8', shell: false, windowsHide: true });
    const hits = (res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    if (res.status === 0 && hits.length) {
      // On Windows prefer a real executable, then a .cmd/.bat shim. Never the
      // extensionless npm shim — that's a bash script cmd.exe cannot run.
      const chosen = isWin
        ? ['.exe', '.cmd', '.bat', '.com']
            .map((ext) => hits.find((p) => p.toLowerCase().endsWith(ext)))
            .find(Boolean)
        : hits[0];
      if (!chosen) { presence.set(key, info); return info; }
      info = {
        available: true,
        path: chosen,
        needsShell: isWin && !chosen.toLowerCase().endsWith('.exe'),
      };
    }
  }

  presence.set(key, info);
  return info;
}

export function cliAvailable(key) {
  return resolveCli(key).available;
}

export function availableCliAgents() {
  return Object.fromEntries(Object.keys(CLI_AGENTS).map((k) => [k, cliAvailable(k)]));
}

/** Build a provider adapter for one CLI. */
export function makeCliProvider(key) {
  const spec = CLI_AGENTS[key];

  return {
    id: key,
    label: spec.label,
    defaultModel: '',
    usesOwnTools: true,

    toHistory(messages) {
      return messages.map((m) => ({ role: m.role, content: m.content }));
    },

    async *turn({ model, history, sessionId, signal, onSession, previewContext }) {
      if (!cliAvailable(key)) {
        yield {
          type: 'error',
          message: `${spec.label} isn't installed or isn't on PATH. ${spec.install}`,
        };
        return { assistant: null, toolCalls: [], stop: 'error' };
      }

      const last = [...history].reverse().find((m) => m.role === 'user');
      let prompt = typeof last?.content === 'string' ? last.content : String(last?.content ?? '');

      // These CLIs have their own system prompt and no reliable way to append
      // to it across versions, so the preview contract rides along with the
      // first message of a conversation instead.
      if (previewContext && !sessionId) {
        prompt = `${previewContext}\n\n---\n\n${prompt}`;
      }

      const args = spec.args({ model, sessionId });
      // `-p <prompt>` for CLIs that want it inline, bare for those that take it
      // positionally; stdin for the rest.
      if (spec.promptAsArg) {
        const flag = spec.promptFlag === undefined ? '-p' : spec.promptFlag;
        if (flag) args.push(flag);
        args.push(prompt);
      }

      const env = { ...process.env };
      // Inherited from whatever launched the app; makes a CLI think it's a
      // nested session and quietly changes its behaviour.
      delete env.CLAUDE_CODE_CHILD_SESSION;

      // A real executable is spawned directly. Only .cmd/.ps1 shims need
      // cmd.exe, because Node refuses to spawn batch files (CVE-2024-27980).
      const resolved = resolveCli(key);

      let child;
      try {
        child = spawnCommand(resolved.path, args, {
          cwd: getWorkspaceRoot(),
          env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.on('error', () => { /* reported via close */ });
        if (spec.promptAsArg) child.stdin.end();
        else child.stdin.end(prompt);
      } catch (err) {
        yield { type: 'error', message: `Could not start ${spec.label}: ${err.message}` };
        return { assistant: null, toolCalls: [], stop: 'error' };
      }

      const abort = () => { try { child.kill(); } catch { /* gone */ } };
      signal?.addEventListener('abort', abort, { once: true });

      const queue = [];
      let notify = null;
      let finished = false;
      let stderr = '';
      let stdoutBuf = '';
      let exitCode = null;

      const push = (item) => { queue.push(item); notify?.(); notify = null; };

      child.stdout.on('data', (chunk) => {
        if (spec.rawText) return push({ __text: chunk.toString() });
        stdoutBuf += chunk.toString();
        let i;
        while ((i = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, i).trim();
          stdoutBuf = stdoutBuf.slice(i + 1);
          if (!line) continue;
          try { push(JSON.parse(line)); } catch { /* partial / banner text */ }
        }
      });
      child.stderr.on('data', (c) => { stderr += c.toString(); });
      child.on('error', (e) => { stderr += e.message; finished = true; notify?.(); notify = null; });
      child.on('close', (code) => { exitCode = code; finished = true; notify?.(); notify = null; });

      let text = '';
      let sawOutput = false;
      let failure = null;
      const pending = [];

      const emit = {
        text: (t) => { text += t; pending.push({ type: 'text', text: t }); },
        tool: (id, name, input) => pending.push({ type: 'tool_use', id, name, input }),
        result: (id, ok, content) => pending.push({ type: 'tool_result', id, name: 'tool', ok, content }),
        session: (id) => { if (id) onSession?.(id); },
        fail: (m) => { failure = m; },
      };

      while (!finished || queue.length) {
        if (!queue.length) {
          await new Promise((resolve) => { notify = resolve; });
          continue;
        }
        const msg = queue.shift();
        sawOutput = true;

        if (msg.__text !== undefined) emit.text(msg.__text);
        else spec.parse(msg, emit);

        while (pending.length) yield pending.shift();
      }

      signal?.removeEventListener('abort', abort);

      if (failure) {
        yield { type: 'error', message: failure };
      } else if (!text.trim() && !sawOutput) {
        let hint;
        if (/not (logged in|authenticated)|sign ?in|\/login|unauthor/i.test(stderr)) {
          hint = `${spec.label} isn't logged in. Run \`${spec.bin}\` in the terminal and sign in.`;
        } else if (stderr.trim()) {
          hint = stderr.trim().slice(0, 400);
        } else {
          hint = `${spec.label} exited (code ${exitCode}) without producing output.`;
        }
        yield { type: 'error', message: hint };
      }

      return { assistant: null, toolCalls: [], stop: 'end_turn' };
    },

    pushAssistant() { /* the CLI owns the transcript */ },
    pushToolResults() { /* the CLI runs its own tools */ },
  };
}
