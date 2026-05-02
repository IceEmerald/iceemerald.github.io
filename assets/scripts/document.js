/* ================================================
   EmeraldNetwork Document Editor — document.js
   ================================================ */

'use strict';

/* ---- State ---- */
const State = {
    docId: null,
    pages: [],          // array of page objects
    currentPage: 0,
    zoom: 1,
    columns: 1,
    orientation: 'portrait',
    pageSize: 'a4',
    margins: { top: 96, right: 96, bottom: 96, left: 96 }, // px (1in = 96px)
    headerText: '',
    footerText: '',
    headerPageNum: false,
    footerPageNum: true,
    headerDate: false,
    footerDate: false,
    lineSpacing: 1.15,
    savedAt: null,
    isDirty: false,
    saveTimer: null,
    highlightColor: '#ffff00',
    fontColor: '#000000',
};

/* ---- Page size map (px at 96dpi) ---- */
const PAGE_SIZES = {
    a4:     { w: 794,  h: 1123 },
    letter: { w: 816,  h: 1056 },
    legal:  { w: 816,  h: 1344 },
    a3:     { w: 1123, h: 1587 },
    a5:     { w: 559,  h: 794  },
    b5:     { w: 665,  h: 944  },
};

/* ---- Helpers ---- */
function toast(msg, duration = 2500) {
    const el = document.getElementById('docToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), duration);
}

function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
}

function getDocId() {
    let id = new URLSearchParams(location.search).get('doc');
    if (!id) {
        id = 'doc_' + Math.random().toString(36).slice(2, 10);
        const url = new URL(location.href);
        url.searchParams.set('doc', id);
        history.replaceState(null, '', url.toString());
    }
    return id;
}

function getTitle() { return document.getElementById('docTitle').value.trim() || 'Untitled Document'; }

/* ---- Save / Load (localStorage) ---- */
function serialize() {
    return {
        title: getTitle(),
        pages: State.pages.map(p => ({
            html: p.el.querySelector('.page-content').innerHTML,
        })),
        pageSize: State.pageSize,
        orientation: State.orientation,
        margins: State.margins,
        columns: State.columns,
        lineSpacing: State.lineSpacing,
        headerText: State.headerText,
        footerText: State.footerText,
        headerPageNum: State.headerPageNum,
        footerPageNum: State.footerPageNum,
        headerDate: State.headerDate,
        footerDate: State.footerDate,
        zoom: State.zoom,
    };
}

function scheduleSave() {
    setSavedBadge('saving');
    State.isDirty = true;
    clearTimeout(State.saveTimer);
    State.saveTimer = setTimeout(saveDoc, 1200);
}

function saveDoc() {
    try {
        const data = serialize();
        localStorage.setItem('emerald_doc_' + State.docId, JSON.stringify(data));
        setSavedBadge('saved');
        State.isDirty = false;
    } catch (e) {
        setSavedBadge('error');
    }
}

function setSavedBadge(state) {
    const el = document.getElementById('savedBadge');
    if (!el) return;
    if (state === 'saving') {
        el.textContent = 'Saving…';
        el.classList.add('saving');
    } else if (state === 'saved') {
        el.textContent = 'All changes saved';
        el.classList.remove('saving');
    } else {
        el.textContent = 'Save failed';
        el.classList.add('saving');
    }
}

function loadDoc() {
    try {
        const raw = localStorage.getItem('emerald_doc_' + State.docId);
        if (!raw) return false;
        const data = JSON.parse(raw);
        document.getElementById('docTitle').value = data.title || 'Untitled Document';
        State.pageSize = data.pageSize || 'a4';
        State.orientation = data.orientation || 'portrait';
        State.margins = data.margins || { top: 96, right: 96, bottom: 96, left: 96 };
        State.columns = data.columns || 1;
        State.lineSpacing = data.lineSpacing || 1.15;
        State.headerText = data.headerText || '';
        State.footerText = data.footerText || '';
        State.headerPageNum = !!data.headerPageNum;
        State.footerPageNum = data.footerPageNum !== false;
        State.headerDate = !!data.headerDate;
        State.footerDate = !!data.footerDate;
        State.zoom = data.zoom || 1;
        // build pages
        if (data.pages && data.pages.length) {
            data.pages.forEach((p, i) => {
                if (i === 0) {
                    State.pages[0].el.querySelector('.page-content').innerHTML = p.html;
                } else {
                    addPage(false);
                    State.pages[i].el.querySelector('.page-content').innerHTML = p.html;
                }
            });
        }
        applyPageDimensions();
        applyZoom();
        updateAllHeadersFooters();
        updateDropdownLabels();
        return true;
    } catch (e) {
        return false;
    }
}

/* ================================================
   PAGE MANAGEMENT
   ================================================ */
function getPageDimensions() {
    const sz = PAGE_SIZES[State.pageSize] || PAGE_SIZES.a4;
    let w = sz.w, h = sz.h;
    if (State.orientation === 'landscape') { [w, h] = [h, w]; }
    return { w, h };
}

function createPage(idx) {
    const { w, h } = getPageDimensions();
    const m = State.margins;
    const colCount = State.columns;

    const page = document.createElement('div');
    page.className = 'doc-page';
    page.style.width = w + 'px';
    page.style.height = h + 'px';
    page.style.padding = `${m.top}px ${m.right}px ${m.bottom}px ${m.left}px`;
    page.dataset.pageIndex = idx;

    // page number badge (left side label)
    const badge = document.createElement('div');
    badge.className = 'page-number-badge';
    badge.textContent = 'Page ' + (idx + 1);
    page.appendChild(badge);

    const inner = document.createElement('div');
    inner.className = 'page-inner';

    // header
    const hdr = document.createElement('div');
    hdr.className = 'page-header';
    inner.appendChild(hdr);

    // columns wrap
    const colsWrap = document.createElement('div');
    colsWrap.className = `page-columns-wrap cols-${colCount}`;

    for (let c = 0; c < colCount; c++) {
        const content = document.createElement('div');
        content.className = 'page-content';
        content.contentEditable = 'true';
        content.spellcheck = true;
        content.dataset.pageIndex = idx;
        content.dataset.colIndex = c;

        // default empty paragraph
        if (c === 0 && idx === 0) {
            content.innerHTML = '<p><br></p>';
        } else {
            content.innerHTML = '<p><br></p>';
        }

        content.style.lineHeight = State.lineSpacing;

        content.addEventListener('input', onContentInput);
        content.addEventListener('keydown', onContentKeydown);
        content.addEventListener('mouseup', updateToolbarState);
        content.addEventListener('keyup', updateToolbarState);
        content.addEventListener('focus', () => {
            State.currentPage = parseInt(page.dataset.pageIndex, 10);
            updatePageStat();
            updateToolbarState();
            document.querySelectorAll('.doc-page').forEach(p => p.classList.remove('focused'));
            page.classList.add('focused');
        });

        colsWrap.appendChild(content);
    }

    inner.appendChild(colsWrap);

    // footer
    const ftr = document.createElement('div');
    ftr.className = 'page-footer';
    inner.appendChild(ftr);

    page.appendChild(inner);
    return page;
}

