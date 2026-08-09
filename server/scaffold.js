import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { config, getWorkspaceRoot, isFolderOpen } from './config.js';

/**
 * Scaffold a real framework project into the open folder.
 *
 * Everything here shells out to the upstream generators rather than vendoring
 * templates, so what you get is whatever those projects ship today — no stale
 * copies to maintain. The output lands in the folder you already have open, so
 * it flows straight into the existing edit → preview → deploy loop.
 */

const isWin = process.platform === 'win32';

/**
 * Curated starting points. `npx <generator>` is used for anything with an
 * official CLI; everything else is copied out of a git repo subdirectory with
 * degit, which is how vercel/examples is meant to be consumed.
 */
export const TEMPLATES = {
  'next': {
    label: 'Next.js',
    group: 'Framework',
    description: 'React framework with routing, server components and API routes.',
    run: (name) => ['create-next-app@latest', '.', '--yes', '--use-npm'],
  },
  'next-tailwind': {
    label: 'Next.js + Tailwind',
    group: 'Framework',
    description: 'Next.js preconfigured with Tailwind CSS and TypeScript.',
    run: () => ['create-next-app@latest', '.', '--yes', '--typescript', '--tailwind', '--eslint', '--app', '--use-npm'],
  },
  'vite-react': {
    label: 'Vite + React',
    group: 'Framework',
    description: 'Fast dev server, minimal setup.',
    run: () => ['create-vite@latest', '.', '--template', 'react-ts'],
  },
  'astro': {
    label: 'Astro',
    group: 'Framework',
    description: 'Content-focused sites that ship almost no JavaScript.',
    run: () => ['create-astro@latest', '.', '--template', 'minimal', '--install', '--no-git', '--skip-houston'],
  },
  'commerce': {
    label: 'Next.js Commerce',
    group: 'Template',
    description: 'A production storefront template.',
    degit: 'vercel/commerce',
  },
  'ai-chatbot': {
    label: 'AI Chatbot',
    group: 'Template',
    description: 'Vercel\'s AI chatbot starter.',
    degit: 'vercel/ai-chatbot',
  },
  'eve-agent': {
    label: 'Eve agent',
    group: 'Agent',
    description: 'Filesystem-first durable AI agent (vercel/eve).',
    run: () => ['eve@latest', 'init', '--yes'],
  },
  'chat-bot': {
    label: 'Chat SDK bot',
    group: 'Agent',
    description: 'Bot for Slack, Discord, Teams and others (vercel/chat).',
    run: () => ['create-chat-sdk@latest', '.'],
  },
};

/** Pull one example out of vercel/examples by its directory name. */
export function vercelExampleTemplate(example) {
  return { label: example, degit: `vercel/examples/${example}` };
}

