# EmeraldNetwork Notes

A rich-text, collaborative note-taking web app hosted as static files (GitHub Pages compatible).

## Files
- `notes.html` — Main app page
- `assets/scripts/notes.js` — All app logic (NotesApp, CollaborationManager, AIAssistant)
- `assets/styles/notes.css` — All styles
- `assets/scripts/dropdown.js`, `rightclick.js`, `animationvisible.js`, `scrollice.js` — Supporting scripts

## Features

### Core Notes
- Create, edit, delete, and color-code notes
- Rich text editor (ribbon toolbar: bold, italic, underline, alignment, lists, tables, links)
- Auto-save to localStorage
- Export note as compressed share link (`?s=...`)
- Import note from URL on page load

### Live Collaboration (Firebase-powered)
- **Go Live button** (antenna icon) in editor header
- Requires a free Firebase project with Realtime Database enabled
- First-time setup: paste Firebase config JSON into the setup dialog
- Generates a sharable URL (`notes.html#room/ROOM_ID`) for real-time multi-user editing
- Real-time content + title sync (debounced, 700ms)
- Presence bar shows collaborator avatars when 2+ users are in the same note
- "Stop Sharing" removes the room and resets the URL
- Works on GitHub Pages — no server required (Firebase is the backend)

### AI Assistant (OpenAI-compatible)
- **AI button** (star icon) in editor header — opens floating panel
- Quick actions: Continue Writing, Improve, Summarize, Fix Grammar
- Custom prompt text input + Generate button
- AI response shown inline; "Insert at cursor" or "Replace note" to apply
- Settings modal: configure API Key, endpoint URL, and model name
- Supports OpenAI, Groq (free tier), Together AI, and any OpenAI-compatible API
- API key stored in localStorage (never leaves the browser)

## Architecture
- 100% static HTML/CSS/JS — no build step, works on GitHub Pages
- Firebase Realtime Database for real-time sync and presence
- AI calls are direct browser fetch() to the AI provider API (CORS-enabled)
- URL hash routing (`#room/ID`) for shared note deep linking

## Setup for Collaboration
1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create a project, add a Web app, copy the config JSON
3. Enable Realtime Database, set rules to allow read/write
4. Click "Go Live" in the app, paste the config, and start sharing

## Setup for AI
1. Get an API key from OpenAI, Groq, or another compatible provider
2. Click the AI (star) button, then the ⚙ settings icon
3. Enter your API key, confirm endpoint and model, save
