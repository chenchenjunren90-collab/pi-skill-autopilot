## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] No new code path installs a skill without a `ctx.ui.confirm` (or `askWhichToInstall`)
- [ ] Failures still degrade to a note instead of throwing (search, scan, install)
- [ ] Relevance changes are reflected in the README scoring rule, or the rule is unchanged
- [ ] `CHANGELOG.md` updated for user-visible changes

## Safety

<!-- Delete what does not apply. -->

- [ ] This change does not add a way to install without explicit user confirmation
- [ ] This change does not widen what is installed by default
- [ ] New dangerous-pattern rules are added to `risk.ts` (not to an ad-hoc blocklist)
