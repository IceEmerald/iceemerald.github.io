// EmeraldNotes JavaScript - Note Taking App Functionality

// Compress a string to a URL-safe token using browser-native deflate (no library needed)
async function compressToUrl(str) {
    const bytes = new TextEncoder().encode(str);
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    const arr = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Decompress a URL-safe token back to the original string
async function decompressFromUrl(token) {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const out = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(out);
}

class NotesApp {
    constructor() {
        this.notes = [];
        this.currentNoteId = null;
        this.saveTimeout = null;
        this.isInitialized = false;
        this.savedSelection = null;
        this.isMobile = () => window.innerWidth <= 1023;
        this.sidebarOpen = false;
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchStartTime = 0;
        this.isSwiping = false;
        this.collab = null;
        this.init();
    }

    init() {
        this.loadNotesFromStorage();
        this.setupEventListeners();
        this.setupRibbon();
        this.setupMobileRibbon();
        this.setupTextEditor();
        this.renderNotesList();
        this.showWelcomeScreenIfNeeded();
        this.setupMobileUI();
        this.setupSwipeGesture();
        this.isInitialized = true;
        this.collab = new CollaborationManager(this);
        this.collab.checkRoomFromUrl();
    }

    loadNotesFromStorage() {
        try {
            const stored = localStorage.getItem('emeraldnotes_data');
            if (stored) {
                this.notes = JSON.parse(stored);
                this.notes.forEach(note => {
                    if (note.content && typeof note.content === 'string') {
                        if (note.content.trim() === '<p>Start typing your note here...</p>' || note.content.trim() === 'Start typing your note here...') note.content = '';
                        const legacyEmptyPatterns = ['<div>\u00A0</div>', '<p>\u00A0</p>', '<div>&nbsp;</div>', '<p>&nbsp;</p>'];
                        if (legacyEmptyPatterns.includes(note.content.trim())) note.content = '';
                    }
                });
            }
        } catch (error) {
            console.error('Error loading notes from storage:', error);
            this.notes = [];
        }
    }

    saveNotesToStorage() {
        try {
            localStorage.setItem('emeraldnotes_data', JSON.stringify(this.notes));
            this.showSaveIndicator('saved');
        } catch (error) {
            console.error('Error saving notes from storage:', error);
            this.showSaveIndicator('error');
        }
    }

    showSaveIndicator(status) {
        const indicator = document.getElementById('saveIndicator');
        if (!indicator) return;
        const text = indicator.querySelector('.save-text');
        indicator.className = 'save-indicator';
        switch (status) {
            case 'saving': indicator.classList.add('saving'); if (text) text.textContent = 'Saving...'; break;
            case 'saved': if (text) text.textContent = 'All changes saved'; break;
            case 'error': if (text) text.textContent = 'Error saving'; break;
        }
    }

    debouncedSave() {
        this.showSaveIndicator('saving');
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => this.saveNotesToStorage(), 1000);
    }

    setupEventListeners() {
        const newNoteBtn = document.getElementById('newNoteBtn');
        const welcomeNewNoteBtn = document.getElementById('welcomeNewNoteBtn');
        if (newNoteBtn) newNoteBtn.addEventListener('click', () => this.createNewNote());
        if (welcomeNewNoteBtn) welcomeNewNoteBtn.addEventListener('click', () => this.createNewNote());
        const deleteNoteBtn = document.getElementById('deleteNoteBtn');
        if (deleteNoteBtn) deleteNoteBtn.addEventListener('click', () => this.deleteCurrentNote());
        const exportNoteBtn = document.getElementById('exportNoteBtn');
        if (exportNoteBtn) exportNoteBtn.addEventListener('click', () => this.exportNoteAsLink());
        const goLiveBtn = document.getElementById('goLiveBtn');
        if (goLiveBtn) goLiveBtn.addEventListener('click', () => this.collab?.goLive());
        const noteTitle = document.getElementById('noteTitle');
        if (noteTitle) noteTitle.addEventListener('input', (e) => { if (this.currentNoteId) this.updateNoteTitle(e.target.value); });
        const textEditor = document.getElementById('textEditor');
        if (textEditor) textEditor.addEventListener('input', () => { if (this.currentNoteId) { this.updatePlaceholderState(textEditor); this.updateNoteContent(); } });
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
        document.querySelectorAll('.ribbon-btn, .ribbon-tab').forEach(element => element.addEventListener('mousedown', (e) => e.preventDefault()));
        document.querySelectorAll('.ms-dropdown-item, .color-swatch').forEach(element => element.addEventListener('mousedown', (e) => e.preventDefault()));
        this.setupMSDropdowns();
        this.setupCustomContextMenu();
        this.setupEditorPlaceholder();
        this.setupSidebarToggle();
    }

    updateNoteTitle(title) {
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (note) {
            note.title = title || 'Untitled Note';
            note.modifiedAt = new Date().toISOString();
            this.renderNotesList();
            this.debouncedSave();
            if (this.collab?.currentRoom) {
                const ed = document.getElementById('textEditor');
                this.collab.syncContent(ed?.innerHTML || '', title || '');
            }
        }
    }

    updateNoteContent() {
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (note) {
            const textEditor = document.getElementById('textEditor');
            const content = textEditor.innerHTML.trim();
            note.content = this.isEditorEmpty(textEditor) ? '' : content;
            note.modifiedAt = new Date().toISOString();
            this.renderNotesList();
            this.debouncedSave();
            if (this.collab?.currentRoom) {
                const ti = document.getElementById('noteTitle');
                this.collab.syncContent(note.content || '', ti?.value || note.title || '');
            }
        }
    }

    renderNotesList() {
        const notesList = document.getElementById('notesList');
        if (!notesList) return;
        notesList.innerHTML = '';
        this.notes.forEach(note => notesList.appendChild(this.createNoteListItem(note)));
    }

    createNoteListItem(note) {
        const div = document.createElement('div');
        div.className = 'note-item';
        div.dataset.noteId = note.id;
        if (note.id === this.currentNoteId) div.classList.add('active');
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = note.content;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        const preview = plainText.substring(0, 150);
        const date = new Date(note.modifiedAt);
        div.innerHTML = `<div class="note-item-title">${this.escapeHtml(note.title)}${note.isLive ? '<span class="live-badge">● Live</span>' : ''}</div><div class="note-item-preview">${this.escapeHtml(preview)}${preview.length === 150 ? '...' : ''}</div><div class="note-item-date">${this.formatDate(date)}</div>`;
        div.addEventListener('click', () => { this.selectNote(note.id); if (this.isMobile()) this.closeMobileSidebar(); });
        return div;
    }

    // existing methods remain below this line in your file
}

