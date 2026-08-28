## What this changes

<!-- One paragraph. What is different after this PR that was not true before it? -->

## Why

<!-- The problem, not the patch. Fixes #123 -->

## Does this change the wire surface?

- [ ] No — internal only.
- [ ] Yes. Then: **has the matching change been made in `mu-sdk-python`?** Link it. Two SDKs that
      disagree about the wire are one bug in two places.

## How to see it fail without this change

<!-- Name the test, or paste the command and the output you saw before the fix. -->

## Gates

Run locally on Node 20+:

- [ ] `npm ci`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run build`
- [ ] `npm run test:integration` (needs the Python conformance server — ran / not applicable / could not run: say which)

## Checks that are not automatable

- [ ] **No token, credential or memory content** in anything this code logs, throws, or attaches to
      an error object.
- [ ] No new runtime dependency. (If there is one, argue for it here — this package ships exactly
      one on purpose.)
- [ ] Public API changes are reflected in the emitted `.d.ts` and in the README's examples.
- [ ] Any new test can actually fail — I mutated the line it guards and watched it go red.
- [ ] Nothing here weakens or disables a gate.

## Anything a reviewer should push back on

<!-- Shortcuts, open questions, wire-shape decisions you are unsure about. -->