function addPage(focus = true) {
    const idx = State.pages.length;
    const pageEl = createPage(idx);
    document.getElementById('pagesContainer').appendChild(pageEl);

    State.pages.push({ el: pageEl, idx });
    updateHeaderFooter(pageEl, idx + 1, State.pages.length);
    updatePageStat();
    updateRuler();

    if (focus) {
        const content = pageEl.querySelector('.page-content');
        content.focus();
        placeCaretAtStart(content);
    }

    return pageEl;
}

function applyPageDimensions() {
    const { w, h } = getPageDimensions();
    const m = State.margins;
    const colCount = State.columns;

    State.pages.forEach((p, i) => {
        const el = p.el;
        el.style.width = w + 'px';
        el.style.height = h + 'px';
        el.style.padding = `${m.top}px ${m.right}px ${m.bottom}px ${m.left}px`;
        el.dataset.pageIndex = i;

        const badge = el.querySelector('.page-number-badge');
        if (badge) badge.textContent = 'Page ' + (i + 1);

        // rebuild columns if count changed
        const colsWrap = el.querySelector('.page-columns-wrap');
        const existingCols = colsWrap.querySelectorAll('.page-content').length;
        if (existingCols !== colCount) {
            const firstContent = colsWrap.querySelector('.page-content');
            const savedHtml = firstContent ? firstContent.innerHTML : '<p><br></p>';
            colsWrap.innerHTML = '';
            colsWrap.className = `page-columns-wrap cols-${colCount}`;
            for (let c = 0; c < colCount; c++) {
                const content = document.createElement('div');
                content.className = 'page-content';
                content.contentEditable = 'true';
                content.spellcheck = true;
                content.dataset.pageIndex = i;
                content.dataset.colIndex = c;
                content.innerHTML = c === 0 ? savedHtml : '<p><br></p>';
                content.style.lineHeight = State.lineSpacing;
                content.addEventListener('input', onContentInput);
                content.addEventListener('keydown', onContentKeydown);
                content.addEventListener('mouseup', updateToolbarState);
                content.addEventListener('keyup', updateToolbarState);
                content.addEventListener('focus', () => {
                    State.currentPage = parseInt(el.dataset.pageIndex, 10);
                    updatePageStat();
                    updateToolbarState();
                    document.querySelectorAll('.doc-page').forEach(pg => pg.classList.remove('focused'));
                    el.classList.add('focused');
                });
                colsWrap.appendChild(content);
            }
        } else {
            colsWrap.className = `page-columns-wrap cols-${colCount}`;
            colsWrap.querySelectorAll('.page-content').forEach(c => {
                c.style.lineHeight = State.lineSpacing;
            });
        }

        updateHeaderFooter(el, i + 1, State.pages.length);
    });

    updateRuler();
    applyZoom();
}

function updateAllHeadersFooters() {
    State.pages.forEach((p, i) => {
        updateHeaderFooter(p.el, i + 1, State.pages.length);
    });
}

function updateHeaderFooter(pageEl, pageNum, total) {
    const hdr = pageEl.querySelector('.page-header');
    const ftr = pageEl.querySelector('.page-footer');
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    let hText = State.headerText;
    if (State.headerPageNum) hText += (hText ? '  |  ' : '') + `Page ${pageNum} of ${total}`;
    if (State.headerDate) hText += (hText ? '  |  ' : '') + date;

    let fText = State.footerText;
    if (State.footerPageNum) fText += (fText ? '  |  ' : '') + `Page ${pageNum} of ${total}`;
    if (State.footerDate) fText += (fText ? '  |  ' : '') + date;

    if (hdr) {
        hdr.textContent = hText;
        hdr.classList.toggle('has-content', !!hText);
        hdr.style.display = hText ? 'flex' : '';
    }
    if (ftr) {
        ftr.textContent = fText;
        ftr.classList.toggle('has-content', !!fText);
        ftr.style.display = fText ? 'flex' : '';
    }
}

function applyZoom() {
    const container = document.getElementById('pagesContainer');
    if (!container) return;
    container.style.transform = `scale(${State.zoom})`;
    container.style.transformOrigin = 'top center';

    const { w, h } = getPageDimensions();
    const gap = 20;
    const totalPages = State.pages.length;

    // When scaling down, transform-scale shrinks the visual size but the DOM layout space
    // stays full-size. We compensate with negative margin-bottom to collapse the extra space.
    const scaledH = h * State.zoom;
    const naturalH = h;
    const diff = (naturalH - scaledH) * totalPages;
    container.style.marginBottom = -diff + 'px';

    document.getElementById('zoomLabel').textContent = Math.round(State.zoom * 100) + '%';
    document.getElementById('statZoom').textContent = Math.round(State.zoom * 100) + '%';
    updateRuler();
}

/* ================================================
   RULER
   ================================================ */
