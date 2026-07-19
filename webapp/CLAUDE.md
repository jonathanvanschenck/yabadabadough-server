# Webapp Conventions

React webapp for the finance server, served by the backend from `dist/`. Structure and
conventions were carried over from a prior project ("hyperspace").

## Stack

React 19 + plain JSX (no TypeScript; JSDoc typedefs for complex signatures, especially
mutation hooks), Vite 7, react-router 7 (`createBrowserRouter`), TanStack Query v5,
socket.io-client, dayjs, FontAwesome (icons registered once in `src/Icons.jsx`, referenced
by string name like `icon="fa-trash"`). ESLint flat config: unused vars are errors except
`_`-prefixed; context files start with
`/* eslint-disable react-refresh/only-export-components */`.

## Build & versioning

- `npm run build:dev:watch` is the dev loop: the backend serves `dist/`, so the API is
  same-origin at `/api/...` — no Vite proxy, no `import.meta.env` (the frontend learns
  everything from the API).
- `__APP_VERSION__` is injected via Vite `define` from the PARENT server `package.json`
  (one shared version). `<VersionGate>` polls `GET /api/utils/versions` and replaces the
  app with a full-screen reload prompt on mismatch.
- Static files in `public/` use dashes, not underscores, in filenames.

## Browser debugging (Chrome DevTools MCP)

Claude drives a real Chrome via the `chrome-devtools` MCP server (declared in the project
`.mcp.json` at the server root) to inspect console errors, network traffic, and the live
DOM — no puppeteer harness in-repo. Dev-server + attach workflow:

1. From `webapp/`: `npm run build:dev:watch` (unminified + sourcemaps, rebuilds `dist/` on
   save).
2. From the server root: `node index.js` — the backend serves `dist/` and the API on the
   same origin. Default URL is `http://localhost:1234` (`YDD_SERVER_PORT`, default `1234`).
   For a login-free debugging session run with `YDD_DISABLE_AUTH=1`.
3. Point the Chrome DevTools MCP tools at that URL to navigate, read console/network, and
   snapshot the DOM. `build:dev:watch` keeps `dist/` fresh, so just reload the page after a
   code change (the `<VersionGate>` also prompts a reload on a version bump).

## Naming & styling

- camelCase in the webapp; the API is snake_case — convert at the boundary (hook param
  `fundId` → search param `fund_id`). PascalCase component files; snake_case page
  directories; kebab-case URL paths.
- CSS modules co-located with every component (`Foo.jsx` + `Foo.module.css`). Inline
  styles only for state-driven one-offs. Prefer `rem` over `px`. Theme lives in
  `public/styles.css` as `:root` custom properties — always `var(--...)`, never
  hardcoded colors. Fonts are the "Warm Stone" trio loaded from Google Fonts in
  `index.html`: Newsreader (`--font-display`, headlines), Source Serif 4
  (`--font-body`, UI/body), JetBrains Mono (`--font-mono`, numbers/dates via
  `.tabular-nums`). Semantic status/utility colors are the `--u-<role>[-variant]`
  ramps (success/warn/danger/info); the legacy `--bg-ok-color`/`--bg-danger-color`/
  `--font-*-color` names are aliases onto them. Neutral overlays go through
  `--scrim-color`/`--shadow-color`/`--glow-color`.
- Fund colors are the `--fund-<slug>` custom properties in `public/styles.css` (10
  OKLCH hues, each with four tone-matched variants — `dot`/`text`/`main`/`muted`
  for the dark surfaces). Funds persist the SLUG, not the hex: the slug list is the
  server's `lib/fund_colors.mjs` registry (API-validated + db CHECK), re-exported
  here via `src/hooks/fundColors.js` along with `fundColorVar(slug, variant)`.
  There is NO auto-assignment — a fund with no color stores null and renders with
  the neutral `--fund-default*` fallback. Render a named fund via `<FundLabel>`
  (dot + `-text`-tinted name) or `<FundTypeBadge ... color={slug}>`.

## Routing (`src/main.jsx`)

All routes in one `createBrowserRouter` tree: `AppLayout` at `/`, one `src/pages/`
directory per route, `pages/404/` as the `*` catch-all. Plural list page (`/funds`),
singular detail page (`/fund/:id`) — mirroring the server's API path convention. Deep
links to page sections use URL fragments via `useUrlFragment()`
(`src/hooks/URLFragment.jsx`): pages auto-expand and scroll to the matching collapsible
card; section headers render an `AnchorLink`.

## Contexts (`src/contexts/`)

Provider stack in `AppLayout`, outermost first: `LogContextProvider` →
`QueryClientProvider` (single module-level client) → `AuthContextProvider` →
`SocketIOContextProvider` → `VersionGate` → domain contexts → app chrome + `<Outlet/>`.

- One file per context, exporting the `XxxContextProvider` plus `useXxx()` hooks;
  consumers never call `useContext` directly, and every hook throws a descriptive error
  outside its provider.
- Providers needing setup (auth, socket) gate children behind `LoadingPlaceholder` with a
  300ms minimum display (anti-flicker).
- Split contexts by change-rate; persist user choices to `localStorage` in the provider.
- `useLogger(namespace)` (LogContext) instead of bare `console.*` in components.
- **AuthContext** owns all auth and the fetch wrappers everyone uses: cookie-based JWT,
  `POST /api/auth/authenticate` on mount, renders `LoginModal` itself. Roles
  `reader`/`editor`/`adminable`/`admin`; `adminable` users toggle sudo mode, sent
  per-request as `x-sudo-mode`. Refresh is single-flight + proactive timer +
  refresh-on-focus. Fetch hooks: `useAuthedFetch()` (401 → refresh → retry once),
  `useAuthedFetchJSON()` (throws `APIError(status)` with `.details`),
  `useAuthedFetchAllJSON()` (auto-paginates via `limit`/`offset` + `X-Total-Count`).
  The client's own user id comes from the login/authenticate response — there are no
  `/me` routes; self-service uses `/api/users/user/:user_id/...`.
