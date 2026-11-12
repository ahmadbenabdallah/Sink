# Sink Repository Guide

## Non-obvious constraints

- Write all documentation and code comments in English.
- Use Node.js 24 or newer and pnpm 11.11.0 (`package.json` is authoritative). The root package is the Nuxt app; `docs/` is the `@sink/docs` VitePress workspace package.
- Do not hand-edit `app/components/ui/**`; it is managed by shadcn-vue and excluded from ESLint.
- Read `DESIGN.md` before UI work. The authoritative design sources are `app/assets/css/tailwind.css` and `app/components/ui/**`; `DESIGN.md` is a derived summary.
- Do not invent undocumented design tokens.
- Feature-level classes should stay focused on layout and composition. Prefer shared component variants and sizes over overriding primitive chrome such as radius, border, shadow, background, typography, padding, height, or focus, hover, and disabled states. Recurring product-specific exceptions should become app-owned wrappers outside `app/components/ui/**`.
- Use `DropdownMenu` for compact contextual action lists and `Popover` for richer anchored content; do not simulate menu items with buttons inside a `Popover`.
- Compose dashboard navigation and utilities with `SidebarMenu`, `SidebarMenuItem`, and `SidebarMenuButton`; do not recreate sidebar hover, focus, radius, or collapsed behavior with raw controls.
- After changing design tokens or `DESIGN.md`, run `npx @google/design.md lint DESIGN.md` and resolve all errors.
- Nuxt and server utilities are auto-imported. Follow nearby code before adding explicit imports for framework globals.
- Use `@lucide/vue` for Lucide icons; do not add `lucide-vue-next`.
- Application forms must live in dedicated `*Form.vue` components and should prefer `@tanstack/vue-form`. Generated components under `app/components/ui/form/**` may use `vee-validate` internally.
- Business dialogs must live in dedicated `*Dialog.vue` or `*Modal.vue` components; use `AlertDialog` for confirmations and `ResponsiveModal` for task content that adapts between dialog and drawer, and do not inline these implementations in unrelated components.
- Locale messages live in `i18n/locales/<locale>/*.json` and are loaded through the module list in `i18n/config.json`, which `i18n/i18n.ts` maps to locale files. Organize feature messages by their owning product domain; do not introduce cross-cutting `ux`, `ui`, or `messages` namespaces at the top level or across product domains.
- Keep every locale directory aligned on module files, translation keys, and interpolation placeholders. When moving a key or changing the module list, update every locale and all application references in the same change.

## Setup and commands

```bash
pnpm install                              # also runs build:map, nuxt prepare, and hook setup
pnpm dev                                  # Nuxt dev server on port 7465
pnpm build                                # production build with an 8 GB Node heap
pnpm preview                              # requires existing .output build artifacts
pnpm dev:docs                             # VitePress docs dev server
pnpm build:docs                           # production docs build
pnpm preview:docs                         # preview the docs build
pnpm lint                                 # check only
pnpm lint:fix                             # modifies files
pnpm types:check
pnpm test --run                           # full Vitest run, not watch mode
pnpm test --run tests/api/link.spec.ts    # one test file
pnpm test --run -t 'creates new link'     # tests matching a name
```

- ESLint and TypeScript extend generated `.nuxt` files. If they are missing, run `pnpm postinstall` (or `pnpm install`) before diagnosing config errors.
- Authenticated tests need `NUXT_SITE_TOKEN`; local values are loaded from `.env`, with `.env.example` as the template. The template sets `NUXT_PUBLIC_PREVIEW_MODE=true`, which makes edit, delete, and import tests return 403; leave it empty in the `.env` used for tests.
- `.github/workflows/fork-ci.yml` runs lint, typecheck, locale check, build, and tests on every pull request and push to `master`. It only reports; it does not block merges or deploy. Run the same commands locally before pushing.
- `fork-ci` also runs dependency review (pull requests only), a gitleaks secret scan over the full history (`.gitleaks.toml`), and the project Semgrep rules in `.semgrep/rules`. Server code must not call raw `fetch()`; use `fetchPublicHttpUrl` for user-supplied URLs.
- Tests run with `remoteBindings: false` (`vitest.config.ts`), so they need no Cloudflare login or API token.
- On Windows, `pnpm build` fails under cmd or PowerShell because the script sets `NODE_OPTIONS=` inline. Run it from a POSIX shell such as Git Bash: `node scripts/build-sphere.js && NODE_OPTIONS=--max-old-space-size=8192 npx nuxt build`.
- A running `pnpm dev` keeps `.output/public` open (it backs the `ASSETS` binding), so a build fails with `EBUSY` on Windows. Stop the dev server before building.
- `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md` only; on Windows the symlink checks out as a one-line text file and must not be changed.
- The pre-commit hook only runs `eslint --fix` on staged JS/TS/Vue files; it does not replace full-project verification.

