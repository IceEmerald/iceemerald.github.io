// EmeraldNotes JavaScript - Note Taking App Functionality

class NotesApp {
    constructor() {
        this.notes = [];
        this.currentNoteId = null;
        this.saveTimeout = null;
        this.isInitialized = false;
        this.savedSelection = null;

        // Initialize the app
        this.init();
    }

    init() {
        this.loadNotesFromStorage();
        this.setupEventListeners();
        this.setupRibbon();
        this.setupTextEditor();
        this.renderNotesList();
        this.showWelcomeScreenIfNeeded();
        this.isInitialized = true;
    }

    // Load notes from localStorage
    loadNotesFromStorage() {
        try {
            const stored = localStorage.getItem('emeraldnotes_data');
            if (stored) {
                this.notes = JSON.parse(stored);

                // Legacy content migration: convert old placeholder HTML
                this.notes.forEach(note => {
                    if (note.content && typeof note.content === 'string') {
                        // Remove legacy placeholder content
                        if (note.content.trim() === '<p>Start typing your note here...</p>' ||
                            note.content.trim() === 'Start typing your note here...') {
                            note.content = '';
                        }

                        // Clean up other legacy empty patterns
                        const legacyEmptyPatterns = [
                            '<div>\u00A0</div>',
                            '<p>\u00A0</p>',
                            '<div>&nbsp;</div>',
                            '<p>&nbsp;</p>'
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

    // Save notes to localStorage
    saveNotesToStorage() {
        try {
            localStorage.setItem('emeraldnotes_data', JSON.stringify(this.notes));
            this.showSaveIndicator('saved');
        } catch (error) {
            console.error('Error saving notes to storage:', error);
            this.showSaveIndicator('error');
        }
    }

    // Show save indicator
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

    // Debounced save function
    debouncedSave() {
        this.showSaveIndicator('saving');
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            this.saveNotesToStorage();
        }, 1000);
    }

    // Setup event listeners
    setupEventListeners() {
        // New note buttons
        const newNoteBtn = document.getElementById('newNoteBtn');
        const welcomeNewNoteBtn = document.getElementById('welcomeNewNoteBtn');
        if (newNoteBtn) newNoteBtn.addEventListener('click', () => this.createNewNote());
        if (welcomeNewNoteBtn) welcomeNewNoteBtn.addEventListener('click', () => this.createNewNote());

        // Delete note button
        const deleteNoteBtn = document.getElementById('deleteNoteBtn');
        if (deleteNoteBtn) deleteNoteBtn.addEventListener('click', () => this.deleteCurrentNote());

        // Note title input
        const noteTitle = document.getElementById('noteTitle');
        if (noteTitle) {
            noteTitle.addEventListener('input', (e) => {
                if (this.currentNoteId) {
                    this.updateNoteTitle(e.target.value);
                }
            });
        }

        // Text editor changes
        const textEditor = document.getElementById('textEditor');
        if (textEditor) {
            textEditor.addEventListener('input', () => {
                if (this.currentNoteId) {
                    this.updatePlaceholderState(textEditor);
                    this.updateNoteContent();
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

        // Prevent losing focus on editor when clicking specific ribbon buttons only
        document.querySelectorAll('.ribbon-btn, .ribbon-tab').forEach(element => {
            element.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });
        });

        // Prevent losing focus on editor when clicking dropdown items and color swatches
        document.querySelectorAll('.ms-dropdown-item, .color-swatch').forEach(element => {
            element.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });
        });

        // Setup Microsoft Office-style dropdowns
        this.setupMSDropdowns();

        // Setup custom right-click context menu
        this.setupCustomContextMenu();

        // Setup editor placeholder behavior
        this.setupEditorPlaceholder();

        // Setup sidebar toggle functionality
        this.setupSidebarToggle();
    }

    // Setup ribbon functionality
    setupRibbon() {
        // Tab switching
        document.querySelectorAll('.ribbon-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchRibbonTab(tabName);
            });
        });

        // Format buttons
        document.querySelectorAll('.format-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const command = btn.dataset.command;
                this.executeCommand(command);
                this.updateButtonStates();
            });
        });

        // Legacy font controls are now handled by MS-style dropdowns in setupMSDropdowns()

        // Clipboard operations
        const cutBtn = document.getElementById('cutBtn');
        const copyBtn = document.getElementById('copyBtn');
        const pasteBtn = document.getElementById('pasteBtn');
        if (cutBtn) cutBtn.addEventListener('click', () => this.executeCommand('cut'));
        if (copyBtn) copyBtn.addEventListener('click', () => this.executeCommand('copy'));
        if (pasteBtn) pasteBtn.addEventListener('click', () => this.executeCommand('paste'));

        // Insert operations
        const insertTableBtn = document.getElementById('insertTableBtn');
        const insertLinkBtn = document.getElementById('insertLinkBtn');
        if (insertTableBtn) insertTableBtn.addEventListener('click', () => this.insertTable());
        if (insertLinkBtn) insertLinkBtn.addEventListener('click', () => this.insertLink());

