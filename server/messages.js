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

/**
 * The text a preview screenshot needs to arrive with.
 *
 * The app attaches a shot of the live preview to every message by itself. Sent
 * bare, a model has no way to tell it apart from a reference image the user
 * chose to send, and reads it as the brief: asked to build a retro game, one
 * agent opened the screenshot to "see the visual direction you want" — a
 * picture of the blank page it was about to replace.
 */
const PREVIEW_NOTE =
  'The image below is an automatic screenshot of the live preview, showing how '
  + 'the project currently renders. The user did not attach it and is not asking '
  + 'about it. Use it to check your own work; never treat it as a design to copy.';

/**
 * Parts ready for a model that takes images inline, with each automatic
 * screenshot introduced by the text above. Images the user actually attached
 * are left alone — they speak for themselves.
 */
export function toModelParts(content) {
  const out = [];
  for (const part of toParts(content)) {
    if (part.type === 'image' && part.source === 'preview') {
      out.push({ type: 'text', text: PREVIEW_NOTE });
    }
    out.push(part);
  }
  return out;
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
