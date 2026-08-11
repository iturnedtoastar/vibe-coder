import { runAgent, cheapModelFor, PROVIDERS } from './agent.js';

/**
 * Plan before executing.
 *
 * Without this, you type a sentence and the agent spends a full run before you
 * can tell whether it understood you. If it misread the goal you paid for the
 * wrong thing and only found out at the end — one measured run cost 220k
 * tokens building something that wasn't asked for.
 *
 * A planning pass reads the project, states what it intends to do, and stops.
 * It runs on the cheap model with the mutating tools withheld, so producing a
 * plan costs a fraction of a run and physically cannot change a file. You
 * approve, edit, or throw it away before anything expensive starts.
 */

export const PLAN_SYSTEM = `You are working out how to build something, before any code is written.

Read whatever you need to understand the task, then produce the approach. You
have read-only tools: you cannot edit, create, delete, or run anything, and you
should not try.

Your answer goes straight to the engineer who writes the code. Nobody reviews
it first and nobody will answer questions about it, so decide the open
questions yourself and say what you decided. Make the call a good engineer
would make and move on.

Answer with JSON and nothing else — no prose before or after, no code fence:

{
  "summary": "one sentence on what gets built",
  "steps": [
    { "action": "what happens in this step", "files": ["path/one.js"] }
  ],
  "risks": ["decisions you made, and anything that might break"]
}

What makes this worth doing:
- Ground it in files that actually exist. Use the project map, and read the
  files you are unsure about rather than guessing at their contents.
- Three to seven steps. One per meaningful change, not per keystroke.
- Name real paths. "Update the component" helps nobody; "src/Cart.tsx" does.
- Where the request was ambiguous, pick the reading that does the most useful
  work and record that choice in "risks" so the engineer knows it was a choice.
- Say what is NOT in scope if the request could sprawl. Holding the line on
  scope is most of what makes a result feel deliberate rather than sprawling.`;

/** Pull the plan object out of a model response that may still be wrapped. */
export function parsePlan(text) {
  if (!text || !text.trim()) return null;

  const attempts = [text.trim()];

  // Fenced JSON, despite being told not to fence it.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) attempts.push(fenced[1].trim());

  // A plain object embedded in an explanation.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return normalize(parsed);
    } catch { /* try the next shape */ }
  }
  return null;
}

function normalize(plan) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return {
    summary: typeof plan.summary === 'string' ? plan.summary.trim() : '',
    steps: steps.slice(0, 12).map((s) => ({
      action: typeof s === 'string' ? s : String(s?.action || '').trim(),
      files: Array.isArray(s?.files) ? s.files.filter((f) => typeof f === 'string').slice(0, 8) : [],
    })).filter((s) => s.action),
    risks: (Array.isArray(plan.risks) ? plan.risks : [])
      .filter((r) => typeof r === 'string').slice(0, 6),
  };
}

/**
 * Build a plan for `messages`. Never throws: a failed plan degrades to running
 * the task directly rather than blocking the user behind a broken feature.
 */
export async function buildPlan({
  provider, model, apiKey, baseUrl, messages, previewContext, signal, onEvent,
}) {
  const adapter = PROVIDERS[provider];

  // A CLI agent runs its own loop with its own tools and its own plan mode; we
  // cannot withhold its tools, so wrapping it in ours would be a lie.
  if (!adapter || adapter.usesOwnTools) return { skipped: 'provider plans on its own' };

  const planModel = cheapModelFor(provider, model || adapter.defaultModel)
    || model || adapter.defaultModel;

  let text = '';
  let usage = null;

  try {
    for await (const event of runAgent({
      provider,
      model: planModel,
      apiKey,
      baseUrl,
      messages,
      system: PLAN_SYSTEM,
      readOnly: true,
      previewContext,
      signal,
    })) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'done') usage = event.usage;
      if (event.type === 'error') return { error: event.message };
      // Tool activity is surfaced so planning doesn't look like a hang.
      if (onEvent && (event.type === 'tool_use' || event.type === 'thinking')) onEvent(event);
    }
  } catch (err) {
    return { error: err?.message || String(err) };
  }

  const plan = parsePlan(text);
  if (!plan || !plan.steps.length) return { error: 'no usable plan', raw: text.slice(0, 400) };

  return { plan, usage, model: planModel };
}

/**
 * Render an approved plan for the execution run.
 *
 * The executing model gets the plan as instructions rather than as history, so
 * it never re-derives what was already decided — that reasoning is the part you
 * already paid the cheap model to do.
 */
export function planAsInstructions(plan) {
  if (!plan?.steps?.length) return '';

  const lines = [
    '',
    '## Approved plan',
    '',
    'You already worked this out by reading the project. Build it.',
    'Do not re-plan, re-survey the codebase, or restate the plan back — the',
    'thinking is done, and repeating it just costs the user money. If a step',
    'turns out to be wrong once you see the real code, fix it and say so, but',
    'stay inside this scope.',
    '',
    plan.summary ? `Goal: ${plan.summary}` : '',
    '',
  ];

  plan.steps.forEach((step, i) => {
    const files = step.files?.length ? `  (${step.files.join(', ')})` : '';
    lines.push(`${i + 1}. ${step.action}${files}`);
  });

  if (plan.risks?.length) {
    lines.push('', 'Known risks and assumptions:', ...plan.risks.map((r) => `- ${r}`));
  }

  return lines.filter((l) => l !== '').join('\n');
}
