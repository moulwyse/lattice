import { type Readable } from 'node:stream';

const MAX_HOOK_INPUT_BYTES = 64 * 1024;

/**
 * Read one Codex hook JSON value. Kept free of heavy imports: hooks run on
 * every matched tool call, where module loading dominates their latency.
 */
export async function readCodexHookInput(input: Readable) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_HOOK_INPUT_BYTES) {
      throw new Error(`Codex hook input exceeds ${MAX_HOOK_INPUT_BYTES} bytes`);
    }
    chunks.push(value);
    const buffered = Buffer.concat(chunks).toString('utf8');
    const newline = buffered.indexOf('\n');
    const candidate = newline >= 0 ? buffered.slice(0, newline) : buffered;
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      if (newline >= 0) throw error;
      // The JSON value may span more than one stream chunk. Keep reading until
      // it becomes complete, but never wait for EOF once it is parseable.
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