function updateRuler() {
    const canvas = document.getElementById('rulerCanvas');
    if (!canvas) return;
    const { w } = getPageDimensions();
    const scaledW = Math.round(w * State.zoom);
    const workspace = document.getElementById('docWorkspace');
    const ww = workspace.clientWidth || window.innerWidth;

    canvas.width = ww;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, ww, 22);

    // background
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, ww, 22);

    // page area
    const pageLeft = Math.max(0, (ww - scaledW) / 2);
    const pageRight = pageLeft + scaledW;
    ctx.fillStyle = '#fff';
    ctx.fillRect(pageLeft, 0, scaledW, 22);
    ctx.strokeStyle = '#d0d0d0';
    ctx.strokeRect(pageLeft, 0, scaledW, 22);

    // margin indicators
    const mL = State.margins.left * State.zoom;
    const mR = State.margins.right * State.zoom;
    ctx.fillStyle = 'rgba(35,154,77,0.12)';
    ctx.fillRect(pageLeft, 0, mL, 22);
    ctx.fillRect(pageRight - mR, 0, mR, 22);

    // tick marks (every 0.25 inch = 24px at 96dpi)
    const tickUnit = 24 * State.zoom; // px per 0.25in
    ctx.strokeStyle = '#aaa';
    ctx.fillStyle = '#777';
    ctx.font = '9px DM Sans, sans-serif';
    ctx.textAlign = 'center';

    const contentLeft = pageLeft + mL;
    const contentW = scaledW - mL - mR;
    let inchCount = 0;
    for (let x = contentLeft; x <= pageRight - mR + 1; x += tickUnit) {
        const isInch = Math.round(inchCount) === inchCount && inchCount > 0;
        const isHalf = (inchCount % 1) === 0.5;
        const h = isInch ? 10 : isHalf ? 7 : 4;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), 22 - h);
        ctx.lineTo(Math.round(x), 22);
        ctx.stroke();
        if (isInch) {
            ctx.fillText(String(Math.round(inchCount)), Math.round(x), 10);
        }
        inchCount += 0.25;
    }
}

/* ================================================
   CONTENT EVENT HANDLERS
   ================================================ */
function onContentInput(e) {
    updateWordCount();
    scheduleSave();
    updateToolbarState();
}

function onContentKeydown(e) {
    // Tab key — insert spaces
    if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
        return;
    }
    // Ctrl+S
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveDoc();
        toast('Document saved');
        return;
    }
    // Ctrl+Z / Ctrl+Y
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { /* native */ return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') { /* native */ return; }
    // Ctrl+P = print
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        exportPDF();
        return;
    }
    // Enter at page boundary — new page
    if (e.key === 'Enter') {
        checkPageOverflow(e.currentTarget);
    }
}

function checkPageOverflow(contentEl) {
    // allow browser to process the Enter first
    setTimeout(() => {
        const pageIdx = parseInt(contentEl.dataset.pageIndex, 10);
        const colIdx = parseInt(contentEl.dataset.colIndex || '0', 10);
        const { h } = getPageDimensions();
        const m = State.margins;
        const maxH = h - m.top - m.bottom - 44; // 44 for header+footer approx

        if (contentEl.scrollHeight > maxH) {
            // If this is the last page, add a new one
            if (pageIdx === State.pages.length - 1) {
                addPage(false);
                toast('New page added');
            }
        }
        updateWordCount();
        updatePageStat();
    }, 0);
}

