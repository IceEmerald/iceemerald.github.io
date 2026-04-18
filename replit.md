# EmeraldNetwork Notes

A rich-text notes app with optional live collaboration on GitHub Pages.

## Live collaboration
- Firebase Realtime Database powers shared notes
- Edit the Firebase config in the **Setup Live Collaboration** modal
- The config is stored in browser localStorage under `firebase_config`
- Shared notes open with `#room/<id>` in the URL

## Where to edit Firebase settings
1. Open the app
2. Click **Go Live / Share**
3. If prompted, paste your Firebase Web App config JSON
4. Enable Realtime Database in Firebase Console

## Files
- `notes.html`
- `assets/scripts/notes.js`
- `assets/styles/notes.css`
