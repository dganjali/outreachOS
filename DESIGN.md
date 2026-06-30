# DESIGN.md — OutreachOS design system

Register: **product** (design serves the task). Identity: **Linear/Notion register,
dark**. Matte near-black ground with a faint cool tint, near-white ink, hairline
borders, near-invisible elevation, sharp rectangles. **Forest green is the single
chromatic accent, used sparingly** — at most one "go" action per screen plus the
standing topbar CTA. The app is **forced dark** (`<html class="dark">`); there is
no light theme in the product.

## Source of truth & the two-layer token system (read this first)

Styles come from **two stylesheets**, imported in this order by `src/main.tsx`:

1. `src/index.css` — the legacy 8.4k-line layer (originally a light system, now
   carrying a dark-override block). Defines the **legacy tokens**: `--fg`,
   `--fg-muted`, `--bg`, `--bg-elev`, `--surface-2`, `--accent-hover`,
   `--success` / `--success-line`, `--info` / `--info-line`, `--border-strong`,
   `--font-body`, `--font-display`, `--radius-*`, `--space-*`, `--dur*`, etc.
   These hold real color/length values and are used **directly**: `var(--fg)`.
2. `src/styles/globals.css` — the shadcn/Tailwind layer, loaded **last** so it
   wins on token-name collisions. Defines the **shadcn tokens** as bare **HSL
   triplets** on `:root, .dark`: `--background`, `--foreground`, `--primary`,
   `--secondary`, `--accent`, `--border`, `--input`, `--ring`, `--card`, …

### The collision rule (do not get this wrong)
Where a name exists in **both** files (`--primary`, `--accent`, `--border`,
`--secondary`, `--ring`, `--background`, `--foreground`), **globals.css wins**, so
the value is an **HSL triplet** like `152 38% 42%`. A triplet is **not a color**:

