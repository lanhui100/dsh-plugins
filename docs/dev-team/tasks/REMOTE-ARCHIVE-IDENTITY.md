# Task REMOTE-ARCHIVE-IDENTITY

- Status: Validation
- Complexity: B
- Scope: Normalize remote archive/pin operation response IDs at the Host boundary and add multi-host regression coverage.
- Owner: implementation-engineer (orchestrated in current session)
- Spec: `docs/dev-team/specs/remote-archive-identity.md`
- Review: completed (plan/spec reviews A/B/C + code review A/B, see spec review record)

## Acceptance criteria

1. Archive and unarchive responses for namespaced remote IDs return namespaced IDs matching `/remote-ssh/sessions`. — Done (manager mode; legacy single-caller keeps raw consistent with its raw snapshot).
2. Pin and unpin responses use the same identity normalization. — Done.
3. Local archived/pinned IDs remain in merged client state. — Done (client local/remote set split + per-host merge).
4. A multi-host regression test fails on the old raw-ID response and passes after the fix. — Done (`smoke-multi-host.mjs` mutation assertions + new `smoke-archive-multi.mjs`).
5. Existing single-host smoke, typecheck, and build remain green. — Done.

## Verification evidence

- `pnpm --filter dsh-plugin-remote-ssh typecheck` — passed.
- `pnpm --filter dsh-plugin-remote-ssh build` — passed.
- `node packages/dsh-plugin-remote-ssh/smoke-multi-host.mjs` — passed (incl. archive/unarchive/pin/unpin identity).
- `node packages/dsh-plugin-remote-ssh/smoke-archive-multi.mjs` — passed (client-level multi-host regression).
- Offline smoke suite (client-bundle, manager, command, timing, host-apply, question-card, settings-ui, ssh-config) — passed.
- `smoke-route.mjs` — requires an isolated real-remote fixture (mutates remote state); not executed offline.

## Next Action

Final review sign-off; prepare commit message if user requests a commit.

## Resume Hint

Inspect `src/route.ts` (manager-mode mutation normalization), `client.js` (local/remote set split, per-host merge, recursion guard, pin sync), and `smoke-archive-multi.mjs`.

