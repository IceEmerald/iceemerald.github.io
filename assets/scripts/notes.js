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

        // Collaboration (initialized in init())
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

        // Initialize collaboration manager
        this.collab = new CollaborationManager(this);
        this.collab.checkRoomFromUrl();
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

        const goLiveBtn = document.getElementById('goLiveBtn');
        if (goLiveBtn) goLiveBtn.addEventListener('click', () => this.collab?.goLive());
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
                    <div class="ms-dropdown-item" data-value="Arial">Arial</div>
                    <div class="ms-dropdown-item" data-value="Helvetica">Helvetica</div>
                    <div class="ms-dropdown-item" data-value="Times New Roman">Times New Roman</div>
                    <div class="ms-dropdown-item" data-value="Georgia">Georgia</div>
                    <div class="ms-dropdown-item" data-value="Verdana">Verdana</div>
                    <div class="ms-dropdown-item" data-value="Courier New">Courier New</div>
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
        const insertLinkBtn = document.getElementById('insertLinkBtn');
        if (insertTableBtn) insertTableBtn.addEventListener('click', () => this.insertTable());
        if (insertLinkBtn) insertLinkBtn.addEventListener('click', () => this.insertLink());

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

        editor.addEventListener('paste', (e) => {
            setTimeout(() => {
                this.updatePlaceholderState(editor);
                this.updateNoteContent();
            }, 10);
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
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(this.savedSelection.cloneRange());
            document.getElementById('textEditor').focus();
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

        const commands = ['bold', 'italic', 'underline', 'justifyLeft', 'justifyCenter', 'justifyRight', 'insertUnorderedList', 'insertOrderedList'];
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
            if (!fontFamily && styles.fontFamily && styles.fontFamily !== 'inherit')
                fontFamily = styles.fontFamily.replace(/['"]/g, '');
            if (!fontSize && element.style && element.style.fontSize)
                fontSize = element.style.fontSize.replace('px', '');
            if (!textColor && element.style && element.style.color)
                textColor = element.style.color;
            if (!backgroundColor && element.style && element.style.backgroundColor)
                backgroundColor = element.style.backgroundColor;
            element = element.parentElement;
        }

        const fontFamilyDropdown = document.getElementById('fontFamilyDropdown');
        if (fontFamilyDropdown && fontFamily) {
            const valueSpan = fontFamilyDropdown.querySelector('.dropdown-value');
            if (valueSpan) {
                const matchingItem = fontFamilyDropdown.querySelector(`[data-value="${fontFamily}"]`);
                if (matchingItem) valueSpan.textContent = matchingItem.dataset.label || matchingItem.textContent;
            }
        }

        const fontSizeDropdown = document.getElementById('fontSizeDropdown');
        if (fontSizeDropdown && fontSize) {
            const valueSpan = fontSizeDropdown.querySelector('.dropdown-value');
            if (valueSpan) valueSpan.textContent = fontSize + 'px';
        }

        const fontColorDropdown = document.getElementById('fontColorDropdown');
        if (fontColorDropdown && textColor) {
            const colorPreview = fontColorDropdown.querySelector('.color-preview');
            if (colorPreview) { colorPreview.style.background = textColor; colorPreview.setAttribute('data-color', textColor); }
        }

        const highlightColorDropdown = document.getElementById('highlightColorDropdown');
        if (highlightColorDropdown && backgroundColor) {
            const colorPreview = highlightColorDropdown.querySelector('.color-preview');
            if (colorPreview) { colorPreview.style.background = backgroundColor; colorPreview.setAttribute('data-color', backgroundColor); }
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

        setTimeout(() => document.getElementById('textEditor').focus(), 100);
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
            <div class="note-item-title">${this.escapeHtml(note.title)}${note.isLive ? '<span class="live-badge">● Live</span>' : ''}</div>
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

    insertTable() { this.showTableModal(); }
    insertLink() { this.showLinkModal(); }

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
        tableHTML += '</table>';
        this.executeCommand('insertHTML', tableHTML);
    }

    showLinkModal() {
        const modal = document.getElementById('linkModal');
        const cancelBtn = document.getElementById('linkModalCancel');
        const createBtn = document.getElementById('linkModalCreate');
        const urlInput = document.getElementById('linkUrl');
        const textInput = document.getElementById('linkText');
        if (!modal) return;
        this.saveSelection();
        modal.classList.add('show');
        urlInput.value = 'https://';
        textInput.value = '';
        createBtn.disabled = true;
        setTimeout(() => { urlInput.focus(); urlInput.select(); }, 100);

        const validateUrl = (url) => {
            if (!url || url.trim() === '' || url.trim() === 'https://') return { valid: false, message: '' };
            url = url.trim();
            if (!url.match(/^[a-z][a-z0-9+.-]*:/i)) { url = 'https://' + url; urlInput.value = url; }
            const dangerousSchemes = ['javascript:', 'data:', 'vbscript:', 'file:', 'about:'];
            for (const scheme of dangerousSchemes) {
                if (url.toLowerCase().startsWith(scheme))
                    return { valid: false, message: 'Unsafe URL scheme. Use http://, https://, or mailto:' };
            }
            if (!/^(https?|mailto):/i.test(url)) return { valid: false, message: 'Only HTTP, HTTPS, and mailto URLs allowed' };
            try {
                if (url.startsWith('mailto:')) {
                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url.substring(7)))
                        return { valid: false, message: 'Invalid email address' };
                } else {
                    const urlObj = new URL(url);
                    if (!urlObj.hostname) return { valid: false, message: 'Invalid URL format' };
                }
                return { valid: true, message: '', url };
            } catch { return { valid: false, message: 'Invalid URL format' }; }
        };

        const showFeedback = (input, message, isValid) => {
            let feedback = input.parentNode.querySelector('.validation-feedback');
            if (!feedback) { feedback = document.createElement('div'); feedback.className = 'validation-feedback'; input.parentNode.appendChild(feedback); }
            feedback.textContent = message;
            feedback.className = `validation-feedback ${isValid ? 'valid' : 'invalid'}`;
            feedback.style.display = message ? 'block' : 'none';
        };

        const updateBtn = () => {
            const url = urlInput.value.trim();
            const text = textInput.value.trim();
            const v = validateUrl(url);
            createBtn.disabled = !(v.valid && text);
            if (url && url !== 'https://') showFeedback(urlInput, v.message || (v.valid ? 'Valid URL' : ''), v.valid);
            else { const f = urlInput.parentNode.querySelector('.validation-feedback'); if (f) f.style.display = 'none'; }
        };

        const cleanup = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', cleanup);
            createBtn.removeEventListener('click', handleCreate);
            urlInput.removeEventListener('input', updateBtn);
            textInput.removeEventListener('input', updateBtn);
            this.restoreSelection();
        };
        const handleCreate = () => {
            const url = urlInput.value.trim();
            const text = textInput.value.trim();
            const v = validateUrl(url);
            if (v.valid && text) {
                this.restoreSelection();
                this.executeCommand('insertHTML', `<a href="${this.escapeHtml(v.url || url)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(text)}</a>`);
                cleanup();
            }
        };

        cancelBtn.addEventListener('click', cleanup);
        createBtn.addEventListener('click', handleCreate);
        modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(); });
        urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !createBtn.disabled) handleCreate(); });
        textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !createBtn.disabled) handleCreate(); });
        urlInput.addEventListener('input', updateBtn);
        textInput.addEventListener('input', updateBtn);
        updateBtn();
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
        const allowedTags = ['p', 'br', 'strong', 'em', 'u', 'b', 'i', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'a', 'table', 'tr', 'td', 'th'];
        const allowedAttributes = ['style', 'href', 'target', 'rel'];
        try {
            const div = document.createElement('div');
            div.innerHTML = html;
            div.querySelectorAll('script, iframe, object, embed, form, input, button, link, meta').forEach(el => el.remove());
            div.querySelectorAll('*').forEach(element => {
                const tagName = element.tagName.toLowerCase();
                if (!allowedTags.includes(tagName)) {
                    const span = document.createElement('span');
                    span.innerHTML = element.innerHTML;
                    element.parentNode.replaceChild(span, element);
                    return;
                }
                Array.from(element.attributes).forEach(attr => {
                    const attrName = attr.name.toLowerCase();
                    const attrValue = attr.value.toLowerCase();
                    if (attrName === 'href' && tagName === 'a') {
                        if (attrValue.startsWith('http://') || attrValue.startsWith('https://') || attrValue.startsWith('mailto:')) return;
                    }
                    if (attrName.startsWith('on') || attrName.includes('javascript:') || attrValue.includes('javascript:') ||
                        attrName === 'src' || (attrName === 'href' && tagName !== 'a') || !allowedAttributes.includes(attrName)) {
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
                    const label = item.dataset.label || item.textContent;
                    const valueSpan = btn.querySelector('.dropdown-value');
                    if (valueSpan) valueSpan.textContent = label;
                    const colorPreview = btn.querySelector('.color-preview');
                    if (colorPreview && value) {
                        colorPreview.style.background = value;
                        colorPreview.setAttribute('data-color', value);
                        if (value === 'transparent') { colorPreview.style.border = '1px solid #ccc'; colorPreview.removeAttribute('data-color'); }
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
    }

    modernHighlightColor(color) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
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

// ─── Collaboration Manager ──────────────────────────────────────────────────────

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

    _getOrCreate(key, def) {
        let v = localStorage.getItem(key);
        if (!v) { v = def; localStorage.setItem(key, v); }
        return v;
    }

    _randomColor() {
        const c = ['#e74c3c','#e67e22','#27ae60','#2980b9','#8e44ad','#16a085','#d35400','#c0392b'];
        return c[Math.floor(Math.random() * c.length)];
    }

    getConfig() {
        try { return JSON.parse(localStorage.getItem('firebase_config') || 'null'); } catch { return null; }
    }

    saveSetupConfig() {
        const raw = document.getElementById('firebaseConfigInput')?.value?.trim();
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            const dbUrl = parsed.databaseURL || parsed.databaseUrl || parsed.url || raw;
            const config = typeof raw === 'string' && raw.startsWith('{') ? parsed : {
                apiKey: '',
                authDomain: '',
                databaseURL: dbUrl,
                projectId: '',
                appId: ''
            };
            if (!config.databaseURL) throw new Error('Missing databaseURL');
            localStorage.setItem('firebase_config', JSON.stringify(config));
            document.getElementById('firebaseSetupModal')?.classList.remove('show');
            this.db = null;
            this.goLive();
        } catch { alert('Paste either the Firebase config JSON or just the database URL.'); }
    }

    _prefillFirebaseUrl() {
        const el = document.getElementById('firebaseConfigInput');
        if (!el || el.value.trim()) return;
        el.value = 'https://emeraldnetwork-web-default-rtdb.asia-southeast1.firebasedatabase.app/';
    }

    showSetupModal() {
        this._prefillFirebaseUrl();
        document.getElementById('firebaseSetupModal')?.classList.add('show');
    }

    async initFirebase() {
        if (this.db) return true;
        if (typeof firebase === 'undefined') {
            alert('Firebase SDK failed to load. Check your internet connection.');
            return false;
        }
        const config = this.getConfig();
        if (!config) return false;
        try {
            if (!firebase.apps.length) firebase.initializeApp(config);
            this.db = firebase.database();
            return true;
        } catch (e) {
            console.error('Firebase init:', e);
            alert('Firebase error: ' + e.message);
            return false;
        }
    }

    async checkRoomFromUrl() {
        const m = window.location.hash.match(/#room\/([a-zA-Z0-9_-]+)/);
        if (!m) return;
        const roomId = m[1];
        const ok = await this.initFirebase();
        if (!ok) { this._pendingRoom = roomId; this.showSetupModal(); return; }
        await this.joinRoom(roomId);
    }

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
        await this.db.ref('rooms/' + roomId).set({
            title: note.title || 'Untitled Note',
            content: note.content || '',
            createdAt: Date.now(),
            hostId: this.userId
        });

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
        if (!data) {
            alert('This shared note no longer exists.');
            window.history.replaceState({}, '', window.location.pathname);
            return;
        }
        this.currentRoom = roomId;
        this.isHost = false;
        let note = this.app.notes.find(n => n.roomId === roomId);
        if (!note) {
            note = {
                id: this.app.generateId(),
                title: data.title || 'Shared Note',
                content: data.content || '',
                color: '#ffffff',
                createdAt: new Date().toISOString(),
                modifiedAt: new Date().toISOString(),
                isLive: true,
                roomId
            };
            this.app.notes.unshift(note);
        } else {
            note.title = data.title || note.title;
            note.content = data.content || note.content;
            note.isLive = true;
        }
        this.app.selectNote(note.id);
        this.app.renderNotesList();
        this.app.saveNotesToStorage();
        this._listenRoom(roomId);
        this._registerPresence(roomId);
        this._updateGoLiveBtn(true);
    }

    _listenRoom(roomId) {
        const ref = this.db.ref('rooms/' + roomId);
        ref.child('content').on('value', snap => {
            if (this.isLocalUpdate) return;
            const val = snap.val();
            const note = this.app.notes.find(n => n.roomId === roomId);
            if (!note || val === null) return;
            note.content = val;
            if (this.app.currentNoteId === note.id) {
                const ed = document.getElementById('textEditor');
                if (ed && ed.innerHTML !== val) ed.innerHTML = val;
            }
        });
        ref.child('title').on('value', snap => {
            if (this.isLocalUpdate) return;
            const val = snap.val();
            const note = this.app.notes.find(n => n.roomId === roomId);
            if (!note || val === null) return;
            note.title = val;
            if (this.app.currentNoteId === note.id) {
                const ti = document.getElementById('noteTitle');
                if (ti && ti.value !== val) ti.value = val;
            }
            this.app.renderNotesList();
        });
        ref.child('users').on('value', snap => {
            this._updatePresenceUI(snap.val() || {});
        });
    }

    syncContent(content, title) {
        if (!this.currentRoom || !this.db) return;
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.isLocalUpdate = true;
            this.db.ref('rooms/' + this.currentRoom).update({
                content,
                title: title || 'Untitled',
                lastUpdated: Date.now()
            });
            setTimeout(() => { this.isLocalUpdate = false; }, 400);
        }, 700);
    }

    _registerPresence(roomId) {
        const ref = this.db.ref('rooms/' + roomId + '/users/' + this.userId);
        ref.set({ name: this.userName, color: this.userColor, joinedAt: Date.now() });
        ref.onDisconnect().remove();
    }

    _updatePresenceUI(users) {
        const bar = document.getElementById('presenceBar');
        if (!bar) return;
        const list = Object.values(users);
        if (list.length < 2) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
        bar.style.display = 'flex';
        bar.innerHTML = list.map(u =>
            `<div class="presence-avatar" style="background:${u.color}" title="${u.name}">${u.name.charAt(0).toUpperCase()}</div>`
        ).join('') + `<span class="presence-label">${list.length} collaborating</span>`;
    }

    async stopLive() {
        if (!this.currentRoom) return;
        if (this.db) {
            this.db.ref('rooms/' + this.currentRoom + '/users/' + this.userId).remove();
            if (this.isHost) this.db.ref('rooms/' + this.currentRoom).remove();
        }
        const note = this.app.notes.find(n => n.roomId === this.currentRoom);
        if (note) { note.isLive = false; note.roomId = null; }
        this.currentRoom = null;
        this.isHost = false;
        window.history.replaceState({}, '', window.location.pathname);
        this._updateGoLiveBtn(false);
        const bar = document.getElementById('presenceBar');
        if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
        this.app.renderNotesList();
        this.app.saveNotesToStorage();
        document.getElementById('shareLiveModal')?.classList.remove('show');
    }

    _genId() { return Math.random().toString(36).substr(2, 8) + Date.now().toString(36); }

    _updateGoLiveBtn(live) {
        const btn = document.getElementById('goLiveBtn');
        if (!btn) return;
        btn.classList.toggle('live-active', live);
        btn.title = live ? 'Currently Live — click to see share link' : 'Go Live / Share';
    }

    showSetupModal() { document.getElementById('firebaseSetupModal')?.classList.add('show'); }

    showShareModal(roomId) {
        const modal = document.getElementById('shareLiveModal');
        if (!modal) return;
        const li = document.getElementById('shareLinkInput');
        if (li) li.value = location.origin + location.pathname + '#room/' + roomId;
        modal.classList.add('show');
    }

    copyShareLink() {
        const v = document.getElementById('shareLinkInput')?.value;
        if (!v) return;
        navigator.clipboard.writeText(v).then(() => {
            const btn = document.getElementById('copyShareLinkBtn');
            if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
        });
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