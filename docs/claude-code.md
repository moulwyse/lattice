# Claude Code adapter roadmap

Claude Code support is planned, but it is not implemented or advertised as
working today.

Lattice keeps repository discovery, context selection, edit grants,
fingerprint validation, transactions, and verification independent from the
worker that proposes a patch. A Claude Code adapter should map that existing
worker contract to an official, supported Claude Code interface without
weakening the current safety or evidence boundaries.

## Work required

- select an official Claude Code SDK or documented local interface;
- map model selection and effort controls without inventing identifiers;
- preserve Lattice's bounded request and canonical response protocol;
- account for every provider-reported model call, retry, and tool-mediated
  invocation;
- define cancellation, timeout, authentication, and error behavior;
- add credential-free contract tests and an opt-in capped live smoke test;
- document data handling, retention, pricing, and platform support;
- run the same paired evaluation protocol used for any provider claim.

## Current blocker

The maintainer does not currently have the Claude Code tooling and sustained
usage allowance needed to implement and validate the adapter responsibly.
Access through the Claude for Open Source program would be used to build the
adapter, exercise it on public or synthetic repositories, and publish the
resulting tests and disclosed compatibility evidence.

Contributions are welcome through the provider-adapter issue template. Do not
send credentials, private repositories, or Claude session data in an issue or
pull request.
