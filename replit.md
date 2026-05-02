# EmeraldNetwork Website

## Overview
A static portfolio and landing page for applications and services created by IceEmerald, including Discord bots and Minecraft plugins. Also includes a full-featured document editor and a note-taking app.

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
- `notes.html` — Rich note-taking app (sidebar + editor, collab, export)
- `document.html` — Full MS Word / Google Docs-like document editor
- `sw.js` — Service worker
- `assets/` — Static assets
  - `images/` — Project and UI images
  - `scripts/` — JS modules
    - `notes.js` — Notes app logic
    - `document.js` — Document editor logic (pages, zoom, export, import)
    - `dropdown.js`, `rightclick.js`, `animationvisible.js`, `scrollice.js`
  - `styles/` — CSS stylesheets
    - `style.css` — Global/shared styles
    - `notes.css` — Notes app styles
    - `document.css` — Document editor styles

## Document Editor Features (document.html)
- **Paging system**: Real A4/Letter/Legal/A3/A5/B5 pages with correct dimensions
- **Ribbon tabs**: Home, Insert, Layout, Styles
- **Clipboard**: Cut, Copy, Paste
- **Font**: Family (50+ fonts), size, Bold, Italic, Underline, Strikethrough, Sub/Superscript, font color (color grid), highlight color
- **Paragraph**: Left/Center/Right/Justify alignment, bullet list, numbered list, indent/outdent, line spacing
- **Insert**: Table (grid picker), Image (file/drag-drop), Hyperlink, Horizontal rule, Page break, Special characters/symbols, Header & Footer, Page number
- **Layout**: Page size, orientation, margins (presets + custom), columns (1/2/3), zoom in/out
- **Styles gallery**: Normal, H1–H4, Quote, Code, Caption, Subtitle, Title
- **Delete**: Clear formatting, delete page
- **Export**: PDF (print dialog), DOCX (html-docx-js library)
- **Import**: DOCX (mammoth.js), PDF (text extraction), TXT, HTML
- **Share/Collaboration**: URL-based share link, collab link
- **Ruler**: Canvas-drawn inch ruler with margin indicators
- **Status bar**: Page X of Y, word count, character count, zoom %
- **Auto-save**: localStorage with 1.2s debounce + 30s interval
- **Keyboard shortcuts**: Ctrl+S (save), Ctrl+P (print/PDF), Ctrl+B/I/U, Tab (indent)

## Running the App
- **Workflow**: "Start application" — `python3 -m http.server 5000 --bind 0.0.0.0`
- **Port**: 5000 (webview)

## Deployment
- **Type**: Static site
- **Public Directory**: `.` (project root)
