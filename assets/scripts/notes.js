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

        // Mobile state
        this.isMobile = () => window.innerWidth <= 1023;
        this.sidebarOpen = false;

        // Touch / swipe state
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchStartTime = 0;
        this.isSwiping = false;

        this.init();
    }

    init() {
        this.loadNotesFromStorage();
        this.setupEventListeners();
        this.setupRibbon();
        this.setupMobileRibbon();
        this.setupTextEditor();
        this.setupDrawing();
        this.setupImageDragDrop();
        this.setupTableResize();
        this.setupCanvasDragHandle();
        this.renderNotesList();
        this.showWelcomeScreenIfNeeded();
        this.setupMobileUI();
        this.setupSwipeGesture();
        this.isInitialized = true;
    }

    // ─── Storage ────────────────────────────────────────────────────────────────

    loadNotesFromStorage() {
        try {
            const stored = localStorage.getItem('emeraldnotes_data');
            if (stored) {
                this.notes = JSON.parse(stored);
                this.notes.forEach(note => {
                    if (note.content && typeof note.content === 'string') {
                        if (note.content.trim() === '<p>Start typing your note here...</p>' ||
                            note.content.trim() === 'Start typing your note here...') {
                            note.content = '';
                        }
                        const legacyEmptyPatterns = [
                            '<div>\u00A0</div>', '<p>\u00A0</p>',
                            '<div>&nbsp;</div>', '<p>&nbsp;</p>'
                        ];
                        if (legacyEmptyPatterns.includes(note.content.trim())) {
                            note.content = '';
                        }
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
            console.error('Error saving notes to storage:', error);
            this.showSaveIndicator('error');
        }
    }

    showToast(message, duration = 3000) {
        const toast = document.getElementById('custom-toast');
        if (!toast) { console.warn(message); return; }
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
    }

    showSaveIndicator(status) {
        const indicator = document.getElementById('saveIndicator');
        const text = indicator.querySelector('.save-text');
        indicator.className = 'save-indicator';
        switch (status) {
            case 'saving':
                indicator.classList.add('saving');
                text.textContent = 'Saving...';
                break;
            case 'saved':
                text.textContent = 'All changes saved';
                break;
            case 'error':
                text.textContent = 'Error saving';
                break;
        }
    }

    debouncedSave() {
        this.showSaveIndicator('saving');
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => this.saveNotesToStorage(), 1000);
    }

    // ─── Event Listeners ────────────────────────────────────────────────────────

    setupEventListeners() {
        const newNoteBtn = document.getElementById('newNoteBtn');
        const welcomeNewNoteBtn = document.getElementById('welcomeNewNoteBtn');
        if (newNoteBtn) newNoteBtn.addEventListener('click', () => this.createNewNote());
        if (welcomeNewNoteBtn) welcomeNewNoteBtn.addEventListener('click', () => this.createNewNote());

        const deleteNoteBtn = document.getElementById('deleteNoteBtn');
        if (deleteNoteBtn) deleteNoteBtn.addEventListener('click', () => this.deleteCurrentNote());

        const exportNoteBtn = document.getElementById('exportNoteBtn');
        if (exportNoteBtn) exportNoteBtn.addEventListener('click', () => this.exportNoteAsLink());

        const noteTitle = document.getElementById('noteTitle');
        if (noteTitle) {
            noteTitle.addEventListener('input', (e) => {
                if (this.currentNoteId) this.updateNoteTitle(e.target.value);
            });
        }

        const textEditor = document.getElementById('textEditor');
        if (textEditor) {
            textEditor.addEventListener('input', () => {
                if (this.currentNoteId) {
                    this.updatePlaceholderState(textEditor);
                    this.updateNoteContent();
                }
            });
        }

        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

        document.querySelectorAll('.ribbon-btn, .ribbon-tab').forEach(el => {
            el.addEventListener('mousedown', (e) => e.preventDefault());
        });

        document.querySelectorAll('.ms-dropdown-item, .color-swatch').forEach(el => {
            el.addEventListener('mousedown', (e) => e.preventDefault());
        });

        this.setupMSDropdowns();
        this.setupCustomContextMenu();
        this.setupEditorPlaceholder();
        this.setupSidebarToggle();
        this.setupTableToolbar();
    }

    // ─── Mobile UI ──────────────────────────────────────────────────────────────

    setupMobileUI() {
        // Inject backdrop element for sidebar overlay
        if (!document.getElementById('sidebarBackdrop')) {
            const backdrop = document.createElement('div');
            backdrop.id = 'sidebarBackdrop';
            backdrop.className = 'sidebar-backdrop';
            backdrop.addEventListener('click', () => this.closeMobileSidebar());
            document.querySelector('.notes-app').appendChild(backdrop);
        }

        // Inject mobile back button into editor header
        const editorHeader = document.querySelector('.editor-header');
        if (editorHeader && !document.getElementById('mobileBackBtn')) {
            const backBtn = document.createElement('button');
            backBtn.id = 'mobileBackBtn';
            backBtn.className = 'mobile-back-btn';
            backBtn.title = 'Back to Notes';
            backBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
            backBtn.addEventListener('click', () => this.openMobileSidebar());
            editorHeader.insertBefore(backBtn, editorHeader.firstChild);
        }



        // Inject swipe hint strip
        if (!document.getElementById('swipeHint')) {
            const hint = document.createElement('div');
            hint.id = 'swipeHint';
            hint.className = 'swipe-hint';
            document.querySelector('.notes-app').appendChild(hint);
        }
    }

    openMobileSidebar() {
        if (!this.isMobile()) return;
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebarBackdrop');
        sidebar.classList.add('mobile-open');
        backdrop.classList.add('visible');
        this.sidebarOpen = true;
    }

    closeMobileSidebar() {
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebarBackdrop');
        sidebar.classList.remove('mobile-open');
        backdrop.classList.remove('visible');
        this.sidebarOpen = false;
    }

    // ─── Swipe Gesture ──────────────────────────────────────────────────────────

    setupSwipeGesture() {
        const app = document.querySelector('.notes-app');

        app.addEventListener('touchstart', (e) => {
            if (!this.isMobile()) return;
            const touch = e.touches[0];
            this.touchStartX = touch.clientX;
            this.touchStartY = touch.clientY;
            this.touchStartTime = Date.now();
            this.isSwiping = false;
        }, { passive: true });

        app.addEventListener('touchmove', (e) => {
            if (!this.isMobile()) return;
            const touch = e.touches[0];
            const dx = touch.clientX - this.touchStartX;
            const dy = touch.clientY - this.touchStartY;

            // Only track horizontal swipes (more horizontal than vertical)
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
                this.isSwiping = true;
            }

            if (!this.isSwiping) return;

            const sidebar = document.querySelector('.sidebar');
            const sidebarWidth = sidebar.offsetWidth;

            if (this.sidebarOpen && dx < 0) {
                // Dragging sidebar closed — follow finger
                const clampedDx = Math.max(dx, -sidebarWidth);
                sidebar.style.transform = `translateX(${clampedDx}px)`;
                sidebar.style.transition = 'none';
            } else if (!this.sidebarOpen && dx > 0) {
                // Dragging sidebar open — follow finger from left
                const clampedDx = Math.min(dx - sidebarWidth, 0);
                sidebar.style.transform = `translateX(${clampedDx}px)`;
                sidebar.style.transition = 'none';
            }
        }, { passive: true });

        app.addEventListener('touchend', (e) => {
            if (!this.isMobile()) return;
            const touch = e.changedTouches[0];
            const dx = touch.clientX - this.touchStartX;
            const dy = touch.clientY - this.touchStartY;
            const dt = Date.now() - this.touchStartTime;

            // Always restore CSS transition and clear inline transform/transition
            const sidebar = document.querySelector('.sidebar');
            sidebar.style.transition = '';
            sidebar.style.transform = '';

            const THRESHOLD = 50;         // minimum px to trigger action
            const MAX_VERTICAL = 80;      // maximum vertical drift allowed
            const MAX_TIME = 600;         // maximum ms for swipe

            const isHorizontalSwipe =
                Math.abs(dx) > THRESHOLD &&
                Math.abs(dy) < MAX_VERTICAL &&
                dt < MAX_TIME;

            if (!isHorizontalSwipe) return;

            if (dx > 0 && !this.sidebarOpen) {
                // Swipe right from ANYWHERE on screen — open sidebar
                // (no left-edge restriction; entire screen is a valid swipe zone)
                this.openMobileSidebar();
            } else if (dx < 0 && this.sidebarOpen) {
                // Swipe left — close sidebar
                this.closeMobileSidebar();
            }
        }, { passive: true });
    }

    // ─── Mobile Ribbon ──────────────────────────────────────────────────────────

    setupMobileRibbon() {
        // Only runs if we are on mobile; re-checks on resize
        this.buildMobileRibbon();
        window.addEventListener('resize', () => {
            this.buildMobileRibbon();
        });
    }

    buildMobileRibbon() {
        const ribbonContent = document.querySelector('.ribbon-content');
        if (!ribbonContent) return;

        if (!this.isMobile()) {
            // Restore desktop ribbon — remove mobile row if it exists
            const mobileRow = document.getElementById('mobileRibbonRow');
            if (mobileRow) mobileRow.remove();
            const morePanel = document.getElementById('mobileMorePanel');
            if (morePanel) morePanel.remove();
            return;
        }

        // Already built
        if (document.getElementById('mobileRibbonRow')) return;

        // Build the mobile ribbon row
        const row = document.createElement('div');
        row.id = 'mobileRibbonRow';
        row.className = 'mobile-ribbon-row';

        // Essential buttons: Bold, Italic, Underline | Bullet, Number | Align L/C/R | More⋯
        const essentials = [
            { command: 'bold', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>`, title: 'Bold' },
            { command: 'italic', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>`, title: 'Italic' },
            { command: 'underline', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>`, title: 'Underline' },
        ];

        const div1 = document.createElement('div');
        div1.className = 'mobile-ribbon-divider';

        const secondary = [
            { command: 'insertUnorderedList', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`, title: 'Bullet List' },
            { command: 'insertOrderedList', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>`, title: 'Numbered List' },
        ];

        const div2 = document.createElement('div');
        div2.className = 'mobile-ribbon-divider';

        const tertiary = [
            { command: 'justifyLeft', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>`, title: 'Align Left' },
            { command: 'justifyCenter', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>`, title: 'Center' },
        ];

        // Build buttons
        [...essentials].forEach(({ command, icon, title }) => {
            const btn = document.createElement('button');
            btn.className = 'ribbon-btn format-btn';
            btn.dataset.command = command;
            btn.title = title;
            btn.innerHTML = icon;
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.executeCommand(command);
                this.updateButtonStates();
            });
            row.appendChild(btn);
        });

        row.appendChild(div1);
        [...secondary].forEach(({ command, icon, title }) => {
            const btn = document.createElement('button');
            btn.className = 'ribbon-btn format-btn';
            btn.dataset.command = command;
            btn.title = title;
            btn.innerHTML = icon;
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.executeCommand(command);
                this.updateButtonStates();
            });
            row.appendChild(btn);
        });

        row.appendChild(div2);
        [...tertiary].forEach(({ command, icon, title }) => {
            const btn = document.createElement('button');
            btn.className = 'ribbon-btn format-btn';
            btn.dataset.command = command;
            btn.title = title;
            btn.innerHTML = icon;
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.executeCommand(command);
                this.updateButtonStates();
            });
            row.appendChild(btn);
        });

        // Spacer
        const spacer = document.createElement('div');
        spacer.style.flex = '1';
        row.appendChild(spacer);

        // More ⋯ button
        const moreBtn = document.createElement('button');
        moreBtn.className = 'mobile-more-btn';
        moreBtn.id = 'mobileMoreBtn';
        moreBtn.title = 'More options';
        moreBtn.textContent = '⋯';
        row.appendChild(moreBtn);

        // More panel (font, colors)
        const morePanel = document.createElement('div');
        morePanel.className = 'mobile-more-panel';
        morePanel.id = 'mobileMorePanel';
        morePanel.innerHTML = `
            <div style="padding:4px 0 8px;font-size:11px;font-weight:600;color:rgba(44,62,80,0.5);text-transform:uppercase;letter-spacing:0.5px;">Font</div>
            <div id="mobileFontFamilyDropdown" class="ms-dropdown" style="margin-bottom:6px;">
                <button class="ms-dropdown-btn" type="button" style="width:100%;min-width:unset;">
                    <span class="dropdown-value">Arial</span>
                </button>
                <div class="ms-dropdown-menu">
                    <div class="ms-dropdown-item font-group-label">— Sans-Serif —</div>
                    <div class="ms-dropdown-item" data-value="Arial" style="font-family:Arial,sans-serif;">Arial</div>
                    <div class="ms-dropdown-item" data-value="Helvetica" style="font-family:Helvetica,sans-serif;">Helvetica</div>
                    <div class="ms-dropdown-item" data-value="Verdana" style="font-family:Verdana,sans-serif;">Verdana</div>
                    <div class="ms-dropdown-item" data-value="Roboto" style="font-family:Roboto,sans-serif;">Roboto</div>
                    <div class="ms-dropdown-item" data-value="Open Sans" style="font-family:'Open Sans',sans-serif;">Open Sans</div>
                    <div class="ms-dropdown-item" data-value="Lato" style="font-family:Lato,sans-serif;">Lato</div>
                    <div class="ms-dropdown-item" data-value="Montserrat" style="font-family:Montserrat,sans-serif;">Montserrat</div>
                    <div class="ms-dropdown-item" data-value="Poppins" style="font-family:Poppins,sans-serif;">Poppins</div>
                    <div class="ms-dropdown-item" data-value="Raleway" style="font-family:Raleway,sans-serif;">Raleway</div>
                    <div class="ms-dropdown-item" data-value="Nunito" style="font-family:Nunito,sans-serif;">Nunito</div>
                    <div class="ms-dropdown-item" data-value="Ubuntu" style="font-family:Ubuntu,sans-serif;">Ubuntu</div>
                    <div class="ms-dropdown-item" data-value="Mulish" style="font-family:Mulish,sans-serif;">Mulish</div>
                    <div class="ms-dropdown-item" data-value="Oswald" style="font-family:Oswald,sans-serif;">Oswald</div>
                    <div class="ms-dropdown-item" data-value="Quicksand" style="font-family:Quicksand,sans-serif;">Quicksand</div>
                    <div class="ms-dropdown-item" data-value="Comfortaa" style="font-family:Comfortaa,sans-serif;">Comfortaa</div>
                    <div class="ms-dropdown-item font-group-label">— Serif —</div>
                    <div class="ms-dropdown-item" data-value="Georgia" style="font-family:Georgia,serif;">Georgia</div>
                    <div class="ms-dropdown-item" data-value="Times New Roman" style="font-family:'Times New Roman',serif;">Times New Roman</div>
                    <div class="ms-dropdown-item" data-value="Merriweather" style="font-family:Merriweather,serif;">Merriweather</div>
                    <div class="ms-dropdown-item" data-value="Lora" style="font-family:Lora,serif;">Lora</div>
                    <div class="ms-dropdown-item" data-value="Playfair Display" style="font-family:'Playfair Display',serif;">Playfair Display</div>
                    <div class="ms-dropdown-item font-group-label">— Monospace —</div>
                    <div class="ms-dropdown-item" data-value="Courier New" style="font-family:'Courier New',monospace;">Courier New</div>
                    <div class="ms-dropdown-item" data-value="Source Code Pro" style="font-family:'Source Code Pro',monospace;">Source Code Pro</div>
                    <div class="ms-dropdown-item" data-value="Fira Code" style="font-family:'Fira Code',monospace;">Fira Code</div>
                    <div class="ms-dropdown-item" data-value="JetBrains Mono" style="font-family:'JetBrains Mono',monospace;">JetBrains Mono</div>
                    <div class="ms-dropdown-item font-group-label">— Handwriting —</div>
                    <div class="ms-dropdown-item" data-value="Dancing Script" style="font-family:'Dancing Script',cursive;">Dancing Script</div>
                    <div class="ms-dropdown-item" data-value="Pacifico" style="font-family:Pacifico,cursive;">Pacifico</div>
                    <div class="ms-dropdown-item" data-value="Satisfy" style="font-family:Satisfy,cursive;">Satisfy</div>
                    <div class="ms-dropdown-item" data-value="Caveat" style="font-family:Caveat,cursive;">Caveat</div>
                </div>
            </div>
            <div id="mobileFontSizeDropdown" class="ms-dropdown" style="margin-bottom:6px;">
                <button class="ms-dropdown-btn" type="button" style="width:100%;min-width:unset;">
                    <span class="dropdown-value">12</span>
                </button>
                <div class="ms-dropdown-menu">
                    <div class="ms-dropdown-item" data-value="10">10</div>
                    <div class="ms-dropdown-item" data-value="12">12</div>
                    <div class="ms-dropdown-item" data-value="14">14</div>
                    <div class="ms-dropdown-item" data-value="16">16</div>
                    <div class="ms-dropdown-item" data-value="18">18</div>
                    <div class="ms-dropdown-item" data-value="20">20</div>
                    <div class="ms-dropdown-item" data-value="24">24</div>
                    <div class="ms-dropdown-item" data-value="28">28</div>
                    <div class="ms-dropdown-item" data-value="32">32</div>
                    <div class="ms-dropdown-item" data-value="36">36</div>
                    <div class="ms-dropdown-item" data-value="48">48</div>
                </div>
            </div>
            <div style="padding:4px 0 8px;font-size:11px;font-weight:600;color:rgba(44,62,80,0.5);text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Color</div>
            <div id="mobileFontColorDropdown" class="ms-dropdown" style="margin-bottom:6px;">
                <button class="ms-dropdown-btn" type="button" style="width:100%;min-width:unset;">
                    <span class="color-preview" style="background:#000000;width:12px;height:12px;border-radius:2px;display:inline-block;margin-right:6px;"></span>
                    <span class="dropdown-value">Text Color</span>
                </button>
                <div class="ms-dropdown-menu">
                    <div class="ms-dropdown-item" data-value="#000000" data-label="Black"><span class="color-preview" style="background:#000000;width:12px;height:12px;border-radius:2px;"></span> Black</div>
                    <div class="ms-dropdown-item" data-value="#FF0000" data-label="Red"><span class="color-preview" style="background:#FF0000;width:12px;height:12px;border-radius:2px;"></span> Red</div>
                    <div class="ms-dropdown-item" data-value="#0000FF" data-label="Blue"><span class="color-preview" style="background:#0000FF;width:12px;height:12px;border-radius:2px;"></span> Blue</div>
                    <div class="ms-dropdown-item" data-value="#008000" data-label="Green"><span class="color-preview" style="background:#008000;width:12px;height:12px;border-radius:2px;"></span> Green</div>
                    <div class="ms-dropdown-item" data-value="#800080" data-label="Purple"><span class="color-preview" style="background:#800080;width:12px;height:12px;border-radius:2px;"></span> Purple</div>
                </div>
            </div>
            <div id="mobileHighlightDropdown" class="ms-dropdown">
                <button class="ms-dropdown-btn" type="button" style="width:100%;min-width:unset;">
                    <span class="color-preview" style="background:#FFFF00;width:12px;height:12px;border-radius:2px;display:inline-block;margin-right:6px;"></span>
                    <span class="dropdown-value">Highlight</span>
                </button>
                <div class="ms-dropdown-menu">
                    <div class="ms-dropdown-item" data-value="#FFFF00" data-label="Yellow"><span class="color-preview" style="background:#FFFF00;width:12px;height:12px;border-radius:2px;"></span> Yellow</div>
                    <div class="ms-dropdown-item" data-value="#90EE90" data-label="Light Green"><span class="color-preview" style="background:#90EE90;width:12px;height:12px;border-radius:2px;"></span> Light Green</div>
                    <div class="ms-dropdown-item" data-value="#FFB6C1" data-label="Light Pink"><span class="color-preview" style="background:#FFB6C1;width:12px;height:12px;border-radius:2px;"></span> Light Pink</div>
                    <div class="ms-dropdown-item" data-value="#ADD8E6" data-label="Light Blue"><span class="color-preview" style="background:#ADD8E6;width:12px;height:12px;border-radius:2px;"></span> Light Blue</div>
                    <div class="ms-dropdown-item" data-value="transparent" data-label="None"><span class="color-preview" style="background:transparent;width:12px;height:12px;border:1px solid #ccc;border-radius:2px;"></span> None</div>
                </div>
            </div>
        `;

        // Position more panel relative to ribbon
        const ribbonEl = document.querySelector('.ribbon');
        ribbonEl.style.position = 'relative';
        ribbonEl.appendChild(morePanel);

        // Toggle more panel
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.saveSelection();
            morePanel.classList.toggle('open');
            moreBtn.classList.toggle('active');
        });

        // Close more panel on outside click
        document.addEventListener('click', (e) => {
            if (!moreBtn.contains(e.target) && !morePanel.contains(e.target)) {
                morePanel.classList.remove('open');
                moreBtn.classList.remove('active');
            }
        });

        // Wire up mobile more panel dropdowns
        const mobileFontFamily = morePanel.querySelector('#mobileFontFamilyDropdown');
        const mobileFontSize = morePanel.querySelector('#mobileFontSizeDropdown');
        const mobileFontColor = morePanel.querySelector('#mobileFontColorDropdown');
        const mobileHighlight = morePanel.querySelector('#mobileHighlightDropdown');

        this.wireMobileDropdown(mobileFontFamily, (value) => {
            this.restoreSelection();
            this.executeCommand('fontName', value);
        });
        this.wireMobileDropdown(mobileFontSize, (value) => {
            this.restoreSelection();
            this.executeCommand('fontSize', value);
        });
        this.wireMobileDropdown(mobileFontColor, (value) => {
            this.restoreSelection();
            this.executeCommand('foreColor', value);
        });
        this.wireMobileDropdown(mobileHighlight, (value) => {
            this.restoreSelection();
            this.executeCommand('hiliteColor', value);
        });

        ribbonContent.appendChild(row);
    }

    wireMobileDropdown(dropdownEl, onSelect) {
        if (!dropdownEl) return;
        const btn = dropdownEl.querySelector('.ms-dropdown-btn');
        const menu = dropdownEl.querySelector('.ms-dropdown-menu');
        const items = dropdownEl.querySelectorAll('.ms-dropdown-item');

        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.saveSelection();
            document.querySelectorAll('.ms-dropdown.active').forEach(d => {
                if (d !== dropdownEl) d.classList.remove('active');
            });
            dropdownEl.classList.toggle('active');
        });

        items.forEach(item => {
            item.addEventListener('mousedown', (e) => e.preventDefault());
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const value = item.dataset.value;
                if (value === undefined || value === null || value === '') return; // Skip group labels
                const label = item.dataset.label || item.textContent.trim();
                const valueSpan = btn.querySelector('.dropdown-value');
                if (valueSpan) valueSpan.textContent = label;
                const colorPreview = btn.querySelector('.color-preview');
                if (colorPreview && value) {
                    colorPreview.style.background = value;
                }
                dropdownEl.classList.remove('active');
                setTimeout(() => {
                    const editor = document.getElementById('textEditor');
                    if (editor) editor.focus();
                    onSelect(value);
                    this.updateButtonStates();
                }, 10);
            });
        });
    }

    // ─── Ribbon Setup (Desktop) ─────────────────────────────────────────────────

    setupRibbon() {
        document.querySelectorAll('.ribbon-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchRibbonTab(tabName);
            });
        });

        document.querySelectorAll('.format-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const command = btn.dataset.command;
                this.executeCommand(command);
                this.updateButtonStates();
            });
        });

        const cutBtn = document.getElementById('cutBtn');
        const copyBtn = document.getElementById('copyBtn');
        const pasteBtn = document.getElementById('pasteBtn');
        if (cutBtn) cutBtn.addEventListener('click', () => this.executeCommand('cut'));
        if (copyBtn) copyBtn.addEventListener('click', () => this.executeCommand('copy'));
        if (pasteBtn) pasteBtn.addEventListener('click', () => this.executeCommand('paste'));

        const insertTableBtn = document.getElementById('insertTableBtn');
        const insertTodoBtn = document.getElementById('insertTodoBtn');
        const drawBtn = document.getElementById('drawBtn');
        const insertImageBtn = document.getElementById('insertImageBtn');
        const insertImageInput = document.getElementById('insertImageInput');
        if (insertTableBtn) insertTableBtn.addEventListener('click', () => this.insertTable());
        if (insertTodoBtn) insertTodoBtn.addEventListener('click', () => this.insertTodo());
        if (drawBtn) drawBtn.addEventListener('click', () => this.toggleDrawMode());
        if (insertImageBtn) insertImageBtn.addEventListener('click', () => {
            this.saveSelection();
            if (insertImageInput) insertImageInput.click();
        });
        if (insertImageInput) insertImageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) { this.insertImage(file); }
            insertImageInput.value = '';
        });

        const zoomInBtn = document.getElementById('zoomInBtn');
        const zoomOutBtn = document.getElementById('zoomOutBtn');
        if (zoomInBtn) zoomInBtn.addEventListener('click', () => this.zoomIn());
        if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => this.zoomOut());
    }

    // ─── Text Editor ────────────────────────────────────────────────────────────

    setupTextEditor() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;

        editor.addEventListener('wheel', (e) => e.stopPropagation(), false);

        editor.addEventListener('mouseup', () => {
            this.saveSelection();
            this.updateButtonStates();
        });
        editor.addEventListener('keyup', () => {
            this.saveSelection();
            this.updateButtonStates();
        });

        editor.addEventListener('blur', () => this.saveSelection());

        // Handle Enter key in todo items - move cursor below the todo item
        editor.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const node = sel.getRangeAt(0).commonAncestorContainer;
            const label = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            const todoLabel = label && label.closest ? label.closest('.todo-label') : null;
            if (!todoLabel) return;

            e.preventDefault();
            const todoItem = todoLabel.closest('.todo-item');
            if (!todoItem) return;

            // Insert an empty div after the todo item and move cursor there
            const newBlock = document.createElement('div');
            newBlock.innerHTML = '<br>';
            const next = todoItem.nextSibling;
            if (next) {
                todoItem.parentNode.insertBefore(newBlock, next);
            } else {
                todoItem.parentNode.appendChild(newBlock);
            }

            // Place cursor in the new block
            const newRange = document.createRange();
            newRange.setStart(newBlock, 0);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            this.updateNoteContent();
        });

        editor.addEventListener('paste', (e) => {
            setTimeout(() => {
                this.updatePlaceholderState(editor);
                this.updateNoteContent();
            }, 10);
        });

        // Handle checkbox clicks in todo items
        editor.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox' && e.target.closest('.todo-item')) {
                setTimeout(() => {
                    if (e.target.checked) {
                        e.target.setAttribute('checked', 'checked');
                    } else {
                        e.target.removeAttribute('checked');
                    }
                    this.updateNoteContent();
                }, 0);
            }
        });
    }

    saveSelection() {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            this.savedSelection = selection.getRangeAt(0).cloneRange();
        }
    }

    restoreSelection() {
        if (this.savedSelection) {
            const editor = document.getElementById('textEditor');
            if (editor) editor.focus();
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(this.savedSelection.cloneRange());
        }
    }

    switchRibbonTab(tabName) {
        document.querySelectorAll('.ribbon-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        document.querySelectorAll('.ribbon-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });
    }

    executeCommand(command, value = null) {
        document.getElementById('textEditor').focus();

        try {
            if (command === 'cut') { this.modernCut(); return; }
            if (command === 'copy') { this.modernCopy(); return; }
            if (command === 'paste') { this.modernPaste(); return; }
            if (command === 'fontName') { this.modernFontFamily(value); return; }
            if (command === 'fontSize') { this.modernFontSize(value); return; }
            if (command === 'foreColor') { this.modernTextColor(value); return; }
            if (command === 'hiliteColor') { this.modernHighlightColor(value); return; }

            if (value) {
                document.execCommand(command, false, value);
            } else {
                document.execCommand(command, false, null);
            }
        } catch (error) {
            console.error('Error executing command:', command, error);
        }

        this.updateNoteContent();
    }

    updateButtonStates() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const commands = ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript', 'justifyLeft', 'justifyCenter', 'justifyRight', 'insertUnorderedList', 'insertOrderedList'];
        commands.forEach(command => {
            const btns = document.querySelectorAll(`[data-command="${command}"]`);
            btns.forEach(btn => {
                try {
                    btn.classList.toggle('active', document.queryCommandState(command));
                } catch { btn.classList.remove('active'); }
            });
        });

        this.updateFontStateFromDOM();
    }

    updateFontStateFromDOM() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        let currentNode = range.commonAncestorContainer;
        if (currentNode.nodeType === Node.TEXT_NODE) currentNode = currentNode.parentElement;

        let fontFamily = '', fontSize = '', textColor = '', backgroundColor = '';
        let element = currentNode;

        while (element && element !== document.getElementById('textEditor')) {
            const styles = window.getComputedStyle(element);
            if (!fontFamily && styles.fontFamily && styles.fontFamily !== 'inherit') {
                // Extract first font name, strip quotes and fallback fonts
                const raw = styles.fontFamily.replace(/['"]/g, '').split(',')[0].trim();
                fontFamily = raw;
            }
            if (!fontSize && element.style && element.style.fontSize)
                fontSize = element.style.fontSize.replace('px', '');
            if (!textColor && element.style && element.style.color)
                textColor = element.style.color;
            if (!backgroundColor && element.style && element.style.backgroundColor)
                backgroundColor = element.style.backgroundColor;
            // Also check <font> tag attributes
            if (!textColor && element.tagName && element.tagName.toLowerCase() === 'font' && element.getAttribute('color'))
                textColor = element.getAttribute('color');
            element = element.parentElement;
        }

        const fontFamilyDropdown = document.getElementById('fontFamilyDropdown');
        if (fontFamilyDropdown && fontFamily) {
            const valueSpan = fontFamilyDropdown.querySelector('.dropdown-value');
            if (valueSpan) {
                // Try exact match first, then case-insensitive
                let matchingItem = fontFamilyDropdown.querySelector(`[data-value="${fontFamily}"]`);
                if (!matchingItem) {
                    const lower = fontFamily.toLowerCase();
                    matchingItem = Array.from(fontFamilyDropdown.querySelectorAll('.ms-dropdown-item'))
                        .find(el => el.dataset.value.toLowerCase() === lower);
                }
                if (matchingItem) valueSpan.textContent = matchingItem.textContent.trim();
            }
        }

        const fontSizeDropdown = document.getElementById('fontSizeDropdown');
        if (fontSizeDropdown && fontSize) {
            const valueSpan = fontSizeDropdown.querySelector('.dropdown-value');
            if (valueSpan) valueSpan.textContent = fontSize; // no 'px' suffix
        }

        const fontColorDropdown = document.getElementById('fontColorDropdown');
        if (fontColorDropdown && textColor) {
            const colorPreview = fontColorDropdown.querySelector('.color-preview');
            if (colorPreview) { colorPreview.style.background = textColor; colorPreview.setAttribute('data-color', textColor); }
        }

        const highlightColorDropdown = document.getElementById('highlightColorDropdown');
        if (highlightColorDropdown) {
            const colorPreview = highlightColorDropdown.querySelector('.color-preview');
            if (colorPreview) {
                if (backgroundColor && backgroundColor !== 'rgba(0, 0, 0, 0)' && backgroundColor !== 'transparent') {
                    colorPreview.style.background = backgroundColor;
                    colorPreview.style.border = '';
                } else {
                    colorPreview.style.background = 'transparent';
                    colorPreview.style.border = '1px solid #ccc';
                }
            }
        }
    }

    // ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

    handleKeyboardShortcuts(e) {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'n': e.preventDefault(); this.createNewNote(); break;
                case 's': e.preventDefault(); this.saveNotesToStorage(); break;
                case 'b':
                    if (this.isEditorFocused()) { e.preventDefault(); this.executeCommand('bold'); this.updateButtonStates(); }
                    break;
                case 'i':
                    if (this.isEditorFocused()) { e.preventDefault(); this.executeCommand('italic'); this.updateButtonStates(); }
                    break;
                case 'u':
                    if (this.isEditorFocused()) { e.preventDefault(); this.executeCommand('underline'); this.updateButtonStates(); }
                    break;
            }
        }
    }

    isEditorFocused() {
        return document.getElementById('textEditor').contains(document.activeElement);
    }

    // ─── Notes CRUD ──────────────────────────────────────────────────────────────

    createNewNote() {
        const note = {
            id: this.generateId(),
            title: 'Untitled Note',
            content: '',
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        };

        this.notes.unshift(note);
        this.selectNote(note.id);
        this.renderNotesList();
        this.debouncedSave();

        setTimeout(() => {
            const titleInput = document.getElementById('noteTitle');
            titleInput.select();
        }, 100);

        // On mobile, close sidebar after selecting/creating a note
        if (this.isMobile()) this.closeMobileSidebar();
    }

    selectNote(noteId) {
        const note = this.notes.find(n => n.id === noteId);
        if (!note) return;

        this.currentNoteId = noteId;

        document.getElementById('noteTitle').value = note.title;
        document.getElementById('textEditor').innerHTML = this.sanitizeHtml(note.content);

        const textEditor = document.getElementById('textEditor');
        if (note.color && note.color !== '#ffffff') {
            textEditor.style.backgroundColor = note.color;
        } else {
            textEditor.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
        }

        const noteColorDropdown = document.getElementById('noteColorDropdown');
        if (noteColorDropdown) {
            const colorPreview = noteColorDropdown.querySelector('.color-preview');
            const dropdownValue = noteColorDropdown.querySelector('.dropdown-value');
            const currentColor = note.color || '#ffffff';
            if (colorPreview) { colorPreview.style.background = currentColor; colorPreview.setAttribute('data-color', currentColor); }
            if (dropdownValue) {
                const colorItem = noteColorDropdown.querySelector(`[data-value="${currentColor}"]`);
                dropdownValue.textContent = colorItem ? (colorItem.dataset.label || 'Default') : 'Default';
            }
        }

        document.querySelectorAll('.note-item').forEach(item => {
            item.classList.toggle('active', item.dataset.noteId === noteId);
        });

        document.getElementById('welcomeScreen').classList.add('hidden');
        document.querySelector('.editor-header').style.display = 'flex';
        document.querySelector('.editor-content').style.display = 'flex';

        // On mobile, close sidebar when a note is selected
        if (this.isMobile()) this.closeMobileSidebar();

        // If in draw mode, exit it
        if (this.isDrawMode) { this.isDrawMode = false; const tb = document.getElementById('drawToolbar'); if (tb) tb.classList.remove('visible'); const db = document.getElementById('drawBtn'); if (db) db.classList.remove('active'); const te = document.getElementById('textEditor'); if (te) te.contentEditable = 'true'; }
        // Load the drawing for this note (or hide canvas if none)
        this.loadDrawing();

        setTimeout(() => document.getElementById('textEditor').focus(), 100);
    }

    updateNoteTitle(title) {
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (note) {
            note.title = title || 'Untitled Note';
            note.modifiedAt = new Date().toISOString();
            this.renderNotesList();
            this.debouncedSave();
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
        }
    }

    deleteCurrentNote() {
        if (!this.currentNoteId) return;

        const currentNote = this.notes.find(n => n.id === this.currentNoteId);
        if (!currentNote) return;

        const title = currentNote.title || 'Untitled Note';
        this.showDeleteModal(title, () => {
            const currentIndex = this.notes.findIndex(n => n.id === this.currentNoteId);
            this.notes = this.notes.filter(note => note.id !== this.currentNoteId);

            if (this.notes.length > 0) {
                const nextIndex = currentIndex < this.notes.length ? currentIndex : this.notes.length - 1;
                this.selectNote(this.notes[nextIndex].id);
            } else {
                this.currentNoteId = null;
                this.showWelcomeScreenIfNeeded();
                const noteTitle = document.getElementById('noteTitle');
                const textEditor = document.getElementById('textEditor');
                if (noteTitle) noteTitle.value = '';
                if (textEditor) { textEditor.innerHTML = ''; textEditor.style.backgroundColor = 'rgba(255, 255, 255, 0.5)'; }
            }

            this.saveNotesToStorage();
            this.renderNotesList();
        });
    }

    renderNotesList() {
        const notesList = document.getElementById('notesList');
        notesList.innerHTML = '';
        this.notes.forEach(note => notesList.appendChild(this.createNoteListItem(note)));
    }

    createNoteListItem(note) {
        const div = document.createElement('div');
        div.className = 'note-item';
        div.dataset.noteId = note.id;
        if (note.id === this.currentNoteId) div.classList.add('active');

        if (note.color && note.color !== '#ffffff') {
            div.style.backgroundColor = note.color;
            div.style.borderColor = note.color;
            const shadowColor = this.hexToRgba(note.color, 0.3);
            div.style.boxShadow = `0 4px 16px ${shadowColor}`;
            div.addEventListener('mouseenter', () => { div.style.boxShadow = `0 8px 24px ${this.hexToRgba(note.color, 0.4)}`; });
            div.addEventListener('mouseleave', () => { div.style.boxShadow = `0 4px 16px ${this.hexToRgba(note.color, 0.3)}`; });
        }

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = note.content;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        const preview = plainText.substring(0, 150);
        const date = new Date(note.modifiedAt);

        div.innerHTML = `
            <div class="note-item-title">${this.escapeHtml(note.title)}</div>
            <div class="note-item-preview">${this.escapeHtml(preview)}${preview.length === 150 ? '...' : ''}</div>
            <div class="note-item-date">${this.formatDate(date)}</div>
        `;

        div.addEventListener('click', () => {
            this.selectNote(note.id);
            // Close sidebar on mobile when note is tapped
            if (this.isMobile()) this.closeMobileSidebar();
        });

        return div;
    }

    showWelcomeScreenIfNeeded() {
        const hasNotes = this.notes.length > 0;
        const welcomeScreen = document.getElementById('welcomeScreen');
        const editorHeader = document.querySelector('.editor-header');
        const editorContent = document.querySelector('.editor-content');

        if (hasNotes && this.currentNoteId) {
            welcomeScreen.classList.add('hidden');
            editorHeader.style.display = 'flex';
            editorContent.style.display = 'flex';
        } else {
            welcomeScreen.classList.remove('hidden');
            editorHeader.style.display = 'none';
            editorContent.style.display = 'none';
            this.currentNoteId = null;

            // Do NOT auto-open sidebar — user swipes right to open
        }
    }

    // ─── Insert Operations ──────────────────────────────────────────────────────

    insertTable() { this.saveSelection(); this.showTableModal(); }

    insertTodo() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        const div = document.createElement('div');
        div.className = 'todo-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'todo-checkbox';
        const label = document.createElement('span');
        label.className = 'todo-label';
        label.textContent = ' To-do item';
        div.appendChild(checkbox);
        div.appendChild(label);
        const br = document.createElement('br');

        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            range.deleteContents();
            range.insertNode(br);
            range.insertNode(div);
            const newRange = document.createRange();
            newRange.selectNodeContents(label);
            newRange.collapse(false);
            selection.removeAllRanges();
            selection.addRange(newRange);
        } else {
            editor.appendChild(div);
            editor.appendChild(br);
        }
        this.updateNoteContent();
    }

    insertImage(file) {
        const editor = document.getElementById('textEditor');
        if (!file || !editor) return;
        if (!file.type.startsWith('image/')) {
            this.showToast('Please select an image file.');
            return;
        }
        const maxSize = 5 * 1024 * 1024; // 5 MB
        if (file.size > maxSize) {
            this.showToast('Image too large. Please use images under 5 MB.');
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            const img = `<img src="${dataUrl}" alt="${file.name}" style="max-width:100%;height:auto;border-radius:6px;">`;
            this.restoreSelection();
            // If we have a saved selection, use insertHTML; otherwise append
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                this.executeCommand('insertHTML', img);
            } else {
                editor.focus();
                this.executeCommand('insertHTML', img);
            }
            this.updateNoteContent();
        };
        reader.onerror = () => { this.showToast('Failed to read image file.'); };
        reader.readAsDataURL(file);
    }

    setupImageDragDrop() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;

        editor.addEventListener('dragover', (e) => {
            if (e.dataTransfer && Array.from(e.dataTransfer.items).some(i => i.kind === 'file' && i.type.startsWith('image/'))) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                editor.classList.add('drag-over');
            }
        });

        editor.addEventListener('dragleave', (e) => {
            if (!editor.contains(e.relatedTarget)) {
                editor.classList.remove('drag-over');
            }
        });

        editor.addEventListener('drop', (e) => {
            editor.classList.remove('drag-over');
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files) return;
            let handled = false;
            Array.from(files).forEach(file => {
                if (file.type.startsWith('image/')) {
                    handled = true;
                    e.preventDefault();
                    e.stopPropagation();
                    this.insertImage(file);
                }
            });
        });
    }

    setupTableResize() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;

        let resizing = false;
        let startX = 0;
        let startW = 0;
        let targetCell = null;
        let nextCell = null;

        editor.addEventListener('mousemove', (e) => {
            if (resizing) return;
            const th = e.target.closest('th, td');
            if (!th) { editor.style.cursor = ''; return; }
            const rect = th.getBoundingClientRect();
            const nearRight = e.clientX > rect.right - 6 && e.clientX < rect.right + 4;
            if (nearRight) {
                editor.style.cursor = 'col-resize';
            } else {
                editor.style.cursor = '';
            }
        });

        editor.addEventListener('mousedown', (e) => {
            const th = e.target.closest('th, td');
            if (!th) return;
            const rect = th.getBoundingClientRect();
            const nearRight = e.clientX > rect.right - 6 && e.clientX < rect.right + 4;
            if (!nearRight) return;

            e.preventDefault();
            resizing = true;
            startX = e.clientX;
            targetCell = th;
            startW = th.offsetWidth;
            const row = th.parentElement;
            const idx = Array.from(row.cells).indexOf(th);
            nextCell = row.cells[idx + 1] || null;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!resizing || !targetCell) return;
            const diff = e.clientX - startX;
            const newW = Math.max(40, startW + diff);
            targetCell.style.width = newW + 'px';
            if (nextCell) nextCell.style.width = '';
        });

        document.addEventListener('mouseup', () => {
            if (!resizing) return;
            resizing = false;
            targetCell = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            this.updateNoteContent();
        });
    }

    setupTableDrag(table) {
        if (!table || table.dataset.dragSetup) return;
        table.dataset.dragSetup = '1';

        const dragHandle = document.createElement('div');
        dragHandle.className = 'table-drag-handle';
        dragHandle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5H10V7H8V5ZM14 5H16V7H14V5ZM8 11H10V13H8V11ZM14 11H16V13H14V11ZM8 17H10V19H8V17ZM14 17H16V19H14V17Z"/></svg> Move`;
        table.style.position = 'relative';
        table.appendChild(dragHandle);

        let dragging = false;
        let startX, startY, initLeft, initTop;

        dragHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = table.getBoundingClientRect();
            const editorRect = document.getElementById('textEditor').getBoundingClientRect();
            initLeft = rect.left - editorRect.left;
            initTop = rect.top - editorRect.top + document.getElementById('textEditor').scrollTop;
            table.classList.add('em-floating');
            table.style.left = initLeft + 'px';
            table.style.top = initTop + 'px';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            table.style.left = (initLeft + dx) + 'px';
            table.style.top = (initTop + dy) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            this.updateNoteContent();
        });
    }

    setupCanvasDragHandle() {
        const canvas = document.getElementById('drawingCanvas');
        const editorContent = canvas ? canvas.parentElement : null;
        if (!canvas || !editorContent) return;

        const handle = document.createElement('div');
        handle.id = 'canvasDragHandle';
        handle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5H10V7H8V5ZM14 5H16V7H14V5ZM8 11H10V13H8V11ZM14 11H16V13H14V11ZM8 17H10V19H8V17ZM14 17H16V19H14V17Z"/></svg> Move Drawing`;
        editorContent.appendChild(handle);

        let dragging = false;
        let startX, startY, initTop = 0, initLeft = 0;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initTop = parseInt(canvas.style.top || '0') || 0;
            initLeft = parseInt(canvas.style.left || '0') || 0;
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            canvas.style.top = (initTop + dy) + 'px';
            canvas.style.left = (initLeft + dx) + 'px';
            handle.style.top = (8 + initTop + dy) + 'px';
            handle.style.right = '';
            handle.style.left = (Math.max(8, initLeft + dx)) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            this.saveDrawing();
        });

        const observer = new MutationObserver(() => {
            const isVisible = canvas.style.display !== 'none' && !this.isDrawMode;
            if (isVisible) {
                handle.classList.add('visible');
            } else {
                handle.classList.remove('visible');
            }
        });
        observer.observe(canvas, { attributes: true, attributeFilter: ['style'] });
    }

    showTableModal() {
        const modal = document.getElementById('tableModal');
        const cancelBtn = document.getElementById('tableModalCancel');
        const createBtn = document.getElementById('tableModalCreate');
        const rowsInput = document.getElementById('tableRows');
        const colsInput = document.getElementById('tableCols');
        if (!modal) return;
        modal.classList.add('show');
        setTimeout(() => rowsInput.focus(), 100);

        const cleanup = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', cleanup);
            createBtn.removeEventListener('click', handleCreate);
            modal.removeEventListener('click', handleBackdrop);
            document.removeEventListener('keydown', handleEscape);
        };
        const handleCreate = () => {
            const rows = parseInt(rowsInput.value);
            const cols = parseInt(colsInput.value);
            if (rows && cols && rows > 0 && cols > 0) { this.createTable(rows, cols); cleanup(); }
        };
        const handleBackdrop = (e) => { if (e.target === modal) cleanup(); };
        const handleEscape = (e) => { if (e.key === 'Escape') cleanup(); };
        const handleEnter = (e) => { if (e.key === 'Enter') handleCreate(); };

        cancelBtn.addEventListener('click', cleanup);
        createBtn.addEventListener('click', handleCreate);
        modal.addEventListener('click', handleBackdrop);
        document.addEventListener('keydown', handleEscape);
        rowsInput.addEventListener('keydown', handleEnter);
        colsInput.addEventListener('keydown', handleEnter);
    }

    createTable(rows, cols) {
        let tableHTML = '<table>';
        tableHTML += '<tr>';
        for (let j = 0; j < cols; j++) tableHTML += '<th>Header ' + (j + 1) + '</th>';
        tableHTML += '</tr>';
        for (let i = 1; i < rows; i++) {
            tableHTML += '<tr>';
            for (let j = 0; j < cols; j++) tableHTML += '<td>Cell ' + i + ',' + (j + 1) + '</td>';
            tableHTML += '</tr>';
        }
        tableHTML += '</table><br>';
        // Restore cursor to where user was before opening the modal
        this.restoreSelection();
        this.executeCommand('insertHTML', tableHTML);
    }

    setupDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return;
        this.drawCtx = canvas.getContext('2d');
        this.isDrawMode = false;
        this.isDrawing = false;
        this.drawTool = 'pen';
        this.drawColor = '#000000';
        this.drawSize = 2;

        canvas.addEventListener('mousedown', (e) => this.startDraw(e));
        canvas.addEventListener('mousemove', (e) => this.drawLine(e));
        canvas.addEventListener('mouseup', () => this.endDraw());
        canvas.addEventListener('mouseleave', () => this.endDraw());

        // Allow scrolling in draw mode - only prevent default when actually drawing
        canvas.addEventListener('touchstart', (e) => {
            this.startDraw(e.touches[0]);
        }, { passive: true });
        canvas.addEventListener('touchmove', (e) => {
            if (this.isDrawing) e.preventDefault();
            this.drawLine(e.touches[0]);
        }, { passive: false });
        canvas.addEventListener('touchend', () => this.endDraw());

        const penBtn = document.getElementById('drawPenBtn');
        const eraserBtn = document.getElementById('drawEraserBtn');
        const clearBtn = document.getElementById('drawClearBtn');
        const doneBtn = document.getElementById('drawDoneBtn');

        const colorSection = document.querySelector('.draw-color-section');
        const colorDivider = colorSection ? colorSection.previousElementSibling : null;

        if (penBtn) penBtn.addEventListener('click', () => {
            this.drawTool = 'pen';
            penBtn.classList.add('active');
            if (eraserBtn) eraserBtn.classList.remove('active');
            if (colorSection) colorSection.classList.remove('eraser-hidden');
            if (colorDivider && colorDivider.classList.contains('color-divider')) colorDivider.classList.remove('eraser-hidden');
            if (canvas) canvas.classList.remove('eraser-active');
        });
        if (eraserBtn) eraserBtn.addEventListener('click', () => {
            this.drawTool = 'eraser';
            eraserBtn.classList.add('active');
            if (penBtn) penBtn.classList.remove('active');
            if (colorSection) colorSection.classList.add('eraser-hidden');
            if (colorDivider && colorDivider.classList.contains('color-divider')) colorDivider.classList.add('eraser-hidden');
            if (canvas) canvas.classList.add('eraser-active');
        });
        if (clearBtn) clearBtn.addEventListener('click', () => {
            const c = document.getElementById('drawingCanvas');
            if (c && this.drawCtx) this.drawCtx.clearRect(0, 0, c.width, c.height);
        });
        if (doneBtn) doneBtn.addEventListener('click', () => this.finishDrawing());

        // Color swatches
        const colorPresets = document.getElementById('drawColorPresets');
        if (colorPresets) {
            colorPresets.addEventListener('click', (e) => {
                const swatch = e.target.closest('.draw-color-swatch');
                if (swatch) {
                    this.drawColor = swatch.dataset.color;
                    colorPresets.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
                    swatch.classList.add('active');
                }
            });
        }

        // Custom color picker
        const colorPicker = document.getElementById('drawColorPicker');
        if (colorPicker) {
            colorPicker.addEventListener('input', () => {
                this.drawColor = colorPicker.value;
                // Remove active from all swatches since it's a custom color
                if (colorPresets) colorPresets.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
            });
        }

        // Size preset buttons
        const toolbar = document.getElementById('drawToolbar');
        if (toolbar) {
            toolbar.addEventListener('click', (e) => {
                const sizeBtn = e.target.closest('.draw-size-btn');
                if (sizeBtn) {
                    this.drawSize = parseInt(sizeBtn.dataset.size);
                    toolbar.querySelectorAll('.draw-size-btn').forEach(b => b.classList.remove('active'));
                    sizeBtn.classList.add('active');
                    const slider = document.getElementById('drawThickness');
                    if (slider) slider.value = this.drawSize;
                }
            });
        }
    }

    resizeCanvas() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return;
        const container = canvas.parentElement || document.querySelector('.editor-content');
        if (!container) return;
        // Snapshot current drawing
        const snapshot = this.drawCtx ? canvas.toDataURL() : null;
        canvas.width = container.offsetWidth || container.clientWidth || 800;
        canvas.height = Math.max(container.offsetHeight || container.clientHeight || 600, 600);
        // Restore drawing
        if (snapshot && this.drawCtx) {
            const img = new Image();
            img.onload = () => { if (this.drawCtx) this.drawCtx.drawImage(img, 0, 0); };
            img.src = snapshot;
        }
    }

    toggleDrawMode() {
        this.isDrawMode = !this.isDrawMode;
        const canvas = document.getElementById('drawingCanvas');
        const toolbar = document.getElementById('drawToolbar');
        const textEditor = document.getElementById('textEditor');
        const drawBtn = document.getElementById('drawBtn');

        if (this.isDrawMode) {
            if (canvas) { canvas.style.pointerEvents = 'all'; canvas.style.display = 'block'; }
            // resizeCanvas snapshots+restores existing drawing; also reload from note for safety
            const noteForDraw = this.notes.find(n => n.id === this.currentNoteId);
            if (noteForDraw && noteForDraw.drawing && this.drawCtx) {
                const img = new Image();
                img.onload = () => {
                    this.resizeCanvas();
                    if (this.drawCtx) this.drawCtx.drawImage(img, 0, 0);
                };
                img.src = noteForDraw.drawing;
            } else {
                this.resizeCanvas();
            }
            if (textEditor) { textEditor.contentEditable = 'false'; }
            if (toolbar) toolbar.classList.add('visible');
            if (drawBtn) drawBtn.classList.add('active');
        } else {
            // Save the drawing and keep canvas visible (pointer-events: none)
            this.saveDrawing();
            if (canvas) {
                canvas.style.pointerEvents = 'none';
                // Keep visible if there's a drawing, else hide
                const noteForDraw = this.notes.find(n => n.id === this.currentNoteId);
                if (!noteForDraw || !noteForDraw.drawing) canvas.style.display = 'none';
            }
            if (textEditor) { textEditor.contentEditable = 'true'; }
            if (toolbar) toolbar.classList.remove('visible');
            if (drawBtn) drawBtn.classList.remove('active');
        }
    }

    finishDrawing() {
        // Save the drawing to note.drawing and exit draw mode
        // The canvas stays visible as a persistent overlay (pointer-events: none)
        if (this.isDrawMode) this.toggleDrawMode();
    }

    startDraw(e) {
        if (!this.isDrawMode || !this.drawCtx) return;
        this.isDrawing = true;
        const canvas = document.getElementById('drawingCanvas');
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        this.drawCtx.beginPath();
        this.drawCtx.moveTo(x, y);
        this.lastX = x;
        this.lastY = y;
    }

    drawLine(e) {
        if (!this.isDrawMode || !this.isDrawing || !this.drawCtx) return;
        const canvas = document.getElementById('drawingCanvas');
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        const thickness = this.drawSize || 2;

        if (this.drawTool === 'eraser') {
            this.drawCtx.globalCompositeOperation = 'destination-out';
            this.drawCtx.lineWidth = thickness * 5;
        } else {
            this.drawCtx.globalCompositeOperation = 'source-over';
            this.drawCtx.strokeStyle = this.drawColor || '#000000';
            this.drawCtx.lineWidth = thickness;
        }
        this.drawCtx.lineCap = 'round';
        this.drawCtx.lineJoin = 'round';
        this.drawCtx.lineTo(x, y);
        this.drawCtx.stroke();
        this.lastX = x;
        this.lastY = y;
    }

    endDraw() {
        if (!this.isDrawing) return;
        this.isDrawing = false;
    }

    saveDrawing() {
        if (!this.currentNoteId) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note) return;
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas || !this.drawCtx) return;
        // Check if there's anything drawn
        const pixelData = this.drawCtx.getImageData(0, 0, canvas.width, canvas.height).data;
        const hasContent = Array.from(pixelData).some(v => v > 0);
        note.drawing = hasContent ? canvas.toDataURL('image/png') : null;
        this.debouncedSave();
    }

    loadDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas || !this.drawCtx) return;
        this.drawCtx.clearRect(0, 0, canvas.width, canvas.height);
        if (!this.currentNoteId) { canvas.style.display = 'none'; return; }
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (note && note.drawing) {
            canvas.style.display = 'block';
            const img = new Image();
            img.onload = () => { if (this.drawCtx) this.drawCtx.drawImage(img, 0, 0); };
            img.src = note.drawing;
        } else {
            canvas.style.display = 'none';
        }
    }



    zoomIn() {
        const editor = document.getElementById('textEditor');
        editor.style.fontSize = (parseFloat(getComputedStyle(editor).fontSize) * 1.1) + 'px';
    }

    zoomOut() {
        const editor = document.getElementById('textEditor');
        editor.style.fontSize = (parseFloat(getComputedStyle(editor).fontSize) * 0.9) + 'px';
    }

    // ─── Utility ─────────────────────────────────────────────────────────────────

    generateId() {
        return 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    formatDate(date) {
        const now = new Date();
        const diff = now - date;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return date.toLocaleDateString();
        if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
        return 'Just now';
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    hexToRgba(hex, opacity) {
        hex = hex.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }

    sanitizeHtml(html) {
        if (!html) return '';
        const allowedTags = [
            'p', 'br', 'strong', 'em', 'u', 'b', 'i', 'ul', 'ol', 'li',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'a',
            'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
            'font', 'input', 'img', 's', 'strike', 'sub', 'sup'
        ];
        const allowedAttributes = [
            'style', 'href', 'target', 'rel',
            'face', 'color', 'size',
            'type', 'checked', 'class', 'data-checked',
            'width', 'height', 'colspan', 'rowspan', 'border',
            'cellpadding', 'cellspacing', 'align', 'valign',
            'src', 'alt', 'draggable'
        ];
        try {
            const div = document.createElement('div');
            div.innerHTML = html;
            div.querySelectorAll('script, iframe, object, embed, form, link, meta').forEach(el => el.remove());
            div.querySelectorAll('*').forEach(element => {
                const tagName = element.tagName.toLowerCase();
                if (tagName === 'input' && element.getAttribute('type') !== 'checkbox') {
                    element.remove(); return;
                }
                if (!allowedTags.includes(tagName)) {
                    const span = document.createElement('span');
                    span.innerHTML = element.innerHTML;
                    element.parentNode.replaceChild(span, element);
                    return;
                }
                Array.from(element.attributes).forEach(attr => {
                    const attrName = attr.name.toLowerCase();
                    const attrValue = attr.value;
                    const attrValueLower = attrValue.toLowerCase();
                    if (attrName === 'href' && tagName === 'a') {
                        if (attrValueLower.startsWith('http://') || attrValueLower.startsWith('https://') || attrValueLower.startsWith('mailto:')) return;
                    }
                    if (attrName === 'src' && tagName === 'img') {
                        if (attrValueLower.startsWith('data:image/') || attrValueLower.startsWith('http://') || attrValueLower.startsWith('https://') || attrValueLower.startsWith('/')) return;
                    }
                    if (attrName.startsWith('on') || attrValueLower.includes('javascript:') ||
                        (attrName === 'src' && tagName !== 'img') || (attrName === 'href' && tagName !== 'a') || !allowedAttributes.includes(attrName)) {
                        element.removeAttribute(attr.name);
                    }
                });
                if (element.hasAttribute('style')) {
                    const style = element.getAttribute('style');
                    if (style && (style.includes('javascript:') || style.includes('expression(') || style.includes('@import'))) {
                        element.removeAttribute('style');
                    }
                }
            });
            return div.innerHTML;
        } catch (error) {
            const div = document.createElement('div');
            div.textContent = html;
            return div.innerHTML;
        }
    }

    // ─── MS Dropdowns ────────────────────────────────────────────────────────────

    setupMSDropdowns() {
        document.querySelectorAll('.ms-dropdown').forEach(dropdown => {
            const btn = dropdown.querySelector('.ms-dropdown-btn');
            const menu = dropdown.querySelector('.ms-dropdown-menu');
            const items = dropdown.querySelectorAll('.ms-dropdown-item');

            btn.setAttribute('aria-expanded', 'false');
            btn.setAttribute('aria-haspopup', 'listbox');
            menu.setAttribute('role', 'listbox');
            items.forEach((item, index) => {
                item.setAttribute('role', 'option');
                item.setAttribute('tabindex', '-1');
                item.id = `dropdown-item-${dropdown.id}-${index}`;
            });

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.saveSelection();
                document.querySelectorAll('.ms-dropdown.active').forEach(other => {
                    if (other !== dropdown) { other.classList.remove('active'); other.querySelector('.ms-dropdown-btn').setAttribute('aria-expanded', 'false'); }
                });
                const isActive = dropdown.classList.toggle('active');
                btn.setAttribute('aria-expanded', isActive);
                if (isActive && items[0]) items[0].focus();
            });

            btn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); btn.click(); }
            });

            items.forEach((item, index) => {
                item.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); (items[index + 1] || items[0]).focus(); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[index - 1] || items[items.length - 1]).focus(); }
                    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
                    else if (e.key === 'Escape') { e.preventDefault(); dropdown.classList.remove('active'); btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
                });
            });

            items.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation(); e.preventDefault();
                    const value = item.dataset.value;
                    if (value === undefined || value === null || value === '') return; // Skip group labels
                    const label = item.dataset.label || item.textContent;
                    const valueSpan = btn.querySelector('.dropdown-value');
                    // For color-only dropdowns, keep the permanent label (e.g. "Text", "Highlight")
                    const isColorOnlyDropdown = dropdown.id === 'fontColorDropdown' || dropdown.id === 'highlightColorDropdown';
                    if (valueSpan && !isColorOnlyDropdown) valueSpan.textContent = label;
                    const colorPreview = btn.querySelector('.color-preview');
                    if (colorPreview && value) {
                        if (value === 'transparent') {
                            colorPreview.style.background = 'transparent';
                            colorPreview.style.border = '1px solid #ccc';
                            colorPreview.removeAttribute('data-color');
                        } else {
                            colorPreview.style.background = value;
                            colorPreview.style.border = '';
                            colorPreview.setAttribute('data-color', value);
                        }
                    }
                    dropdown.classList.remove('active');
                    btn.setAttribute('aria-expanded', 'false');
                    setTimeout(() => {
                        const editor = document.getElementById('textEditor');
                        if (editor) editor.focus();
                        this.restoreSelection();
                        if (dropdown.id === 'fontFamilyDropdown') this.executeCommand('fontName', value);
                        else if (dropdown.id === 'fontSizeDropdown') this.executeCommand('fontSize', value);
                        else if (dropdown.id === 'fontColorDropdown') this.executeCommand('foreColor', value);
                        else if (dropdown.id === 'highlightColorDropdown') this.executeCommand('hiliteColor', value);
                        else if (dropdown.id === 'noteColorDropdown') this.updateNoteColor(value);
                        this.updateButtonStates();
                    }, 10);
                });
            });
        });

        document.addEventListener('click', () => {
            document.querySelectorAll('.ms-dropdown.active').forEach(dropdown => {
                dropdown.classList.remove('active');
                dropdown.querySelector('.ms-dropdown-btn').setAttribute('aria-expanded', 'false');
            });
        });
    }

    // ─── Context Menu ────────────────────────────────────────────────────────────

    setupCustomContextMenu() {
        const contextMenu = document.getElementById('customContextMenu');
        const textEditor = document.getElementById('textEditor');
        if (!contextMenu || !textEditor) return;

        textEditor.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.saveSelection();
            contextMenu.style.left = e.pageX + 'px';
            contextMenu.style.top = e.pageY + 'px';
            contextMenu.style.display = 'block';
            const rect = contextMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) contextMenu.style.left = (e.pageX - rect.width) + 'px';
            if (rect.bottom > window.innerHeight) contextMenu.style.top = (e.pageY - rect.height) + 'px';
        });

        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;
            this.restoreSelection();
            switch (item.dataset.action) {
                case 'copy': this.executeCommand('copy'); break;
                case 'paste': this.executeCommand('paste'); break;
                case 'bold': this.executeCommand('bold'); this.updateButtonStates(); break;
                case 'italic': this.executeCommand('italic'); this.updateButtonStates(); break;
                case 'underline': this.executeCommand('underline'); this.updateButtonStates(); break;
                case 'selectAll': this.executeCommand('selectAll'); break;
            }
            contextMenu.style.display = 'none';
        });

        document.addEventListener('click', (e) => { if (!contextMenu.contains(e.target)) contextMenu.style.display = 'none'; });
        document.addEventListener('scroll', () => { contextMenu.style.display = 'none'; });
    }

    // ─── Table Toolbar ───────────────────────────────────────────────────────────

    setupTableToolbar() {
        const toolbar = document.getElementById('tableToolbar');
        const editor = document.getElementById('textEditor');
        if (!toolbar || !editor) return;

        let activeCell = null;

        // Show toolbar when user clicks inside a table cell
        editor.addEventListener('click', (e) => {
            const cell = e.target.closest('td, th');
            if (cell && editor.contains(cell)) {
                activeCell = cell;
                toolbar.style.display = 'flex';
                // Position toolbar above the table
                const table = cell.closest('table');
                const tableRect = table.getBoundingClientRect();
                const tbH = 36;
                let top = tableRect.top - tbH - 6;
                if (top < 4) top = tableRect.bottom + 6;
                toolbar.style.top = top + 'px';
                toolbar.style.left = Math.max(4, tableRect.left) + 'px';
            } else {
                if (!toolbar.contains(e.target)) { toolbar.style.display = 'none'; activeCell = null; }
            }
        });

        // Handle toolbar button actions
        toolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.tbl-btn');
            if (!btn || !activeCell) return;
            const action = btn.dataset.tbl;
            const row = activeCell.parentElement;
            const table = row ? row.closest('table') : null;
            if (!table) return;

            const colIndex = Array.from(row.children).indexOf(activeCell);

            if (action === 'addRowAbove') {
                const newRow = this._makeTableRow(row.cells.length, row.querySelector('th') ? 'th' : 'td');
                row.parentNode.insertBefore(newRow, row);
            } else if (action === 'addRowBelow') {
                const newRow = this._makeTableRow(row.cells.length, 'td');
                row.parentNode.insertBefore(newRow, row.nextSibling);
            } else if (action === 'deleteRow') {
                if (table.rows.length > 1) { row.remove(); activeCell = null; toolbar.style.display = 'none'; }
                else { table.remove(); toolbar.style.display = 'none'; activeCell = null; }
            } else if (action === 'addColLeft') {
                Array.from(table.rows).forEach((r, ri) => {
                    const cell = document.createElement(ri === 0 ? 'th' : 'td');
                    cell.textContent = ri === 0 ? 'Header' : '';
                    r.insertBefore(cell, r.cells[colIndex]);
                });
            } else if (action === 'addColRight') {
                Array.from(table.rows).forEach((r, ri) => {
                    const cell = document.createElement(ri === 0 ? 'th' : 'td');
                    cell.textContent = ri === 0 ? 'Header' : '';
                    const ref = r.cells[colIndex + 1];
                    if (ref) r.insertBefore(cell, ref); else r.appendChild(cell);
                });
            } else if (action === 'deleteCol') {
                if (row.cells.length > 1) {
                    Array.from(table.rows).forEach(r => { if (r.cells[colIndex]) r.cells[colIndex].remove(); });
                }
            } else if (action === 'moveTable') {
                this.setupTableDrag(table);
                toolbar.style.display = 'none';
                activeCell = null;
                this.showToast('Table is now draggable — grab the Move handle on the table to reposition it.');
                return;
            }
            this.updateNoteContent();
        });

        // Hide toolbar when clicking outside editor
        document.addEventListener('click', (e) => {
            if (!editor.contains(e.target) && !toolbar.contains(e.target)) {
                toolbar.style.display = 'none'; activeCell = null;
            }
        });
    }

    _makeTableRow(colCount, cellTag = 'td') {
        const row = document.createElement('tr');
        for (let i = 0; i < colCount; i++) {
            const cell = document.createElement(cellTag);
            cell.textContent = '';
            row.appendChild(cell);
        }
        return row;
    }

    // ─── Note Color ──────────────────────────────────────────────────────────────

    updateNoteColor(color) {
        if (!this.currentNoteId) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note) return;
        note.color = color;
        this.debouncedSave();
        this.renderNotesList();
        const textEditor = document.getElementById('textEditor');
        if (textEditor) {
            textEditor.style.backgroundColor = color === '#ffffff' ? 'rgba(255, 255, 255, 0.5)' : color;
        }
    }

    // ─── Delete Modal ────────────────────────────────────────────────────────────

    showDeleteModal(noteTitle, onConfirm) {
        const modal = document.getElementById('deleteModal');
        const message = document.getElementById('deleteModalMessage');
        const cancelBtn = document.getElementById('deleteModalCancel');
        const confirmBtn = document.getElementById('deleteModalConfirm');
        message.textContent = `Are you sure you want to delete "${noteTitle}"? This action cannot be undone.`;
        modal.classList.add('show');

        const cleanup = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', cleanup);
            confirmBtn.removeEventListener('click', handleConfirm);
            modal.removeEventListener('click', handleBackdrop);
            document.removeEventListener('keydown', handleEscape);
        };
        const handleConfirm = () => { cleanup(); onConfirm(); };
        const handleBackdrop = (e) => { if (e.target === modal) cleanup(); };
        const handleEscape = (e) => { if (e.key === 'Escape') cleanup(); };

        cancelBtn.addEventListener('click', cleanup);
        confirmBtn.addEventListener('click', handleConfirm);
        modal.addEventListener('click', handleBackdrop);
        document.addEventListener('keydown', handleEscape);
    }

    // ─── Sidebar Toggle (Desktop) ────────────────────────────────────────────────

    setupSidebarToggle() {
        const toggleBtn = document.getElementById('sidebarToggle');
        const sidebar = document.querySelector('.sidebar');
        if (!toggleBtn || !sidebar) return;

        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();

            if (this.isMobile()) {
                // On mobile, toggle acts as open/close
                if (this.sidebarOpen) this.closeMobileSidebar();
                else this.openMobileSidebar();
                return;
            }

            sidebar.classList.toggle('collapsed');
            const isCollapsed = sidebar.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed.toString());
            this.updateToggleIcon(toggleBtn, isCollapsed);
        });

        const savedState = localStorage.getItem('sidebarCollapsed');
        if (savedState === 'true' && !this.isMobile()) {
            sidebar.classList.add('collapsed');
            this.updateToggleIcon(toggleBtn, true);
        }

        toggleBtn.style.opacity = '1';
        toggleBtn.style.pointerEvents = 'auto';
    }

    updateToggleIcon(toggleBtn, isCollapsed) {
        const svg = toggleBtn.querySelector('svg');
        if (!svg) return;
        if (isCollapsed) {
            svg.innerHTML = '<line x1="9" y1="18" x2="15" y2="12"/><line x1="9" y1="6" x2="15" y2="12"/>';
            toggleBtn.title = 'Expand Sidebar';
        } else {
            svg.innerHTML = '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>';
            toggleBtn.title = 'Collapse Sidebar';
        }
    }

    // ─── Editor Empty Detection ──────────────────────────────────────────────────

    isEditorEmpty(editor) {
        const content = editor.innerHTML.trim();
        const textContent = editor.textContent.trim();
        const meaningfulElements = content.match(/<(img|table|audio|video|iframe|embed|object|canvas|svg)[^>]*>/gi);
        if (meaningfulElements && meaningfulElements.length > 0) return false;
        const listMatches = content.match(/<(ul|ol)[^>]*>[\s\S]*?<\/(ul|ol)>/gi);
        if (listMatches && listMatches.some(list => list.replace(/<[^>]*>/g, '').trim() !== '')) return false;
        if (textContent === '' || textContent === '\u00A0') return true;
        const emptyPatterns = ['', '<br>', '<div></div>', '<p></p>', '<div><br></div>', '<p><br></p>', '<div>\u00A0</div>', '<p>\u00A0</p>', '<p>Start typing your note here...</p>', '<ul></ul>', '<ol></ol>', '<ul><li></li></ul>', '<ol><li></li></ol>'];
        return emptyPatterns.includes(content);
    }

    updatePlaceholderState(editor) {
        if (this.isEditorEmpty(editor)) editor.setAttribute('data-empty', 'true');
        else editor.removeAttribute('data-empty');
    }

    setupEditorPlaceholder() {
        const textEditor = document.getElementById('textEditor');
        if (!textEditor) return;
        textEditor.addEventListener('focus', () => this.updatePlaceholderState(textEditor));
        textEditor.addEventListener('blur', () => this.updatePlaceholderState(textEditor));
        textEditor.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' || e.key === 'Delete')
                setTimeout(() => this.updatePlaceholderState(textEditor), 0);
        });
        this.updatePlaceholderState(textEditor);
    }

    // ─── Clipboard ───────────────────────────────────────────────────────────────

    async modernCut() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const selectedText = range.toString();
        if (selectedText) {
            try {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([this.getSelectedHtml()], { type: 'text/html' }),
                    'text/plain': new Blob([selectedText], { type: 'text/plain' })
                })]);
                range.deleteContents();
                this.updateNoteContent();
            } catch { try { document.execCommand('cut'); this.updateNoteContent(); } catch (err) { console.error('Cut failed:', err); } }
        }
    }

    async modernCopy() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const selectedText = selection.toString();
        if (selectedText) {
            try {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([this.getSelectedHtml()], { type: 'text/html' }),
                    'text/plain': new Blob([selectedText], { type: 'text/plain' })
                })]);
            } catch { try { document.execCommand('copy'); } catch (err) { console.error('Copy failed:', err); } }
        }
    }

    async modernPaste() {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                if (item.types.includes('text/html')) {
                    const html = await (await item.getType('text/html')).text();
                    if (html) { this.insertHtmlAtSelection(html); this.updateNoteContent(); return; }
                }
                if (item.types.includes('text/plain')) {
                    const text = await (await item.getType('text/plain')).text();
                    if (text) { this.insertTextAtSelection(text); this.updateNoteContent(); return; }
                }
            }
        } catch {
            try {
                const text = await navigator.clipboard.readText();
                if (text) { this.insertTextAtSelection(text); this.updateNoteContent(); return; }
            } catch {
                try { document.execCommand('paste'); this.updateNoteContent(); } catch (err) { console.error('Paste failed:', err); }
            }
        }
    }

    modernFontFamily(font) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
            const span = document.createElement('span');
            span.style.fontFamily = font;
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;';
            range.insertNode(span);
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            this.setupTempFormatting(span, { fontFamily: font });
        } else {
            const span = document.createElement('span');
            span.style.fontFamily = font;
            try {
                span.appendChild(range.extractContents());
                range.insertNode(span);
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch { document.execCommand('fontName', false, font); }
        }
        this.updateNoteContent();
    }

    modernFontSize(size) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;';
            range.insertNode(span);
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            this.setupTempFormatting(span, { fontSize: size + 'px' });
        } else {
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';
            try {
                span.appendChild(range.extractContents());
                range.insertNode(span);
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch { document.execCommand('fontSize', false, size); }
        }
        this.updateNoteContent();
    }

    modernTextColor(color) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
            const span = document.createElement('span');
            span.style.color = color;
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;';
            range.insertNode(span);
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            this.setupTempFormatting(span, { color });
        } else {
            const span = document.createElement('span');
            span.style.color = color;
            try {
                span.appendChild(range.extractContents());
                range.insertNode(span);
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch { document.execCommand('foreColor', false, color); }
        }
        this.updateNoteContent();
    }

    modernHighlightColor(color) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const isNone = !color || color === 'transparent' || color === 'none';
        if (range.collapsed) {
            if (!isNone) {
                const span = document.createElement('span');
                span.style.backgroundColor = color;
                span.className = 'temp-formatting';
                span.innerHTML = '&#8203;';
                range.insertNode(span);
                range.setStartAfter(span);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                this.setupTempFormatting(span, { backgroundColor: color });
            }
        } else {
            if (isNone) {
                // In-place removal: walk up ancestors and within selection to clear background-color
                const editor = document.getElementById('textEditor');
                const unwrapSpan = (el) => {
                    const parent = el.parentNode;
                    if (!parent) return;
                    while (el.firstChild) parent.insertBefore(el.firstChild, el);
                    parent.removeChild(el);
                };

                // 1. Walk up ancestors of selection start to clear parent highlight spans
                let ancestor = range.commonAncestorContainer;
                if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentElement;
                let cur = ancestor;
                while (cur && cur !== editor && cur !== document.body) {
                    if (cur.nodeType === Node.ELEMENT_NODE && cur.style && cur.style.backgroundColor) {
                        cur.style.removeProperty('background-color');
                        if (cur.tagName === 'SPAN' && (!cur.getAttribute('style') || cur.getAttribute('style').trim() === '') && !cur.className) {
                            const next = cur.parentElement;
                            unwrapSpan(cur);
                            cur = next;
                            continue;
                        }
                    }
                    cur = cur.parentElement;
                }

                // 2. Clear highlight from all descendant elements within the range
                if (ancestor && ancestor !== editor) {
                    const spans = Array.from(ancestor.querySelectorAll('span[style]'));
                    for (let i = spans.length - 1; i >= 0; i--) {
                        const el = spans[i];
                        try { if (!range.intersectsNode(el)) continue; } catch { continue; }
                        el.style.removeProperty('background-color');
                        if (el.tagName === 'SPAN' && (!el.getAttribute('style') || el.getAttribute('style').trim() === '') && !el.className) {
                            unwrapSpan(el);
                        }
                    }
                }
            } else {
                const span = document.createElement('span');
                span.style.backgroundColor = color;
                try {
                    span.appendChild(range.extractContents());
                    range.insertNode(span);
                    range.selectNodeContents(span);
                    selection.removeAllRanges();
                    selection.addRange(range);
                } catch { document.execCommand('hiliteColor', false, color); }
            }
        }
        this.updateNoteContent();
    }

    insertTextAtSelection(text) {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    getSelectedHtml() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return '';
        const div = document.createElement('div');
        div.appendChild(selection.getRangeAt(0).cloneContents());
        return div.innerHTML;
    }

    insertHtmlAtSelection(html) {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const fragment = document.createRange().createContextualFragment(this.sanitizeHtml(html));
        range.insertNode(fragment);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    setupTempFormatting(span, styles) {
        const editor = document.getElementById('textEditor');
        this.tempFormattingStyles = styles;
        this.tempFormattingSpan = span;

        const handleInput = (e) => {
            if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
                const range = window.getSelection().getRangeAt(0);
                const textNode = range.startContainer;
                if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                    const newSpan = document.createElement('span');
                    Object.assign(newSpan.style, this.tempFormattingStyles);
                    if (this.tempFormattingSpan && this.tempFormattingSpan.parentNode) {
                        this.tempFormattingSpan.parentNode.replaceChild(newSpan, this.tempFormattingSpan);
                        newSpan.appendChild(textNode);
                        const newRange = document.createRange();
                        newRange.setStartAfter(newSpan);
                        newRange.collapse(true);
                        const selection = window.getSelection();
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    }
                }
                this.tempFormattingStyles = null;
                this.tempFormattingSpan = null;
                editor.removeEventListener('input', handleInput);
            }
        };

        const cleanupHandler = () => {
            if (this.tempFormattingSpan && this.tempFormattingSpan.parentNode) {
                this.tempFormattingSpan.parentNode.removeChild(this.tempFormattingSpan);
                if (this.tempFormattingSpan.parentNode && this.tempFormattingSpan.parentNode.normalize)
                    this.tempFormattingSpan.parentNode.normalize();
            }
            this.tempFormattingStyles = null;
            this.tempFormattingSpan = null;
            editor.removeEventListener('input', handleInput);
            editor.removeEventListener('click', cleanupHandler);
        };

        editor.addEventListener('input', handleInput, { once: true });
        editor.addEventListener('click', cleanupHandler, { once: true });
        editor.addEventListener('keydown', (e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) cleanupHandler();
        }, { once: true });
    }

    // ─── Export / Import ─────────────────────────────────────────────────────────

    async exportNoteAsLink() {
        if (!this.currentNoteId) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note) return;
        try {
            const token = await compressToUrl(JSON.stringify({ t: note.title, c: note.content }));
            const shareLink = `${window.location.origin}${window.location.pathname}?s=${token}`;
            const exportModal = document.getElementById('exportModal');
            const exportLink = document.getElementById('exportLink');
            const cancelBtn = document.getElementById('exportModalCancel');
            const copyBtn = document.getElementById('exportModalCopy');
            if (!exportModal) return;
            this.saveSelection();
            exportModal.classList.add('show');
            exportLink.value = shareLink;
            exportLink.select();

            const cleanup = () => {
                exportModal.classList.remove('show');
                cancelBtn.removeEventListener('click', cleanup);
                copyBtn.removeEventListener('click', handleCopy);
            };
            const handleCopy = () => {
                exportLink.select();
                try {
                    if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(exportLink.value).then(cleanup).catch(() => { document.execCommand('copy'); cleanup(); });
                    } else { document.execCommand('copy'); cleanup(); }
                } catch { }
                cancelBtn.removeEventListener('click', cleanup);
                copyBtn.removeEventListener('click', handleCopy);
            };
            cancelBtn.addEventListener('click', cleanup);
            copyBtn.addEventListener('click', handleCopy);
        } catch (error) { console.error('Error encoding note:', error); }
    }

    async importNoteFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('s');
        if (!token) return;
        try {
            const data = JSON.parse(await decompressFromUrl(token));
            const newNote = {
                id: this.generateId(),
                title: data.t || 'Untitled',
                content: data.c || '',
                color: '#ffffff',
                createdAt: new Date().toISOString(),
                modifiedAt: new Date().toISOString()
            };
            this.notes.unshift(newNote);
            this.selectNote(newNote.id);
            this.renderNotesList();
            this.saveNotesToStorage();
            window.history.replaceState({}, document.title, window.location.pathname);
            setTimeout(() => this.showImportModal(data.t || 'Untitled'), 150);
        } catch (error) { console.error('Error importing note:', error); }
    }

    showImportModal(noteTitle) {
        const modal = document.getElementById('importModal');
        const message = document.getElementById('importModalMessage');
        const cancelBtn = document.getElementById('importModalCancel');
        const continueBtn = document.getElementById('importModalContinue');
        if (!modal || !message) return;
        message.innerHTML = `Added to your collection: <strong>${noteTitle}</strong>`;
        modal.classList.add('show');
        const close = () => modal.classList.remove('show');
        if (cancelBtn) cancelBtn.onclick = close;
        if (continueBtn) continueBtn.onclick = close;
    }
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    window.notesApp = new NotesApp();
    window.notesApp.importNoteFromUrl();
});

window.addEventListener('beforeunload', () => {
    const app = window.notesApp;
    if (app && app.saveTimeout) { clearTimeout(app.saveTimeout); app.saveNotesToStorage(); }
});    