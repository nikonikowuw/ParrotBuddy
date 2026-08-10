/**
 * Encode an ``ArrayBuffer`` as a base64 string.
 *
 * ``btoa`` cannot take large strings, so the bytes are chunked through 32 KB
 * windows. ``globalThis.btoa`` keeps this usable both on the main thread and
 * inside Web Workers.
 */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return globalThis.btoa(binary);
}
