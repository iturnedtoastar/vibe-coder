import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { toParts } from '../messages.js';

/**
 * Models that take adaptive thinking + output_config.effort. Older models
 * (Haiku 4.5, Sonnet 4.5 and earlier) reject `effort` with a 400, so the
 * parameters are gated rather than sent unconditionally.
 */
const ADAPTIVE = /^claude-(opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;

/** Models where safety classifiers can decline a request and a fallback helps. */
const FALLBACK_CAPABLE = /^claude-(opus-5|fable-5|mythos-5)/;

function client(apiKey, baseURL) {
  return new Anthropic({
    apiKey,
    baseURL: baseURL || config.baseUrls.anthropic,
  });
}

function toolSchema(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function buildParams({ model, system, history, tools }) {
  const params = {
    model,
    max_tokens: config.agent.maxTokens,
    system,
    messages: history,
    tools: toolSchema(tools),
  };

  if (ADAPTIVE.test(model)) {
    // Adaptive thinking lets Claude decide depth per turn; `display` opts into
    // a readable summary so the UI can show progress instead of a long pause.
    params.thinking = { type: 'adaptive', display: 'summarized' };
    params.output_config = { effort: config.agent.effort };
  }

  return params;
}

export const anthropic = {
  id: 'anthropic',
  defaultModel: 'claude-opus-5',

  toHistory(messages) {
    return messages.map((m) => {
      // Plain strings stay strings — only promote to blocks when needed.
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: toParts(m.content).map((part) =>
          part.type === 'image'
            ? {
                type: 'image',
                source: { type: 'base64', media_type: part.mediaType, data: part.data },
              }
            : { type: 'text', text: part.text }
        ),
      };
    });
  },

  /**
   * Run one model turn. Yields normalized stream events; the generator's
   * return value carries the assistant turn and any tool calls to execute.
   */
  async *turn({ model, apiKey, baseUrl, system, history, tools, signal }) {
    const c = client(apiKey, baseUrl);
    const params = buildParams({ model, system, history, tools });

    const withFallbacks =
      config.agent.anthropicFallbacks !== 'off' && FALLBACK_CAPABLE.test(model);

    const open = (useFallbacks) =>
      c.beta.messages.stream(
        useFallbacks
          ? { ...params, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] }
          : params,
        { signal }
      );

    let stream = open(withFallbacks);
    let final;

    try {
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { type: 'thinking', text: event.delta.thinking };
        }
      }
      final = await stream.finalMessage();
    } catch (err) {
      // If this account/SDK does not have the fallback beta, retry plainly
      // rather than failing the whole turn.
      const msg = String(err?.message || '');
      if (withFallbacks && /fallback|beta/i.test(msg) && /400|invalid_request/i.test(msg)) {
        stream = open(false);
        for await (const event of stream) {
          if (event.type !== 'content_block_delta') continue;
          if (event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text };
          else if (event.delta.type === 'thinking_delta')
            yield { type: 'thinking', text: event.delta.thinking };
        }
        final = await stream.finalMessage();
      } else {
        throw err;
      }
    }

    if (final.stop_reason === 'refusal') {
      const category = final.stop_details?.category || 'unspecified';
      yield {
        type: 'text',
        text: `\n[Request declined by safety classifiers (${category}). Rephrase, or switch models in Settings.]\n`,
      };
      return { assistant: null, toolCalls: [], stop: 'refusal' };
    }

    // Surface what the turn cost. The SDK reports cache reads separately;
    // they bill differently, so keep them distinct rather than summing.
    if (final.usage) {
      yield {
        type: 'usage',
        inputTokens: final.usage.input_tokens || 0,
        outputTokens: final.usage.output_tokens || 0,
        cacheReadTokens: final.usage.cache_read_input_tokens || 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens || 0,
      };
    }

    const toolCalls = final.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    // Push `final.content` verbatim — thinking blocks must be replayed
    // unchanged on the next turn or the API rejects the conversation.
    return { assistant: { role: 'assistant', content: final.content }, toolCalls, stop: final.stop_reason };
  },

  pushAssistant(history, assistant) {
    if (assistant) history.push(assistant);
  },

  pushToolResults(history, results) {
    history.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        ...(r.ok ? {} : { is_error: true }),
      })),
    });
  },
};
