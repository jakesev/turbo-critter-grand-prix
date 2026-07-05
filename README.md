# 🏁 Turbo Critter Grand Prix

A complete browser-based 3D kart racer built with **three.js + vanilla JavaScript**.
Everything is procedural — track, karts, decorations, music, and sound effects
(Web Audio API synth). No external assets, no build step, no server-side code.

## ▶ Play it now

**https://jakesev.github.io/turbo-critter-grand-prix/**

Share that link with anyone — it runs on desktop and phones (on-screen controls
appear automatically on touch devices; play in landscape).

## 📱 Install it as an app (PWA)

- **Android (Chrome):** open the link → menu ⋮ → **Add to Home screen / Install app**
- **iPhone (Safari):** open the link → Share → **Add to Home Screen**
- **Desktop (Chrome/Edge):** click the install icon in the address bar

Once installed it works **fully offline**, launches fullscreen in landscape, and
your progress (best time, unlocks, settings) is saved **on that device** —
every player's phone keeps its own duck-hunting progress. 🦆

## 🌱🏁🔥 Difficulties

Pick in the menu (saved between plays):
- **Easy** — relaxed rivals, generous catch-up, fewer items thrown at you
- **Medium** — the balanced race
- **Hard** — faster, braver bots that drift, boost and use items aggressively, with little mercy catch-up

## Run it locally

The game loads three.js from a CDN and uses ES modules, so it needs a local web
server (double-clicking `index.html` won't work) and an internet connection:

```bash
cd turbo-critter-grand-prix
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, VS Code Live Server, etc.).

## Controls

| Key | Action |
|---|---|
| **W / ↑** | accelerate |
| **S / ↓** | brake / reverse |
| **A D / ← →** | steer |
| **SPACE** (hold) | drift → charges a mini-turbo into your boost meter (also: mid-air trick) |
| **SHIFT** | spend boost meter |
| **E / ENTER** | use held item |
| **H** | horn 📯 |
| **ESC** | pause |
| **P** | debug mode (waypoints, bot targets, boundaries, live stats) |

## The race

You start 8th of 8. Three laps. The rivals — Zoomie, Sir Waddles, Nitro Newt,
Big Tony, Mabel Moss, Pixel Possum and Captain Crumbs — have different skill,
nerve and personalities (one of them knows about the mud shortcut…).
Rubber-banding keeps the pack honest in both directions.

**Speed comes from:** boost pads, drift mini-turbos (orange → cyan sparks),
the ramp jump (press SPACE in the air for a trick-landing boost), slipstreaming,
coins (each one raises your top speed, max 10 — you drop some when hit), and
Turbo Carrots.

**Items** (from the rainbow mystery boxes): 🥕 Turbo Carrot · 🟢 Slime Spill ·
🫧 Bubble Shield · 🎉 Confetti Rocket · ⭐ Wobble Star.

## Secrets

Rumor has it something *golden* hides in the grass past the tunnel.
Persistent rumors say hitting it enough times changes the game forever. 🦆

## Files

- `index.html` — page shell, HUD/menu/results DOM, touch controls, import map
- `style.css` — all UI styling (incl. touch layout + PWA bits)
- `main.js` — the whole game, organized in 13 banner-commented sections
  (audio synth → track builder → particles → karts → physics/AI → items →
  race manager → HUD → input → debug → main loop)
- `manifest.webmanifest` + `sw.js` + icons — the PWA layer (installable, offline)

Debug helpers are exposed on `window.TCGP` (e.g. `TCGP.step(n)` to fast-forward,
`TCGP.debugFinish(true)` to end a race, `TCGP.unlockDuck()` if you're impatient).
