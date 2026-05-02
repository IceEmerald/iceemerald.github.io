/* ================================================
   EmeraldNetwork Document Editor — document.js
   ================================================ */

'use strict';

/* ---- State ---- */
const State = {
    docId: null,
    pages: [],
    currentPage: 0,
    zoom: 1,
    columns: 1,
    orientation: 'portrait',
    pageSize: 'a4',
    margins: { top: 96, right: 96, bottom: 96, left: 96 },
    headerText: '',
    footerText: '',
    headerPageNum: false,
    footerPageNum: true,
    headerDate: false,
    footerDate: false,
    lineSpacing: 1.15,
    isDirty: false,
    saveTimer: null,
    highlightColor: '#ffff00',
    fontColor: '#000000',
    drawMode: false,
    drawEraser: false,
    drawColor: '#000000',
    drawSize: 3,
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

/* ================================================
   HELPERS
   ================================================ */
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

/* ================================================
   SAVE / LOAD (localStorage)
   ================================================ */
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
        el.textContent = 'Saving\u2026';
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

    const badge = document.createElement('div');
    badge.className = 'page-number-badge';
    badge.textContent = 'Page ' + (idx + 1);
    page.appendChild(badge);

    const inner = document.createElement('div');
    inner.className = 'page-inner';

    const hdr = document.createElement('div');
    hdr.className = 'page-header';
    inner.appendChild(hdr);

    const colsWrap = document.createElement('div');
    colsWrap.className = `page-columns-wrap cols-${colCount}`;

    for (let c = 0; c < colCount; c++) {
        const content = document.createElement('div');
        content.className = 'page-content';
        content.contentEditable = 'true';
        content.spellcheck = true;
        content.dataset.pageIndex = idx;
        content.dataset.colIndex = c;
        content.innerHTML = '<p><br></p>';
        content.style.lineHeight = State.lineSpacing;
        bindContentEvents(content, page);
        colsWrap.appendChild(content);
    }

    inner.appendChild(colsWrap);

    const ftr = document.createElement('div');
    ftr.className = 'page-footer';
    inner.appendChild(ftr);

    page.appendChild(inner);

    // Draw canvas overlay
    const canvas = document.createElement('canvas');
    canvas.className = 'draw-canvas';
    canvas.width = w;
    canvas.height = h;
    page.appendChild(canvas);

    return page;
}

function bindContentEvents(content, page) {
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

        // Update draw canvas size
        const canvas = el.querySelector('.draw-canvas');
        if (canvas) { canvas.width = w; canvas.height = h; }

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
                bindContentEvents(content, el);
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
    State.pages.forEach((p, i) => updateHeaderFooter(p.el, i + 1, State.pages.length));
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

    const { h } = getPageDimensions();
    const gap = 24;
    const total = State.pages.length;
    const scaledH = h * State.zoom;
    const diff = (h - scaledH) * total + (gap - gap * State.zoom) * (total - 1);
    container.style.marginBottom = (-diff) + 'px';

    const zl = document.getElementById('zoomLabel');
    const zs = document.getElementById('statZoom');
    const pct = Math.round(State.zoom * 100) + '%';
    if (zl) zl.textContent = pct;
    if (zs) zs.textContent = pct;
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
    const ww = (workspace ? workspace.clientWidth : window.innerWidth);

    canvas.width = ww;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, ww, 22);
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, ww, 22);

    const pageLeft = Math.max(0, (ww - scaledW) / 2);
    const pageRight = pageLeft + scaledW;
    ctx.fillStyle = '#fff';
    ctx.fillRect(pageLeft, 0, scaledW, 22);
    ctx.strokeStyle = '#d0d0d0';
    ctx.strokeRect(pageLeft, 0, scaledW, 22);

    const mL = State.margins.left * State.zoom;
    const mR = State.margins.right * State.zoom;
    ctx.fillStyle = 'rgba(35,154,77,0.1)';
    ctx.fillRect(pageLeft, 0, mL, 22);
    ctx.fillRect(pageRight - mR, 0, mR, 22);

    const tickUnit = 24 * State.zoom;
    ctx.strokeStyle = '#bbb';
    ctx.fillStyle = '#888';
    ctx.font = '9px DM Sans, sans-serif';
    ctx.textAlign = 'center';

    let inchCount = 0;
    const contentLeft = pageLeft + mL;
    for (let x = contentLeft; x <= pageRight - mR + 1; x += tickUnit) {
        const isInch = Math.round(inchCount) === inchCount && inchCount > 0;
        const isHalf = (inchCount % 1) === 0.5;
        const ht = isInch ? 10 : isHalf ? 7 : 4;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), 22 - ht);
        ctx.lineTo(Math.round(x), 22);
        ctx.stroke();
        if (isInch) ctx.fillText(String(Math.round(inchCount)), Math.round(x), 10);
        inchCount += 0.25;
    }
}

/* ================================================
   CONTENT EVENT HANDLERS
   ================================================ */
function onContentInput() {
    updateWordCount();
    scheduleSave();
    updateToolbarState();
}