function have(bin) {
  const res = spawnSync(isWin ? 'where' : 'which', [bin], {
    encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (res.status !== 0) return null;
  const hits = (res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!isWin) return hits[0] || null;
  return hits.find((h) => /\.(exe|cmd|bat|com)$/i.test(h)) || null;
}

let cache = null;

export function scaffoldStatus({ force = false } = {}) {
  if (cache && !force) return cache;
  const npx = have('npx');
  cache = {
    available: Boolean(npx),
    npx,
    templates: Object.entries(TEMPLATES).map(([id, t]) => ({
      id, label: t.label, group: t.group, description: t.description,
    })),
    hint: 'Scaffolding needs Node.js (which provides npx).',
  };
  return cache;
}

function runNpx(args, { onOutput, timeoutMs = 900000 } = {}) {
  const npx = have('npx');
  const needsShell = isWin && npx && !npx.toLowerCase().endsWith('.exe');
  const command = needsShell ? (process.env.ComSpec || 'cmd.exe') : npx;
  const argv = needsShell ? ['/d', '/s', '/c', npx, ...args] : args;

  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: getWorkspaceRoot(),
      windowsHide: true,
      // Generators prompt by default; CI makes them take the defaults instead
      // of hanging forever on a question nobody can answer.
      env: { ...process.env, CI: '1', npm_config_yes: 'true', ADBLOCK: '1' },
    });

    let out = '';
    const push = (c) => {
      const text = c.toString();
      if (out.length < config.maxToolOutput * 2) out += text;
      onOutput?.(text);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: out + err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function folderIsEmpty() {
  try {
    const entries = await fsp.readdir(getWorkspaceRoot());
    return entries.filter((e) => !e.startsWith('.')).length === 0;
  } catch {
    return true;
  }
}

/**
 * Scaffold `template` into the open folder.
 * Refuses to write over an existing project unless `force` is set.
 */
export async function scaffold({ template, example, force = false, onOutput } = {}) {
  const status = scaffoldStatus({ force: true });
  if (!status.available) return { error: status.hint };
  if (!isFolderOpen()) return { error: 'Open or create a project first — scaffolding writes into the open folder.' };

  const spec = example ? vercelExampleTemplate(example) : TEMPLATES[template];
  if (!spec) {
    return { error: `Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}` };
  }

  if (!force && !(await folderIsEmpty())) {
    return { error: 'The folder already has files. Create a new project first, or pass force to overwrite.' };
  }

  const args = spec.degit
    ? ['--yes', 'degit', spec.degit, '.', '--force']
    : spec.run();

  const res = await runNpx(args, { onOutput });

  if (res.code !== 0) {
    return { error: `Scaffold failed (exit ${res.code}).\n${res.out.slice(-800)}` };
  }

  const files = (await fsp.readdir(getWorkspaceRoot())).filter((f) => !f.startsWith('.'));
  return { template: spec.label, files: files.length, log: res.out.slice(-1500) };
}

/** Add Vercel Analytics and Speed Insights to the project in the open folder. */
export async function addVercelInsights({ onOutput } = {}) {
  if (!isFolderOpen()) return { error: 'Open a project first.' };
  const pkg = path.join(getWorkspaceRoot(), 'package.json');
  if (!fs.existsSync(pkg)) {
    return { error: 'No package.json here — analytics packages need a framework project. Scaffold one first.' };
  }

  const res = await runNpx(
    ['--yes', 'npm', 'install', '@vercel/analytics', '@vercel/speed-insights'],
    { onOutput, timeoutMs: 300000 }
  );
  if (res.code !== 0) return { error: `Install failed.\n${res.out.slice(-600)}` };

  return {
    installed: ['@vercel/analytics', '@vercel/speed-insights'],
    next: 'Render <Analytics /> and <SpeedInsights /> in your root layout. They only report once deployed to Vercel.',
  };
}

export const SCAFFOLD_TOOLS = [
  {
    name: 'scaffold_project',
    description:
      'Scaffold a real framework project into the open folder using the official generator. Templates: '
      + Object.entries(TEMPLATES).map(([id, t]) => `${id} (${t.label})`).join(', ')
      + '. Alternatively pass "example" to copy any directory name from the vercel/examples repository. Refuses to overwrite a non-empty folder unless force is true.',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template id, e.g. "next-tailwind".' },
        example: { type: 'string', description: 'A directory name from github.com/vercel/examples.' },
        force: { type: 'boolean', description: 'Scaffold even if the folder is not empty.' },
      },
      required: [],
    },
  },
  {
    name: 'add_vercel_insights',
    description:
      'Add @vercel/analytics and @vercel/speed-insights to the project in the open folder. Requires a package.json.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

export function scaffoldToolsAvailable() {
  return scaffoldStatus().available;
}

/**
 * UI guidance from components.build — a specification rather than a library, so
 * it's most useful as instruction the agent actually follows when writing
 * components, not as a dependency.
 */
export const COMPONENT_GUIDANCE = `
## Writing UI components

Follow the components.build principles:
- Compose small parts rather than one component with many boolean props.
- Keep state where it belongs: let the caller own it when they might need it.
- Semantic HTML first. A button is a <button>; only reach for ARIA when no
  element already carries the meaning.
- Every interactive element must be reachable and operable by keyboard, with a
  visible focus style.
- Respect prefers-reduced-motion and prefers-color-scheme.
- Style through tokens or classes the caller can override; never hard-code a
  colour a consumer cannot change.
`;
