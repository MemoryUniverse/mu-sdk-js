# Contributing to mu-sdk-js

`mu-sdk` (JavaScript/TypeScript) is a **thin async wire client** — no engine, no stores, no
strategies, no embedder. It mirrors the Python SDK's wire surface in another language, and the two
staying in step is the point: a request or response shape that differs between them is one bug in
two places.

Its dependency list is one package (`zod`). Please keep it that way.

## Setup

Node 20 or newer (`engines.node: ">=20"`). Unlike the other repositories in this project, this one
has **no cross-repo path dependency** — a plain clone works:

```bash
git clone https://github.com/MemoryUniverse/mu-sdk-js.git
cd mu-sdk-js
npm ci
```

`npm ci`, not `npm install`: it installs exactly `package-lock.json` and fails if the lock and
`package.json` disagree. CI does the same, so a lock you forgot to commit fails here rather than
mysteriously there.

## The gates — run them before you push

Exactly what CI runs, in the same order:

```bash
npm run lint        # biome check src tests  — lint AND format in one pass
npm run typecheck   # tsc --noEmit
npm run test:unit   # vitest run tests/unit
npm run build       # tsup — ESM bundle + .d.ts
```

`npm run lint:fix` and `npm run format` fix what `biome check` reports.

Measured on a clean clone, Node 20.19.0 / npm 10.8.2:

| Gate | Result |
|---|---|
| `npm ci` | ok (~14 s) |
| `npm run lint` | `Checked 31 files in 212ms. No fixes applied.` |
| `npm run typecheck` | clean |
| `npm run test:unit` | `Test Files 9 passed (9)` · `Tests 135 passed (135)` (~14 s) |
| `npm run build` | `ESM dist/index.js 57.99 KB` · `DTS dist/index.d.ts 112.57 KB` |

**The build is a gate, not a release step.** `tsup` emits the type declarations, and a type error
that only appears during declaration emit is invisible to `tsc --noEmit` over the source tree. If
you have ever shipped a package whose `.d.ts` did not compile for consumers, you know why this runs
on every PR.

## The integration tier

`npm run test:integration` does **not** run in CI, and that is a gap being named rather than
papered over. Those tests drive this client against the Python conformance server and the
engine-server, which live in *other repositories* and need Python and `uv` on the runner — see the
`conformance:start` script in `package.json`, which reaches into `../mu-sdk-python`.

Standing that up in CI is worth doing. Standing it up badly would give this project a second,
half-real conformance surface that quietly disagrees with the first, which is worse than not
having one. Until it is built properly, run the integration tier locally or on the dev VM, and say
in your PR whether you did.

## Conventions

- **Commits** follow Conventional Commits: `fix(client): …`, `feat(transport): …`, `!` for
  breaking.
- **Wire parity with `mu-sdk-python` is a hard requirement.** If you change a request body, a
  response shape, an error mapping or a default, the Python SDK almost certainly needs the same
  change. Link the two PRs to each other.
- **Runtime dependencies stay at one.** `zod` earns its place by validating what comes back off
  the wire. A second runtime dependency needs an argument in the PR, not just a line in
  `package.json`.
- **No token, credential or memory content** in anything this library logs, throws or attaches to
  an error. It runs inside someone else's application; what it emits, they inherit.
- **Tests must be able to fail.** Mutate the line your new test guards, watch it go red, then
  revert. A test that passes against both the old and the new behaviour is documentation, not a
  test.

## Licensing

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](../LICENSE).
