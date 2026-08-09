/**
 * Parse a `fetch` response body as Server-Sent Events, yielding each `data:`
 * payload as a string. Handles chunk boundaries splitting mid-event.
 */
export async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') yield payload;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

export async function assertOk(response, provider) {
  if (response.ok) return;
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 800);
  } catch {
    /* body already consumed */
  }
  throw new Error(`${provider} API error ${response.status}: ${detail || response.statusText}`);
}