function onContentKeydown(e) {
    if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDoc(); toast('Saved'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); exportPDF(); return; }
    if (e.key === 'Enter') checkPageOverflow(e.currentTarget);
}

function checkPageOverflow(contentEl) {
    setTimeout(() => {
        const pageIdx = parseInt(contentEl.dataset.pageIndex, 10);
        const { h } = getPageDimensions();
        const m = State.margins;
        const maxH = h - m.top - m.bottom - 40;
        if (contentEl.scrollHeight > maxH && pageIdx === State.pages.length - 1) {
            addPage(false);
        }
        updateWordCount();
        updatePageStat();
    }, 0);
}

function placeCaretAtStart(el) {
    try {
        const range = document.createRange();
        range.setStart(el, 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    } catch (e) {}
}

function getFocusedContent() {
    const focused = document.activeElement;
    if (focused && focused.classList.contains('page-content')) return focused;
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
    const commands = ['bold','italic','underline','strikeThrough','subscript','superscript',
        'justifyLeft','justifyCenter','justifyRight','justifyFull','insertUnorderedList','insertOrderedList'];
    commands.forEach(cmd => {
        const btn = document.querySelector(`[data-command="${cmd}"]`);
        if (!btn) return;
        try { btn.classList.toggle('active', document.queryCommandState(cmd)); } catch (e) {}
    });

    try {
        let ff = document.queryCommandValue('fontName').replace(/"/g,'').replace(/'/g,'');
        ff = ff.split(',')[0].trim();
        const ffBtn = document.querySelector('#fontFamilyDropdown .dropdown-value');
        if (ffBtn && ff) ffBtn.textContent = ff;
    } catch (e) {}

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
    const el = document.getElementById('statPage');
    if (el) el.textContent = `Page ${cur} of ${total}`;
}

function updateWordCount() {
    let text = '';
    State.pages.forEach(p => {
        p.el.querySelectorAll('.page-content').forEach(c => { text += (c.innerText || '') + ' '; });
    });
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const chars = text.replace(/\s/g, '').length;
    const ws = document.getElementById('statWords');
    const cs = document.getElementById('statChars');
    if (ws) ws.textContent = words + ' words';
    if (cs) cs.textContent = chars + ' characters';
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
    const btn = document.querySelector('#fontFamilyDropdown .dropdown-value');
    if (btn) btn.textContent = family;
}

function applyFontSize(pt) {
    ensureEditorFocused();
    const px = Math.round(pt * 96 / 72);
    execCmd('fontSize', '7');
    document.querySelectorAll('font[size="7"]').forEach(el => {
        el.removeAttribute('size');
        el.style.fontSize = px + 'px';
    });
    const btn = document.querySelector('#fontSizeDropdown .dropdown-value');
    if (btn) btn.textContent = pt;
    scheduleSave();
}

function applyFontColor(color) {
    State.fontColor = color;
    ensureEditorFocused();
    execCmd('foreColor', color);
    const sw = document.getElementById('fontColorSwatch');
    if (sw) sw.style.background = color;
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
    const sw = document.getElementById('highlightSwatch');
    if (sw) sw.style.background = color;
}

function applyStyle(styleTag) {
    ensureEditorFocused();
    const block = getSelectionBlock();
    if (styleTag === 'p-caption') {
        execCmd('formatBlock', 'p');
        if (block) { block.style.fontSize = '10pt'; block.style.color = '#888'; block.style.fontStyle = 'italic'; }
    } else if (styleTag === 'p-subtitle') {
        execCmd('formatBlock', 'p');
        if (block) { block.style.fontSize = '14pt'; block.style.color = '#555'; }
    } else if (styleTag === 'p-title') {
        execCmd('formatBlock', 'p');
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
    if (!sel || !sel.rangeCount) return null;
    const node = sel.getRangeAt(0).startContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el ? (el.closest('p,h1,h2,h3,h4,h5,h6,blockquote,pre,div') || el) : null;
}

/* ================================================
   INSERT
   ================================================ */
function insertTable(rows, cols) {
    let html = '<table style="border-collapse:collapse;width:auto;"><tbody>';
    for (let r = 0; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) {
            const tag = r === 0 ? 'th' : 'td';
            html += `<${tag} style="border:1px solid #bbb;padding:6px 10px;min-width:80px;" contenteditable="true"><br></${tag}>`;
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
    execCmd('insertHTML', `<span style="color:#239a4d;font-weight:600;" contenteditable="false">[Page ${pageNum}]</span>`);
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
        toast('Use Ctrl+V to paste');
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
    toast('Preparing PDF\u2026', 2000);
    setTimeout(() => window.print(), 400);
}

/* ================================================
   EXPORT — DOCX
   ================================================ */
function exportDOCX() {
    try {
        if (typeof htmlDocx === 'undefined') {
            toast('DOCX library not loaded. Try refreshing.', 3000);
            return;
        }
        let html = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
        html += '<style>body{font-family:Arial,sans-serif;font-size:12pt;margin:1in;line-height:1.15;}';
        html += 'h1{font-size:24pt;}h2{font-size:18pt;}h3{font-size:14pt;}h4{font-size:12pt;}';
        html += 'table{border-collapse:collapse;width:100%;margin:10px 0;}';
        html += 'td,th{border:1px solid #bbb;padding:6px 10px;}';
        html += 'th{background:#f4f4f4;font-weight:700;}';
        html += 'blockquote{border-left:3px solid #aaa;padding-left:14px;color:#555;font-style:italic;}';
        html += 'pre{font-family:Courier New,monospace;background:#f6f8fa;padding:10px;font-size:10pt;}';
        html += 'img{max-width:100%;height:auto;}';
        html += 'a{color:#1155cc;}</style></head><body>';

        State.pages.forEach((p, i) => {
            if (i > 0) html += '<div style="page-break-before:always;"></div>';
            const hdr = State.headerText || (State.headerPageNum ? `Page ${i+1} of ${State.pages.length}` : '');
            const ftr = State.footerText || (State.footerPageNum ? `Page ${i+1} of ${State.pages.length}` : '');
            if (hdr) html += `<p style="font-size:9pt;color:#888;border-bottom:1px solid #ddd;padding-bottom:4px;margin-bottom:12px;">${hdr}</p>`;
            p.el.querySelectorAll('.page-content').forEach(c => {
                // Clone to clean up draw canvases etc.
                const clone = c.cloneNode(true);
                clone.querySelectorAll('canvas').forEach(cv => cv.remove());
                html += clone.innerHTML;
            });
            if (ftr) html += `<p style="font-size:9pt;color:#888;border-top:1px solid #ddd;padding-top:4px;margin-top:12px;">${ftr}</p>`;
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
        toast('DOCX exported!');
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
    if (name.endsWith('.docx')) importDOCX(file);
    else if (name.endsWith('.pdf')) importPDF(file);
    else if (name.endsWith('.txt')) importText(file);
    else if (name.endsWith('.html') || name.endsWith('.htm')) importHTML(file);
    else toast('Unsupported file. Supported: .docx, .pdf, .txt, .html', 4000);
}

function importDOCX(file) {
    if (typeof mammoth === 'undefined') {
        toast('DOCX import library not loaded.', 3000);
        return;
    }
    toast('Importing DOCX\u2026', 3000);
    const reader = new FileReader();
    reader.onload = e => {
        mammoth.convertToHtml(
            { arrayBuffer: e.target.result },
            {
                styleMap: [
                    "p[style-name='Heading 1'] => h1:fresh",
                    "p[style-name='Heading 2'] => h2:fresh",
                    "p[style-name='Heading 3'] => h3:fresh",
                    "p[style-name='Heading 4'] => h4:fresh",
                    "p[style-name='Title'] => h1.doc-title:fresh",
                    "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
                    "p[style-name='Quote'] => blockquote:fresh",
                    "p[style-name='Intense Quote'] => blockquote.intense:fresh",
                    "p[style-name='Caption'] => p.doc-caption:fresh",
                    "p[style-name='List Bullet'] => ul > li:fresh",
                    "p[style-name='List Bullet 2'] => ul > li:fresh",
                    "p[style-name='List Number'] => ol > li:fresh",
                    "p[style-name='List Number 2'] => ol > li:fresh",
                    "r[style-name='Intense Emphasis'] => em",
                    "r[style-name='Intense Reference'] => strong",
                    "table => table",
                    "tr => tr",
                    "td => td",
                ],
                convertImage: mammoth.images.imgElement(function(image) {
                    return image.read('base64').then(function(imageBuffer) {
                        return { src: 'data:' + image.contentType + ';base64,' + imageBuffer };
                    });
                }),
                includeDefaultStyleMap: true,
                ignoreEmptyParagraphs: false,
            }
        )
        .then(result => {
            let html = result.value;
            // Post-process: wrap images for movability
            html = html.replace(/<img /g, '<img style="max-width:100%;cursor:move;" ');
            loadContent(html, file.name.replace(/\.docx$/i, ''));
            if (result.messages.length) {
                console.log('DOCX import messages:', result.messages);
            }
            toast('DOCX imported! Formatting preserved.');
        })
        .catch(err => toast('Import failed: ' + err.message, 4000));
    };
    reader.readAsArrayBuffer(file);
}

function importPDF(file) {
    if (typeof pdfjsLib === 'undefined') {
        toast('PDF.js not loaded. Refreshing may help.', 4000);
        return;
    }

    // Set worker source
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    toast('Extracting PDF text\u2026', 4000);
    const reader = new FileReader();
    reader.onload = e => {
        const typedArray = new Uint8Array(e.target.result);
        pdfjsLib.getDocument({ data: typedArray }).promise.then(pdf => {
            const pagePromises = [];
            for (let i = 1; i <= pdf.numPages; i++) {
                pagePromises.push(
                    pdf.getPage(i).then(page =>
                        page.getTextContent().then(content => {
                            // Build HTML preserving line structure
                            let pageHtml = '';
                            let lastY = null;
                            let lineText = '';
                            content.items.forEach(item => {
                                if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) {
                                    // New line
                                    if (lineText.trim()) pageHtml += '<p>' + escapeHtml(lineText.trim()) + '</p>';
                                    lineText = item.str;
                                } else {
                                    lineText += item.str;
                                }
                                lastY = item.transform[5];
                            });
                            if (lineText.trim()) pageHtml += '<p>' + escapeHtml(lineText.trim()) + '</p>';
                            return pageHtml || '<p><br></p>';
                        })
                    )
                );
            }
            Promise.all(pagePromises).then(pageParts => {
                const combined = pageParts.join('<hr style="border-top:2px dashed #ddd;margin:16px 0;">');
                loadContent(combined, file.name.replace(/\.pdf$/i, ''));
                toast(`PDF imported: ${pdf.numPages} page(s) extracted!`);
            });
        }).catch(err => {
            toast('PDF parse error: ' + err.message, 4000);
        });
    };
    reader.readAsArrayBuffer(file);
}

function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function importText(file) {
    const reader = new FileReader();
    reader.onload = e => {
        const text = e.target.result;
        const html = text.split('\n').map(line => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');
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
        doc.body.querySelectorAll('script,link').forEach(el => el.remove());
        loadContent(doc.body.innerHTML, file.name.replace(/\.html?$/i, ''));
        toast('HTML imported!');
    };
    reader.readAsText(file);
}

function loadContent(html, title) {
    if (title) document.getElementById('docTitle').value = title;
    while (State.pages.length > 1) {
        const last = State.pages.pop();
        last.el.remove();
    }
    const firstContent = State.pages[0].el.querySelector('.page-content');
    firstContent.innerHTML = html;
    wrapImagesForMovability(firstContent);
    updateWordCount();
    updatePageStat();
    scheduleSave();
}

/* ================================================
   SHARE / COLLAB
   ================================================ */
function openShareModal() {
    const base = location.origin + location.pathname;
    document.getElementById('shareLink').value = base + '?doc=' + State.docId + '&view=1';
    document.getElementById('collabLink').value = base + '?doc=' + State.docId;
    openModal('shareModal');
}

/* ================================================
   DROPDOWN PORTAL (fixed positioning to escape overflow clipping)
   ================================================ */
let _openDropdown = null;

function positionDropdownMenu(dd) {
    const btn = dd.querySelector('.ms-dropdown-btn');
    const menu = dd.querySelector('.ms-dropdown-menu');
    if (!btn || !menu) return;

    const rect = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuH = Math.min(320, vh * 0.6);

    // Position below button
    let top = rect.bottom + 4;
    let left = rect.left;

    // Flip up if not enough space below
    if (top + menuH > vh - 10) {
        top = rect.top - menuH - 4;
    }
    // Keep within viewport horizontally
    const menuW = Math.max(parseInt(menu.style.minWidth) || 160, 160);
    if (left + menuW > vw - 8) {
        left = vw - menuW - 8;
    }
    if (left < 8) left = 8;

    menu.style.position = 'fixed';
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    menu.style.zIndex = '99999';
}

function initDropdowns() {
    document.querySelectorAll('.ms-dropdown').forEach(dd => {
        const btn = dd.querySelector('.ms-dropdown-btn');
        if (!btn) return;
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const wasOpen = dd.classList.contains('open');
            closeAllDropdowns();
            if (!wasOpen) {
                dd.classList.add('open');
                _openDropdown = dd;
                positionDropdownMenu(dd);
            }
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
                p.el.querySelectorAll('.page-content').forEach(c => { c.style.lineHeight = State.lineSpacing; });
            });
            closeAllDropdowns();
            scheduleSave();
        });
    });

    // Page Size
    document.querySelectorAll('#pageSizeDropdown .ms-dropdown-item[data-value]').forEach(item => {
        item.addEventListener('click', () => {
            State.pageSize = item.dataset.value;
            document.querySelector('#pageSizeDropdown .dropdown-value').textContent = item.dataset.value.toUpperCase();
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

    // Font Color
    document.querySelectorAll('#fontColorDropdown .ms-dropdown-item[data-value]').forEach(item => {
        item.addEventListener('click', e => {
            e.stopPropagation();
            applyFontColor(item.dataset.value);
            const lbl = item.dataset.label || item.dataset.value;
            document.querySelector('#fontColorDropdown .dropdown-value').textContent = lbl.split(' ')[0] || 'Text';
            closeAllDropdowns();
        });
    });
    document.getElementById('fontColorCustom')?.addEventListener('input', e => applyFontColor(e.target.value));
    document.getElementById('fontColorCustom')?.addEventListener('change', () => closeAllDropdowns());

    // Highlight
    document.querySelectorAll('#highlightDropdown .ms-dropdown-item[data-hl]').forEach(item => {
        item.addEventListener('click', e => {
            e.stopPropagation();
            applyHighlight(item.dataset.value);
            closeAllDropdowns();
        });
    });
    document.getElementById('highlightCustom')?.addEventListener('input', e => applyHighlight(e.target.value));
    document.getElementById('highlightCustom')?.addEventListener('change', () => closeAllDropdowns());
}

function closeAllDropdowns() {
    document.querySelectorAll('.ms-dropdown.open').forEach(dd => dd.classList.remove('open'));
    _openDropdown = null;
}

function updateDropdownLabels() {
    document.querySelector('#pageSizeDropdown .dropdown-value').textContent = State.pageSize.toUpperCase();
    document.querySelector('#orientationDropdown .dropdown-value').textContent = State.orientation === 'portrait' ? 'Portrait' : 'Landscape';
    document.querySelector('#columnsDropdown .dropdown-value').textContent = State.columns === 1 ? '1 Column' : State.columns === 2 ? 'Two columns' : 'Three columns';
    document.querySelector('#lineSpacingDropdown .dropdown-value').textContent = State.lineSpacing;
    const zl = document.getElementById('zoomLabel');
    if (zl) zl.textContent = Math.round(State.zoom * 100) + '%';
}

/* ================================================
   TABLE GRID PICKER
   ================================================ */
function initTableGridPicker() {
    const grid = document.getElementById('tableGrid');
    if (!grid) return;
    const ROWS = 8, COLS = 10;
    grid.style.gridTemplateColumns = `repeat(${COLS}, 22px)`;
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
    const lbl = document.getElementById('tableGridLabel');
    if (lbl) lbl.textContent = `${rows} \u00d7 ${cols}`;
}

/* ================================================
   SPECIAL CHARACTERS
   ================================================ */
const SPECIAL_CHARS = [
    '\u00A9','\u00AE','\u2122','\u00A7','\u00B6','\u2020','\u2021',
    '\u2022','\u00B7','\u2026','\u2013','\u2014',
    '\u00AB','\u00BB','\u201C','\u201D','\u2018','\u2019','\u201E','\u201A',
    '\u00BD','\u00BC','\u00BE','\u2153','\u2154','\u215B','\u215C','\u215D','\u215E',
    '\u00B0','\u00B1','\u00D7','\u00F7','\u2260','\u2264','\u2265','\u2248','\u221E','\u221A','\u2211','\u220F',
    '\u03B1','\u03B2','\u03B3','\u03B4','\u03B5','\u03B8','\u03BB','\u03BC','\u03C0','\u03C3','\u03C4','\u03C6','\u03C9',
    '\u0391','\u0392','\u0393','\u0394','\u03A9',
    '\u2190','\u2192','\u2191','\u2193','\u2194','\u2195','\u21D2','\u21D0','\u21D1','\u21D3','\u21D4',
    '\u2660','\u2663','\u2665','\u2666','\u2605','\u2606','\u2713','\u2717','\u2714','\u2718',
    '\u20AC','\u00A3','\u00A5','\u00A2','$','\u20B9','\u20A9','\u20BF',
    '\u00A1','\u00BF','\u00F1','\u00FC','\u00F6','\u00E4','\u00E9','\u00E8','\u00EA','\u00E0','\u00E2','\u00EE','\u00F4','\u00FB',
    '\u2460','\u2461','\u2462','\u2463','\u2464','\u2465','\u2466','\u2467','\u2468','\u2469',
    '\u266A','\u266B','\u266C','\u266D','\u266E','\u266F',
    '\u2200','\u2203','\u2208','\u2209','\u2229','\u222A','\u2282','\u2283','\u2284','\u2286','\u2287',
    '\u2318','\u2303','\u2325','\u21E7','\u232B','\u2326','\u23CE','\u21E5',
    '\u00C6','\u00E6','\u00D8','\u00F8','\u00C5','\u00E5','\u00D0','\u00F0','\u00DE','\u00FE','\u00DF',
];

function initSpecialChars() {
    const grid = document.getElementById('specialCharGrid');
    if (!grid) return;
    SPECIAL_CHARS.forEach(ch => {
        const btn = document.createElement('button');
        btn.className = 'special-char-btn';
        btn.textContent = ch;
        btn.title = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0');
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
    // format-btn class (data-command)
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
            State.pages[idx].el.remove();
            State.pages.splice(idx, 1);
            State.currentPage = Math.max(0, idx - 1);
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

    // Insert Table
    document.getElementById('insertTableBtn')?.addEventListener('click', () => openModal('tableModal'));
    document.getElementById('insertTableConfirm')?.addEventListener('click', () => {
        const rows = parseInt(document.getElementById('tableRows').value, 10) || 3;
        const cols = parseInt(document.getElementById('tableCols').value, 10) || 3;
        closeModal('tableModal');
        insertTable(rows, cols);
    });

    // Insert Image
    document.getElementById('insertImageBtn')?.addEventListener('click', () => {
        document.getElementById('insertImageInput').click();
    });
    document.getElementById('insertImageInput')?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            ensureEditorFocused();
            execCmd('insertHTML', `<img src="${ev.target.result}" alt="${file.name}" style="max-width:100%;cursor:move;" draggable="true">`);
            toast('Image inserted — drag to move');
            const content = getFocusedContent();
            if (content) wrapImagesForMovability(content);
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    // Draw
    document.getElementById('insertDrawBtn')?.addEventListener('click', toggleDrawMode);
    document.getElementById('drawExitBtn')?.addEventListener('click', () => exitDrawMode());
    document.getElementById('drawClearBtn')?.addEventListener('click', clearCurrentDrawCanvas);
    document.getElementById('drawEraserBtn')?.addEventListener('click', () => {
        State.drawEraser = !State.drawEraser;
        document.getElementById('drawEraserBtn').classList.toggle('active', State.drawEraser);
    });
    document.getElementById('drawColor')?.addEventListener('input', e => { State.drawColor = e.target.value; });
    document.getElementById('drawSize')?.addEventListener('input', e => { State.drawSize = parseInt(e.target.value, 10); });

    // Insert Link
    document.getElementById('insertLinkBtn')?.addEventListener('click', () => {
        const sel = window.getSelection();
        document.getElementById('linkText').value = sel ? sel.toString() : '';
        document.getElementById('linkUrl').value = '';
        openModal('linkModal');
    });
    document.getElementById('insertLinkConfirm')?.addEventListener('click', () => {
        const text = document.getElementById('linkText').value;
        const url = document.getElementById('linkUrl').value;
        if (!url) { toast('Enter a URL'); return; }
        closeModal('linkModal');
        insertLink(text, url);
    });

    document.getElementById('insertHrBtn')?.addEventListener('click', insertHr);
    document.getElementById('insertPageBreakBtn')?.addEventListener('click', insertPageBreak);
    document.getElementById('insertPageNumBtn')?.addEventListener('click', insertPageNumber);
    document.getElementById('insertSpecialCharBtn')?.addEventListener('click', () => openModal('specialCharModal'));

    // Header/Footer
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

    // Layout: Margins
    document.getElementById('marginsBtn')?.addEventListener('click', () => openModal('marginsModal'));
    document.querySelectorAll('.margin-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.margin-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const preset = btn.dataset.preset;
            const cf = document.getElementById('marginCustomFields');
            if (preset === 'custom') {
                cf.classList.add('visible');
            } else {
                cf.classList.remove('visible');
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
        State.margins = {
            top:    parseFloat(document.getElementById('marginTop').value) * 96,
            right:  parseFloat(document.getElementById('marginRight').value) * 96,
            bottom: parseFloat(document.getElementById('marginBottom').value) * 96,
            left:   parseFloat(document.getElementById('marginLeft').value) * 96,
        };
        closeModal('marginsModal');
        applyPageDimensions();
        scheduleSave();
        toast('Margins applied');
    });

    // Zoom
    document.getElementById('zoomInBtn')?.addEventListener('click', () => {
        State.zoom = Math.min(2, parseFloat((State.zoom + 0.1).toFixed(2)));
        applyZoom(); scheduleSave();
    });
    document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
        State.zoom = Math.max(0.3, parseFloat((State.zoom - 0.1).toFixed(2)));
        applyZoom(); scheduleSave();
    });

    // Export / Import
    document.getElementById('exportPdfBtn')?.addEventListener('click', exportPDF);
    document.getElementById('exportDocxBtn')?.addEventListener('click', exportDOCX);
    document.getElementById('importBtn')?.addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile')?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) importFile(file);
        e.target.value = '';
    });

    // Share
    document.getElementById('shareBtn')?.addEventListener('click', openShareModal);
    document.getElementById('copyShareLink')?.addEventListener('click', () => {
        navigator.clipboard.writeText(document.getElementById('shareLink').value)
            .then(() => toast('Share link copied!')).catch(() => toast('Copy failed'));
    });
    document.getElementById('copyCollabLink')?.addEventListener('click', () => {
        navigator.clipboard.writeText(document.getElementById('collabLink').value)
            .then(() => toast('Collaboration link copied!')).catch(() => toast('Copy failed'));
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
    document.querySelectorAll('.doc-modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.classList.remove('open');
        });
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.doc-modal-overlay.open').forEach(o => o.classList.remove('open'));
            closeAllDropdowns();
        }
    });
}

/* ================================================
   TABLE TOOLBAR
   ================================================ */
let tableToolbarCell = null;

function initTableToolbar() {
    const toolbar = document.getElementById('tableToolbar');
    if (!toolbar) return;

    document.addEventListener('click', e => {
        const cell = e.target.closest('td, th');
        if (!cell || State.drawMode) {
            toolbar.style.display = 'none';
            tableToolbarCell = null;
            return;
        }
        const rect = cell.getBoundingClientRect();
        toolbar.style.display = 'flex';
        toolbar.style.top = (rect.bottom + 6) + 'px';
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
                const newRow = document.createElement('tr');
                for (let i = 0; i < row.cells.length; i++) {
                    const td = document.createElement('td');
                    td.style.cssText = 'border:1px solid #bbb;padding:6px 10px;min-width:80px;';
                    td.contentEditable = 'true';
                    td.innerHTML = '<br>';
                    newRow.appendChild(td);
                }
                row.parentNode.insertBefore(newRow, row);
            } else if (cmd === 'addRowBelow') {
                const newRow = document.createElement('tr');
                for (let i = 0; i < row.cells.length; i++) {
                    const td = document.createElement('td');
                    td.style.cssText = 'border:1px solid #bbb;padding:6px 10px;min-width:80px;';
                    td.contentEditable = 'true';
                    td.innerHTML = '<br>';
                    newRow.appendChild(td);
                }
                row.parentNode.insertBefore(newRow, row.nextSibling);
            } else if (cmd === 'deleteRow') {
                if (table.rows.length > 1) row.remove();
                else toast('Cannot delete only row');
                toolbar.style.display = 'none';
            } else if (cmd === 'addColLeft') {
                Array.from(table.rows).forEach((r, ri) => {
                    const td = document.createElement(ri === 0 ? 'th' : 'td');
                    td.style.cssText = 'border:1px solid #bbb;padding:6px 10px;min-width:80px;';
                    if (ri === 0) td.style.background = '#f4f4f4';
                    td.contentEditable = 'true';
                    td.innerHTML = '<br>';
                    r.insertBefore(td, r.cells[cellIdx]);
                });
            } else if (cmd === 'addColRight') {
                Array.from(table.rows).forEach((r, ri) => {
                    const td = document.createElement(ri === 0 ? 'th' : 'td');
                    td.style.cssText = 'border:1px solid #bbb;padding:6px 10px;min-width:80px;';
                    td.contentEditable = 'true';
                    td.innerHTML = '<br>';
                    const ref = r.cells[cellIdx + 1];
                    ref ? r.insertBefore(td, ref) : r.appendChild(td);
                });
            } else if (cmd === 'deleteCol') {
                if (table.rows[0].cells.length > 1) {
                    Array.from(table.rows).forEach(r => { if (r.cells[cellIdx]) r.cells[cellIdx].remove(); });
                } else toast('Cannot delete only column');
                toolbar.style.display = 'none';
            } else if (cmd === 'mergeCells') {
                toast('Select multiple cells to merge (coming soon)', 2000);
            } else if (cmd === 'setBorder') {
                const borderVal = prompt('Border style (e.g. "1px solid #000" or "none"):', '1px solid #bbb');
                if (borderVal !== null) {
                    tableToolbarCell.style.border = borderVal;
                }
            }
            scheduleSave();
        });
    });
}

