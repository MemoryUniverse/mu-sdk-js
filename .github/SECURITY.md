# Security policy

`mu-sdk` for JavaScript is a client library: it runs inside someone else's application, holds their
credentials, and carries their users' data over the wire. A vulnerability here is a vulnerability in
every application that depends on it.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:
**[Security → Report a vulnerability](https://github.com/MemoryUniverse/mu-sdk-js/security/advisories/new)**.

If that form is unavailable to you, open a normal issue containing only *"I need a private channel
for a security report"* — **no details** — and a maintainer will open an advisory and invite you.

## What to include

- What an attacker can do, and what they must already control (the server? the network? a response
  body?).
- The smallest reproduction you have.
- The commit you saw it on.

**Never include real tokens, memory content or personal data.** Redact, and say what you redacted.

## What to expect

| | Target |
|---|---|
| Acknowledgement | within 3 working days |
| First assessment | within 10 working days |
| Fix or a dated plan | agreed with you on the advisory |

Credit in the advisory unless you ask us not to.

## Supported versions

**None yet.** No git tag, and nothing published to npm — `registry.npmjs.org/mu-sdk` returns `404`
(verified 2026-08-28). If a package by that name appears on npm before this project announces a
release, **it is not ours.** See [RELEASING.md](RELEASING.md).

## Scope

Especially in scope:

- A token, API key or credential reaching a log line, a thrown error's message, or a property
  attached to an error object that an application will serialize into its own logs.
- Memory content reaching any of the same places.
- TLS verification that can be disabled by configuration, or a fall back to plain HTTP without
  saying so.
- A malicious or compromised **server response** that can make this client do something worse than
  throw — prototype pollution through parsed JSON, unbounded allocation, or an error path that
  leaks the request it was retrying.
- The token auto-load path reading a credential from an unexpected location.
- Anything in the published `dist/` that is not in `src/`, or a build that can inject into it.

Out of scope: advisories in `zod` or the dev toolchain with no exploitable path through this code
(report upstream, and tell us so we can pin), and the hosted plane, which is not in this repository.