function placeCaretAtStart(el) {
    const range = document.createRange();
    range.setStart(el, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function placeCaretAtEnd(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function getFocusedContent() {
    const focused = document.activeElement;
    if (focused && focused.classList.contains('page-content')) return focused;
    // fallback: first content on current page
    if (State.pages[State.currentPage]) {
        return State.pages[State.currentPage].el.querySelector('.page-content');
    }
    return null;
}

function ensureEditorFocused() {
    const c = getFocusedContent();
    if (c) { c.focus(); return c; }
    if (State.pages.length) {
        const fc = State.pages[0].el.querySelector('.page-content');
        fc.focus();
        return fc;
    }
    return null;
}

/* ================================================
   TOOLBAR STATE
   ================================================ */
function updateToolbarState() {
    const commands = ['bold', 'italic', 'underline', 'strikeThrough',
        'subscript', 'superscript', 'justifyLeft', 'justifyCenter',
        'justifyRight', 'justifyFull', 'insertUnorderedList', 'insertOrderedList'];
    commands.forEach(cmd => {
        const btn = document.querySelector(`[data-command="${cmd}"]`);
        if (!btn) return;
        try {
            btn.classList.toggle('active', document.queryCommandState(cmd));
        } catch (e) {}
    });

    // font family
    try {
        let ff = document.queryCommandValue('fontName').replace(/"/g, '').replace(/'/g, '');
        // trim fallbacks (e.g. "Calibri, DM Sans, sans-serif" -> "Calibri")
        ff = ff.split(',')[0].trim();
        const ffBtn = document.querySelector('#fontFamilyDropdown .dropdown-value');
        if (ffBtn && ff) ffBtn.textContent = ff;
    } catch (e) {}

    // font size
    try {
        const node = window.getSelection()?.anchorNode;
        if (node) {
            const el = node.nodeType === 1 ? node : node.parentElement;
            const computed = window.getComputedStyle(el);
            const sz = parseFloat(computed.fontSize);
            const pt = Math.round(sz * 0.75);
            const szBtn = document.querySelector('#fontSizeDropdown .dropdown-value');
            if (szBtn && pt) szBtn.textContent = pt;
        }
    } catch (e) {}

    updatePageStat();
}

function updatePageStat() {
    const total = State.pages.length;
    const cur = State.currentPage + 1;
    document.getElementById('statPage').textContent = `Page ${cur} of ${total}`;
}

function updateWordCount() {
    let text = '';
    State.pages.forEach(p => {
        p.el.querySelectorAll('.page-content').forEach(c => {
            text += (c.innerText || '') + ' ';
        });
    });
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const chars = text.replace(/\s/g, '').length;
    document.getElementById('statWords').textContent = words + ' words';
    document.getElementById('statChars').textContent = chars + ' characters';
}

/* ================================================
   FORMATTING COMMANDS
   ================================================ */
function execCmd(cmd, value = null) {
    ensureEditorFocused();
    try {
        if (value !== null) document.execCommand(cmd, false, value);
        else document.execCommand(cmd, false, null);
    } catch (e) {}
    updateToolbarState();
    scheduleSave();
}

function applyFontFamily(family) {
    ensureEditorFocused();
    execCmd('fontName', family);
    document.querySelector('#fontFamilyDropdown .dropdown-value').textContent = family;
}

function applyFontSize(pt) {
    // execCommand fontSize uses 1-7 scale; use inline style instead
    ensureEditorFocused();
    const px = Math.round(pt * 96 / 72);
    execCmd('fontSize', '7'); // set to max first
    // fix the font size via span replacement
    document.querySelectorAll('font[size="7"]').forEach(el => {
        el.removeAttribute('size');
        el.style.fontSize = px + 'px';
    });
    document.querySelector('#fontSizeDropdown .dropdown-value').textContent = pt;
    scheduleSave();
}

function applyFontColor(color) {
    State.fontColor = color;
    ensureEditorFocused();
    execCmd('foreColor', color);
    document.getElementById('fontColorSwatch').style.background = color;
}

function applyHighlight(color) {
    State.highlightColor = color;
    ensureEditorFocused();
    if (color === 'transparent') {
        execCmd('hiliteColor', 'transparent');
        execCmd('backColor', 'transparent');
    } else {
        execCmd('hiliteColor', color);
    }
    document.getElementById('highlightSwatch').style.background = color;
}

function applyStyle(styleTag) {
    ensureEditorFocused();
    if (styleTag === 'p-caption') {
        execCmd('formatBlock', 'p');
        // style via execCmd is limited; add class via selection
        const sel = window.getSelection();
        if (sel.rangeCount) {
            const range = sel.getRangeAt(0);
            const block = range.startContainer.nodeType === 1
                ? range.startContainer
                : range.startContainer.parentElement?.closest('p,h1,h2,h3,h4,blockquote,pre');
            if (block) {
                block.style.fontSize = '10pt';
                block.style.color = '#888';
                block.style.fontStyle = 'italic';
            }
        }
    } else if (styleTag === 'p-subtitle') {
        execCmd('formatBlock', 'p');
        const block = getSelectionBlock();
        if (block) { block.style.fontSize = '14pt'; block.style.color = '#555'; }
    } else if (styleTag === 'p-title') {
        execCmd('formatBlock', 'p');
        const block = getSelectionBlock();
        if (block) { block.style.fontSize = '22pt'; block.style.fontWeight = '700'; block.style.letterSpacing = '-0.5px'; }
    } else {
        execCmd('formatBlock', styleTag);
    }
    document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-style="${styleTag}"]`)?.classList.add('active');
    scheduleSave();
}

function getSelectionBlock() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const node = sel.getRangeAt(0).startContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el.closest('p,h1,h2,h3,h4,h5,h6,blockquote,pre,div') || el;
}

/* ================================================
   INSERT
   ================================================ */
function insertTable(rows, cols) {
    let html = '<table><tbody>';
    for (let r = 0; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) {
            html += r === 0
                ? `<th contenteditable="true"><br></th>`
                : `<td contenteditable="true"><br></td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    ensureEditorFocused();
    execCmd('insertHTML', html);
    scheduleSave();
}

function insertLink(text, url) {
    ensureEditorFocused();
    const html = `<a href="${url}" target="_blank">${text || url}</a>`;
    execCmd('insertHTML', html);
}

function insertHr() {
    ensureEditorFocused();
    execCmd('insertHTML', '<hr><p><br></p>');
}

function insertPageBreak() {
    ensureEditorFocused();
    addPage(true);
}

function insertPageNumber() {
    const pageNum = State.currentPage + 1;
    ensureEditorFocused();
    execCmd('insertHTML', `<span class="page-num-field" contenteditable="false">[Page ${pageNum}]</span>`);
}

/* ================================================
   CLIPBOARD
   ================================================ */
function doCut() { document.execCommand('cut'); }
function doCopy() { document.execCommand('copy'); toast('Copied to clipboard'); }
function doPaste() {
    ensureEditorFocused();
    navigator.clipboard.readText().then(text => {
        execCmd('insertText', text);
    }).catch(() => {
        toast('Paste using Ctrl+V');
    });
}
function clearFormatting() {
    ensureEditorFocused();
    execCmd('removeFormat');
    toast('Formatting cleared');
}

/* ================================================
   EXPORT — PDF
   ================================================ */
function exportPDF() {
    toast('Preparing PDF print dialog…', 2000);
    setTimeout(() => window.print(), 500);
}

/* ================================================
   EXPORT — DOCX
   ================================================ */
function exportDOCX() {
    try {
        if (typeof htmlDocx === 'undefined') {
            toast('DOCX export library not loaded. Try again.', 3000);
            return;
        }

        let html = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
        html += '<style>body{font-family:Calibri,sans-serif;font-size:11pt;margin:1in;}';
        html += 'h1{font-size:24pt;}h2{font-size:18pt;}h3{font-size:14pt;}';
        html += 'table{border-collapse:collapse;width:100%;}';
        html += 'td,th{border:1px solid #bbb;padding:6px 10px;}';
        html += '</style></head><body>';

        State.pages.forEach((p, i) => {
            if (i > 0) html += '<div style="page-break-before:always;"></div>';
            const header = State.headerText || (State.headerPageNum ? `Page ${i+1} of ${State.pages.length}` : '');
            const footer = State.footerText || (State.footerPageNum ? `Page ${i+1} of ${State.pages.length}` : '');
            if (header) html += `<p style="font-size:9pt;color:#888;border-bottom:1px solid #ddd;padding-bottom:4px;margin-bottom:12px;">${header}</p>`;
            p.el.querySelectorAll('.page-content').forEach(c => {
                html += c.innerHTML;
            });
            if (footer) html += `<p style="font-size:9pt;color:#888;border-top:1px solid #ddd;padding-top:4px;margin-top:12px;">${footer}</p>`;
        });

        html += '</body></html>';

        const blob = htmlDocx.asBlob(html, {
            orientation: State.orientation === 'landscape' ? 'landscape' : 'portrait',
            margins: {
                top: Math.round(State.margins.top * 914400 / 96),
                right: Math.round(State.margins.right * 914400 / 96),
                bottom: Math.round(State.margins.bottom * 914400 / 96),
                left: Math.round(State.margins.left * 914400 / 96),
            }
        });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (getTitle() || 'document') + '.docx';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
        toast('DOCX exported successfully!');
    } catch (e) {
        toast('DOCX export failed: ' + e.message, 4000);
    }
}

/* ================================================
   IMPORT
   ================================================ */
function importFile(file) {
    if (!file) return;
    const name = file.name.toLowerCase();

    if (name.endsWith('.docx')) {
        importDOCX(file);
    } else if (name.endsWith('.pdf')) {
        toast('PDF import: text extraction in progress…', 3000);
        importPDF(file);
    } else if (name.endsWith('.txt')) {
        importText(file);
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
        importHTML(file);
    } else {
        toast('Unsupported file type. Supported: .docx, .pdf, .txt, .html', 4000);
    }
}

function importDOCX(file) {
    if (typeof mammoth === 'undefined') {
        toast('DOCX import library not loaded. Try again.', 3000);
        return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        mammoth.convertToHtml({ arrayBuffer: e.target.result })
            .then(result => {
                loadContent(result.value, file.name.replace(/\.docx$/i, ''));
                toast('DOCX imported successfully!');
            })
            .catch(err => toast('Import failed: ' + err.message, 4000));
    };
    reader.readAsArrayBuffer(file);
}

function importPDF(file) {
    // Use PDF.js if available, otherwise read as text
    const reader = new FileReader();
    reader.onload = e => {
        try {
            if (typeof pdfjsLib !== 'undefined') {
                const typedarray = new Uint8Array(e.target.result);
                pdfjsLib.getDocument(typedarray).promise.then(pdf => {
                    const pages = [];
                    const loadPage = (num) => {
                        return pdf.getPage(num).then(page => {
                            return page.getTextContent().then(content => {
                                const text = content.items.map(i => i.str).join(' ');
                                pages.push('<p>' + text.replace(/\n/g, '</p><p>') + '</p>');
                            });
                        });
                    };
                    const promises = [];
                    for (let i = 1; i <= pdf.numPages; i++) promises.push(loadPage(i));
                    Promise.all(promises).then(() => {
                        loadContent(pages.join('<div style="page-break-before:always;"></div>'), file.name.replace(/\.pdf$/i, ''));
                        toast('PDF imported (text extracted)!');
                    });
                });
            } else {
                // Fallback: just show file name, can't truly parse PDF without library
                toast('PDF text extraction requires pdf.js. Showing placeholder.', 4000);
                loadContent('<p>[PDF content: ' + file.name + ']</p><p>Install pdf.js for full PDF text extraction.</p>', file.name.replace(/\.pdf$/i, ''));
            }
        } catch (err) {
            toast('PDF import error: ' + err.message, 4000);
        }
    };
    reader.readAsArrayBuffer(file);
}

function importText(file) {
    const reader = new FileReader();
    reader.onload = e => {
        const text = e.target.result;
        const html = text.split('\n').map(line => `<p>${line || '<br>'}</p>`).join('');
        loadContent(html, file.name.replace(/\.txt$/i, ''));
        toast('Text file imported!');
    };
    reader.readAsText(file);
}

function importHTML(file) {
    const reader = new FileReader();
    reader.onload = e => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(e.target.result, 'text/html');
        const body = doc.body;
        // Sanitize: remove script tags
        body.querySelectorAll('script,style,link').forEach(el => el.remove());
        loadContent(body.innerHTML, file.name.replace(/\.html?$/i, ''));
        toast('HTML document imported!');
    };
    reader.readAsText(file);
}

function loadContent(html, title) {
    if (title) document.getElementById('docTitle').value = title;
    // Clear all pages except first
    while (State.pages.length > 1) {
        const last = State.pages.pop();
        last.el.remove();
    }
    // Set first page content
    const firstContent = State.pages[0].el.querySelector('.page-content');
    firstContent.innerHTML = html;
    updateWordCount();
    updatePageStat();
    scheduleSave();
}

/* ================================================
   SHARE / COLLAB (localStorage-based simple version)
   ================================================ */
function openShareModal() {
    const base = location.origin + location.pathname.replace('document.html', 'document.html');
    const shareUrl = base + '?doc=' + State.docId + '&view=1';
    const collabUrl = base + '?doc=' + State.docId;
    document.getElementById('shareLink').value = shareUrl;
    document.getElementById('collabLink').value = collabUrl;
    openModal('shareModal');
}

/* ================================================
   MODALS & UI BINDING
   ================================================ */
function initDropdowns() {
    document.querySelectorAll('.ms-dropdown').forEach(dd => {
        const btn = dd.querySelector('.ms-dropdown-btn');
        if (!btn) return;
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const wasOpen = dd.classList.contains('open');
            closeAllDropdowns();
            if (!wasOpen) dd.classList.add('open');
        });
    });

    // Font Family
    document.querySelectorAll('#fontFamilyDropdown .ms-dropdown-item[data-value]').forEach(item => {
        item.addEventListener('click', () => {
            applyFontFamily(item.dataset.value);
            document.querySelector('#fontFamilyDropdown .dropdown-value').textContent = item.dataset.value;
            closeAllDropdowns();
        });
    });

    // Font Size
    document.querySelectorAll('#fontSizeDropdown .ms-dropdown-item[data-value]').forEach(item => {
        item.addEventListener('click', () => {
            applyFontSize(parseInt(item.dataset.value, 10));
            closeAllDropdowns();
        });
    });

    // Line Spacing
    document.querySelectorAll('#lineSpacingDropdown .ms-dropdown-item[data-value]').forEach(item => {
        item.addEventListener('click', () => {
            State.lineSpacing = parseFloat(item.dataset.value);
            document.querySelector('#lineSpacingDropdown .dropdown-value').textContent = item.dataset.value;
            State.pages.forEach(p => {
                p.el.querySelectorAll('.page-content').forEach(c => {
                    c.style.lineHeight = State.lineSpacing;
                });
            });
            closeAllDropdowns();
            scheduleSave();
        });
    });

    // Page Size
    document.querySelectorAll('#pageSizeDropdown .ms-dropdown-item[data-value]').forEach(item => {
        item.addEventListener('click', () => {
            State.pageSize = item.dataset.value;
            document.querySelector('#pageSizeDropdown .dropdown-value').textContent = item.textContent.split(' ')[0];
            closeAllDropdowns();
            applyPageDimensions();
            scheduleSave();
        });
    });

    // Orientation
    document.querySelectorAll('#orientationDropdown .ms-dropdown-item[data-value]').forEach(item => {
        item.addEventListener('click', () => {
            State.orientation = item.dataset.value;
            document.querySelector('#orientationDropdown .dropdown-value').textContent = item.dataset.value === 'portrait' ? 'Portrait' : 'Landscape';
            closeAllDropdowns();
            applyPageDimensions();
            scheduleSave();
        });
    });

    // Columns
    document.querySelectorAll('#columnsDropdown .ms-dropdown-item[data-value]').forEach(item => {
        item.addEventListener('click', () => {
            State.columns = parseInt(item.dataset.value, 10);
            document.querySelector('#columnsDropdown .dropdown-value').textContent = item.textContent;
            closeAllDropdowns();
            applyPageDimensions();
            scheduleSave();
        });
    });

    // Font Color grid
    document.querySelectorAll('#fontColorDropdown .color-cell').forEach(cell => {
        cell.addEventListener('click', e => {
            e.stopPropagation();
            applyFontColor(cell.dataset.color);
            closeAllDropdowns();
        });
    });
    document.getElementById('fontColorCustom')?.addEventListener('input', e => {
        applyFontColor(e.target.value);
    });
    document.getElementById('fontColorCustom')?.addEventListener('change', () => closeAllDropdowns());

    // Highlight grid
    document.querySelectorAll('#highlightDropdown .color-cell').forEach(cell => {
        cell.addEventListener('click', e => {
            e.stopPropagation();
            applyHighlight(cell.dataset.color);
            closeAllDropdowns();
        });
    });
    document.getElementById('highlightCustom')?.addEventListener('input', e => {
        applyHighlight(e.target.value);
    });
    document.getElementById('highlightCustom')?.addEventListener('change', () => closeAllDropdowns());
}

