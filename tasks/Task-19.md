# Task-19 — Fleet view wiring + stub

**Wave:** E1 (parallel with 18) · **Size:** S · **Depends on:** — · **Blocks:** 20

## Goal

Register a new `fleet` center view as the first tab and the default view. A stub component holds its
place until Task-20 lands.

## Read first

`docs/fleet-dashboard-plan.md` §4–5, then these files: `src/client/state/store.ts` (`ViewId`, default `ui.view`,
`setView`, the URL restore around line 332), `src/client/state/url.ts`, `src/client/shell/ViewTabs.tsx`,
`src/client/shell/CenterView.tsx`, `src/client/hooks/useGlobalHotkeys.ts`,
`src/client/palette/CommandPalette.tsx`, and the existing tests for those files.

## Ownership (create/modify only these)

- `src/client/state/store.ts` and `src/client/state/url.ts`
- `src/client/shell/ViewTabs.tsx` and `src/client/shell/CenterView.tsx`
- `src/client/hooks/useGlobalHotkeys.ts` and `src/client/palette/CommandPalette.tsx`
- The co-located tests for those files, `test/e2e/console.spec.ts` (only to fix assumptions about the default view or tab count), and `README.md` / `Plan.md` §7.3 (one short Fleet paragraph)
- `src/client/views/fleet/FleetView.tsx` (new **stub**): `export function FleetView()` that renders
  `<div data-testid="fleet-view">Fleet</div>`

## Requirements

1. Make `ViewId` include `'fleet'`. `VIEW_ORDER` becomes `['fleet','dag','timeline','stream','changes','overview']`,
   and the url.ts `VIEWS` list is updated to match.
2. The default `ui.view` is `'fleet'`. The URL `v=fleet` round-trips.
3. Add the tab with label "Fleet" and the lucide `Network` icon.
4. Register a lazy import in `CenterView`.
5. Hotkeys and palette: any numeric or view-list mapping must include Fleet first. Keep the existing
   behavior for the other views; if the number keys shift, update the tests and shortcuts help to match.
6. **Exception to the default:** when the URL carries `s=` or `r=` without `v=`, the initial view stays `dag`, so deep
   links keep working. Check how the store currently restores the view and keep that behavior.

## Verify

```bash
npm run typecheck && npx vitest run src/client
```

## Report

Summary, files, commands and results, deviations. List any e2e assertions you changed.
