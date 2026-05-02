# EmeraldNetwork Website

## Overview
A static portfolio and landing page for applications and services created by IceEmerald, including Discord bots and Minecraft plugins.

## Tech Stack
- **Languages**: HTML5, CSS3, Vanilla JavaScript (ES6+)
- **Build System**: None — pure static site, no build step required
- **Package Manager**: None
- **Service Worker**: `sw.js` for offline support (PWA-like)

## Project Structure
- `index.html` — Main landing page
- `404.html` — Custom error page
- `offline.html` — Service worker offline fallback
- `discordemeraldbot.html` / `discordemeraldbotcmds.html` — Discord bot pages
- `emeraldcreative.html` / `emeraldessentialsplugin.html` — Project pages
- `notes.html` — Updates/notes page
- `sw.js` — Service worker
- `assets/` — Static assets
  - `images/` — Project and UI images
  - `scripts/` — JS modules (animations, scrolling, dropdown, etc.)
  - `styles/` — CSS stylesheets

## Running the App
- **Workflow**: "Start application" — `python3 -m http.server 5000 --bind 0.0.0.0`
- **Port**: 5000 (webview)

## Deployment
- **Type**: Static site
- **Public Directory**: `.` (project root)