function closeAllDropdowns() {
    document.querySelectorAll('.ms-dropdown.open').forEach(dd => dd.classList.remove('open'));
}

function updateDropdownLabels() {
    document.querySelector('#pageSizeDropdown .dropdown-value').textContent = State.pageSize.toUpperCase();
    document.querySelector('#orientationDropdown .dropdown-value').textContent = State.orientation === 'portrait' ? 'Portrait' : 'Landscape';
    document.querySelector('#columnsDropdown .dropdown-value').textContent = State.columns === 1 ? '1 Column' : State.columns === 2 ? 'Two columns' : 'Three columns';
    document.querySelector('#lineSpacingDropdown .dropdown-value').textContent = State.lineSpacing;
    document.getElementById('zoomLabel').textContent = Math.round(State.zoom * 100) + '%';
}

/* ================================================
   TABLE GRID PICKER
   ================================================ */
function initTableGridPicker() {
    const grid = document.getElementById('tableGrid');
    if (!grid) return;
    const ROWS = 8, COLS = 10;
    grid.style.gridTemplateColumns = `repeat(${COLS}, 20px)`;
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const cell = document.createElement('div');
            cell.className = 'table-grid-cell';
            cell.dataset.r = r + 1;
            cell.dataset.c = c + 1;
            cell.addEventListener('mouseover', () => highlightTableGrid(r + 1, c + 1));
            cell.addEventListener('click', () => {
                document.getElementById('tableRows').value = r + 1;
                document.getElementById('tableCols').value = c + 1;
                closeModal('tableModal');
                insertTable(r + 1, c + 1);
            });
            grid.appendChild(cell);
        }
    }
}

