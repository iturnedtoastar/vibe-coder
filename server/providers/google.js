import { config } from '../config.js';
import { sseLines, assertOk } from './sse.js';
import { toParts } from '../messages.js';

/**
 * Gemini expects an OpenAPI-flavoured schema with UPPERCASE type names and
 * rejects several standard JSON Schema keywords, so tool parameters are
 * translated rather than passed through.
 */
function toGeminiSchema(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' || key === '$schema') continue;
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
    } else if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)])
      );
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const google = {
  id: 'google',
  defaultModel: 'gemini-2.5-pro',

  toHistory(messages) {
    return messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: toParts(m.content).map((part) =>
        part.type === 'image'
          ? { inlineData: { mimeType: part.mediaType, data: part.data } }
          : { text: part.text }
      ),
    }));
  },

  async *turn({ model, apiKey, baseUrl, system, history, tools, signal }) {
    const base = (baseUrl || config.baseUrls.google).replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: history,
        // An empty functionDeclarations list is rejected, so send neither field
        // when running without tools.
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: toGeminiSchema(t.parameters),
                  })),
                },
              ],
              toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            }
          : {}),
      }),
    });
    await assertOk(response, 'Google');

    const parts = [];
    let finishReason = null;

    for await (const payload of sseLines(response)) {
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) finishReason = candidate.finishReason;

      for (const part of candidate.content?.parts || []) {
        if (typeof part.text === 'string' && part.text) {
          parts.push({ text: part.text });
          yield { type: 'text', text: part.text };
        } else if (part.functionCall) {
          parts.push({ functionCall: part.functionCall });
        }
      }
    }

    // Gemini does not assign ids to function calls, so synthesize stable ones
    // and keep the call name for building the matching functionResponse.
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `${p.functionCall.name}_${i}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      }));

    return {
      assistant: parts.length ? { role: 'model', parts } : null,
      toolCalls,
      stop: finishReason,
    };
  },

  pushAssistant(history, assistant) {
    if (assistant) history.push(assistant);
  },

  pushToolResults(history, results) {
    history.push({
      role: 'user',
      parts: results.map((r) => ({
        functionResponse: {
          name: r.name,
          response: r.ok ? { result: r.content } : { error: r.content },
        },
      })),
    });
  },
};
