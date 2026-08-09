import { config } from '../config.js';
import { sseLines, assertOk } from './sse.js';
import { toParts } from '../messages.js';

/**
 * OpenAI-compatible chat completions with streaming tool calls. Works against
 * api.openai.com and any drop-in compatible endpoint (DeepSeek, Groq,
 * OpenRouter, local llama.cpp / Ollama) via a custom base URL.
 */
export const openai = {
  id: 'openai',
  defaultModel: 'gpt-4o',

  toHistory(messages) {
    return messages.map((m) => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: toParts(m.content).map((part) =>
          part.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
            : { type: 'text', text: part.text }
        ),
      };
    });
  },

  async *turn({ model, apiKey, baseUrl, system, history, tools, signal }) {
    const base = (baseUrl || config.baseUrls.openai).replace(/\/+$/, '');

    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'system', content: system }, ...history],
        // OpenAI rejects an empty `tools` array outright, so omit both fields
        // entirely when running without tools (the plain /api/chat path).
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: 'auto',
            }
          : {}),
      }),
    });
    await assertOk(response, 'OpenAI');

    let text = '';
    // Tool calls arrive as deltas keyed by index; arguments stream as JSON
    // fragments that must be concatenated before parsing.
    const pending = new Map();
    let finishReason = null;

    for await (const payload of sseLines(response)) {
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta || {};
      if (delta.content) {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }
      for (const call of delta.tool_calls || []) {
        // OpenAI always sends `index`, but several compatible endpoints
        // (DeepSeek, Groq, Ollama) omit it. Keying everything on `undefined`
        // would merge parallel calls into one — "read_fileread_file" with two
        // concatenated argument objects.
        const key = call.index ?? call.id ?? pending.size;
        const slot = pending.get(key) || { id: '', name: '', args: '' };

        if (call.id) slot.id = call.id;
        if (call.function?.name) {
          // Some providers stream the name in fragments, others repeat it
          // whole on every delta. Append only what isn't already there.
          if (!slot.name) slot.name = call.function.name;
          else if (!slot.name.endsWith(call.function.name)) slot.name += call.function.name;
        }
        if (call.function?.arguments) slot.args += call.function.arguments;

        pending.set(key, slot);
      }
    }

    const raw = [...pending.values()].filter((c) => c.name);
    const toolCalls = raw.map((c, i) => ({
      id: c.id || `call_${i}_${Date.now()}`,
      name: c.name,
      input: safeParse(c.args),
    }));

    const assistant = {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.input) },
            })),
          }
        : {}),
    };

    return { assistant, toolCalls, stop: finishReason };
  },

  pushAssistant(history, assistant) {
    if (assistant) history.push(assistant);
  },

  pushToolResults(history, results) {
    for (const r of results) {
      history.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  },
};

function safeParse(json) {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return { __malformed_arguments: json };
  }
}
