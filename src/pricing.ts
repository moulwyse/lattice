/**
 * First-party Claude API list prices in USD per million tokens, used only to
 * estimate the cost of ordinary Claude Code sessions, whose logs record tokens
 * but not cost. Cache writes are billed at 1.25x input (2x for one-hour
 * writes); cache reads at 0.1x input unless the model has its own rate.
 * Unknown models, and every Codex model, have no estimate.
 */
type Price = { input: number; output: number; cacheRead?: number };

// Longest prefix first: `claude-opus-5` must not match `claude-opus-5-5`.
const CLAUDE_PRICES: [prefix: string, price: Price][] = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4-6', { input: 3, output: 15 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
];

export function claudePrice(model: unknown): Price | null {
  if (typeof model !== 'string') return null;
  const id = model.toLowerCase().replace(/^(?:[a-z]+\.)?anthropic\./, '');
  for (const [prefix, price] of CLAUDE_PRICES) {
    if (id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}[`)) {
      // `claude-opus-5-20260101` is Opus 5; `claude-opus-5-5` was matched above.
      return price;
    }
  }
  return null;
}

export type ClaudeUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: { ephemeral_1h_input_tokens?: unknown } | null;
};

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Estimated USD for one assistant message, or null for an unpriced model. */
export function claudeMessageCost(model: unknown, usage: ClaudeUsage) {
  const price = claudePrice(model);
  if (!price) return null;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const hourWrite = Math.min(cacheWrite, count(usage.cache_creation?.ephemeral_1h_input_tokens));
  return (
    count(usage.input_tokens) * perToken(price.input) +
    (cacheWrite - hourWrite) * perToken(price.input * 1.25) +
    hourWrite * perToken(price.input * 2) +
    count(usage.cache_read_input_tokens) * perToken(price.cacheRead ?? price.input * 0.1) +
    count(usage.output_tokens) * perToken(price.output)
  );
}

/** USD per uncached input token, for valuing context that was never sent. */
export function claudeInputPrice(model: unknown) {
  const price = claudePrice(model);
  return price ? price.input / 1_000_000 : null;
}