        // Zoom operations
        const zoomInBtn = document.getElementById('zoomInBtn');
        const zoomOutBtn = document.getElementById('zoomOutBtn');
        if (zoomInBtn) zoomInBtn.addEventListener('click', () => this.zoomIn());
        if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => this.zoomOut());
    }

    // Setup text editor
    setupTextEditor() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;

        // Update button states when selection changes
        editor.addEventListener('mouseup', () => {
            this.saveSelection();
            this.updateButtonStates();
        });
        editor.addEventListener('keyup', () => {
            this.saveSelection();
            this.updateButtonStates();
        });

        // Save selection when editor loses focus
        editor.addEventListener('blur', () => {
            this.saveSelection();
        });

        // Handle paste events
        editor.addEventListener('paste', (e) => {
            // Allow default paste behavior
            setTimeout(() => {
                this.updatePlaceholderState(editor);
                this.updateNoteContent();
            }, 10);
        });
    }

    // Save current selection
    saveSelection() {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            this.savedSelection = selection.getRangeAt(0).cloneRange();
        }
    }

    // Restore saved selection
    restoreSelection() {
        if (this.savedSelection) {
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(this.savedSelection.cloneRange());
            document.getElementById('textEditor').focus();
        }
    }

    // Switch ribbon tab
    switchRibbonTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.ribbon-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // Update panels
        document.querySelectorAll('.ribbon-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });
    }

    // Execute formatting command with modern implementations
    executeCommand(command, value = null) {
        document.getElementById('textEditor').focus();

        try {
            // Handle modern clipboard operations
            if (command === 'cut') {
                this.modernCut();
                return;
            }
            if (command === 'copy') {
                this.modernCopy();
                return;
            }
            if (command === 'paste') {
                this.modernPaste();
                return;
            }

            // Handle modern text formatting
            if (command === 'fontSize') {
                this.modernFontSize(value);
                return;
            }
            if (command === 'foreColor') {
                this.modernTextColor(value);
                return;
            }
            if (command === 'hiliteColor') {
                this.modernHighlightColor(value);
                return;
            }

            // Fall back to execCommand for other commands (bold, italic, etc.)
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

    // Update button states based on current selection with span-based styling support
    updateButtonStates() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        // Handle traditional execCommand-based formatting
        const commands = ['bold', 'italic', 'underline', 'justifyLeft', 'justifyCenter', 'justifyRight', 'insertUnorderedList', 'insertOrderedList'];

        commands.forEach(command => {
            const btn = document.querySelector(`[data-command="${command}"]`);
            if (btn) {
                try {
                    const isActive = document.queryCommandState(command);
                    btn.classList.toggle('active', isActive);
                } catch (error) {
                    // Fallback: check for styling in the DOM
                    btn.classList.remove('active');
                }
            }
        });

        // Update font styling based on actual DOM inspection
        this.updateFontStateFromDOM();
    }

    // Update font dropdowns based on actual DOM styling at cursor position
    updateFontStateFromDOM() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        let currentNode = range.commonAncestorContainer;

        // If text node, get parent element
        if (currentNode.nodeType === Node.TEXT_NODE) {
            currentNode = currentNode.parentElement;
        }

        // Traverse up the DOM to find styling
        let fontFamily = '';
        let fontSize = '';
        let textColor = '';
        let backgroundColor = '';

        // Start from the current node and traverse up
        let element = currentNode;
        while (element && element !== document.getElementById('textEditor')) {
            const styles = window.getComputedStyle(element);

            // Get font family
            if (!fontFamily && styles.fontFamily && styles.fontFamily !== 'inherit') {
                fontFamily = styles.fontFamily.replace(/['"]/g, '');
            }

            // Get font size (look for explicit styling, not inherited)
            if (!fontSize && element.style && element.style.fontSize) {
                fontSize = element.style.fontSize.replace('px', '');
            }

            // Get text color (look for explicit styling)
            if (!textColor && element.style && element.style.color) {
                textColor = element.style.color;
            }

            // Get background color (look for explicit styling)
            if (!backgroundColor && element.style && element.style.backgroundColor) {
                backgroundColor = element.style.backgroundColor;
            }

            element = element.parentElement;
        }

        // Update font family dropdown
        const fontFamilyDropdown = document.getElementById('fontFamilyDropdown');
        if (fontFamilyDropdown && fontFamily) {
            const valueSpan = fontFamilyDropdown.querySelector('.dropdown-value');
            if (valueSpan) {
                // Find matching option
                const matchingItem = fontFamilyDropdown.querySelector(`[data-value="${fontFamily}"]`);
                if (matchingItem) {
                    valueSpan.textContent = matchingItem.dataset.label || matchingItem.textContent;
                }
            }
        }

        // Update font size dropdown
        const fontSizeDropdown = document.getElementById('fontSizeDropdown');
        if (fontSizeDropdown && fontSize) {
            const valueSpan = fontSizeDropdown.querySelector('.dropdown-value');
            if (valueSpan) {
                valueSpan.textContent = fontSize + 'px';
            }
        }

        // Update font color dropdown
        const fontColorDropdown = document.getElementById('fontColorDropdown');
        if (fontColorDropdown && textColor) {
            const colorPreview = fontColorDropdown.querySelector('.color-preview');
            if (colorPreview) {
                colorPreview.style.background = textColor;
                colorPreview.setAttribute('data-color', textColor);
            }
        }

        // Update highlight color dropdown
        const highlightColorDropdown = document.getElementById('highlightColorDropdown');
        if (highlightColorDropdown && backgroundColor) {
            const colorPreview = highlightColorDropdown.querySelector('.color-preview');
            if (colorPreview) {
                colorPreview.style.background = backgroundColor;
                colorPreview.setAttribute('data-color', backgroundColor);
            }
        }
    }

    // Handle keyboard shortcuts
    handleKeyboardShortcuts(e) {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'n':
                    e.preventDefault();
                    this.createNewNote();
                    break;
                case 's':
                    e.preventDefault();
                    this.saveNotesToStorage();
                    break;
                case 'b':
                    if (this.isEditorFocused()) {
                        e.preventDefault();
                        this.executeCommand('bold');
                        this.updateButtonStates();
                    }
                    break;
                case 'i':
                    if (this.isEditorFocused()) {
                        e.preventDefault();
                        this.executeCommand('italic');
                        this.updateButtonStates();
                    }
                    break;
                case 'u':
                    if (this.isEditorFocused()) {
                        e.preventDefault();
                        this.executeCommand('underline');
                        this.updateButtonStates();
                    }
                    break;
            }
        }
    }

    // Check if editor is focused
    isEditorFocused() {
        return document.getElementById('textEditor').contains(document.activeElement);
    }

    // Create new note
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

        // Focus on title for editing
        setTimeout(() => {
            const titleInput = document.getElementById('noteTitle');
            titleInput.select();
        }, 100);
    }

    // Select a note
    selectNote(noteId) {
        const note = this.notes.find(n => n.id === noteId);
        if (!note) return;

        this.currentNoteId = noteId;

        // Update UI
        document.getElementById('noteTitle').value = note.title;
        document.getElementById('textEditor').innerHTML = this.sanitizeHtml(note.content);

        // Update editor background color based on note color
        const textEditor = document.getElementById('textEditor');
        if (note.color && note.color !== '#ffffff') {
            textEditor.style.backgroundColor = note.color;
        } else {
            textEditor.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
        }

        // Update note color dropdown to show current color
        const noteColorDropdown = document.getElementById('noteColorDropdown');
        if (noteColorDropdown) {
            const colorPreview = noteColorDropdown.querySelector('.color-preview');
            const dropdownValue = noteColorDropdown.querySelector('.dropdown-value');
            const currentColor = note.color || '#ffffff';

            if (colorPreview) {
                colorPreview.style.background = currentColor;
                colorPreview.setAttribute('data-color', currentColor);
            }

            if (dropdownValue) {
                // Find the matching color label
                const colorItem = noteColorDropdown.querySelector(`[data-value="${currentColor}"]`);
                if (colorItem) {
                    dropdownValue.textContent = colorItem.dataset.label || 'Default';
                } else {
                    dropdownValue.textContent = 'Default';
                }
            }
        }

        // Update active state in notes list
        document.querySelectorAll('.note-item').forEach(item => {
            item.classList.toggle('active', item.dataset.noteId === noteId);
        });

        // Hide welcome screen and show editor
        document.getElementById('welcomeScreen').classList.add('hidden');
        document.querySelector('.editor-header').style.display = 'flex';
        document.querySelector('.editor-content').style.display = 'flex';

        // Focus editor
        setTimeout(() => {
            document.getElementById('textEditor').focus();
        }, 100);
    }

    // Update note title
    updateNoteTitle(title) {
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (note) {
            note.title = title || 'Untitled Note';
            note.modifiedAt = new Date().toISOString();
            this.renderNotesList();
            this.debouncedSave();
        }
    }

    // Update note content
    updateNoteContent() {
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (note) {
            const textEditor = document.getElementById('textEditor');
            const content = textEditor.innerHTML.trim();
            // Use unified empty detection logic
            if (this.isEditorEmpty(textEditor)) {
                note.content = '';
            } else {
                note.content = content;
            }
            note.modifiedAt = new Date().toISOString();
            this.renderNotesList();
            this.debouncedSave();
        }
    }

    // Delete current note
    deleteCurrentNote() {
        if (!this.currentNoteId) return;

        if (confirm('Are you sure you want to delete this note?')) {
            this.notes = this.notes.filter(n => n.id !== this.currentNoteId);
            this.currentNoteId = null;
            this.renderNotesList();
            this.showWelcomeScreenIfNeeded();
            this.debouncedSave();
        }
    }

    // Render notes list
    renderNotesList() {
        const notesList = document.getElementById('notesList');
        notesList.innerHTML = '';

        this.notes.forEach(note => {
            const noteElement = this.createNoteListItem(note);
            notesList.appendChild(noteElement);
        });
    }

    // Create note list item
    createNoteListItem(note) {
        const div = document.createElement('div');
        div.className = 'note-item';
        div.dataset.noteId = note.id;

        if (note.id === this.currentNoteId) {
            div.classList.add('active');
        }

        // Apply note color and shadow if set
        if (note.color && note.color !== '#ffffff') {
            div.style.backgroundColor = note.color;
            div.style.borderColor = note.color;

            // Apply colored shadow effect
            const shadowColor = this.hexToRgba(note.color, 0.3);
            div.style.boxShadow = `0 4px 16px ${shadowColor}`;

            // Enhanced shadow on hover
            div.addEventListener('mouseenter', () => {
                const hoverShadowColor = this.hexToRgba(note.color, 0.4);
                div.style.boxShadow = `0 8px 24px ${hoverShadowColor}`;
            });

            div.addEventListener('mouseleave', () => {
                const shadowColor = this.hexToRgba(note.color, 0.3);
                div.style.boxShadow = `0 4px 16px ${shadowColor}`;
            });
        }

        // Extract plain text for preview
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = note.content;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        const preview = plainText.substring(0, 150);

        // Format date
        const date = new Date(note.modifiedAt);
        const formattedDate = this.formatDate(date);

        div.innerHTML = `
            <div class="note-item-title">${this.escapeHtml(note.title)}</div>
            <div class="note-item-preview">${this.escapeHtml(preview)}${preview.length === 150 ? '...' : ''}</div>
            <div class="note-item-date">${formattedDate}</div>
        `;

        div.addEventListener('click', () => this.selectNote(note.id));

        return div;
    }

    // Show welcome screen if no notes
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
        }
    }

    // Insert table
    insertTable() {
        this.showTableModal();
    }

    // Show custom table creation modal
    showTableModal() {
        const modal = document.getElementById('tableModal');
        const cancelBtn = document.getElementById('tableModalCancel');
        const createBtn = document.getElementById('tableModalCreate');
        const rowsInput = document.getElementById('tableRows');
        const colsInput = document.getElementById('tableCols');

        if (!modal) return;

        // Show modal
        modal.classList.add('show');

        // Focus first input
        setTimeout(() => rowsInput.focus(), 100);

        // Handle cancel
        const handleCancel = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', handleCancel);
            createBtn.removeEventListener('click', handleCreate);
            modal.removeEventListener('click', handleBackdropClick);
            document.removeEventListener('keydown', handleEscape);
        };

        // Handle create
        const handleCreate = () => {
            const rows = parseInt(rowsInput.value);
            const cols = parseInt(colsInput.value);

            if (rows && cols && rows > 0 && cols > 0) {
                this.createTable(rows, cols);
                handleCancel();
            }
        };

        // Handle backdrop click
        const handleBackdropClick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };

        // Handle escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };

        // Handle enter key in inputs
        const handleEnter = (e) => {
            if (e.key === 'Enter') {
                handleCreate();
            }
        };

        // Add event listeners
        cancelBtn.addEventListener('click', handleCancel);
        createBtn.addEventListener('click', handleCreate);
        modal.addEventListener('click', handleBackdropClick);
        document.addEventListener('keydown', handleEscape);
        rowsInput.addEventListener('keydown', handleEnter);
        colsInput.addEventListener('keydown', handleEnter);
    }

    // Create table with specified dimensions
    createTable(rows, cols) {
        let tableHTML = '<table>';

        // Create header row
        tableHTML += '<tr>';
        for (let j = 0; j < cols; j++) {
            tableHTML += '<th>Header ' + (j + 1) + '</th>';
        }
        tableHTML += '</tr>';

        // Create data rows
        for (let i = 1; i < rows; i++) {
            tableHTML += '<tr>';
            for (let j = 0; j < cols; j++) {
                tableHTML += '<td>Cell ' + i + ',' + (j + 1) + '</td>';
            }
            tableHTML += '</tr>';
        }
        tableHTML += '</table>';

        this.executeCommand('insertHTML', tableHTML);
    }

    // Insert link
    insertLink() {
        this.showLinkModal();
    }

    // Show custom link creation modal
    showLinkModal() {
        const modal = document.getElementById('linkModal');
        const cancelBtn = document.getElementById('linkModalCancel');
        const createBtn = document.getElementById('linkModalCreate');
        const urlInput = document.getElementById('linkUrl');
        const textInput = document.getElementById('linkText');

        if (!modal) return;

        // Save current editor selection
        this.saveSelection();

        // Show modal
        modal.classList.add('show');

        // Reset inputs and validation
        urlInput.value = 'https://';
        textInput.value = '';
        createBtn.disabled = true;

        // Focus first input and select all text
        setTimeout(() => {
            urlInput.focus();
            urlInput.select();
        }, 100);

        // URL validation function
        const validateUrl = (url) => {
            if (!url || url.trim() === '' || url.trim() === 'https://') {
                return { valid: false, message: '' };
            }

            url = url.trim();

            // Auto-prepend https:// if no protocol is present
            if (!url.match(/^[a-z][a-z0-9+.-]*:/i)) {
                url = 'https://' + url;
                urlInput.value = url;
            }

            // Check for dangerous schemes
            const dangerousSchemes = ['javascript:', 'data:', 'vbscript:', 'file:', 'about:'];
            const urlLower = url.toLowerCase();

            for (const scheme of dangerousSchemes) {
                if (urlLower.startsWith(scheme)) {
                    return { 
                        valid: false, 
                        message: 'Unsafe URL scheme detected. Please use http://, https://, or mailto:' 
                    };
                }
            }

            // Allow only safe protocols
            const safeProtocols = /^(https?|mailto):/i;
            if (!safeProtocols.test(url)) {
                return { 
                    valid: false, 
                    message: 'Only HTTP, HTTPS, and mailto URLs are allowed' 
                };
            }

            // Basic URL format validation
            try {
                if (url.startsWith('mailto:')) {
                    // Simple email validation for mailto links
                    const email = url.substring(7);
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!emailRegex.test(email)) {
                        return { 
                            valid: false, 
                            message: 'Invalid email address for mailto link' 
                        };
                    }
                } else {
                    // Validate HTTP/HTTPS URLs
                    const urlObj = new URL(url);
                    if (!urlObj.hostname) {
                        return { 
                            valid: false, 
                            message: 'Invalid URL format' 
                        };
                    }
                }
                return { valid: true, message: '', url: url };
            } catch (error) {
                return { 
                    valid: false, 
                    message: 'Invalid URL format' 
                };
            }
        };

        // Show validation feedback
        const showValidationFeedback = (input, message, isValid) => {
            let feedback = input.parentNode.querySelector('.validation-feedback');

            if (!feedback) {
                feedback = document.createElement('div');
                feedback.className = 'validation-feedback';
                input.parentNode.appendChild(feedback);
            }

            feedback.textContent = message;
            feedback.className = `validation-feedback ${isValid ? 'valid' : 'invalid'}`;
            feedback.style.display = message ? 'block' : 'none';
        };

        // Clear validation feedback
        const clearValidationFeedback = (input) => {
            const feedback = input.parentNode.querySelector('.validation-feedback');
            if (feedback) {
                feedback.style.display = 'none';
            }
        };

        // Update create button state
        const updateCreateButton = () => {
            const url = urlInput.value.trim();
            const text = textInput.value.trim();
            const validation = validateUrl(url);

            createBtn.disabled = !(validation.valid && text && text.trim() !== '');

            if (url && url !== 'https://') {
                if (validation.valid) {
                    showValidationFeedback(urlInput, 'Valid URL', true);
                } else {
                    showValidationFeedback(urlInput, validation.message, false);
                }
            } else {
                clearValidationFeedback(urlInput);
            }
        };

        // Handle cancel
        const handleCancel = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', handleCancel);
            createBtn.removeEventListener('click', handleCreate);
            modal.removeEventListener('click', handleBackdropClick);
            document.removeEventListener('keydown', handleEscape);
            urlInput.removeEventListener('keydown', handleEnter);
            textInput.removeEventListener('keydown', handleEnter);
            urlInput.removeEventListener('input', updateCreateButton);
            textInput.removeEventListener('input', updateCreateButton);

            // Restore editor selection and focus
            this.restoreSelection();
        };

        // Handle create
        const handleCreate = () => {
            const url = urlInput.value.trim();
            const text = textInput.value.trim();
            const validation = validateUrl(url);

            if (validation.valid && text && text.trim() !== '') {
                // Restore selection before inserting link
                this.restoreSelection();

                const safeUrl = validation.url || url;
                const linkHTML = `<a href="${this.escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(text)}</a>`;
                this.executeCommand('insertHTML', linkHTML);
                handleCancel();
            }
        };

        // Handle backdrop click
        const handleBackdropClick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };

        // Handle escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };

        // Handle enter key in inputs
        const handleEnter = (e) => {
            if (e.key === 'Enter' && !createBtn.disabled) {
                handleCreate();
            }
        };

        // Add event listeners
        cancelBtn.addEventListener('click', handleCancel);
        createBtn.addEventListener('click', handleCreate);
        modal.addEventListener('click', handleBackdropClick);
        document.addEventListener('keydown', handleEscape);
        urlInput.addEventListener('keydown', handleEnter);
        textInput.addEventListener('keydown', handleEnter);
        urlInput.addEventListener('input', updateCreateButton);
        textInput.addEventListener('input', updateCreateButton);

        // Initial validation
        updateCreateButton();
    }

    // Zoom in
    zoomIn() {
        const editor = document.getElementById('textEditor');
        const currentSize = parseFloat(getComputedStyle(editor).fontSize);
        editor.style.fontSize = (currentSize * 1.1) + 'px';
    }

    // Zoom out
    zoomOut() {
        const editor = document.getElementById('textEditor');
        const currentSize = parseFloat(getComputedStyle(editor).fontSize);
        editor.style.fontSize = (currentSize * 0.9) + 'px';
    }

    // Utility functions
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

        if (days > 0) {
            return date.toLocaleDateString();
        } else if (hours > 0) {
            return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
        } else if (minutes > 0) {
            return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
        } else {
            return 'Just now';
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Convert hex color to RGBA with opacity for shadows
    hexToRgba(hex, opacity) {
        // Remove # if present
        hex = hex.replace('#', '');

        // Parse hex values
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }

    // Sanitize HTML content to prevent XSS
    sanitizeHtml(html) {
        if (!html) return '';

        const allowedTags = ['p', 'br', 'strong', 'em', 'u', 'b', 'i', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span'];
        const allowedAttributes = ['style'];

        try {
            const div = document.createElement('div');
            div.innerHTML = html;

            // Remove all script tags and dangerous elements
            const dangerousElements = div.querySelectorAll('script, iframe, object, embed, form, input, button, link, meta');
            dangerousElements.forEach(element => element.remove());

            // Process all remaining elements
            const allElements = div.querySelectorAll('*');
            allElements.forEach(element => {
                const tagName = element.tagName.toLowerCase();

                // Remove elements not in allowed list
                if (!allowedTags.includes(tagName)) {
                    // Replace with span to preserve content
                    const span = document.createElement('span');
                    span.innerHTML = element.innerHTML;
                    element.parentNode.replaceChild(span, element);
                    return;
                }

                // Remove dangerous attributes
                const attributes = Array.from(element.attributes);
                attributes.forEach(attr => {
                    const attrName = attr.name.toLowerCase();
                    if (attrName.startsWith('on') || 
                        attrName.includes('javascript:') || 
                        attrName === 'src' || 
                        attrName === 'href' || 
                        !allowedAttributes.includes(attrName)) {
                        element.removeAttribute(attr.name);
                    }
                });

                // Clean style attribute specifically
                if (element.hasAttribute('style')) {
                    const style = element.getAttribute('style');
                    if (style && (style.includes('javascript:') || style.includes('expression(') || style.includes('@import'))) {
                        element.removeAttribute('style');
                    }
                }
            });

            return div.innerHTML;
        } catch (error) {
            console.error('Error sanitizing HTML:', error);
            // Fallback to text content only
            const div = document.createElement('div');
            div.textContent = html;
            return div.innerHTML;
        }
    }

    // Setup Microsoft Office-style dropdowns
    setupMSDropdowns() {
        document.querySelectorAll('.ms-dropdown').forEach(dropdown => {
            const btn = dropdown.querySelector('.ms-dropdown-btn');
            const menu = dropdown.querySelector('.ms-dropdown-menu');
            const items = dropdown.querySelectorAll('.ms-dropdown-item');

            // Set up ARIA attributes
            btn.setAttribute('aria-expanded', 'false');
            btn.setAttribute('aria-haspopup', 'listbox');
            menu.setAttribute('role', 'listbox');
            items.forEach((item, index) => {
                item.setAttribute('role', 'option');
                item.setAttribute('tabindex', '-1');
                item.id = `dropdown-item-${dropdown.id}-${index}`;
            });

            // Toggle dropdown on button click
            btn.addEventListener('click', (e) => {
                e.stopPropagation();

                // Save selection before dropdown interaction
                this.saveSelection();

                // Close other dropdowns
                document.querySelectorAll('.ms-dropdown.active').forEach(otherDropdown => {
                    if (otherDropdown !== dropdown) {
                        otherDropdown.classList.remove('active');
                        otherDropdown.querySelector('.ms-dropdown-btn').setAttribute('aria-expanded', 'false');
                    }
                });

                // Toggle this dropdown
                const isActive = dropdown.classList.toggle('active');
                btn.setAttribute('aria-expanded', isActive);

                if (isActive) {
                    // Focus first item
                    const firstItem = items[0];
                    if (firstItem) {
                        firstItem.focus();
                    }
                }
            });

            // Keyboard navigation
            btn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    btn.click();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    btn.click();
                }
            });

            // Handle keyboard navigation within dropdown
            items.forEach((item, index) => {
                item.addEventListener('keydown', (e) => {
                    switch (e.key) {
                        case 'ArrowDown':
                            e.preventDefault();
                            const nextItem = items[index + 1] || items[0];
                            nextItem.focus();
                            break;
                        case 'ArrowUp':
                            e.preventDefault();
                            const prevItem = items[index - 1] || items[items.length - 1];
                            prevItem.focus();
                            break;
                        case 'Enter':
                        case ' ':
                            e.preventDefault();
                            item.click();
                            break;
                        case 'Escape':
                            e.preventDefault();
                            dropdown.classList.remove('active');
                            btn.setAttribute('aria-expanded', 'false');
                            btn.focus();
                            break;
                    }
                });
            });

            // Handle item selection
            items.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();

                    const value = item.dataset.value;
                    const label = item.dataset.label || item.textContent;

                    // Update button display
                    const valueSpan = btn.querySelector('.dropdown-value');
                    if (valueSpan) {
                        valueSpan.textContent = label;
                    }

                    // Update color preview if present
                    const colorPreview = btn.querySelector('.color-preview');
                    if (colorPreview && value) {
                        colorPreview.style.background = value;
                        colorPreview.setAttribute('data-color', value);
                        if (value === 'transparent') {
                            colorPreview.style.border = '1px solid #ccc';
                            colorPreview.removeAttribute('data-color');
                        }
                    }

                    // Close dropdown first to prevent interference
                    dropdown.classList.remove('active');
                    btn.setAttribute('aria-expanded', 'false');

                    // Execute the appropriate command with improved selection handling
                    setTimeout(() => {
                        // Ensure editor has focus before restoring selection
                        const editor = document.getElementById('textEditor');
                        if (editor) {
                            editor.focus();
                        }

                        // Restore selection and execute command
                        this.restoreSelection();

                        if (dropdown.id === 'fontFamilyDropdown') {
                            this.executeCommand('fontName', value);
                        } else if (dropdown.id === 'fontSizeDropdown') {
                            this.executeCommand('fontSize', value);
                        } else if (dropdown.id === 'fontColorDropdown') {
                            this.executeCommand('foreColor', value);
                        } else if (dropdown.id === 'highlightColorDropdown') {
                            this.executeCommand('hiliteColor', value);
                        } else if (dropdown.id === 'noteColorDropdown') {
                            this.updateNoteColor(value);
                        }

                        // Update button states to reflect changes
                        this.updateButtonStates();
                    }, 10);
                });
            });
        });

        // Close dropdowns when clicking outside
        document.addEventListener('click', () => {
            document.querySelectorAll('.ms-dropdown.active').forEach(dropdown => {
                dropdown.classList.remove('active');
                dropdown.querySelector('.ms-dropdown-btn').setAttribute('aria-expanded', 'false');
            });
        });
    }

    // Setup custom right-click context menu
    setupCustomContextMenu() {
        const contextMenu = document.getElementById('customContextMenu');
        const textEditor = document.getElementById('textEditor');

        if (!contextMenu || !textEditor) return;

        // Show context menu on right-click
        textEditor.addEventListener('contextmenu', (e) => {
            e.preventDefault();

            // Save selection
            this.saveSelection();

            // Position context menu
            const x = e.pageX;
            const y = e.pageY;

            contextMenu.style.left = x + 'px';
            contextMenu.style.top = y + 'px';
            contextMenu.style.display = 'block';

            // Adjust position if menu goes off screen
            const rect = contextMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                contextMenu.style.left = (x - rect.width) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                contextMenu.style.top = (y - rect.height) + 'px';
            }
        });

        // Handle context menu item clicks
        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;

            const action = item.dataset.action;

            // Restore selection before executing command
            this.restoreSelection();

            switch (action) {
                case 'copy':
                    this.executeCommand('copy');
                    break;
                case 'paste':
                    this.executeCommand('paste');
                    break;
                case 'bold':
                    this.executeCommand('bold');
                    this.updateButtonStates();
                    break;
                case 'italic':
                    this.executeCommand('italic');
                    this.updateButtonStates();
                    break;
                case 'underline':
                    this.executeCommand('underline');
                    this.updateButtonStates();
                    break;
                case 'selectAll':
                    this.executeCommand('selectAll');
                    break;
            }

            // Hide context menu
            contextMenu.style.display = 'none';
        });

        // Hide context menu on click outside
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                contextMenu.style.display = 'none';
            }
        });

        // Hide context menu on scroll
        document.addEventListener('scroll', () => {
            contextMenu.style.display = 'none';
        });
    }

    // Update note color
    updateNoteColor(color) {
        if (!this.currentNoteId) return;

        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note) return;

        note.color = color;
        this.debouncedSave();
        this.renderNotesList();

        // Update editor background
        const textEditor = document.getElementById('textEditor');
        if (textEditor) {
            if (color === '#ffffff') {
                textEditor.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
            } else {
                textEditor.style.backgroundColor = color;
            }
        }
    }

    // Delete current note
    deleteCurrentNote() {
        if (!this.currentNoteId) return;

        const currentNote = this.notes.find(n => n.id === this.currentNoteId);
        if (!currentNote) return;

        const title = currentNote.title || 'Untitled Note';
        this.showDeleteModal(title, () => {
            // Find the index of current note to determine next note
            const currentIndex = this.notes.findIndex(n => n.id === this.currentNoteId);

            // Remove note from array
            this.notes = this.notes.filter(note => note.id !== this.currentNoteId);

            // Select next note or show welcome screen
            if (this.notes.length > 0) {
                // Select the next note, or previous if we deleted the last one
                const nextIndex = currentIndex < this.notes.length ? currentIndex : this.notes.length - 1;
                const nextNote = this.notes[nextIndex];
                this.selectNote(nextNote.id);
            } else {
                // No notes left, clear current note and show welcome screen
                this.currentNoteId = null;
                this.showWelcomeScreenIfNeeded();

                // Clear editor
                const noteTitle = document.getElementById('noteTitle');
                const textEditor = document.getElementById('textEditor');
                if (noteTitle) noteTitle.value = '';
                if (textEditor) {
                    textEditor.innerHTML = '';
                    textEditor.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
                }
            }

            // Save changes
            this.saveNotesToStorage();

            // Update notes list
            this.renderNotesList();
        });
    }

    // Show custom delete confirmation modal
    showDeleteModal(noteTitle, onConfirm) {
        const modal = document.getElementById('deleteModal');
        const message = document.getElementById('deleteModalMessage');
        const cancelBtn = document.getElementById('deleteModalCancel');
        const confirmBtn = document.getElementById('deleteModalConfirm');

        // Update modal message
        message.textContent = `Are you sure you want to delete "${noteTitle}"? This action cannot be undone.`;

        // Show modal
        modal.classList.add('show');

        // Handle cancel
        const handleCancel = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', handleCancel);
            confirmBtn.removeEventListener('click', handleConfirm);
            modal.removeEventListener('click', handleBackdropClick);
            document.removeEventListener('keydown', handleEscape);
        };

        // Handle confirm
        const handleConfirm = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', handleCancel);
            confirmBtn.removeEventListener('click', handleConfirm);
            modal.removeEventListener('click', handleBackdropClick);
            document.removeEventListener('keydown', handleEscape);
            onConfirm();
        };

        // Handle backdrop click
        const handleBackdropClick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };

        // Handle escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };

        // Add event listeners
        cancelBtn.addEventListener('click', handleCancel);
        confirmBtn.addEventListener('click', handleConfirm);
        modal.addEventListener('click', handleBackdropClick);
        document.addEventListener('keydown', handleEscape);
    }

    // Setup sidebar toggle functionality
    setupSidebarToggle() {
        const toggleBtn = document.getElementById('sidebarToggle');
        const sidebar = document.querySelector('.sidebar');

        if (!toggleBtn || !sidebar) return;

        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Toggle the collapsed class
            sidebar.classList.toggle('collapsed');

            // Store the collapsed state in localStorage
            const isCollapsed = sidebar.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed.toString());

            // Update toggle button icon
            this.updateToggleIcon(toggleBtn, isCollapsed);

            // Force a reflow to ensure CSS changes are applied
            void sidebar.offsetWidth;

            // Ensure the toggle button remains visible and clickable
            toggleBtn.style.opacity = '1';
            toggleBtn.style.pointerEvents = 'auto';
        });

        // Restore collapsed state from localStorage
        const savedState = localStorage.getItem('sidebarCollapsed');
        if (savedState === 'true') {
            sidebar.classList.add('collapsed');
            this.updateToggleIcon(toggleBtn, true);
        }

        // Always ensure toggle button is visible and clickable
        toggleBtn.style.opacity = '1';
        toggleBtn.style.pointerEvents = 'auto';
    }

    // Update the toggle button icon based on collapsed state
    updateToggleIcon(toggleBtn, isCollapsed) {
        const svg = toggleBtn.querySelector('svg');
        if (!svg) return;

        if (isCollapsed) {
            // Show expand icon (arrow pointing right)
            svg.innerHTML = '<line x1="9" y1="18" x2="15" y2="12"/><line x1="9" y1="6" x2="15" y2="12"/>';
            toggleBtn.title = 'Expand Sidebar';
        } else {
            // Show collapse icon (hamburger menu)
            svg.innerHTML = '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>';
            toggleBtn.title = 'Collapse Sidebar';
        }
    }

    // Comprehensive empty detection for contenteditable
    isEditorEmpty(editor) {
        const content = editor.innerHTML.trim();
        const textContent = editor.textContent.trim();

        // First check for meaningful HTML elements that should never be considered empty
        const meaningfulElements = content.match(/<(img|table|audio|video|iframe|embed|object|canvas|svg)[^>]*>/gi);
        if (meaningfulElements && meaningfulElements.length > 0) {
            return false; // Content contains meaningful media elements
        }

        // Check for lists with content
        const listMatches = content.match(/<(ul|ol)[^>]*>[\s\S]*?<\/(ul|ol)>/gi);
        if (listMatches) {
            // Check if lists have actual content beyond empty <li> tags
            const hasListContent = listMatches.some(list => {
                const listTextContent = list.replace(/<[^>]*>/g, '').trim();
                return listTextContent !== '';
            });
            if (hasListContent) {
                return false;
            }
        }

        // Check for truly empty or whitespace-only text content
        if (textContent === '' || textContent === '\u00A0') { // includes &nbsp;
            return true;
        }

        // Check for common empty HTML patterns
        const emptyPatterns = [
            '', '<br>', '<div></div>', '<p></p>', 
            '<div><br></div>', '<p><br></p>',
            '<div>\u00A0</div>', '<p>\u00A0</p>',
            '<p>Start typing your note here...</p>', // legacy placeholder
            '<ul></ul>', '<ol></ol>', // empty lists
            '<ul><li></li></ul>', '<ol><li></li></ol>' // lists with empty items
        ];

        return emptyPatterns.includes(content);
    }

    // Update placeholder state based on content (non-destructive)
    updatePlaceholderState(editor) {
        if (this.isEditorEmpty(editor)) {
            editor.setAttribute('data-empty', 'true');
        } else {
            editor.removeAttribute('data-empty');
        }
    }

    // Setup editor placeholder behavior
    setupEditorPlaceholder() {
        const textEditor = document.getElementById('textEditor');
        if (!textEditor) return;

        // Note: Input events are handled in setupEventListeners() to avoid duplication
        // Only add placeholder-specific event handlers here

        // Handle focus events
        textEditor.addEventListener('focus', () => {
            this.updatePlaceholderState(textEditor);
        });

        // Handle blur events
        textEditor.addEventListener('blur', () => {
            this.updatePlaceholderState(textEditor);
        });

        // Handle keydown for delete operations (immediate placeholder update)
        textEditor.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' || e.key === 'Delete') {
                setTimeout(() => {
                    this.updatePlaceholderState(textEditor);
                }, 0);
            }
        });

        // Initial state
        this.updatePlaceholderState(textEditor);
    }

    // Modern clipboard operations with rich HTML formatting support
    async modernCut() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        const selectedText = range.toString();

        if (selectedText) {
            try {
                // Get both HTML and plain text content
                const htmlContent = this.getSelectedHtml();
                const plainText = selectedText;

                // Use modern clipboard API with both formats
                const clipboardItems = [new ClipboardItem({
                    'text/html': new Blob([htmlContent], { type: 'text/html' }),
                    'text/plain': new Blob([plainText], { type: 'text/plain' })
                })];

                await navigator.clipboard.write(clipboardItems);
                range.deleteContents();
                this.updateNoteContent();
            } catch (error) {
                console.warn('Modern clipboard failed, using fallback:', error);
                // Fallback to execCommand if clipboard API fails
                try {
                    document.execCommand('cut');
                    this.updateNoteContent();
                } catch (execError) {
                    console.error('Cut operation failed:', execError);
                }
            }
        }
    }

    async modernCopy() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const selectedText = selection.toString();

        if (selectedText) {
            try {
                // Get both HTML and plain text content
                const htmlContent = this.getSelectedHtml();
                const plainText = selectedText;

                // Use modern clipboard API with both formats
                const clipboardItems = [new ClipboardItem({
                    'text/html': new Blob([htmlContent], { type: 'text/html' }),
                    'text/plain': new Blob([plainText], { type: 'text/plain' })
                })];

                await navigator.clipboard.write(clipboardItems);
            } catch (error) {
                console.warn('Modern clipboard failed, using fallback:', error);
                // Fallback to execCommand if clipboard API fails
                try {
                    document.execCommand('copy');
                } catch (execError) {
                    console.error('Copy operation failed:', execError);
                }
            }
        }
    }

    async modernPaste() {
        try {
            // Try to read HTML content first, fallback to plain text
            const clipboardItems = await navigator.clipboard.read();

            for (const item of clipboardItems) {
                if (item.types.includes('text/html')) {
                    const htmlBlob = await item.getType('text/html');
                    const htmlText = await htmlBlob.text();
                    if (htmlText) {
                        this.insertHtmlAtSelection(htmlText);
                        this.updateNoteContent();
                        return;
                    }
                }

                if (item.types.includes('text/plain')) {
                    const textBlob = await item.getType('text/plain');
                    const plainText = await textBlob.text();
                    if (plainText) {
                        this.insertTextAtSelection(plainText);
                        this.updateNoteContent();
                        return;
                    }
                }
            }
        } catch (error) {
            console.warn('Modern clipboard read failed, trying readText fallback:', error);

            // Second fallback: try readText for plain text
            try {
                const plainText = await navigator.clipboard.readText();
                if (plainText) {
                    this.insertTextAtSelection(plainText);
                    this.updateNoteContent();
                    return;
                }
            } catch (readTextError) {
                console.warn('ReadText fallback failed, using execCommand:', readTextError);
            }

            // Final fallback to execCommand if both clipboard APIs fail
            try {
                document.execCommand('paste');
                this.updateNoteContent();
            } catch (execError) {
                console.error('All paste methods failed:', execError);
            }
        }
    }

    // Modern font size implementation with collapsed selection support
    modernFontSize(size) {
        // Restore saved selection to handle dropdown focus loss
        this.restoreSelection();

        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);

        if (range.collapsed) {
            // Handle collapsed selection by creating a styled span for subsequent typing
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;'; // Zero-width space to maintain selection

            range.insertNode(span);

            // Position cursor after the span
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);

            // Set up a listener to apply formatting to subsequent typing
            this.setupTempFormatting(span, { fontSize: size + 'px' });
        } else {
            // Handle text selection
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';

            try {
                const contents = range.extractContents();
                span.appendChild(contents);
                range.insertNode(span);

                // Maintain selection on the formatted content
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch (error) {
                console.error('Error applying font size:', error);
                document.execCommand('fontSize', false, size);
            }
        }
    }

    // Modern text color implementation with collapsed selection support
    modernTextColor(color) {
        // Restore saved selection to handle dropdown focus loss
        this.restoreSelection();

        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);

        if (range.collapsed) {
            // Handle collapsed selection
            const span = document.createElement('span');
            span.style.color = color;
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;'; // Zero-width space

            range.insertNode(span);

            // Position cursor after the span
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);

            // Set up formatting for subsequent typing
            this.setupTempFormatting(span, { color: color });
        } else {
            // Handle text selection
            const span = document.createElement('span');
            span.style.color = color;

            try {
                const contents = range.extractContents();
                span.appendChild(contents);
                range.insertNode(span);

                // Maintain selection on the formatted content
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch (error) {
                console.error('Error applying text color:', error);
                document.execCommand('foreColor', false, color);
            }
        }
    }

    // Modern highlight color implementation with collapsed selection support
    modernHighlightColor(color) {
        // Restore saved selection to handle dropdown focus loss
        this.restoreSelection();

        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);

        if (range.collapsed) {
            // Handle collapsed selection
            const span = document.createElement('span');
            span.style.backgroundColor = color;
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;'; // Zero-width space

            range.insertNode(span);

            // Position cursor after the span
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);

            // Set up formatting for subsequent typing
            this.setupTempFormatting(span, { backgroundColor: color });
        } else {
            // Handle text selection
            const span = document.createElement('span');
            span.style.backgroundColor = color;

            try {
                const contents = range.extractContents();
                span.appendChild(contents);
                range.insertNode(span);

                // Maintain selection on the formatted content
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch (error) {
                console.error('Error applying highlight color:', error);
                document.execCommand('hiliteColor', false, color);
            }
        }
    }

    // Utility method to insert text at current selection
    insertTextAtSelection(text) {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        range.deleteContents();

        const textNode = document.createTextNode(text);
        range.insertNode(textNode);

        // Move cursor to end of inserted text
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // Get selected HTML content with formatting
    getSelectedHtml() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return '';

        const range = selection.getRangeAt(0);
        const clonedSelection = range.cloneContents();
        const div = document.createElement('div');
        div.appendChild(clonedSelection);
        return div.innerHTML;
    }

    // Insert HTML content at current selection
    insertHtmlAtSelection(html) {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        range.deleteContents();

        // Sanitize the HTML before inserting
        const sanitizedHtml = this.sanitizeHtml(html);

        // Create a document fragment from the HTML
        const fragment = document.createRange().createContextualFragment(sanitizedHtml);
        range.insertNode(fragment);

        // Move cursor to end of inserted content
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // Set up temporary formatting for subsequent typing at collapsed selection
    setupTempFormatting(span, styles) {
        const editor = document.getElementById('textEditor');

        // Store the current styles for next character input
        this.tempFormattingStyles = styles;
        this.tempFormattingSpan = span;

        // Set up one-time event handler for next input
        const handleInput = (e) => {
            if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
                // Apply formatting to the newly typed content
                const range = window.getSelection().getRangeAt(0);
                const textNode = range.startContainer;

                if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                    // Wrap the newly typed text in a span with the formatting
                    const newSpan = document.createElement('span');
                    Object.assign(newSpan.style, this.tempFormattingStyles);

                    // Replace the temp span with the new formatted span
                    if (this.tempFormattingSpan && this.tempFormattingSpan.parentNode) {
                        this.tempFormattingSpan.parentNode.replaceChild(newSpan, this.tempFormattingSpan);
                        newSpan.appendChild(textNode);

                        // Position cursor after the formatted text
                        const newRange = document.createRange();
                        newRange.setStartAfter(newSpan);
                        newRange.collapse(true);
                        const selection = window.getSelection();
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    }
                }

                // Clean up
                this.tempFormattingStyles = null;
                this.tempFormattingSpan = null;
                editor.removeEventListener('input', handleInput);
            }
        };

        editor.addEventListener('input', handleInput, { once: true });

        // Also clean up if user moves cursor or clicks elsewhere
        const cleanupHandler = () => {
            if (this.tempFormattingSpan && this.tempFormattingSpan.parentNode) {
                // Remove empty temp span
                const parent = this.tempFormattingSpan.parentNode;
                parent.removeChild(this.tempFormattingSpan);

                // Normalize the parent to merge adjacent text nodes
                if (parent.normalize) {
                    parent.normalize();
                }
            }
            this.tempFormattingStyles = null;
            this.tempFormattingSpan = null;
            editor.removeEventListener('input', handleInput);
            editor.removeEventListener('click', cleanupHandler);
            editor.removeEventListener('keydown', cleanupHandler);
        };

        // Clean up on click or arrow keys
        editor.addEventListener('click', cleanupHandler, { once: true });
        editor.addEventListener('keydown', (e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                cleanupHandler();
            }
        }, { once: true });
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.notesApp = new NotesApp();
});

// Auto-save before page unload
window.addEventListener('beforeunload', () => {
    const app = window.notesApp;
    if (app && app.saveTimeout) {
        clearTimeout(app.saveTimeout);
        app.saveNotesToStorage();
    }
});