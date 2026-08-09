#!/usr/bin/env node
'use strict';

/**
 * Vibe Agent CLI.
 *
 * This runs as a real process inside a real PTY, exactly like any other command
 * line tool — so you can Ctrl-C out of it and `npm start`, `git status`, or run
 * anything else in the same terminal.
 *
 * It is deliberately thin: all provider and tool logic lives in the local
 * server, which it drives over the same token-gated HTTP API the UI uses.
 *
 * CommonJS on purpose — it is launched through Electron's bundled Node
 * (ELECTRON_RUN_AS_NODE=1) so it can be read out of the packaged app.asar.
 */

const readline = require('node:readline');
const path = require('node:path');
const os = require('node:os');

const BASE = process.env.VIBE_URL || 'http://127.0.0.1:4400';
const TOKEN = process.env.VIBE_TOKEN || '';
const PROVIDER = process.env.VIBE_PROVIDER || 'anthropic';
const MODEL = process.env.VIBE_MODEL || '';
const API_KEY = process.env.VIBE_API_KEY || '';
const BASE_URL = process.env.VIBE_BASE_URL || '';
const VERSION = process.env.VIBE_VERSION || '1.0.0';

// ---------------------------------------------------------------- styling ---

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
  accent: '\x1b[38;2;217;119;87m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[97m',
};

/** Tool names read better in a terminal as verbs than as snake_case. */
const TOOL_LABELS = {
  list_files: 'ListDir',
  read_file: 'ReadFile',
  write_file: 'WriteFile',
  edit_file: 'EditFile',
  delete_file: 'DeleteFile',
  search: 'Search',
  run_command: 'Shell',
};

function tilde(p) {
  const home = os.homedir();
  return p && p.startsWith(home) ? '~' + p.slice(home.length).split(path.sep).join('/') : p;
}

function banner(status) {
  const model = MODEL || '(server default)';
  const lines = [
    '',
    `  ${C.accent}${C.bold}█▀▀▀▀▀▀▀█${C.reset}    ${C.bold}${C.white}Vibe Agent CLI ${VERSION}${C.reset}`,
    `  ${C.accent}${C.bold}█  ${C.white}>_${C.accent}   █${C.reset}    ${C.dim}${PROVIDER} · ${model}${C.reset}`,
    `  ${C.accent}${C.bold}█▄▄▄▄▄▄▄█${C.reset}    ${C.dim}${tilde(status.workspace)}${C.reset}`,
    '',
    `  ${C.dim}Ask for anything in this folder. It can read, write, search and run commands.${C.reset}`,
    `  ${C.dim}/help for commands · /exit drops you back to the shell${C.reset}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function help() {
  process.stdout.write(
    `\n  ${C.bold}Commands${C.reset}\n` +
    `    ${C.cyan}/help${C.reset}    this list\n` +
    `    ${C.cyan}/clear${C.reset}   clear the screen and forget the conversation\n` +
    `    ${C.cyan}/reset${C.reset}   forget the conversation, keep the screen\n` +
    `    ${C.cyan}/exit${C.reset}    leave the agent and return to the shell\n` +
    `    ${C.dim}Ctrl-C${C.reset}   stop whatever it is doing\n\n` +
    `  ${C.dim}This is a normal terminal — after /exit you can run npm, git, node, anything.${C.reset}\n\n`
  );
}

// ------------------------------------------------------------------ agent ---

const history = [];
let controller = null;

async function getStatus() {
  const res = await fetch(`${BASE}/api/status`, { headers: { 'x-vibe-token': TOKEN } });
  if (!res.ok) throw new Error(`backend returned ${res.status}`);
  return res.json();
}

async function ask(prompt) {
  history.push({ role: 'user', content: prompt });
  controller = new AbortController();

  const res = await fetch(`${BASE}/api/agent`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json', 'x-vibe-token': TOKEN },
    body: JSON.stringify({
      provider: PROVIDER,
      model: MODEL || undefined,
      apiKey: API_KEY || undefined,
      baseUrl: BASE_URL || undefined,
      messages: history,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let atLineStart = true;

  const write = (s) => { process.stdout.write(s); atLineStart = s.endsWith('\n'); };
  const breakLine = () => { if (!atLineStart) write('\n'); };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;

      let event;
      try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }

      if (event.type === 'text') {
        reply += event.text;
        write(event.text);
      } else if (event.type === 'tool_use') {
        const label = TOOL_LABELS[event.name] || event.name;
        const detail = event.input?.path || event.input?.command || event.input?.pattern || '';
        breakLine();
        write(`${C.accent}●${C.reset} ${C.bold}${label}${C.reset}${detail ? `${C.dim}(${String(detail).slice(0, 80)})${C.reset}` : ''}\n`);
      } else if (event.type === 'tool_result' && !event.ok) {
        const first = String(event.content).split('\n')[0].slice(0, 140);
        write(`  ${C.red}✗ ${first}${C.reset}\n`);
      } else if (event.type === 'error') {
        breakLine();
        write(`${C.red}Error: ${event.message}${C.reset}\n`);
      } else if (event.type === 'done') {
        breakLine();
        if (event.changedFiles?.length) {
          write(`${C.dim}  ${event.changedFiles.length} file(s) changed${C.reset}\n`);
        }
      }
    }
  }

  breakLine();
  if (reply.trim()) history.push({ role: 'assistant', content: reply });
  controller = null;
}

// ------------------------------------------------------------------- loop ---

async function main() {
  let status;
  try {
    status = await getStatus();
  } catch (err) {
    process.stdout.write(`${C.red}Cannot reach the Vibe Coder backend: ${err.message}${C.reset}\n`);
    process.exit(1);
  }

  banner(status);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.accent}>${C.reset} `,
    historySize: 200,
  });

  // Ctrl-C stops the current request rather than killing the CLI.
  rl.on('SIGINT', () => {
    if (controller) {
      controller.abort();
      controller = null;
      process.stdout.write(`\n${C.yellow}Stopped.${C.reset}\n`);
    } else {
      process.stdout.write(`\n${C.dim}(/exit to leave)${C.reset}\n`);
    }
    rl.prompt();
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) { rl.prompt(); continue; }
    if (input === '/exit' || input === 'exit' || input === '/quit') break;
    if (input === '/help') { help(); rl.prompt(); continue; }
    if (input === '/clear') {
      history.length = 0;
      process.stdout.write('\x1b[2J\x1b[H');
      banner(status);
      rl.prompt();
      continue;
    }
    if (input === '/reset') {
      history.length = 0;
      process.stdout.write(`${C.dim}Conversation cleared.${C.reset}\n`);
      rl.prompt();
      continue;
    }

    try {
      await ask(input);
    } catch (err) {
      if (err.name !== 'AbortError') {
        process.stdout.write(`${C.red}${err.message}${C.reset}\n`);
      }
    }
    rl.prompt();
  }

  rl.close();
  process.stdout.write(`${C.dim}Leaving the agent. You're back in the shell.${C.reset}\n`);
}

main();