- **SocketIOContext** (inside auth) applies server-pushed `clean_queries` actions to the
  queryClient. **Cache invalidation is server-driven through this channel** — mutation
  hooks rarely invalidate manually.

## Data layer: `src/hooks/Queries.jsx`

ALL server communication lives here — pages/components never call
`fetch`/`useQuery`/`useMutation` directly.

- **Query keys come exclusively from `src/hooks/queryKeys.js`** — the shim re-exporting
  the server's shared registry (`../collections/lib/query_keys.mjs`: `QK`, `invalidate`,
  `remove`, `money_moved`). Never inline key literals: the server broadcasts
  invalidations against these exact keys, and inlined keys silently never invalidate.
  Single-entity ids in keys are STRINGIFIED (the registry handles this).
- Query hooks: `useGet<Entity>Query(id, { enabled, ...options })`,
  `useGet<Entities>Query(params = {}, options = {})`; `options` spreads into `useQuery`
  last so callers can override. Ids normalize via `standardizeIdStr()` and compose
  `enabled: enabled && !!idStr`. `batchSize` is excluded from queryKeys (changes *how*,
  not *what* — comment this). Effectively-static data uses `staleTime: Infinity` and
  relies on pushed invalidation.
- Mutation hooks: `use<Verb><Entity>Mutation` (Post/Patch/Put/Delete), no arguments.
  `mutate(mutateData)` where `mutateData.formData` holds the snake_case API payload;
  other keys pass through to caller callbacks. `mutationFn` checks `useAuthRoles()`
  first and throws a local `APIError(403)` if the user lacks `editor`. Caller
  `onSuccess`/`onError` run after internal handling. Each mutation gets a JSDoc
  `@typedef` for its `formData` and a stale-closure warning comment.

## Components (`src/components/`)

Tinted callout blocks are `<Banner variant="warn|info|danger|success" icon dense>` — the one
box for "this is read-only", "this month isn't finalized", modal hazard notes. Callers own
their own spacing via `className` (the box carries no margin).

Balances that an unfinalized earlier month could still move are marked with
`<ProvisionalValue>` (a dotted warn underline + tooltip; chosen over a glyph, which would
break `tabular-nums` alignment, and over recoloring, which fights the fund colors) and
explained once per view by `<ProvisionalBanner>` (collapsed to one line with a "See more"
toggle — it annotates dense data, so it must not out-shout it; its `som` is the month to NAME,
chosen by the caller, since the month that bears on the view is not always the earliest
unfinalized one). Never decide provisional-ness locally: read
the `provisional` flag off the balance response, or use `useProvisionalFrontier()` with the
shared predicates in `src/hooks/provisional.js` (the server's `lib/provisional.mjs`, re-exported
like `queryKeys.js`/`fundColors.js`). See the server CLAUDE.md for the rule and its
deliberate off-by-one.

**Always check `src/components/` before writing new UI** — buttons, links, modals,
menus, badges, tables, inputs, spinners, cards, and toasts exist and must be reused. New
UI goes here as a general reusable component, not a page-local one-off. Two tiers:

1. Generic/presentational (`Inputs.jsx`, `Buttons.jsx`, `Card.jsx`, `Modal.jsx`,
   `SearchableTable.jsx`, ...): props-driven, no queries, no domain knowledge; related
   components grouped per file with named exports.
2. Domain-aware "Special" components (`SpecialInputs.jsx`, `SpecialModals.jsx`,
   `SpecialIcons.jsx`): compose the generic tier with `Queries.jsx` hooks (e.g. an
   entity-aware selector wrapping `LabeledSearchableSelector` + a list query).

Prop idioms: inputs take `label`, `value`, `onChange(value)` (value, not event),
`isFrozen`, `isChanged`, `allowNull`/`nullPlaceholder`; `IconButton` takes `text`,
`icon`, `onClick`, `disabled`, `isPending`/`pendingText`; components pass through
`className`/`style` and `forwardRef` when pages scroll to them. Destructive actions
always go through `ConfirmationModal` (`onConfirm` returns a promise via `mutateAsync`).

## Pages (`src/pages/`)

One directory per route: `pages/<snake_case>/<PascalCase>.jsx` + `.module.css`, default
export; page-local helpers in a sibling `utils.jsx`.

- **List pages**: fetch via a list query hook, filter/sort CLIENT-side (`useMemo` over
  raw data with `searchTerm`/`sortKey`/`direction` state), render `SearchableTable` with
  a `columns` config; row-cell links use `NavLink` with `stopPropagation`.
- **Detail pages**: early-return `isPending` → `Spinner`, `isError` → message
  (`error.message` + `error.details?.message`) with a `BackLink`. Content is `Card`s,
  one per concern, each with an `anchor` fragment + collapsible sections synced to the
  URL fragment. Edit-in-place: `isEditing` state, parallel `formData`/`originalData`
  initialized from the fetched entity, `getChangedFields()` diff, Save disabled unless
  dirty, PATCH sends only changed fields, errors in `CardErrorSection`, Cancel restores
  `originalData`.

## Other hooks (`src/hooks/`)

Reusable browser/UI behaviors get their own file (`useCopyToClipboard`,
`useUrlFragment`, `useStackedEscapeKey` — a capture-phase Escape stack so nested
modals dismiss top-most-first). Server data access never lives here — only in
`Queries.jsx`.
