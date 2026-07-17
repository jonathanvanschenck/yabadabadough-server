# UPDATE_PLAN — Webapp feedback implementation plan

Source: `notes.md` (2026-07-17). Check items off as they land. Stages are ordered so that
infrastructure and bug fixes land before the features that depend on them, but stages 4–7
are largely independent of each other and can be reordered.

**Decisions already made (with Jonathan):**
- Finalized-month date guard: native `min` attribute on date inputs **plus** inline form
  error for out-of-range values (belt and suspenders; no custom picker).
- Statements page: move to a **cards** layout everywhere (stacks vertically, phone-friendly),
  with inline from/to/description for the simple path and modals for advanced workflows.
- Allocations page: replace the month paginator with a **horizontally scrolling month strip**
  (sticky fund column, older months load as you scroll left).
- Browser debugging: **Chrome DevTools MCP** (no puppeteer harness for now).

---

## Stage 0 — Bugs & safety nets (do first)

- [x] **Fix bug (A): fund selector search crash.**
  `SearchableSelector` filters with `displayName.toLowerCase()` (`webapp/src/components/Inputs.jsx:879`),
  but `FundSearchableSelector` passes JSX badges (`<FundTypeBadge>`) as `optionDisplayNames`
  (`webapp/src/components/SpecialInputs.jsx:58-69`). Fix: add a parallel
  `optionSearchTexts` (plain strings) prop to `SearchableSelector` used only for filtering,
  falling back to `optionDisplayNames` entries that are strings, else the key. Update
  `FundSearchableSelector` to pass fund names as search text (keep the JSX for display).
  Audit other callers (`StatementSourceSelector`, `UserSearchableSelector` are string-safe).
- [x] **Add a router ErrorBoundary.**
  The "💿 Hey developer 👋" console message is React Router 7's dev-mode hint: a route
  component threw during render and the router fell back to its ugly default error screen
  because no route defines `errorElement`/`ErrorBoundary`. Add one boundary on the root
  route in `webapp/src/main.jsx` (uses `useRouteError`, shows a friendly "something broke"
  card with the error message + a reload/home link) so future render errors degrade gracefully.
- [x] **Set up Chrome DevTools MCP** so Claude can see console errors, network traffic, and
  drive the app during debugging. Add `chrome-devtools-mcp` to Claude Code's MCP config
  (project `.mcp.json`), document the dev-server + attach workflow in `webapp/CLAUDE.md`.

## Stage 1 — Modal infrastructure (unblocks most UX items)

- [x] **Modal width tiers.** Base `CardModal` card has `max-height` but no width control
  (`webapp/src/components/Modal.module.css`); small modals (SetAllocation, FinalizeMonth)
  stretch awkwardly wide on large screens. Add size variants to `CardModal`
  (e.g. `size="sm" | "md" | "lg"` → `max-width` ~26rem / ~40rem / 60rem, all `width: min(..., 92vw)`),
  keep the existing `wideModalCard` behavior as `lg`, and sweep all 27 modals in
  `SpecialModals.jsx` to declare a sensible size.
  Done: `.sizeSm/.sizeMd/.sizeLg` in `Modal.module.css`; `CardModal` takes `size` (default
  `md`); 6 former `wideModalCard` modals → `lg`, SetAllocation/CopyAllocations/FinalizeMonth
  → `sm`, the rest `md`; `ConfirmationModal` defaults `md` (its ~30rem content fits);
  `wideModalCard` deleted.
  Also (mobile prep, folded into the same CSS edit): `modalContainer` height and
  `cardBaseStyles` max-height now use `dvh` (with `vh` fallback) so a modal's card and submit
  button stay on-screen when the mobile keyboard/URL bar resizes the viewport.
