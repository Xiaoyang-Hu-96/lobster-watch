# 🦞 Lobster Watch

A calm, transparent dashboard for monitoring autonomous AI agents — built with a pixel art aesthetic inspired by Stardew Valley.

This monorepo contains two projects:

---

## Projects

### `lobster-watch-app/` — Agent Monitoring Dashboard

A real-time dashboard that connects to the OpenClaw gateway and displays live AI agent activity.

**Features:**
- Real-time agent status via WebSocket
- Memory file viewer
- Pixel art UI with ocean/coral color palette

**Tech stack:** Node.js, Express, WebSocket, vanilla HTML/CSS/JS

**Getting started:**
```bash
cd lobster-watch-app
npm install
cp .env.example .env   # fill in your OpenClaw gateway config
npm start              # runs on http://localhost:3000
```

**Environment variables** (see `.env.example`):
| Variable | Description |
|---|---|
| `OPENCLAW_GATEWAY_URL` | WebSocket URL of the OpenClaw gateway |
| `OPENCLAW_GATEWAY_TOKEN` | Auth token for the gateway |
| `OPENCLAW_HOME` | Path to OpenClaw home directory |
| `PORT` | Server port (default: 3000) |

---

### `lobster-watch-landing/` — Landing Page

A marketing landing page for Lobster Watch, showcasing the product with the same pixel art visual style.

**Tech stack:** Vanilla HTML/CSS/JS, deployed via Netlify

**Getting started:**
```bash
cd lobster-watch-landing
open index.html   # or deploy to Netlify
```

---

## Design

Both projects share a consistent visual language:
- **Font:** Pixelify Sans (pixel art) + DM Sans (body text)
- **Colors:** Ocean blue, coral, seafoam, sand
- **Style:** Retro pixel art with a cozy, calm feel
