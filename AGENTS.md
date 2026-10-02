<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# ArtQ repository rules (all agents)
The full rules are in [CLAUDE.md](CLAUDE.md). In short:
- **Tests:** every testable feature or fix ships with automated tests covering the happy path, negative paths (invalid input,
  unauthorized, wrong state, not found) and edge/failure cases; run the whole suite (`pnpm build && pnpm typecheck && pnpm lint && pnpm test`,
  plus `pnpm validate:docs` when the database design changes) and report real results.
- **Commits:** work on a `phase-<n>` branch; commit when each phase is complete with the suite green; never push or merge unless asked.
- **Validation:** frontend and backend use the same criteria: one Zod schema per request in `@artq/shared`, imported by the
  API and the form (forms may only add client-only fields such as "repeat password"). Forms validate with Zod (React Hook
  Form + `zodResolver`); every invalid field gets a red border and its message in red directly under it (server field
  errors mapped back onto the field). Applies to every form, strictly.
