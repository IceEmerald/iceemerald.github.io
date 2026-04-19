# EmeraldNetwork Notes

A static HTML notes app deployed on GitHub Pages. All data stored in localStorage.

## Files
- `notes.html` — Main app entry point
- `assets/scripts/notes.js` — All app logic (~1900 lines)
- `assets/styles/notes.css` — All styles (~2050 lines)
- `assets/scripts/dropdown.js`, `rightclick.js`, `animationvisible.js`, `scrollice.js` — Supporting scripts

## Architecture
- Single `NotesApp` class in `notes.js`
- Notes saved as JSON in `localStorage` under key `emeraldNotes`
- Each note: `{ id, title, content (HTML), color, drawing (base64 PNG), createdAt, modifiedAt }`
- `sanitizeHtml()` sanitizes loaded content (allows: font, tbody/thead/tfoot, input[checkbox], span, etc.)
- Rich text editing via contenteditable + modern span-based methods (`modernFontFamily`, `modernFontSize`, `modernTextColor`, `modernHighlightColor`)

## Key Features
- Rich text editor (bold, italic, underline, strikethrough, lists, headings, font/size/color/highlight)
- Tables (with thead/tbody/tfoot support)
- To-Do items (clickable checkboxes, checked state persists via HTML attribute)
- Drawing canvas overlay (pen, eraser, color picker, thickness slider, saved as base64 per note)
- Note color customization
- Export/import via URL compression
- Mobile responsive with swipe gestures

## Bugs Fixed (April 2026)
- `sanitizeHtml` now allows `font`, `tbody`, `thead`, `tfoot`, `input[checkbox]` tags
- Font family now uses `<span style="font-family:X">` (not `<font face>` which was stripped)
- Font size display no longer shows 'px' suffix in ribbon dropdown
- Text color and highlight color now call `updateNoteContent()` after applying
- Highlight "None" (transparent) handled correctly
- Table structure preserved (tbody no longer stripped)

## Removed Features
- Link insertion feature removed (was causing confusion; will be re-added later if needed)

## Planned (Future)
- Real-time Firebase collaboration (paused until formatting bugs resolved)