function highlightTableGrid(rows, cols) {
    document.querySelectorAll('.table-grid-cell').forEach(cell => {
        cell.classList.toggle('highlighted',
            parseInt(cell.dataset.r) <= rows && parseInt(cell.dataset.c) <= cols);
    });
    document.getElementById('tableGridLabel').textContent = `${rows} × ${cols}`;
}

/* ================================================
   SPECIAL CHARACTERS
   ================================================ */
const SPECIAL_CHARS = [
    '©','®','™','§','¶','†','‡','•','·','…','–','—',
    '\u00AB','\u00BB','\u201C','\u201D','\u2018','\u2019','\u201E','\u201A',
    '½','¼','¾','⅓','⅔','⅛','⅜','⅝','⅞',
    '°','±','×','÷','≠','≤','≥','≈','∞','√','∑','∏',
    'α','β','γ','δ','ε','θ','λ','μ','π','σ','τ','φ','ω',
    'Α','Β','Γ','Δ','Ω',
    '←','→','↑','↓','↔','↕','⇒','⇐','⇑','⇓','⇔',
    '♠','♣','♥','♦','★','☆','✓','✗','✔','✘',
    '€','£','¥','¢','$','₹','₩','₿',
    '¡','¿','ñ','ü','ö','ä','é','è','ê','à','â','î','ô','û',
    '①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
    '♪','♫','♬','♭','♮','♯',
    '∀','∃','∈','∉','∩','∪','⊂','⊃','⊄','⊆','⊇',
    '⌘','⌃','⌥','⇧','⌫','⌦','⏎','⇥',
    'Æ','æ','Ø','ø','Å','å','Ð','ð','Þ','þ','ß',
];

function initSpecialChars() {
    const grid = document.getElementById('specialCharGrid');
    if (!grid) return;
    SPECIAL_CHARS.forEach(ch => {
        const btn = document.createElement('button');
        btn.className = 'special-char-btn';
        btn.textContent = ch;
        btn.title = ch + ' (U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0') + ')';
        btn.addEventListener('click', () => {
            ensureEditorFocused();
            execCmd('insertText', ch);
            closeModal('specialCharModal');
        });
        grid.appendChild(btn);
    });
}

/* ================================================
   RIBBON TABS
   ================================================ */
function initRibbonTabs() {
    document.querySelectorAll('.ribbon-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            document.querySelectorAll('.ribbon-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.ribbon-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab-' + target)?.classList.add('active');
        });
    });
}

/* ================================================
   FORMAT BUTTONS
   ================================================ */
