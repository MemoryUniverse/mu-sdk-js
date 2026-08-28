# Releasing — proposed convention

**Status: a proposal, not yet in force.** There is **no git tag** in this repository and nothing
published: `registry.npmjs.org/mu-sdk` returns `404` (verified 2026-08-28). A maintainer should
ratify or amend this before the first tag is cut.

## Versioning

SemVer, `v`-prefixed annotated tags: `v0.1.0`. Pre-1.0: a **minor** bump may break the client API or
the wire shapes it speaks; a **patch** bump never does. No compatibility promise before `v1.0.0`.

The npm `version` field and the git tag must always agree. `npm version 0.1.0` writes the field,
commits, and creates the tag in one step — use it rather than editing the field by hand and
tagging separately, which is how the two drift.

## Cross-language parity

The Python and JavaScript SDKs should carry **the same minor version** when they speak the same
wire surface, so `0.3.x` means one thing in both languages. This is a convention with nothing
enforcing it, which is exactly why it is written down.

There is one asymmetry to decide before the first release: **`mu-sdk` is free on npm but taken on
PyPI** by an unrelated project. The Python SDK therefore has to be renamed, and whoever makes that
call also decides whether this package renames alongside it for symmetry, or keeps `mu-sdk`. Do
not publish here until that decision exists — an npm package named `mu-sdk` whose Python twin is
called something else is a support burden forever.

## The procedure

1. Land everything on the trunk. CI green: lint, typecheck, unit, build.
2. Run the integration tier locally against the Python conformance server. It does not run in CI
   (see CONTRIBUTING.md), so it has to be run by a human before a release, and the release notes
   should say against which commit of `mu-sdk-python` it was run.
3. `npm version 0.1.0` — writes `package.json`, commits, tags `v0.1.0`.
4. Push the commit, then the tag.
5. GitHub Release from the tag; notes grouped by Conventional-Commit type, breaking changes first.
6. `npm publish --provenance --access public` from a workflow using **npm Trusted Publishing /
   OIDC**, not a long-lived `NODE_AUTH_TOKEN` in a repository secret. Provenance is worth the
   setup for a package whose whole promise is that it is thin and auditable.
7. Attach the `dist/` artifact the `build` gate already produces.

Steps 3-7 stay manual until a human has published once by hand. A publishing workflow written
before its first successful manual run is an untested script wired to a trigger — and for npm the
failure mode is a bad version published, which cannot be taken back.

## Before the first publish

- Decide the name (above).
- Confirm `files: ["dist"]` is still right — `npm pack --dry-run` and read the file list. A
  published tarball containing tests, sources or a `.env` is the classic first-release mistake.
- Confirm the package installs and imports from a scratch project on Node 20, both ESM and — if
  the README claims it — TypeScript `moduleResolution: NodeNext`.

## What a tag here does not claim

That the hosted plane accepts every route this client can speak. The integration tier proves this
client against the **conformance server**, which is a faithful stand-in, not the real deployment.
That distinction belongs in the release notes as prose, where it can be qualified.
