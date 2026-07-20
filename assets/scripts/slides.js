/* ============================================================
   EmeraldSuite Slides — Professional Presentation Engine
   SlidesApp class — complete replacement for the notes-based editor
   ============================================================ */

'use strict';

// ── Utility ────────────────────────────────────────────────────
function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function htmlToText(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent || '';
}

function formatDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Shape SVG generator
function shapeSVG(shape, fill, stroke, strokeWidth) {
    const sw = (stroke === 'none' || !stroke) ? 0 : (strokeWidth || 2);
    const f = fill === 'none' ? 'none' : (fill || '#f97316');
    const s = (stroke === 'none' || !stroke) ? 'none' : stroke;
    const attrs = `fill="${f}" stroke="${s}" stroke-width="${sw}"`;
    const pad = sw / 2;

    const star5 = () => {
        const outer = 50 - pad, inner = outer * 0.4, pts = [];
        for (let i = 0; i < 10; i++) {
            const r = i % 2 === 0 ? outer : inner;
            const a = (i * 36 - 90) * Math.PI / 180;
            pts.push(`${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`);
        }
        return pts.join(' ');
    };

    const hex = () => Array.from({ length: 6 }, (_, i) => {
        const a = (i * 60 - 90) * Math.PI / 180;
        const r = 50 - pad;
        return `${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`;
    }).join(' ');

    const map = {
        rect:    `<rect x="${pad}" y="${pad}" width="${100 - sw}" height="${100 - sw}" ${attrs}/>`,
        rounded: `<rect x="${pad}" y="${pad}" width="${100 - sw}" height="${100 - sw}" rx="10" ry="10" ${attrs}/>`,
        ellipse: `<ellipse cx="50" cy="50" rx="${50 - pad}" ry="${50 - pad}" ${attrs}/>`,
        triangle:`<polygon points="50,${pad} ${100 - pad},${100 - pad} ${pad},${100 - pad}" ${attrs}/>`,
        diamond: `<polygon points="50,${pad} ${100 - pad},50 50,${100 - pad} ${pad},50" ${attrs}/>`,
        star:    `<polygon points="${star5()}" ${attrs}/>`,
        arrow:   `<polygon points="${pad},35 70,35 70,${10 + pad} ${100 - pad},50 70,${90 - pad} 70,65 ${pad},65" ${attrs}/>`,
        hexagon: `<polygon points="${hex()}" ${attrs}/>`,
        line:    `<line x1="${pad}" y1="50" x2="${100 - pad}" y2="50" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 3)}" stroke-linecap="round"/>`,
    };

    const inner = map[shape] || map.rect;
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%;display:block" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

// Default element factories
function makeTextEl(x = 100, y = 100, w = 320, h = 80) {
    return {
        id: uid(), type: 'text',
        x, y, w, h, r: 0, z: 1,
        html: '',
        fontFamily: 'DM Sans',
        fontSize: 24,
        bold: false, italic: false, underline: false,
        color: '#1a1a1a',
        textAlign: 'left',
        opacity: 1,
    };
}

function makeShapeEl(shape, x = 200, y = 150, w = 200, h = 140) {
    return {
        id: uid(), type: 'shape',
        x, y, w, h, r: 0, z: 1,
        shape,
        fill: '#f97316',
        stroke: 'none',
        strokeWidth: 2,
        opacity: 1,
    };
}

function makeImageEl(src, x = 100, y = 100, w = 300, h = 200) {
    return { id: uid(), type: 'image', x, y, w, h, r: 0, z: 1, src, opacity: 1, crop: { l: 0, t: 0, r: 0, b: 0 } };
}

function makeSlide() {
    return { id: uid(), background: { type: 'color', value: '#ffffff' }, elements: [], notes: '' };
}

function makePresentation(title = 'Untitled Presentation') {
    return {
        id: uid(),
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        slides: [makeSlide()],
    };
}

// ── SlidesApp ──────────────────────────────────────────────────
class SlidesApp {
    constructor() {
        // State
        this.presentations = [];   // metadata index [{id, title, updatedAt, slideCount}]
        this.pres = null;          // current full presentation
        this.slideIdx = 0;         // active slide index
        this.selectedId = null;    // selected element id
        this.editingId = null;     // element in text-edit mode
        this.savedSelection = null; // saved selection range for toolbar button clicks
        this.clipboard = null;     // cut/copy buffer
        this.history = [];
        this.histIdx = -1;
        this.scale = 1;
        this.drag = null;          // active drag/resize/rotate state
        this.isPresenting = false;
        this.presentIdx = 0;
        this._saveTimer = null;
        this._pendingBgValue = null;
        this._deleteTarget = null; // { type: 'pres'|'slide', id?, idx? }
        this._thumbScaleCache = {};
        // Portal dropdown (ported from notes.js for proper overflow escape)
        this._portalMenu = null;
        this._portalDropdown = null;
        this._portalBtn = null;
        this._activeTab = 'home';
        this._previousTab = null; // restored when a contextual tab (e.g. Shape Format) closes
        this._cropMode = false; // true when Shift-dragging on a handle to crop

        // Storage key prefix
        this.PRES_INDEX_KEY = 'emeraldslides_index';
        this.PRES_DATA_KEY  = (id) => `emeraldslides_pres_${id}`;

        this.ready = this.init();
    }

    async init() {
        await this.loadIndex();
        this.setupRibbon();
        this.setupRibbonTabs();
        this.setupTransitionsTab();
        this.setupAnimationsTab();
        this.setupViewTab();
        this.setupExtraTabs();
        this.setupSidebarToggle();
        this.setupCanvasInteraction();
        this.setupKeyboard();
        this.setupResizeObserver();
        this.setupDropdownMenus();
        this.setupPresenterNotes();
        // Note: showWelcomeScreen(true) below already calls renderWelcomeCards().
        // Calling it twice here used to trigger an async race that duplicated
        // cards on the welcome screen, so we no longer call it directly.
        this.showWelcomeScreen(true);

        // Check URL for presentation id
        const params = new URLSearchParams(location.search);
        const openId = params.get('pres');
        if (openId) {
            const meta = this.presentations.find(p => p.id === openId);
            if (meta) { await this.openPresentation(openId); return; }
        }
        // Auto-open most recent if any
        if (this.presentations.length === 0) {
            // Nothing — welcome screen shown
        }
    }

    // ── Storage ────────────────────────────────────────────────
    async loadIndex() {
        try {
            const storage = window.EmeraldIDBStorage;
            let idx = storage ? await storage.getJSON(this.PRES_INDEX_KEY) : null;
            if (!idx) {
                const raw = localStorage.getItem(this.PRES_INDEX_KEY);
                idx = raw ? JSON.parse(raw) : [];
            }
            this.presentations = Array.isArray(idx) ? idx : [];

            // ── De-duplicate by ID (keep newest updatedAt) ──
            // Defensive: if the index somehow contains the same presentation
            // ID twice (e.g. from a prior storage migration glitch), collapse
            // to a single entry, keeping the one with the most recent updatedAt.
            const seen = new Map();
            for (const meta of this.presentations) {
                if (!meta || typeof meta !== 'object' || !meta.id) continue;
                const prev = seen.get(meta.id);
                if (!prev || (meta.updatedAt || 0) > (prev.updatedAt || 0)) {
                    seen.set(meta.id, meta);
                }
            }
            const beforeLen = this.presentations.length;
            this.presentations = Array.from(seen.values()).sort((a, b) =>
                (b.updatedAt || 0) - (a.updatedAt || 0)
            );
            if (this.presentations.length !== beforeLen) {
                // We collapsed duplicates — persist the cleaned index.
                console.warn('[Slides] Collapsed duplicate index entries:', beforeLen, '→', this.presentations.length);
                await this.saveIndex();
            }
        } catch (e) {
            this.presentations = [];
        }
    }

    async saveIndex() {
        try {
            const storage = window.EmeraldIDBStorage;
            const meta = this.presentations;
            if (storage) await storage.setJSON(this.PRES_INDEX_KEY, meta);
            localStorage.setItem(this.PRES_INDEX_KEY, JSON.stringify(meta));
        } catch (e) { console.warn('saveIndex', e); }
    }

    async loadPresData(id) {
        try {
            const storage = window.EmeraldIDBStorage;
            let data = storage ? await storage.getJSON(this.PRES_DATA_KEY(id)) : null;
            if (!data) {
                const raw = localStorage.getItem(this.PRES_DATA_KEY(id));
                data = raw ? JSON.parse(raw) : null;
            }
            return data;
        } catch (e) { return null; }
    }

    async savePresData(pres) {
        try {
            const storage = window.EmeraldIDBStorage;
            const key = this.PRES_DATA_KEY(pres.id);
            if (storage) await storage.setJSON(key, pres);
            localStorage.setItem(key, JSON.stringify(pres));
        } catch (e) { console.warn('savePresData', e); }
    }

    async deletePresData(id) {
        try {
            const storage = window.EmeraldIDBStorage;
            if (storage) await storage.delete(this.PRES_DATA_KEY(id));
            localStorage.removeItem(this.PRES_DATA_KEY(id));
        } catch (e) {}
    }

    scheduleSave() {
        this.showSaveIndicator('saving');
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.commitSave(), 800);
    }

    async commitSave() {
        if (!this.pres) return;
        this.pres.updatedAt = Date.now();
        // Update index entry
        const meta = this.presentations.find(p => p.id === this.pres.id);
        if (meta) {
            meta.title = this.pres.title;
            meta.updatedAt = this.pres.updatedAt;
            meta.slideCount = this.pres.slides.length;
        }
        await Promise.all([this.saveIndex(), this.savePresData(this.pres)]);
        this.showSaveIndicator('saved');
    }

    showSaveIndicator(state) {
        const el = document.getElementById('saveIndicator');
        if (!el) return;
        if (state === 'saving') {
            el.classList.add('saving');
            el.querySelector('.save-text').textContent = 'Saving…';
        } else {
            el.classList.remove('saving');
            el.querySelector('.save-text').textContent = 'All changes saved';
        }
    }

    // Pick an icon for a toast message — mirrors the Notes app pattern.
    // All icons are monochrome black to match the Notes app's toast style.
    _toastIcon(rawMsg) {
        // Strip leading emoji/whitespace so the icon doesn't double up with
        // a ✓ or ⚠ character that was baked into the message string.
        const msg = String(rawMsg || '').replace(/^\s*[\u2705\u2714\u2716\u2728\u26a0\ufe0f\u2757\u2753\u2139]+\s*/u, '').trim();
        const m = msg.toLowerCase();

        // Monochrome black — matches the Notes app's toast icon color.
        const INK = '#111';

        // SVG stroke wrapper helper
        const svg = (paths) =>
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

        // 1. Loading / progress (generating, importing, ...)
        if (m.startsWith('generating') || m.startsWith('importing') || m.includes('this may take')) {
            return { icon: svg('<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>'), msg };
        }

        // 2. Clipboard / copied
        if (m.includes('clipboard') || m.includes('copied') || m.includes('element copied')) {
            return { icon: svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'), msg };
        }

        // 3. Export / import success (starts with emoji-stripped success words)
        if (m.startsWith('pptx exported') || m.startsWith('pdf exported') || m.startsWith('imported ') || m.includes('exported!')) {
            return { icon: svg('<polyline points="20 6 9 17 4 12"/>'), msg };
        }

        // 4. Failed / error
        if (m.includes('failed') || m.includes('error') || m.includes('could not load') || m.includes('could not')) {
            return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'), msg };
        }

        // 5. Library not loaded / warning (⚠ prefix already stripped)
        if (m.includes('not loaded') || m.includes('library') || m.includes('check your internet') || m.includes('unavailable')) {
            return { icon: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'), msg };
        }

        // 6. Warnings: must / select first / no slides found / no transition
        if (m.includes('must have') || m.includes('must be') || m.includes('select an element') || m.includes('select a') || m.includes('no slides found') || m.includes('no transition')) {
            return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'), msg };
        }

        // 7. Deleted
        if (m.includes('deleted') || m.includes('removed')) {
            return { icon: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'), msg };
        }

        // 8. Transition applied
        if (m.includes('transition')) {
            return { icon: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'), msg };
        }

        // 9. Animation added
        if (m.includes('animation') || m.includes('animate')) {
            return { icon: svg('<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6l2.1-2.1"/><circle cx="12" cy="12" r="3"/>'), msg };
        }

        // 10. View modes
        if (m.includes('normal view')) {
            return { icon: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'), msg };
        }
        if (m.includes('slide sorter') || m.includes('sorter view')) {
            return { icon: svg('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'), msg };
        }

        // 11. Notes panel toggles
        if (m.includes('notes panel opened') || m.includes('notes panel open')) {
            return { icon: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'), msg };
        }
        if (m.includes('notes panel closed') || m.includes('notes panel close')) {
            return { icon: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/><line x1="3" y1="3" x2="21" y2="21"/>'), msg };
        }

        // 12. Default info icon
        return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'), msg };
    }

    showToast(msg, duration = 3000) {
        const toast = document.getElementById('custom-toast');
        if (!toast) return;
        const { icon, msg: cleanMsg } = this._toastIcon(msg);
        toast.innerHTML = `<span style="display:flex;align-items:center;gap:10px;"><span style="display:inline-flex;flex-shrink:0;">${icon}</span><span>${cleanMsg}</span></span>`;
        toast.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
    }

    // ── Presentation Management ────────────────────────────────
    async newPresentation() {
        // Always create a brand new deck on each "New" click — even if it
        // ends up empty. To prevent the welcome screen from showing two
        // cards that look identical ("Untitled Presentation" × N), give
        // each new deck a sequential suffix: "Untitled Presentation",
        // "Untitled Presentation 2", "Untitled Presentation 3", ...
        const nextTitle = this._nextUntitledTitle();

        const pres = makePresentation(nextTitle);
        this.presentations.unshift({
            id: pres.id,
            title: pres.title,
            updatedAt: pres.updatedAt,
            slideCount: 1
        });
        await this.saveIndex();
        await this.savePresData(pres);
        await this.openPresentation(pres.id);
    }

    // Compute the next sequential "Untitled Presentation" title so that
    // multiple fresh decks don't appear as duplicate cards on the welcome
    // screen. Returns "Untitled Presentation" if none exist, otherwise
    // "Untitled Presentation N" where N = max existing suffix + 1.
    _nextUntitledTitle() {
        const base = 'Untitled Presentation';
        let maxN = 0;
        for (const meta of this.presentations) {
            if (!meta || !meta.title) continue;
            if (meta.title === base) { maxN = Math.max(maxN, 1); continue; }
            const m = /^Untitled Presentation\s+(\d+)$/.exec(meta.title);
            if (m) { maxN = Math.max(maxN, parseInt(m[1], 10)); }
        }
        return maxN === 0 ? base : `${base} ${maxN + 1}`;
    }

    // Really close the current presentation — used by the File tab.
    // Unlike deletePresentation, this does NOT remove the deck from storage;
    // it just unloads it from the editor and returns the user to the welcome
    // screen. The ribbon stays visible (we do NOT add body.no-active-note
    // because that would hide the ribbon entirely, including the File tab
    // the user just clicked). The URL is cleared so a refresh reopens at
    // the welcome screen, not at the just-closed deck.
    // Really close the current presentation — used by the File tab.
    // Behaves EXACTLY like a page refresh with no ?pres=ID in the URL:
    //   - unloads the current deck from the editor (but keeps it in storage)
    //   - hides the sidebar, editor-area, status bar, presenter notes
    //   - hides the ribbon (CSS body.no-active-note does this)
    //   - shows the welcome screen as the only visible surface
    //   - clears ?pres=ID from the URL so a refresh reopens at the welcome screen
    //
    // body.no-active-note is the same class the page starts with on initial
    // load (see <body class="no-active-note"> in slides.html), so the visual
    // result is identical to a fresh refresh.
    closePresentation() {
        this.pres = null;
        this.selectedId = null;
        this.editingId = null;
        this.slideIdx = 0;
        this.history = [];
        this.histIdx = -1;
        const titleInput = document.getElementById('presentationTitle');
        if (titleInput) titleInput.value = '';
        const slidesList = document.getElementById('slidesList');
        if (slidesList) slidesList.innerHTML = '';
        const slideCanvas = document.getElementById('slideCanvas');
        if (slideCanvas) slideCanvas.innerHTML = '';
        // Clear ?pres=ID from the URL so refresh doesn't reopen the deck
        history.replaceState(null, '', location.pathname);
        // Add body.no-active-note — same class the page loads with on a
        // fresh refresh. CSS uses this class to hide the ribbon, sidebar,
        // editor-area, status bar, and presenter notes, leaving only the
        // welcome screen visible.
        document.body.classList.add('no-active-note');
        this.showWelcomeScreen(true);
    }

    async openPresentation(id) {
        const data = await this.loadPresData(id);
        if (!data) { this.showToast('Could not load presentation.'); return; }
        this.pres = data;
        if (!this.pres.slides || this.pres.slides.length === 0) {
            this.pres.slides = [makeSlide()];
        }
        this.slideIdx = 0;
        this.selectedId = null;
        this.editingId = null;
        this.history = [];
        this.histIdx = -1;

        document.body.classList.remove('no-active-note');
        document.getElementById('presentationTitle').value = this.pres.title;

        this.renderSlideList();
        this.renderCanvas();
        this.updateRibbonState();
        this.updateStatusBar();
        this._loadPresenterNotes();
        // Restore the first slide's saved drawing onto the overlay
        // canvas so it's visible as soon as the deck opens.
        this._restoreDrawing();
        this.showWelcomeScreen(false);
        // If the user was on the File tab (welcome screen) when they clicked
        // a presentation card or "New", switch back to Home so the Home
        // ribbon panel is showing when the editor reappears.
        this._switchTab('home');

        // Add ribbon animation (both tabs strip and content box)
        const ribbon = document.getElementById('mainRibbon');
        if (ribbon) { ribbon.classList.add('entering'); setTimeout(() => ribbon.classList.remove('entering'), 600); }
        const ribbonTabs = document.getElementById('mainRibbonTabs');
        if (ribbonTabs) { ribbonTabs.classList.add('entering'); setTimeout(() => ribbonTabs.classList.remove('entering'), 600); }

        // Update URL
        const url = new URL(location.href);
        url.searchParams.set('pres', this.pres.id);
        history.replaceState(null, '', url);
    }

    async deletePresentation(id) {
        this.presentations = this.presentations.filter(p => p.id !== id);
        await Promise.all([this.saveIndex(), this.deletePresData(id)]);
        if (this.pres && this.pres.id === id) {
            this.pres = null;
            this.selectedId = null;
            document.body.classList.add('no-active-note');
            document.getElementById('presentationTitle').value = '';
            document.getElementById('slidesList').innerHTML = '';
            document.getElementById('slideCanvas').innerHTML = '';
            history.replaceState(null, '', location.pathname);
            this.showWelcomeScreen(true);
        }
        this.renderWelcomeCards();
        this.showToast('Presentation deleted.');
    }

    // ── Slide Management ───────────────────────────────────────
    addSlide(afterIdx = null) {
        if (!this.pres) return;
        this.pushHistory();
        const slide = makeSlide();
        const insertAt = afterIdx !== null ? afterIdx + 1 : this.pres.slides.length;
        this.pres.slides.splice(insertAt, 0, slide);
        this.slideIdx = insertAt;
        this.selectedId = null;
        this.renderSlideList();
        this.renderCanvas();
        this.updateStatusBar();
        this.scheduleSave();
    }

    duplicateSlide(idx = null) {
        if (!this.pres) return;
        this.pushHistory();
        const src = this.pres.slides[idx !== null ? idx : this.slideIdx];
        if (!src) return;
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = uid();
        copy.elements = copy.elements.map(el => ({ ...el, id: uid() }));
        const insertAt = (idx !== null ? idx : this.slideIdx) + 1;
        this.pres.slides.splice(insertAt, 0, copy);
        this.slideIdx = insertAt;
        this.selectedId = null;
        this.renderSlideList();
        this.renderCanvas();
        this.updateStatusBar();
        this.scheduleSave();
    }

    deleteSlide(idx = null) {
        if (!this.pres || this.pres.slides.length <= 1) {
            this.showToast('A presentation must have at least one slide.'); return;
        }
        this.pushHistory();
        const target = idx !== null ? idx : this.slideIdx;
        this.pres.slides.splice(target, 1);
        this.slideIdx = clamp(target, 0, this.pres.slides.length - 1);
        this.selectedId = null;
        this.renderSlideList();
        this.renderCanvas();
        this.updateStatusBar();
        this.scheduleSave();
        // No confirmation modal — slide deletion is undoable via Ctrl+Z / undo button.
        this.showToast('Slide deleted.');
    }

    selectSlide(idx) {
        if (!this.pres || idx === this.slideIdx) return;
        // Save current presenter notes before switching
        this._savePresenterNotes();
        // Persist any in-progress drawing on the outgoing slide before
        // switching — otherwise the strokes would be lost.
        if (this._isDrawMode) this._persistDrawing();
        this.deselectElement();
        this.exitTextEditing();
        this.slideIdx = clamp(idx, 0, this.pres.slides.length - 1);
        this.renderCanvas();
        this.updateRibbonState();
        this.updateStatusBar();
        this._loadPresenterNotes();
        // Restore the incoming slide's drawing onto the canvas. If draw
        // mode is off, the canvas is hidden so this is a no-op visually
        // but prepares the canvas for when the user toggles draw mode on.
        this._restoreDrawing();
        // Update thumbnail active state
        document.querySelectorAll('.slide-thumb-item').forEach((el, i) => {
            el.classList.toggle('active', i === this.slideIdx);
        });
        // Scroll thumbnail into view
        const thumb = document.querySelectorAll('.slide-thumb-item')[this.slideIdx];
        if (thumb) thumb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    _savePresenterNotes() {
        const ta = document.getElementById('presenterNotesInput');
        if (!ta || !this.currentSlide) return;
        this.currentSlide.notes = ta.value || '';
    }

    _loadPresenterNotes() {
        const ta = document.getElementById('presenterNotesInput');
        if (!ta || !this.currentSlide) return;
        ta.value = this.currentSlide.notes || '';
    }

    setupPresenterNotes() {
        const ta = document.getElementById('presenterNotesInput');
        if (!ta) return;
        ta.addEventListener('input', () => {
            if (this.currentSlide) {
                this.currentSlide.notes = ta.value;
                this.scheduleSave();
            }
        });
    }

    get currentSlide() {
        return this.pres ? this.pres.slides[this.slideIdx] : null;
    }

    // ── Element Management ─────────────────────────────────────
    addElement(el) {
        if (!this.currentSlide) return;
        this.pushHistory();
        // Ensure unique z-index on top
        const maxZ = this.currentSlide.elements.reduce((m, e) => Math.max(m, e.z || 1), 0);
        el.z = maxZ + 1;
        this.currentSlide.elements.push(el);
        this.renderCanvas();
        this.selectElement(el.id);
        this.scheduleSave();
        return el;
    }

    /** Remove selection visuals (class + handles) from a DOM element by id. */
    _removeSelectionFromDOM(id) {
        if (!id) return;
        const domEl = document.getElementById(`el-${id}`);
        if (!domEl) return;
        domEl.classList.remove('selected');
        const handles = domEl.querySelector('.el-handles');
        if (handles) handles.remove();
    }

    /** Add selection visuals (class + handles) to a DOM element by id. */
    _addSelectionToDOM(id) {
        if (!id) return;
        const el = this.getElement(id);
        const domEl = document.getElementById(`el-${id}`);
        if (!el || !domEl) return;
        domEl.classList.add('selected');
        this.appendHandles(domEl, el);
    }

    selectElement(id) {
        if (this.editingId && this.editingId !== id) this.exitTextEditing();
        // Avoid full re-render if already selected (prevents text-edit dblclick from being interrupted)
        if (this.selectedId === id) {
            this.updateRibbonState();
            this.updateStatusBar();
            return;
        }
        // Surgically update selection in the DOM instead of re-rendering the
        // entire canvas.  A full renderCanvas() destroys and recreates every
        // element — including audio/video players — which causes a visible
        // "blink" on media elements.  By only toggling the .selected class
        // and the resize/rotate handles, the DOM is preserved.
        const prevId = this.selectedId;
        this.selectedId = id;
        this._removeSelectionFromDOM(prevId);
        this._addSelectionToDOM(id);
        this.updateRibbonState();
        this.updateStatusBar();
    }

    deselectElement() {
        if (this.editingId) this.exitTextEditing();
        const prevId = this.selectedId;
        this.selectedId = null;
        this._removeSelectionFromDOM(prevId);
        this.updateRibbonState();
        this.updateStatusBar();
    }

    deleteElement(id = null) {
        if (!this.currentSlide) return;
        const target = id || this.selectedId;
        if (!target) return;
        this.pushHistory();
        this.currentSlide.elements = this.currentSlide.elements.filter(e => e.id !== target);
        if (this.selectedId === target) this.selectedId = null;
        if (this.editingId === target) this.editingId = null;
        this.renderCanvas();
        this.updateRibbonState();
        this.updateStatusBar();
        this.scheduleSave();
    }

    duplicateElement(id = null) {
        const target = id || this.selectedId;
        if (!target || !this.currentSlide) return;
        const src = this.currentSlide.elements.find(e => e.id === target);
        if (!src) return;
        this.pushHistory();
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = uid();
        copy.x += 24; copy.y += 24;
        const maxZ = this.currentSlide.elements.reduce((m, e) => Math.max(m, e.z || 1), 0);
        copy.z = maxZ + 1;
        this.currentSlide.elements.push(copy);
        this.renderCanvas();
        this.selectElement(copy.id);
        this.scheduleSave();
    }

    getElement(id) {
        return this.currentSlide?.elements.find(e => e.id === id) || null;
    }

    updateElement(id, changes, noHistory = false) {
        const el = this.getElement(id);
        if (!el) return;
        if (!noHistory) this.pushHistory();
        Object.assign(el, changes);
        this.renderElementDOM(id);
        this.scheduleSave();
    }

    bringToFront() {
        if (!this.selectedId || !this.currentSlide) return;
        const maxZ = this.currentSlide.elements.reduce((m, e) => Math.max(m, e.z || 1), 0);
        this.updateElement(this.selectedId, { z: maxZ + 1 });
        this.reZIndex();
    }

    sendToBack() {
        if (!this.selectedId || !this.currentSlide) return;
        const minZ = this.currentSlide.elements.reduce((m, e) => Math.min(m, e.z || 1), 999);
        this.updateElement(this.selectedId, { z: Math.max(0, minZ - 1) });
        this.reZIndex();
    }

    reZIndex() {
        // Normalize z indices
        if (!this.currentSlide) return;
        const sorted = [...this.currentSlide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
        sorted.forEach((el, i) => { el.z = i + 1; });
        this.renderCanvas();
    }

    // ── Text Editing ───────────────────────────────────────────
    enterTextEditing(id) {
        const el = this.getElement(id);
        if (!el || el.type !== 'text') return;
        this.editingId = id;
        const domEl = document.getElementById(`el-${id}`);
        if (!domEl) return;
        domEl.classList.add('editing');
        domEl.classList.remove('selected');
        const content = domEl.querySelector('.text-content');
        if (content) {
            content.contentEditable = 'true';
            content.focus();
            // Place cursor at end
            const range = document.createRange();
            range.selectNodeContents(content);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
        this.updateRibbonState();
    }

    exitTextEditing() {
        if (!this.editingId) return;
        const domEl = document.getElementById(`el-${this.editingId}`);
        if (domEl) {
            domEl.classList.remove('editing');
            const content = domEl.querySelector('.text-content');
            if (content) {
                content.contentEditable = 'false';
                // Save HTML
                const el = this.getElement(this.editingId);
                if (el) {
                    // Clean up empty list tags before saving
                    this._cleanupEmptyLists(content, el);
                    el.html = content.innerHTML;
                    this.scheduleSave();
                }
            }
        }
        this.editingId = null;
        this.savedSelection = null;
        if (this.selectedId) {
            const domEl2 = document.getElementById(`el-${this.selectedId}`);
            if (domEl2) domEl2.classList.add('selected');
        }
        this.updateRibbonState();
        this.updateThumbnail(this.slideIdx);
    }

    // Save the current selection range (called on blur of contentEditable)
    saveSelection() {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            this.savedSelection = selection.getRangeAt(0).cloneRange();
        }
    }

    // Restore a previously saved selection range (called before execCommand)
    restoreSelection(contentEl) {
        if (!contentEl) return;
        if (this.savedSelection) {
            // Guard against detached ranges
            const sc = this.savedSelection.startContainer;
            const ec = this.savedSelection.endContainer;
            if (sc && ec && contentEl.contains(sc) && contentEl.contains(ec)) {
                contentEl.focus();
                const selection = window.getSelection();
                selection.removeAllRanges();
                try {
                    selection.addRange(this.savedSelection.cloneRange());
                    return;
                } catch (e) {
                    // Fall through to default focus
                }
            }
        }
        // No valid saved selection — just focus and place cursor at end
        contentEl.focus();
        try {
            const range = document.createRange();
            range.selectNodeContents(contentEl);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) {
            // Silently ignore
        }
    }

    // Clean up empty list tags (e.g. <ul></ul> or <ol></ol> with no <li> children)
    // and sync el.listType with the actual DOM state
    _cleanupEmptyLists(contentEl, el) {
        if (!contentEl || !el) return;
        // Remove empty <ul> and <ol> elements (those with no <li> children)
        let changed = false;
        contentEl.querySelectorAll('ul, ol').forEach(list => {
            const lis = list.querySelectorAll('li');
            const hasText = Array.from(lis).some(li => li.textContent.trim() !== '');
            if (lis.length === 0 || !hasText) {
                // Remove the empty list, preserve any remaining text nodes
                while (list.firstChild) {
                    list.parentNode.insertBefore(list.firstChild, list);
                }
                list.remove();
                changed = true;
            }
        });
        // Sync listType
        const hasUl = !!contentEl.querySelector('ul');
        const hasOl = !!contentEl.querySelector('ol');
        if (hasOl) el.listType = 'ol';
        else if (hasUl) el.listType = 'ul';
        else el.listType = '';
        return changed;
    }

    // Check if a DOM element contains a real (non-empty) list of the given type
    _hasRealList(contentEl, type) {
        if (!contentEl) return false;
        const lists = contentEl.querySelectorAll(type);
        if (lists.length === 0) return false;
        // At least one list must have a non-empty <li>
        return Array.from(lists).some(list => {
            const lis = list.querySelectorAll('li');
            return Array.from(lis).some(li => li.textContent.trim() !== '');
        });
    }

    // ── Custom Media Player Wiring ─────────────────────────────

    _fmtTime(sec) {
        if (!sec || !isFinite(sec)) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    _wireVideoPlayer(player, vid, ui) {
        const { bigPlay, playBtn, timeEl, progWrap, progBar, bufferBar, volBtn, volSlider, fsBtn } = ui;

        const PAUSE_SVG = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
        const PLAY_SVG = '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        const VOL_ON_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        const VOL_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

        // Track whether a drag happened so we can suppress click-to-play
        // after the user finishes dragging the element across the canvas.
        let didDrag = false;

        function togglePlay() {
            if (vid.paused) { vid.play(); } else { vid.pause(); }
        }
        function updateState() {
            const paused = vid.paused;
            player.classList.toggle('paused', paused);
            playBtn.innerHTML = paused ? PAUSE_SVG : PLAY_SVG;
            bigPlay.innerHTML = paused ? PAUSE_SVG : PLAY_SVG;
        }
        function updateTime() {
            const cur = vid.currentTime || 0;
            const dur = vid.duration || 0;
            timeEl.textContent = `${this._fmtTime(cur)} / ${this._fmtTime(dur)}`;
            if (dur > 0) {
                progBar.style.width = (cur / dur * 100) + '%';
            }
        }
        function updateBuffer() {
            if (vid.buffered.length > 0 && vid.duration > 0) {
                const end = vid.buffered.end(vid.buffered.length - 1);
                bufferBar.style.width = (end / vid.duration * 100) + '%';
            }
        }

        // Click on video to toggle — but only if the user didn't just
        // finish a drag. A mousedown→mousemove→mouseup sequence that
        // moved the element should NOT also toggle play/pause.
        vid.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });
        bigPlay.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });
        playBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });

        vid.addEventListener('play', updateState);
        vid.addEventListener('pause', updateState);
        vid.addEventListener('ended', updateState);
        vid.addEventListener('timeupdate', updateTime.bind(this));
        vid.addEventListener('loadedmetadata', () => { updateTime.call(this); updateBuffer(); });
        vid.addEventListener('progress', updateBuffer);

        // Seek
        progWrap.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = progWrap.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            if (vid.duration) vid.currentTime = pct * vid.duration;
        });

        // Volume
        volSlider.addEventListener('input', (e) => {
            e.stopPropagation();
            vid.volume = parseFloat(volSlider.value);
            vid.muted = vid.volume === 0;
            volBtn.innerHTML = vid.muted || vid.volume === 0 ? VOL_OFF_SVG : VOL_ON_SVG;
        });
        volBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vid.muted = !vid.muted;
            volBtn.innerHTML = vid.muted ? VOL_OFF_SVG : VOL_ON_SVG;
            volSlider.value = vid.muted ? '0' : String(vid.volume);
        });

        // Fullscreen
        const FS_ENTER_SVG = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
        const FS_EXIT_SVG = '<svg viewBox="0 0 24 24"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';
        fsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            } else if (player.requestFullscreen) {
                player.requestFullscreen();
            } else if (player.webkitRequestFullscreen) {
                player.webkitRequestFullscreen();
            }
        });
        // Update icon on fullscreen change
        const updateFsIcon = () => {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
            fsBtn.innerHTML = isFs ? FS_EXIT_SVG : FS_ENTER_SVG;
            fsBtn.title = isFs ? 'Exit Fullscreen' : 'Fullscreen';
        };
        document.addEventListener('fullscreenchange', updateFsIcon);
        document.addEventListener('webkitfullscreenchange', updateFsIcon);

        // Prevent drag when interacting with specific controls (buttons,
        // sliders, progress bar), but allow dragging from empty/padding
        // areas of the controls bar so the user can reposition the
        // element by grabbing the bottom part of the player.
        const controls = player.querySelector('.vid-controls');
        if (controls) {
            controls.querySelectorAll('button, input, .vid-progress-wrap').forEach(el => {
                el.addEventListener('mousedown', (e) => e.stopPropagation());
            });
        }
        // Also prevent the big center play button from starting a drag
        const bigPlayEl = player.querySelector('.vid-big-play');
        if (bigPlayEl) bigPlayEl.addEventListener('mousedown', (e) => e.stopPropagation());

        // Expose didDrag flag so the parent element's drag logic can
        // set it when a real drag occurs.
        player._setDidDrag = () => { didDrag = true; };
        player._resetDidDrag = () => { didDrag = false; };
    }

    _wireAudioPlayer(player, aud, ui) {
        const { playBtn, timeEl, progWrap, progBar, volBtn, volSlider } = ui;

        const PLAY_SVG = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
        const PAUSE_SVG = '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        const VOL_ON_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        const VOL_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

        // Track whether a drag happened so we can suppress click-to-play
        // after the user finishes dragging the element across the canvas.
        let didDrag = false;

        function togglePlay() {
            if (aud.paused) { aud.play(); } else { aud.pause(); }
        }
        function updateState() {
            const playing = !aud.paused;
            player.classList.toggle('playing', playing);
            playBtn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
        }
        function updateTime() {
            const cur = aud.currentTime || 0;
            const dur = aud.duration || 0;
            timeEl.textContent = dur > 0 ? `${this._fmtTime(cur)} / ${this._fmtTime(dur)}` : this._fmtTime(cur);
            if (dur > 0) {
                progBar.style.width = (cur / dur * 100) + '%';
            }
        }

        // Only toggle play on click if the user didn't just finish a drag
        playBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });
        aud.addEventListener('play', updateState);
        aud.addEventListener('pause', updateState);
        aud.addEventListener('ended', updateState);
        aud.addEventListener('timeupdate', updateTime.bind(this));
        aud.addEventListener('loadedmetadata', () => updateTime.call(this));

        // Seek
        progWrap.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = progWrap.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            if (aud.duration) aud.currentTime = pct * aud.duration;
        });

        // Volume
        volSlider.addEventListener('input', (e) => {
            e.stopPropagation();
            aud.volume = parseFloat(volSlider.value);
            aud.muted = aud.volume === 0;
            volBtn.innerHTML = aud.muted || aud.volume === 0 ? VOL_OFF_SVG : VOL_ON_SVG;
        });
        volBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            aud.muted = !aud.muted;
            volBtn.innerHTML = aud.muted ? VOL_OFF_SVG : VOL_ON_SVG;
            volSlider.value = aud.muted ? '0' : String(aud.volume);
        });

        // Prevent drag when interacting with specific controls (buttons,
        // sliders, progress bar), but allow dragging from empty/padding
        // areas of the controls bar so the user can reposition the
        // element by grabbing the bottom part of the player.
        const audCtrl = player.querySelector('.aud-controls');
        if (audCtrl) {
            audCtrl.querySelectorAll('button, input, .aud-progress-wrap').forEach(el => {
                el.addEventListener('mousedown', (e) => e.stopPropagation());
            });
        }

        // Click on art area toggles play — but only if the user didn't
        // just finish a drag across the canvas.
        const audArt = player.querySelector('.aud-art');
        if (audArt) audArt.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });

        // Expose didDrag flag so the parent element's drag logic can
        // set it when a real drag occurs.
        player._setDidDrag = () => { didDrag = true; };
        player._resetDidDrag = () => { didDrag = false; };
    }

    applyTextFormat(cmd, value = null) {
        // Apply format to selected text within editing element, or all text in selected element
        if (!this.selectedId && !this.editingId) return;
        const targetId = this.editingId || this.selectedId;
        const el = this.getElement(targetId);
        if (!el || el.type !== 'text') return;

        const domEl = document.getElementById(`el-${targetId}`);
        const content = domEl?.querySelector('.text-content');

        // When editing a text element, always use the inline (execCommand) path —
        // even if focus temporarily moved to a toolbar button on click.
        // Checking content.contains(document.activeElement) breaks when the user
        // clicks a ribbon button because focus shifts to the button.
        if (this.editingId && content) {
            // Ensure the contentEditable has focus so execCommand works.
            // Focus may have moved to a toolbar button on click — restore saved selection.
            if (!content.contains(document.activeElement)) {
                this.restoreSelection(content);
            }
            // For textAlign, execCommand uses different command names (justifyLeft, justifyCenter, justifyRight)
            if (cmd === 'textAlign') {
                const execCmd = value === 'left' ? 'justifyLeft' : value === 'center' ? 'justifyCenter' : 'justifyRight';
                document.execCommand(execCmd, false, null);
                el.textAlign = value;
            } else if (cmd === 'insertUnorderedList' || cmd === 'insertOrderedList') {
                // List commands — toggle list format via execCommand
                const listTag = cmd === 'insertUnorderedList' ? 'ul' : 'ol';
                // Check state BEFORE execCommand — was the list already active?
                const wasActive = this._hasRealList(content, listTag);
                if (!wasActive) {
                    // We're about to turn ON the list — first clean up any empty/stale
                    // list tags that could confuse execCommand
                    this._cleanupEmptyLists(content, el);
                }
                document.execCommand(cmd, false, null);
                if (wasActive) {
                    // User toggled OFF — clean up any leftover empty list tags
                    this._cleanupEmptyLists(content, el);
                } else {
                    // User toggled ON — just sync listType (don't cleanup, new list may be empty)
                    const hasUl = !!content.querySelector('ul');
                    const hasOl = !!content.querySelector('ol');
                    if (hasOl) el.listType = 'ol';
                    else if (hasUl) el.listType = 'ul';
                    else el.listType = '';
                }
            } else {
                document.execCommand(cmd, false, value);
            }
            el.html = content.innerHTML;
        } else {
            // Apply to whole element style
            switch (cmd) {
                case 'bold':      this.updateElement(targetId, { bold: !el.bold }); break;
                case 'italic':    this.updateElement(targetId, { italic: !el.italic }); break;
                case 'underline': this.updateElement(targetId, { underline: !el.underline }); break;
                case 'fontFamily': this.updateElement(targetId, { fontFamily: value }); break;
                case 'fontSize':  this.updateElement(targetId, { fontSize: parseInt(value) }); break;
                case 'color':     this.updateElement(targetId, { color: value }); break;
                case 'highlight': this.updateElement(targetId, { highlight: value === 'transparent' ? '' : value }); break;
                case 'textAlign': this.updateElement(targetId, { textAlign: value }); break;
                case 'insertUnorderedList':
                case 'insertOrderedList': {
                    // Toggle list type on the element
                    const listTag = cmd === 'insertUnorderedList' ? 'ul' : 'ol';
                    const currentList = el.listType || '';
                    let newHtml = el.html || '';

                    // Check if the HTML actually contains a real list (not stale listType)
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = newHtml;
                    const actualHasList = !!tempDiv.querySelector(listTag);
                    const hasActualLis = Array.from(tempDiv.querySelectorAll(`${listTag} li`)).some(li => li.textContent.trim() !== '');

                    if (currentList === listTag && actualHasList && hasActualLis) {
                        // Toggle off — strip the list tags, keep <li> content as plain text
                        newHtml = newHtml.replace(/<\/?ul>/gi, '').replace(/<\/?ol>/gi, '').replace(/<li>/gi, '<div>').replace(/<\/li>/gi, '</div>');
                        this.updateElement(targetId, { listType: '', html: newHtml });
                    } else if (currentList === listTag && (!actualHasList || !hasActualLis)) {
                        // listType was stale — list doesn't actually exist, so turn it on fresh
                        newHtml = newHtml.replace(/<\/?ul>/gi, '').replace(/<\/?ol>/gi, '').replace(/<li>/gi, '<div>').replace(/<\/li>/gi, '</div>');
                        // Ensure there's at least one list item
                        const parts = newHtml.split(/<\/div>|<br\s*\/?>/i).filter(p => p.trim());
                        if (parts.length === 0) {
                            newHtml = `<${listTag}><li>&nbsp;</li></${listTag}>`;
                        } else {
                            const listItems = parts.map(p => {
                                const text = p.replace(/<div>/gi, '').trim();
                                return `<li>${text || '&nbsp;'}</li>`;
                            }).join('');
                            newHtml = `<${listTag}>${listItems}</${listTag}>`;
                        }
                        this.updateElement(targetId, { listType: listTag, html: newHtml });
                    } else {
                        // Toggle on — wrap content in list
                        // First strip any existing list tags
                        newHtml = newHtml.replace(/<\/?ul>/gi, '').replace(/<\/?ol>/gi, '').replace(/<li>/gi, '<div>').replace(/<\/li>/gi, '</div>');
                        // Split by divs or line breaks and wrap in list items
                        const parts = newHtml.split(/<\/div>|<br\s*\/?>/i).filter(p => p.trim());
                        if (parts.length === 0) {
                            newHtml = `<${listTag}><li>&nbsp;</li></${listTag}>`;
                        } else {
                            const listItems = parts.map(p => {
                                const text = p.replace(/<div>/gi, '').trim();
                                return `<li>${text || '&nbsp;'}</li>`;
                            }).join('');
                            newHtml = `<${listTag}>${listItems}</${listTag}>`;
                        }
                        this.updateElement(targetId, { listType: listTag, html: newHtml });
                    }
                    break;
                }
            }
        }
        this.scheduleSave();
        this.updateRibbonState();
    }

    // ── Canvas Rendering ───────────────────────────────────────
    renderCanvas() {
        const canvas = document.getElementById('slideCanvas');
        if (!canvas) return;

        // Clear
        canvas.innerHTML = '';

        const slide = this.currentSlide;
        if (!slide) return;

        // Background
        const bg = slide.background;
        // Reset all background properties first so switching from image → color doesn't leave residual image
        canvas.style.backgroundImage = '';
        canvas.style.backgroundSize = '';
        canvas.style.backgroundPosition = '';
        if (bg.type === 'color' || bg.type === 'gradient') {
            canvas.style.background = bg.value;
        } else if (bg.type === 'image') {
            canvas.style.background = '#ffffff';
            canvas.style.backgroundImage = `url(${bg.value})`;
            canvas.style.backgroundSize = 'cover';
            canvas.style.backgroundPosition = 'center';
        } else {
            canvas.style.background = '#ffffff';
        }

        // Sort elements by z
        const sorted = [...slide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));

        sorted.forEach(el => {
            const domEl = this.createElementDOM(el);
            canvas.appendChild(domEl);
        });

        this.updateScalerSize();
        this.updateThumbnail(this.slideIdx);
    }

    createElementDOM(el) {
        const div = document.createElement('div');
        div.id = `el-${el.id}`;
        div.className = `slide-el slide-el-${el.type}`;
        div.style.cssText = `
            left:${el.x}px; top:${el.y}px;
            width:${el.w}px; height:${el.h}px;
            transform:rotate(${el.r || 0}deg);
            z-index:${el.z || 1};
            opacity:${el.opacity !== undefined ? el.opacity : 1};
        `;

        if (el.type === 'text') {
            div.style.fontFamily = el.fontFamily || 'DM Sans';
            div.style.fontSize = (el.fontSize || 24) + 'px';
            div.style.color = el.color || '#1a1a1a';
            div.style.textAlign = el.textAlign || 'left';
            div.style.fontWeight = el.bold ? '700' : '400';
            div.style.fontStyle = el.italic ? 'italic' : 'normal';
            div.style.textDecoration = el.underline ? 'underline' : 'none';
            div.style.backgroundColor = el.highlight || 'transparent';
            const content = document.createElement('div');
            content.className = 'text-content';
            content.contentEditable = 'false';
            content.setAttribute('data-placeholder', 'Click to edit text');
            content.style.cssText = 'width:100%;height:100%;outline:none;word-break:break-word;white-space:pre-wrap;';
            content.innerHTML = el.html || '';
            // Listen for input to save
            content.addEventListener('input', () => {
                el.html = content.innerHTML;
                // Sync listType from actual DOM content — only count real (non-empty) lists
                const hasRealUl = this._hasRealList(content, 'ul');
                const hasRealOl = this._hasRealList(content, 'ol');
                if (el.listType === 'ul' && !hasRealUl) el.listType = '';
                if (el.listType === 'ol' && !hasRealOl) el.listType = '';
                if (!el.listType && hasRealOl) el.listType = 'ol';
                else if (!el.listType && hasRealUl) el.listType = 'ul';
                this.scheduleSave();
                this.updateThumbnail(this.slideIdx);
                this.updateRibbonState();
            });
            // Save selection on blur so toolbar buttons can restore it before execCommand
            content.addEventListener('blur', () => this.saveSelection());
            div.appendChild(content);
        } else if (el.type === 'shape') {
            // Icon / chart shapes carry their own pre-rendered SVG markup
            if (el.shape === 'icon' || el.shape === 'chart') {
                div.innerHTML = el.svg || '';
            } else {
                div.innerHTML = shapeSVG(el.shape, el.fill, el.stroke, el.strokeWidth);
            }
        } else if (el.type === 'image') {
            const imgWrap = document.createElement('div');
            imgWrap.className = 'slide-el-image-wrap';
            imgWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:inherit;';
            const img = document.createElement('img');
            img.src = el.src;
            img.draggable = false;
            img.alt = el.alt || '';
            // Apply crop if any
            const crop = el.crop || { l: 0, t: 0, r: 0, b: 0 };
            const visibleW = 1 - crop.l - crop.r;
            const visibleH = 1 - crop.t - crop.b;
            if (visibleW <= 0 || visibleH <= 0) {
                // Invalid crop, reset
                img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;object-fit:contain;';
            } else if (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) {
                const scaleW = 1 / visibleW;
                const scaleH = 1 / visibleH;
                img.style.cssText = `position:absolute;top:0;left:0;width:${scaleW * 100}%;height:${scaleH * 100}%;transform:translate(${-crop.l * scaleW * 100}%, ${-crop.t * scaleH * 100}%);object-fit:fill;display:block;pointer-events:none;`;
            } else {
                img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;object-fit:contain;';
            }
            imgWrap.appendChild(img);
            div.appendChild(imgWrap);
        } else if (el.type === 'video') {
            const player = document.createElement('div');
            player.className = 'slide-video-player paused';
            // Hidden <video> element (no native controls)
            const vid = document.createElement('video');
            vid.src = el.src;
            vid.preload = 'metadata';
            vid.setAttribute('poster', el.poster || '');
            vid.setAttribute('playsinline', '');
            // Big center play button
            const bigPlay = document.createElement('div');
            bigPlay.className = 'vid-big-play';
            bigPlay.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
            // Controls bar
            const controls = document.createElement('div');
            controls.className = 'vid-controls';
            // Progress bar
            const progWrap = document.createElement('div');
            progWrap.className = 'vid-progress-wrap';
            const bufferBar = document.createElement('div');
            bufferBar.className = 'vid-buffer-bar';
            const progBar = document.createElement('div');
            progBar.className = 'vid-progress-bar';
            progWrap.appendChild(bufferBar);
            progWrap.appendChild(progBar);
            // Button row
            const btns = document.createElement('div');
            btns.className = 'vid-btns';
            const playBtn = document.createElement('button');
            playBtn.className = 'vid-btn';
            playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
            playBtn.title = 'Play';
            const timeEl = document.createElement('span');
            timeEl.className = 'vid-time';
            timeEl.textContent = '0:00 / 0:00';
            const spacer = document.createElement('div');
            spacer.className = 'vid-spacer';
            // Volume
            const volWrap = document.createElement('div');
            volWrap.className = 'vid-vol-wrap';
            const volBtn = document.createElement('button');
            volBtn.className = 'vid-btn';
            volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
            volBtn.title = 'Volume';
            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.className = 'vid-vol-slider';
            volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
            volWrap.appendChild(volBtn);
            volWrap.appendChild(volSlider);
            // Fullscreen
            const fsBtn = document.createElement('button');
            fsBtn.className = 'vid-btn';
            fsBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
            fsBtn.title = 'Fullscreen';
            btns.appendChild(playBtn);
            btns.appendChild(timeEl);
            btns.appendChild(spacer);
            btns.appendChild(volWrap);
            btns.appendChild(fsBtn);
            controls.appendChild(progWrap);
            controls.appendChild(btns);
            player.appendChild(vid);
            player.appendChild(bigPlay);
            player.appendChild(controls);
            div.appendChild(player);
            // Wire up player logic
            this._wireVideoPlayer(player, vid, { bigPlay, playBtn, timeEl, progWrap, progBar, bufferBar, volBtn, volSlider, fsBtn });
        } else if (el.type === 'audio') {
            const player = document.createElement('div');
            player.className = 'slide-audio-player';
            // Art area with wave animation only
            const art = document.createElement('div');
            art.className = 'aud-art';
            const wave = document.createElement('div');
            wave.className = 'aud-wave';
            for (let i = 0; i < 5; i++) wave.appendChild(document.createElement('span'));
            art.appendChild(wave);
            // Controls
            const audCtrl = document.createElement('div');
            audCtrl.className = 'aud-controls';
            // Progress
            const progWrap = document.createElement('div');
            progWrap.className = 'aud-progress-wrap';
            const progBar = document.createElement('div');
            progBar.className = 'aud-progress-bar';
            progWrap.appendChild(progBar);
            // Buttons
            const btns = document.createElement('div');
            btns.className = 'aud-btns';
            const playBtn = document.createElement('button');
            playBtn.className = 'aud-play-btn';
            playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
            playBtn.title = 'Play';
            const timeEl = document.createElement('span');
            timeEl.className = 'aud-time';
            timeEl.textContent = '0:00';
            const spacer = document.createElement('div');
            spacer.className = 'aud-spacer';
            // Volume
            const volWrap = document.createElement('div');
            volWrap.className = 'aud-vol-wrap';
            const volBtn = document.createElement('button');
            volBtn.className = 'aud-btn';
            volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
            volBtn.title = 'Volume';
            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.className = 'aud-vol-slider';
            volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
            volWrap.appendChild(volBtn);
            volWrap.appendChild(volSlider);
            btns.appendChild(playBtn);
            btns.appendChild(timeEl);
            btns.appendChild(spacer);
            btns.appendChild(volWrap);
            audCtrl.appendChild(progWrap);
            audCtrl.appendChild(btns);
            // Hidden audio element
            const aud = document.createElement('audio');
            aud.src = el.src;
            aud.preload = 'metadata';
            player.appendChild(art);
            player.appendChild(audCtrl);
            player.appendChild(aud);
            div.appendChild(player);
            // Wire up audio player logic
            this._wireAudioPlayer(player, aud, { playBtn, timeEl, progWrap, progBar, volBtn, volSlider });
        }

        // Event: mousedown for select/drag
        div.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            // If already editing this text element, let the browser handle caret placement
            if (this.editingId === el.id && el.type === 'text') return;
            if (this.editingId && this.editingId !== el.id) this.exitTextEditing();
            const wasSelected = this.selectedId === el.id;
            this.selectElement(el.id);
            // For text: if already selected, single click also enters edit mode (PowerPoint-like)
            if (el.type === 'text' && wasSelected) {
                this.enterTextEditing(el.id);
                return;
            }
            this.startDrag(e, el.id, 'move');
        });

        // Double-click to enter text edit
        if (el.type === 'text') {
            div.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.enterTextEditing(el.id);
            });
        }

        // Selection indicator
        if (this.selectedId === el.id) {
            div.classList.add('selected');
            this.appendHandles(div, el);
        }
        if (this.editingId === el.id) {
            div.classList.add('editing');
            div.classList.remove('selected');
            const c = div.querySelector('.text-content');
            if (c) c.contentEditable = 'true';
        }

        return div;
    }

    renderElementDOM(id) {
        const el = this.getElement(id);
        const domEl = document.getElementById(`el-${id}`);
        if (!el || !domEl) { this.renderCanvas(); return; }

        domEl.style.left = el.x + 'px';
        domEl.style.top = el.y + 'px';
        domEl.style.width = el.w + 'px';
        domEl.style.height = el.h + 'px';
        domEl.style.transform = `rotate(${el.r || 0}deg)`;
        domEl.style.zIndex = el.z || 1;
        domEl.style.opacity = el.opacity !== undefined ? el.opacity : 1;

        if (el.type === 'text') {
            domEl.style.fontFamily = el.fontFamily || 'DM Sans';
            domEl.style.fontSize = (el.fontSize || 24) + 'px';
            domEl.style.color = el.color || '#1a1a1a';
            domEl.style.textAlign = el.textAlign || 'left';
            domEl.style.fontWeight = el.bold ? '700' : '400';
            domEl.style.fontStyle = el.italic ? 'italic' : 'normal';
            domEl.style.textDecoration = el.underline ? 'underline' : 'none';
            domEl.style.backgroundColor = el.highlight || 'transparent';
            const c = domEl.querySelector('.text-content');
            if (c && this.editingId !== id) c.innerHTML = el.html || '';
        } else if (el.type === 'shape') {
            domEl.innerHTML = shapeSVG(el.shape, el.fill, el.stroke, el.strokeWidth);
        } else if (el.type === 'image') {
            // Re-render image with current crop
            const crop = el.crop || { l: 0, t: 0, r: 0, b: 0 };
            const visibleW = 1 - crop.l - crop.r;
            const visibleH = 1 - crop.t - crop.b;
            domEl.innerHTML = '';
            // Use an inner wrapper for overflow clipping so handles on the outer domEl are not clipped
            const imgWrap = document.createElement('div');
            imgWrap.className = 'slide-el-image-wrap';
            imgWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:inherit;';
            const img = document.createElement('img');
            img.src = el.src;
            img.draggable = false;
            img.alt = '';
            if (visibleW <= 0 || visibleH <= 0) {
                img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;object-fit:contain;';
            } else if (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) {
                const scaleW = 1 / visibleW;
                const scaleH = 1 / visibleH;
                img.style.cssText = `position:absolute;top:0;left:0;width:${scaleW * 100}%;height:${scaleH * 100}%;transform:translate(${-crop.l * scaleW * 100}%, ${-crop.t * scaleH * 100}%);object-fit:fill;display:block;pointer-events:none;`;
            } else {
                img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;object-fit:contain;';
            }
            imgWrap.appendChild(img);
            domEl.appendChild(imgWrap);
        }

        // Re-append handles if selected
        const existingHandles = domEl.querySelector('.el-handles');
        if (existingHandles) existingHandles.remove();
        if (this.selectedId === id) {
            this.appendHandles(domEl, el);
        }
    }

    appendHandles(domEl, el) {
        const wrapper = document.createElement('div');
        wrapper.className = 'el-handles';

        const positions = ['nw','n','ne','e','se','s','sw','w'];
        positions.forEach(pos => {
            const h = document.createElement('div');
            h.className = `el-handle ${pos}`;
            h.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.startDrag(e, el.id, 'resize', pos);
            });
            wrapper.appendChild(h);
        });

        // Rotate handle (skip for line shapes)
        if (el.shape !== 'line') {
            const rh = document.createElement('div');
            rh.className = 'el-rotate-handle';
            rh.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
            rh.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.startDrag(e, el.id, 'rotate');
            });
            wrapper.appendChild(rh);
        }

        domEl.appendChild(wrapper);
    }

    // ── Drag / Resize / Crop / Rotate ──────────────────────────
    // Modifier keys (PowerPoint-style):
    //   - No modifier + CORNER handle = RESIZE (proportional for images, free for shapes/text)
    //   - No modifier + SIDE handle   = STRETCH (one dimension)
    //   - SHIFT + any handle          = CROP (for images & shapes — clip the visible region)
    startDrag(e, id, type, handle = null) {
        const el = this.getElement(id);
        if (!el) return;

        this.pushHistory();
        const isCorner = handle && handle.length === 2; // nw, ne, se, sw
        const shiftHeld = e.shiftKey;
        const canCrop = el.type === 'image' || el.type === 'shape';
        const cropMode = shiftHeld && canCrop && type === 'resize';

        this._cropMode = cropMode;
        if (cropMode && !el.crop) el.crop = { l: 0, t: 0, r: 0, b: 0 };

        this.drag = {
            type, id, handle,
            startMX: e.clientX, startMY: e.clientY,
            startX: el.x, startY: el.y,
            startW: el.w, startH: el.h,
            startR: el.r || 0,
            startCrop: el.crop ? { ...el.crop } : { l: 0, t: 0, r: 0, b: 0 },
            cropMode,
            isCorner,
            shiftHeld,
            // For images: lock aspect ratio on EVERY handle resize
            // (corner AND side) so the box always matches the image
            // and the image always fills the box without letterboxing.
            aspect: (el.type === 'image' && !cropMode) ? (el.w / el.h) : null,
        };

        if (type === 'rotate') {
            // Compute center of element in screen coords
            const canvas = document.getElementById('slideCanvas');
            const rect = canvas.getBoundingClientRect();
            this.drag.cx = rect.left + (el.x + el.w / 2) * this.scale;
            this.drag.cy = rect.top + (el.y + el.h / 2) * this.scale;
            this.drag.startAngle = Math.atan2(e.clientY - this.drag.cy, e.clientX - this.drag.cx) * 180 / Math.PI;
        }

        // Add crop-mode visual class to element
        if (cropMode) {
            const domEl = document.getElementById(`el-${id}`);
            if (domEl) domEl.classList.add('crop-mode');
        }

        document.addEventListener('mousemove', this._onDragMove, { passive: false });
        document.addEventListener('mouseup', this._onDragEnd);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = cropMode ? 'crosshair' : (type === 'rotate' ? 'grabbing' : (handle ? `${handle}-resize` : 'grabbing'));
    }

    _onDragMove = (e) => {
        if (!this.drag) return;
        const el = this.getElement(this.drag.id);
        if (!el) return;

        const dx = (e.clientX - this.drag.startMX) / this.scale;
        const dy = (e.clientY - this.drag.startMY) / this.scale;

        // Flag that a real drag occurred so the media player's click
        // handlers know to suppress play/pause toggling.
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            this.drag.hasMoved = true;
            // Notify any media player inside this element
            const domEl = document.getElementById(`el-${this.drag.id}`);
            if (domEl) {
                const player = domEl.querySelector('.slide-video-player, .slide-audio-player');
                if (player && player._setDidDrag) player._setDidDrag();
            }
        }

        if (this.drag.type === 'move') {
            el.x = Math.round(this.drag.startX + dx);
            el.y = Math.round(this.drag.startY + dy);
        } else if (this.drag.type === 'rotate') {
            const angle = Math.atan2(e.clientY - this.drag.cy, e.clientX - this.drag.cx) * 180 / Math.PI;
            el.r = Math.round(this.drag.startR + (angle - this.drag.startAngle));
        } else if (this.drag.type === 'resize') {
            if (this.drag.cropMode) {
                // CROP mode: adjust crop region (l, t, r, b — each 0..0.5)
                // dx/dy is in canvas pixels. Convert to fraction of element size.
                const fx = dx / this.drag.startW;
                const fy = dy / this.drag.startH;
                const h = this.drag.handle;
                const c = { ...this.drag.startCrop };

                if (h.includes('e')) {
                    // Dragging right edge: increase right crop (clipping from right)
                    c.r = clamp(c.r + fx, 0, 0.95 - c.l);
                }
                if (h.includes('s')) {
                    c.b = clamp(c.b + fy, 0, 0.95 - c.t);
                }
                if (h.includes('w')) {
                    // Dragging left edge: increase left crop
                    c.l = clamp(c.l - fx, 0, 0.95 - c.r);
                }
                if (h.includes('n')) {
                    c.t = clamp(c.t - fy, 0, 0.95 - c.b);
                }
                el.crop = c;
            } else {
                // RESIZE / STRETCH mode
                const h = this.drag.handle;
                let { startX: x, startY: y, startW: w, startH: h2 } = this.drag;
                const isCorner = this.drag.isCorner;
                const aspect = this.drag.aspect;

                // Min size 10px (was 20) — lets users shrink images/elements smaller.
                const MIN = 10;
                if (h.includes('e')) { w = Math.max(MIN, w + dx); }
                if (h.includes('s')) { h2 = Math.max(MIN, h2 + dy); }
                if (h.includes('w')) { x = this.drag.startX + dx; w = Math.max(MIN, this.drag.startW - dx); }
                if (h.includes('n')) { y = this.drag.startY + dy; h2 = Math.max(MIN, this.drag.startH - dy); }

                // For images: preserve aspect ratio on every handle
                // (corner AND side). When the user drags a side handle,
                // the perpendicular dimension follows so the box keeps
                // the image's aspect ratio — no letterboxing, and the
                // box visually tracks the image during the stretch.
                if (aspect) {
                    // For side handles, the primary axis is the one being
                    // dragged; derive the other from aspect ratio.
                    // For corner handles, use the dominant delta as before.
                    const isSide = !isCorner;
                    if (isSide) {
                        // Side handle: the dragged axis wins, the other follows.
                        const horiz = h.includes('e') || h.includes('w'); // horizontal drag
                        if (horiz) {
                            // width changed → recompute height from aspect
                            const newH = w / aspect;
                            // Keep the opposite edge (top or bottom) fixed
                            if (h.includes('n')) y = this.drag.startY + (this.drag.startH - newH);
                            h2 = newH;
                        } else {
                            // vertical drag (n/s) → recompute width
                            const newW = h2 * aspect;
                            if (h.includes('w')) x = this.drag.startX + (this.drag.startW - newW);
                            w = newW;
                        }
                    } else {
                        // Corner handle: use the dominant delta to preserve aspect.
                        const newAspect = w / h2;
                        if (newAspect > aspect) {
                            const newH = w / aspect;
                            if (h.includes('n')) y = this.drag.startY + (this.drag.startH - newH);
                            h2 = newH;
                        } else {
                            const newW = h2 * aspect;
                            if (h.includes('w')) x = this.drag.startX + (this.drag.startW - newW);
                            w = newW;
                        }
                    }
                }

                el.x = Math.round(x); el.y = Math.round(y);
                el.w = Math.round(w); el.h = Math.round(h2);
            }
        }

        this.renderElementDOM(this.drag.id);
        this.updateThumbnail(this.slideIdx);
        this.updateStatusBar();
    };

    _onDragEnd = () => {
        document.removeEventListener('mousemove', this._onDragMove);
        document.removeEventListener('mouseup', this._onDragEnd);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        if (this.drag) {
            // Remove crop-mode visual class
            const domEl = document.getElementById(`el-${this.drag.id}`);
            if (domEl) domEl.classList.remove('crop-mode');
            // Reset the media player's didDrag flag after a short delay
            // so the pending click event sees didDrag=true and is
            // suppressed, then the flag resets for the next interaction.
            if (this.drag.hasMoved && domEl) {
                const player = domEl.querySelector('.slide-video-player, .slide-audio-player');
                if (player && player._resetDidDrag) {
                    setTimeout(() => player._resetDidDrag(), 50);
                }
            }
            this.scheduleSave();
            this.drag = null;
            this._cropMode = false;
        }
    };

    screenToCanvas(sx, sy) {
        const canvas = document.getElementById('slideCanvas');
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        return {
            x: clamp(Math.round((sx - rect.left) / this.scale), 0, 960),
            y: clamp(Math.round((sy - rect.top) / this.scale), 0, 540),
        };
    }

    // ── Canvas Scaling ─────────────────────────────────────────
    updateScalerSize() {
        const wrapper = document.getElementById('slideCanvasWrapper');
        const scaler = document.getElementById('slideCanvasScaler');
        if (!wrapper || !scaler) return;

        const availW = wrapper.clientWidth - 80;
        const availH = wrapper.clientHeight - 60;
        const scaleX = availW / 960;
        const scaleY = availH / 540;
        this.scale = Math.min(scaleX, scaleY, 1.5);

        scaler.style.width = '960px';
        scaler.style.height = '540px';
        scaler.style.transform = `scale(${this.scale})`;

        const zoomEl = document.getElementById('zoomStatus');
        if (zoomEl) zoomEl.textContent = Math.round(this.scale * 100) + '%';
    }

    setupResizeObserver() {
        const wrapper = document.getElementById('slideCanvasWrapper');
        if (!wrapper) return;
        const ro = new ResizeObserver(() => this.updateScalerSize());
        ro.observe(wrapper);
        this.updateScalerSize();
    }

    // ── Slide Thumbnails ───────────────────────────────────────
    renderSlideList() {
        const list = document.getElementById('slidesList');
        if (!list || !this.pres) return;
        list.innerHTML = '';

        this.pres.slides.forEach((slide, idx) => {
            const item = document.createElement('div');
            item.className = `slide-thumb-item${idx === this.slideIdx ? ' active' : ''}`;
            item.draggable = true;
            item.dataset.idx = idx;

            const num = document.createElement('div');
            num.className = 'slide-thumb-number';
            num.textContent = idx + 1;

            const wrap = document.createElement('div');
            wrap.className = 'slide-thumb-canvas-wrap';

            const inner = document.createElement('div');
            inner.className = 'slide-thumb-inner';
            inner.id = `thumb-inner-${slide.id}`;
            inner.style.background = slide.background.type !== 'image' ? slide.background.value : '#fff';

            this.renderThumbContent(inner, slide);
            wrap.appendChild(inner);

            item.appendChild(num);
            item.appendChild(wrap);

            // Apply thumbnail scale after layout (double-RAF for reliable clientWidth)
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const w = wrap.clientWidth || 276;
                const thumbScale = w / 960;
                inner.style.transform = `scale(${thumbScale})`;
                inner.style.transformOrigin = 'top left';
                wrap.style.height = (540 * thumbScale) + 'px';
            }));

            // Events
            item.addEventListener('click', () => this.selectSlide(idx));

            // Drag to reorder
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', idx);
                item.style.opacity = '0.5';
            });
            item.addEventListener('dragend', () => { item.style.opacity = ''; });
            item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
            item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                this.reorderSlide(fromIdx, idx);
            });

            list.appendChild(item);
        });
    }

    renderThumbContent(inner, slide) {
        inner.innerHTML = '';
        const bg = slide.background;
        if (bg.type === 'gradient') inner.style.background = bg.value;
        else inner.style.background = bg.value || '#ffffff';

        const sorted = [...slide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
        sorted.forEach(el => {
            const d = document.createElement('div');
            d.style.cssText = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;transform:rotate(${el.r || 0}deg);z-index:${el.z || 1};overflow:hidden;pointer-events:none;`;
            if (el.type === 'text') {
                d.style.fontFamily = el.fontFamily || 'DM Sans';
                d.style.fontSize = (el.fontSize || 24) + 'px';
                d.style.color = el.color || '#1a1a1a';
                d.style.fontWeight = el.bold ? '700' : '400';
                d.style.backgroundColor = el.highlight || 'transparent';
                d.style.padding = '8px 10px';
                d.style.wordBreak = 'break-word';
                d.innerHTML = el.html || '';
            } else if (el.type === 'shape') {
                d.innerHTML = shapeSVG(el.shape, el.fill, el.stroke, el.strokeWidth);
            } else if (el.type === 'image') {
                const crop = el.crop || { l: 0, t: 0, r: 0, b: 0 };
                const visibleW = 1 - crop.l - crop.r;
                const visibleH = 1 - crop.t - crop.b;
                const img = document.createElement('img');
                img.src = el.src;
                if (visibleW <= 0 || visibleH <= 0) {
                    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                } else if (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) {
                    const scaleW = 1 / visibleW;
                    const scaleH = 1 / visibleH;
                    img.style.cssText = `position:absolute;top:0;left:0;width:${scaleW * 100}%;height:${scaleH * 100}%;transform:translate(${-crop.l * scaleW * 100}%, ${-crop.t * scaleH * 100}%);object-fit:fill;display:block;`;
                } else {
                    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                }
                d.appendChild(img);
            } else if (el.type === 'video') {
                // Lightweight thumbnail placeholder matching the custom video
                // player's dark look with an orange play button overlay.
                d.style.background = '#000';
                d.style.display = 'flex';
                d.style.alignItems = 'center';
                d.style.justifyContent = 'center';
                d.style.borderRadius = '0';
                d.innerHTML = '<div style="width:24px;height:24px;border-radius:50%;background:#f97316;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3)"><svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><polygon points="6 4 20 12 6 20 6 4"/></svg></div>';
            } else if (el.type === 'audio') {
                // Compact audio thumbnail matching the custom audio player's
                // dark gradient background with wave animation and controls.
                d.style.background = 'linear-gradient(135deg, #1e1e2e 0%, #2a2a3c 100%)';
                d.style.display = 'flex';
                d.style.alignItems = 'center';
                d.style.justifyContent = 'center';
                d.style.borderRadius = '0';
                d.style.gap = '4px';
                d.style.padding = '0 8px';
                d.innerHTML = '<div style="width:14px;height:14px;border-radius:50%;background:#f97316;display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="8" height="8" viewBox="0 0 24 24" fill="#fff"><polygon points="6 4 20 12 6 20 6 4"/></svg></div><div style="display:flex;align-items:flex-end;gap:1px;height:10px"><span style="width:1.5px;height:40%;background:#f97316;border-radius:1px"></span><span style="width:1.5px;height:70%;background:#f97316;border-radius:1px"></span><span style="width:1.5px;height:100%;background:#f97316;border-radius:1px"></span><span style="width:1.5px;height:60%;background:#f97316;border-radius:1px"></span><span style="width:1.5px;height:35%;background:#f97316;border-radius:1px"></span></div>';
            }
            inner.appendChild(d);
        });
        // Render the saved drawing as an overlay so the thumbnail
        // shows the user's strokes along with the slide content.
        if (slide.drawingData) {
            const drawImg = document.createElement('img');
            drawImg.src = slide.drawingData;
            drawImg.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px;pointer-events:none;z-index:9998;display:block;';
            drawImg.alt = '';
            inner.appendChild(drawImg);
        }
    }

    updateThumbnail(idx) {
        if (!this.pres || !this.pres.slides[idx]) return;
        const slide = this.pres.slides[idx];
        const inner = document.getElementById(`thumb-inner-${slide.id}`);
        if (inner) this.renderThumbContent(inner, slide);
    }

    reorderSlide(from, to) {
        if (from === to || !this.pres) return;
        this.pushHistory();
        const [slide] = this.pres.slides.splice(from, 1);
        this.pres.slides.splice(to, 0, slide);
        if (this.slideIdx === from) this.slideIdx = to;
        else if (from < this.slideIdx && to >= this.slideIdx) this.slideIdx--;
        else if (from > this.slideIdx && to <= this.slideIdx) this.slideIdx++;
        this.renderSlideList();
        this.scheduleSave();
    }

    // ── Canvas Mouse Interaction ───────────────────────────────
    setupCanvasInteraction() {
        const wrapper = document.getElementById('slideCanvasWrapper');
        const canvas  = document.getElementById('slideCanvas');
        if (!wrapper || !canvas) return;

        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // Clicking on canvas background (not an element)
            if (e.target === canvas) {
                this.exitTextEditing();
                this.deselectElement();
            }
        });

        // Clicking canvas wrapper (outside canvas) — deselect
        wrapper.addEventListener('mousedown', (e) => {
            if (e.target === wrapper || e.target === document.getElementById('slideCanvasScaler')) {
                this.exitTextEditing();
                this.deselectElement();
            }
        });
    }

    // ── Keyboard Shortcuts ─────────────────────────────────────
    setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (!this.pres) return;

            // Don't intercept when typing in title input or other inputs
            if (['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName) &&
                document.activeElement.id !== 'slideCanvas') return;

            // Allow editing element to handle keys
            if (this.editingId) {
                if (e.key === 'Escape') { e.preventDefault(); this.exitTextEditing(); }
                return;
            }

            const ctrl = e.ctrlKey || e.metaKey;

            if (ctrl && e.key === 'z') { e.preventDefault(); this.undo(); return; }
            if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); this.redo(); return; }
            if (ctrl && e.key === 'c') { this.copyElement(); return; }
            if (ctrl && e.key === 'x') { this.cutElement(); return; }
            if (ctrl && e.key === 'v') { e.preventDefault(); this.pasteElement(); return; }
            if (ctrl && e.key === 'd') { e.preventDefault(); this.duplicateElement(); return; }
            if (ctrl && e.key === 'a') { e.preventDefault(); /* select all — future */ return; }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.selectedId) { e.preventDefault(); this.deleteElement(); }
                return;
            }
            if (e.key === 'Escape') { this.deselectElement(); return; }
            if (e.key === 'F11') { e.preventDefault(); this.startPresentation(0); return; }

            // Arrow keys: move selected element
            if (this.selectedId && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
                e.preventDefault();
                const el = this.getElement(this.selectedId);
                if (!el) return;
                const step = e.shiftKey ? 10 : 1;
                if (e.key === 'ArrowLeft')  el.x -= step;
                if (e.key === 'ArrowRight') el.x += step;
                if (e.key === 'ArrowUp')    el.y -= step;
                if (e.key === 'ArrowDown')  el.y += step;
                this.renderElementDOM(this.selectedId);
                this.scheduleSave();
                return;
            }

            // Slide navigation (Page Up / Page Down)
            if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !this.selectedId)) {
                if (!this.selectedId) this.selectSlide(this.slideIdx + 1);
            }
            if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !this.selectedId)) {
                if (!this.selectedId) this.selectSlide(this.slideIdx - 1);
            }
        });
    }

    // ── Clipboard ──────────────────────────────────────────────
    copyElement() {
        if (!this.selectedId) return;
        const el = this.getElement(this.selectedId);
        if (el) { this.clipboard = JSON.parse(JSON.stringify(el)); this.showToast('Element copied.'); }
    }

    cutElement() {
        if (!this.selectedId) return;
        this.copyElement();
        this.deleteElement();
    }

    pasteElement() {
        if (!this.clipboard || !this.currentSlide) return;
        const copy = JSON.parse(JSON.stringify(this.clipboard));
        copy.id = uid();
        copy.x += 20; copy.y += 20;
        this.addElement(copy);
    }

    // ── Undo / Redo ────────────────────────────────────────────
    pushHistory() {
        if (!this.pres) return;
        // Trim future
        this.history = this.history.slice(0, this.histIdx + 1);
        this.history.push(JSON.parse(JSON.stringify(this.pres.slides)));
        if (this.history.length > 50) this.history.shift(); else this.histIdx++;
        this.updateUndoRedo();
    }

    undo() {
        if (this.histIdx < 0) return;
        const current = JSON.parse(JSON.stringify(this.pres.slides));
        if (this.histIdx >= this.history.length) return;
        const prev = this.history[this.histIdx];
        // Push current to redo
        this.history[this.histIdx] = current;
        this.histIdx = Math.max(-1, this.histIdx - 1);
        if (prev) {
            this.pres.slides = prev;
            this.slideIdx = clamp(this.slideIdx, 0, this.pres.slides.length - 1);
            this.selectedId = null;
            this.renderSlideList();
            this.renderCanvas();
            this.scheduleSave();
        }
        this.updateUndoRedo();
    }

    redo() {
        if (this.histIdx >= this.history.length - 1) return;
        this.histIdx++;
        const next = this.history[this.histIdx];
        if (next) {
            this.pres.slides = JSON.parse(JSON.stringify(next));
            this.slideIdx = clamp(this.slideIdx, 0, this.pres.slides.length - 1);
            this.selectedId = null;
            this.renderSlideList();
            this.renderCanvas();
            this.scheduleSave();
        }
        this.updateUndoRedo();
    }

    updateUndoRedo() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = this.histIdx < 0;
        if (redoBtn) redoBtn.disabled = this.histIdx >= this.history.length - 1;
    }

    // ── Ribbon Setup ───────────────────────────────────────────
    setupRibbon() {
        // Undo / Redo
        document.getElementById('undoBtn')?.addEventListener('click', () => this.undo());
        document.getElementById('redoBtn')?.addEventListener('click', () => this.redo());

        // Clipboard
        document.getElementById('cutBtn')?.addEventListener('click', () => this.cutElement());
        document.getElementById('copyBtn')?.addEventListener('click', () => this.copyElement());
        document.getElementById('pasteBtn')?.addEventListener('click', () => this.pasteElement());

        // Insert
        document.getElementById('insertTextBtn')?.addEventListener('click', () => {
            if (!this.pres) return;
            const el = makeTextEl(120, 100, 320, 80);
            this.addElement(el);
            setTimeout(() => this.enterTextEditing(el.id), 50);
        });

        document.getElementById('insertImageBtn')?.addEventListener('click', () => {
            document.getElementById('insertImageInput')?.click();
        });
        document.getElementById('insertImageInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataUrl = ev.target.result;
                // Load the actual image to read its natural dimensions,
                // then size the element box to match the real aspect ratio.
                // This avoids the empty letterboxed space that appeared when
                // every imported image was forced into a fixed 360x270 box.
                const probe = new Image();
                probe.onload = () => {
                    const natW = probe.naturalWidth || 360;
                    const natH = probe.naturalHeight || 270;
                    const MAX = 480; // longest side, in canvas px (960x540 slide)
                    let w, h;
                    if (natW >= natH) {
                        w = Math.min(MAX, natW);
                        h = Math.round(w * natH / natW);
                    } else {
                        h = Math.min(MAX, natH);
                        w = Math.round(h * natW / natH);
                    }
                    // Center on canvas, clamp so it never overflows
                    const x = Math.max(20, Math.round((960 - w) / 2));
                    const y = Math.max(20, Math.round((540 - h) / 2));
                    const el = makeImageEl(dataUrl, x, y, w, h);
                    this.addElement(el);
                };
                probe.onerror = () => {
                    // Fallback to a sane default if the image fails to load
                    const el = makeImageEl(dataUrl, 130, 100, 360, 270);
                    this.addElement(el);
                };
                probe.src = dataUrl;
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });

        // Shape dropdown
        document.querySelectorAll('.shape-option').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this.pres) return;
                const shape = btn.dataset.shape;
                const el = makeShapeEl(shape, 200, 150, shape === 'line' ? 300 : 200, shape === 'line' ? 4 : 140);
                // Close dropdown
                document.getElementById('shapeDropdown')?.classList.remove('active');
                this.addElement(el);
            });
        });

        // Font family
        const fontFamilyDd = document.getElementById('fontFamilyDropdown');
        fontFamilyDd?.querySelectorAll('.ms-dropdown-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                const val = item.dataset.value;
                fontFamilyDd.querySelector('.dropdown-value').textContent = val;
                this.applyTextFormat('fontFamily', val);
                fontFamilyDd.classList.remove('active');
            });
        });

        // Font size
        const fontSizeDd = document.getElementById('fontSizeDropdown');
        fontSizeDd?.querySelectorAll('.ms-dropdown-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                const val = item.dataset.value;
                fontSizeDd.querySelector('.dropdown-value').textContent = val;
                this.applyTextFormat('fontSize', val);
                fontSizeDd.classList.remove('active');
            });
        });

        // Bold / Italic / Underline
        document.getElementById('boldBtn')?.addEventListener('click', () => this.applyTextFormat('bold'));
        document.getElementById('italicBtn')?.addEventListener('click', () => this.applyTextFormat('italic'));
        document.getElementById('underlineBtn')?.addEventListener('click', () => this.applyTextFormat('underline'));

        // Text color (vertical list — matches notes app style)
        document.querySelectorAll('#fontColorDropdown .ms-dropdown-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                const color = item.dataset.value;
                const btn = document.querySelector('#fontColorDropdown .ms-dropdown-btn');
                const swatch = btn?.querySelector('.color-preview');
                const label = btn?.querySelector('.dropdown-value');
                if (swatch) {
                    swatch.style.background = color === 'transparent' ? 'transparent' : color;
                    swatch.style.border = (color === 'transparent') ? '1px solid #ccc' : '';
                }
                if (label) label.textContent = item.dataset.label || 'Text';
                this.applyTextFormat('color', color);
                document.getElementById('fontColorDropdown')?.classList.remove('active');
            });
        });

        // Text highlight (matches notes app style)
        document.querySelectorAll('#highlightColorDropdown .ms-dropdown-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                const color = item.dataset.value;
                const btn = document.querySelector('#highlightColorDropdown .ms-dropdown-btn');
                const swatch = btn?.querySelector('.color-preview');
                const label = btn?.querySelector('.dropdown-value');
                if (swatch) {
                    if (color === 'transparent') {
                        swatch.style.background = 'transparent';
                        swatch.style.border = '1px solid #ccc';
                    } else {
                        swatch.style.background = color;
                        swatch.style.border = '';
                    }
                }
                if (label) label.textContent = item.dataset.label || 'Highlight';
                this.applyTextFormat('highlight', color);
                document.getElementById('highlightColorDropdown')?.classList.remove('active');
            });
        });

        // Align
        document.getElementById('alignLeftBtn')?.addEventListener('click', () => this.applyTextFormat('textAlign', 'left'));
        document.getElementById('alignCenterBtn')?.addEventListener('click', () => this.applyTextFormat('textAlign', 'center'));
        document.getElementById('alignRightBtn')?.addEventListener('click', () => this.applyTextFormat('textAlign', 'right'));

        // Lists
        document.getElementById('bulletListBtn')?.addEventListener('click', () => this.applyTextFormat('insertUnorderedList'));
        document.getElementById('numberListBtn')?.addEventListener('click', () => this.applyTextFormat('insertOrderedList'));

        // Shape fill
        document.querySelectorAll('#fillColorDropdown .color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                const color = dot.dataset.color;
                document.getElementById('fillColorSwatch').style.background = color === 'none' ? 'transparent' : color;
                if (this.selectedId) this.updateElement(this.selectedId, { fill: color });
                document.getElementById('fillColorDropdown')?.classList.remove('active');
            });
        });
        document.getElementById('fillColorCustom')?.addEventListener('input', (e) => {
            document.getElementById('fillColorSwatch').style.background = e.target.value;
            if (this.selectedId) this.updateElement(this.selectedId, { fill: e.target.value }, true);
        });

        // Shape stroke
        document.querySelectorAll('#strokeColorDropdown .color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                const color = dot.dataset.color;
                if (this.selectedId) this.updateElement(this.selectedId, { stroke: color });
                document.getElementById('strokeColorDropdown')?.classList.remove('active');
            });
        });
        document.getElementById('strokeColorCustom')?.addEventListener('input', (e) => {
            if (this.selectedId) this.updateElement(this.selectedId, { stroke: e.target.value }, true);
        });
        document.getElementById('strokeWidthInput')?.addEventListener('input', (e) => {
            if (this.selectedId) this.updateElement(this.selectedId, { strokeWidth: parseInt(e.target.value) || 2 }, true);
        });

        // Arrange
        document.getElementById('bringFrontBtn')?.addEventListener('click', () => this.bringToFront());
        document.getElementById('sendBackBtn')?.addEventListener('click', () => this.sendToBack());
        document.getElementById('duplicateElBtn')?.addEventListener('click', () => this.duplicateElement());
        document.getElementById('deleteElBtn')?.addEventListener('click', () => this.deleteElement());

        // Presentation
        document.getElementById('presentFromStartBtn')?.addEventListener('click', () => this.startPresentation(0));
        document.getElementById('presentFromCurrentBtn')?.addEventListener('click', () => this.startPresentation(this.slideIdx));

        // Export
        document.getElementById('exportPptxBtn')?.addEventListener('click', () => this.exportPPTX());
        document.getElementById('exportPdfBtn')?.addEventListener('click', () => this.exportPDF());
        document.getElementById('importPptxBtn')?.addEventListener('click', () => document.getElementById('importPptxInput')?.click());
        document.getElementById('importPptxInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this.importPPTX(file);
            e.target.value = '';
        });

        // Slide actions (in editor header)
        document.getElementById('newSlideBtn')?.addEventListener('click', () => this.addSlide());
        document.getElementById('newSlideBtnRibbon')?.addEventListener('click', () => this.addSlide());
        document.getElementById('duplicateSlideBtn')?.addEventListener('click', () => this.duplicateSlide());
        document.getElementById('deleteSlideBtn')?.addEventListener('click', () => this.deleteSlide());

        // Presenter Notes toggle (status bar button)
        const notesBtn = document.getElementById('notesToggleBtn');
        const notesPanel = document.getElementById('presenterNotesPanel');
        if (notesBtn && notesPanel) {
            notesBtn.addEventListener('click', () => {
                const willShow = !notesPanel.classList.contains('visible');
                notesPanel.classList.toggle('visible', willShow);
                notesBtn.classList.toggle('active', willShow);
                notesBtn.title = willShow ? 'Hide Presenter Notes' : 'Show Presenter Notes';
                if (willShow) {
                    // Focus the textarea for immediate editing
                    setTimeout(() => document.getElementById('presenterNotesInput')?.focus(), 50);
                }
            });
        }

        // Welcome screen
        document.getElementById('welcomeNewBtn')?.addEventListener('click', () => this.newPresentation());

        // Presentation title
        document.getElementById('presentationTitle')?.addEventListener('input', (e) => {
            if (!this.pres) return;
            this.pres.title = e.target.value || 'Untitled Presentation';
            this.scheduleSave();
        });

        // Delete modal
        document.getElementById('deleteModalCancel')?.addEventListener('click', () => this.closeDeleteModal());
        document.getElementById('deleteModalConfirm')?.addEventListener('click', () => this.confirmDelete());

        // Background picker modal (legacy, kept for fallback)
        document.getElementById('bgPickerCancel')?.addEventListener('click', () => this.closeBgPicker());
        document.getElementById('bgPickerApply')?.addEventListener('click', () => this.applyBgPicker());

        // Background ribbon dropdown — applies immediately on click (no modal needed)
        document.querySelectorAll('#bgDropdown .bg-color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this.currentSlide) return;
                const bgVal = btn.dataset.bg;
                this.applyBackgroundImmediate(bgVal);
                // Highlight active
                document.querySelectorAll('#bgDropdown .bg-color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                // Close dropdown
                document.getElementById('bgDropdown')?.classList.remove('active');
            });
        });
        // Custom color picker in ribbon dropdown — applies immediately
        document.querySelector('#bgDropdown #bgColorCustom')?.addEventListener('input', (e) => {
            if (!this.currentSlide) return;
            this.applyBackgroundImmediate(e.target.value);
            document.querySelectorAll('#bgDropdown .bg-color-btn').forEach(b => b.classList.remove('active'));
        });

        // Legacy modal color buttons (kept in case modal is opened)
        document.querySelectorAll('#bgPickerModal .bg-color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#bgPickerModal .bg-color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._pendingBgValue = btn.dataset.bg;
                const customInput = document.querySelector('#bgPickerModal #bgColorCustom');
                if (customInput && !btn.dataset.bg.includes('gradient')) customInput.value = btn.dataset.bg;
            });
        });
        document.querySelector('#bgPickerModal #bgColorCustom')?.addEventListener('input', (e) => {
            this._pendingBgValue = e.target.value;
            document.querySelectorAll('#bgPickerModal .bg-color-btn').forEach(b => b.classList.remove('active'));
        });
    }

    // Apply background immediately (no modal) — used by ribbon dropdown
    applyBackgroundImmediate(value) {
        if (!this.currentSlide) return;
        this.pushHistory();
        const isGradient = value.includes('gradient');
        this.currentSlide.background = {
            type: isGradient ? 'gradient' : 'color',
            value,
        };
        this.renderCanvas();
        this.updateThumbnail(this.slideIdx);
        this.scheduleSave();
    }

    setupDropdownMenus() {
        // Portal-based dropdown (ported from notes.js for proper overflow escape)
        document.querySelectorAll('.ms-dropdown').forEach(dropdown => {
            const btn = dropdown.querySelector(':scope > .ms-dropdown-btn, :scope > button.ribbon-btn.ms-dropdown-btn');
            const menu = dropdown.querySelector(':scope > .ms-dropdown-menu');
            if (!btn || !menu) return;

            btn.setAttribute('aria-expanded', 'false');
            btn.setAttribute('aria-haspopup', 'listbox');

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._portalDropdown === dropdown) {
                    this._closePortal();
                    return;
                }
                this._openPortal(dropdown, btn, menu);
            });

            btn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    btn.click();
                } else if (e.key === 'Escape') {
                    this._closePortal();
                }
            });
        });

        // Close portal on outside click
        document.addEventListener('mousedown', (e) => {
            if (this._portalMenu &&
                !this._portalMenu.contains(e.target) &&
                this._portalBtn && !this._portalBtn.contains(e.target)) {
                this._closePortal();
            }
        });

        // Close portal on scroll or resize — but NOT when scrolling inside the menu itself
        window.addEventListener('scroll', (e) => {
            if (this._portalMenu && (e.target === this._portalMenu || this._portalMenu.contains(e.target))) return;
            this._closePortal();
        }, true);
        window.addEventListener('resize', () => this._closePortal());
    }

    _openPortal(dropdown, btn, menu) {
        this._closePortal(false);
        document.body.appendChild(menu);
        this._portalMenu = menu;
        this._portalDropdown = dropdown;
        this._portalBtn = btn;
        dropdown.classList.add('active');
        btn.setAttribute('aria-expanded', 'true');

        // Match Notes app: tighter max-height (320px default, 240px for color list menus)
        const isColorList = menu.classList && menu.classList.contains('color-list-menu');
        const isColorGrid = menu.classList && menu.classList.contains('color-grid-menu');
        const cap = isColorList ? 240 : (isColorGrid ? 320 : 320);
        const maxH = Math.min(cap, window.innerHeight * 0.6);
        // First, measure invisibly
        menu.style.cssText = `position:fixed;visibility:hidden;display:block;z-index:999999;margin:0;max-height:${maxH}px;overflow-y:auto;`;
        const btnRect = btn.getBoundingClientRect();
        const mW = menu.offsetWidth || 200;
        const mH = menu.offsetHeight || 280;
        const vW = window.innerWidth;
        const vH = window.innerHeight;
        let top = btnRect.bottom + 4;
        if (top + mH > vH - 8) top = btnRect.top - mH - 4;
        if (top < 8) top = btnRect.bottom + 4;
        let left = btnRect.left;
        if (left + mW > vW - 8) left = vW - mW - 8;
        if (left < 8) left = 8;
        menu.style.cssText = `position:fixed;display:block;visibility:visible;z-index:999999;margin:0;left:${left}px;top:${top}px;max-height:${maxH}px;overflow-y:auto;animation:dropdownFadeIn 0.18s ease;`;
    }

    _closePortal(animate = true) {
        if (!this._portalMenu) return;
        const menu = this._portalMenu;
        const dropdown = this._portalDropdown;
        const btn = this._portalBtn;
        this._portalMenu = null;
        this._portalDropdown = null;
        this._portalBtn = null;
        if (dropdown) dropdown.classList.remove('active');
        if (btn) btn.setAttribute('aria-expanded', 'false');

        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            menu.removeEventListener('animationend', cleanup);
            menu.classList.remove('ms-portal-closing');
            menu.style.cssText = '';
            if (dropdown) dropdown.appendChild(menu);
        };
        if (animate) {
            menu.classList.add('ms-portal-closing');
            menu.addEventListener('animationend', cleanup);
            setTimeout(cleanup, 220);
        } else {
            cleanup();
        }
    }

    // ── Ribbon Tab Switching ──────────────────────────────────────
    setupRibbonTabs() {
        const tabs = document.querySelectorAll('.ribbon-tab[data-tab]');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                this._switchTab(tab.dataset.tab);
            });
        });
        // Initial position + keep it aligned on resize / contextual-tab show.
        // Double-rAF: the first frame commits the initial CSS state
        // (width:0, transform:0, opacity:0); the second frame sets the
        // target values, giving the transition a clean starting point.
        // Without this, the browser batches both states and the indicator
        // just appears at the active tab with no slide animation.
        requestAnimationFrame(() => requestAnimationFrame(() => this._updateRibbonTabIndicator()));
        window.addEventListener('resize', () => this._updateRibbonTabIndicator());
        // Re-align when fonts finish loading (tab widths can shift)
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => this._updateRibbonTabIndicator());
        }
    }

    // Switch the active ribbon tab.
    //   target  - the data-tab value of the new tab (e.g. 'home', 'insert', 'file')
    //
    // Special case: target === 'file' does NOT activate the File ribbon panel.
    // Instead, it opens the welcome screen (the start surface where the user
    // can pick a different presentation or create a new one). The File tab
    // itself is still marked .active so the user sees where they are, and
    // the ribbon stays visible — we do NOT add body.no-active-note, which
    // would hide the ribbon entirely. All ribbon panels are deactivated.
    //
    // This mirrors Microsoft Office's "File → Backstage" behaviour: clicking
    // File leaves the editor and takes you to a file-management surface.
    _switchTab(target) {
        const tabs = document.querySelectorAll('.ribbon-tab[data-tab]');
        const panels = document.querySelectorAll('.ribbon-panel[data-panel]');
        const targetTab = document.querySelector(`.ribbon-tab[data-tab="${target}"]`);
        if (!targetTab) return;

        tabs.forEach(t => t.classList.toggle('active', t === targetTab));

        if (target === 'file') {
            // Open welcome screen, hide all ribbon panels. Keep ribbon visible
            // so the File tab itself stays visible as the active tab.
            panels.forEach(p => p.classList.remove('active'));
            this.closePresentation();
            this._activeTab = target;
            this._closePortal(false);
            this._updateRibbonTabIndicator();
            return;
        }

        // Normal tab switch: activate the matching ribbon panel.
        panels.forEach(p => p.classList.toggle('active', p.dataset.panel === target));
        this._activeTab = target;
        this._closePortal(false);
        this._updateRibbonTabIndicator();
    }

    // Position the sliding underline indicator under the active ribbon tab.
    // Sets `transform: translateX(Npx)` and `width: Mpx` based on the active
    // tab's offsetLeft/offsetWidth inside .ribbon-tabs-left. The CSS transition
    // on `.ribbon-tab-indicator` produces the smooth slide.
    _updateRibbonTabIndicator() {
        const indicator = document.getElementById('ribbonTabIndicator');
        if (!indicator) return;
        const activeTab = document.querySelector('.ribbon-tab.active');
        if (!activeTab || activeTab.hidden) {
            indicator.classList.remove('visible');
            indicator.style.width = '0px';
            indicator.style.transform = 'translateX(0px)';
            return;
        }
        const left = activeTab.offsetLeft;
        const width = activeTab.offsetWidth;
        indicator.style.width = `${width}px`;
        indicator.style.transform = `translateX(${left}px)`;
        indicator.classList.add('visible');
    }

    // ── Transitions Tab ───────────────────────────────────────────
    // 16 transition types ported from slides AI GENERATED.html
    static TRANSITIONS = [
        { value: 'none',       label: 'None',       preview: '#ffffff' },
        { value: 'fade',       label: 'Fade',       preview: 'linear-gradient(90deg,#fff,#aaa)' },
        { value: 'push',       label: 'Push',       preview: 'linear-gradient(90deg,#f97316 50%,#fff 50%)' },
        { value: 'wipe',       label: 'Wipe',       preview: 'linear-gradient(90deg,#fff 30%,#f97316 30%)' },
        { value: 'split',      label: 'Split',      preview: 'linear-gradient(135deg,#f97316 50%,#fff 50%)' },
        { value: 'fade-black', label: 'Fade Black', preview: 'linear-gradient(90deg,#fff,#000)' },
        { value: 'zoom',       label: 'Zoom',       preview: 'radial-gradient(circle,#f97316 30%,#fff)' },
        { value: 'cube',       label: 'Cube',       preview: 'linear-gradient(135deg,#f97316,#c2410c)' },
        { value: 'flip',       label: 'Flip',       preview: 'linear-gradient(90deg,#f97316,#fff)' },
        { value: 'gallery',    label: 'Gallery',    preview: 'linear-gradient(180deg,#f97316 60%,#fff)' },
        { value: 'cover',      label: 'Cover',      preview: 'radial-gradient(circle at center,#f97316 40%,#fff 41%)' },
        { value: 'reveal',     label: 'Reveal',     preview: 'radial-gradient(circle at center,#fff 50%,#f97316 51%)' },
        { value: 'cut',        label: 'Cut',        preview: 'repeating-linear-gradient(90deg,#fff 0 10px,#f97316 10px 11px)' },
        { value: 'vortex',     label: 'Vortex',     preview: 'conic-gradient(from 0deg,#f97316,#fff,#f97316)' },
        { value: 'newsflash',  label: 'Newsflash',  preview: 'linear-gradient(135deg,#fbbf24 0 50%,#fff 50%)' },
        { value: 'honeycomb',  label: 'Honeycomb',  preview: 'radial-gradient(circle at 50% 50%,#f97316 20%,#fff 21%,#fff 40%,#f97316 41%)' },
        { value: 'glitch',     label: 'Glitch',     preview: 'repeating-linear-gradient(0deg,#ff0000 0 2px,#00ff00 2px 4px,#0000ff 4px 6px)' },
    ];

    setupTransitionsTab() {
        const grid = document.getElementById('transitionGrid');
        if (!grid) return;

        // Populate transition grid
        SlidesApp.TRANSITIONS.forEach(tr => {
            const item = document.createElement('button');
            item.className = 'transition-option';
            item.dataset.value = tr.value;
            item.title = tr.label;
            item.innerHTML = `
                <div class="tr-preview" style="background:${tr.preview};"></div>
                <span class="tr-label">${tr.label}</span>
            `;
            item.addEventListener('click', () => {
                this._closePortal(false);
                this.applyTransition(tr.value);
                grid.querySelectorAll('.transition-option').forEach(o => o.classList.toggle('active', o === item));
            });
            grid.appendChild(item);
        });

        // Duration input
        const durInput = document.getElementById('transitionDuration');
        durInput?.addEventListener('change', () => {
            this.updateTransitionTiming({ duration: parseFloat(durInput.value) || 0.7 });
        });

        // On click checkbox
        const onClickCb = document.getElementById('transitionOnClick');
        onClickCb?.addEventListener('change', () => {
            this.updateTransitionTiming({ onClick: onClickCb.checked });
        });

        // Auto after checkbox
        const afterCb = document.getElementById('transitionAutoAfter');
        const afterSec = document.getElementById('transitionAfterSec');
        afterCb?.addEventListener('change', () => {
            afterSec.disabled = !afterCb.checked;
            this.updateTransitionTiming({ autoAfter: afterCb.checked, afterSec: parseFloat(afterSec.value) || 5 });
        });
        afterSec?.addEventListener('change', () => {
            this.updateTransitionTiming({ autoAfter: afterCb.checked, afterSec: parseFloat(afterSec.value) || 5 });
        });

        // Apply to all
        document.getElementById('applyTransitionAllBtn')?.addEventListener('click', () => {
            if (!this.pres || this.pres.slides.length === 0) return;
            const current = this.pres.slides[this.slideIdx]?.transition || { type: 'none', duration: 0.7, onClick: true };
            this.pres.slides.forEach(s => { s.transition = { ...current }; });
            this.scheduleSave();
            this.showToast(`Applied "${current.type}" transition to all slides.`);
        });

        // Preview
        document.getElementById('previewTransitionBtn')?.addEventListener('click', () => {
            this.previewTransition();
        });
    }

    applyTransition(type) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        slide.transition = { ...(slide.transition || {}), type };
        const labelEl = document.getElementById('transitionLabel');
        if (labelEl) labelEl.textContent = type === 'none' ? 'None' : SlidesApp.TRANSITIONS.find(t => t.value === type)?.label || type;
        this.scheduleSave();
    }

    updateTransitionTiming(opts) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        slide.transition = { ...(slide.transition || { type: 'none', duration: 0.7, onClick: true }), ...opts };
        this.scheduleSave();
    }

    previewTransition() {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        const type = slide.transition?.type || 'none';
        if (type === 'none') { this.showToast('No transition selected.'); return; }
        // Render the current slide with the transition animation
        const container = document.getElementById('presentSlide') || document.getElementById('slideCanvas');
        if (!container) return;
        const cls = `tr-${type}-in`;
        container.classList.remove(...Array.from(container.classList).filter(c => c.startsWith('tr-')));
        void container.offsetWidth;
        container.classList.add(cls);
        setTimeout(() => container.classList.remove(cls), 1200);
    }

    // ── Animations Tab ────────────────────────────────────────────
    static ANIMATIONS = [
        { value: 'appear', label: 'Appear',  icon: '<circle cx="12" cy="12" r="9"/>' },
        { value: 'fade',   label: 'Fade In', icon: '<circle cx="12" cy="12" r="9" stroke-dasharray="3,3"/>' },
        { value: 'fly',    label: 'Fly In',  icon: '<path d="M3 12h18M14 6l6 6-6 6"/>' },
        { value: 'zoom',   label: 'Zoom',    icon: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="9" stroke-dasharray="2,3"/>' },
        { value: 'spin',   label: 'Spin',    icon: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/>' },
        { value: 'bounce', label: 'Bounce',  icon: '<path d="M3 18c3-6 6-12 9-6s6 0 9-6"/>' },
    ];

    setupAnimationsTab() {
        const list = document.getElementById('animationListMenu');
        if (!list) return;

        SlidesApp.ANIMATIONS.forEach(anim => {
            const item = document.createElement('div');
            item.className = 'ms-dropdown-item animation-option';
            item.dataset.value = anim.value;
            item.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${anim.icon}</svg><span>${anim.label}</span>`;
            item.addEventListener('click', () => {
                this._closePortal(false);
                this.applyAnimation(anim.value);
            });
            list.appendChild(item);
        });

        // Animation pane toggle
        document.getElementById('animationPaneBtn')?.addEventListener('click', () => this.toggleAnimationPane());
        document.getElementById('apCloseBtn')?.addEventListener('click', () => this.toggleAnimationPane(false));

        // Animation start dropdown
        const startDd = document.getElementById('animStartDropdown');
        startDd?.querySelectorAll('.ms-dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const v = item.dataset.value;
                const valSpan = startDd.querySelector('.dropdown-value');
                if (valSpan) valSpan.textContent = { click: 'On Click', with: 'With Previous', after: 'After Previous' }[v] || 'On Click';
                this._closePortal(false);
                this.updateAnimationTiming({ start: v });
            });
        });

        // Animation duration
        const durInput = document.getElementById('animDuration');
        durInput?.addEventListener('change', () => {
            this.updateAnimationTiming({ duration: parseFloat(durInput.value) || 0.5 });
        });
    }

    applyAnimation(type) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        if (!this.selectedId) { this.showToast('Select an element first to animate.'); return; }
        slide.animations = slide.animations || [];
        slide.animations.push({
            id: uid(),
            elementId: this.selectedId,
            type,
            start: 'click',
            duration: 0.5,
        });
        this.scheduleSave();
        this.renderAnimationPane();
        this.showToast(`Added "${type}" animation.`);
    }

    updateAnimationTiming(opts) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide || !slide.animations || slide.animations.length === 0) return;
        Object.assign(slide.animations[slide.animations.length - 1], opts);
        this.scheduleSave();
        this.renderAnimationPane();
    }

    toggleAnimationPane(force) {
        const pane = document.getElementById('animationPane');
        if (!pane) return;
        const show = force === undefined ? pane.style.display === 'none' : force;
        pane.style.display = show ? 'flex' : 'none';
        if (show) this.renderAnimationPane();
    }

    renderAnimationPane() {
        const body = document.getElementById('apBody');
        if (!body || !this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide || !slide.animations || slide.animations.length === 0) {
            body.innerHTML = '<div class="ap-empty">No animations on this slide.</div>';
            return;
        }
        body.innerHTML = '';
        slide.animations.forEach((a, i) => {
            const el = this.getElement(a.elementId);
            const elLabel = el ? `${el.type} #${i+1}` : `Element #${i+1}`;
            const animLabel = SlidesApp.ANIMATIONS.find(x => x.value === a.type)?.label || a.type;
            const item = document.createElement('div');
            item.className = 'ap-item';
            item.innerHTML = `
                <div class="ap-item-info">
                    <div class="ap-item-name">${elLabel}</div>
                    <div class="ap-item-anim">${animLabel} • ${a.start || 'click'} • ${(a.duration || 0.5).toFixed(1)}s</div>
                </div>
                <button class="ap-item-remove" title="Remove">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </button>
            `;
            item.querySelector('.ap-item-remove').addEventListener('click', () => {
                slide.animations.splice(i, 1);
                this.scheduleSave();
                this.renderAnimationPane();
            });
            body.appendChild(item);
        });
    }

    // ── View Tab ──────────────────────────────────────────────────
    setupViewTab() {
        // Zoom controls
        document.getElementById('zoomInBtn2')?.addEventListener('click', () => this.setZoom(this.scale * 1.1));
        document.getElementById('zoomOutBtn2')?.addEventListener('click', () => this.setZoom(this.scale / 1.1));
        document.getElementById('zoomFitBtn')?.addEventListener('click', () => this.fitZoom());
        document.getElementById('zoom100Btn')?.addEventListener('click', () => this.setZoom(1));

        // View modes (toggle body classes that CSS can target)
        document.getElementById('viewNormalBtn')?.addEventListener('click', () => {
            document.body.classList.remove('view-sorter', 'view-notes');
            this.showToast('Normal view.');
            // Mark this button as active in the group
            ['viewSorterBtn', 'viewNotesBtn', 'immersiveReaderBtn', 'viewNormalBtn'].forEach(id => {
                document.getElementById(id)?.classList.toggle('active', id === 'viewNormalBtn');
            });
        });
        document.getElementById('viewSorterBtn')?.addEventListener('click', () => {
            document.body.classList.toggle('view-sorter');
            document.body.classList.remove('view-notes');
            const on = document.body.classList.contains('view-sorter');
            this.showToast(on ? 'Slide sorter view.' : 'Normal view.');
            ['viewSorterBtn', 'viewNotesBtn', 'immersiveReaderBtn', 'viewNormalBtn'].forEach(id => {
                document.getElementById(id)?.classList.toggle('active', id === 'viewSorterBtn' && on);
            });
        });
        document.getElementById('viewNotesBtn')?.addEventListener('click', () => {
            const panel = document.getElementById('presenterNotesPanel');
            const btn = document.getElementById('notesToggleBtn');
            if (panel) {
                const willShow = !panel.classList.contains('visible');
                panel.classList.toggle('visible', willShow);
                panel.classList.toggle('expanded', willShow);
                btn?.classList.toggle('active', willShow);
                if (btn) btn.title = willShow ? 'Hide Presenter Notes' : 'Show Presenter Notes';
                this.showToast(willShow ? 'Notes panel opened.' : 'Notes panel closed.');
                if (willShow) setTimeout(() => document.getElementById('presenterNotesInput')?.focus(), 50);
            }
        });

        // Show toggles
        document.getElementById('toggleRulersBtn')?.addEventListener('click', (e) => {
            document.body.classList.toggle('show-rulers');
            e.currentTarget.classList.toggle('active');
        });
        document.getElementById('toggleGridBtn')?.addEventListener('click', (e) => {
            document.body.classList.toggle('show-grid');
            e.currentTarget.classList.toggle('active');
            const canvas = document.getElementById('slideCanvas');
            if (canvas) canvas.classList.toggle('show-grid');
        });
        document.getElementById('toggleGuidesBtn')?.addEventListener('click', (e) => {
            document.body.classList.toggle('show-guides');
            e.currentTarget.classList.toggle('active');
            const wrapper = document.getElementById('slideCanvasWrapper');
            if (wrapper) wrapper.classList.toggle('show-guides');
        });

        // Immersive reader (opens a simplified read-only overlay of the current slide text)
        document.getElementById('immersiveReaderBtn')?.addEventListener('click', () => this.openImmersiveReader());
        // Notes toggle in View tab (same as status-bar Notes button)
        document.getElementById('viewNotesToggleBtn')?.addEventListener('click', () => {
            document.getElementById('viewNotesBtn')?.click();
        });
    }

    // ── File / Draw / Slide Show / Review Tab Wiring ─────
    setupExtraTabs() {
        // ── FILE TAB ──
        document.getElementById('fileNewBtn')?.addEventListener('click', () => {
            this.confirmDiscardAndCreate();
        });
        document.getElementById('fileOpenBtn')?.addEventListener('click', () => {
            // Switch to welcome screen to pick a presentation
            const ws = document.getElementById('welcomeScreen');
            if (ws && ws.parentElement) ws.parentElement.classList.remove('hidden');
            document.getElementById('welcomeScreen')?.scrollIntoView({ behavior: 'smooth' });
            this.showToast('Select a presentation from the list.');
        });
        document.getElementById('fileSaveBtn')?.addEventListener('click', () => {
            this.scheduleSave();
            this.commitSave();
            this.showToast('Saved.');
        });
        document.getElementById('fileSaveAsBtn')?.addEventListener('click', () => {
            const title = prompt('Save presentation as:', (this.pres?.title || 'Untitled Presentation') + ' (Copy)');
            if (title && title.trim()) {
                this.duplicatePresentationAs(title.trim());
            }
        });
        document.getElementById('fileRenameBtn')?.addEventListener('click', () => {
            const input = document.getElementById('presentationTitle');
            if (input) { input.focus(); input.select(); }
            this.showToast('Edit the title in the sidebar.');
        });
        document.getElementById('fileExportPptxBigBtn')?.addEventListener('click', () => this.exportPPTX());
        document.getElementById('fileExportPdfBigBtn')?.addEventListener('click', () => this.exportPDF());

        // ── DRAW (inside Insert tab — toggles bottom drawing toolbar) ──
        this._drawColor = '#000000';
        this._drawWidth = 2;
        this._drawTool = 'pen';
        this._isDrawMode = false;
        this._isDrawing = false;
        this._drawPoints = [];
        this._drawCtx = null;
        // Insert tab → Draw button toggles the bottom drawing toolbar
        document.getElementById('insertDrawBtn')?.addEventListener('click', () => this.toggleDrawMode());
        // Bottom toolbar: tool selection
        const penBtn = document.getElementById('drawPenBtn');
        const highlighterBtn = document.getElementById('drawHighlighterBtn');
        const eraserBtn = document.getElementById('drawEraserBtn');
        const colorSection = document.querySelector('.draw-color-section');
        const colorDivider = colorSection ? colorSection.previousElementSibling : null;
        const setTool = (tool) => {
            this._drawTool = tool;
            [penBtn, highlighterBtn, eraserBtn].forEach(b => b && b.classList.remove('active'));
            if (tool === 'pen' && penBtn) penBtn.classList.add('active');
            if (tool === 'highlighter' && highlighterBtn) highlighterBtn.classList.add('active');
            if (tool === 'eraser' && eraserBtn) eraserBtn.classList.add('active');
            // Hide color section when eraser is active (nothing to color)
            const hideColor = (tool === 'eraser');
            if (colorSection) colorSection.classList.toggle('eraser-hidden', hideColor);
            if (colorDivider && colorDivider.classList.contains('color-divider')) colorDivider.classList.toggle('eraser-hidden', hideColor);
            const canvas = document.getElementById('drawingCanvas');
            if (canvas) canvas.classList.toggle('eraser-active', tool === 'eraser');
        };
        if (penBtn) penBtn.addEventListener('click', () => setTool('pen'));
        if (highlighterBtn) highlighterBtn.addEventListener('click', () => setTool('highlighter'));
        if (eraserBtn) eraserBtn.addEventListener('click', () => setTool('eraser'));
        // Color swatches
        const colorPresets = document.getElementById('drawColorPresets');
        if (colorPresets) {
            colorPresets.addEventListener('click', (e) => {
                const sw = e.target.closest('.draw-color-swatch');
                if (sw) {
                    this._drawColor = sw.dataset.color;
                    colorPresets.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
                    sw.classList.add('active');
                    const picker = document.getElementById('drawColorPicker');
                    if (picker) picker.value = sw.dataset.color;
                }
            });
        }
        const colorPicker = document.getElementById('drawColorPicker');
        if (colorPicker) {
            colorPicker.addEventListener('input', () => {
                this._drawColor = colorPicker.value;
                if (colorPresets) colorPresets.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
            });
        }
        // Size presets
        const toolbar = document.getElementById('drawToolbar');
        if (toolbar) {
            toolbar.addEventListener('click', (e) => {
                const sizeBtn = e.target.closest('.draw-size-btn');
                if (sizeBtn) {
                    this._drawWidth = parseInt(sizeBtn.dataset.size, 10) || 2;
                    toolbar.querySelectorAll('.draw-size-btn').forEach(b => b.classList.remove('active'));
                    sizeBtn.classList.add('active');
                    const slider = document.getElementById('drawThickness');
                    if (slider) slider.value = this._drawWidth;
                }
            });
        }
        // Clear / Done
        document.getElementById('drawClearBtn')?.addEventListener('click', () => this.clearDrawing());
        document.getElementById('drawDoneBtn')?.addEventListener('click', () => this.finishDrawing());
        // Initialize the drawing canvas context + listeners (the canvas
        // itself is always present in the DOM; pointer-events is toggled
        // by toggleDrawMode so it only intercepts mouse events when active).
        this._initDrawingCanvas();

        // ── SLIDE SHOW TAB ──
        document.getElementById('slideshowStartBtn')?.addEventListener('click', () => this.startPresentation(0));
        document.getElementById('slideshowCurrentBtn')?.addEventListener('click', () => this.startPresentation(this.slideIdx));
        this._slideshowLoop = false;
        document.getElementById('slideshowLoopBtn')?.addEventListener('click', (e) => {
            this._slideshowLoop = !this._slideshowLoop;
            e.currentTarget.classList.toggle('active', this._slideshowLoop);
            this.showToast(this._slideshowLoop ? 'Loop enabled.' : 'Loop disabled.');
        });
        document.getElementById('slideshowRehearseBtn')?.addEventListener('click', () => {
            this.showToast('Rehearse mode: presenting with a timer — press Esc to stop.');
            this.startPresentation(this.slideIdx);
        });
        document.getElementById('slideshowFullscreenBtn')?.addEventListener('click', () => {
            this.startPresentation(this.slideIdx);
            setTimeout(() => {
                const el = document.documentElement;
                if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
            }, 100);
        });

        // ── REVIEW TAB ──
        document.getElementById('spellCheckBtn')?.addEventListener('click', () => this.spellCheck());
        document.getElementById('wordCountBtn')?.addEventListener('click', () => this.showWordCount());
        document.getElementById('checkAccessibilityBtn')?.addEventListener('click', () => this.checkAccessibility());
        document.getElementById('altTextBtn')?.addEventListener('click', () => this.editAltText());
        document.getElementById('translateBtn')?.addEventListener('click', () => this.translateSelection());
        document.getElementById('languageBtn')?.addEventListener('click', () => this.setLanguage());

        // ── DESIGN TAB: Themes & Variants ──
        this.renderThemes();
        this.renderVariants();
        document.getElementById('moreThemesBtn')?.addEventListener('click', () => {
            this._themeIdx = (this._themeIdx ?? 0) + 6;
            this.renderThemes();
        });

        // ── DESIGN TAB: Customize buttons ──
        document.getElementById('slideLayoutBtn')?.addEventListener('click', () => this.showLayoutPicker());
        document.getElementById('slideSizeBtn')?.addEventListener('click', () => this.cycleSlideSize());
        document.getElementById('designerBtn')?.addEventListener('click', () => this.openDesigner());

        // ── ANIMATIONS TAB: Preview + Reorder + Delay ──
        document.getElementById('previewAnimBtn')?.addEventListener('click', () => this.previewAnimations());
        document.getElementById('animMoveEarlierBtn')?.addEventListener('click', () => this.moveAnimation(-1));
        document.getElementById('animMoveLaterBtn')?.addEventListener('click', () => this.moveAnimation(1));
        document.getElementById('animDelay')?.addEventListener('input', (e) => {
            const slide = this.pres?.slides?.[this.slideIdx];
            const el = this.selectedId ? this.getElement(this.selectedId) : null;
            const anim = el?.animations?.find(a => a.slideIdx === this.slideIdx);
            if (anim) {
                anim.delay = parseFloat(e.target.value) || 0;
                this.scheduleSave();
                this.renderAnimationPane();
            }
        });

        // ── INSERT TAB: New Slide + Video + Audio + Icon + Chart + Link + Comment + Symbol ──
        document.getElementById('insertNewSlideBtn')?.addEventListener('click', () => this.addSlide());
        document.getElementById('insertVideoBtn')?.addEventListener('click', () => document.getElementById('insertVideoInput')?.click());
        document.getElementById('insertVideoInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                // Probe the video metadata so the box matches the real aspect ratio.
                // Falls back to 320x180 (16:9) if metadata can't be read.
                const dataUrl = ev.target.result;
                const probe = document.createElement('video');
                probe.preload = 'metadata';
                probe.onloadedmetadata = () => {
                    const natW = probe.videoWidth || 320;
                    const natH = probe.videoHeight || 180;
                    const MAX = 480;
                    let w, h;
                    if (natW >= natH) {
                        w = Math.min(MAX, natW);
                        h = Math.round(w * natH / natW);
                    } else {
                        h = Math.min(MAX, natH);
                        w = Math.round(h * natW / natH);
                    }
                    const x = Math.max(20, Math.round((960 - w) / 2));
                    const y = Math.max(20, Math.round((540 - h) / 2));
                    const el = { id: uid(), type: 'video', x, y, w, h, r: 0, z: 1, src: dataUrl, poster: '', opacity: 1 };
                    this.addElement(el);
                    this.showToast('Video inserted.');
                };
                probe.onerror = () => {
                    const el = { id: uid(), type: 'video', x: 130, y: 100, w: 320, h: 180, r: 0, z: 1, src: dataUrl, poster: '', opacity: 1 };
                    this.addElement(el);
                    this.showToast('Video inserted.');
                };
                probe.src = dataUrl;
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });
        document.getElementById('insertAudioBtn')?.addEventListener('click', () => document.getElementById('insertAudioInput')?.click());
        document.getElementById('insertAudioInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                // 260x70 compact card: wide enough for the native audio
                // controls (~240px) and tall enough for icon + control bar.
                const el = { id: uid(), type: 'audio', x: 130, y: 100, w: 260, h: 70, r: 0, z: 1, src: ev.target.result, opacity: 1 };
                this.addElement(el);
                this.showToast('Audio inserted.');
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });
        document.getElementById('insertIconBtn')?.addEventListener('click', () => this.openIconPicker());
        document.getElementById('insertChartBtn')?.addEventListener('click', () => this.insertChart());
        document.getElementById('insertLinkBtn')?.addEventListener('click', () => this.openLinkModal());
        document.getElementById('insertCommentBtn')?.addEventListener('click', () => this.insertComment());
        document.getElementById('insertSymbolBtn')?.addEventListener('click', () => this.openSymbolPicker());
    }

    // ── Helper methods for the new features ──────────────────────

    confirmDiscardAndCreate() {
        if (this.pres && this.pres.slides && this.pres.slides.length > 0 && !confirm('Start a new presentation? Current one is saved in your library.')) return;
        this.newPresentation();
    }

    duplicatePresentationAs(newTitle) {
        if (!this.pres) return;
        const copy = JSON.parse(JSON.stringify(this.pres));
        copy.id = uid();
        copy.title = newTitle;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        this.pres = copy;
        this.slideIdx = 0;
        this.history = [];
        this.histIdx = -1;
        this.scheduleSave();
        this.commitSave();
        this.renderSlideList();
        this.renderCanvas();
        this.showToast(`Saved as "${newTitle}".`);
    }

    // ── DRAW MODE (bottom-toolbar, notes-app style) ──
    // The drawing overlay is a <canvas id="drawingCanvas"> sized to the
    // 960x540 slide. It lives inside the slide-canvas-scaler so it
    // scales with the slide. Pointer events are toggled so the canvas
    // only intercepts mouse events while drawing is active — otherwise
    // users can still select/move/resize elements normally.
    _initDrawingCanvas() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return;
        this._drawCtx = canvas.getContext('2d');
        // The canvas always renders at the slide's logical 960x540 size.
        // The slide-canvas-scaler handles the visual scaling via CSS transform.
        canvas.width = 960;
        canvas.height = 540;
        if (this._drawCtx) {
            this._drawCtx.lineCap = 'round';
            this._drawCtx.lineJoin = 'round';
            this._drawCtx.imageSmoothingEnabled = true;
            this._drawCtx.imageSmoothingQuality = 'high';
        }
        // Mouse
        canvas.addEventListener('mousedown', (e) => this.startDraw(e));
        canvas.addEventListener('mousemove', (e) => this.drawLine(e));
        window.addEventListener('mouseup', () => this.endDraw());
        // Touch
        canvas.addEventListener('touchstart', (e) => { e.preventDefault(); this.startDraw(e.touches[0]); }, { passive: false });
        canvas.addEventListener('touchmove', (e) => { if (this._isDrawing) e.preventDefault(); this.drawLine(e.touches[0]); }, { passive: false });
        canvas.addEventListener('touchend', () => this.endDraw());
    }

    toggleDrawMode() {
        if (!this.pres) return;
        const canvas = document.getElementById('drawingCanvas');
        const toolbar = document.getElementById('drawToolbar');
        const drawBtn = document.getElementById('insertDrawBtn');
        this._isDrawMode = !this._isDrawMode;
        if (this._isDrawMode) {
            // Entering draw mode: deselect any element, show toolbar,
            // enable pointer events on the canvas, restore this slide's
            // previously saved drawing (if any).
            this.deselectElement();
            this.exitTextEditing?.();
            if (canvas) {
                canvas.style.pointerEvents = 'all';
                canvas.style.display = 'block';
            }
            if (toolbar) toolbar.classList.add('visible');
            if (drawBtn) drawBtn.classList.add('active');
            this._restoreDrawing();
            this.showToast('Draw mode on — click and drag on the slide to draw.');
        } else {
            // Exiting draw mode: persist the drawing to the slide,
            // hide toolbar, disable pointer events on the canvas.
            this._persistDrawing();
            if (canvas) canvas.style.pointerEvents = 'none';
            if (toolbar) toolbar.classList.remove('visible');
            if (drawBtn) drawBtn.classList.remove('active');
            this.showToast('Draw mode off.');
        }
    }

    finishDrawing() { if (this._isDrawMode) this.toggleDrawMode(); }

    clearDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        if (canvas && this._drawCtx) this._drawCtx.clearRect(0, 0, canvas.width, canvas.height);
        // Also clear the saved drawing on the current slide so the clear
        // survives a slide-switch / reload.
        const slide = this.currentSlide;
        if (slide) slide.drawingData = null;
        this.scheduleSave();
        this.updateThumbnail(this.slideIdx);
    }

    // Convert a mouse/touch event's clientX/Y into the canvas's
    // internal 960x540 coordinate space (accounting for the scaler's
    // CSS transform and any offset).
    _eventToCanvasXY(e) {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        // rect.width/height are post-transform CSS pixels; canvas
        // internal coords are 960x540. Scale accordingly.
        const sx = (e.clientX - rect.left) / rect.width * 960;
        const sy = (e.clientY - rect.top) / rect.height * 540;
        return { x: sx, y: sy };
    }

    startDraw(e) {
        if (!this._isDrawMode || !this._drawCtx) return;
        this._isDrawing = true;
        const { x, y } = this._eventToCanvasXY(e);
        this._drawPoints = [{ x, y }];
        const thickness = this._drawWidth || 2;
        const tool = this._drawTool || 'pen';
        if (tool === 'eraser') {
            this._drawCtx.globalCompositeOperation = 'destination-out';
            this._drawCtx.lineWidth = thickness * 5;
            this._drawCtx.strokeStyle = '#000';
            this._drawCtx.fillStyle = '#000';
        } else if (tool === 'highlighter') {
            this._drawCtx.globalCompositeOperation = 'source-over';
            this._drawCtx.strokeStyle = this._drawColor || '#000000';
            this._drawCtx.fillStyle = this._drawColor || '#000000';
            this._drawCtx.lineWidth = thickness * 2.5;
            this._drawCtx.globalAlpha = 0.4; // translucent like a real highlighter
        } else {
            this._drawCtx.globalCompositeOperation = 'source-over';
            this._drawCtx.strokeStyle = this._drawColor || '#000000';
            this._drawCtx.fillStyle = this._drawColor || '#000000';
            this._drawCtx.lineWidth = thickness;
            this._drawCtx.globalAlpha = 1;
        }
        // Draw a dot for single-click strokes
        this._drawCtx.beginPath();
        this._drawCtx.arc(x, y, Math.max(0.5, this._drawCtx.lineWidth / 2), 0, Math.PI * 2);
        this._drawCtx.fill();
        this._drawCtx.beginPath();
        this._drawCtx.moveTo(x, y);
    }

    drawLine(e) {
        if (!this._isDrawMode || !this._isDrawing || !this._drawCtx) return;
        const { x, y } = this._eventToCanvasXY(e);
        const pts = this._drawPoints;
        pts.push({ x, y });
        // Use quadratic-curve smoothing through midpoints for natural strokes
        if (pts.length >= 3) {
            const p0 = pts[pts.length - 3];
            const p1 = pts[pts.length - 2];
            const p2 = pts[pts.length - 1];
            const mid1x = (p0.x + p1.x) / 2, mid1y = (p0.y + p1.y) / 2;
            const mid2x = (p1.x + p2.x) / 2, mid2y = (p1.y + p2.y) / 2;
            this._drawCtx.beginPath();
            this._drawCtx.moveTo(mid1x, mid1y);
            this._drawCtx.quadraticCurveTo(p1.x, p1.y, mid2x, mid2y);
            this._drawCtx.stroke();
        } else {
            const p0 = pts[0], p1 = pts[1];
            this._drawCtx.beginPath();
            this._drawCtx.moveTo(p0.x, p0.y);
            this._drawCtx.lineTo(p1.x, p1.y);
            this._drawCtx.stroke();
        }
    }

    endDraw() {
        if (!this._isDrawing) return;
        this._isDrawing = false;
        // Reset alpha so subsequent strokes are full-opacity
        if (this._drawCtx) this._drawCtx.globalAlpha = 1;
        // Final segment to the last point so the stroke doesn't end mid-curve
        const pts = this._drawPoints;
        if (pts.length >= 2 && this._drawCtx) {
            const p1 = pts[pts.length - 2], p2 = pts[pts.length - 1];
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            this._drawCtx.beginPath();
            this._drawCtx.moveTo(mx, my);
            this._drawCtx.lineTo(p2.x, p2.y);
            this._drawCtx.stroke();
        }
        this._drawPoints = [];
        // Persist after each stroke so a crash / reload keeps the drawing.
        this._persistDrawing();
        this.updateThumbnail(this.slideIdx);
    }

    // Save the current canvas pixels as a dataURL on the current slide.
    _persistDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        const slide = this.currentSlide;
        if (!canvas || !slide || !this._drawCtx) return;
        try {
            // Only save if there are non-transparent pixels (avoid storing
            // a blank canvas every time the user toggles draw mode).
            const img = this._drawCtx.getImageData(0, 0, canvas.width, canvas.height);
            let hasContent = false;
            for (let i = 3; i < img.data.length; i += 4) {
                if (img.data[i] !== 0) { hasContent = true; break; }
            }
            slide.drawingData = hasContent ? canvas.toDataURL('image/png') : null;
        } catch (_) {
            slide.drawingData = null;
        }
        this.scheduleSave();
    }

    // Load the current slide's saved drawing onto the canvas.
    _restoreDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        const slide = this.currentSlide;
        if (!canvas || !slide || !this._drawCtx) return;
        this._drawCtx.setTransform(1, 0, 0, 1, 0, 0);
        this._drawCtx.clearRect(0, 0, canvas.width, canvas.height);
        if (!slide.drawingData) return;
        const img = new Image();
        img.onload = () => {
            if (this._drawCtx) this._drawCtx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = slide.drawingData;
    }

    // ── THEMES & VARIANTS ──
    static THEMES = [
        { name: 'Accent Box', bg: '#ffffff', title: '#1a1a1a', sub: '#f97316' },
        { name: 'Wisp',       bg: '#f5f3ff', title: '#4c1d95', sub: '#7c3aed' },
        { name: '-gallery',   bg: '#fef2f2', title: '#7f1d1d', sub: '#ef4444' },
        { name: 'Slice',      bg: '#0f172a', title: '#f8fafc', sub: '#38bdf8' },
        { name: 'Integral',   bg: '#1e293b', title: '#f1f5f9', sub: '#f97316' },
        { name: 'Office',     bg: '#ffffff', title: '#1a1a1a', sub: '#2b579a' },
        { name: 'Couture',    bg: '#fdf4ff', title: '#581c87', sub: '#a21caf' },
        { name: 'Mesh',       bg: '#ecfeff', title: '#164e63', sub: '#06b6d4' },
        { name: 'Organic',    bg: '#f0fdf4', title: '#14532d', sub: '#22c55e' },
        { name: 'Parallax',   bg: '#1a1a1a', title: '#fafafa', sub: '#fbbf24' },
        { name: 'Vapor',      bg: '#fdf2f8', title: '#831843', sub: '#ec4899' },
        { name: 'Frame',      bg: '#fffbeb', title: '#78350f', sub: '#f59e0b' },
    ];

    static VARIANTS = [
        { name: 'Light',      bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316' },
        { name: 'Gray',       bg: '#f1f5f9', fg: '#0f172a', accent: '#f97316' },
        { name: 'Dark',       bg: '#1a1a1a', fg: '#fafafa', accent: '#f97316' },
        { name: 'Warm',       bg: '#fff7ed', fg: '#7c2d12', accent: '#ea580c' },
        { name: 'Cool',       bg: '#eff6ff', fg: '#1e3a8a', accent: '#2563eb' },
        { name: 'Mono',       bg: '#1e293b', fg: '#e2e8f0', accent: '#94a3b8' },
    ];

    renderThemes() {
        const row = document.getElementById('themeThumbnailRow');
        if (!row) return;
        const start = (this._themeIdx ?? 0);
        const slice = SlidesApp.THEMES.slice(start, start + 6);
        row.innerHTML = slice.map((t, i) => `
            <button class="theme-thumb" data-idx="${start + i}" title="${t.name}" style="background:${t.bg};color:${t.title};">
                <span class="theme-thumb-title">Aa</span>
                <span class="theme-thumb-sub" style="color:${t.sub};">${t.name}</span>
            </button>
        `).join('');
        row.querySelectorAll('.theme-thumb').forEach(th => {
            th.addEventListener('click', () => {
                const idx = parseInt(th.dataset.idx, 10);
                this.applyTheme(SlidesApp.THEMES[idx]);
                row.querySelectorAll('.theme-thumb').forEach(x => x.classList.remove('active'));
                th.classList.add('active');
            });
        });
    }

    renderVariants() {
        const row = document.getElementById('variantThumbnailRow');
        if (!row) return;
        row.innerHTML = SlidesApp.VARIANTS.map((v, i) => `
            <button class="variant-thumb" data-idx="${i}" title="${v.name}" style="background:${v.bg};color:${v.fg};border-color:${v.accent};">
                Aa
            </button>
        `).join('');
        row.querySelectorAll('.variant-thumb').forEach(th => {
            th.addEventListener('click', () => {
                const idx = parseInt(th.dataset.idx, 10);
                this.applyVariant(SlidesApp.VARIANTS[idx]);
                row.querySelectorAll('.variant-thumb').forEach(x => x.classList.remove('active'));
                th.classList.add('active');
            });
        });
    }

    applyTheme(theme) {
        if (!this.pres) return;
        this.pres.slides.forEach(s => {
            if (!s.background) s.background = { type: 'color', value: '#ffffff' };
            s.background = { type: 'color', value: theme.bg };
            // Update first text element to title color
            const titleEl = s.elements.find(e => e.type === 'text');
            if (titleEl) titleEl.color = theme.title;
            // Update first shape to accent color
            const shapeEl = s.elements.find(e => e.type === 'shape');
            if (shapeEl) shapeEl.fill = theme.sub;
        });
        this.pushHistory();
        this.renderCanvas();
        this.renderSlideList();
        this.scheduleSave();
        this.showToast(`Theme "${theme.name}" applied.`);
    }

    applyVariant(v) {
        if (!this.pres) return;
        this.pres.slides.forEach(s => {
            if (!s.background) s.background = { type: 'color', value: '#ffffff' };
            s.background = { type: 'color', value: v.bg };
            s.elements.forEach(el => {
                if (el.type === 'text') el.color = v.fg;
                if (el.type === 'shape' && el.fill && el.fill !== 'none') el.fill = v.accent;
            });
        });
        this.pushHistory();
        this.renderCanvas();
        this.renderSlideList();
        this.scheduleSave();
        this.showToast(`Variant "${v.name}" applied.`);
    }

    showLayoutPicker() {
        const layouts = [
            { name: 'Title Slide',     desc: 'Centered title + subtitle' },
            { name: 'Title and Content', desc: 'Title on top, body below' },
            { name: 'Section Header',  desc: 'Large centered title' },
            { name: 'Two Content',     desc: 'Title + two columns' },
            { name: 'Comparison',      desc: 'Title + side-by-side compare' },
            { name: 'Title Only',      desc: 'Just a title placeholder' },
            { name: 'Blank',           desc: 'Empty slide' },
            { name: 'Content with Caption', desc: 'Caption + content' },
        ];
        const choice = prompt('Choose a layout (1-' + layouts.length + '):\n' + layouts.map((l, i) => `${i + 1}. ${l.name} — ${l.desc}`).join('\n'), '2');
        const idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= layouts.length) return;
        this.applyLayout(layouts[idx]);
    }

    applyLayout(layout) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        slide.elements = [];
        const W = 960, H = 540;
        if (layout.name === 'Blank') { /* nothing */ }
        else if (layout.name === 'Title Slide') {
            slide.elements.push({ ...makeTextEl(W / 2 - 250, 180, 500, 90), fontSize: 54, bold: true, textAlign: 'center', html: 'Click to add title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(W / 2 - 200, 300, 400, 50), fontSize: 24, textAlign: 'center', html: 'Click to add subtitle', color: '#666' });
        } else if (layout.name === 'Title and Content') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 70), fontSize: 36, bold: true, html: 'Click to add title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 130, 840, 360), fontSize: 22, html: 'Click to add text', color: '#333' });
        } else if (layout.name === 'Section Header') {
            slide.elements.push({ ...makeTextEl(W / 2 - 300, 220, 600, 100), fontSize: 60, bold: true, textAlign: 'center', html: 'Section Title', color: '#1a1a1a' });
        } else if (layout.name === 'Two Content') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 70), fontSize: 36, bold: true, html: 'Click to add title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 130, 400, 360), fontSize: 22, html: 'Left column', color: '#333' });
            slide.elements.push({ ...makeTextEl(500, 130, 400, 360), fontSize: 22, html: 'Right column', color: '#333' });
        } else if (layout.name === 'Comparison') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 70), fontSize: 36, bold: true, html: 'Click to add title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 130, 400, 60), fontSize: 24, bold: true, html: 'Option A', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 200, 400, 290), fontSize: 20, html: 'Description...', color: '#333' });
            slide.elements.push({ ...makeTextEl(500, 130, 400, 60), fontSize: 24, bold: true, html: 'Option B', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(500, 200, 400, 290), fontSize: 20, html: 'Description...', color: '#333' });
        } else if (layout.name === 'Title Only') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 70), fontSize: 36, bold: true, html: 'Click to add title', color: '#1a1a1a' });
        } else if (layout.name === 'Content with Caption') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 50), fontSize: 22, bold: true, html: 'Caption', color: '#666' });
            slide.elements.push({ ...makeTextEl(60, 100, 840, 60), fontSize: 32, bold: true, html: 'Title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 170, 840, 320), fontSize: 22, html: 'Content...', color: '#333' });
        }
        this.pushHistory();
        this.renderCanvas();
        this.renderSlideList();
        this.scheduleSave();
        this.showToast(`Layout "${layout.name}" applied.`);
    }

    cycleSlideSize() {
        const sizes = [
            { name: 'Widescreen 16:9', w: 960, h: 540 },
            { name: 'Standard 4:3',    w: 720, h: 540 },
            { name: 'Widescreen 16:10', w: 960, h: 600 },
        ];
        const cur = (this._slideSizeIdx ?? 0);
        const next = (cur + 1) % sizes.length;
        this._slideSizeIdx = next;
        const sz = sizes[next];
        this._slideW = sz.w;
        this._slideH = sz.h;
        const canvas = document.getElementById('slideCanvas');
        if (canvas) { canvas.style.width = sz.w + 'px'; canvas.style.height = sz.h + 'px'; }
        this.fitZoom();
        this.showToast(`Slide size: ${sz.name} (${sz.w}×${sz.h}).`);
    }

    openDesigner() {
        // Pick from a set of auto-layout suggestions
        const designs = [
            { name: 'Hero Title',        apply: () => this.applyLayout({ name: 'Title Slide' }) },
            { name: 'Section Break',     apply: () => this.applyLayout({ name: 'Section Header' }) },
            { name: 'Two-Column Compare',apply: () => this.applyLayout({ name: 'Comparison' }) },
            { name: 'Bullet List',       apply: () => this.applyLayout({ name: 'Title and Content' }) },
        ];
        const choice = prompt('Designer suggestions:\n' + designs.map((d, i) => `${i + 1}. ${d.name}`).join('\n'), '1');
        const idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= designs.length) return;
        designs[idx].apply();
        this.showToast(`Designer applied: ${designs[idx].name}`);
    }

    // ── ANIMATION PREVIEW / REORDER ──
    previewAnimations() {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide || !slide.animations || slide.animations.length === 0) {
            this.showToast('No animations on this slide to preview.');
            return;
        }
        this.showToast('Previewing animations…');
        // Briefly re-trigger the slide render so animations replay
        const canvas = document.getElementById('slideCanvas');
        if (canvas) {
            canvas.style.opacity = '0.3';
            setTimeout(() => { canvas.style.opacity = '1'; this.renderCanvas(); }, 250);
        }
    }

    moveAnimation(delta) {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide || !slide.animations) return;
        const el = this.selectedId ? this.getElement(this.selectedId) : null;
        if (!el || !el.animations) { this.showToast('Select an animated element first.'); return; }
        const animIdx = el.animations.findIndex(a => a.slideIdx === this.slideIdx);
        if (animIdx < 0) return;
        // Move within the element's animations list (re-order)
        const arr = el.animations;
        const target = animIdx + delta;
        if (target < 0 || target >= arr.length) return;
        [arr[animIdx], arr[target]] = [arr[target], arr[animIdx]];
        this.scheduleSave();
        this.renderAnimationPane();
        this.showToast(delta < 0 ? 'Moved earlier.' : 'Moved later.');
    }

    // ── IMMERSIVE READER ──
    openImmersiveReader() {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide) return;
        const text = slide.elements
            .filter(e => e.type === 'text' && e.html)
            .map(e => e.html.replace(/<[^>]+>/g, ' '))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) { this.showToast('No text to read on this slide.'); return; }
        const overlay = document.createElement('div');
        overlay.id = 'immersiveReaderOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:#fffdf7;z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;font-family:"DM Sans",sans-serif;color:#1a1a1a;';
        overlay.innerHTML = `
            <div style="max-width:720px;font-size:24px;line-height:1.7;text-align:center;">${text}</div>
            <div style="margin-top:32px;display:flex;gap:12px;">
                <button id="irClose" style="padding:10px 20px;background:#f97316;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;">Close (Esc)</button>
                <button id="irRead" style="padding:10px 20px;background:#fff;color:#1a1a1a;border:1px solid #ddd;border-radius:6px;font-size:14px;cursor:pointer;">Read Aloud</button>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector('#irClose').addEventListener('click', close);
        overlay.querySelector('#irRead').addEventListener('click', () => {
            if ('speechSynthesis' in window) {
                const u = new SpeechSynthesisUtterance(text);
                speechSynthesis.cancel();
                speechSynthesis.speak(u);
            } else {
                this.showToast('Speech synthesis not supported in this browser.');
            }
        });
        const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
        document.addEventListener('keydown', escHandler);
    }

    // ── REVIEW FEATURES ──
    spellCheck() {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide) return;
        // Naive spell-check: very common typos (placeholder until a real dictionary is loaded)
        const dict = { teh: 'the', recieve: 'receive', occured: 'occurred', seperate: 'separate', definately: 'definitely', tommorow: 'tomorrow', wich: 'which', thier: 'their' };
        let count = 0;
        slide.elements.forEach(el => {
            if (el.type !== 'text' || !el.html) return;
            let html = el.html;
            Object.entries(dict).forEach(([bad, good]) => {
                const re = new RegExp(`\\b${bad}\\b`, 'gi');
                if (re.test(html)) { html = html.replace(re, good); count++; }
            });
            el.html = html;
        });
        if (count > 0) { this.pushHistory(); this.renderCanvas(); this.scheduleSave(); this.showToast(`Fixed ${count} spelling issue(s).`); }
        else this.showToast('No spelling issues found.');
    }

    showWordCount() {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide) { this.showToast('No slide selected.'); return; }
        let words = 0, chars = 0, paras = 0;
        slide.elements.forEach(el => {
            if (el.type === 'text' && el.html) {
                const text = el.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (text) {
                    words += text.split(' ').length;
                    chars += text.length;
                    paras += text.split(/\n+/).length;
                }
            }
        });
        this.showHelpModal('Word Count', [
            `Slides: ${this.pres.slides.length}`,
            `Words on this slide: ${words}`,
            `Characters: ${chars}`,
            `Paragraphs: ${paras}`,
        ]);
    }

    checkAccessibility() {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide) return;
        const issues = [];
        slide.elements.forEach(el => {
            if (el.type === 'image' && !el.alt) issues.push(`Image at (${Math.round(el.x)}, ${Math.round(el.y)}) is missing alt text.`);
            if (el.type === 'text' && el.html) {
                const txt = el.html.replace(/<[^>]+>/g, '');
                if (txt.length > 200) issues.push(`Long text block (${txt.length} chars) — consider breaking up.`);
                if (el.fontSize && el.fontSize < 14) issues.push(`Small font (${el.fontSize}px) may be hard to read.`);
            }
        });
        if (issues.length === 0) this.showToast('No accessibility issues detected.');
        else this.showHelpModal('Accessibility Issues', issues);
    }

    editAltText() {
        const el = this.selectedId ? this.getElement(this.selectedId) : null;
        if (!el || el.type !== 'image') { this.showToast('Select an image to add alt text.'); return; }
        const cur = el.alt || '';
        const v = prompt('Alt text for this image:', cur);
        if (v !== null) { el.alt = v.trim(); this.pushHistory(); this.scheduleSave(); this.showToast(v.trim() ? 'Alt text saved.' : 'Alt text cleared.'); }
    }

    translateSelection() {
        const el = this.selectedId ? this.getElement(this.selectedId) : null;
        if (!el || el.type !== 'text' || !el.html) { this.showToast('Select a text element to translate.'); return; }
        const langs = ['Spanish', 'French', 'German', 'Indonesian', 'Japanese', 'Chinese'];
        const choice = prompt('Translate to:\n' + langs.map((l, i) => `${i + 1}. ${l}`).join('\n'), '4');
        const idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= langs.length) return;
        const lang = langs[idx];
        const codes = { Spanish: 'es', French: 'fr', German: 'de', Indonesian: 'id', Japanese: 'ja', Chinese: 'zh' };
        const text = el.html.replace(/<[^>]+>/g, '');
        const url = `https://translate.google.com/?sl=auto&tl=${codes[lang]}&text=${encodeURIComponent(text)}&op=translate`;
        window.open(url, '_blank');
        this.showToast(`Opening ${lang} translation in a new tab…`);
    }

    setLanguage() {
        const langs = ['English (US)', 'English (UK)', 'Indonesian', 'Spanish', 'French', 'German', 'Japanese', 'Chinese (Simplified)'];
        const choice = prompt('Set proofing language:\n' + langs.map((l, i) => `${i + 1}. ${l}`).join('\n'), '1');
        const idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= langs.length) return;
        this._proofLang = langs[idx];
        this.showToast(`Proofing language: ${langs[idx]}`);
    }

    // ── HELP MODAL ──
    showHelpModal(title, lines) {
        const overlay = document.createElement('div');
        overlay.className = 'link-modal';
        overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;';
        const list = Array.isArray(lines) ? lines : [lines];
        const items = list.map(l => Array.isArray(l)
            ? `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;"><strong>${l[0]}</strong><span>${l[1]}</span></div>`
            : `<div style="padding:6px 0;border-bottom:1px solid #f0f0f0;">${l}</div>`
        ).join('');
        overlay.innerHTML = `
            <div class="link-modal-content" style="max-width:520px;">
                <div class="link-modal-header">
                    <h3 class="link-modal-title">${title}</h3>
                    <button class="link-modal-close" title="Close" style="background:transparent;border:none;color:#666;font-size:22px;cursor:pointer;margin-left:auto;">&times;</button>
                </div>
                <div class="link-modal-body" style="max-height:60vh;overflow-y:auto;">
                    ${items}
                </div>
                <div class="link-modal-actions">
                    <button class="link-modal-btn link-modal-btn-create" style="background:#f97316;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;">Close</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector('.link-modal-close').addEventListener('click', close);
        overlay.querySelector('.link-modal-btn-create').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }

    // ── INSERT: Icon / Chart / Link / Comment / Symbol ──
    openIconPicker() {
        const icons = [
            { name: 'Check',     svg: '<polyline points="20 6 9 17 4 12"/>' },
            { name: 'Star',      svg: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },
            { name: 'Heart',     svg: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>' },
            { name: 'Bell',      svg: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>' },
            { name: 'Home',      svg: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
            { name: 'Mail',      svg: '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/>' },
            { name: 'Calendar',  svg: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
            { name: 'User',      svg: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
            { name: 'Settings',  svg: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
            { name: 'Search',    svg: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
            { name: 'Cloud',     svg: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>' },
            { name: 'Lock',      svg: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' },
        ];
        const overlay = document.createElement('div');
        overlay.className = 'link-modal';
        overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div class="link-modal-content" style="max-width:480px;">
                <div class="link-modal-header"><h3 class="link-modal-title">Insert Icon</h3>
                    <button class="link-modal-close" style="background:transparent;border:none;color:#666;font-size:22px;cursor:pointer;margin-left:auto;">&times;</button>
                </div>
                <div class="link-modal-body">
                    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;">
                        ${icons.map((ic, i) => `
                            <button class="icon-pick" data-idx="${i}" title="${ic.name}" style="padding:10px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ic.svg}</svg>
                            </button>
                        `).join('')}
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector('.link-modal-close').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelectorAll('.icon-pick').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx, 10);
                const ic = icons[idx];
                const svgStr = `<svg viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block;">${ic.svg}</svg>`;
                const el = { id: uid(), type: 'shape', x: 380, y: 220, w: 80, h: 80, r: 0, z: 1, shape: 'icon', svg: svgStr, fill: 'none', stroke: '#1a1a1a', strokeWidth: 2, opacity: 1 };
                this.addElement(el);
                this.showToast(`Inserted "${ic.name}" icon.`);
                close();
            });
        });
    }

    insertChart() {
        const types = [
            { name: 'Bar Chart',        svg: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 17V10M12 17V7M17 17v-4"/>' },
            { name: 'Line Chart',       svg: '<polyline points="3 17 9 11 13 15 21 7"/><rect x="3" y="3" width="18" height="18" rx="2"/>' },
            { name: 'Pie Chart',        svg: '<path d="M21 12a9 9 0 1 1-9-9v9z"/><circle cx="12" cy="12" r="9"/>' },
            { name: 'Donut Chart',      svg: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>' },
        ];
        const choice = prompt('Choose chart type:\n' + types.map((t, i) => `${i + 1}. ${t.name}`).join('\n'), '1');
        const idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= types.length) return;
        const type = types[idx];
        // Insert a chart as an SVG image element
        const w = 480, h = 280;
        const svgStr = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;">
            <rect width="${w}" height="${h}" fill="#fff" stroke="#e5e7eb" rx="8"/>
            <text x="${w/2}" y="30" text-anchor="middle" font-family="DM Sans" font-size="16" font-weight="700" fill="#1a1a1a">${type.name}</text>
            ${type.svg.replace(/<(rect|polyline|path|circle)([^>]*)>/g, (m, tag, attrs) => `<${tag}${attrs} transform="translate(40, 50) scale(0.85)"/>`)}
        </svg>`;
        const el = { id: uid(), type: 'shape', x: 240, y: 130, w, h, r: 0, z: 1, shape: 'chart', svg: svgStr, fill: 'none', stroke: 'none', strokeWidth: 0, opacity: 1 };
        this.addElement(el);
        this.showToast(`${type.name} inserted. (Demo placeholder)`);
    }

    openLinkModal() {
        const el = this.selectedId ? this.getElement(this.selectedId) : null;
        if (!el || el.type !== 'text') { this.showToast('Select a text element to add a link.'); return; }
        const url = prompt('Link URL:', 'https://');
        if (!url || !url.trim()) return;
        el.link = url.trim();
        this.pushHistory();
        this.scheduleSave();
        this.showToast(`Linked to ${url.trim()}.`);
    }

    insertComment() {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        const text = prompt('Comment:');
        if (!text || !text.trim()) return;
        if (!slide.comments) slide.comments = [];
        slide.comments.push({ id: uid(), text: text.trim(), author: 'You', ts: Date.now(), x: 100, y: 100 });
        this.scheduleSave();
        this.showToast('Comment added.');
    }

    openSymbolPicker() {
        const symbols = ['★','☆','✓','✗','♥','♦','♣','♠','→','←','↑','↓','↔','↕','⇒','⇐','⇑','⇓','∞','∴','∵','≈','≠','≤','≥','±','×','÷','∑','∏','∫','∂','∇','√','∝','∠','⊥','∼','≡','∈','∉','⊂','⊃','∪','∩','∀','∃','ƒ','ℵ','π','ε','μ','Ω','α','β','γ','δ','λ','σ','φ','ψ','ω','Σ','Π','Δ','Γ','Θ','Λ','Φ','Ψ','Ω','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','●','○','■','□','▲','△','▼','▽','◆','◇','✔','✘','✚','✦','✧','✩','✪','✫','✬','✭','✮','✯','✰','✱','✲','✳','✴','✵','✶','✷','✸','✹','✺','✻','✼','✽','✾','✿','❀','❁','❂','❃','❄','❅','❆','❇','❈','❉','❊','❋'];
        const overlay = document.createElement('div');
        overlay.className = 'link-modal';
        overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div class="link-modal-content" style="max-width:520px;">
                <div class="link-modal-header"><h3 class="link-modal-title">Insert Symbol</h3>
                    <button class="link-modal-close" style="background:transparent;border:none;color:#666;font-size:22px;cursor:pointer;margin-left:auto;">&times;</button>
                </div>
                <div class="link-modal-body" style="max-height:50vh;overflow-y:auto;">
                    <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:4px;">
                        ${symbols.map((s, i) => `<button class="sym-pick" data-s="${s}" style="padding:8px;background:#fff;border:1px solid #e5e7eb;border-radius:4px;cursor:pointer;font-size:18px;">${s}</button>`).join('')}
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector('.link-modal-close').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelectorAll('.sym-pick').forEach(btn => {
            btn.addEventListener('click', () => {
                const s = btn.dataset.s;
                const el = makeTextEl(380, 220, 80, 80);
                el.html = s; el.fontSize = 48; el.textAlign = 'center';
                this.addElement(el);
                this.showToast(`Inserted "${s}".`);
                close();
            });
        });
    }

    setZoom(scale) {
        this.scale = clamp(scale, 0.2, 4);
        const scaler = document.getElementById('slideCanvasScaler');
        if (scaler) scaler.style.transform = `scale(${this.scale})`;
        const zs = document.getElementById('zoomStatus');
        if (zs) zs.textContent = Math.round(this.scale * 100) + '%';
    }

    fitZoom() {
        const wrapper = document.getElementById('slideCanvasWrapper');
        if (!wrapper) { this.setZoom(1); return; }
        const rect = wrapper.getBoundingClientRect();
        const padding = 40;
        const sx = (rect.width - padding) / 960;
        const sy = (rect.height - padding) / 540;
        this.setZoom(Math.min(sx, sy, 1));
    }

    setupSidebarToggle() {
        document.getElementById('sidebarToggle')?.addEventListener('click', () => {
            const sidebar = document.getElementById('slidesSidebar');
            if (!sidebar) return;
            // On mobile (<=1023px), use mobile-open class for off-canvas slide-in
            // On desktop, use collapsed class for the 60px mini-sidebar
            if (window.innerWidth <= 1023) {
                sidebar.classList.toggle('mobile-open');
                // Also toggle a backdrop for mobile
                let backdrop = document.querySelector('.sidebar-backdrop');
                if (!backdrop) {
                    backdrop = document.createElement('div');
                    backdrop.className = 'sidebar-backdrop';
                    backdrop.addEventListener('click', () => {
                        sidebar.classList.remove('mobile-open');
                        backdrop.classList.remove('visible');
                    });
                    sidebar.parentElement.insertBefore(backdrop, sidebar.nextSibling);
                }
                if (sidebar.classList.contains('mobile-open')) {
                    backdrop.classList.add('visible');
                } else {
                    backdrop.classList.remove('visible');
                }
            } else {
                sidebar.classList.toggle('collapsed');
            }
        });
    }

    // ── Ribbon State Update ────────────────────────────────────
    updateRibbonState() {
        const el = this.selectedId ? this.getElement(this.selectedId) : null;
        const isText  = el?.type === 'text';
        const isShape = el?.type === 'shape';
        const isImg   = el?.type === 'image';
        const hasEl   = !!el;

        // Text format group visibility — dim + disable interaction when no text element is selected
        const tfg = document.getElementById('textFormatGroup');
        if (tfg) {
            tfg.style.opacity = isText ? '1' : '0.45';
            tfg.style.pointerEvents = isText ? 'auto' : 'none';
        }

        // Paragraph group visibility — dim + disable interaction when no text element is selected
        const pg = document.getElementById('paragraphGroup');
        if (pg) {
            pg.style.opacity = isText ? '1' : '0.45';
            pg.style.pointerEvents = isText ? 'auto' : 'none';
        }

        // Shape Format contextual tab — show only when a shape is selected
        const shapeTab = document.getElementById('shapeFormatTab');
        if (shapeTab) {
            const wasHidden = shapeTab.hasAttribute('hidden');
            if (isShape) {
                shapeTab.removeAttribute('hidden');
                // Auto-switch to Shape Format tab when a shape is first selected
                if (wasHidden && this._activeTab !== 'shape-format') {
                    this._previousTab = this._activeTab;
                    shapeTab.click();
                }
            } else {
                // Hide tab — if it was active, return to the previous tab (or Home)
                if (this._activeTab === 'shape-format') {
                    const restoreTab = this._previousTab && this._previousTab !== 'shape-format'
                        ? this._previousTab
                        : 'home';
                    const restoreBtn = document.querySelector(`.ribbon-tab[data-tab="${restoreTab}"]`);
                    restoreBtn?.click();
                }
                shapeTab.setAttribute('hidden', '');
            }
        }

        // Arrange group: enable only when element selected
        const ag = document.getElementById('arrangeGroup');
        if (ag) {
            ag.style.opacity = hasEl ? '1' : '0.45';
            ag.style.pointerEvents = hasEl ? 'auto' : 'none';
        }

        // Background group — dim when no slide is active
        const bgGroup = document.getElementById('backgroundGroup');
        if (bgGroup) {
            bgGroup.style.opacity = this.currentSlide ? '1' : '0.45';
            bgGroup.style.pointerEvents = this.currentSlide ? 'auto' : 'none';
        }

        // Slide Show group — dim when no presentation is open
        const ssGroup = document.getElementById('slideShowGroup');
        if (ssGroup) {
            ssGroup.style.opacity = this.pres ? '1' : '0.45';
            ssGroup.style.pointerEvents = this.pres ? 'auto' : 'none';
        }

        // Export group — dim when no presentation is open
        const expGroup = document.getElementById('exportGroup');
        if (expGroup) {
            expGroup.style.opacity = this.pres ? '1' : '0.45';
            expGroup.style.pointerEvents = this.pres ? 'auto' : 'none';
        }

        // Update format button active states
        if (isText) {
            document.getElementById('boldBtn')?.classList.toggle('active', el.bold);
            document.getElementById('italicBtn')?.classList.toggle('active', el.italic);
            document.getElementById('underlineBtn')?.classList.toggle('active', el.underline);

            // Alignment active state — highlight the currently active alignment
            const align = el.textAlign || 'left';
            document.getElementById('alignLeftBtn')?.classList.toggle('active', align === 'left');
            document.getElementById('alignCenterBtn')?.classList.toggle('active', align === 'center');
            document.getElementById('alignRightBtn')?.classList.toggle('active', align === 'right');

            // List active state — verify against actual HTML content, not just el.listType
            // (el.listType can become stale when user deletes all list items with backspace)
            let effectiveListType = el.listType || '';
            const contentEl = document.getElementById(`el-${el.id}`)?.querySelector('.text-content');
            if (contentEl) {
                // Only count real (non-empty) lists
                const hasRealOl = this._hasRealList(contentEl, 'ol');
                const hasRealUl = this._hasRealList(contentEl, 'ul');
                if (hasRealOl) effectiveListType = 'ol';
                else if (hasRealUl) effectiveListType = 'ul';
                else effectiveListType = '';
                // Keep el.listType in sync
                el.listType = effectiveListType;
            }
            document.getElementById('bulletListBtn')?.classList.toggle('active', effectiveListType === 'ul');
            document.getElementById('numberListBtn')?.classList.toggle('active', effectiveListType === 'ol');
            // Font family
            const ffVal = document.getElementById('fontFamilyDropdown')?.querySelector('.dropdown-value');
            if (ffVal) ffVal.textContent = el.fontFamily || 'DM Sans';
            // Font size
            const fsVal = document.getElementById('fontSizeDropdown')?.querySelector('.dropdown-value');
            if (fsVal) fsVal.textContent = el.fontSize || 24;
            // Text color swatch (notes-app style dropdown)
            const fcBtn = document.querySelector('#fontColorDropdown .ms-dropdown-btn');
            const fcSwatch = fcBtn?.querySelector('.color-preview');
            if (fcSwatch) {
                fcSwatch.style.background = el.color || '#000000';
                fcSwatch.style.border = '';
            }
            // Text highlight swatch (notes-app style dropdown)
            const hlBtn = document.querySelector('#highlightColorDropdown .ms-dropdown-btn');
            const hlSwatch = hlBtn?.querySelector('.color-preview');
            if (hlSwatch) {
                if (el.highlight) {
                    hlSwatch.style.background = el.highlight;
                    hlSwatch.style.border = '';
                } else {
                    hlSwatch.style.background = 'transparent';
                    hlSwatch.style.border = '1px solid #ccc';
                }
            }
        }

        // Clear alignment active states when no text element is selected
        if (!isText) {
            document.getElementById('alignLeftBtn')?.classList.remove('active');
            document.getElementById('alignCenterBtn')?.classList.remove('active');
            document.getElementById('alignRightBtn')?.classList.remove('active');
            document.getElementById('bulletListBtn')?.classList.remove('active');
            document.getElementById('numberListBtn')?.classList.remove('active');
        }

        if (isShape) {
            const fillSwatch = document.getElementById('fillColorSwatch');
            if (fillSwatch) fillSwatch.style.background = el.fill === 'none' ? 'transparent' : el.fill;
            const swInput = document.getElementById('strokeWidthInput');
            if (swInput) swInput.value = el.strokeWidth || 2;
        }
    }

    updateStatusBar() {
        const numEl = document.getElementById('slideNumStatus');
        if (numEl && this.pres) {
            numEl.textContent = `Slide ${this.slideIdx + 1} of ${this.pres.slides.length}`;
        }
        const elEl = document.getElementById('elementStatus');
        if (elEl) {
            const el = this.selectedId ? this.getElement(this.selectedId) : null;
            elEl.textContent = el ? `${el.type.charAt(0).toUpperCase() + el.type.slice(1)} selected` : 'No selection';
        }
    }

    // ── Delete Modal (presentations only — slide deletion is direct & undoable) ──
    confirmDeletePresentation(id) {
        this._deleteTarget = { type: 'pres', id };
        document.getElementById('deleteModalTitle').textContent = 'Delete Presentation';
        document.getElementById('deleteModalMessage').textContent = 'Are you sure you want to delete this presentation? This cannot be undone.';
        document.getElementById('deleteModal')?.classList.add('show');
    }

    closeDeleteModal() {
        document.getElementById('deleteModal')?.classList.remove('show');
        this._deleteTarget = null;
    }

    confirmDelete() {
        if (!this._deleteTarget) { this.closeDeleteModal(); return; }
        const target = this._deleteTarget;
        // Close modal FIRST (which nulls _deleteTarget) but we already captured `target`
        document.getElementById('deleteModal')?.classList.remove('show');
        this._deleteTarget = null;
        if (target.type === 'pres') this.deletePresentation(target.id);
    }

    // ── Background Picker ──────────────────────────────────────
    openBgPicker() {
        if (!this.currentSlide) return;
        this._pendingBgValue = this.currentSlide.background.value;
        const customInput = document.getElementById('bgColorCustom');
        if (customInput && !this._pendingBgValue.includes('gradient')) customInput.value = this._pendingBgValue;
        document.getElementById('bgPickerModal')?.classList.add('show');
    }

    closeBgPicker() {
        document.getElementById('bgPickerModal')?.classList.remove('show');
    }

    applyBgPicker() {
        if (!this.currentSlide || !this._pendingBgValue) { this.closeBgPicker(); return; }
        this.pushHistory();
        const isGradient = this._pendingBgValue.includes('gradient');
        this.currentSlide.background = {
            type: isGradient ? 'gradient' : 'color',
            value: this._pendingBgValue,
        };
        this.renderCanvas();
        this.updateThumbnail(this.slideIdx);
        this.scheduleSave();
        this.closeBgPicker();
    }

    // ── Welcome Screen ─────────────────────────────────────────
    showWelcomeScreen(show) {
        const ws  = document.getElementById('welcomeScreen');
        const eh  = document.getElementById('editorHeader');
        const ec  = document.getElementById('editorContent');
        const es  = document.getElementById('editorStatusbar');
        const pn  = document.getElementById('presenterNotesPanel');
        if (!ws) return;

        if (show) {
            ws.style.display = 'flex';
            if (eh) eh.style.display = 'none';
            if (ec) ec.style.display = 'none';
            if (es) es.style.display = 'none';
            // Presenter notes panel: just remove .visible to collapse
            if (pn) pn.classList.remove('visible');
            this.renderWelcomeCards();
        } else {
            ws.style.display = 'none';
            if (eh) eh.style.display = 'flex';
            if (ec) {
                ec.style.display = 'flex';
                ec.style.flexDirection = 'column';
                ec.style.flex = '1';
                ec.style.overflow = 'hidden';
                ec.style.minHeight = '0';
            }
            // Presenter notes panel visibility is controlled by the toggle button (CSS .visible class)
            // Do not force-display here — keep whatever state the user last chose
            if (es) es.style.display = 'flex';
        }
    }

    renderWelcomeCards() {
        const container = document.getElementById('presentationsDisplay');
        const noContainer = document.getElementById('noPresContainer');
        if (!container) return;

        // ── Render-token guard ──
        // Each call gets a unique token. We capture the token at call time
        // and check it again before mutating the DOM after any await. If a
        // newer render has started, this render aborts silently — preventing
        // the classic "async forEach appends stale cards on top of newer
        // ones" race that produced duplicate cards on the welcome screen.
        const myToken = (this._welcomeRenderToken = (this._welcomeRenderToken || 0) + 1);

        if (this.presentations.length === 0) {
            container.innerHTML = '';
            if (noContainer) noContainer.style.display = 'flex';
            return;
        }

        if (noContainer) noContainer.style.display = 'none';

        // Snapshot the list at call time so concurrent edits to
        // `this.presentations` don't change what we render mid-flight.
        const snapshot = this.presentations.slice(0, 12);

        // Load all deck previews in parallel, build all card elements in
        // memory, then commit them to the DOM in ONE synchronous operation.
        // This eliminates any window where stale appends can sneak in.
        Promise.all(snapshot.map(async (meta) => {
            const presData = await this.loadPresData(meta.id);
            return { meta, presData };
        })).then(results => {
            // Stale render — a newer renderWelcomeCards() call has started.
            // Abort to avoid appending duplicate cards.
            if (myToken !== this._welcomeRenderToken) return;

            // Build all card elements in memory first
            const frag = document.createDocumentFragment();
            for (const { meta, presData } of results) {
                const card = document.createElement('div');
                card.className = 'presentation-card';

                const thumb = document.createElement('div');
                thumb.className = 'presentation-card-thumb';
                thumb.style.background = '#f5f5f5';

                if (presData && presData.slides && presData.slides[0]) {
                    const slide = presData.slides[0];
                    const inner = document.createElement('div');
                    inner.className = 'presentation-card-thumb-inner';
                    inner.style.background = slide.background?.value || '#fff';
                    this.renderThumbContent(inner, slide);
                    thumb.appendChild(inner);
                    requestAnimationFrame(() => {
                        const w = thumb.clientWidth || 220;
                        const s = w / 960;
                        inner.style.transform = `scale(${s})`;
                        inner.style.height = Math.round(540 * s) + 'px';
                        thumb.style.height = Math.round(540 * s) + 'px';
                    });
                }

                const delBtn = document.createElement('button');
                delBtn.className = 'presentation-card-del';
                delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
                delBtn.title = 'Delete presentation';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.confirmDeletePresentation(meta.id);
                });

                const info = document.createElement('div');
                info.className = 'presentation-card-info';
                info.innerHTML = `
                    <div class="presentation-card-title">${meta.title || 'Untitled'}</div>
                    <div class="presentation-card-meta">${meta.slideCount || 1} slide${(meta.slideCount || 1) !== 1 ? 's' : ''} · ${formatDate(meta.updatedAt)}</div>
                `;

                card.appendChild(thumb);
                card.appendChild(delBtn);
                card.appendChild(info);
                card.addEventListener('click', () => this.openPresentation(meta.id));
                frag.appendChild(card);
            }

            // ── Single atomic DOM commit ──
            // Clear + append in the same synchronous tick — no async gap
            // between clear and append means no chance for a stale render
            // to slip cards in between.
            container.innerHTML = '';
            container.appendChild(frag);
        }).catch(err => {
            console.warn('renderWelcomeCards failed:', err);
        });
    }

    // ── Presentation Mode ──────────────────────────────────────
    startPresentation(fromSlide = 0) {
        if (!this.pres || this.pres.slides.length === 0) return;
        this.presentIdx = clamp(fromSlide, 0, this.pres.slides.length - 1);
        this.isPresenting = true;

        const overlay = document.getElementById('presentOverlay');
        if (!overlay) return;
        overlay.style.display = 'block';
        requestAnimationFrame(() => { overlay.style.opacity = '1'; });

        this.renderPresentSlide();
        this.buildPresentDots();
        this.updatePresentCounter();

        document.addEventListener('keydown', this._presentKeyHandler);
        document.getElementById('presentPrevBtn')?.addEventListener('click', () => this.presentPrev());
        document.getElementById('presentNextBtn')?.addEventListener('click', () => this.presentNext());
        document.getElementById('presentExitBtn')?.addEventListener('click', () => this.endPresentation());

        // Try fullscreen – re-render slide once the viewport actually resizes
        this._presentFullscreenHandler = () => {
            if (this.isPresenting) this.renderPresentSlide();
        };
        this._presentResizeHandler = () => {
            if (this.isPresenting) this.renderPresentSlide();
        };
        document.addEventListener('fullscreenchange', this._presentFullscreenHandler);
        window.addEventListener('resize', this._presentResizeHandler);
        try { document.documentElement.requestFullscreen?.(); } catch (_) {}
    }

    endPresentation() {
        this.isPresenting = false;
        const overlay = document.getElementById('presentOverlay');
        if (overlay) overlay.style.display = 'none';
        document.removeEventListener('keydown', this._presentKeyHandler);
        if (this._presentFullscreenHandler) document.removeEventListener('fullscreenchange', this._presentFullscreenHandler);
        if (this._presentResizeHandler) window.removeEventListener('resize', this._presentResizeHandler);
        this._presentFullscreenHandler = null;
        this._presentResizeHandler = null;
        try { document.exitFullscreen?.(); } catch (_) {}
    }

    _presentKeyHandler = (e) => {
        if (!this.isPresenting) return;
        if (e.key === 'Escape')      this.endPresentation();
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); this.presentNext(); }
        if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); this.presentPrev(); }
    };

    presentNext() {
        if (this.presentIdx >= this.pres.slides.length - 1) return;
        this.presentIdx++;
        this.renderPresentSlide('right');
        this.updatePresentCounter();
    }

    presentPrev() {
        if (this.presentIdx <= 0) return;
        this.presentIdx--;
        this.renderPresentSlide('left');
        this.updatePresentCounter();
    }

    renderPresentSlide(direction = null) {
        const container = document.getElementById('presentSlide');
        if (!container || !this.pres) return;

        const slide = this.pres.slides[this.presentIdx];
        if (!slide) return;

        // Scale to viewport
        const vw = window.innerWidth, vh = window.innerHeight;
        const scaleX = vw / 960, scaleY = vh / 540;
        const pScale = Math.min(scaleX, scaleY);

        // Store scale as CSS custom property so animations can include it
        container.style.setProperty('--present-scale', pScale);
        container.style.transform = `scale(var(--present-scale, ${pScale}))`;
        container.style.width = '960px';
        container.style.height = '540px';

        // Background
        const bg = slide.background;
        container.style.background = bg.type !== 'image' ? bg.value : '#fff';

        // Elements
        container.innerHTML = '';
        const sorted = [...slide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
        sorted.forEach(el => {
            const d = document.createElement('div');
            d.style.cssText = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;transform:rotate(${el.r || 0}deg);z-index:${el.z || 1};overflow:hidden;`;
            if (el.type === 'text') {
                d.style.fontFamily = el.fontFamily || 'DM Sans';
                d.style.fontSize = (el.fontSize || 24) + 'px';
                d.style.color = el.color || '#1a1a1a';
                d.style.fontWeight = el.bold ? '700' : '400';
                d.style.fontStyle = el.italic ? 'italic' : 'normal';
                d.style.textDecoration = el.underline ? 'underline' : 'none';
                d.style.textAlign = el.textAlign || 'left';
                d.style.backgroundColor = el.highlight || 'transparent';
                d.style.padding = '8px 10px';
                d.style.wordBreak = 'break-word';
                d.style.whiteSpace = 'pre-wrap';
                d.innerHTML = el.html || '';
            } else if (el.type === 'shape') {
                d.innerHTML = shapeSVG(el.shape, el.fill, el.stroke, el.strokeWidth);
            } else if (el.type === 'image') {
                const crop = el.crop || { l: 0, t: 0, r: 0, b: 0 };
                const visibleW = 1 - crop.l - crop.r;
                const visibleH = 1 - crop.t - crop.b;
                const img = document.createElement('img');
                img.src = el.src;
                if (visibleW <= 0 || visibleH <= 0) {
                    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                } else if (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) {
                    const scaleW = 1 / visibleW;
                    const scaleH = 1 / visibleH;
                    img.style.cssText = `position:absolute;top:0;left:0;width:${scaleW * 100}%;height:${scaleH * 100}%;transform:translate(${-crop.l * scaleW * 100}%, ${-crop.t * scaleH * 100}%);object-fit:fill;display:block;`;
                } else {
                    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                }
                d.appendChild(img);
            } else if (el.type === 'video') {
                // Custom video player in presentation mode
                d.style.overflow = 'hidden';
                const player = document.createElement('div');
                player.className = 'slide-video-player paused';
                player.style.cssText = 'position:absolute;inset:0;';
                const vid = document.createElement('video');
                vid.src = el.src;
                vid.preload = 'metadata';
                vid.setAttribute('poster', el.poster || '');
                vid.setAttribute('playsinline', '');
                const bigPlay = document.createElement('div');
                bigPlay.className = 'vid-big-play';
                bigPlay.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
                const controls = document.createElement('div');
                controls.className = 'vid-controls';
                const progWrap = document.createElement('div');
                progWrap.className = 'vid-progress-wrap';
                const bufferBar = document.createElement('div');
                bufferBar.className = 'vid-buffer-bar';
                const progBar = document.createElement('div');
                progBar.className = 'vid-progress-bar';
                progWrap.appendChild(bufferBar);
                progWrap.appendChild(progBar);
                const btns = document.createElement('div');
                btns.className = 'vid-btns';
                const playBtn = document.createElement('button');
                playBtn.className = 'vid-btn';
                playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
                const timeEl = document.createElement('span');
                timeEl.className = 'vid-time';
                timeEl.textContent = '0:00 / 0:00';
                const spacer = document.createElement('div');
                spacer.className = 'vid-spacer';
                const volWrap = document.createElement('div');
                volWrap.className = 'vid-vol-wrap';
                const volBtn = document.createElement('button');
                volBtn.className = 'vid-btn';
                volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
                const volSlider = document.createElement('input');
                volSlider.type = 'range';
                volSlider.className = 'vid-vol-slider';
                volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
                volWrap.appendChild(volBtn);
                volWrap.appendChild(volSlider);
                const fsBtn = document.createElement('button');
                fsBtn.className = 'vid-btn';
                fsBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
                btns.appendChild(playBtn);
                btns.appendChild(timeEl);
                btns.appendChild(spacer);
                btns.appendChild(volWrap);
                btns.appendChild(fsBtn);
                controls.appendChild(progWrap);
                controls.appendChild(btns);
                player.appendChild(vid);
                player.appendChild(bigPlay);
                player.appendChild(controls);
                d.appendChild(player);
                this._wireVideoPlayer(player, vid, { bigPlay, playBtn, timeEl, progWrap, progBar, bufferBar, volBtn, volSlider, fsBtn });
            } else if (el.type === 'audio') {
                // Custom audio player in presentation mode
                d.style.overflow = 'hidden';
                const player = document.createElement('div');
                player.className = 'slide-audio-player';
                player.style.cssText = 'position:absolute;inset:0;';
                const art = document.createElement('div');
                art.className = 'aud-art';
                const wave = document.createElement('div');
                wave.className = 'aud-wave';
                for (let i = 0; i < 5; i++) wave.appendChild(document.createElement('span'));
                art.appendChild(wave);
                const audCtrl = document.createElement('div');
                audCtrl.className = 'aud-controls';
                const progWrap = document.createElement('div');
                progWrap.className = 'aud-progress-wrap';
                const progBar = document.createElement('div');
                progBar.className = 'aud-progress-bar';
                progWrap.appendChild(progBar);
                const btns = document.createElement('div');
                btns.className = 'aud-btns';
                const playBtn = document.createElement('button');
                playBtn.className = 'aud-play-btn';
                playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
                const timeEl = document.createElement('span');
                timeEl.className = 'aud-time';
                timeEl.textContent = '0:00';
                const spacer = document.createElement('div');
                spacer.className = 'aud-spacer';
                const volWrap = document.createElement('div');
                volWrap.className = 'aud-vol-wrap';
                const volBtn = document.createElement('button');
                volBtn.className = 'aud-btn';
                volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
                const volSlider = document.createElement('input');
                volSlider.type = 'range';
                volSlider.className = 'aud-vol-slider';
                volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
                volWrap.appendChild(volBtn);
                volWrap.appendChild(volSlider);
                btns.appendChild(playBtn);
                btns.appendChild(timeEl);
                btns.appendChild(spacer);
                btns.appendChild(volWrap);
                audCtrl.appendChild(progWrap);
                audCtrl.appendChild(btns);
                const aud = document.createElement('audio');
                aud.src = el.src;
                aud.preload = 'metadata';
                player.appendChild(art);
                player.appendChild(audCtrl);
                player.appendChild(aud);
                d.appendChild(player);
                this._wireAudioPlayer(player, aud, { playBtn, timeEl, progWrap, progBar, volBtn, volSlider });
            }
            container.appendChild(d);
        });

        // Render the saved drawing overlay on top of all elements.
        // The drawing was created in the editor as a 960x540 PNG; we
        // just drop it as an <img> covering the whole slide. It's
        // non-interactive (pointer-events:none) so it never blocks clicks.
        if (slide.drawingData) {
            const drawImg = document.createElement('img');
            drawImg.src = slide.drawingData;
            drawImg.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px;pointer-events:none;z-index:9998;display:block;';
            drawImg.alt = '';
            container.appendChild(drawImg);
        }

        // Animation — use the slide's configured transition if available,
        // otherwise fall back to the default fade/slide.
        // All animations are opacity-only or clip-path based to preserve
        // the inline transform:scale(...) that fits the slide to viewport.
        const trType = slide.transition?.type || null;
        const trDur = slide.transition?.duration || 0.7;
        container.style.setProperty('--tr-duration', trDur + 's');

        // Remove previous transition classes
        const prevClasses = Array.from(container.classList).filter(c => c.startsWith('tr-') || c === 'fade-in' || c === 'slide-in-right' || c === 'slide-in-left');
        prevClasses.forEach(c => container.classList.remove(c));
        void container.offsetWidth; // Force reflow to restart animation

        if (trType && trType !== 'none') {
            // Use the configured transition
            container.classList.add(`tr-${trType}-in`);
            setTimeout(() => container.classList.remove(`tr-${trType}-in`), Math.ceil(trDur * 1000) + 50);
        } else if (direction) {
            container.classList.add(direction === 'right' ? 'slide-in-right' : 'slide-in-left');
            setTimeout(() => container.classList.remove('slide-in-right', 'slide-in-left'), 450);
        } else {
            container.classList.add('fade-in');
            setTimeout(() => container.classList.remove('fade-in'), 450);
        }

        // Update dots
        document.querySelectorAll('.present-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === this.presentIdx);
        });
    }

    buildPresentDots() {
        const dotsEl = document.getElementById('presentDots');
        if (!dotsEl || !this.pres) return;
        dotsEl.innerHTML = '';
        const maxDots = Math.min(this.pres.slides.length, 20);
        for (let i = 0; i < maxDots; i++) {
            const dot = document.createElement('button');
            dot.className = `present-dot${i === this.presentIdx ? ' active' : ''}`;
            dot.addEventListener('click', () => { this.presentIdx = i; this.renderPresentSlide(); this.updatePresentCounter(); });
            dotsEl.appendChild(dot);
        }
    }

    updatePresentCounter() {
        const el = document.getElementById('presentCounter');
        if (el && this.pres) el.textContent = `${this.presentIdx + 1} / ${this.pres.slides.length}`;
    }

    // ── Export: PPTX ───────────────────────────────────────────
    async exportPPTX() {
        if (!this.pres) return;
        if (typeof PptxGenJS === 'undefined') {
            this.showToast('⚠ PptxGenJS library not loaded. Check your internet connection.', 5000); return;
        }
        this.showToast('Generating PPTX…', 10000);
        try {
            const pptx = new PptxGenJS();
            pptx.layout = 'LAYOUT_16x9';

            for (const slide of this.pres.slides) {
                const s = pptx.addSlide();

                // Background
                const bg = slide.background;
                if (bg.type === 'color') {
                    s.background = { color: bg.value.replace('#', '') };
                } else {
                    s.background = { color: 'FFFFFF' };
                }

                const sorted = [...slide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
                for (const el of sorted) {
                    const x = el.x / 960 * 10;
                    const y = el.y / 540 * 5.625;
                    const w = el.w / 960 * 10;
                    const h = el.h / 540 * 5.625;
                    const rot = el.r || 0;

                    if (el.type === 'text') {
                        const txt = htmlToText(el.html || '') || ' ';
                        s.addText(txt, {
                            x, y, w, h,
                            rotate: rot,
                            fontSize: Math.round((el.fontSize || 24) * 0.75),
                            fontFace: el.fontFamily || 'Arial',
                            color: (el.color || '#000000').replace('#', ''),
                            align: el.textAlign || 'left',
                            bold: el.bold || false,
                            italic: el.italic || false,
                            underline: el.underline ? { style: 'sng' } : false,
                            wrap: true,
                        });
                    } else if (el.type === 'shape') {
                        const shapeMap = {
                            rect: pptx.ShapeType.rect,
                            rounded: pptx.ShapeType.roundRect,
                            ellipse: pptx.ShapeType.ellipse,
                            triangle: pptx.ShapeType.triangle,
                            diamond: pptx.ShapeType.diamond,
                            arrow: pptx.ShapeType.rightArrow,
                            star: pptx.ShapeType.star5,
                            hexagon: pptx.ShapeType.hexagon,
                            line: pptx.ShapeType.line,
                        };
                        const pptxShape = shapeMap[el.shape] || pptx.ShapeType.rect;
                        const fillColor = (el.fill && el.fill !== 'none') ? el.fill.replace('#', '') : null;
                        const strokeColor = (el.stroke && el.stroke !== 'none') ? el.stroke.replace('#', '') : null;
                        try {
                            s.addShape(pptxShape, {
                                x, y, w, h, rotate: rot,
                                fill: fillColor ? { color: fillColor } : { type: 'none' },
                                line: strokeColor ? { color: strokeColor, width: el.strokeWidth || 2 } : { type: 'none' },
                            });
                        } catch (_) {
                            s.addShape(pptx.ShapeType.rect, {
                                x, y, w, h,
                                fill: fillColor ? { color: fillColor } : { type: 'none' },
                            });
                        }
                    } else if (el.type === 'image') {
                        s.addImage({ data: el.src, x, y, w, h, rotate: rot });
                    }
                }
            }

            await pptx.writeFile({ fileName: `${this.pres.title || 'presentation'}.pptx` });
            this.showToast('✓ PPTX exported!');
        } catch (err) {
            console.error('PPTX export error:', err);
            this.showToast('Export failed: ' + err.message, 5000);
        }
    }

    // ── Export: PDF ────────────────────────────────────────────
    async exportPDF() {
        if (!this.pres) return;

        const hasJsPDF = typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined';
        const hasH2C   = typeof html2canvas !== 'undefined';

        if (!hasJsPDF || !hasH2C) {
            this.showToast('⚠ PDF libraries not loaded. Check your internet connection.', 5000); return;
        }

        this.showToast('Generating PDF… (this may take a moment)', 15000);
        try {
            const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
            const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [297, 167.25] });

            const origIdx = this.slideIdx;

            for (let i = 0; i < this.pres.slides.length; i++) {
                if (i > 0) pdf.addPage();
                this.slideIdx = i;
                this.renderCanvas();
                await new Promise(r => setTimeout(r, 120));

                const canvas = document.getElementById('slideCanvas');
                const imgData = await html2canvas(canvas, {
                    scale: 2,
                    useCORS: true,
                    backgroundColor: this.pres.slides[i].background?.value || '#ffffff',
                    logging: false,
                });
                const dataUrl = imgData.toDataURL('image/jpeg', 0.92);
                pdf.addImage(dataUrl, 'JPEG', 0, 0, 297, 167.25);
            }

            this.slideIdx = origIdx;
            this.renderCanvas();
            pdf.save(`${this.pres.title || 'presentation'}.pdf`);
            this.showToast('✓ PDF exported!');
        } catch (err) {
            console.error('PDF export error:', err);
            this.showToast('PDF export failed: ' + err.message, 5000);
        }
    }

    // ── Import: PPTX (basic) ───────────────────────────────────
    async importPPTX(file) {
        if (typeof JSZip === 'undefined') {
            this.showToast('⚠ JSZip library not loaded. Import unavailable.', 5000); return;
        }
        this.showToast('Importing PPTX…', 10000);
        try {
            const zip = await JSZip.loadAsync(file);
            const pres = makePresentation(file.name.replace('.pptx', ''));
            pres.slides = [];

            // Find slide XML files
            const slideFiles = Object.keys(zip.files)
                .filter(name => /ppt\/slides\/slide\d+\.xml$/.test(name))
                .sort((a, b) => {
                    const na = parseInt(a.match(/\d+/)[0]);
                    const nb = parseInt(b.match(/\d+/)[0]);
                    return na - nb;
                });

            if (slideFiles.length === 0) {
                this.showToast('No slides found in PPTX file.', 4000); return;
            }

            for (const slideFile of slideFiles) {
                const xmlStr = await zip.file(slideFile).async('string');
                const slide = makeSlide();

                // Parse text content from XML
                const parser = new DOMParser();
                const doc = parser.parseFromString(xmlStr, 'application/xml');

                // Extract shapes/text frames
                const spNodes = doc.querySelectorAll('sp');
                let yOffset = 60;

                spNodes.forEach((sp) => {
                    const txBody = sp.querySelector('txBody');
                    if (!txBody) return;

                    // Get position/size
                    const off = sp.querySelector('off');
                    const ext = sp.querySelector('ext');
                    const EMU = 914400; // EMUs per inch
                    const INCH_TO_PX = 96; // 96dpi

                    let x = off ? Math.round(parseInt(off.getAttribute('x') || '0') / EMU * INCH_TO_PX / 10 * (960 / 120)) : 60;
                    let y = off ? Math.round(parseInt(off.getAttribute('y') || '0') / EMU * INCH_TO_PX / 10 * (540 / 67.5)) : yOffset;
                    let w = ext ? Math.round(parseInt(ext.getAttribute('cx') || '0') / EMU * INCH_TO_PX / 10 * (960 / 120)) : 400;
                    let h = ext ? Math.round(parseInt(ext.getAttribute('cy') || '0') / EMU * INCH_TO_PX / 10 * (540 / 67.5)) : 60;

                    // Clamp to slide
                    x = clamp(x, 0, 900); y = clamp(y, 0, 500);
                    w = clamp(w, 50, 900); h = clamp(h, 20, 500);

                    // Get text
                    const paragraphs = txBody.querySelectorAll('p');
                    let textLines = [];
                    paragraphs.forEach(p => {
                        const runs = p.querySelectorAll('r t');
                        const lineText = Array.from(runs).map(r => r.textContent).join('');
                        if (lineText.trim()) textLines.push(lineText);
                    });

                    if (textLines.length === 0) return;

                    // Font size
                    const szEl = sp.querySelector('sz');
                    const fontSize = szEl ? Math.round(parseInt(szEl.getAttribute('val') || '0') / 100) || 18 : 18;

                    // Bold
                    const boldEl = sp.querySelector('b');
                    const bold = boldEl ? (boldEl.getAttribute('val') !== '0') : false;

                    const el = makeTextEl(x, y, Math.max(w, 100), Math.max(h, 40));
                    el.html = textLines.map(t => `<p>${t}</p>`).join('');
                    el.fontSize = clamp(fontSize, 10, 96);
                    el.bold = bold;
                    slide.elements.push(el);
                    yOffset += h + 20;
                });

                // Try to get background color
                const bgColor = doc.querySelector('solidFill fgClr, solidFill srgbClr');
                if (bgColor) {
                    const colorVal = bgColor.getAttribute('val') || bgColor.getAttribute('lastClr') || 'ffffff';
                    slide.background = { type: 'color', value: '#' + colorVal.toLowerCase() };
                }

                if (slide.elements.length === 0) {
                    // Add placeholder text
                    const placeholder = makeTextEl(60, 60, 840, 60);
                    placeholder.html = `<p>Slide ${pres.slides.length + 1}</p>`;
                    placeholder.fontSize = 32;
                    slide.elements.push(placeholder);
                }

                pres.slides.push(slide);
            }

            if (pres.slides.length === 0) pres.slides = [makeSlide()];

            // Save and open
            this.presentations.unshift({ id: pres.id, title: pres.title, updatedAt: pres.updatedAt, slideCount: pres.slides.length });
            await this.saveIndex();
            await this.savePresData(pres);
            await this.openPresentation(pres.id);
            this.showToast(`✓ Imported ${pres.slides.length} slides from PPTX.`);
        } catch (err) {
            console.error('PPTX import error:', err);
            this.showToast('Import failed: ' + err.message, 5000);
        }
    }
}

// ── Init ───────────────────────────────────────────────────────
SlidesApp.memoryStorageFallback = new Map();

document.addEventListener('DOMContentLoaded', () => {
    window.slidesApp = new SlidesApp();
});