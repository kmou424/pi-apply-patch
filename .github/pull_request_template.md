## Summary

<!-- Brief description, 1-3 bullets -->

-

## Verification

- [ ] `npm run check` (typecheck + biome)
- [ ] `npm test` (unit tests)
- [ ] `npm pack --dry-run` (release sanity)
- [ ] `pi -e ./src/index.ts` smoke-tested locally, if behavior changed

## apply_patch impact

- [ ] Tool schema / grammar changes are documented in README if changed
- [ ] Workspace path safety remains covered by tests
- [ ] CHANGELOG entry added under `[Unreleased]` if user-facing
