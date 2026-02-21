# Contributing to candy-localhost

First off: this project started as a shitpost about IANA handing out /8 blocks like candy in the 1980s. It accidentally became useful. Please maintain the vibe.

## The Rules

1. **The daemon is the source of truth.** Everything else is a client. Don't break this.
2. **Zero npm dependencies.** Pure Bun stdlib. If you need a library, you need a better idea.
3. **Easter eggs are features.** The void system, yandere mode, and candy corruption are not bugs. Don't "fix" them. Enhance them.
4. **Flavor text matters.** If you add an API response, give it personality. Study the existing `msg` object in `daemon.ts`.

## Getting Started

```bash
bun install
bun run dev    # daemon with auto-reload
```

Visit `https://portal.localhost` to see the portal UI. Visit any unconfigured domain like `https://anything.localhost` to see the registration page.

## Project Structure

```
daemon.ts          The daemon. Manages everything. 
mcp.ts             MCP server for AI integration
cli.ts             CLI client (candy dev, candy logs, etc.)
public/
  portal.html      Management UI with terminal + GUI modes
  candy.html       Registration page (cute mode)
  terminal.html    Registration page (dark mode, 15% chance)
  starting.html    Server boot screen with streaming logs
  crashed.html     Server crash screen
  killed.html      Server killed screen
  portaling.html   Tunnel creation loading screen
  favicon.svg      A candy with a void eye. Look closely.
```

## What We Want

### Platform Ports
The daemon is Linux-native. We want:
- **macOS support** — replace systemd, xdg-open, /tmp paths, freedesktop protocol handlers
- **Windows support** — god help you

### Void Manifestations
The void currently spawns calculators. We want more. Ideas:
- Platform-specific chaos (spawning `calc.exe` on Windows is funnier than `gnome-calculator`)
- New GUI manifestations beyond calculators
- Seasonal void themes

### Easter Eggs
The existing horror systems are:
- **Candy corruption** (candy.html) — candies become eyes, taglines shift, shadow figure, color degradation
- **Yandere mode** (candy.html) — tab abandonment triggers clingy localhost behavior
- **Restricted zone** (candy.html) — guilt trip when proxying external domains
- **Void incursion** (portal.html) — full terminal corruption with interactive void commands
- **Time corruption** (terminal.html) — progressive visual degradation

Add new ones. Surprise us. Some ground rules:
- Horror should escalate gradually, not jump-scare
- Corruption should feel *persistent* — things that change should stay changed
- The localhost is possessive. It doesn't want you to leave. This is thematically correct because external domain proxying genuinely doesn't work well (Host header issues).

### MCP Tools
New tools for AI integration are welcome. The MCP server authenticates via a bootstrap secret exchanged for session API keys.

### CLI Commands
The `candy` CLI is young. Make it better.

## What We Don't Want

- npm dependencies
- Removing or "fixing" easter eggs
- Making the flavor text "professional"
- Breaking the multiplayer log architecture (daemon owns processes, clients read streams)
- Electron

## Code Style

- TypeScript, Bun APIs
- No semicolons in the HTML `<script>` blocks (they're already inconsistent, don't worry about it)
- Comments should be useful or funny. Preferably both.
- `// The void is patient` is a valid comment.

## Submitting Changes

1. Fork the repo
2. Create a branch (`feat/windows-void-manifestation`, `fix/yandere-timing`, etc.)
3. Test on your machine (we don't have CI, this is a localhost tool)
4. Open a PR with a description that matches the project's energy
5. Wait for the maintainer to type "lgtmed"

## The Void

If you've read this far, the void has noticed you. Welcome.

```
░█░█░█░ VOID ░█░█░█░
░░THE░VOID░░HUNGERS░░
░█░█░█░░░░░░░░█░█░█░
```