/* ================================================
   DRAW MODE
   ================================================ */
let _drawCanvas = null;
let _drawCtx = null;
let _isDrawing = false;
let _lastX = 0, _lastY = 0;

function toggleDrawMode() {
    if (State.drawMode) exitDrawMode();
    else enterDrawMode();
}

function enterDrawMode() {
    State.drawMode = true;
    const toolbar = document.getElementById('drawToolbar');
    if (toolbar) toolbar.style.display = 'flex';
    document.getElementById('insertDrawBtn')?.classList.add('active');

    // Activate canvas on the currently focused page
    const pageIdx = State.currentPage;
    const pageEl = State.pages[pageIdx]?.el;
    if (!pageEl) return;
    activateDrawCanvas(pageEl);
    toast('Draw mode on. Draw on the page. Exit when done.');
}

function exitDrawMode() {
    State.drawMode = false;
    const toolbar = document.getElementById('drawToolbar');
    if (toolbar) toolbar.style.display = 'none';
    document.getElementById('insertDrawBtn')?.classList.remove('active');

    // Deactivate all canvases
    document.querySelectorAll('.draw-canvas.active').forEach(c => {
        c.classList.remove('active');
    });
    _drawCanvas = null;
    _drawCtx = null;
    toast('Draw mode off');
}