## Architecture and data flow

- `app/` is a client-only Nuxt 4 UI (`ssr: false`); `/` and `/dashboard/**` are prerendered, and `/dashboard` redirects to `/dashboard/links`. `server/` is the Nitro backend using the `cloudflare-module` preset outside Cloudflare Pages.
- `shared/` owns schemas, cross-runtime utilities, and shared types. Prefer `#shared/...`; `app/types/index.ts` only re-exports selected shared types for UI use. Never import `app/**` from `server/**`; move cross-runtime code to `shared/**` instead.
- Use `useAPI()` for authenticated internal APIs, mutations, polling, searches, and abortable user flows. Reserve Nuxt `useFetch` for read-only data where AsyncData caching, deduplication, or shared state provides a concrete benefit.
- D1 is the authoritative link store. KV is a write-through read cache and the temporary source for pre-D1 links until D1 records a completed KV-to-D1 migration run. Route link persistence through `server/utils/link-store.ts`; direct KV-only writes can lose authoritative data.
- Link validation has separate create, edit, import, stored, and legacy-KV contracts in `shared/schemas/link.ts`. Do not merge them or remove legacy KV parsing without explicit confirmation that every deployed instance has completed KV-to-D1 migration.
- `server/middleware/1.redirect.ts` intentionally runs before `2.auth.ts`: public short-link resolution happens first, while every `/api/**` request is authenticated by site token or allowed Cloudflare Access identity. A connector token (`sink_mcp_...`, stored hashed in `mcp_tokens`) authenticates a POST to `/api/mcp` only, at the level stored with it; never accept it on another route. Connectors are managed through `/api/connector/{list,create,revoke}`, which only the site token or an Access identity may call; a connector must never be able to create or revoke connectors. Every MCP tool call that reaches a handler is checked against a per-caller daily limit, counted in `mcp_usage`, and logged as `mcp.tool_call`, all in the single wrapper in `server/services/mcp/tools.ts`; log the slug and nothing else from the arguments.
- Cloudflare bindings are declared in `wrangler.jsonc`: `DB`, `KV`, `ANALYTICS`, `AI`, `R2`, `ASSETS`, and the `LINK_PASSWORD_LIMITER` and `API_AUTH_LIMITER` rate limits. Regenerate `worker-configuration.d.ts` with `pnpm gen:types` after changing bindings.
- The realtime dashboard is intentionally pseudo-live: it polls analytics every 10 seconds, then replays the initial and newly discovered access events through a bounded client-side queue at roughly one event per second. Pausing stops polling, queue replay, and WebGL motion; it is not an SSE or WebSocket stream.

## Database and deployment

```bash
pnpm db:generate         # schema: server/database/schema.ts; output: drizzle/
pnpm db:migrate:local    # apply migrations to local Wrangler D1
pnpm db:migrate:remote   # mutates the configured remote D1 database
```

- Commit generated migrations when changing the Drizzle schema; tests read and apply migrations from `drizzle/` automatically.
- Prefer Drizzle ORM for constructing and executing SQL. Use raw D1 SQL only when Drizzle cannot express the operation clearly or an existing migration-specific atomic pattern must be preserved.
- `pnpm deploy:pages` and `pnpm deploy:worker` both run remote D1 migrations before publishing and assume build artifacts already exist. Treat them as production-mutating commands, not verification commands.

## Testing quirks

- Vitest uses `@cloudflare/vitest-plugin`, `wrangler.jsonc`, one Worker, `isolate: false`, and `maxWorkers: 1`. Storage is shared across the run.
- Worker tests execute `.output/server/index.mjs` from `wrangler.jsonc`. Run `pnpm build` after server changes before the final test run, or tests may exercise stale output.
- Use unique slugs and cleanup helpers from `tests/utils.ts`; do not make state-sharing suites concurrent.
- `tests/setup.ts` applies all D1 migrations before tests. Update migrations, not ad hoc test setup, when schema changes.
- A spec that imports server code directly must alias `#shared/...` itself, for example `vi.mock('#shared/utils/link-password', async () => import('../../shared/utils/link-password'))`.
- `runScheduledTasks()` can return before the cron hooks finish. Wait for the effect with `vi.waitFor` instead of asserting right after the call (see `tests/api/link-password-rehash.spec.ts`).

## Generated artifacts

- `pnpm install` regenerates ignored `public/world.json` via `build:map`. It also rewrites the tracked `public/countries.geojson` from the map bundled with `@unovis/ts`, so its content can change when that package updates; restore it with `git restore public/countries.geojson` unless you mean to update the map.
- `pnpm build` regenerates `public/sphere.bin` through its prebuild hook. `build:colo` and `build:testimonials` generate `public/colos.json` and `app/data/testimonials.json`; the testimonial task is network-dependent and randomizes order.
