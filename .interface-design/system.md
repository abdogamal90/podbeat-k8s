# podbeat-k8s design system

Saved from the design pass of Nov 22 2026 (interface-design + frontend-design
skills, GNOME shell per gnome-gui-spec). Read this before touching UI.

## Direction and feel

**Mission-control calm.** Cold like a terminal, alive like a heart monitor.
For an on-call engineer scanning "what restarted and why" in one glance.
Dense, quiet chrome, one unmistakable signal.

## Signature: the beat

An EKG blip (`beatGlyph()` in `static/app.js`, styled in `style.css` under
"signature: the beat"):

- **brand pulse dot** — a real lub-dub two-thump heartbeat in the header
- **pods table** — every restarts cell carries a blip: `live` (animated trace)
  for restarts < 1h old, amber for < 24h, static grey beyond, flatline for 0
- **restarts tab** — blip in the "when" column, live if the event is < 1h old
- **logs** — `live-dot` + `LIVE` while streaming
- **empty restarts state** — a flatline with "steady — no restarts recorded"

All beat animation is disabled under `prefers-reduced-motion`.

## Tokens (style.css `:root`)

- Surfaces, one hue (blue-green charcoal), lightness ramp only:
  `--bg #0b0f12` → `--bg-raised #10161b` → `--bg-overlay #141c21` →
  `--bg-modal #172126`; inputs sit *darker* (`--bg-control #0e1317`).
- Ink, four levels: `--ink #d7e3e8` / `--ink-dim #8ca3ab` / `--ink-faint #5d7078`.
- Identity: `--pulse #45d6b8` (phosphor teal, the only accent, ~10% coverage).
  Semantics: `--ok #58c786`, `--warn #e6b44e`, `--bad #e86a72`.
- Borders-only depth: `--line rgba(255,255,255,.07)`, `--line-strong .14`.
  No shadows except modal backdrop blur.

## Typography

Mono-first: the data *is* the interface (`--mono` stack for tables, values,
brand; `--sans` only for prose labels/buttons). All numeric cells use
`font-variant-numeric: tabular-nums`. Scale 10/11/12/13/14/16 — hierarchy
through weight + ink level more than size.

## Density and spacing

4px base unit, tool-tight: 30px controls, ~30px table rows, 46px header,
36px tabs, 27px footer. Radius scale: 6px controls, 7px cm cards, 9px modal.

## Motion

`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`. Entrances 160–180ms from
opacity+small-offset only; press `scale(0.97)`; only `transform`/`opacity`
animate. Repeated actions (tab switches, table renders) get **no** animation.

## Shell (podbeat-app.py)

libadwaita chrome when available: `Adw.Application` + `Adw.ApplicationWindow`
+ `Adw.HeaderBar` + `Adw.ToolbarView`, dark via `Adw.ColorScheme.PREFER_DARK`
to match the web UI. Icon-only header buttons always carry `tooltip-text`.
`Gtk.ShortcutsWindow` on Ctrl+Shift+question; `Adw.AboutWindow` from the menu.
Plain GTK4 window as fallback, then Chrome `--app`, then browser.

## Named defaults we rejected

generic blue accent → phosphor teal · sans-everything → mono-first ·
same-density flat table → one focal signal column (restarts/beat) ·
spinner loading → quiet skeleton shimmer.