function activateDrawCanvas(pageEl) {
    if (_drawCanvas) _drawCanvas.classList.remove('active');
    _drawCanvas = pageEl.querySelector('.draw-canvas');
    if (!_drawCanvas) return;
    _drawCanvas.classList.add('active');
    _drawCtx = _drawCanvas.getContext('2d');
    setupDrawEvents(_drawCanvas);
}

function clearCurrentDrawCanvas() {
    if (!_drawCtx || !_drawCanvas) return;
    _drawCtx.clearRect(0, 0, _drawCanvas.width, _drawCanvas.height);
    toast('Drawing cleared');
}

function setupDrawEvents(canvas) {
    if (canvas._drawBound) return;
    canvas._drawBound = true;

    function getPos(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const cx = (e.touches ? e.touches[0].clientX : e.clientX);
        const cy = (e.touches ? e.touches[0].clientY : e.clientY);
        return { x: (cx - rect.left) * scaleX, y: (cy - rect.top) * scaleY };
    }

    canvas.addEventListener('mousedown', e => {
        if (!State.drawMode) return;
        _isDrawing = true;
        const pos = getPos(e);
        _lastX = pos.x; _lastY = pos.y;
        e.preventDefault();
    });
    canvas.addEventListener('mousemove', e => {
        if (!_isDrawing || !State.drawMode) return;
        const pos = getPos(e);
        draw(pos.x, pos.y);
        e.preventDefault();
    });
    canvas.addEventListener('mouseup', () => { _isDrawing = false; scheduleSave(); });
    canvas.addEventListener('mouseleave', () => { _isDrawing = false; });

    canvas.addEventListener('touchstart', e => {
        if (!State.drawMode) return;
        _isDrawing = true;
        const pos = getPos(e);
        _lastX = pos.x; _lastY = pos.y;
        e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
        if (!_isDrawing || !State.drawMode) return;
        const pos = getPos(e);
        draw(pos.x, pos.y);
        e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', () => { _isDrawing = false; scheduleSave(); });
}

function draw(x, y) {
    if (!_drawCtx) return;
    _drawCtx.beginPath();
    _drawCtx.moveTo(_lastX, _lastY);
    _drawCtx.lineTo(x, y);
    if (State.drawEraser) {
        _drawCtx.globalCompositeOperation = 'destination-out';
        _drawCtx.strokeStyle = 'rgba(0,0,0,1)';
        _drawCtx.lineWidth = State.drawSize * 3;
    } else {
        _drawCtx.globalCompositeOperation = 'source-over';
        _drawCtx.strokeStyle = State.drawColor;
        _drawCtx.lineWidth = State.drawSize;
    }
    _drawCtx.lineCap = 'round';
    _drawCtx.lineJoin = 'round';
    _drawCtx.stroke();
    _lastX = x;
    _lastY = y;
}

/* ================================================
   MOVABLE IMAGES
   ================================================ */
function wrapImagesForMovability(container) {
    container.querySelectorAll('img:not([data-wrapped])').forEach(img => {
        img.setAttribute('data-wrapped', '1');
        img.setAttribute('draggable', 'false');
        img.style.cursor = 'move';
        img.style.maxWidth = img.style.maxWidth || '100%';
        img.style.userSelect = 'none';

        // Resize handle via corner drag
        let startW, startH, startX;
        const onMouseDown = e => {
            if (!e.target.classList.contains('img-resize-handle')) return;
            e.preventDefault();
            startW = img.offsetWidth;
            startH = img.offsetHeight;
            startX = e.clientX;
            const onMove = ev => {
                const dx = ev.clientX - startX;
                const newW = Math.max(40, startW + dx);
                img.style.width = newW + 'px';
                img.style.height = 'auto';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                scheduleSave();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        img.addEventListener('mousedown', e => {
            if (State.drawMode) return;
            e.stopPropagation();
        });
        img.addEventListener('click', e => {
            if (State.drawMode) return;
            document.querySelectorAll('img.img-selected').forEach(i => i.classList.remove('img-selected'));
            img.classList.add('img-selected');
            e.stopPropagation();
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
        if (key === 'd') { e.preventDefault(); toggleDrawMode(); }
        if (key === '=' && e.shiftKey) { e.preventDefault(); execCmd('superscript'); }
        if (key === ',' ) { e.preventDefault(); execCmd('subscript'); }
    });

    // Deselect images on doc click
    document.addEventListener('click', e => {
        if (!e.target.closest('img')) {
            document.querySelectorAll('img.img-selected').forEach(i => i.classList.remove('img-selected'));
        }
        if (!e.target.closest('.ms-dropdown')) closeAllDropdowns();
        if (!e.target.closest('#tableToolbar') && !e.target.closest('td') && !e.target.closest('th')) {
            const toolbar = document.getElementById('tableToolbar');
            if (toolbar) toolbar.style.display = 'none';
        }
    });
}

/* ================================================
   DRAG & DROP (images & documents onto workspace)
   ================================================ */
function initDragDrop() {
    const pc = document.getElementById('pagesContainer');
    if (!pc) return;
    pc.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    pc.addEventListener('drop', e => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        const imgFiles = files.filter(f => f.type.startsWith('image/'));
        if (imgFiles.length) {
            imgFiles.forEach(file => {
                const reader = new FileReader();
                reader.onload = ev => {
                    ensureEditorFocused();
                    execCmd('insertHTML', `<img src="${ev.target.result}" alt="${file.name}" style="max-width:100%;cursor:move;" draggable="false">`);
                    const content = getFocusedContent();
                    if (content) wrapImagesForMovability(content);
                };
                reader.readAsDataURL(file);
            });
        } else if (files[0]) {
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
   INIT
   ================================================ */
function init() {
    State.docId = getDocId();

    // Auto-fit zoom
    const vw = window.innerWidth;
    const pageW = PAGE_SIZES['a4'].w;
    const fittedZoom = Math.min(1, (vw - 120) / pageW);
    State.zoom = parseFloat(Math.max(0.5, fittedZoom).toFixed(2));

    // Create first page
    const firstPageEl = createPage(0);
    document.getElementById('pagesContainer').appendChild(firstPageEl);
    State.pages.push({ el: firstPageEl, idx: 0 });

    // Load saved doc or fresh start
    const loaded = loadDoc();
    if (!loaded) {
        firstPageEl.querySelector('.page-content').focus();
    }

    applyPageDimensions();
    applyZoom();
    updateAllHeadersFooters();
    updateWordCount();
    updatePageStat();

    // Init all subsystems
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
    setInterval(() => { if (State.isDirty) saveDoc(); }, 30000);

    console.log('EmeraldNetwork Document Editor initialized');
}

document.addEventListener('DOMContentLoaded', init);
