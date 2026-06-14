# DESIGN.md - OutreachOS design system

Register: **product** (design serves the task). Identity: **Linear/Notion register**
- cool graphite + near-white surfaces, Inter throughout, sharp rectangles,
hairline borders, near-invisible elevation. Forest green is retained as a
*sparing* accent only (one identity moment per screen at most). Light theme.

All tokens live in `src/index.css` `:root`. The "REHAUL LAYER v2" block at the
end of that file is the authoritative component layer (appended last so it wins
on equal specificity).

## The one rule
**Never hardcode a color.** Every color is a token. Hex/rgb literals in component
CSS are how this system drifted before. If a value you need doesn't exist as a
token, add it to `:root`, don't inline it.

## Color (OKLCH)
Cool gray neutrals, faintly tinted toward 250 (a hair of blue). Graphite ink.
Forest green is the only chromatic accent, reserved for the "go" action and
selection. Status colors are muted so they coexist with the cool ground without
screaming.

| Role | Tokens |
|---|---|
| Surfaces | `--paper`/`--bg`, `--bg-elev`, `--bg-soft`, `--surface`, `--surface-2`, `--surface-sunk` |
| Borders | `--border` (hairline), `--border-soft`, `--border-strong` |
| Ink | `--fg` (graphite), `--fg-muted`, `--fg-subtle`, `--fg-faint` |
| Brand (sparing) | `--accent`, `--accent-hover`, `--accent-press`, `--accent-soft`, `--accent-line`, `--accent-fg` |
| Primary (general buttons) | `--primary` = `--fg` (graphite ink), `--primary-hover`, `--primary-foreground` |
| Success | `--success`, `--success-soft`, `--success-line` |
| Warn | `--warn`, `--warn-soft`, `--warn-line` (ochre) |
| Danger | `--danger`, `--danger-soft`, `--danger-line` (brick) |
| Info | `--info`, `--info-soft`, `--info-line` (muted slate, NOT alert-blue) |

**Color strategy: Restrained.** Cool neutrals + graphite ink + green accent.
The green accent appears on `.btn-go` / `.btn-primary.is-go`, `.topbar-new`,
links, focus rings, and `--mission-progress-bar`. Nothing else. No green hero
washes, no `--accent-soft` backgrounds on whole cards.

## Typography
- `--font-body: Inter` - **everything** in product UI. Headings, labels, body.
- `--font-display: Fraunces` - *only* on Landing hero + the marketing-side
  long-form headings on the auth shell. Forbidden in app UI.
- `--font-mono` for IDs/data/emails.
- Fixed rem scale anchored at **14px base** (`--text-base: 0.875rem`), ~1.2 ratio.
  Product UI is denser than before.
- Body prose caps at 65–75ch.

## Spacing, radii, elevation, motion
- Space: `--space-1 … --space-10` (4px base).
- Radii: **tight**. `--radius-sm` 4, `--radius` 6, `--radius-lg` 10.
- Elevation: hairline borders do the work. `--shadow-sm` is a single 1px line;
  `--shadow` is barely there; `--shadow-lg` reserved for floating menus.
- Motion: 90 / 140 / 200ms. Linear-instant. State changes only. No bounces.
- Focus: 2px ring (`--ring`), tighter than before. Don't remove it.

## Components (the unified vocabulary)
- **Buttons**:
  - `.btn-primary` = graphite-ink fill, general "do it". Default.
  - `.btn-primary.is-go` / `.btn-go` = forest green. Reserved for Send / Run /
    Connect Gmail. **One per screen, ideally.**
  - `.btn-secondary` = outlined on `--bg-elev`.
  - `.btn-ghost` = chromeless.
  - `.btn-lg` / `.tiny` for sizing.
  - Topbar uses `.topbar-new` (the one place the green button lives by default).
- **Form controls**: bare `input`/`textarea`/`select` are styled globally
  (bg-elev, `--border-strong`, 4px radius, focus ring). Don't re-skin per screen.
  Labels are uppercase 11px.
- **Status labels**: `.pill` / `.badge` / `.status-pill` share one base (flat,
  4px radius, no border). Add tone via `.is-success | .is-warn | .is-danger |
  .is-info | .is-accent`. Common status names (`.status-sent`, `.status-replied`,
  `.status-bounced`, etc) auto-tone.
- **Surfaces**: `--bg-elev` + `--border` + `--radius`. No shadows by default.
  No nested cards. Many lists are just rows-in-a-bordered-list, not cards.
- **Banners**: `.error-banner` / `.run-banner.warn` / `.run-banner.error` use
  the status-soft + status-line + status-fg triad. `.link-button` for inline
  actions.
- **Loading**: skeletons (`.skeleton-*`), never a centered spinner.
- **Dashboard pattern**: `.focus-band` (renders only when there's something to
  do, no big serif numbers) → `.mission-row-list` main column → `.dash-rail`
  (activity + `.stat-strip` for demoted secondary numbers). No KPI-card grid,
  no green hero.
- **App shell**: 220px sticky `.app-sidebar`, gray-fill active nav (not green
  wash), 48px sticky `.app-topbar` with hairline border (no blur, no
  translucency). `.topbar-new` is the green identity moment.
- **Mission list**: `.mission-cards` is a *bordered list of rows*, not a chunky
  card grid. `.mission-row` flattens hover to background-only (no transform).

## Identity moments (where green earns its rent)
- `.topbar-new` (the New mission CTA)
- `.btn-go` / `.btn-primary.is-go` (Send / Run / Connect Gmail)
- Focus ring (2px green halo on inputs / buttons)
- Selection (`::selection` background)
- `.mission-progress-bar` (the only filled green strip)
- Landing hero (Fraunces + green gradient - brand-register exception)

Outside these, the design is monochrome-graphite. If you're tempted to add green
elsewhere, you're degrading the accent. Use weight or border instead.

## Bans (enforced)
- No hardcoded hex/rgb in component CSS (see "The one rule"). The only
  exception: macOS window-control dots in the Landing mockup.
- No em dashes in UX copy. Use commas, colons, semicolons, periods, parentheses.
- No gradient text (`background-clip: text`). Solid color; emphasis via weight.
- No side-stripe borders (colored `border-left/right` > 1px) as accents.
- **No glassmorphism.** The previous topbar blur is removed; hairline borders
  carry separation instead.
- No hero-metric template, no identical card grids, no modal as first thought.
- No Fraunces in product UI. Inter only.
- No green-soft backgrounds on cards/heroes. The accent lives on actions, not
  surfaces.