function initFormatButtons() {
    document.querySelectorAll('[data-command]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.preventDefault();
            execCmd(btn.dataset.command);
        });
    });

    // Clipboard
    document.getElementById('cutBtn').addEventListener('click', doCut);
    document.getElementById('copyBtn').addEventListener('click', doCopy);
    document.getElementById('pasteBtn').addEventListener('click', doPaste);

    // Delete/Clear
    document.getElementById('clearFormatBtn').addEventListener('click', clearFormatting);
    document.getElementById('deletePageBtn').addEventListener('click', () => {
        if (State.pages.length <= 1) {
            const c = State.pages[0].el.querySelector('.page-content');
            c.innerHTML = '<p><br></p>';
            toast('Page content cleared');
            scheduleSave();
            return;
        }
        if (confirm('Delete this page?')) {
            const idx = State.currentPage;
            const page = State.pages[idx];
            page.el.remove();
            State.pages.splice(idx, 1);
            State.currentPage = Math.max(0, idx - 1);
            // re-index
            State.pages.forEach((p, i) => {
                p.idx = i;
                p.el.dataset.pageIndex = i;
                p.el.querySelectorAll('.page-content').forEach(c => c.dataset.pageIndex = i);
                const badge = p.el.querySelector('.page-number-badge');
                if (badge) badge.textContent = 'Page ' + (i + 1);
                updateHeaderFooter(p.el, i + 1, State.pages.length);
            });
            updatePageStat();
            scheduleSave();
            toast('Page deleted');
        }
    });

    // Style buttons
    document.querySelectorAll('.style-btn').forEach(btn => {
        btn.addEventListener('click', () => applyStyle(btn.dataset.style));
    });

    // Insert
    document.getElementById('insertTableBtn')?.addEventListener('click', () => openModal('tableModal'));
    document.getElementById('insertTableConfirm')?.addEventListener('click', () => {
        const rows = parseInt(document.getElementById('tableRows').value, 10) || 3;
        const cols = parseInt(document.getElementById('tableCols').value, 10) || 3;
        closeModal('tableModal');
        insertTable(rows, cols);
    });

    document.getElementById('insertImageBtn')?.addEventListener('click', () => {
        document.getElementById('insertImageInput').click();
    });
    document.getElementById('insertImageInput')?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            ensureEditorFocused();
            execCmd('insertHTML', `<img src="${ev.target.result}" alt="${file.name}" style="max-width:100%;">`);
            toast('Image inserted');
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    document.getElementById('insertLinkBtn')?.addEventListener('click', () => {
        const sel = window.getSelection();
        document.getElementById('linkText').value = sel ? sel.toString() : '';
        document.getElementById('linkUrl').value = '';
        openModal('linkModal');
    });
    document.getElementById('insertLinkConfirm')?.addEventListener('click', () => {
        const text = document.getElementById('linkText').value;
        const url = document.getElementById('linkUrl').value;
        if (!url) { toast('Please enter a URL'); return; }
        closeModal('linkModal');
        insertLink(text, url);
    });

    document.getElementById('insertHrBtn')?.addEventListener('click', insertHr);
    document.getElementById('insertPageBreakBtn')?.addEventListener('click', insertPageBreak);
    document.getElementById('insertPageNumBtn')?.addEventListener('click', insertPageNumber);
    document.getElementById('insertSpecialCharBtn')?.addEventListener('click', () => openModal('specialCharModal'));

    document.getElementById('headerFooterBtn')?.addEventListener('click', () => {
        document.getElementById('headerText').value = State.headerText;
        document.getElementById('footerText').value = State.footerText;
        document.getElementById('headerPageNum').checked = State.headerPageNum;
        document.getElementById('footerPageNum').checked = State.footerPageNum;
        document.getElementById('headerDate').checked = State.headerDate;
        document.getElementById('footerDate').checked = State.footerDate;
        openModal('headerFooterModal');
    });
    document.getElementById('applyHeaderFooter')?.addEventListener('click', () => {
        State.headerText = document.getElementById('headerText').value;
        State.footerText = document.getElementById('footerText').value;
        State.headerPageNum = document.getElementById('headerPageNum').checked;
        State.footerPageNum = document.getElementById('footerPageNum').checked;
        State.headerDate = document.getElementById('headerDate').checked;
        State.footerDate = document.getElementById('footerDate').checked;
        closeModal('headerFooterModal');
        updateAllHeadersFooters();
        scheduleSave();
        toast('Header & footer updated');
    });

    // Layout
    document.getElementById('marginsBtn')?.addEventListener('click', () => openModal('marginsModal'));
    document.querySelectorAll('.margin-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.margin-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const preset = btn.dataset.preset;
            const customFields = document.getElementById('marginCustomFields');
            if (preset === 'custom') {
                customFields.classList.add('visible');
            } else {
                customFields.classList.remove('visible');
                const presets = {
                    normal:   { top: 96, right: 96, bottom: 96, left: 96 },
                    narrow:   { top: 48, right: 48, bottom: 48, left: 48 },
                    moderate: { top: 96, right: 72, bottom: 96, left: 72 },
                    wide:     { top: 96, right: 192, bottom: 96, left: 192 },
                };
                const m = presets[preset];
                if (m) {
                    document.getElementById('marginTop').value = (m.top / 96).toFixed(1);
                    document.getElementById('marginRight').value = (m.right / 96).toFixed(1);
                    document.getElementById('marginBottom').value = (m.bottom / 96).toFixed(1);
                    document.getElementById('marginLeft').value = (m.left / 96).toFixed(1);
                }
            }
        });
    });
    document.getElementById('applyMarginsBtn')?.addEventListener('click', () => {
        const top = parseFloat(document.getElementById('marginTop').value) * 96;
        const right = parseFloat(document.getElementById('marginRight').value) * 96;
        const bottom = parseFloat(document.getElementById('marginBottom').value) * 96;
        const left = parseFloat(document.getElementById('marginLeft').value) * 96;
        State.margins = { top, right, bottom, left };
        closeModal('marginsModal');
        applyPageDimensions();
        scheduleSave();
        toast('Margins applied');
    });

    // Zoom
    document.getElementById('zoomInBtn')?.addEventListener('click', () => {
        State.zoom = Math.min(2, parseFloat((State.zoom + 0.1).toFixed(2)));
        applyZoom();
        scheduleSave();
    });
    document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
        State.zoom = Math.max(0.3, parseFloat((State.zoom - 0.1).toFixed(2)));
        applyZoom();
        scheduleSave();
    });

    // Export / Import
    document.getElementById('exportPdfBtn')?.addEventListener('click', exportPDF);
    document.getElementById('exportDocxBtn')?.addEventListener('click', exportDOCX);
    document.getElementById('importBtn')?.addEventListener('click', () => {
        document.getElementById('importFile').click();
    });
    document.getElementById('importFile')?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) importFile(file);
        e.target.value = '';
    });

    // Share
    document.getElementById('shareBtn')?.addEventListener('click', openShareModal);
    document.getElementById('copyShareLink')?.addEventListener('click', () => {
        navigator.clipboard.writeText(document.getElementById('shareLink').value)
            .then(() => toast('Share link copied!'))
            .catch(() => toast('Copy failed'));
    });
    document.getElementById('copyCollabLink')?.addEventListener('click', () => {
        navigator.clipboard.writeText(document.getElementById('collabLink').value)
            .then(() => toast('Collaboration link copied!'))
            .catch(() => toast('Copy failed'));
    });
}

/* ================================================
   MODAL CLOSE HANDLERS
   ================================================ */