class CollaborationManager {
    constructor(notesApp) {
        this.app = notesApp;
        this.db = null;
        this.currentRoom = null;
        this.isHost = false;
        this.isLocalUpdate = false;
        this.debounceTimer = null;
        this.userId = this._getOrCreate('collab_uid', 'u_' + Math.random().toString(36).substr(2, 9));
        this.userName = this._getOrCreate('collab_name', 'User' + Math.floor(Math.random() * 9000 + 1000));
        this.userColor = this._getOrCreate('collab_color', this._randomColor());
    }
    _getOrCreate(key, def) { let v = localStorage.getItem(key); if (!v) { v = def; localStorage.setItem(key, v); } return v; }
    _randomColor() { const c = ['#e74c3c','#e67e22','#27ae60','#2980b9','#8e44ad','#16a085','#d35400','#c0392b']; return c[Math.floor(Math.random() * c.length)]; }
    getConfig() { try { return JSON.parse(localStorage.getItem('firebase_config') || 'null'); } catch { return null; } }
    saveSetupConfig() {
        const raw = document.getElementById('firebaseConfigInput')?.value?.trim();
        if (!raw) return;
        try {
            JSON.parse(raw);
            localStorage.setItem('firebase_config', raw);
            document.getElementById('firebaseSetupModal')?.classList.remove('show');
            this.db = null;
            this.goLive();
        } catch { alert('Invalid JSON. Paste the complete Firebase config object.'); }
    }
    async initFirebase() {
        if (this.db) return true;
        if (typeof firebase === 'undefined') { alert('Firebase SDK failed to load. Check your internet connection.'); return false; }
        const config = this.getConfig();
        if (!config) return false;
        try { if (!firebase.apps.length) firebase.initializeApp(config); this.db = firebase.database(); return true; } catch (e) { console.error('Firebase init:', e); alert('Firebase error: ' + e.message); return false; }
    }
    async checkRoomFromUrl() { const m = window.location.hash.match(/#room\/([a-zA-Z0-9_-]+)/); if (!m) return; const ok = await this.initFirebase(); if (!ok) { this.showSetupModal(); return; } await this.joinRoom(m[1]); }
    async goLive() {
        if (!this.app.currentNoteId) { alert('Please select or create a note first.'); return; }
        const ok = await this.initFirebase();
        if (!ok) { this.showSetupModal(); return; }
        if (this.currentRoom) { this.showShareModal(this.currentRoom); return; }
        const note = this.app.notes.find(n => n.id === this.app.currentNoteId);
        if (!note) return;
        const roomId = this._genId();
        this.currentRoom = roomId;
        this.isHost = true;
        await this.db.ref('rooms/' + roomId).set({ title: note.title || 'Untitled Note', content: note.content || '', createdAt: Date.now(), hostId: this.userId });
        note.isLive = true;
        note.roomId = roomId;
        this.app.renderNotesList();
        this.app.saveNotesToStorage();
        this._listenRoom(roomId);
        this._registerPresence(roomId);
        window.history.pushState({}, '', '#room/' + roomId);
        this._updateGoLiveBtn(true);
        this.showShareModal(roomId);
    }
    async joinRoom(roomId) {
        const snap = await this.db.ref('rooms/' + roomId).once('value');
        const data = snap.val();
        if (!data) { alert('This shared note no longer exists.'); window.history.replaceState({}, '', window.location.pathname); return; }
        this.currentRoom = roomId;
        this.isHost = false;
        let note = this.app.notes.find(n => n.roomId === roomId);
        if (!note) { note = { id: this.app.generateId(), title: data.title || 'Shared Note', content: data.content || '', color: '#ffffff', createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), isLive: true, roomId }; this.app.notes.unshift(note); }
        else { note.title = data.title || note.title; note.content = data.content || note.content; note.isLive = true; }
        this.app.selectNote(note.id);
        this.app.renderNotesList();
        this.app.saveNotesToStorage();
        this._listenRoom(roomId);
        this._registerPresence(roomId);
        this._updateGoLiveBtn(true);
    }
    _listenRoom(roomId) {
        const ref = this.db.ref('rooms/' + roomId);
        ref.child('content').on('value', snap => { if (this.isLocalUpdate) return; const val = snap.val(); const note = this.app.notes.find(n => n.roomId === roomId); if (!note || val === null) return; note.content = val; if (this.app.currentNoteId === note.id) { const ed = document.getElementById('textEditor'); if (ed && ed.innerHTML !== val) ed.innerHTML = val; } });
        ref.child('title').on('value', snap => { if (this.isLocalUpdate) return; const val = snap.val(); const note = this.app.notes.find(n => n.roomId === roomId); if (!note || val === null) return; note.title = val; if (this.app.currentNoteId === note.id) { const ti = document.getElementById('noteTitle'); if (ti && ti.value !== val) ti.value = val; } this.app.renderNotesList(); });
        ref.child('users').on('value', snap => this._updatePresenceUI(snap.val() || {}));
    }
    syncContent(content, title) { if (!this.currentRoom || !this.db) return; clearTimeout(this.debounceTimer); this.debounceTimer = setTimeout(() => { this.isLocalUpdate = true; this.db.ref('rooms/' + this.currentRoom).update({ content, title: title || 'Untitled', lastUpdated: Date.now() }); setTimeout(() => { this.isLocalUpdate = false; }, 400); }, 700); }
    _registerPresence(roomId) { const ref = this.db.ref('rooms/' + roomId + '/users/' + this.userId); ref.set({ name: this.userName, color: this.userColor, joinedAt: Date.now() }); ref.onDisconnect().remove(); }
    _updatePresenceUI(users) { const bar = document.getElementById('presenceBar'); if (!bar) return; const list = Object.values(users); if (list.length < 2) { bar.innerHTML = ''; bar.style.display = 'none'; return; } bar.style.display = 'flex'; bar.innerHTML = list.map(u => `<div class="presence-avatar" style="background:${u.color}" title="${u.name}">${u.name.charAt(0).toUpperCase()}</div>`).join('') + `<span class="presence-label">${list.length} collaborating</span>`; }
    async stopLive() { if (!this.currentRoom) return; if (this.db) { this.db.ref('rooms/' + this.currentRoom + '/users/' + this.userId).remove(); if (this.isHost) this.db.ref('rooms/' + this.currentRoom).remove(); } const note = this.app.notes.find(n => n.roomId === this.currentRoom); if (note) { note.isLive = false; note.roomId = null; } this.currentRoom = null; this.isHost = false; window.history.replaceState({}, '', window.location.pathname); this._updateGoLiveBtn(false); const bar = document.getElementById('presenceBar'); if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; } this.app.renderNotesList(); this.app.saveNotesToStorage(); document.getElementById('shareLiveModal')?.classList.remove('show'); }
    _genId() { return Math.random().toString(36).substr(2, 8) + Date.now().toString(36); }
    _updateGoLiveBtn(live) { const btn = document.getElementById('goLiveBtn'); if (!btn) return; btn.classList.toggle('live-active', live); btn.title = live ? 'Currently Live — click to see share link' : 'Go Live / Share'; }
    showSetupModal() { document.getElementById('firebaseSetupModal')?.classList.add('show'); }
    showShareModal(roomId) { const modal = document.getElementById('shareLiveModal'); if (!modal) return; const li = document.getElementById('shareLinkInput'); if (li) li.value = location.origin + location.pathname + '#room/' + roomId; modal.classList.add('show'); }
    copyShareLink() { const v = document.getElementById('shareLinkInput')?.value; if (!v) return; navigator.clipboard.writeText(v).then(() => { const btn = document.getElementById('copyShareLinkBtn'); if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); } }); }
}

document.addEventListener('DOMContentLoaded', () => {
    window.notesApp = new NotesApp();
    window.notesApp.importNoteFromUrl();
});

window.addEventListener('beforeunload', () => {
    const app = window.notesApp;
    if (app && app.saveTimeout) { clearTimeout(app.saveTimeout); app.saveNotesToStorage(); }
});