- ✅ `hsl(var(--primary))` → green. `hsl(var(--border))` → hairline.
- ❌ `var(--primary)` as a color → **invalid / broken** (it's `152 38% 42%`).

So in component CSS: use `hsl(var(--token))` for any shadcn-named token, and bare
`var(--token)` only for legacy-only tokens (`--fg`, `--bg-elev`, `--success-line`,
`--font-body`, spacing, radii, durations). Tailwind already wraps these via
`hsl(var(--x))` in `tailwind.config.cjs`.

> Eventually the legacy `index.css` should be retired and globals.css become the
> sole layer. Until then, **never hardcode a hex/rgb in component CSS** — add a
> token. (Only exception: the macOS window-control dots in the Landing mockup.)

## Color

Cool near-black surfaces, near-white ink, forest green as the only chromatic
accent (the "go" action + selection + focus ring). Status colors are muted so
they coexist with the ground without screaming.

| Role | Tokens |
|---|---|
| Surfaces | `--background`, `--card`, `--bg-elev`, `--surface-2` |
| Borders | `--border` (hairline), `--border-strong` |
| Ink | `--foreground`/`--fg`, `--fg-muted`, `--fg-subtle`, `--muted-foreground` |
| Brand "go" (sparing) | `--primary` (= green) via `hsl(var(--primary))`; `.btn-go` / `--accent-hover` |
| Neutral fill | `--secondary`, `--accent` (NOTE: shadcn `--accent` is **neutral grey**, not the brand green) |
| Success | `--success`, `--success-line` (muted) |
| Warn | `--warning` |
| Danger | `--destructive` |
| Info | `--info`, `--info-line` (muted slate) |

**Green is reserved.** It appears on: the topbar **New mission** CTA, the single
**go** action per screen (Send / Run pipeline / Connect Gmail), the focus ring,
`::selection`, and the mission progress bar. Nothing else gets a green *fill*.
Signal pills (funding/launch/press…) keep their own color coding — that is data,
not accent.

## The one-green-per-screen rule

The topbar **New mission** button (shadcn `Button` default = `bg-primary`) is the
screen's standing green identity moment. A **page-body** button is green **only**
when it is that view's true go-action:

- ✅ `.btn-go` for the one go-action (Run pipeline, Send all, Connect Gmail).
- ✅ `.btn-secondary` (neutral dark, hairline) for everything else, incl. demoted
  primaries (e.g. a header action that isn't the climax of the page).
- ⚠️ `.btn-primary` resolves to **green inside `.app-content`** (via
  `hsl(var(--primary))`) and near-white standalone — so don't reach for it when
  you want "neutral". Use `.btn-secondary`.
- shadcn `<Button>`: `default` = green, `secondary`/`outline`/`ghost` = neutral.

If a screen already shows green on its go-action, secondary actions are neutral.
Status edges (`.tgt.status-approved` etc.) use the **muted** `--success-line` /
`--info-line` so a list of them doesn't read as a wall of green.

## Typography

- `--font-body` (**Inter**) — **everything in the product UI**: headings, labels,
  body. Product is sans-only.
- `--font-display` (**Fraunces**, serif) — **only** on the marketing **Landing**
  (`.ldg-*`), the **auth** shells (`.auth-*`), the brand wordmark (`.logo`), and
  public content heroes (`.cl-*`). **Forbidden in product UI** — an appended
  override at the end of `index.css` pins in-app headings (`.me-*`, `.coach-*`,
  `.kpi-value`, `.pw-q`, `.mn-title`, …) back to `--font-body`.
- `--font-mono` (Geist Mono) for IDs / emails / data.
- Fixed rem scale, ~14px base, ~1.2 ratio. Prose caps at 65–75ch.

> Note: Tailwind's `font-sans` is **Geist**-first while legacy `--font-body` is
> **Inter**-first. Newer (Tailwind) pages render Geist; legacy-CSS pages render
> Inter. Both are clean grotesques; unifying them is future work, out of scope of
> the serif-removal pass.

## Spacing, radii, elevation, motion

- Space `--space-1 … --space-10` (4px base). Radii tight: `--radius-sm` 4,
  `--radius` ~8, `--radius-lg` 10.
- Elevation: hairline borders do the work. Shadows only on floating menus.
- **Motion: minimal and fast.** Page entrance is `animate-fade-in`
  (**0.18s**, opacity-dominant, `translateY(2px)`) — defined in
  `tailwind.config.cjs`. No per-item stagger delays on page load (content must be
  readable immediately). Honor `prefers-reduced-motion`. State changes only, no
  bounces.
- Focus: 2px green ring (`--ring`). Never remove it; pair any `outline-none` with
  a `focus-visible:ring-*` replacement.

## Components (the unified vocabulary)

- **Buttons**: `.btn-go` (green go), `.btn-secondary` (neutral), `.btn-ghost`
  (chromeless), `.btn-launch` (pill shape modifier). shadcn `<Button>` for new
  Tailwind surfaces.
- **Form controls**: bare `input`/`textarea`/`select` are globally styled. Don't
  re-skin per screen. Inputs need `aria-label` or a `<label>`.
- **Status labels**: `.pill` / `.badge` / `.status-pill` share one flat base; add
  tone via `.is-success | .is-warn | .is-danger | .is-info`.
- **Surfaces**: `--bg-elev` + `--border` + radius. No nested cards; many lists are
  rows-in-a-bordered-list, not card grids.
- **Loading**: skeletons (shimmer), never a centered spinner.
- **App shell**: sticky sidebar (grey-fill active nav, not green), sticky topbar
  with hairline border (no blur/translucency). Topbar **New mission** is the green
  identity moment.

## Accessibility (baseline, already enforced — keep it)

- Icon-only buttons: `aria-label`. Decorative icons: `aria-hidden`.
- Toasts/async regions: `aria-live="polite"`. Charts: `role="img"` + label.
- Toggles: `aria-pressed`. Visible focus on every interactive element.
- Ellipsis `…` (not `...`) in loading/placeholder copy.

## Bans (enforced)

- No hardcoded hex/rgb in component CSS (add a token). No **bare `var(--x)`** for
  a colliding shadcn token used as a color (use `hsl(var(--x))`).
- No green fills outside the sanctioned go-action / identity moments. No green
  hero washes, no `--primary`/green-soft backgrounds on whole cards.
- No Fraunces / `--font-display` in product UI. Sans only.
- No em dashes in UX copy. No gradient text. No glassmorphism / topbar blur.
- No slow or staggered page-entrance animation. No hero-metric KPI-grid template
  as a default (Analytics is the one place a metric grid is allowed).