function initModals() {
    document.querySelectorAll('.doc-modal-close, .modal-btn.cancel').forEach(btn => {
        const modalId = btn.dataset.modal;
        if (modalId) btn.addEventListener('click', () => closeModal(modalId));
    });
    // Close on overlay click
    document.querySelectorAll('.doc-modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) {
                overlay.classList.remove('open');
            }
        });
    });
    // ESC closes modals
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.doc-modal-overlay.open').forEach(o => o.classList.remove('open'));
            closeAllDropdowns();
        }
    });
}

/* ================================================
   TABLE TOOLBAR (right-click / context on table)
   ================================================ */
let tableToolbarCell = null;

function initTableToolbar() {
    const toolbar = document.getElementById('tableToolbar');
    if (!toolbar) return;

    document.addEventListener('click', e => {
        const cell = e.target.closest('td, th');
        if (!cell) {
            toolbar.style.display = 'none';
            tableToolbarCell = null;
            return;
        }
        const rect = cell.getBoundingClientRect();
        toolbar.style.display = 'flex';
        toolbar.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        toolbar.style.left = rect.left + 'px';
        tableToolbarCell = cell;
    });

    toolbar.querySelectorAll('.tbl-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (!tableToolbarCell) return;
            const cmd = btn.dataset.tbl;
            const table = tableToolbarCell.closest('table');
            const row = tableToolbarCell.closest('tr');
            const cellIdx = Array.from(row.cells).indexOf(tableToolbarCell);

            if (cmd === 'addRowAbove') {
                const newRow = row.cloneNode(false);
                for (let i = 0; i < row.cells.length; i++) {
                    const td = document.createElement('td');
                    td.contentEditable = 'true';
                    td.innerHTML = '<br>';
                    newRow.appendChild(td);
                }
                table.querySelector('tbody').insertBefore(newRow, row);
            } else if (cmd === 'addRowBelow') {
                const newRow = row.cloneNode(false);
                for (let i = 0; i < row.cells.length; i++) {
                    const td = document.createElement('td');
                    td.contentEditable = 'true';
                    td.innerHTML = '<br>';
                    newRow.appendChild(td);
                }
                row.parentNode.insertBefore(newRow, row.nextSibling);
            } else if (cmd === 'deleteRow') {
                if (table.rows.length > 1) row.remove();
                else toast('Cannot delete the only row');
                toolbar.style.display = 'none';
            } else if (cmd === 'addColLeft') {
                Array.from(table.rows).forEach(r => {
                    const td = document.createElement(r.rowIndex === 0 ? 'th' : 'td');
                    td.contentEditable = 'true';
                    td.innerHTML = '<br>';
                    r.insertBefore(td, r.cells[cellIdx]);
                });
            } else if (cmd === 'addColRight') {
                Array.from(table.rows).forEach(r => {
                    const td = document.createElement(r.rowIndex === 0 ? 'th' : 'td');
                    td.contentEditable = 'true';
                    td.innerHTML = '<br>';
                    const ref = r.cells[cellIdx + 1];
                    ref ? r.insertBefore(td, ref) : r.appendChild(td);
                });
            } else if (cmd === 'deleteCol') {
                if (table.rows[0].cells.length > 1) {
                    Array.from(table.rows).forEach(r => {
                        if (r.cells[cellIdx]) r.cells[cellIdx].remove();
                    });
                } else toast('Cannot delete the only column');
                toolbar.style.display = 'none';
            }
            scheduleSave();
        });
    });
}

/* ================================================
   KEYBOARD SHORTCUTS
   ================================================ */
function initKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const key = e.key.toLowerCase();
        if (key === 's') { e.preventDefault(); saveDoc(); toast('Saved'); }
        if (key === 'p') { e.preventDefault(); exportPDF(); }
        if (key === '=' && e.shiftKey) { e.preventDefault(); execCmd('superscript'); }
        if (key === '=' && !e.shiftKey) { e.preventDefault(); execCmd('subscript'); }
    });
}

/* ================================================
   DRAG & DROP images onto pages
   ================================================ */
function initDragDrop() {
    document.getElementById('pagesContainer').addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    document.getElementById('pagesContainer').addEventListener('drop', e => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        const imgFiles = files.filter(f => f.type.startsWith('image/'));
        if (imgFiles.length) {
            imgFiles.forEach(file => {
                const reader = new FileReader();
                reader.onload = ev => {
                    ensureEditorFocused();
                    execCmd('insertHTML', `<img src="${ev.target.result}" alt="${file.name}" style="max-width:100%;">`);
                };
                reader.readAsDataURL(file);
            });
        } else {
            // Try importing as document
            importFile(files[0]);
        }
    });
}

/* ================================================
   RESIZE HANDLER
   ================================================ */
function initResize() {
    window.addEventListener('resize', () => {
        updateRuler();
    });
}

/* ================================================
   GLOBAL CLICK — close dropdowns
   ================================================ */
document.addEventListener('click', e => {
    if (!e.target.closest('.ms-dropdown')) {
        closeAllDropdowns();
    }
});

/* ================================================
   INIT
   ================================================ */
function init() {
    State.docId = getDocId();

    // Auto-fit zoom to viewport width
    const viewportW = window.innerWidth;
    const pageW = PAGE_SIZES['a4'].w;
    const padding = 120; // left + right padding
    const fittedZoom = Math.min(1, (viewportW - padding) / pageW);
    State.zoom = parseFloat(Math.max(0.5, fittedZoom).toFixed(2));

    // Create first page
    const firstPageEl = createPage(0);
    document.getElementById('pagesContainer').appendChild(firstPageEl);
    State.pages.push({ el: firstPageEl, idx: 0 });

    // Load saved doc
    const loaded = loadDoc();
    if (!loaded) {
        // Fresh doc: focus first content
        const fc = firstPageEl.querySelector('.page-content');
        fc.focus();
    }

    applyPageDimensions();
    applyZoom();
    updateAllHeadersFooters();
    updateWordCount();
    updatePageStat();

    // Initialize everything
    initRibbonTabs();
    initDropdowns();
    initFormatButtons();
    initModals();
    initTableToolbar();
    initTableGridPicker();
    initSpecialChars();
    initKeyboardShortcuts();
    initDragDrop();
    initResize();

    updateRuler();

    // Autosave every 30s
    setInterval(() => {
        if (State.isDirty) saveDoc();
    }, 30000);

    console.log('EmeraldNetwork Document Editor initialized');
}

document.addEventListener('DOMContentLoaded', init);
