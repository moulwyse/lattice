# Configuration

Lattice discovers the nearest Git root. If Git is unavailable, the presence of
a repository-local `lattice.config.json` can act as an explicit project marker.
Automatic discovery refuses a filesystem root, the user's home directory, and
other broad shared-home roots.

## Model settings

The current public configuration schema contains three optional model fields:

```json
{
  "model": "inherit",
  "reasoningEffort": "inherit",
  "modelPolicy": "inherit"
}
```

Copy [`../examples/lattice.config.example.json`](../examples/lattice.config.example.json)
when a project marker or explicit model policy is needed.

### `model`

- a non-empty provider model identifier passes that identifier to Codex;
- `"inherit"` or omission leaves model choice to the next source.

Lattice does not validate that an arbitrary identifier is available to the
account. Avoid documenting a model as supported solely because the string is
accepted.

### `reasoningEffort`

Accepted values are `minimal`, `low`, `medium`, `high`, `xhigh`, and
`inherit`. Availability still depends on the provider model and installed SDK.

### `modelPolicy`

- `inherit` is the safe default;
- `adaptive` is experimental and can select a built-in model/effort pair for
  low- or medium-risk tasks when no observed Codex session takes precedence.

Adaptive selection can become stale as provider catalogs change. Use explicit
settings for controlled evaluations.

## Precedence

For model and reasoning effort, the intended precedence is:

1. CLI override;
2. `lattice.config.json`;
3. observed active Codex session state;
4. experimental adaptive policy;
5. official Codex configuration or provider default.

The resolved source is included in runtime output and `doctor` diagnostics.

## Credentials

There is no supported credential field in `lattice.config.json`. Do not add
keys, cookies, bearer values, or provider session state. Use the provider's
official authentication mechanism and keep its configuration outside the
project.

## Ignore behavior and generated state

Lattice records generated state in `.lattice/`. The repository
`.gitignore` and `.latticeignore` are used by indexing and should exclude
generated, vendored, and sensitive material appropriate to the project.
Ignore rules reduce accidental indexing but are not an authorization system.
Never place production credentials inside the repository.

## Verification commands

The runtime accepts only known verification commands:

```text
npm test
npm run test
npm run build
npm run lint
npx tsc --noEmit
npx vitest run
```

The command allowlist is intentionally narrow. Extending it changes the
security boundary and requires tests and documentation.
