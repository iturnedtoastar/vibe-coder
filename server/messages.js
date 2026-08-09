/**
 * Normalized multimodal messages.
 *
 * A message's `content` is either a plain string (the common case) or an array
 * of parts:
 *
 *   { type: 'text',  text }
 *   { type: 'image', mediaType, data }     // data is base64, no data: prefix
 *
 * Every provider accepts images in a different shape, so this module is the one
 * place that knows the difference. Adapters call `toParts` and map from there.
 */

/** Always returns an array of parts, whatever shape the message arrived in. */
export function toParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }];
  return content.filter((p) => p && (p.type === 'text' || p.type === 'image'));
}

/** True if any message carries an image. */
export function hasImages(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image'));
}

/** The text of a message, ignoring images. Used by CLIs that take a prompt string. */
export function textOf(content) {
  return toParts(content)
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/** Every image in a message. */
export function imagesOf(content) {
  return toParts(content).filter((p) => p.type === 'image');
}

/** Accepts a data: URL or raw base64 and returns { mediaType, data }. */
export function parseImage(input) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(input || ''));
  if (match) return { mediaType: match[1], data: match[2] };
  return { mediaType: 'image/png', data: String(input || '') };
}
