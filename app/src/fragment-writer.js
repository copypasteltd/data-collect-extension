export const FRAGMENT_LENGTH = 100000;

export function fragmentReference(text, captureId, field) {
  return { captureId, field, length: text.length, parts: Math.ceil(text.length / FRAGMENT_LENGTH) };
}
