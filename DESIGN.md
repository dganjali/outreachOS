# DESIGN.md — OutreachOS design system

Register: **product** (design serves the task). Identity: **editorial warm-paper
+ deep forest green**, Fraunces display serif + Inter UI, light theme. All tokens
live in `src/index.css` `:root`. The "REHAUL LAYER" comment block near the end of
that file is the authoritative component layer (appended last so it wins on equal
specificity).

## The one rule
**Never hardcode a color.** Every color is a token. Hex/rgb literals in component
CSS are how this system drifted into three clashing eras. If a value you need
doesn't exist as a token, add it to `:root`, don't inline it.

## Color (OKLCH)
Warm paper neutrals, tinted toward the green hue. Forest green is the only
chromatic accent and is reserved for primary actions, selection, and identity
moments. Status colors live in the same warm world (no cool Tailwind blues).

| Role | Tokens |
|---|---|
| Surfaces | `--paper`/`--bg`, `--bg-elev`, `--surface`, `--surface-2`, `--surface-sunk` |
| Borders | `--border`, `--border-soft`, `--border-strong` |
| Ink | `--fg`, `--fg-muted`, `--fg-subtle`, `--fg-faint` |
| Brand | `--accent`, `--accent-hover`, `--accent-press`, `--accent-2`, `--accent-soft`, `--accent-line`, `--accent-fg` |
| Success | `--success`, `--success-soft`, `--success-line` (forest/olive) |
| Warn | `--warn`, `--warn-soft`, `--warn-line` (ochre) |
| Danger | `--danger`, `--danger-soft`, `--danger-line` (brick) |
| Info | `--info`, `--info-soft`, `--info-line` (muted slate, NOT alert-blue) |

Color strategy: **Restrained** is the floor (tinted neutrals + green accent).
**Committed** green is earned only on identity surfaces (onboarding welcome, the
Mission Run hero, the sign-in panel, the first-run launchpad).

## Typography
- `--font-display: Fraunces` — h1/h2/h3 and large display numbers only. Optical
  sizing on h1.
- `--font-body: Inter` — all UI, labels, body, h4. `--font-mono` for IDs/data.
- Fixed rem scale, ~1.2 ratio: `--text-xs … --text-4xl`. Do not use fluid/clamp
  sizing in product UI.
- Body prose caps at 65–75ch.

## Spacing, radii, elevation, motion
- Space: `--space-1 … --space-10` (4px base). Vary spacing for rhythm.
- Radii: `--radius-sm` 6, `--radius` 10, `--radius-lg` 16, `--radius-full`.
- Elevation: `--shadow-xs/sm/(base)/lg`, green-black tinted. `--shadow-glow` for
  identity moments only.
- Motion: 120–240ms (`--dur-fast`/`--dur`/`--dur-slow`), `--ease-out` (quint).
  State changes only, no page-load choreography. Never animate layout props.
- Focus: `--ring` is applied globally via `:focus-visible`. Don't remove it.

## Components (the unified vocabulary)
- **Buttons**: `.btn-primary` (green), `.btn-secondary` (outline), `.btn-ghost`,
  size `.btn-lg`. Topbar uses `.topbar-new`. One shape, one set of states.
- **Form controls**: bare `input`/`textarea`/`select` are styled globally
  (bg-elev, `--border-strong`, focus ring). Don't re-skin per screen.
- **Status labels**: `.pill` / `.badge` / `.status-pill` share one base; add a
  tone modifier `.is-success | .is-warn | .is-danger | .is-info | .is-accent`.
  `.mode-pill` for mission modes.
- **Surfaces**: `--bg-elev` + `--border` + `--radius` + `--shadow-sm`. No nested
  cards. Don't wrap everything in a card; many lists are just rows.
- **Banners**: `.error-banner` / `.run-banner.warn` / `.run-banner.error` use the
  status-soft + status-line + status-fg triad. `.link-button` for inline actions.
- **Loading**: skeletons (`.skeleton-*`), never a centered spinner.
- **Dashboard pattern**: `.focus-band` (only renders when there's something to
  do) → `.mission-row-list` main column → `.dash-rail` (activity + `.stat-strip`
  for demoted secondary numbers). No KPI-card grid.
- **App shell**: sticky `.app-sidebar` (active nav = `--accent-soft`), sticky
  blurred `.app-topbar` with New mission + avatar menu.

## Bans (enforced)
- No hardcoded hex/rgb in component CSS (see "The one rule").
- No em dashes in UX copy. Use commas, colons, semicolons, periods, parentheses.
- No gradient text (`background-clip: text`). Solid color; emphasis via weight.
- No side-stripe borders (colored `border-left/right` > 1px) as accents.
- No glassmorphism by default. The topbar blur is the one intentional exception.
- No hero-metric template, no identical card grids, no modal as first thought.