- [x] **Initial focus on open.** No modal currently moves focus (only `.focus()` in the
  codebase is inside `SearchableSelector`). Add an `initialFocusRef` /
  `data-autofocus` mechanism to `CardModal` (focus the first flagged element on mount;
  fall back to the first focusable form control). Flag the sensible first field in each
  data-entry modal (SetAllocation amount, CreateTransactionGroup description, import CSV
  file input, etc.). Keep `useStackedEscapeKey` semantics intact for nested modals.
  Done: `CardModal` focuses `[data-autofocus]` (or the first focusable form control, scoped
  to the form body so the close button is never picked) on open via a post-paint rAF; buttons
  excluded from the fallback so read-only views (ViewTransactionGroup) focus nothing. Flagged
  fields: CreateTransactionGroup description, SetAllocation amount, ImportStatementsCSV file
  input (threaded through `CSVImporter`'s `autoFocusFile`). Nested modals focus via their own
  effect, so a child open never fights the parent.

## Stage 2 — Finalization guardrails & affected-month clarity

- [x] **Recursive unfinalize with confirmation.** Server unfinalize is strictly LIFO
  (`MonthFinalization.unfinalize`), so "recursively unfinalize month M" = unfinalize
  latest → M in order. Add a `recursive` option to the unfinalize flow: either an API
  addition (`DELETE /api/finalizations/...?recursive=true` looping LIFO server-side in one
  transaction — preferred, atomic) or a client-side loop. `UnfinalizeMonthModal`
  (`SpecialModals.jsx:2715`) becomes a confirmation modal explaining side effects
  (eom_cleanup groups removed, monthly-fund balances un-reset, months become editable).
  Done: chose the atomic API path. `MonthFinalization._delete(db, month, { recursive })`
  extracts the raw reversal into `_unfinalize_one` and, when `recursive`, unfinalizes every
  later month newest-first inside the one sqlite transaction before reversing the target;
  `DELETE /api/finalizations/month-finalization/:id?recursive=true` (a `string_to_boolean`
  query param) threads it through, and the delete broadcasts a prefix
  `["month-finalization"]` invalidation on cascade. `UnfinalizeMonthModal` self-fetches the
  finalizations list, cascades when the target isn't the latest, and its confirmation copy
  now spells out the side effects. Transactions page unfinalize button no longer gates on
  `isLatestFinalization`. Tests: model (cascade + latest-is-plain) + API (`?recursive=true`).
- [x] **Affected-months list in both modals.** `FinalizeMonthModal` (recursive finalize
  already exists server-side) and `UnfinalizeMonthModal` list the concrete months the
  action will touch (e.g. "This will finalize: 2026-03, 2026-04, 2026-05"), computed from
  the finalizations query the pages already have.
  Done: `monthsBetween(fromSom, toSom)` helper + month chips. FinalizeMonthModal derives the
  first unfinalized month (latest finalization's sonm, else earliest tracked-fund start),
  lists every month from there to the picked month, and requires recursive (inline warning +
  disabled submit) when more than one. UnfinalizeMonthModal lists the target + every later
  finalized month (newest-first).
- [x] **Date inputs respect the finalization boundary.** Per decision: on
  CreateTransactionGroup / EditTransactionGroup date fields (and any other
  month-sensitive date input), set the input's `min` to the first day of the first
  unfinalized month (from the finalizations list query) and add an inline form error
  ("March 2026 is finalized — pick a date on or after 2026-04-01") when the entered date
  is out of range; disable submit while invalid.
  Done: local `useFinalizationDateFloor()` hook (min = latest finalization's sonm; inline
  validity string) wired into both CreateTransactionGroupModal and EditTransactionGroupModal
  date fields — `min` disables earlier days in the picker and the validity message disables
  submit. The themed `DateInput` already supported `min`/`validityMessage`.
- [x] **Fund editing: disable known-impossible edits.** In the Fund edit surface, when
  finalizations exist for the fund, disable the history-locked fields
  (`start_date`, `start_balance`, `tracked`, `monthly`, `pool`, guarded `parent_id` — the
  `assert_unfinalized` set) with a tooltip explaining why, instead of letting the API 400.
  Done: EditFundModal queries the fund's finalizations (`historyLocked`) and freezes
  start_date/start_balance/tracked/monthly/pool with a lock tooltip + a visible warning
  banner. `parent_id` locks only when the fund is or contains a monthly fund (new
  `fundIdsContainingMonthly` domain helper mirroring the server's narrower `parent_id`
  guard).

## Stage 3 — Transaction group page (the big feature)

- [x] **New route + page: `/transaction-group/:id`.** Full detail view of a group: scalar
  fields (description, note, date), the transaction lines table (amount, source → target,
  description, note), linked bank-statement items, finalized-month status. Reuse query
  hooks from `Queries.jsx`; extract shareable pieces from `ViewTransactionGroupModal`
  (`SpecialModals.jsx:2263`).
  Done: new `pages/transaction_group/TransactionGroup.jsx` (+ route in `main.jsx`). Read
  view of details / lines table / reconciled statements built from
  `useGetTransactionGroupQuery` + `useGetFundsQuery`; `isManaged`
  (allocation/eom_cleanup) and `isFinalized` (group date inside a month from
  `useGetMonthFinalizationsQuery`) drive an `Allocation`/`EOM cleanup` header badge, the
  `FinalizedBadge`, and a read-only banner. `ViewTransactionGroupModal` is now superseded
  by the page (left exported but unused).
- [x] **Editing when month is unfinalized.** Wire the three PATCH surfaces into the page:
  scalar edit (`PATCH /transaction-group/:id`), atomic line editor add/update/remove
  (`PATCH /transaction-group/:id/transactions` — this is the split / re-route workflow),
  and single-line edit (`PATCH /transaction/:id`). Allocation/eom_cleanup groups and
  finalized months render read-only with an explanatory banner (mirror the API-layer 409
  guards client-side).
  Done: the page reuses the existing `EditTransactionGroupModal` (Edit details) /
  `EditTransactionGroupTransactionsModal` (Edit transactions) / `EditTransactionModal`
  (per-line edit) — all guard logic already lives in them. A single `canEdit = isEditor &&
  !isManaged && !isFinalized` gate hides every edit affordance and disables Delete (with a
  tooltip reason) for managed groups, finalized months, and non-editors.
- [x] **URL fragments per transaction.** Each line row gets `id="transaction-<id>"`; the
  page scrolls-to and highlights the fragment target on load (same pattern as the Fund
  page's fragment-synced cards).
  Done: `useUrlFragment()` → parse `transaction-<id>`, post-paint rAF/timeout scroll into
  view, and a 2.2s `lineHighlightFlash` background animation. A `handledFragmentRef` keeps
  socket-driven refetches from re-scrolling.
- [x] **Repoint Transactions-page NavLinks.** `Transactions.jsx:153` group link →
  `/transaction-group/:id`; `Transactions.jsx:190` transaction link →
  `/transaction-group/:groupId#transaction-:id`. (Both currently 404 — the routes never
  existed.) Also make the Statements page "view group" action link/open through to the page.
  Done: group link already pointed at `/transaction-group/:id`; transaction line link now
  `/transaction-group/${group.id}#transaction-${t.id}`. Statements `handleAction('viewGroup')`
  now `navigate`s to the page instead of opening `ViewTransactionGroupModal` (import + render
  removed).
- [x] **Delete workflow.** Delete button (with `ConfirmationModal`) on the group page;
  hidden-or-disabled-with-tooltip for allocation/eom_cleanup groups and finalized months.
  If a group has linked statement items, the confirmation must surface the release-to-pending
  / re-import double-count hazard. Additionally add a small per-row delete icon (same
  confirmation) on the Transactions-page group rows, disabled with tooltip for special groups.
  Done: page Delete reuses `DeleteTransactionGroupModal` (which already carries the
  statement-item double-count warning), disabled with a reason tooltip when `!canEdit`, and
  navigates back to `/transactions` on success. Transactions-page group rows get a subtle
  `GhostButton` trash (new `disabled` support + `.ghostDelete` danger hover) wired to the
  same modal, disabled with a tooltip for allocation/eom_cleanup groups, finalized months,
  and non-editors.

## Stage 4 — Transactions page polish

- [ ] **Single-transaction description defaulting.** In CreateTransactionGroupModal (and the
  statements easy path in Stage 7): when a group has exactly one line, the transaction
  description mirrors the group description unless the user explicitly diverges (leave
  line description blank → inherit; UI shows placeholder "same as group").
  Decide whether inheritance happens at the API call site (send the group description) or
  display time (render group description when line description is null) — prefer call site,
  no schema change.
- [ ] **Fix sticky-header squish of the Totals row.** The sticky top rows
  (`theadHeightRem` computation at `Transactions.jsx:342`, `totalsRow` stick offset)
  squeeze the "<Month> totals" row; fix the offset math / row heights so the totals row
  keeps full height while stuck.
- [ ] **Cell selection + sum.** Click / shift-click / drag / shift-drag to select amount
  cells in the grid, with a floating (or status-bar) readout of count + sum. Pointer-event
  based, page-local state; selection cleared on Escape/outside click. This is the largest
  polish item — implement after squish fix since both touch the grid.
- [ ] **"Total" column untracked-fund breakdown.** The third sticky column shows net flow
  from untracked funds (`outsideTotalOf`, `transactions/utils.jsx:93`). Add an info
  affordance (hover tooltip + click-to-pin popover for touch) listing which untracked
  fund(s) contribute and by how much.

## Stage 5 — Fund iconography

*(Before Stage 6, which builds on the new icons.)*

- [ ] **Re-imagine tracked/pool/monthly icons.** Current mapping in
  `SpecialIcons.jsx:51` (pool→water, monthly→calendar-days, tracked→chart-line,
  untracked→folder) doesn't communicate the concepts. Propose 2–3 candidate icon sets
  (FontAwesome-only) with a rendered comparison for Jonathan to pick from; the concepts to
  convey: *tracked* = has a real balance; *pool* = source/sink reservoir that descendants
  draw from; *monthly* = resets each month. Update `FundTypeIcon`, `FundTypeBadge`,
  legend/tooltips everywhere they appear.
- [ ] **Pool indicator on allocations page.** Parent funds that are pools get the pool
  symbol (and perhaps a subtle row treatment) in the allocations grid's fund column, so
  it's obvious where allocation money is drawn from.

## Stage 6 — Allocations page overhaul

- [ ] **Cell hover/action redesign** (per the detailed spec in notes): fixed-position icon
  slots so nothing moves on hover — edit/add icon always visible (muted) in a reserved
  slot; delete icon in its own reserved slot to the *right* of edit/add, rendered only on
  cell hover (muted → warning color on direct hover); hovered cell gets a border/box-shadow
  so icon↔cell grouping is unambiguous. Kill the current float-left delete / float-right
  add layout (`Allocations.jsx:49-82`).
- [ ] **Horizontal continuous month scroll.** Replace `MonthPaginator` with a horizontally
  scrollable month strip: sticky fund-name column (with pool indicators from Stage 5),
  months as columns extending left into the past, loading older months on scroll
  (windowed fetch via the existing allocations/finalizations queries). Preserve `?month=`
  deep-linking as initial scroll position. Keep the per-month header controls
  (add, copy-from-previous, finalized lock).

## Stage 7 — Statements page cards redesign

- [ ] **Cards layout.** Replace the `SearchableTable` on `Statements.jsx` with vertically
  stacked cards (state badge, date, source, amount, note), keeping the server-side
  search/sort/pagination controls above the list. Design for narrow screens first.
- [ ] **Inline easy path on pending cards.** From/to fund selectors + description input +
  confirm button directly on the card for the common single-transaction reconcile —
  no modal. Uses the Stage 4 description-defaulting rule (one description field fills both
  group and line). Amount/date come from the statement item.
- [ ] **Advanced workflows stay as buttons → modals.** Split-group reconcile
  (`ReconcileStatementsModal`), link-to-existing (`LinkStatementModal`), edit, delete,
  ignore-toggle — as secondary actions on the card.

---

## Explicitly out of scope (from notes review)

- Puppeteer harness in-repo (chose MCP-only for debugging).
- Custom date-picker component (chose native `min` + inline error).
- Point-in-time hierarchy snapshotting (already documented as future direction in CLAUDE.md).
