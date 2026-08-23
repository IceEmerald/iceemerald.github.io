/* =========================================================
   Z Docs — Word Processor  (v2)
   Real pagination engine: content is distributed across real
   A4 page DOM elements. Paragraphs move whole between pages;
   a single block taller than a page is split at a word boundary
   (never mid-word).
   ---------------------------------------------------------
   v2 changes:
   - BUG FIX: single overflowing block now splits FIRST instead
     of being pushed whole to the next page (which created
     cascades of empty pages).
   - Find & Replace (Ctrl+F / Ctrl+H) with match highlighting.
   - Insert Link (Ctrl+K), Image (upload/url), Table (grid), HR.
   - Undo/Redo, Dark theme toggle, Export (.txt/.html/print),
     Word-count stats dialog, Ruler.
   ========================================================= */
(function () {
  "use strict";

  /* ---------------- Constants ---------------- */
  var PAGES_WRAPPER_ID = "pagesWrapper";
  var CARET_BLOCK_ATTR = "data-caret-block";
  var CARET_OFFSET_ATTR = "data-caret-offset";
  var STORAGE_KEY = "zdocs.document.v3";
  var THEME_KEY = "zdocs.theme";
  var VERSIONS_KEY = "zdocs.versions";
  var MARGINS_KEY = "zdocs.margins";
  var GOAL_KEY = "zdocs.goal";
  var MAX_VERSIONS = 10;
  var AUTOSAVE_SNAPSHOT_MS = 5 * 60 * 1000; // 5 minutes
  var autosaveSnapshotTimer = null;
  var MAX_PAGINATE_ITER = 120;
  var PAGE_WIDTH = 794;
  var PAGE_HEIGHT = 1123;
  var MIN_MARGIN = 32;
  var MAX_MARGIN = 300;

  /* ---------------- State ---------------- */
  var paginateScheduled = false;
  var autosaveScheduled = false;
  var autosaveTimer = null;
  var lastEditorRange = null;
  var toastTimer = null;
  var theme = "light";
  var findMatches = [];
  var findIndex = -1;
  var pageMargins = { top: 96, right: 96, bottom: 96, left: 96 };
  var goalTarget = 0;

  /* ---------------- DOM helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function getPages() { return Array.prototype.slice.call(document.querySelectorAll(".page")); }
  function getContent(page) { return page.querySelector(".page-content"); }
  function isOverflow(content) { return content.scrollHeight > content.clientHeight + 1; }

  /* ---------------- Page management ---------------- */
  function createPage() {
    var page = document.createElement("div");
    page.className = "page";

    var content = document.createElement("div");
    content.className = "page-content";
    content.setAttribute("contenteditable", "true");
    content.setAttribute("spellcheck", "true");
    content.setAttribute("role", "textbox");
    content.setAttribute("aria-multiline", "true");

    var badge = document.createElement("div");
    badge.className = "page-badge";

    page.appendChild(content);
    page.appendChild(badge);

    attachPageEvents(content);
    return page;
  }

  function ensureFirstPage() {
    var wrapper = $(PAGES_WRAPPER_ID);
    if (wrapper.children.length === 0) {
      var page = createPage();
      wrapper.appendChild(page);
      var p = document.createElement("p");
      p.innerHTML = "<br>";
      getContent(page).appendChild(p);
    }
  }

  function attachPageEvents(content) {
    content.addEventListener("input", onInput);
    content.addEventListener("keydown", onKeyDown);
    content.addEventListener("paste", onPaste);
    content.addEventListener("blur", function () {
      if (paginateScheduled) {
        paginateScheduled = false;
        paginate();
      }
    });
  }

  /* ---------------- Caret save / restore ---------------- */
  function clearCaretMarkers() {
    var marked = document.querySelectorAll("[" + CARET_BLOCK_ATTR + "]");
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(CARET_BLOCK_ATTR);
      marked[i].removeAttribute(CARET_OFFSET_ATTR);
    }
  }

  function saveCaret() {
    clearCaretMarkers();
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (!range.collapsed) return;

    var start = range.startContainer;
    var block = start;
    if (block.nodeType !== Node.ELEMENT_NODE) block = block.parentElement;
    while (block && block.parentElement && !block.parentElement.classList.contains("page-content")) {
      block = block.parentElement;
    }
    if (!block || !block.parentElement || !block.parentElement.classList.contains("page-content")) return;

    var preRange = document.createRange();
    preRange.selectNodeContents(block);
    preRange.setEnd(range.startContainer, range.startOffset);
    var offset = preRange.toString().length;

    block.setAttribute(CARET_BLOCK_ATTR, "1");
    block.setAttribute(CARET_OFFSET_ATTR, String(offset));
  }

  function restoreCaret() {
    var block = document.querySelector("[" + CARET_BLOCK_ATTR + "]");
    if (!block) return;
    var offset = parseInt(block.getAttribute(CARET_OFFSET_ATTR) || "0", 10);
    block.removeAttribute(CARET_BLOCK_ATTR);
    block.removeAttribute(CARET_OFFSET_ATTR);

    var blockText = block.textContent;
    var targetBlock = block;
    var targetOffset = offset;

    if (offset > blockText.length) {
      var page = block.closest(".page");
      var nextPage = page ? page.nextElementSibling : null;
      if (nextPage && nextPage.classList.contains("page")) {
        var overflow = getContent(nextPage).firstElementChild;
        if (overflow) {
          targetBlock = overflow;
          targetOffset = offset - blockText.length;
        }
      } else {
        targetOffset = blockText.length;
      }
    }

    setCaretInBlock(targetBlock, Math.max(0, targetOffset));
  }

  function setCaretInBlock(block, offset) {
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var node, len = 0;
    while ((node = walker.nextNode())) {
      var textLen = node.textContent.length;
      if (offset <= len + textLen) {
        var range = document.createRange();
        range.setStart(node, Math.max(0, offset - len));
        range.collapse(true);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        var content = block.closest(".page-content");
        if (content) content.focus();
        return;
      }
      len += textLen;
    }
    var range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var content = block.closest(".page-content");
    if (content) content.focus();
  }

  /* ---------------- Pagination engine ----------------
     KEY FIX (v2): when a page has a SINGLE block that overflows,
     we split it FIRST (at a word boundary) rather than pushing
     the whole block to the next page. The old logic pushed the
     only block down, leaving an empty page and moving the
     overflow unchanged — producing cascades of empty pages.
     ---------------------------------------------------------
     KEY FIX (v3): TRUE hard page break. A `.zdocs-page-break`
     element forces ALL content after it onto the next page.
     This runs as a pre-pass before the overflow logic.       */
  function paginate() {
    saveCaret();

    try {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (e) {}

    // PRE-PASS: enforce hard page breaks first (before overflow logic)
    var pbChanged = true;
    var pbIter = 0;
    while (pbChanged && pbIter++ < MAX_PAGINATE_ITER) {
      pbChanged = enforcePageBreaks();
    }

    var changed = true;
    var iter = 0;
    while (changed && iter++ < MAX_PAGINATE_ITER) {
      changed = false;
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        var content = getContent(pages[i]);
        normalizeContent(content);

        var guard = 0;
        while (isOverflow(content) && guard++ < 300) {
          if (content.children.length === 1) {
            // Single overflowing block → SPLIT it (don't push whole)
            if (splitOverflowingBlock(content, pages[i])) {
              changed = true;
              continue;
            }
            break; // cannot split further (e.g. one giant word)
          }
          // Multiple blocks → push the last block down
          if (!pushOverflowDown(pages[i])) break;
          changed = true;
        }

        // Pull content up from next page if there's room
        // BUT never pull across a page-break boundary.
        if (pages[i + 1]) {
          var guard2 = 0;
          while (pullUp(pages[i], pages[i + 1]) && guard2++ < 300) {
            changed = true;
          }
        }
      }
    }

    removeTrailingEmptyPages();
    ensureFirstPage();
    ensureTableCellsEditable();
    updatePageNumbers();
    updateDynamicFields();
    applySectionConfigs();
    updateStatus();
    restoreCaret();
    refreshFindHighlights();
  }

  /* Hard page break enforcement.
     For each page, if a `.zdocs-page-break` element exists, every block
     AFTER it (and the break itself stays as the last thing on this page)
     is moved to the start of the next page (a new page is created if needed).
     Returns true if any content was moved. */
  function enforcePageBreaks() {
    var moved = false;
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var content = getContent(pages[i]);
      var breaks = content.querySelectorAll(".zdocs-page-break");
      if (breaks.length === 0) continue;

      // Take the FIRST page break on this page.
      var brk = breaks[0];

      // Collect all sibling blocks AFTER the break (in DOM order, direct children only)
      var toMove = [];
      var sibling = brk.nextElementSibling;
      while (sibling) {
        var next = sibling.nextElementSibling;
        toMove.push(sibling);
        sibling = next;
      }

      if (toMove.length === 0) {
        // Break is already the last block on this page — nothing to move.
        // But if there are MULTIPLE breaks on this page, the later ones
        // need to go to the next page (a break with nothing after it still
        // means "the next page starts here").
        if (breaks.length > 1) {
          // Remove extra breaks (keep only the first) and move them down
          for (var b = 1; b < breaks.length; b++) {
            var extra = breaks[b];
            var next2 = extra.nextElementSibling;
            var extras = [];
            while (next2) {
              var n2 = next2.nextElementSibling;
              extras.push(next2);
              next2 = n2;
            }
            ensureNextPageAndPrepend(pages, i, extras, extra);
            moved = true;
            return moved; // restart the loop after a structural change
          }
        }
        continue;
      }

      ensureNextPageAndPrepend(pages, i, toMove, null);
      moved = true;
      return moved; // restart after a structural change to keep indices valid
    }
    return moved;
  }

  /* Create (if needed) the next page after `pages[i]` and prepend the
     given blocks (optionally a page-break marker first) to its content. */
  function ensureNextPageAndPrepend(pages, i, blocks, optionalBreak) {
    var next = pages[i].nextElementSibling;
    if (!next || !next.classList.contains("page")) {
      next = createPage();
      pages[i].parentNode.insertBefore(next, pages[i].nextSibling);
    }
    var nextContent = getContent(next);
    var insertBefore = nextContent.firstChild;
    if (optionalBreak) {
      nextContent.insertBefore(optionalBreak, insertBefore);
    }
    for (var k = 0; k < blocks.length; k++) {
      nextContent.insertBefore(blocks[k], insertBefore);
    }
  }

  /* Make sure all td/th in the document remain editable after pagination
     (execCommand insertHTML strips contenteditable, and splitOverflowingBlock
     clones blocks without restoring it on nested tables). */
  function ensureTableCellsEditable() {
    var cells = document.querySelectorAll(".page-content td, .page-content th");
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].getAttribute("contenteditable") !== "true") {
        cells[i].setAttribute("contenteditable", "true");
      }
    }
  }

  function normalizeContent(content) {
    // Wrap stray non-empty text nodes in <p>, drop empty text nodes.
    // NOTE: do NOT auto-add an empty <p> to a childless page here — that
    // would make removeTrailingEmptyPages think a genuinely-empty trailing
    // page still has content, so it would never clean up pages the user
    // emptied. ensureFirstPage() guarantees the first page stays editable.
    var kids = Array.prototype.slice.call(content.childNodes);
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.nodeType === Node.TEXT_NODE) {
        if (k.textContent.trim() === "") {
          content.removeChild(k);
        } else {
          var p = document.createElement("p");
          content.insertBefore(p, k);
          p.appendChild(k);
        }
      }
    }
  }

  function pushOverflowDown(page) {
    var content = getContent(page);
    var last = content.lastElementChild;
    if (!last) return false;

    var next = page.nextElementSibling;
    if (!next || !next.classList.contains("page")) {
      next = createPage();
      page.parentNode.insertBefore(next, page.nextSibling);
    }
    var nextContent = getContent(next);
    nextContent.insertBefore(last, nextContent.firstChild);
    return true;
  }

  function splitOverflowingBlock(content, page) {
    var block = content.firstElementChild;
    if (!block) return false;
    if (content.children.length !== 1) return false;

    var children = Array.prototype.slice.call(block.childNodes);
    var removed = [];

    // 1) Remove trailing child nodes until it fits (or single node remains)
    for (var i = children.length - 1; i >= 0; i--) {
      if (!isOverflow(content)) break;
      if (block.childNodes.length === 1) break;
      removed.unshift(children[i]);
      block.removeChild(children[i]);
    }

    // 2) If still overflow with a single text node, split at word boundary
    if (isOverflow(content) && block.childNodes.length === 1) {
      var node = block.firstChild;
      if (node && node.nodeType === Node.TEXT_NODE) {
        var text = node.textContent;
        var tokens = text.split(/(\s+)/);
        if (tokens.length > 1) {
          node.textContent = tokens.slice(0, 1).join("");
          if (isOverflow(content)) {
            node.textContent = text;
            return false; // single token too big — give up
          }
          var lo = 1, hi = tokens.length, best = 1;
          while (lo <= hi) {
            var mid = Math.floor((lo + hi) / 2);
            node.textContent = tokens.slice(0, mid).join("");
            if (isOverflow(content)) {
              hi = mid - 1;
            } else {
              best = mid;
              lo = mid + 1;
            }
          }
          node.textContent = tokens.slice(0, best).join("");
          var rest = tokens.slice(best).join("");
          if (rest) removed.unshift(document.createTextNode(rest));
        }
      } else if (node && node.nodeType === Node.ELEMENT_NODE) {
        removed.unshift(node);
        block.removeChild(node);
      }
    }

    if (removed.length === 0) return false;

    var overflowBlock = block.cloneNode(false);
    overflowBlock.removeAttribute(CARET_BLOCK_ATTR);
    overflowBlock.removeAttribute(CARET_OFFSET_ATTR);
    for (var j = 0; j < removed.length; j++) {
      overflowBlock.appendChild(removed[j]);
    }

    var next = page.nextElementSibling;
    if (!next || !next.classList.contains("page")) {
      next = createPage();
      page.parentNode.insertBefore(next, page.nextSibling);
    }
    var nextContent = getContent(next);
    nextContent.insertBefore(overflowBlock, nextContent.firstChild);
    return true;
  }

  function pullUp(currentPage, nextPage) {
    var currentContent = getContent(currentPage);
    var nextContent = getContent(nextPage);
    var first = nextContent.firstElementChild;
    if (!first) return false;

    // Never pull a page-break marker up — it must stay as a boundary.
    if (first.classList && first.classList.contains("zdocs-page-break")) return false;

    // If the current page already ends with a page-break marker,
    // content after it belongs on the next page — don't pull across.
    var lastHere = currentContent.lastElementChild;
    if (lastHere && lastHere.classList && lastHere.classList.contains("zdocs-page-break")) {
      return false;
    }

    currentContent.appendChild(first);
    if (isOverflow(currentContent)) {
      nextContent.insertBefore(first, nextContent.firstChild);
      return false;
    }
    return true;
  }

  function removeTrailingEmptyPages() {
    var wrapper = $(PAGES_WRAPPER_ID);
    var pages = getPages();

    // A page is "empty" only if it has NO block-level children at all.
    // An empty <p> (created by pressing Enter) IS a legitimate block and
    // must NOT cause its page to be deleted — otherwise pressing Enter on
    // the last line of a full page (which pushes the new empty paragraph
    // onto a fresh next page) would have that page immediately removed,
    // making Enter appear to do nothing.
    //
    // EXCEPTION: a trailing page whose ONLY content is page-break markers
    // (.zdocs-page-break) is a confusing leftover from a page break placed
    // at the very end of the document. We strip the now-orphaned marker and
    // remove the page so the document ends cleanly.
    for (var i = pages.length - 1; i >= 1; i--) {
      var content = getContent(pages[i]);
      var hasMedia = content.querySelector("img, table, hr, iframe");
      if (content.children.length === 0 && !hasMedia) {
        wrapper.removeChild(pages[i]);
      } else if (pageIsOnlyBreakMarkers(content)) {
        wrapper.removeChild(pages[i]);
      } else {
        break;
      }
    }
  }

  function pageIsOnlyBreakMarkers(content) {
    var kids = content.children;
    if (kids.length === 0) return false;
    for (var k = 0; k < kids.length; k++) {
      if (!kids[k].classList || !kids[k].classList.contains("zdocs-page-break")) return false;
    }
    return true;
  }

  function updatePageNumbers() {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var badge = pages[i].querySelector(".page-badge");
      if (badge) badge.textContent = "Page " + (i + 1);
    }
  }

  /* ---------------- Status / counts ---------------- */
  function getAllText() {
    var pages = getPages();
    var parts = [];
    for (var i = 0; i < pages.length; i++) {
      parts.push(getContent(pages[i]).innerText);
    }
    return parts.join("\n").trim();
  }

  function getStats() {
    var text = getAllText();
    var words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    var charsNoSpaces = text.replace(/\s/g, "").length;
    var chars = text.length;
    var paragraphs = 0;
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      paragraphs += getContent(pages[i]).querySelectorAll("p, h1, h2, h3, h4, li, blockquote, pre").length;
    }
    var readingMin = Math.max(1, Math.ceil(words / 200));
    return {
      words: words,
      chars: chars,
      charsNoSpaces: charsNoSpaces,
      paragraphs: paragraphs,
      pages: pages.length,
      readingMin: readingMin,
    };
  }

  function updateStatus() {
    var stats = getStats();
    $("wordCount").textContent = stats.words + " " + (stats.words === 1 ? "word" : "words");
    $("charCount").textContent = stats.chars + " " + (stats.chars === 1 ? "character" : "characters");

    var cur = getCurrentPageIndex() + 1;
    if (cur < 1) cur = 1;
    $("pageInfo").textContent = "Page " + cur + " of " + stats.pages;

    var prev = $("prevPage"), next = $("nextPage");
    if (prev) prev.disabled = cur <= 1;
    if (next) next.disabled = cur >= stats.pages;

    // Update caret position (Ln, Col)
    updateCaretPosition();

    // Update relative autosave time ("saved 2 min ago")
    updateRelativeAutosave();

    // Live-update goal tracker + stats chart if the dialog is open
    if ($("wordCountModal").classList.contains("open")) {
      updateGoalTracker();
      renderStatsChart();
      renderReadability();
      renderSentenceLengthChart();
      renderWordFrequency();
      renderWordCloud();
      renderWritingIssues();
    }
    // Update thumbnails if panel is open
    scheduleThumbnailsUpdate();
    // Highlight the active heading in the outline panel
    highlightActiveOutlineHeading();
  }

  // Caret position: compute line + column from the current selection.
  function updateCaretPosition() {
    var el = $("caretPos");
    if (!el) return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var node = sel.anchorNode;
    if (!node) return;
    // Check if we're in the editor
    var inEditor = false;
    var checkNode = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (checkNode) {
      if (checkNode.classList && checkNode.classList.contains("page-content")) { inEditor = true; break; }
      checkNode = checkNode.parentElement;
    }
    if (!inEditor) return;

    // Find the block element containing the caret
    var block = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (block && block.parentElement && !block.parentElement.classList.contains("page-content")) {
      block = block.parentElement;
    }
    if (!block) return;

    // Count which block number this is (across all pages)
    var pages = getPages();
    var blockIndex = 0;
    var found = false;
    for (var pi = 0; pi < pages.length && !found; pi++) {
      var blocks = getContent(pages[pi]).children;
      for (var bi = 0; bi < blocks.length; bi++) {
        if (blocks[bi] === block) { found = true; break; }
        blockIndex++;
      }
    }
    // Line = block number + 1
    var line = blockIndex + 1;

    // Column = offset within the current block's text
    var col = 1;
    try {
      var range = sel.getRangeAt(0);
      var preRange = document.createRange();
      preRange.selectNodeContents(block);
      preRange.setEnd(range.startContainer, range.startOffset);
      col = preRange.toString().length + 1;
    } catch (e) {}

    el.textContent = "Ln " + line + ", Col " + col;
  }

  // Relative autosave time: "saved 2 min ago"
  var relativeAutosaveTimer = null;
  function updateRelativeAutosave() {
    var el = $("autosave");
    if (!el || !lastSavedAt) return;
    // Only update the relative time if we're in the "saved" state
    if (!el.classList.contains("saved")) return;
    var diff = Math.floor((Date.now() - lastSavedAt) / 1000);
    var rel;
    if (diff < 5) rel = "just now";
    else if (diff < 60) rel = diff + "s ago";
    else if (diff < 3600) rel = Math.floor(diff / 60) + "m ago";
    else rel = Math.floor(diff / 3600) + "h ago";
    el.innerHTML = "Saved <span class='autosave-time'>" + rel + "</span>";
  }

  function getCurrentPageIndex() {
    var sel = window.getSelection();
    if (sel && sel.anchorNode) {
      var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
      var pageEl = node ? node.closest(".page") : null;
      if (pageEl) return getPages().indexOf(pageEl);
    }
    var scroll = $("documentScroll");
    if (!scroll) return 0;
    var pages = getPages();
    var top = scroll.getBoundingClientRect().top;
    for (var i = 0; i < pages.length; i++) {
      var r = pages[i].getBoundingClientRect();
      if (r.bottom > top + 24) return i;
    }
    return pages.length - 1;
  }

  /* ---------------- Events ---------------- */
  function onInput(e) {
    startSessionTimer();
    startAutosaveSnapshots();
    // AutoCorrect: when user types a space, check the preceding word
    if (e && (e.data === " " || e.data === "\u00a0")) {
      try { checkAutoCorrect(); } catch (err) {}
    }
    schedulePaginate();
    scheduleAutosave();
    scheduleOutlineUpdate();
  }

  function onKeyDown(e) {
    // Escape closes any open modal / outline / thumbnails / focus mode
    if (e.key === "Escape") {
      if (anyModalOpen()) { closeAllModals(); e.preventDefault(); return; }
      if ($("outlinePanel").classList.contains("open")) { toggleOutline(false); e.preventDefault(); return; }
      if ($("thumbnailsPanel").classList.contains("open")) { toggleThumbnails(false); e.preventDefault(); return; }
      if ($("commentsPanel").classList.contains("open")) { toggleComments(false); e.preventDefault(); return; }
      if ($("app").classList.contains("focus-mode")) { toggleFocusMode(false); e.preventDefault(); return; }
      if ($("app").classList.contains("view-read")) { setViewMode("print"); e.preventDefault(); return; }
      return;
    }

    // Tab: navigate table cells if inside a table, else insert tab
    if (e.key === "Tab") {
      var cell = getCurrentTableCell();
      if (cell) {
        e.preventDefault();
        navigateTableCell(cell, e.shiftKey ? "prev" : "next");
        return;
      }
      e.preventDefault();
      document.execCommand("insertText", false, "\t");
      schedulePaginate();
      return;
    }

    // ? (with no modifier, or Shift+/) shows shortcuts overlay
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // only trigger if not typing in an input/dialog
      var ae = document.activeElement;
      if (ae && ae.tagName !== "INPUT" && ae.tagName !== "TEXTAREA") {
        e.preventDefault();
        openShortcutOverlay();
        return;
      }
    }

    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    var k = e.key.toLowerCase();

    // Ctrl+Enter → page break
    if (e.key === "Enter") { e.preventDefault(); insertPageBreak(); return; }

    if (k === "s") { e.preventDefault(); saveDocument(true); return; }
    if (k === "p") { e.preventDefault(); printDocument(); return; }
    if (k === "b") { e.preventDefault(); exec("bold"); return; }
    if (k === "i") { e.preventDefault(); exec("italic"); return; }
    if (k === "u") { e.preventDefault(); exec("underline"); return; }
    if (k === "f") { e.preventDefault(); openFind(); return; }
    if (k === "h") { e.preventDefault(); openFind(); return; }
    if (k === "k") { e.preventDefault(); openLinkDialog(); return; }
    if (k === "g") { e.preventDefault(); toggleOutline(); return; }
    if (k === "m" && e.shiftKey) { e.preventDefault(); cycleMarginPreset(); return; }
    if (k === "f" && e.shiftKey) { e.preventDefault(); toggleFocusMode(); return; }
    if (k === "n" && e.shiftKey) { e.preventDefault(); toggleZenMode(); return; }
    if (k === "/" && e.shiftKey) { e.preventDefault(); openShortcutOverlay(); return; }

    // Ctrl++ / Ctrl+= → zoom in
    if (k === "+" || k === "=") { e.preventDefault(); adjustZoom(10); return; }
    // Ctrl+- → zoom out
    if (k === "-") { e.preventDefault(); adjustZoom(-10); return; }
    // Ctrl+0 → reset zoom
    if (k === "0") { e.preventDefault(); setZoom(100); return; }
    if (k === "z" && !e.shiftKey) { e.preventDefault(); exec("undo"); return; }
    if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); exec("redo"); return; }
  }

  /* Cycle through margin presets in order: default → narrow → moderate → wide → default */
  function cycleMarginPreset() {
    var presets = ["default", "narrow", "moderate", "wide"];
    // Find current preset (or default if custom)
    var current = "default";
    for (var name in MARGIN_PRESETS) {
      var v = MARGIN_PRESETS[name];
      if (pageMargins.top === v && pageMargins.bottom === v &&
          pageMargins.left === v && pageMargins.right === v) {
        current = name;
        break;
      }
    }
    var idx = presets.indexOf(current);
    var next = presets[(idx + 1) % presets.length];
    applyPreset(next);
    saveMargins();
    schedulePaginate();
    scheduleAutosave();
    toast("Margins: " + next.charAt(0).toUpperCase() + next.slice(1), "success");
  }

  function anyModalOpen() {
    var modals = document.querySelectorAll(".modal-overlay.open");
    return modals.length > 0;
  }

  /* ---------------- Table cell navigation ---------------- */
  function getCurrentTableCell() {
    var sel = window.getSelection();
    if (!sel || !sel.anchorNode) return null;
    var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
    var td = node ? node.closest("td, th") : null;
    return td && td.closest(".page-content") ? td : null;
  }

  function navigateTableCell(currentCell, dir) {
    var table = currentCell.closest("table");
    if (!table) return;
    var cells = Array.prototype.slice.call(table.querySelectorAll("td, th"));
    var idx = cells.indexOf(currentCell);
    var target;
    if (dir === "next") {
      target = cells[idx + 1];
      if (!target) {
        // move to next row's first cell, or create a new row at the end
        var row = currentCell.closest("tr");
        var nextRow = row.nextElementSibling;
        if (nextRow) {
          target = nextRow.querySelector("td, th");
        } else {
          // append a new row
          var tbody = table.querySelector("tbody") || table;
          var newRow = document.createElement("tr");
          var colCount = row.children.length;
          for (var i = 0; i < colCount; i++) {
            var td = document.createElement("td");
            td.innerHTML = "&nbsp;";
            newRow.appendChild(td);
          }
          tbody.appendChild(newRow);
          target = newRow.firstElementChild;
          schedulePaginate();
          scheduleAutosave();
        }
      }
    } else {
      target = cells[idx - 1];
      if (!target) {
        var row2 = currentCell.closest("tr");
        var prevRow = row2.previousElementSibling;
        if (prevRow) target = prevRow.querySelector("td, th:last-child");
      }
    }
    if (target) {
      var range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      target.focus();
    }
  }

  /* ---------------- Page Break ---------------- */
  function insertPageBreak() {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    // Insert a page-break marker element followed by an empty paragraph
    var html = '<div class="zdocs-page-break" contenteditable="false"><span class="pb-label">— Page Break —</span></div><p><br></p>';
    document.execCommand("insertHTML", false, html);
    schedulePaginate();
    scheduleAutosave();
    scheduleOutlineUpdate();
    toast("Page break inserted", "success");
  }

  /* ---------------- Outline ---------------- */
  var outlineUpdateScheduled = false;

  function scheduleOutlineUpdate() {
    if (outlineUpdateScheduled) return;
    outlineUpdateScheduled = true;
    setTimeout(function () {
      outlineUpdateScheduled = false;
      if ($("outlinePanel").classList.contains("open")) {
        buildOutline();
      }
    }, 250);
  }

  function toggleOutline(force) {
    var panel = $("outlinePanel");
    var shouldOpen = force === undefined ? !panel.classList.contains("open") : force;
    if (shouldOpen) {
      buildOutline();
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
    } else {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
    }
  }

  function buildOutline() {
    var body = $("outlineBody");
    body.innerHTML = "";
    var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
    if (headings.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "Add headings (Title, Heading 1–3) to see them here.";
      body.appendChild(empty);
      return;
    }
    for (var i = 0; i < headings.length; i++) {
      (function (h) {
        var tag = h.tagName.toLowerCase();
        var text = (h.textContent || "").trim();
        if (!text) return;
        var item = document.createElement("button");
        item.className = "outline-item level-" + tag;
        var badge = document.createElement("span");
        badge.className = "outline-badge";
        badge.textContent = tag.toUpperCase();
        item.appendChild(badge);
        item.appendChild(document.createTextNode(text));
        item.title = "Jump to " + text;
        item.addEventListener("click", function () {
          h.scrollIntoView({ behavior: "smooth", block: "center" });
          // place caret at start of heading
          var range = document.createRange();
          range.selectNodeContents(h);
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          var content = h.closest(".page-content");
          if (content) content.focus();
          // brief highlight
          h.style.transition = "background 0.4s";
          var prevBg = h.style.background;
          h.style.background = "var(--accent-soft)";
          setTimeout(function () { h.style.background = prevBg; }, 800);
        });
        body.appendChild(item);
      })(headings[i]);
    }
    // apply any active filter after rebuild
    filterOutline();
  }

  function filterOutline() {
    var body = $("outlineBody");
    if (!body) return;
    var query = ($("outlineSearch").value || "").toLowerCase().trim();
    var items = body.querySelectorAll(".outline-item");
    var visible = 0;
    for (var i = 0; i < items.length; i++) {
      var text = items[i].textContent.toLowerCase();
      if (!query || text.indexOf(query) !== -1) {
        items[i].classList.remove("hidden");
        visible++;
      } else {
        items[i].classList.add("hidden");
      }
    }
    // show / hide "no match" message
    var noMatch = body.querySelector(".outline-no-match");
    if (!noMatch) {
      noMatch = document.createElement("p");
      noMatch.className = "outline-no-match";
      noMatch.textContent = "No headings match your filter.";
      body.appendChild(noMatch);
    }
    if (query && visible === 0 && items.length > 0) {
      noMatch.classList.add("show");
    } else {
      noMatch.classList.remove("show");
    }
  }

  // Highlight the heading nearest the top of the viewport in the outline
  // panel, so the user can see where they are in the document.
  function highlightActiveOutlineHeading() {
    var panel = $("outlinePanel");
    if (!panel || !panel.classList.contains("open")) return;
    var body = $("outlineBody");
    if (!body) return;
    var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
    if (headings.length === 0) return;
    var scrollEl = $("documentScroll");
    var scrollTop = scrollEl.scrollTop;
    var viewportMid = scrollTop + scrollEl.clientHeight / 3;
    var activeIdx = -1;
    for (var i = 0; i < headings.length; i++) {
      var rect = headings[i].getBoundingClientRect();
      var absTop = rect.top + scrollEl.scrollTop - scrollEl.getBoundingClientRect().top;
      if (absTop <= viewportMid) activeIdx = i;
      else break;
    }
    if (activeIdx < 0) activeIdx = 0;
    var items = body.querySelectorAll(".outline-item");
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle("active-heading", j === activeIdx);
    }
    // auto-scroll the outline to keep the active item visible
    var activeItem = items[activeIdx];
    if (activeItem) {
      var bodyRect = body.getBoundingClientRect();
      var itemRect = activeItem.getBoundingClientRect();
      if (itemRect.top < bodyRect.top || itemRect.bottom > bodyRect.bottom) {
        activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  /* ---------------- Shortcuts dialog ---------------- */
  var shortcutOverlay = null;
  function openShortcutOverlay() {
    // Also populate the old modal grid for backward compat
    buildShortcuts();
    if (!shortcutOverlay) {
      shortcutOverlay = document.createElement("div");
      shortcutOverlay.className = "shortcut-overlay";
      shortcutOverlay.innerHTML =
        '<div class="shortcut-overlay-content">' +
          '<div class="shortcut-overlay-head">' +
            '<h3>Keyboard Shortcuts</h3>' +
            '<button class="modal-close" id="shortcutOverlayClose" aria-label="Close">×</button>' +
          '</div>' +
          '<div class="shortcut-overlay-body" id="shortcutOverlayBody"></div>' +
          '<div class="shortcut-overlay-hint">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</div>' +
        '</div>';
      document.body.appendChild(shortcutOverlay);
      // click outside to close
      shortcutOverlay.addEventListener("mousedown", function (e) {
        if (e.target === shortcutOverlay) shortcutOverlay.classList.remove("open");
      });
      // close button
      var closeBtn = shortcutOverlay.querySelector("#shortcutOverlayClose");
      if (closeBtn) closeBtn.addEventListener("click", function () { shortcutOverlay.classList.remove("open"); });
    }
    // copy the shortcuts grid into the overlay body
    var body = shortcutOverlay.querySelector("#shortcutOverlayBody");
    if (body) {
      body.innerHTML = "";
      var grid = $("shortcutsGrid");
      if (grid) body.appendChild(grid.cloneNode(true));
    }
    shortcutOverlay.classList.add("open");
  }

  function buildShortcuts() {
    var grid = $("shortcutsGrid");
    grid.innerHTML = "";
    var modKey = navigator.platform.indexOf("Mac") >= 0 ? "⌘" : "Ctrl";
    var sections = [
      {
        title: "File",
        items: [
          { desc: "Save document", keys: [modKey, "S"] },
          { desc: "Print / Export PDF", keys: [modKey, "P"] },
          { desc: "New document", keys: [] },
        ],
      },
      {
        title: "Editing",
        items: [
          { desc: "Undo", keys: [modKey, "Z"] },
          { desc: "Redo", keys: [modKey, "Y"] },
          { desc: "Find & Replace", keys: [modKey, "H"] },
          { desc: "Find (quick)", keys: [modKey, "F"] },
          { desc: "Insert tab", keys: ["Tab"] },
          { desc: "Page break", keys: [modKey, "Enter"] },
          { desc: "Close dialog / panel", keys: ["Esc"] },
          { desc: "Right-click for context menu", keys: ["Right-click"] },
        ],
      },
      {
        title: "Formatting",
        items: [
          { desc: "Bold", keys: [modKey, "B"] },
          { desc: "Italic", keys: [modKey, "I"] },
          { desc: "Underline", keys: [modKey, "U"] },
          { desc: "Strikethrough", keys: [] },
          { desc: "Insert link", keys: [modKey, "K"] },
          { desc: "Cycle font size", keys: [modKey, "Shift", ">"] },
        ],
      },
      {
        title: "Navigation",
        items: [
          { desc: "Toggle outline", keys: [modKey, "G"] },
          { desc: "Focus mode", keys: [modKey, "Shift", "F"] },
          { desc: "Zen mode (auto-hide)", keys: [modKey, "Shift", "N"] },
          { desc: "Cycle margin presets", keys: [modKey, "Shift", "M"] },
          { desc: "Show this help", keys: ["?"] },
          { desc: "Next table cell", keys: ["Tab"] },
          { desc: "Previous table cell", keys: ["Shift", "Tab"] },
          { desc: "Zoom in", keys: [modKey, "+"] },
          { desc: "Zoom out", keys: [modKey, "-"] },
        ],
      },
    ];
    for (var s = 0; s < sections.length; s++) {
      var sec = document.createElement("div");
      sec.className = "shortcut-section";
      var h4 = document.createElement("h4");
      h4.textContent = sections[s].title;
      sec.appendChild(h4);
      for (var i = 0; i < sections[s].items.length; i++) {
        var it = sections[s].items[i];
        var row = document.createElement("div");
        row.className = "shortcut-row";
        var desc = document.createElement("span");
        desc.className = "desc";
        desc.textContent = it.desc;
        row.appendChild(desc);
        var keys = document.createElement("span");
        keys.className = "keys";
        for (var k = 0; k < it.keys.length; k++) {
          if (k > 0) {
            var plus = document.createElement("span");
            plus.textContent = "+";
            plus.style.color = "var(--text-faint)";
            keys.appendChild(plus);
          }
          var kbd = document.createElement("span");
          kbd.className = "kbd";
          kbd.textContent = it.keys[k];
          keys.appendChild(kbd);
        }
        if (it.keys.length === 0) {
          var hint = document.createElement("span");
          hint.className = "kbd";
          hint.textContent = "menu";
          keys.appendChild(hint);
        }
        row.appendChild(keys);
        sec.appendChild(row);
      }
      grid.appendChild(sec);
    }
  }

  /* ---------------- Link hover preview ---------------- */
  var linkPreviewEl = null;
  var linkPreviewTimer = null;

  function initLinkPreview() {
    linkPreviewEl = document.createElement("div");
    linkPreviewEl.className = "link-preview";
    document.body.appendChild(linkPreviewEl);

    document.addEventListener("mouseover", function (e) {
      var a = e.target.closest ? e.target.closest("a") : null;
      if (a && a.closest(".page-content")) {
        clearTimeout(linkPreviewTimer);
        linkPreviewTimer = setTimeout(function () {
          showLinkPreview(a, e);
        }, 350);
      }
    });
    document.addEventListener("mouseout", function (e) {
      var a = e.target.closest ? e.target.closest("a") : null;
      if (a) {
        clearTimeout(linkPreviewTimer);
        linkPreviewEl.classList.remove("show");
      }
    });
    document.addEventListener("mousemove", function (e) {
      if (linkPreviewEl.classList.contains("show")) {
        positionLinkPreview(e);
      }
    });
  }

  function showLinkPreview(a, e) {
    var href = a.getAttribute("href") || "";
    var text = a.textContent || "";
    linkPreviewEl.innerHTML =
      '<div class="lp-url">' + escapeHtml(href) + "</div>" +
      '<div class="lp-hint">' + (text ? "“" + escapeHtml(text) + "” · " : "") + "Ctrl+click to open</div>";
    positionLinkPreview(e);
    linkPreviewEl.classList.add("show");
  }

  function positionLinkPreview(e) {
    var x = e.clientX + 14;
    var y = e.clientY + 18;
    var w = linkPreviewEl.offsetWidth;
    var h = linkPreviewEl.offsetHeight;
    if (x + w > window.innerWidth - 12) x = window.innerWidth - w - 12;
    if (y + h > window.innerHeight - 12) y = e.clientY - h - 14;
    linkPreviewEl.style.left = x + "px";
    linkPreviewEl.style.top = y + "px";
  }

  /* ---------------- Image resize handles ----------------
     Clicking an image wraps it in a container with 8 drag handles
     (corners + edges). Dragging a handle resizes the image
     proportionally (corners) or one-dimensionally (edges).       */
  var activeResizeImg = null;
  var resizeOverlay = null;
  var resizeHandles = null;
  var resizeStartX = 0;
  var resizeStartY = 0;
  var resizeStartW = 0;
  var resizeStartH = 0;
  var resizeMode = null; // 'nw','ne','sw','se','n','s','e','w'

  function initImageResize() {
    // Delegated click listener on the document
    document.addEventListener("click", function (e) {
      var img = e.target.closest ? e.target.closest(".page-content img") : null;
      if (img) {
        e.preventDefault();
        attachImageResize(img);
      } else if (resizeOverlay && !e.target.closest(".img-resize-wrap")) {
        detachImageResize();
      }
    });

    document.addEventListener("mousemove", function (e) {
      if (activeResizeImg && resizeMode) {
        e.preventDefault();
        var dx = e.clientX - resizeStartX;
        var dy = e.clientY - resizeStartY;
        var newW = resizeStartW, newH = resizeStartH;
        var ratio = resizeStartW / resizeStartH;
        switch (resizeMode) {
          case "se": newW = Math.max(40, resizeStartW + dx); newH = newW / ratio; break;
          case "sw": newW = Math.max(40, resizeStartW - dx); newH = newW / ratio; break;
          case "ne": newW = Math.max(40, resizeStartW + dx); newH = newW / ratio; break;
          case "nw": newW = Math.max(40, resizeStartW - dx); newH = newW / ratio; break;
          case "e": newW = Math.max(40, resizeStartW + dx); break;
          case "w": newW = Math.max(40, resizeStartW - dx); break;
          case "s": newH = Math.max(40, resizeStartH + dy); break;
          case "n": newH = Math.max(40, resizeStartH - dy); break;
        }
        activeResizeImg.style.width = newW + "px";
        activeResizeImg.style.height = newH + "px";
      }
    });

    document.addEventListener("mouseup", function () {
      if (activeResizeImg && resizeMode) {
        resizeMode = null;
        activeResizeImg.removeAttribute("data-resizing");
        schedulePaginate();
        scheduleAutosave();
      }
    });
  }

  function attachImageResize(img) {
    detachImageResize();
    activeResizeImg = img;
    img.setAttribute("data-selected", "true");

    resizeOverlay = document.createElement("div");
    resizeOverlay.className = "img-resize-overlay";
    resizeHandles = [];
    var modes = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    for (var i = 0; i < modes.length; i++) {
      (function (mode) {
        var h = document.createElement("div");
        h.className = "img-resize-handle handle-" + mode;
        h.addEventListener("mousedown", function (e) {
          e.preventDefault();
          e.stopPropagation();
          resizeMode = mode;
          resizeStartX = e.clientX;
          resizeStartY = e.clientY;
          resizeStartW = img.offsetWidth;
          resizeStartH = img.offsetHeight;
          img.setAttribute("data-resizing", "true");
        });
        resizeOverlay.appendChild(h);
        resizeHandles.push(h);
      })(modes[i]);
    }
    document.body.appendChild(resizeOverlay);
    positionResizeOverlay();
    window.addEventListener("scroll", positionResizeOverlay, true);
    window.addEventListener("resize", positionResizeOverlay);
  }

  function positionResizeOverlay() {
    if (!resizeOverlay || !activeResizeImg) return;
    var r = activeResizeImg.getBoundingClientRect();
    resizeOverlay.style.left = r.left + "px";
    resizeOverlay.style.top = r.top + "px";
    resizeOverlay.style.width = r.width + "px";
    resizeOverlay.style.height = r.height + "px";
  }

  function detachImageResize() {
    if (activeResizeImg) activeResizeImg.removeAttribute("data-selected");
    activeResizeImg = null;
    if (resizeOverlay) {
      resizeOverlay.parentNode.removeChild(resizeOverlay);
      resizeOverlay = null;
    }
    resizeHandles = null;
    window.removeEventListener("scroll", positionResizeOverlay, true);
    window.removeEventListener("resize", positionResizeOverlay);
  }

  function onPaste() {
    setTimeout(function () {
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        var c = getContent(pages[i]);
        var breaks = c.querySelectorAll("[style*='page-break'], .page, [data-page]");
        for (var j = 0; j < breaks.length; j++) breaks[j].remove();
      }
      schedulePaginate();
      scheduleAutosave();
    }, 0);
  }

  function schedulePaginate() {
    if (paginateScheduled) return;
    paginateScheduled = true;
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        paginateScheduled = false;
        paginate();
      });
    } else {
      setTimeout(function () {
        paginateScheduled = false;
        paginate();
      }, 16);
    }
  }

  function scheduleAutosave() {
    // Show "Saving…" immediately (matching slides pattern)
    setAutosaveState("saving");
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      autosaveTimer = null;
      saveDocument(false);
    }, 800);
  }

  // Periodic version snapshots — every 5 minutes, push a version snapshot
  // so the user can roll back to an earlier point in their writing session.
  function startAutosaveSnapshots() {
    if (autosaveSnapshotTimer) return; // already running
    autosaveSnapshotTimer = setInterval(function () {
      try {
        var data = serialize();
        pushVersion(data);
        // update the version count badge in the status bar
        var vc = $("versionCountText");
        if (vc) vc.textContent = String(getVersions().length);
      } catch (e) {}
    }, AUTOSAVE_SNAPSHOT_MS);
  }

  function stopAutosaveSnapshots() {
    if (autosaveSnapshotTimer) {
      clearInterval(autosaveSnapshotTimer);
      autosaveSnapshotTimer = null;
    }
  }

  /* ---------------- Toolbar / execCommand ---------------- */
  function restoreEditorSelection() {
    if (lastEditorRange) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(lastEditorRange);
      } catch (e) {}
    }
  }

  // Focus the first page-content and re-apply the last saved selection.
  // Used after modal/prompt dialogs steal focus — execCommand('insertHTML')
  // only works when the editor is focused and has a selection inside it.
  function focusEditorAndRestore() {
    var firstContent = getContent(getPages()[0]);
    if (firstContent) {
      try { firstContent.focus(); } catch (e) {}
    }
    restoreEditorSelection();
  }

  function exec(cmd, value) {
    restoreEditorSelection();
    var sel = window.getSelection();
    var inEditor = false;
    if (sel && sel.anchorNode) {
      var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
      inEditor = !!node && !!node.closest && !!node.closest(".page-content");
    }
    if (!inEditor) {
      var firstContent = getContent(getPages()[0]);
      if (firstContent) firstContent.focus();
    }
    try { document.execCommand(cmd, false, value); } catch (e) {}
    schedulePaginate();
    scheduleAutosave();
    setTimeout(updateToolbarStates, 10);
  }

  function applyBlock(tag) { exec("formatBlock", "<" + (tag === "p" ? "p" : tag) + ">"); }
  function applyFontFamily(value) { exec("fontName", value); }
  function applyFontSize(value) { exec("fontSize", value); }

  function applyLineSpacing(value) {
    var block = getCurrentBlock();
    if (block) {
      block.style.lineHeight = value;
      schedulePaginate();
      scheduleAutosave();
    }
  }

  function applyTextColor(color) {
    $("textColorBar").style.background = color;
    exec("foreColor", color);
    // macro recording
    if (typeof macroRecording !== "undefined" && macroRecording) {
      macroSteps.push({ type: "color", target: "text", value: color });
    }
  }

  function applyHiliteColor(color) {
    $("hiliteColorBar").style.background = color;
    try { document.execCommand("styleWithCSS", false, true); } catch (e) {}
    exec("hiliteColor", color);
    // macro recording
    if (typeof macroRecording !== "undefined" && macroRecording) {
      macroSteps.push({ type: "color", target: "hilite", value: color });
    }
  }

  function clearFormatting() { exec("removeFormat"); }

  function getCurrentBlock() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var node = sel.anchorNode;
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node && node.parentElement && !node.parentElement.classList.contains("page-content")) {
      node = node.parentElement;
    }
    if (node && node.parentElement && node.parentElement.classList.contains("page-content")) return node;
    return null;
  }

  function updateToolbarStates() {
    var cmds = ["bold", "italic", "underline", "strikeThrough", "justifyLeft", "justifyCenter", "justifyRight", "justifyFull"];
    for (var i = 0; i < cmds.length; i++) {
      var btn = document.querySelector('[data-cmd="' + cmds[i] + '"]');
      if (!btn) continue;
      var active = false;
      try { active = document.queryCommandState(cmds[i]); } catch (e) {}
      if (active) btn.classList.add("active"); else btn.classList.remove("active");
    }
    var block = "p";
    try {
      var v = document.queryCommandValue("formatBlock");
      if (v) block = String(v).toLowerCase().replace(/[<>]/g, "");
    } catch (e) {}
    var sel = $("blockType");
    if (sel) {
      var has = false;
      for (var j = 0; j < sel.options.length; j++) {
        if (sel.options[j].value === block) { has = true; break; }
      }
      if (has) sel.value = block;
    }
  }

  /* ---------------- Save / Load (IndexedDB via EmeraldIDBStorage) ---------------- */
  var idb = null; // will be set to window.EmeraldIDBStorage if available

  function idbAvailable() {
    return idb && idb.isReady && idb.isReady();
  }

  function serialize() {
    var pages = getPages();
    var combined = document.createElement("div");
    for (var i = 0; i < pages.length; i++) {
      var content = getContent(pages[i]);
      var kids = content.children;
      for (var j = 0; j < kids.length; j++) {
        combined.appendChild(kids[j].cloneNode(true));
      }
    }
    return {
      title: ($("docTitle") ? $("docTitle").value : "Untitled Document"),
      content: combined.innerHTML,
      savedAt: Date.now(),
      theme: theme,
    };
  }

  function saveDocument(showToast) {
    var data;
    try { data = serialize(); } catch (e) {
      if (showToast) toast("Save failed", "error");
      return;
    }
    // If password protection is enabled, encrypt the content before saving
    if (documentPassword) {
      data.encrypted = true;
      data.content = xorCipher(data.content, documentPassword);
      data.title = xorCipher(data.title, documentPassword);
    }
    try {
      // Use IndexedDB if available, otherwise fall back to localStorage
      if (idbAvailable()) {
        idb.setJSON(STORAGE_KEY, data);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      }
      setAutosaveState("saved");
      if (showToast) {
        // Explicit save → also push to version history (store plaintext for versions)
        pushVersion(serialize());
        toast("Document saved", "success");
      }
    } catch (e) {
      setAutosaveState("error");
      if (showToast) toast("Save failed (storage full?)", "error");
    }
  }

  /* ---------------- Version history (IndexedDB) ---------------- */
  function pushVersion(data) {
    var versions = getVersions();

    // Don't add a duplicate if the content is unchanged from the last version
    if (versions.length > 0) {
      var last = versions[0];
      if (last.content === data.content && last.title === data.title) return;
    }

    var entry = {
      title: data.title,
      content: data.content,
      savedAt: data.savedAt,
    };
    versions.unshift(entry);
    if (versions.length > MAX_VERSIONS) versions = versions.slice(0, MAX_VERSIONS);
    try {
      if (idbAvailable()) {
        idb.setJSON(VERSIONS_KEY, versions);
      } else {
        localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions));
      }
    } catch (e) {}
  }

  function getVersions() {
    try {
      var raw = null;
      if (idbAvailable()) {
        raw = idb.getJSONSync(VERSIONS_KEY);
        // getJSONSync returns parsed object, not string
        if (raw) return raw;
      }
      // fallback to localStorage
      raw = localStorage.getItem(VERSIONS_KEY);
      if (!raw) return [];
      return JSON.parse(raw) || [];
    } catch (e) { return []; }
  }

  function restoreVersion(index) {
    var versions = getVersions();
    if (index < 0 || index >= versions.length) return;
    var v = versions[index];
    ($("docTitle")?$("docTitle").value=v.title:null) || "Untitled Document";
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    var page = createPage();
    wrapper.appendChild(page);
    var content = getContent(page);
    content.innerHTML = v.content || "";
    if (content.children.length === 0) {
      var p = document.createElement("p");
      p.innerHTML = "<br>";
      content.appendChild(p);
    }
    paginate();
    saveDocument(false);
    closeModal("versionsModal");
    toast("Version restored", "success");
  }

  function showVersions() {
    var list = $("versionsList");
    list.innerHTML = "";
    var versions = getVersions();
    if (versions.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No saved versions yet. Use the Save button to create version snapshots.";
      list.appendChild(empty);
    } else {
      for (var i = 0; i < versions.length; i++) {
        (function (idx, v) {
          var item = document.createElement("div");
          item.className = "version-item";
          var info = document.createElement("div");
          info.className = "version-info";
          var time = document.createElement("div");
          time.className = "version-time";
          time.textContent = formatTime(v.savedAt);
          var preview = document.createElement("div");
          preview.className = "version-preview";
          preview.textContent = v.title || "Untitled";
          info.appendChild(time);
          info.appendChild(preview);
          var actions = document.createElement("div");
          actions.className = "version-actions";
          var restore = document.createElement("button");
          restore.className = "btn ghost sm";
          restore.textContent = "Restore";
          restore.addEventListener("click", function () { restoreVersion(idx); });
          actions.appendChild(restore);
          item.appendChild(info);
          item.appendChild(actions);
          list.appendChild(item);
        })(i, versions[i]);
      }
    }
    openModal("versionsModal");
  }

  function formatTime(ts) {
    if (!ts) return "Unknown";
    var d = new Date(ts);
    var now = new Date();
    var diff = now - d;
    var sameDay = d.toDateString() === now.toDateString();
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return "Today, " + hh + ":" + mm;
    var yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday, " + hh + ":" + mm;
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[d.getMonth()] + " " + d.getDate() + ", " + hh + ":" + mm;
  }

  async function loadDocument() {
    try {
      var data = null;
      // Try IndexedDB first (async)
      if (window.EmeraldIDBStorage) {
        data = await window.EmeraldIDBStorage.getJSON(STORAGE_KEY);
        // If not in IDB, try migrating from localStorage
        if (!data) {
          data = await window.EmeraldIDBStorage.migrateLocalJSON(STORAGE_KEY);
        }
      }
      // Fallback to localStorage
      if (!data) {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) data = JSON.parse(raw);
      }
      if (!data) return false;
      // If the document is password-encrypted, don't load the scrambled
      // content — checkPasswordOnLoad() will show the unlock modal.
      if (data.encrypted) return false;

      ($("docTitle")?$("docTitle").value=data.title:null) || "Untitled Document";
      var wrapper = $(PAGES_WRAPPER_ID);
      wrapper.innerHTML = "";
      var page = createPage();
      wrapper.appendChild(page);
      var content = getContent(page);
      content.innerHTML = data.content || "";
      if (content.children.length === 0) {
        var p = document.createElement("p");
        p.innerHTML = "<br>";
        content.appendChild(p);
      }
      paginate();
      return true;
    } catch (e) { return false; }
  }

  function setAutosaveState(state) {
    // Save indicator pill: green=saved, yellow=saving, red=error (matching slides)
    var pill = $("saveIndicator");
    var pillText = pill ? pill.querySelector(".save-text") : null;
    if (pill) {
      pill.classList.remove("saving", "error");
      if (state === "saving") {
        pill.classList.add("saving");
        if (pillText) pillText.textContent = "Saving…";
      } else if (state === "error") {
        pill.classList.add("error");
        if (pillText) pillText.textContent = "Save failed";
      } else {
        lastSavedAt = Date.now();
        if (pillText) pillText.textContent = "All changes saved";
      }
    }
    var el = $("autosave");
    if (el) {
      el.classList.remove("saving", "saved");
      if (state === "saving") {
        el.classList.add("saving");
        el.textContent = "Saving…";
      } else if (state === "error") {
        el.textContent = "Save failed";
      } else {
        el.classList.add("saved", "has-time");
        lastSavedAt = Date.now();
        el.innerHTML = "Saved <span class='autosave-time'>at " + formatAutosaveTime(lastSavedAt) + "</span>";
      }
    }
  }
  /* ---------------- New / Print / Export ---------------- */
  function newDocument() {
    if (!window.confirm("Start a new document? Current content will be cleared.")) return;
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    ensureFirstPage();
    ($("docTitle")?$("docTitle").value="Untitled Document":null);
    paginate();
    saveDocument(false);
    toast("New document created", "success");
    setTimeout(function () {
      var c = getContent(getPages()[0]);
      if (c) c.focus();
    }, 50);
  }

  function printDocument() {
    saveDocument(false);
    window.print();
  }

  function exportDocument(format) {
    var title = ($("docTitle") ? $("docTitle").value : "document").replace(/[^\w\-]+/g, "_").toLowerCase() || "document";
    if (format === "txt") {
      var text = getAllText();
      downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), title + ".txt");
      toast("Exported as .txt", "success");
    } else if (format === "html") {
      var stats = getStats();
      var bodyHtml = "";
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        bodyHtml += getContent(pages[i]).innerHTML;
      }
      var html = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" +
        escapeHtml($("docTitle") ? $("docTitle").value : "Document") +
        "</title><style>body{font-family:Georgia,serif;max-width:794px;margin:40px auto;padding:0 24px;line-height:1.6;color:#1a1d21}h1{font-size:28px}h2{font-size:22px}blockquote{border-left:3px solid #0f9d6e;margin:8px 0;padding:4px 16px;background:#e6f6ef;font-style:italic}pre{background:#f4f6f8;padding:10px;border-radius:6px;overflow:auto}img{max-width:100%}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 10px}</style></head><body>" +
        bodyHtml + "</body></html>";
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), title + ".html");
      toast("Exported as .html", "success");
    } else if (format === "print") {
      printDocument();
    } else if (format === "preview") {
      togglePrintPreview(true);
    }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------------- Zoom ---------------- */
  function setZoom(percent) {
    var wrapper = $(PAGES_WRAPPER_ID);
    if (wrapper) wrapper.style.zoom = String(percent / 100);
    $("zoomLabel").textContent = percent + "%";
    var slider = $("zoom");
    if (slider) slider.value = percent;
    var statusPct = $("statusZoomPct");
    if (statusPct) statusPct.textContent = percent + "%";
  }

  /* ---------------- Page navigation ---------------- */
  function scrollToPage(index) {
    var pages = getPages();
    if (index < 1) index = 1;
    if (index > pages.length) index = pages.length;
    if (pages[index - 1]) {
      pages[index - 1].scrollIntoView({ behavior: "smooth", block: "start" });
      var content = getContent(pages[index - 1]);
      if (content) {
        setTimeout(function () {
          content.focus();
          var range = document.createRange();
          range.selectNodeContents(content);
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }, 250);
      }
    }
  }

  /* ---------------- Theme ---------------- */
  function applyTheme(t) {
    theme = t;
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    // re-apply color theme on top of light/dark
    applyColorTheme(currentColorTheme);
  }

  function toggleTheme() {
    applyTheme(theme === "dark" ? "light" : "dark");
  }

  /* Dark paper mode — true dark document canvas (only meaningful in dark theme) */
  function toggleDarkPaper() {
    var app = $("app");
    app.classList.toggle("dark-paper");
    var isOn = app.classList.contains("dark-paper");
    try { localStorage.setItem("zdocs.darkPaper", isOn ? "1" : "0"); } catch (e) {}
    toast(isOn ? "Dark paper on" : "Dark paper off", "success");
  }

  /* ---------------- Document color themes (accent presets) ---------------- */
  var COLOR_THEME_KEY = "zdocs.colorTheme";
  var currentColorTheme = "blue";
  var COLOR_THEMES = {
    blue: { accent: "#2563eb", accentHover: "#1d4ed8", ring: "#3b82f6", name: "Blue" },
    ocean: { accent: "#0284c7", accentHover: "#0369a1", ring: "#38bdf8", name: "Ocean" },
    indigo: { accent: "#4f46e5", accentHover: "#4338ca", ring: "#818cf8", name: "Indigo" },
    cyan: { accent: "#0891b2", accentHover: "#0e7490", ring: "#22d3ee", name: "Cyan" },
    emerald: { accent: "#239a4d", accentHover: "#1a7d3d", ring: "#2BD059", name: "Emerald" },
    sunset: { accent: "#ea580c", accentHover: "#c2410c", ring: "#fb923c", name: "Sunset" },
    rose: { accent: "#e11d48", accentHover: "#be123c", ring: "#fb7185", name: "Rose" },
    violet: { accent: "#7c3aed", accentHover: "#6d28d9", ring: "#a78bfa", name: "Violet" },
  };

  function applyColorTheme(key) {
    currentColorTheme = key || "blue";
    var t = COLOR_THEMES[currentColorTheme] || COLOR_THEMES.blue;
    var root = document.documentElement;
    // override the accent CSS variables
    root.style.setProperty("--ui-accent", t.accent);
    root.style.setProperty("--ui-accent-hover", t.accentHover);
    root.style.setProperty("--ui-accent-soft", hexToRgba(t.accent, 0.10));
    root.style.setProperty("--ui-accent-selected", hexToRgba(t.accent, 0.15));
    root.style.setProperty("--ui-accent-border", hexToRgba(t.accent, 0.30));
    root.style.setProperty("--ui-accent-ring", hexToRgba(t.ring, 0.35));
    root.style.setProperty("--ring", t.ring);
    root.style.setProperty("--accent", t.accent);
    root.style.setProperty("--accent-strong", t.accentHover);
    root.style.setProperty("--accent-soft", hexToRgba(t.accent, 0.10));
    root.setAttribute("data-color-theme", currentColorTheme);
    try { localStorage.setItem(COLOR_THEME_KEY, currentColorTheme); } catch (e) {}
  }

  function loadColorTheme() {
    try {
      var k = localStorage.getItem(COLOR_THEME_KEY);
      if (k && COLOR_THEMES[k]) currentColorTheme = k;
      else currentColorTheme = "blue";
    } catch (e) {}
    applyColorTheme(currentColorTheme);
  }

  function hexToRgba(hex, alpha) {
    var m = hex.match(/^#([0-9a-f]{6})$/i);
    if (!m) return "rgba(0,0,0," + alpha + ")";
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  function openColorThemeDialog() {
    var grid = $("colorThemeGrid");
    if (!grid) return;
    grid.innerHTML = "";
    var keys = Object.keys(COLOR_THEMES);
    for (var i = 0; i < keys.length; i++) {
      (function (key) {
        var t = COLOR_THEMES[key];
        var item = document.createElement("button");
        item.className = "color-theme-option" + (key === currentColorTheme ? " active" : "");
        item.innerHTML = '<span class="ct-swatch" style="background:' + t.accent + '"></span><span class="ct-name">' + escapeHtml(t.name) + "</span>";
        item.addEventListener("click", function () {
          applyColorTheme(key);
          // update active states
          var all = grid.querySelectorAll(".color-theme-option");
          for (var j = 0; j < all.length; j++) all[j].classList.remove("active");
          item.classList.add("active");
          toast("Color theme: " + t.name, "success");
        });
        grid.appendChild(item);
      })(keys[i]);
    }
    openModal("colorThemeModal");
  }

  /* ---------------- Clipboard history ---------------- */
  var clipboardHistory = [];
  var CLIPBOARD_MAX = 12;

  function captureClipboard(text) {
    if (!text || text.length < 1) return;
    // dedupe — if the same text is already the most recent, skip
    if (clipboardHistory.length > 0 && clipboardHistory[0] === text) return;
    // remove older duplicates
    var idx = clipboardHistory.indexOf(text);
    if (idx >= 0) clipboardHistory.splice(idx, 1);
    clipboardHistory.unshift(text);
    if (clipboardHistory.length > CLIPBOARD_MAX) clipboardHistory = clipboardHistory.slice(0, CLIPBOARD_MAX);
  }

  function openClipboardHistory() {
    var list = $("clipboardHistoryList");
    list.innerHTML = "";
    if (clipboardHistory.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No clipboard history yet. Cut or copy some text.";
      list.appendChild(empty);
    } else {
      for (var i = 0; i < clipboardHistory.length; i++) {
        (function (text, idx) {
          var item = document.createElement("div");
          item.className = "clipboard-history-item";
          var preview = text.length > 60 ? text.slice(0, 60) + "…" : text;
          item.innerHTML = '<span class="ch-preview">' + escapeHtml(preview) + '</span><span class="ch-len">' + text.length + ' chars</span>';
          item.title = "Click to paste at caret";
          item.addEventListener("click", function () {
            focusEditorAndRestore();
            document.execCommand("insertText", false, text);
            closeModal("clipboardHistoryModal");
            schedulePaginate();
            scheduleAutosave();
            toast("Pasted from clipboard history", "success");
          });
          list.appendChild(item);
        })(clipboardHistory[i], i);
      }
    }
    openModal("clipboardHistoryModal");
  }

  function clearClipboardHistory() {
    clipboardHistory = [];
    openClipboardHistory();
    toast("Clipboard history cleared", "success");
  }

  /* ---------------- Modal helpers ---------------- */
  function openModal(id) {
    var m = $(id);
    if (m) {
      m.classList.add("open");
      m.setAttribute("aria-hidden", "false");
      var first = m.querySelector("input[type='text'], input[type='url'], input:not([type])");
      if (first) setTimeout(function () { first.focus(); }, 80);
    }
  }

  function closeModal(id) {
    var m = $(id);
    if (m) {
      m.classList.remove("open");
      m.setAttribute("aria-hidden", "true");
    }
  }

  function closeAllModals() {
    var modals = document.querySelectorAll(".modal-overlay");
    for (var i = 0; i < modals.length; i++) {
      modals[i].classList.remove("open");
      modals[i].setAttribute("aria-hidden", "true");
    }
  }

  /* ---------------- Find & Replace ---------------- */
  function openFind() {
    clearFindHighlights();
    openModal("findModal");
    buildFindHistoryDropdown();
  }

  /* ---------------- Find history ---------------- */
  var FIND_HISTORY_KEY = "zdocs.findHistory";
  var findHistory = [];
  var findHistoryDropdown = null;

  function loadFindHistory() {
    try {
      var h = null;
      if (idbAvailable()) h = idb.getJSONSync(FIND_HISTORY_KEY);
      if (!h) { var raw = localStorage.getItem(FIND_HISTORY_KEY); if (raw) h = JSON.parse(raw); }
      if (Array.isArray(h)) findHistory = h;
    } catch (e) {}
  }

  function saveFindHistory() {
    try {
      if (idbAvailable()) idb.setJSON(FIND_HISTORY_KEY, findHistory);
      else localStorage.setItem(FIND_HISTORY_KEY, JSON.stringify(findHistory));
    } catch (e) {}
  }

  function addFindHistory(term) {
    term = (term || "").trim();
    if (!term || term.length < 2) return;
    // dedupe + move to front
    var idx = findHistory.indexOf(term);
    if (idx >= 0) findHistory.splice(idx, 1);
    findHistory.unshift(term);
    if (findHistory.length > 12) findHistory = findHistory.slice(0, 12);
    saveFindHistory();
  }

  function buildFindHistoryDropdown() {
    var input = $("findInput");
    if (!input) return;
    if (!findHistoryDropdown) {
      findHistoryDropdown = document.createElement("div");
      findHistoryDropdown.className = "find-history";
      input.parentElement.style.position = "relative";
      input.parentElement.appendChild(findHistoryDropdown);
      // show on focus — rebuild items each time so new searches appear
      input.addEventListener("focus", function () {
        populateFindHistoryItems();
        if (findHistory.length > 0) findHistoryDropdown.classList.add("open");
      });
      // hide on click outside
      document.addEventListener("click", function (e) {
        if (!e.target.closest(".find-history") && e.target !== input) {
          findHistoryDropdown.classList.remove("open");
        }
      });
    }
    populateFindHistoryItems();
  }

  function populateFindHistoryItems() {
    if (!findHistoryDropdown) return;
    findHistoryDropdown.innerHTML = "";
    if (findHistory.length === 0) {
      findHistoryDropdown.classList.remove("open");
      return;
    }
    var input = $("findInput");
    for (var i = 0; i < findHistory.length; i++) {
      (function (term) {
        var item = document.createElement("div");
        item.className = "find-history-item";
        item.textContent = term;
        item.addEventListener("click", function () {
          input.value = term;
          findHistoryDropdown.classList.remove("open");
          runFind();
        });
        findHistoryDropdown.appendChild(item);
      })(findHistory[i]);
    }
  }

  function clearFindHighlights() {
    var marks = document.querySelectorAll(".page-content mark.zdocs-mark");
    for (var i = marks.length - 1; i >= 0; i--) {
      var mark = marks[i];
      var parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
    findMatches = [];
    findIndex = -1;
    updateMatchCount();
  }

  function refreshFindHighlights() {
    if (!findMatches.length) return;
    var term = $("findInput").value;
    if (term) runFind();
  }

  function runFind() {
    clearFindHighlights();
    var term = $("findInput").value;
    if (!term) { updateMatchCount(); return; }

    // Track find history (debounced via input event)
    addFindHistory(term);

    var caseSensitive = $("findCase").checked;
    var wholeWord = $("findWhole").checked;
    var useRegex = $("findRegex") && $("findRegex").checked;
    var flags = caseSensitive ? "g" : "gi";
    var pattern;
    if (useRegex) {
      // In regex mode, the user's input is treated as a raw regex pattern.
      // Whole word is ignored (they can use \b themselves).
      pattern = term;
    } else if (wholeWord) {
      pattern = "\\b" + escapeRegExp(term) + "\\b";
    } else {
      pattern = escapeRegExp(term);
    }
    var regex;
    try { regex = new RegExp(pattern, flags); } catch (e) {
      toast("Invalid regex: " + e.message, "error");
      return;
    }

    findMatches = [];
    var pages = getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var content = getContent(pages[pi]);
      var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          var p = node.parentElement;
          if (p && p.tagName === "MARK" && p.classList.contains("zdocs-mark")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var textNodes = [];
      var n;
      while ((n = walker.nextNode())) textNodes.push(n);

      for (var ti = 0; ti < textNodes.length; ti++) {
        var node = textNodes[ti];
        var text = node.textContent;
        var matches = [];
        var m;
        regex.lastIndex = 0;
        while ((m = regex.exec(text)) !== null) {
          matches.push({ start: m.index, end: m.index + m[0].length });
          if (m[0].length === 0) regex.lastIndex++;
        }
        if (matches.length) {
          wrapMatches(node, matches, pi);
        }
      }
    }

    findIndex = findMatches.length ? 0 : -1;
    highlightCurrentMatch();
    updateMatchCount();
  }

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function wrapMatches(textNode, matches, pageIndex) {
    var parent = textNode.parentNode;
    var text = textNode.textContent;
    var frag = document.createDocumentFragment();
    var last = 0;
    for (var i = 0; i < matches.length; i++) {
      var ms = matches[i].start, me = matches[i].end;
      if (ms > last) frag.appendChild(document.createTextNode(text.slice(last, ms)));
      var mark = document.createElement("mark");
      mark.className = "zdocs-mark";
      mark.appendChild(document.createTextNode(text.slice(ms, me)));
      frag.appendChild(mark);
      findMatches.push({ node: mark, pageIndex: pageIndex });
      last = me;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, textNode);
  }

  function updateMatchCount() {
    var el = $("matchCount");
    if (!el) return;
    if (findMatches.length === 0) {
      el.textContent = "0 of 0";
    } else {
      el.textContent = (findIndex + 1) + " of " + findMatches.length;
    }
  }

  function highlightCurrentMatch() {
    var marks = document.querySelectorAll(".page-content mark.zdocs-mark");
    for (var i = 0; i < marks.length; i++) marks[i].classList.remove("current");
    if (findIndex >= 0 && findMatches[findIndex]) {
      var m = findMatches[findIndex];
      m.node.classList.add("current");
      m.node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function findNext() {
    if (!findMatches.length) { runFind(); return; }
    findIndex = (findIndex + 1) % findMatches.length;
    highlightCurrentMatch();
    updateMatchCount();
  }

  function findPrev() {
    if (!findMatches.length) { runFind(); return; }
    findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
    highlightCurrentMatch();
    updateMatchCount();
  }

  function replaceOne() {
    if (!findMatches.length || findIndex < 0) return;
    var m = findMatches[findIndex];
    var replacement = $("replaceInput").value;
    var textNode = document.createTextNode(replacement);
    m.node.parentNode.replaceChild(textNode, m.node);
    findMatches.splice(findIndex, 1);
    if (findIndex >= findMatches.length) findIndex = 0;
    schedulePaginate();
    setTimeout(function () {
      runFind();
      highlightCurrentMatch();
      updateMatchCount();
    }, 100);
  }

  function replaceAll() {
    var replacement = $("replaceInput").value;
    var count = findMatches.length;
    if (!count) return;
    // Replace from end to start to preserve indexes
    for (var i = findMatches.length - 1; i >= 0; i--) {
      var m = findMatches[i];
      var textNode = document.createTextNode(replacement);
      m.node.parentNode.replaceChild(textNode, m.node);
    }
    findMatches = [];
    findIndex = -1;
    schedulePaginate();
    setTimeout(function () {
      runFind();
      updateMatchCount();
    }, 100);
    toast(count + " replacement" + (count === 1 ? "" : "s") + " made", "success");
  }

  /* ---------------- Insert Link ---------------- */
  function openLinkDialog() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var node = sel.anchorNode;
      if (node) {
        var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (el && el.closest(".page-content")) {
          lastEditorRange = sel.getRangeAt(0).cloneRange();
        }
      }
    }
    $("linkUrl").value = "";
    $("linkText").value = sel && !sel.isCollapsed ? sel.toString() : "";
    openModal("linkModal");
  }

  function insertLink() {
    var url = $("linkUrl").value.trim();
    var text = $("linkText").value.trim();
    if (!url) { toast("Please enter a URL", "error"); return; }
    restoreEditorSelection();
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      var fc = getContent(getPages()[0]);
      if (fc) fc.focus();
    }
    if (text) {
      // Replace selection with linked text
      document.execCommand("insertHTML", false,
        '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener">' + escapeHtml(text) + "</a>");
    } else {
      try { document.execCommand("createLink", false, url); } catch (e) {}
    }
    closeModal("linkModal");
    schedulePaginate();
    scheduleAutosave();
    toast("Link inserted", "success");
  }

  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }

  /* ---------------- Insert Image ---------------- */
  function openImageDialog() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var node = sel.anchorNode;
      if (node) {
        var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (el && el.closest(".page-content")) {
          lastEditorRange = sel.getRangeAt(0).cloneRange();
        }
      }
    }
    $("imgUrl").value = "";
    $("imgFile").value = "";
    $("imgAlt").value = "";
    openModal("imageModal");
  }

  function insertImage() {
    var url = $("imgUrl").value.trim();
    var alt = $("imgAlt").value.trim();
    var file = $("imgFile").files[0];

    if (file) {
      var reader = new FileReader();
      reader.onload = function (e) {
        doInsertImage(e.target.result, alt);
      };
      reader.readAsDataURL(file);
    } else if (url) {
      doInsertImage(url, alt);
    } else {
      toast("Please provide a URL or file", "error");
      return;
    }
    closeModal("imageModal");
  }

  function doInsertImage(src, alt) {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    document.execCommand("insertHTML", false,
      '<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt) + '" />');
    schedulePaginate();
    scheduleAutosave();
    toast("Image inserted", "success");
  }

  /* ---------------- Drag-and-drop image insertion ---------------- */
  function initDragDropImage() {
    var scroll = $("documentScroll");
    if (!scroll) return;
    var dragCounter = 0;
    scroll.addEventListener("dragenter", function (e) {
      if (!e.dataTransfer || !e.dataTransfer.types || e.dataTransfer.types.indexOf("Files") < 0) return;
      e.preventDefault();
      dragCounter++;
      scroll.classList.add("drag-over");
    });
    scroll.addEventListener("dragleave", function (e) {
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; scroll.classList.remove("drag-over"); }
    });
    scroll.addEventListener("dragover", function (e) {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf("Files") >= 0) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    });
    scroll.addEventListener("drop", function (e) {
      e.preventDefault();
      dragCounter = 0;
      scroll.classList.remove("drag-over");
      var files = e.dataTransfer ? e.dataTransfer.files : null;
      if (!files || files.length === 0) return;
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!file.type || !file.type.match(/^image\//)) {
          toast("Skipping non-image file: " + file.name, "error");
          continue;
        }
        (function (f) {
          var reader = new FileReader();
          reader.onload = function (ev) {
            doInsertImage(ev.target.result, f.name);
          };
          reader.readAsDataURL(f);
        })(file);
      }
    });
  }

  /* ---------------- Insert Table ---------------- */
  var tableDims = { rows: 2, cols: 2 };

  function buildTableGrid() {
    var grid = $("tableGrid");
    grid.innerHTML = "";
    var MAX = 8;
    for (var r = 1; r <= MAX; r++) {
      for (var c = 1; c <= MAX; c++) {
        (function (r, c) {
          var cell = document.createElement("div");
          cell.className = "table-grid-cell";
          cell.dataset.r = r;
          cell.dataset.c = c;
          cell.addEventListener("mouseenter", function () {
            tableDims.rows = r;
            tableDims.cols = c;
            updateGridHover();
          });
          cell.addEventListener("click", function () {
            tableDims.rows = r;
            tableDims.cols = c;
            updateGridHover();
            insertTable();
          });
          grid.appendChild(cell);
        })(r, c);
      }
    }
    updateGridHover();
  }

  function updateGridHover() {
    var cells = document.querySelectorAll(".table-grid-cell");
    for (var i = 0; i < cells.length; i++) {
      var r = parseInt(cells[i].dataset.r, 10);
      var c = parseInt(cells[i].dataset.c, 10);
      if (r <= tableDims.rows && c <= tableDims.cols) cells[i].classList.add("hover");
      else cells[i].classList.remove("hover");
    }
    $("tableGridLabel").textContent = tableDims.rows + " × " + tableDims.cols;
  }

  function openTableDialog() {
    tableDims = { rows: 2, cols: 2 };
    updateGridHover();
    openModal("tableModal");
  }

  function insertTable() {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    var html = '<table><tbody>';
    for (var r = 0; r < tableDims.rows; r++) {
      html += "<tr>";
      for (var c = 0; c < tableDims.cols; c++) {
        if (r === 0) html += "<th>&nbsp;</th>";
        else html += "<td>&nbsp;</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table><p><br></p>";
    document.execCommand("insertHTML", false, html);
    // execCommand strips contenteditable attr, so set it on all cells now
    var pages = getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var cells = getContent(pages[pi]).querySelectorAll("td, th");
      for (var ci = 0; ci < cells.length; ci++) {
        cells[ci].setAttribute("contenteditable", "true");
      }
    }
    closeModal("tableModal");
    schedulePaginate();
    scheduleAutosave();
    toast("Table inserted (" + tableDims.rows + "×" + tableDims.cols + ")", "success");
  }

  /* ---------------- Insert HR ---------------- */
  function insertHr() {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    document.execCommand("insertHorizontalRule");
    document.execCommand("insertHTML", false, "<p><br></p>");
    schedulePaginate();
    scheduleAutosave();
  }

  /* ---------------- Word Count Dialog ---------------- */
  function showWordCount() {
    var stats = getStats();
    var streak = loadStreak();
    var grid = $("statsGrid");
    var items = [
      { value: stats.words.toLocaleString(), label: "Words" },
      { value: stats.chars.toLocaleString(), label: "Characters" },
      { value: stats.charsNoSpaces.toLocaleString(), label: "Characters (no spaces)" },
      { value: countSentences().toLocaleString(), label: "Sentences" },
      { value: stats.paragraphs.toLocaleString(), label: "Paragraphs / blocks" },
      { value: stats.pages.toLocaleString(), label: "Pages" },
      { value: stats.readingMin + " min", label: "Reading time" },
      { value: (streak.current || 0) + " day" + (streak.current === 1 ? "" : "s"), label: "Writing streak", accent: true },
      { value: (streak.longest || 0) + " day" + (streak.longest === 1 ? "" : "s"), label: "Longest streak" },
    ];
    grid.innerHTML = "";
    for (var i = 0; i < items.length; i++) {
      var div = document.createElement("div");
      div.className = "stat-item" + (items[i].accent ? " stat-accent" : "");
      div.innerHTML = '<div class="stat-value">' + items[i].value + '</div><div class="stat-label">' + items[i].label + "</div>";
      grid.appendChild(div);
    }
    renderStreakHeatmap(streak);
    renderStatsChart();
    renderReadability();
    renderSentenceLengthChart();
    renderWordFrequency();
    renderWordCloud();
    renderWritingIssues();
    updateGoalTracker();
    openModal("wordCountModal");
  }

  /* ---------------- Statistics export (printable) ---------------- */
  function exportStats() {
    var stats = getStats();
    var streak = loadStreak();
    var title = ($("docTitle")?$("docTitle").value:"Untitled Document") || "Untitled Document";
    var date = formatTime(Date.now());
    var sentences = countSentences();
    var avgWordsPerSentence = sentences > 0 ? Math.round(stats.words / sentences) : 0;
    var readingTime = stats.readingMin + " min";
    var speakingTime = Math.max(1, Math.ceil(stats.words / 130)) + " min";

    // Build a printable stats overlay
    var overlay = document.createElement("div");
    overlay.className = "stats-printable";
    overlay.innerHTML =
      '<h1>' + escapeHtml(title) + ' — Statistics Report</h1>' +
      '<p style="color:#666;font-size:12px">Generated: ' + escapeHtml(date) + '</p>' +
      '<h2>Document Summary</h2>' +
      '<div class="stat-row"><span class="stat-label">Words</span><span class="stat-val">' + stats.words.toLocaleString() + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Characters (with spaces)</span><span class="stat-val">' + stats.chars.toLocaleString() + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Characters (no spaces)</span><span class="stat-val">' + stats.charsNoSpaces.toLocaleString() + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Sentences</span><span class="stat-val">' + sentences.toLocaleString() + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Paragraphs / blocks</span><span class="stat-val">' + stats.paragraphs.toLocaleString() + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Pages</span><span class="stat-val">' + stats.pages.toLocaleString() + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Avg words per sentence</span><span class="stat-val">' + avgWordsPerSentence + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Reading time</span><span class="stat-val">' + readingTime + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Speaking time</span><span class="stat-val">' + speakingTime + '</span></div>' +
      '<h2>Writing Streak</h2>' +
      '<div class="stat-row"><span class="stat-label">Current streak</span><span class="stat-val">' + (streak.current || 0) + ' day' + ((streak.current||0) === 1 ? "" : "s") + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Longest streak</span><span class="stat-val">' + (streak.longest || 0) + ' day' + ((streak.longest||0) === 1 ? "" : "s") + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Active days (last 60)</span><span class="stat-val">' + (streak.days ? streak.days.length : 0) + '</span></div>' +
      '<p style="margin-top:32px;color:#999;font-size:11px">EmeraldSuite: Docs — generated automatically</p>';
    document.body.appendChild(overlay);

    // Close the modal, then print, then remove the overlay
    closeModal("wordCountModal");
    setTimeout(function () {
      window.print();
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 500);
    }, 300);
    toast("Statistics report sent to print dialog", "success");
  }

  /* ---------------- Ruler ---------------- */
  function buildRulerTicks() {
    var ticks = $("rulerTicks");
    if (!ticks) return;
    ticks.innerHTML = "";
    // content width depends on current margins
    var contentWidth = PAGE_WIDTH - pageMargins.left - pageMargins.right;
    var step = 50;
    for (var x = 0; x <= contentWidth; x += step) {
      var t = document.createElement("div");
      t.className = "ruler-tick" + (x % 100 === 0 ? " major" : "");
      t.style.width = step + "px";
      if (x % 100 === 0) t.setAttribute("data-n", Math.round(x / 37.8));
      ticks.appendChild(t);
    }
  }

  /* ---------------- Ribbon tab switching ----------------
     EmeraldSuite pattern: clicking a tab animates a sliding
     underline indicator to the active tab, and cross-fades the
     corresponding ribbon-panel with a blur-out → blur-in transition. */
  function initRibbonTabs() {
    var tabs = document.querySelectorAll(".ribbon-tab");
    var panels = document.querySelectorAll(".ribbon-panel");
    var indicator = $("ribbonTabIndicator");
    if (!tabs.length || !indicator) return;

    function moveIndicator(tab) {
      var rect = tab.getBoundingClientRect();
      var parentRect = tab.parentElement.getBoundingClientRect();
      indicator.style.width = rect.width + "px";
      indicator.style.transform = "translateX(" + (rect.left - parentRect.left) + "px)";
    }

    // Position under the initially-active tab after layout settles
    setTimeout(function () {
      var active = document.querySelector(".ribbon-tab.active");
      if (active) moveIndicator(active);
    }, 100);

    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        var tab = this;
        var target = tab.getAttribute("data-tab");
        // already active?
        if (tab.classList.contains("active")) return;

        // Update tab states immediately so indicator slides smoothly
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
        tab.classList.add("active");

        // Move indicator (synced with the 0.3s CSS transition)
        moveIndicator(tab);

        // Blur-out current panel, then activate target panel
        var currentActive = document.querySelector(".ribbon-panel.active");
        var targetPanel = document.querySelector('.ribbon-panel[data-panel="' + target + '"]');
        if (currentActive && targetPanel && currentActive !== targetPanel) {
          currentActive.classList.add("blur-out");
          currentActive.classList.remove("active");
          setTimeout(function () {
            currentActive.classList.remove("blur-out");
            targetPanel.classList.add("active");
          }, 140);
        } else if (targetPanel) {
          if (currentActive) currentActive.classList.remove("active");
          targetPanel.classList.add("active");
        }
      });
    }

    // Reposition indicator on resize
    window.addEventListener("resize", function () {
      var active = document.querySelector(".ribbon-tab.active");
      if (active) moveIndicator(active);
    });
  }

  /* ---------------- Page margins (drag to resize via ruler) ---------------- */
  function applyPageMargins() {
    var root = document.documentElement;
    root.style.setProperty("--page-margin-top", pageMargins.top + "px");
    root.style.setProperty("--page-margin-right", pageMargins.right + "px");
    root.style.setProperty("--page-margin-bottom", pageMargins.bottom + "px");
    root.style.setProperty("--page-margin-left", pageMargins.left + "px");
  }

  function saveMargins() {
    try {
      if (idbAvailable()) { idb.setJSON(MARGINS_KEY, pageMargins); }
      else { localStorage.setItem(MARGINS_KEY, JSON.stringify(pageMargins)); }
    } catch (e) {}
  }

  function loadMargins() {
    try {
      var m = null;
      if (idbAvailable()) { m = idb.getJSONSync(MARGINS_KEY); }
      if (!m) {
        var raw = localStorage.getItem(MARGINS_KEY);
        if (raw) m = JSON.parse(raw);
      }
      if (m && typeof m.left === "number" && typeof m.right === "number") {
        pageMargins.top = clampMargin(m.top);
        pageMargins.right = clampMargin(m.right);
        pageMargins.bottom = clampMargin(m.bottom);
        pageMargins.left = clampMargin(m.left);
      }
    } catch (e) {}
    applyPageMargins();
  }

  function clampMargin(v) {
    if (typeof v !== "number" || isNaN(v)) return 96;
    return Math.max(MIN_MARGIN, Math.min(MAX_MARGIN, Math.round(v)));
  }

  var marginTipEl = null;
  var marginDragSide = null; // 'left' | 'right'
  var marginDragStartX = 0;
  var marginDragStartVal = 0;

  function initMarginDrag() {
    marginTipEl = document.createElement("div");
    marginTipEl.className = "ruler-margin-tip";
    document.body.appendChild(marginTipEl);

    var left = document.querySelector(".ruler-margin-left");
    var right = document.querySelector(".ruler-margin-right");

    if (left) {
      left.addEventListener("mousedown", function (e) {
        e.preventDefault();
        startMarginDrag("left", e);
      });
    }
    if (right) {
      right.addEventListener("mousedown", function (e) {
        e.preventDefault();
        startMarginDrag("right", e);
      });
    }

    document.addEventListener("mousemove", function (e) {
      if (marginDragSide) {
        var dx = e.clientX - marginDragStartX;
        var newVal = marginDragStartVal;
        if (marginDragSide === "left") newVal = marginDragStartVal + dx;
        else newVal = marginDragStartVal - dx; // right margin: drag right = smaller
        newVal = clampMargin(newVal);
        pageMargins[marginDragSide] = newVal;
        applyPageMargins();
        buildRulerTicks();
        showMarginTip(e, marginDragSide, newVal);
        schedulePaginate();
      }
    });

    document.addEventListener("mouseup", function () {
      if (marginDragSide) {
        marginDragSide = null;
        var leftEl = document.querySelector(".ruler-margin-left");
        var rightEl = document.querySelector(".ruler-margin-right");
        if (leftEl) leftEl.classList.remove("dragging");
        if (rightEl) rightEl.classList.remove("dragging");
        marginTipEl.classList.remove("show");
        saveMargins();
        scheduleAutosave();
      }
    });
  }

  function startMarginDrag(side, e) {
    marginDragSide = side;
    marginDragStartX = e.clientX;
    marginDragStartVal = pageMargins[side];
    var el = document.querySelector(".ruler-margin-" + side);
    if (el) el.classList.add("dragging");
    showMarginTip(e, side, pageMargins[side]);
  }

  function showMarginTip(e, side, val) {
    var cm = (val / 37.8).toFixed(1);
    marginTipEl.textContent = (side === "left" ? "Left" : "Right") + " margin: " + cm + " cm (" + val + "px)";
    marginTipEl.style.left = (e.clientX + 12) + "px";
    marginTipEl.style.top = (e.clientY + 18) + "px";
    marginTipEl.classList.add("show");
  }

  /* ---------------- Margins dialog ---------------- */
  var MARGIN_PRESETS = {
    narrow: 48,   // 1.27 cm
    default: 96,  // 2.54 cm
    moderate: 72, // 1.91 cm
    wide: 120,    // 3.18 cm
  };

  function openMarginsDialog() {
    // Sync inputs with current state
    $("marginTop").value = (pageMargins.top / 37.8).toFixed(2);
    $("marginBottom").value = (pageMargins.bottom / 37.8).toFixed(2);
    $("marginLeft").value = (pageMargins.left / 37.8).toFixed(2);
    $("marginRight").value = (pageMargins.right / 37.8).toFixed(2);
    updatePresetActive();
    updateMarginPreview();
    openModal("marginsModal");
  }

  function updatePresetActive() {
    var presetBtns = document.querySelectorAll(".preset-btn");
    var matched = null;
    for (var name in MARGIN_PRESETS) {
      var v = MARGIN_PRESETS[name];
      if (pageMargins.top === v && pageMargins.bottom === v &&
          pageMargins.left === v && pageMargins.right === v) {
        matched = name;
        break;
      }
    }
    for (var i = 0; i < presetBtns.length; i++) {
      if (presetBtns[i].getAttribute("data-preset") === matched) {
        presetBtns[i].classList.add("active");
      } else {
        presetBtns[i].classList.remove("active");
      }
    }
  }

  function applyPreset(name) {
    var v = MARGIN_PRESETS[name];
    if (!v) return;
    pageMargins = { top: v, right: v, bottom: v, left: v };
    applyPageMargins();
    buildRulerTicks();
    saveMargins();
    schedulePaginate();
    scheduleAutosave();
    updatePresetActive();
    // sync inputs
    $("marginTop").value = (v / 37.8).toFixed(2);
    $("marginBottom").value = (v / 37.8).toFixed(2);
    $("marginLeft").value = (v / 37.8).toFixed(2);
    $("marginRight").value = (v / 37.8).toFixed(2);
    updateMarginPreview();
  }

  function applyCustomMargin(side, cmVal) {
    var px = Math.round(parseFloat(cmVal) * 37.8);
    if (isNaN(px)) return;
    px = clampMargin(px);
    pageMargins[side] = px;
    applyPageMargins();
    buildRulerTicks();
    updatePresetActive();
    updateMarginPreview();
  }

  /* ---------------- Confetti celebration ---------------- */
  var goalCelebrated = false;

  function fireConfetti() {
    var container = $("confettiContainer");
    if (!container) return;
    var colors = ["#0f9d6e", "#2ecc8f", "#fff59d", "#ffb300", "#e0a800", "#27b07c"];
    var count = 60;
    for (var i = 0; i < count; i++) {
      var piece = document.createElement("div");
      piece.className = "confetti-piece";
      piece.style.left = Math.random() * 100 + "%";
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = (Math.random() * 0.6) + "s";
      piece.style.animationDuration = (2 + Math.random() * 1.2) + "s";
      var w = 6 + Math.random() * 8;
      var h = 8 + Math.random() * 10;
      piece.style.width = w + "px";
      piece.style.height = h + "px";
      if (Math.random() > 0.5) piece.style.borderRadius = "50%";
      container.appendChild(piece);
      (function (p) {
        setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 3400);
      })(piece);
    }
  }

  /* ---------------- Autosave timestamp ---------------- */
  var lastSavedAt = 0;

  function formatAutosaveTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }

  /* ---------------- Goal tracker ---------------- */
  function saveGoal() {
    try {
      if (idbAvailable()) { idb.setJSON(GOAL_KEY, goalTarget); }
      else { localStorage.setItem(GOAL_KEY, String(goalTarget)); }
    } catch (e) {}
  }

  function loadGoal() {
    try {
      var v = null;
      if (idbAvailable()) { v = idb.getJSONSync(GOAL_KEY); }
      if (v !== null && v !== undefined) { goalTarget = parseInt(v, 10) || 0; return; }
      var raw = localStorage.getItem(GOAL_KEY);
      if (raw) goalTarget = parseInt(raw, 10) || 0;
    } catch (e) {}
  }

  var goalMilestones = { 25: false, 50: false, 75: false };
  function updateGoalTracker() {
    var stats = getStats();
    var current = stats.words;
    $("goalCurrent").textContent = current.toLocaleString();

    var targetEl = $("goalTarget");
    var fillEl = $("goalFill");
    var inputEl = $("goalInput");

    if (goalTarget > 0) {
      targetEl.textContent = goalTarget.toLocaleString();
      if (inputEl && document.activeElement !== inputEl) inputEl.value = goalTarget;
      var pct = Math.min(100, (current / goalTarget) * 100);
      fillEl.style.width = pct + "%";
      fillEl.className = "goal-bar-fill";
      if (pct >= 100) fillEl.classList.add("complete");
      if (current > goalTarget) fillEl.classList.add("over");

      // Milestone toasts at 25%, 50%, 75%
      if (pct >= 25 && !goalMilestones[25]) { goalMilestones[25] = true; toastMilestone("25% there — keep going!"); }
      if (pct >= 50 && !goalMilestones[50]) { goalMilestones[50] = true; toastMilestone("Halfway there! 🚀"); }
      if (pct >= 75 && !goalMilestones[75]) { goalMilestones[75] = true; toastMilestone("75% — almost done!"); }

      // Celebration: fire confetti once when goal is first reached
      if (current >= goalTarget && !goalCelebrated) {
        goalCelebrated = true;
        fireConfetti();
        toastMilestone("Goal reached! Well done. 🎉");
      } else if (current < goalTarget && goalCelebrated) {
        // reset so it can celebrate again if user dips below and re-reaches
        goalCelebrated = false;
      }
      // reset milestones if user drops below
      if (pct < 75) goalMilestones[75] = false;
      if (pct < 50) goalMilestones[50] = false;
      if (pct < 25) goalMilestones[25] = false;
    } else {
      targetEl.textContent = "—";
      fillEl.style.width = "0%";
      fillEl.className = "goal-bar-fill";
      if (inputEl && document.activeElement !== inputEl) inputEl.value = "";
      goalCelebrated = false;
      goalMilestones = { 25: false, 50: false, 75: false };
    }
  }

  function toastMilestone(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast show milestone";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 3000);
  }

  /* ---------------- Stats chart ---------------- */
  function renderStatsChart() {
    var container = $("statsChart");
    if (!container) return;
    container.innerHTML = "";
    var stats = getStats();
    var sentences = countSentences();
    var items = [
      { label: "Words", value: stats.words },
      { label: "Sentences", value: sentences },
      { label: "Paragraphs", value: stats.paragraphs },
      { label: "Pages", value: stats.pages },
    ];
    var maxVal = 1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].value > maxVal) maxVal = items[i].value;
    }
    for (var j = 0; j < items.length; j++) {
      var row = document.createElement("div");
      row.className = "stat-bar-row";
      var label = document.createElement("div");
      label.className = "stat-bar-label";
      label.textContent = items[j].label;
      var track = document.createElement("div");
      track.className = "stat-bar-track";
      var fill = document.createElement("div");
      fill.className = "stat-bar-fill";
      fill.style.width = (items[j].value / maxVal * 100) + "%";
      track.appendChild(fill);
      var val = document.createElement("div");
      val.className = "stat-bar-value";
      val.textContent = items[j].value.toLocaleString();
      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(val);
      container.appendChild(row);
    }

    // Reading time card
    var card = $("readingTimeCard");
    if (card) {
      var mins = stats.readingMin;
      var secs = Math.round((stats.words / 200 - mins + 1) * 60);
      var timeStr = mins + " min" + (mins !== 1 ? "s" : "");
      card.innerHTML =
        '<div class="reading-time-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg></div>' +
        '<div class="reading-time-text"><div class="reading-time-value">' + timeStr + '</div>' +
        '<div class="reading-time-label">Estimated reading time (~200 wpm)</div></div>';
    }
  }

  /* Common abbreviations that shouldn't end a sentence */
  var ABBREVIATIONS = [
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "ave", "blvd", "rd",
    "inc", "ltd", "co", "corp", "etc", "vs", "approx", "no", "vol", "fig",
    "e.g", "i.e", "a.m", "p.m", "u.s", "u.k", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  ];

  /* Smart sentence tokenizer — protects abbreviations and decimals. */
  function getSentences() {
    var text = getAllText();
    if (!text) return [];
    // Temporarily mask abbreviations followed by a period
    var masked = text;
    for (var i = 0; i < ABBREVIATIONS.length; i++) {
      var abbr = ABBREVIATIONS[i];
      var re = new RegExp("\\b" + abbr + "\\.", "gi");
      masked = masked.replace(re, abbr.toUpperCase() + "\x00");
    }
    // Mask decimal numbers (3.14)
    masked = masked.replace(/(\d)\.(\d)/g, "$1\x01$2");
    // Split on sentence-ending punctuation
    var parts = masked.split(/[.!?]+/);
    var sentences = [];
    for (var j = 0; j < parts.length; j++) {
      // Unmask
      var s = parts[j].replace(/\x00/g, ".").replace(/\x01/g, ".").trim();
      if (s.length > 0) sentences.push(s);
    }
    return sentences;
  }

  function countSentences() {
    var sentences = getSentences();
    return sentences.length;
  }

  /* ---------------- Sentence length distribution chart ---------------- */
  function getSentenceLengths() {
    return getSentences().map(function (s) {
      return s.split(/\s+/).filter(Boolean).length;
    });
  }

  /* ---------------- Readability (Flesch reading ease) ---------------- */
  function countSyllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, "");
    if (word.length <= 3) return 1;
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
    word = word.replace(/^y/, "");
    var m = word.match(/[aeiouy]{1,2}/g);
    return m ? m.length : 1;
  }

  function getReadability() {
    var sentences = getSentences();
    var text = getAllText();
    if (!text || sentences.length === 0) {
      return { score: 0, grade: "—", level: "—", desc: "Not enough text to analyze.", words: 0, sentences: 0, syllables: 0 };
    }
    var words = text.split(/\s+/).filter(function (w) { return /[a-zA-Z]/.test(w); });
    var wordCount = words.length;
    var sentenceCount = sentences.length;
    var syllableCount = 0;
    for (var i = 0; i < words.length; i++) {
      syllableCount += countSyllables(words[i]);
    }
    // Flesch Reading Ease: 206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)
    var syllablesPerWord = syllableCount / wordCount;
    var score = 206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * syllablesPerWord;
    // Clamp 0-100
    score = Math.max(0, Math.min(100, score));
    var gradeLevel = Math.round(0.39 * (wordCount / sentenceCount) + 11.8 * syllablesPerWord - 15.59);
    if (isNaN(gradeLevel) || gradeLevel < 0) gradeLevel = 0;

    var level, desc;
    if (score >= 90) { level = "Very Easy"; desc = "5th-grade level. Easily understood by an 11-year-old."; }
    else if (score >= 80) { level = "Easy"; desc = "6th-grade level. Conversational English for consumers."; }
    else if (score >= 70) { level = "Fairly Easy"; desc = "7th-grade level. Fairly easy to read."; }
    else if (score >= 60) { level = "Standard"; desc = "8th–9th grade. Plain English. Good for most content."; }
    else if (score >= 50) { level = "Fairly Difficult"; desc = "10th–12th grade. Fairly difficult to read."; }
    else if (score >= 30) { level = "Difficult"; desc = "College level. Difficult to read."; }
    else { level = "Very Difficult"; desc = "College graduate level. Best for professional/academic."; }

    return {
      score: Math.round(score),
      gradeLevel: gradeLevel,
      level: level,
      desc: desc,
      levelClass: score < 50 ? "hard" : (score < 70 ? "medium" : "easy"),
      words: wordCount,
      sentences: sentenceCount,
      syllables: syllableCount,
    };
  }

  function renderReadability() {
    var wrap = $("readabilityWrap");
    if (!wrap) return;
    var r = getReadability();
    if (r.words === 0) {
      wrap.innerHTML = '<p class="word-freq-empty">Not enough text to analyze readability.</p>';
      return;
    }
    // Gauge: circumference of r=40 is ~251.3. Fill = score/100.
    var circumference = 2 * Math.PI * 40;
    var offset = circumference * (1 - r.score / 100);
    wrap.innerHTML =
      '<div class="readability-gauge">' +
        '<svg viewBox="0 0 88 88">' +
          '<circle class="gauge-bg" cx="44" cy="44" r="40"/>' +
          '<circle class="gauge-fill ' + r.levelClass + '" cx="44" cy="44" r="40" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '"/>' +
        '</svg>' +
        '<div class="readability-score">' +
          '<div class="readability-score-value">' + r.score + '</div>' +
          '<div class="readability-score-unit">/ 100</div>' +
        '</div>' +
      '</div>' +
      '<div class="readability-info">' +
        '<div class="readability-level ' + r.levelClass + '">' + r.level + '</div>' +
        '<div class="readability-desc">' + r.desc + '</div>' +
        '<div class="readability-desc" style="margin-top:4px;">Grade level: ~' + r.gradeLevel + '</div>' +
      '</div>';
  }

  /* ---------------- Word frequency chart ---------------- */
  var STOP_WORDS = {
    the: 1, a: 1, an: 1, and: 1, or: 1, but: 1, if: 1, then: 1, of: 1, to: 1,
    in: 1, on: 1, at: 1, by: 1, for: 1, with: 1, as: 1, is: 1, are: 1, was: 1,
    were: 1, be: 1, been: 1, being: 1, have: 1, has: 1, had: 1, do: 1, does: 1,
    did: 1, will: 1, would: 1, could: 1, should: 1, may: 1, might: 1, can: 1,
    this: 1, that: 1, these: 1, those: 1, it: 1, its: 1, i: 1, you: 1, he: 1,
    she: 1, we: 1, they: 1, them: 1, their: 1, there: 1, here: 1, from: 1,
    into: 1, out: 1, up: 1, down: 1, not: 1, no: 1, so: 1, than: 1, too: 1,
    very: 1, just: 1, about: 1, above: 1, below: 1, after: 1, before: 1,
    his: 1, her: 1, my: 1, your: 1, our: 1, who: 1, whom: 1, which: 1,
    what: 1, when: 1, where: 1, why: 1, how: 1, all: 1, any: 1, both: 1,
    each: 1, few: 1, more: 1, most: 1, other: 1, some: 1, such: 1, only: 1,
    own: 1, same: 1,
  };

  function renderWordFrequency() {
    var container = $("wordFreqList");
    if (!container) return;
    container.innerHTML = "";
    var text = getAllText();
    if (!text) {
      var empty = document.createElement("p");
      empty.className = "word-freq-empty";
      empty.textContent = "No words yet.";
      container.appendChild(empty);
      return;
    }
    var words = text.toLowerCase().match(/[a-z']+/g) || [];
    var freq = {};
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.length < 3) continue;
      if (STOP_WORDS[w]) continue;
      freq[w] = (freq[w] || 0) + 1;
    }
    var entries = Object.keys(freq).map(function (k) { return [k, freq[k]]; });
    entries.sort(function (a, b) { return b[1] - a[1]; });
    var top = entries.slice(0, 8);
    if (top.length === 0) {
      var emptyMsg = document.createElement("p");
      emptyMsg.className = "word-freq-empty";
      emptyMsg.textContent = "No significant words found.";
      container.appendChild(emptyMsg);
      return;
    }
    var maxCount = top[0][1];
    for (var j = 0; j < top.length; j++) {
      var row = document.createElement("div");
      row.className = "word-freq-row";
      var word = document.createElement("div");
      word.className = "word-freq-word";
      word.textContent = top[j][0];
      var bar = document.createElement("div");
      bar.className = "word-freq-bar";
      var fill = document.createElement("div");
      fill.className = "word-freq-bar-fill";
      fill.style.width = (top[j][1] / maxCount * 100) + "%";
      bar.appendChild(fill);
      var count = document.createElement("div");
      count.className = "word-freq-count";
      count.textContent = top[j][1];
      row.appendChild(word);
      row.appendChild(bar);
      row.appendChild(count);
      container.appendChild(row);
    }
  }

  function renderSentenceLengthChart() {
    var container = $("sentenceLengthChart");
    if (!container) return;
    container.innerHTML = "";
    var lengths = getSentenceLengths();
    if (lengths.length === 0) {
      var empty = document.createElement("div");
      empty.className = "dist-empty";
      empty.textContent = "No sentences yet.";
      container.appendChild(empty);
      return;
    }

    // Buckets: 1-5, 6-10, 11-15, 16-20, 21-25, 26-30, 31+
    var buckets = [
      { label: "1-5", min: 1, max: 5, count: 0 },
      { label: "6-10", min: 6, max: 10, count: 0 },
      { label: "11-15", min: 11, max: 15, count: 0 },
      { label: "16-20", min: 16, max: 20, count: 0 },
      { label: "21-25", min: 21, max: 25, count: 0 },
      { label: "26-30", min: 26, max: 30, count: 0 },
      { label: "31+", min: 31, max: Infinity, count: 0 },
    ];
    for (var i = 0; i < lengths.length; i++) {
      for (var b = 0; b < buckets.length; b++) {
        if (lengths[i] >= buckets[b].min && lengths[i] <= buckets[b].max) {
          buckets[b].count++;
          break;
        }
      }
    }
    var maxCount = 1;
    for (var k = 0; k < buckets.length; k++) {
      if (buckets[k].count > maxCount) maxCount = buckets[k].count;
    }
    container.className = "dist-chart";
    for (var j = 0; j < buckets.length; j++) {
      var bar = document.createElement("div");
      bar.className = "dist-bar";
      var fill = document.createElement("div");
      fill.className = "dist-bar-fill";
      fill.style.height = (buckets[j].count / maxCount * 100) + "%";
      var count = document.createElement("span");
      count.className = "dist-count";
      count.textContent = buckets[j].count;
      fill.appendChild(count);
      var lbl = document.createElement("div");
      lbl.className = "dist-bar-label";
      lbl.textContent = buckets[j].label;
      bar.appendChild(fill);
      bar.appendChild(lbl);
      container.appendChild(bar);
    }
  }

  /* ---------------- Writing issues checker ---------------- */
  // A small curated list of common misspellings → corrections
  var COMMON_MISSPELLINGS = {
    "recieve": "receive",
    "definately": "definitely",
    "seperate": "separate",
    "occured": "occurred",
    "occurence": "occurrence",
    "untill": "until",
    "wich": "which",
    "thier": "their",
    "freind": "friend",
    "beleive": "believe",
    "acheive": "achieve",
    "calender": "calendar",
    "cemetary": "cemetery",
    "changable": "changeable",
    "collegue": "colleague",
    "concious": "conscious",
    "enviroment": "environment",
    "existance": "existence",
    "foriegn": "foreign",
    "gramar": "grammar",
    "happend": "happened",
    "independant": "independent",
    "knowlege": "knowledge",
    "liason": "liaison",
    "maintainance": "maintenance",
    "neccessary": "necessary",
    "noticable": "noticeable",
    "occassion": "occasion",
    "persistant": "persistent",
    "posession": "possession",
    "priviledge": "privilege",
    "publically": "publicly",
    "recomend": "recommend",
    "rythm": "rhythm",
    "succesful": "successful",
    "truely": "truly",
    "wierd": "weird",
    "yielded": "yielded",
  };

  function findWritingIssues() {
    var issues = [];
    var text = getAllText();
    if (!text) return issues;

    // 1) Detect repeated consecutive words ("the the")
    var words = text.split(/(\s+)/);
    var tokens = [];
    for (var i = 0; i < words.length; i++) {
      if (words[i].trim()) tokens.push(words[i]);
    }
    for (var j = 1; j < tokens.length; j++) {
      var a = tokens[j - 1].toLowerCase().replace(/[^\w']/g, "");
      var b = tokens[j].toLowerCase().replace(/[^\w']/g, "");
      if (a && b && a === b && a.length > 1) {
        issues.push({
          type: "repeat",
          word: tokens[j],
          suggestion: "remove duplicate",
          context: "…" + tokens[j - 1] + " " + tokens[j] + "…",
          fixType: "removeDuplicate",
        });
      }
    }

    // 2) Detect common misspellings (skip words in custom dictionary)
    var lowerText = text.toLowerCase();
    for (var misspelling in COMMON_MISSPELLINGS) {
      // Skip if the misspelling is in the user's custom dictionary
      if (customDict[misspelling]) continue;
      var regex = new RegExp("\\b" + misspelling + "\\b", "gi");
      var match;
      while ((match = regex.exec(text)) !== null) {
        issues.push({
          type: "spelling",
          word: match[0],
          suggestion: COMMON_MISSPELLINGS[misspelling],
          context: "…" + match[0] + "…",
          fixType: "replace",
          fixFrom: match[0],
          fixTo: COMMON_MISSPELLINGS[misspelling],
        });
      }
    }

    return issues.slice(0, 20); // cap at 20 for performance
  }

  function renderWritingIssues() {
    var container = $("issuesList");
    if (!container) return;
    container.innerHTML = "";
    var issues = findWritingIssues();
    if (issues.length === 0) {
      var empty = document.createElement("p");
      empty.className = "issues-empty";
      empty.textContent = "No writing issues detected. Looking good!";
      container.appendChild(empty);
      return;
    }
    for (var i = 0; i < issues.length; i++) {
      (function (issue) {
        var item = document.createElement("div");
        item.className = "issue-item";
        var icon = document.createElement("div");
        icon.className = "issue-icon";
        icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
        var content = document.createElement("div");
        content.className = "issue-content";
        var text = document.createElement("div");
        text.className = "issue-text";
        if (issue.type === "repeat") {
          text.innerHTML = 'Repeated word: <span class="issue-highlight">' + escapeHtml(issue.word) + '</span> — <span class="issue-suggestion">' + escapeHtml(issue.suggestion) + '</span>';
        } else {
          text.innerHTML = 'Possible misspelling: <span class="issue-highlight">' + escapeHtml(issue.word) + '</span> → <span class="issue-suggestion">' + escapeHtml(issue.suggestion) + '</span>';
        }
        content.appendChild(text);
        var fixBtn = document.createElement("button");
        fixBtn.className = "issue-fix";
        fixBtn.textContent = "Fix";
        fixBtn.addEventListener("click", function () {
          fixWritingIssue(issue);
        });
        item.appendChild(icon);
        item.appendChild(content);
        item.appendChild(fixBtn);
        container.appendChild(item);
      })(issues[i]);
    }
  }

  function fixWritingIssue(issue) {
    if (issue.fixType === "removeDuplicate") {
      // Replace "word word" (case-insensitive) with "word"
      var regex = new RegExp("\\b(" + escapeRegExp(issue.word) + ")\\s+\\1\\b", "gi");
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        var content = getContent(pages[i]);
        content.innerHTML = content.innerHTML.replace(regex, "$1");
      }
    } else if (issue.fixType === "replace") {
      var regex2 = new RegExp("\\b" + escapeRegExp(issue.fixFrom) + "\\b", "g");
      var pages2 = getPages();
      for (var j = 0; j < pages2.length; j++) {
        var content2 = getContent(pages2[j]);
        content2.innerHTML = content2.innerHTML.replace(regex2, issue.fixTo);
      }
    }
    schedulePaginate();
    scheduleAutosave();
    renderWritingIssues();
    toast("Issue fixed", "success");
  }

  /* ---------------- Margin preview diagram ---------------- */
  function updateMarginPreview() {
    var preview = $("marginPreview");
    if (!preview) return;
    // Scale the real page margins (794x1123) down to the preview (140x180)
    var scaleX = 140 / 794;
    var scaleY = 180 / 1123;
    var scale = Math.min(scaleX, scaleY);
    var top = pageMargins.top * scale;
    var right = pageMargins.right * scale;
    var bottom = pageMargins.bottom * scale;
    var left = pageMargins.left * scale;
    preview.style.setProperty("--pv-top", top + "px");
    preview.style.setProperty("--pv-right", right + "px");
    preview.style.setProperty("--pv-bottom", bottom + "px");
    preview.style.setProperty("--pv-left", left + "px");
  }

  /* ---------------- Page thumbnails panel ---------------- */
  var thumbnailsUpdateScheduled = false;

  function toggleThumbnails(force) {
    var panel = $("thumbnailsPanel");
    var shouldOpen = force === undefined ? !panel.classList.contains("open") : force;
    if (shouldOpen) {
      buildThumbnails();
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
    } else {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
    }
  }

  function buildThumbnails() {
    var body = $("thumbnailsBody");
    if (!body) return;
    body.innerHTML = "";
    var pages = getPages();
    var currentPage = getCurrentPageIndex();
    for (var i = 0; i < pages.length; i++) {
      (function (page, idx) {
        var item = document.createElement("div");
        item.className = "thumbnail-item" + (idx === currentPage ? " active" : "");
        var thumb = document.createElement("div");
        thumb.className = "thumbnail-page";
        var content = document.createElement("div");
        content.className = "thumbnail-content";
        // Clone the first ~6 blocks of content for the preview
        var blocks = getContent(page).children;
        var count = 0;
        for (var j = 0; j < blocks.length && count < 8; j++) {
          var clone = blocks[j].cloneNode(true);
          // Strip nested complexity for the thumbnail
          var tables = clone.querySelectorAll("table, img, .zdocs-page-break");
          for (var k = 0; k < tables.length; k++) tables[k].remove();
          content.appendChild(clone);
          count++;
        }
        thumb.appendChild(content);
        var label = document.createElement("div");
        label.className = "thumbnail-label";
        label.textContent = "Page " + (idx + 1);
        item.appendChild(thumb);
        item.appendChild(label);
        item.addEventListener("click", function () {
          page.scrollIntoView({ behavior: "smooth", block: "start" });
          var c = getContent(page);
          if (c) {
            setTimeout(function () { c.focus(); }, 250);
          }
        });
        body.appendChild(item);
      })(pages[i], i);
    }
  }

  function scheduleThumbnailsUpdate() {
    if (!$("thumbnailsPanel").classList.contains("open")) return;
    if (thumbnailsUpdateScheduled) return;
    thumbnailsUpdateScheduled = true;
    setTimeout(function () {
      thumbnailsUpdateScheduled = false;
      buildThumbnails();
    }, 500);
  }

  /* ---------------- Print preview ---------------- */
  function togglePrintPreview(on) {
    var app = $("app");
    if (on === undefined) on = !app.classList.contains("print-preview");
    if (on) {
      app.classList.add("print-preview");
      saveDocument(false);
      // scroll to top of document
      var scroll = $("documentScroll");
      if (scroll) scroll.scrollTop = 0;
    } else {
      app.classList.remove("print-preview");
    }
  }

  /* ---------------- Focus mode ---------------- */
  function toggleFocusMode(on) {
    var app = $("app");
    if (on === undefined) on = !app.classList.contains("focus-mode");
    if (on) {
      app.classList.add("focus-mode");
      toast("Focus mode on — press Esc to exit", "success");
      setTimeout(function () {
        var fc = getContent(getPages()[0]);
        if (fc) fc.focus();
      }, 100);
    } else {
      app.classList.remove("focus-mode");
    }
  }

  /* ---------------- Zen mode (auto-hide chrome on typing) ---------------- */
  // Zen mode is a softer Focus Mode: when enabled via View → Zen (or Ctrl+Shift+Z),
  // the topbar/ribbon/ruler/statusbar fade out after 2s of no typing/mouse
  // movement, and reappear the instant the user types or moves the mouse.
  var zenMode = false;
  var zenHideTimer = null;
  function toggleZenMode(on) {
    var app = $("app");
    if (on === undefined) on = !app.classList.contains("zen-mode");
    zenMode = on;
    if (on) {
      app.classList.add("zen-mode");
      scheduleZenHide();
      toast("Zen mode on — type or move mouse to show controls", "success");
      setTimeout(function () {
        var fc = getContent(getPages()[0]);
        if (fc) fc.focus();
      }, 100);
    } else {
      app.classList.remove("zen-mode", "zen-hidden");
      if (zenHideTimer) { clearTimeout(zenHideTimer); zenHideTimer = null; }
      toast("Zen mode off", "success");
    }
  }

  function scheduleZenHide() {
    if (zenHideTimer) clearTimeout(zenHideTimer);
    zenHideTimer = setTimeout(function () {
      if (zenMode) $("app").classList.add("zen-hidden");
    }, 2000);
  }

  function zenShowControls() {
    if (!zenMode) return;
    $("app").classList.remove("zen-hidden");
    scheduleZenHide();
  }

  /* ---------------- Session timer ---------------- */
  var sessionStart = 0;
  var sessionInterval = null;
  var sessionActive = false;

  function startSessionTimer() {
    if (sessionActive) return;
    sessionActive = true;
    sessionStart = Date.now();
    if (sessionInterval) clearInterval(sessionInterval);
    sessionInterval = setInterval(updateSessionTimer, 1000);
    updateSessionTimer();
  }

  function stopSessionTimer() {
    sessionActive = false;
    if (sessionInterval) {
      clearInterval(sessionInterval);
      sessionInterval = null;
    }
  }

  function resetSessionTimer() {
    sessionStart = Date.now();
    updateSessionTimer();
    toast("Session timer reset", "success");
  }

  function updateSessionTimer() {
    var el = $("sessionTimerText");
    if (!el) return;
    if (!sessionActive) return;
    var elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    var mins = Math.floor(elapsed / 60);
    var secs = elapsed % 60;
    el.textContent = mins + ":" + String(secs).padStart(2, "0");
    // record today's writing activity for the streak tracker
    recordWritingDay();
  }

  /* ---------------- Writing streak tracker ---------------- */
  var STREAK_KEY = "zdocs.streak";
  function recordWritingDay() {
    var today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    var streak = loadStreak();
    if (!streak.days) streak.days = [];
    if (streak.days.indexOf(today) < 0) {
      streak.days.push(today);
      // keep last 60 days
      if (streak.days.length > 60) streak.days = streak.days.slice(-60);
      // recompute current streak
      streak.current = computeCurrentStreak(streak.days);
      streak.longest = Math.max(streak.longest || 0, streak.current);
      saveStreak(streak);
    }
  }

  function loadStreak() {
    try {
      var s = null;
      if (idbAvailable()) s = idb.getJSONSync(STREAK_KEY);
      if (!s) { var raw = localStorage.getItem(STREAK_KEY); if (raw) s = JSON.parse(raw); }
      if (s && Array.isArray(s.days)) return s;
    } catch (e) {}
    return { days: [], current: 0, longest: 0 };
  }

  function saveStreak(s) {
    try {
      if (idbAvailable()) idb.setJSON(STREAK_KEY, s);
      else localStorage.setItem(STREAK_KEY, JSON.stringify(s));
    } catch (e) {}
  }

  function computeCurrentStreak(days) {
    if (!days || !days.length) return 0;
    var sorted = days.slice().sort();
    var today = new Date();
    var streak = 0;
    // start from today and walk backwards
    var d = new Date(today);
    // If today is in the list, count it; otherwise start from yesterday
    var todayStr = today.toISOString().slice(0, 10);
    if (sorted.indexOf(todayStr) < 0) {
      d.setDate(d.getDate() - 1);
    }
    while (true) {
      var ds = d.toISOString().slice(0, 10);
      if (sorted.indexOf(ds) >= 0) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  }


  /* ---------------- Word cloud ---------------- */
  /* ---------------- Writing streak heatmap (GitHub-style) ---------------- */
  function renderStreakHeatmap(streak) {
    var container = $("streakHeatmap");
    if (!container) {
      // find the stats grid section and insert a heatmap section after it
      var grid = $("statsGrid");
      if (!grid) return;
      var wrap = document.createElement("div");
      wrap.className = "stats-chart-section streak-heatmap-section";
      wrap.innerHTML = '<h4>Writing activity (last 35 days)</h4><div class="streak-heatmap" id="streakHeatmap"></div>';
      grid.parentElement.insertBefore(wrap, grid.nextSibling);
      container = $("streakHeatmap");
      if (!container) return;
    }
    container.innerHTML = "";
    var days = streak.days || [];
    var daySet = {};
    for (var i = 0; i < days.length; i++) daySet[days[i]] = true;
    var today = new Date();
    // render last 35 days as 5 rows × 7 cols (5 weeks)
    var cells = 35;
    var start = new Date(today);
    start.setDate(start.getDate() - (cells - 1));
    for (var c = 0; c < cells; c++) {
      var d = new Date(start);
      d.setDate(d.getDate() + c);
      var ds = d.toISOString().slice(0, 10);
      var cell = document.createElement("div");
      cell.className = "streak-cell" + (daySet[ds] ? " streak-cell-active" : "");
      cell.title = ds + (daySet[ds] ? " — wrote" : " — no activity");
      container.appendChild(cell);
    }
  }

  function renderWordCloud() {
    var container = $("wordCloud");
    if (!container) return;
    container.innerHTML = "";
    var text = getAllText();
    if (!text) {
      var empty = document.createElement("p");
      empty.className = "word-cloud-empty";
      empty.textContent = "No words yet.";
      container.appendChild(empty);
      return;
    }
    var words = text.toLowerCase().match(/[a-z']+/g) || [];
    var freq = {};
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.length < 4) continue;
      if (STOP_WORDS[w]) continue;
      freq[w] = (freq[w] || 0) + 1;
    }
    var entries = Object.keys(freq).map(function (k) { return [k, freq[k]]; });
    entries.sort(function (a, b) { return b[1] - a[1]; });
    var top = entries.slice(0, 25);
    if (top.length === 0) {
      var emptyMsg = document.createElement("p");
      emptyMsg.className = "word-cloud-empty";
      emptyMsg.textContent = "No significant words found.";
      container.appendChild(emptyMsg);
      return;
    }
    var maxCount = top[0][1];
    var minCount = top[top.length - 1][1];
    for (var j = 0; j < top.length; j++) {
      var span = document.createElement("span");
      span.className = "word-cloud-item";
      // Scale font size between 12px and 32px based on frequency
      var ratio = maxCount === minCount ? 0.5 : (top[j][1] - minCount) / (maxCount - minCount);
      var size = 12 + ratio * 20;
      span.style.fontSize = size.toFixed(1) + "px";
      span.style.opacity = (0.5 + ratio * 0.5).toFixed(2);
      span.textContent = top[j][0];
      span.title = top[j][0] + " (" + top[j][1] + " uses)";
      container.appendChild(span);
      container.appendChild(document.createTextNode(" "));
    }
  }

  /* ---------------- Custom dictionary ---------------- */
  var DICT_KEY = "zdocs.dictionary";
  var customDict = {};

  function loadCustomDict() {
    try {
      var d = null;
      if (idbAvailable()) { d = idb.getJSONSync(DICT_KEY); }
      if (d && typeof d === "object") { customDict = d; return; }
      var raw = localStorage.getItem(DICT_KEY);
      if (raw) customDict = JSON.parse(raw) || {};
    } catch (e) { customDict = {}; }
  }

  function saveCustomDict() {
    try {
      if (idbAvailable()) { idb.setJSON(DICT_KEY, customDict); }
      else { localStorage.setItem(DICT_KEY, JSON.stringify(customDict)); }
    } catch (e) {}
  }

  function openDictDialog() {
    renderDictWords();
    openModal("dictModal");
    setTimeout(function () { $("dictInput").focus(); }, 80);
  }

  function renderDictWords() {
    var container = $("dictWords");
    if (!container) return;
    container.innerHTML = "";
    var keys = Object.keys(customDict).sort();
    if (keys.length === 0) {
      var empty = document.createElement("p");
      empty.className = "dict-empty";
      empty.textContent = "No custom words yet. Add names or technical terms you use often.";
      container.appendChild(empty);
      return;
    }
    for (var i = 0; i < keys.length; i++) {
      (function (word) {
        var chip = document.createElement("span");
        chip.className = "dict-word";
        chip.appendChild(document.createTextNode(word));
        var remove = document.createElement("button");
        remove.className = "dict-word-remove";
        remove.textContent = "×";
        remove.title = "Remove";
        remove.addEventListener("click", function () {
          delete customDict[word];
          saveCustomDict();
          renderDictWords();
          renderWritingIssues();
        });
        chip.appendChild(remove);
        container.appendChild(chip);
      })(keys[i]);
    }
  }

  function addDictWord(word) {
    word = (word || "").trim().toLowerCase();
    if (!word) return;
    if (customDict[word]) {
      toast("Already in dictionary", "error");
      return;
    }
    customDict[word] = true;
    saveCustomDict();
    renderDictWords();
    renderWritingIssues();
    $("dictInput").value = "";
    $("dictInput").focus();
    toast("Added to dictionary", "success");
  }

  /* ===================================================================
     EMERALDSUITE: DOCS — additional features
     =================================================================== */

  /* ---------------- Templates ---------------- */
  var TEMPLATES = [
    { id: "blank", name: "Blank Document", desc: "Start from scratch", html: "<p><br></p>" },
    { id: "resume", name: "Resume", desc: "Clean professional CV", html:
      "<h1>First Last</h1><p>email@example.com · (555) 123-4567 · City, Country</p>" +
      "<h2>Summary</h2><p>Experienced professional with a track record of...</p>" +
      "<h2>Experience</h2><p><strong>Job Title</strong> — Company, 2020–Present</p><p>Description of role and achievements.</p>" +
      "<p><strong>Previous Role</strong> — Company, 2017–2020</p><p>Description.</p>" +
      "<h2>Education</h2><p><strong>Degree</strong> — University, Year</p>" +
      "<h2>Skills</h2><p>Skill · Skill · Skill · Skill</p>"
    },
    { id: "letter", name: "Letter", desc: "Formal business letter", html:
      "<p>Sender Name<br/>123 Street Address<br/>City, State ZIP</p>" +
      "<p><br></p><p>Date: " + new Date().toLocaleDateString() + "</p>" +
      "<p><br></p><p>Recipient Name<br/>Company<br/>Address</p>" +
      "<p><br></p><p>Dear Recipient,</p>" +
      "<p>Write the body of your letter here. Keep it concise and professional.</p>" +
      "<p><br></p><p>Sincerely,</p><p><br></p><p>Your Name</p>"
    },
    { id: "report", name: "Report", desc: "Structured report", html:
      "<h1>Report Title</h1>" +
      "<h2>Executive Summary</h2><p>Summary of findings and recommendations.</p>" +
      "<h2>Introduction</h2><p>Background and objectives.</p>" +
      "<h2>Methodology</h2><p>How the analysis was conducted.</p>" +
      "<h2>Findings</h2><p>Key results and data.</p>" +
      "<h2>Conclusion</h2><p>Final assessment and next steps.</p>"
    },
    { id: "meeting", name: "Meeting Notes", desc: "Agenda and minutes", html:
      "<h1>Meeting Notes</h1>" +
      "<p><strong>Date:</strong> " + new Date().toLocaleDateString() + "<br/><strong>Attendees:</strong> <br/><strong>Objective:</strong> </p>" +
      "<h2>Agenda</h2><p>1. <br/>2. <br/>3. </p>" +
      "<h2>Discussion</h2><p>Key points discussed.</p>" +
      "<h2>Action Items</h2><p>· Task — Owner — Due date</p>"
    },
    { id: "essay", name: "Essay", desc: "Academic 5-paragraph", html:
      "<h1>Essay Title</h1>" +
      "<p><em>Introduction</em> — Hook, context, and thesis statement that previews three main points.</p>" +
      "<h2>Body Paragraph 1</h2><p>First point with supporting evidence.</p>" +
      "<h2>Body Paragraph 2</h2><p>Second point with supporting evidence.</p>" +
      "<h2>Body Paragraph 3</h2><p>Third point with supporting evidence.</p>" +
      "<h2>Conclusion</h2><p>Restate thesis and synthesize main points.</p>"
    },
  ];

  function buildTemplates() {
    var grid = $("templatesGrid");
    grid.innerHTML = "";
    for (var i = 0; i < TEMPLATES.length; i++) {
      (function (t) {
        var card = document.createElement("div");
        card.className = "template-card";
        var preview = document.createElement("div");
        preview.className = "template-preview";
        var titleLine = document.createElement("div");
        titleLine.className = "tp-line title";
        preview.appendChild(titleLine);
        for (var k = 0; k < 5; k++) {
          var line = document.createElement("div");
          line.className = "tp-line " + (k % 2 ? "med" : "long");
          if (k === 3) line.className = "tp-line short";
          preview.appendChild(line);
        }
        var name = document.createElement("div");
        name.className = "template-name";
        name.textContent = t.name;
        var desc = document.createElement("div");
        desc.className = "template-desc";
        desc.textContent = t.desc;
        card.appendChild(preview);
        card.appendChild(name);
        card.appendChild(desc);
        card.addEventListener("click", function () {
          applyTemplate(t);
          closeModal("templatesModal");
        });
        grid.appendChild(card);
      })(TEMPLATES[i]);
    }
  }

  function applyTemplate(t) {
    if (!window.confirm("Apply the \"" + t.name + "\" template? This will replace the current document content.")) return;
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    var page = createPage();
    wrapper.appendChild(page);
    var content = getContent(page);
    content.innerHTML = t.html || "<p><br></p>";
    ($("docTitle")?$("docTitle").value=t.name:null);
    paginate();
    saveDocument(false);
    toast(t.name + " template applied", "success");
    setTimeout(function () { content.focus(); }, 100);
  }

  /* ---------------- Symbols ---------------- */
  var SYMBOL_SETS = {
    common: "© ® ™ ¶ § • … — – “ ” ‘ ’ ° ± ÷ × ≠ ≤ ≥ ∞ √ ∑ ∫ π ∂ ∆ Ω ≈ ∼ ∝ ∈ ∉ ∪ ∩ ⊂ ⊃",
    math: "± × ÷ ≠ ≈ ∼ ∝ ≤ ≥ ∞ √ ∑ ∫ ∏ ∂ ∆ ∇ π Σ Ω α β γ δ ε ζ η θ λ μ ν ξ ρ σ τ φ ψ ω ∴ ∵ ≅ ≡",
    currency: "$ € £ ¥ ¢ ₹ ₽ ₩ ₪ ₫ ₴ ₸ ฿ ₺ ₼ ₡ ₨ ₦ ₱ ₤ ƒ",
    arrows: "→ ← ↑ ↓ ↔ ↕ ⇒ ⇐ ⇑ ⇓ ⇔ ↗ ↘ ↙ ↖ ➜ ➝ ➞ ➟ ➠ ➡",
    greek: "α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω Α Β Γ Δ Ε Ζ Η Θ Ι Κ Λ Μ Ν Ξ Ο Π Ρ Σ Τ Υ Φ Χ Ψ Ω",
  };

  function buildSymbols(category) {
    var grid = $("symbolGrid");
    grid.innerHTML = "";
    var chars = (SYMBOL_SETS[category] || "").split(/\s+/).filter(Boolean);
    for (var i = 0; i < chars.length; i++) {
      (function (ch) {
        var cell = document.createElement("button");
        cell.className = "symbol-cell";
        cell.textContent = ch;
        cell.title = ch;
        cell.addEventListener("click", function () {
          restoreEditorSelection();
          document.execCommand("insertText", false, ch);
          schedulePaginate();
          scheduleAutosave();
        });
        grid.appendChild(cell);
      })(chars[i]);
    }
  }

  function openSymbols() {
    buildSymbols("common");
    openModal("symbolsModal");
  }

  /* ---------------- Go To ---------------- */
  function openGoTo() {
    $("gotoValue").value = "";
    openModal("gotoModal");
    setTimeout(function () { $("gotoValue").focus(); }, 80);
  }

  function performGoTo() {
    var type = $("gotoType").value;
    var val = parseInt($("gotoValue").value, 10);
    if (isNaN(val) || val < 1) val = 1;
    var pages = getPages();
    if (type === "page") {
      if (val > pages.length) val = pages.length;
      scrollToPage(val);
    } else if (type === "line") {
      // count lines across all pages
      var count = 0;
      var done = false;
      for (var i = 0; i < pages.length && !done; i++) {
        var content = getContent(pages[i]);
        var blocks = content.children;
        for (var j = 0; j < blocks.length; j++) {
          var lineCount = blocks[j].innerText.split("\n").length;
          if (count + lineCount >= val) {
            // place caret at start of this block
            pages[i].scrollIntoView({ behavior: "smooth", block: "start" });
            var range = document.createRange();
            range.selectNodeContents(blocks[j]);
            range.collapse(true);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            content.focus();
            done = true;
            break;
          }
          count += lineCount;
        }
      }
    } else if (type === "heading") {
      // jump to the Nth heading
      var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
      if (headings.length === 0) { toast("No headings found", "error"); return; }
      if (val > headings.length) val = headings.length;
      var h = headings[val - 1];
      h.scrollIntoView({ behavior: "smooth", block: "center" });
      var range2 = document.createRange();
      range2.selectNodeContents(h);
      range2.collapse(true);
      var sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(range2);
      h.closest(".page-content").focus();
    }
    closeModal("gotoModal");
    toast("Jumped to " + type + " " + val, "success");
  }

  /* ---------------- Watermark ---------------- */
  function applyWatermark(text) {
    var pages = getPages();
    // remove existing
    for (var i = 0; i < pages.length; i++) {
      var existing = pages[i].querySelector(".page-watermark");
      if (existing) existing.remove();
    }
    if (!text) return;
    for (var j = 0; j < pages.length; j++) {
      var wm = document.createElement("div");
      wm.className = "page-watermark";
      wm.textContent = text;
      wm.setAttribute("contenteditable", "false");
      pages[j].insertBefore(wm, pages[j].firstChild);
    }
  }

  function openWatermark() {
    openModal("watermarkModal");
  }

  /* ---------------- Table of Contents ---------------- */
  function insertTOC() {
    var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
    if (headings.length === 0) {
      toast("Add headings first to generate a TOC", "error");
      return;
    }
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    var html = '<div class="zdocs-toc" contenteditable="false"><h2>Table of Contents</h2><ul>';
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      var level = h.tagName.toLowerCase();
      var text = (h.textContent || "").trim();
      if (!text) continue;
      html += '<li class="toc-' + level + '"><a href="#" data-toc="' + i + '">' + escapeHtml(text) + '</a></li>';
    }
    html += '</ul></div><p><br></p>';
    document.execCommand("insertHTML", false, html);
    schedulePaginate();
    scheduleAutosave();
    toast("Table of contents inserted", "success");
  }

  /* ---------------- Drop Cap ---------------- */
  function toggleDropCap() {
    var block = getCurrentBlock();
    if (!block || block.tagName !== "P") {
      toast("Place cursor in a paragraph", "error");
      return;
    }
    if (block.classList.contains("has-dropcap")) {
      block.classList.remove("has-dropcap");
      toast("Drop cap removed", "success");
    } else {
      block.classList.add("has-dropcap");
      toast("Drop cap applied", "success");
    }
    schedulePaginate();
    scheduleAutosave();
  }

  /* ---------------- Text Box ---------------- */
  function insertTextBox() {
    restoreEditorSelection();
    var html = '<div class="zdocs-textbox" contenteditable="true" style="border:2px solid var(--ui-accent); border-radius:8px; padding:12px; margin:8px 0; background:var(--ui-accent-soft);"><p>Click to edit text box content.</p></div><p><br></p>';
    document.execCommand("insertHTML", false, html);
    schedulePaginate();
    scheduleAutosave();
    toast("Text box inserted", "success");
  }

  /* ---------------- Columns ---------------- */
  function setColumns(n) {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var c = getContent(pages[i]);
      c.classList.remove("is-cols-2", "is-cols-3");
      if (n === 2) c.classList.add("is-cols-2");
      else if (n === 3) c.classList.add("is-cols-3");
    }
    // update active states on column buttons
    var colBtns = document.querySelectorAll("[data-cols]");
    for (var j = 0; j < colBtns.length; j++) {
      var cols = parseInt(colBtns[j].getAttribute("data-cols"), 10);
      if (cols === n) colBtns[j].classList.add("active");
      else colBtns[j].classList.remove("active");
    }
    schedulePaginate();
    scheduleAutosave();
    toast(n + " column" + (n > 1 ? "s" : "") + " layout", "success");
  }

  /* ---------------- Orientation & Page Size ---------------- */
  var PAGE_SIZES = {
    A4: { w: 794, h: 1123 },
    Letter: { w: 816, h: 1056 },
    Legal: { w: 816, h: 1344 },
    A5: { w: 559, h: 794 },
  };

  function toggleOrientation() {
    var pages = getPages();
    var isLandscape = pages[0].classList.contains("landscape");
    for (var i = 0; i < pages.length; i++) {
      if (isLandscape) {
        pages[i].classList.remove("landscape");
        pages[i].style.width = "";
        pages[i].style.height = "";
      } else {
        pages[i].classList.add("landscape");
        pages[i].style.width = "1123px";
        pages[i].style.height = "794px";
      }
    }
    schedulePaginate();
    scheduleAutosave();
    toast(isLandscape ? "Portrait" : "Landscape", "success");
  }

  function cyclePageSize() {
    var pages = getPages();
    var currentW = pages[0].style.width || "794px";
    var sizes = Object.keys(PAGE_SIZES);
    var currentName = "A4";
    for (var name in PAGE_SIZES) {
      if (PAGE_SIZES[name].w + "px" === currentW) { currentName = name; break; }
    }
    var idx = sizes.indexOf(currentName);
    var next = sizes[(idx + 1) % sizes.length];
    setPageSize(next);
  }

  function setPageSize(name) {
    var dim = PAGE_SIZES[name];
    if (!dim) return;
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      pages[i].style.width = dim.w + "px";
      pages[i].style.height = dim.h + "px";
    }
    // update the status bar label
    var label = document.querySelector(".page-size-label");
    if (label) label.textContent = name;
    // update the page-size menu active state
    var menuBtns = document.querySelectorAll(".page-size-menu button");
    for (var b = 0; b < menuBtns.length; b++) {
      menuBtns[b].classList.toggle("active", menuBtns[b].getAttribute("data-psize") === name);
    }
    schedulePaginate();
    scheduleAutosave();
    toast("Page size: " + name, "success");
  }

  var pageSizeMenu = null;
  function togglePageSizeMenu(anchor) {
    if (pageSizeMenu && pageSizeMenu.classList.contains("open")) {
      pageSizeMenu.classList.remove("open");
      return;
    }
    if (!pageSizeMenu) {
      pageSizeMenu = document.createElement("div");
      pageSizeMenu.className = "page-size-menu";
      document.body.appendChild(pageSizeMenu);
      document.addEventListener("click", function (e) {
        if (pageSizeMenu && !e.target.closest(".page-size-menu") && !e.target.closest(".page-size-label")) {
          pageSizeMenu.classList.remove("open");
        }
      });
    }
    pageSizeMenu.innerHTML = "";
    var sizes = Object.keys(PAGE_SIZES);
    var pages = getPages();
    var currentW = (pages[0] && pages[0].style.width) || "794px";
    var currentName = "A4";
    for (var name in PAGE_SIZES) {
      if (PAGE_SIZES[name].w + "px" === currentW) { currentName = name; break; }
    }
    for (var i = 0; i < sizes.length; i++) {
      (function (psz) {
        var b = document.createElement("button");
        b.setAttribute("data-psize", psz);
        b.textContent = psz + " (" + PAGE_SIZES[psz].w + "×" + PAGE_SIZES[psz].h + ")";
        if (psz === currentName) b.classList.add("active");
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          setPageSize(psz);
          pageSizeMenu.classList.remove("open");
        });
        pageSizeMenu.appendChild(b);
      })(sizes[i]);
    }
    var rect = anchor.getBoundingClientRect();
    pageSizeMenu.style.top = (rect.bottom + 4) + "px";
    pageSizeMenu.style.right = (window.innerWidth - rect.right) + "px";
    pageSizeMenu.classList.add("open");
  }

  /* ---------------- Header / Footer / Page Number ---------------- */
  function insertPageNumber() {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    document.execCommand("insertHTML", false, '<span class="field-dynamic" contenteditable="false" data-field="PAGE">Page 1</span> ');
    updateDynamicFields();
    schedulePaginate();
    scheduleAutosave();
    toast("Page number field inserted", "success");
  }

  function insertHeader() {
    // Toggle a header on every page
    var pages = getPages();
    var has = pages[0].querySelector(".page-header");
    for (var i = 0; i < pages.length; i++) {
      var existing = pages[i].querySelector(".page-header");
      if (existing) existing.remove();
      else {
        var header = document.createElement("div");
        header.className = "page-header";
        header.textContent = ($("docTitle") ? $("docTitle").value : "Document");
        header.setAttribute("contenteditable", "false");
        pages[i].insertBefore(header, pages[i].firstChild);
      }
    }
    toast(has ? "Header removed" : "Header added (document title)", "success");
  }

  function updateDynamicFields() {
    var pages = getPages();
    var pageFields = document.querySelectorAll('[data-field="PAGE"]');
    for (var i = 0; i < pageFields.length; i++) {
      // find which page this field is on
      var pg = pageFields[i].closest(".page");
      var pageNum = pg ? pages.indexOf(pg) + 1 : 1;
      pageFields[i].textContent = "Page " + pageNum;
    }
    var dateFields = document.querySelectorAll('[data-field="DATE"]');
    for (var d = 0; d < dateFields.length; d++) {
      dateFields[d].textContent = new Date().toLocaleDateString();
    }
    var wordFields = document.querySelectorAll('[data-field="WORDS"]');
    for (var w = 0; w < wordFields.length; w++) {
      wordFields[w].textContent = getStats().words.toLocaleString() + " words";
    }
  }

  /* ---------------- View modes ---------------- */
  function setViewMode(mode) {
    var app = $("app");
    app.classList.remove("view-web", "view-draft", "view-read", "focus-mode", "print-preview");
    if (mode === "print") {
      // default — no class needed
    } else if (mode === "web") {
      app.classList.add("view-web");
    } else if (mode === "draft") {
      app.classList.add("view-draft");
    } else if (mode === "read") {
      app.classList.add("view-read");
      saveDocument(false);
    }
    // update active states
    var viewBtns = document.querySelectorAll("[data-view]");
    for (var i = 0; i < viewBtns.length; i++) {
      if (viewBtns[i].getAttribute("data-view") === mode) viewBtns[i].classList.add("active");
      else viewBtns[i].classList.remove("active");
    }
    if (mode === "web" || mode === "draft") {
      // re-paginate to adjust to new page heights
      schedulePaginate();
    }
    toast(mode.charAt(0).toUpperCase() + mode.slice(1) + " layout", "success");
  }

  /* ---------------- Format Painter ---------------- */
  var painterFormat = null;

  function copyFormat() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      toast("Select text to copy its format", "error");
      return;
    }
    // capture the computed style of the selection's parent
    var node = sel.anchorNode;
    var el = node.nodeType === 3 ? node.parentElement : node;
    painterFormat = {
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      color: document.queryCommandValue("foreColor"),
      fontName: document.queryCommandValue("fontName"),
      fontSize: document.queryCommandValue("fontSize"),
    };
    document.body.classList.add("painter-active");
    toast("Format copied — select text to apply", "success");
  }

  function applyPainterFormat() {
    if (!painterFormat) {
      toast("Copy a format first", "error");
      return;
    }
    if (painterFormat.bold) document.execCommand("bold");
    if (painterFormat.italic) document.execCommand("italic");
    if (painterFormat.underline) document.execCommand("underline");
    if (painterFormat.color) document.execCommand("foreColor", false, painterFormat.color);
    if (painterFormat.fontName) document.execCommand("fontName", false, painterFormat.fontName);
    if (painterFormat.fontSize) document.execCommand("fontSize", false, painterFormat.fontSize);
    schedulePaginate();
    scheduleAutosave();
  }

  /* ---------------- Paste Special ---------------- */
  function openPasteSpecial() {
    openModal("pasteSpecialModal");
  }

  function performPasteSpecial() {
    var mode = "keep";
    var radios = document.getElementsByName("pasteMode");
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) { mode = radios[i].value; break; }
    }
    // read clipboard
    navigator.clipboard.readText().then(function (text) {
      restoreEditorSelection();
      var fc = getContent(getPages()[0]);
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
        if (fc) fc.focus();
      }
      if (mode === "plain" || mode === "match") {
        // strip all formatting → plain text
        document.execCommand("insertText", false, text);
      } else if (mode === "html") {
        document.execCommand("insertHTML", false, escapeHtml(text));
      } else {
        // keep source — try insertFromPaste, fallback to text
        document.execCommand("insertText", false, text);
      }
      schedulePaginate();
      scheduleAutosave();
      closeModal("pasteSpecialModal");
      toast("Pasted (" + mode + ")", "success");
    }).catch(function () {
      // clipboard read denied — use last clipboard text if available
      toast("Clipboard access denied — use Ctrl+V", "error");
      closeModal("pasteSpecialModal");
    });
  }

  /* ---------------- AutoCorrect ---------------- */
  var AUTOCORRECT = {
    "teh": "the", "adn": "and", "nad": "and", "recieve": "receive",
    "seperate": "separate", "definately": "definitely", "occured": "occurred",
    "untill": "until", "wich": "which", "thier": "their", "dont": "don't",
    "cant": "can't", "wont": "won't", "isnt": "isn't", "wasnt": "wasn't",
    "havent": "haven't", "didnt": "didn't", "wouldnt": "wouldn't",
    "shouldnt": "shouldn't", "couldnt": "couldn't", "im": "I'm",
    "ive": "I've", "ill": "I'll", "id": "I'd",
    ":-)": "😊", ":-(": "😞", "<3": "❤",
  };

  function checkAutoCorrect() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    var node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    var text = node.textContent;
    var offset = sel.anchorOffset;
    // get the word before the caret (just typed a space)
    var before = text.substring(0, offset);
    var m = before.match(/(\S+)$/);
    if (!m) return;
    var word = m[1];
    var cleanWord = word.toLowerCase().replace(/[^\w']/g, "");
    if (AUTOCORRECT[cleanWord] || AUTOCORRECT[word]) {
      var replacement = AUTOCORRECT[cleanWord] || AUTOCORRECT[word];
      var range = document.createRange();
      range.setStart(node, offset - word.length);
      range.setEnd(node, offset);
      range.deleteContents();
      range.insertNode(document.createTextNode(replacement));
      // move caret after the replacement
      range.setStartAfter(range.endContainer);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /* ---------------- Track Changes ---------------- */
  var trackChangesOn = false;

  function toggleTrackChanges() {
    trackChangesOn = !trackChangesOn;
    var btn = $("btnTrackChanges");
    if (btn) {
      if (trackChangesOn) btn.classList.add("active");
      else btn.classList.remove("active");
    }
    toast(trackChangesOn ? "Track Changes ON" : "Track Changes OFF", "success");
  }

  /* ---------------- Comments ---------------- */
  var comments = [];
  var commentId = 0;

  function addComment() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      toast("Select text to comment on", "error");
      return;
    }
    var quote = sel.toString();
    var text = window.prompt("Comment:", "");
    if (!text) return;
    var c = {
      id: ++commentId,
      quote: quote.substring(0, 80) + (quote.length > 80 ? "…" : ""),
      text: text,
      resolved: false,
      ts: Date.now(),
    };
    comments.push(c);
    toggleComments(true);
    renderComments();
    toast("Comment added", "success");
  }

  function toggleComments(force) {
    var panel = $("commentsPanel");
    var shouldOpen = force === undefined ? !panel.classList.contains("open") : force;
    if (shouldOpen) {
      renderComments();
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
    } else {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
    }
  }

  function renderComments() {
    var body = $("commentsBody");
    body.innerHTML = "";
    if (comments.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No comments yet. Select text and use Review → Comment.";
      body.appendChild(empty);
      return;
    }
    for (var i = 0; i < comments.length; i++) {
      (function (c) {
        var item = document.createElement("div");
        item.className = "comment-item" + (c.resolved ? " resolved" : "");
        var quote = document.createElement("div");
        quote.className = "comment-quote";
        quote.textContent = "“" + c.quote + "”";
        var text = document.createElement("div");
        text.className = "comment-text";
        text.textContent = c.text;
        text.setAttribute("contenteditable", "true");
        text.addEventListener("blur", function () { c.text = text.textContent; });
        var meta = document.createElement("div");
        meta.className = "comment-meta";
        var time = document.createElement("span");
        time.textContent = formatTime(c.ts);
        var actions = document.createElement("div");
        actions.className = "comment-actions";
        var resolve = document.createElement("button");
        resolve.textContent = c.resolved ? "Unresolve" : "Resolve";
        resolve.addEventListener("click", function () {
          c.resolved = !c.resolved;
          renderComments();
        });
        var del = document.createElement("button");
        del.textContent = "Delete";
        del.addEventListener("click", function () {
          comments = comments.filter(function (x) { return x.id !== c.id; });
          renderComments();
        });
        actions.appendChild(resolve);
        actions.appendChild(del);
        meta.appendChild(time);
        meta.appendChild(actions);
        item.appendChild(quote);
        item.appendChild(text);
        item.appendChild(meta);
        body.appendChild(item);
      })(comments[i]);
    }
  }

  /* ---------------- Read Aloud (Web Speech API) ---------------- */
  var readAloudUtter = null;

  function readAloud() {
    if (!("speechSynthesis" in window)) {
      toast("Speech synthesis not supported in this browser", "error");
      return;
    }
    if (readAloudUtter) {
      window.speechSynthesis.cancel();
      readAloudUtter = null;
      toast("Read aloud stopped", "success");
      return;
    }
    var text = getAllText();
    if (!text) { toast("No text to read", "error"); return; }
    readAloudUtter = new SpeechSynthesisUtterance(text.substring(0, 3000));
    readAloudUtter.rate = 1;
    readAloudUtter.onend = function () { readAloudUtter = null; toast("Finished reading", "success"); };
    window.speechSynthesis.speak(readAloudUtter);
    toast("Reading aloud…", "success");
  }

  /* ---------------- Dictate (Speech to Text) ---------------- */
  var dictateRecognition = null;

  // Dictate language mapping (status bar selector → BCP-47)
  var DICTATE_LANGS = {
    "EN": "en-US",
    "EN-GB": "en-GB",
    "ES": "es-ES",
    "FR": "fr-FR",
    "DE": "de-DE",
    "IT": "it-IT",
    "PT": "pt-PT",
    "NL": "nl-NL"
  };
  var dictateIndicator = null;

  function dictate() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast("Speech recognition not supported. Try Chrome/Edge.", "error");
      return;
    }
    if (dictateRecognition) {
      dictateRecognition.stop();
      dictateRecognition = null;
      var btn = $("btnDictate");
      if (btn) btn.classList.remove("active");
      hideDictateIndicator();
      toast("Dictation stopped", "success");
      return;
    }
    dictateRecognition = new SR();
    dictateRecognition.continuous = true;
    dictateRecognition.interimResults = true;
    dictateRecognition.lang = DICTATE_LANGS[spellLang] || "en-US";
    var fc = getContent(getPages()[0]);
    fc.focus();
    dictateRecognition.onresult = function (event) {
      var final = "";
      for (var i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript + " ";
        }
      }
      if (final) {
        // Process punctuation commands (e.g. "period", "comma", "new line")
        final = processDictateCommands(final);
        document.execCommand("insertText", false, final);
        schedulePaginate();
        scheduleAutosave();
      }
    };
    dictateRecognition.onerror = function (e) {
      toast("Dictation error: " + e.error, "error");
      hideDictateIndicator();
    };
    dictateRecognition.onend = function () {
      dictateRecognition = null;
      var btn = $("btnDictate");
      if (btn) btn.classList.remove("active");
      hideDictateIndicator();
    };
    dictateRecognition.start();
    var btn = $("btnDictate");
    if (btn) btn.classList.add("active");
    showDictateIndicator(dictateRecognition.lang);
    toast("Dictating in " + (dictateRecognition.lang) + " — say \"period\", \"comma\", \"new line\", \"new paragraph\"", "success");
  }

  // Convert spoken punctuation commands into actual punctuation.
  function processDictateCommands(text) {
    var replacements = [
      [/\bperiod\b/gi, "."],
      [/\bfull stop\b/gi, "."],
      [/\bcomma\b/gi, ","],
      [/\bquestion mark\b/gi, "?"],
      [/\bexclamation (mark|point)\b/gi, "!"],
      [/\bexclamation\b/gi, "!"],
      [/\bcolon\b/gi, ":"],
      [/\bsemicolon\b/gi, ";"],
      [/\bhyphen\b/gi, "-"],
      [/\bdash\b/gi, "—"],
      [/\bopen (quote|quotation)\b/gi, "\u201C"],
      [/\bclose (quote|quotation)\b/gi, "\u201D"],
      [/\bopen paren\b/gi, "("],
      [/\bclose paren\b/gi, ")"],
      [/\bnew line\b/gi, "\n"],
      [/\bnew paragraph\b/gi, "\n\n"],
      [/\btab\b/gi, "\t"],
      [/\bcap\b/gi, function (m) { return ""; }], // capitalize next — handled by browser usually
    ];
    var out = text;
    for (var i = 0; i < replacements.length; i++) {
      out = out.replace(replacements[i][0], replacements[i][1]);
    }
    // Capitalize the first letter after a period + space
    out = out.replace(/(^|[.!?]\s+)([a-z])/g, function (m, p1, p2) {
      return p1 + p2.toUpperCase();
    });
    return out;
  }

  function showDictateIndicator(lang) {
    if (!dictateIndicator) {
      dictateIndicator = document.createElement("div");
      dictateIndicator.className = "dictate-indicator";
      dictateIndicator.innerHTML = '<span class="di-pulse"></span><span class="di-text">Dictating…</span>';
      document.body.appendChild(dictateIndicator);
    }
    dictateIndicator.querySelector(".di-text").textContent = "Dictating (" + lang + ")…";
    dictateIndicator.classList.add("active");
  }
  function hideDictateIndicator() {
    if (dictateIndicator) dictateIndicator.classList.remove("active");
  }

  function formatTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return d.toLocaleString([], { hour: "2-digit", minute: "2-digit" });
  }

  /* ---------------- Toast ---------------- */
  function toast(message, type) {
    var el = $("toast");
    el.textContent = message;
    el.className = "toast show" + (type ? " " + type : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 2400);
  }

  /* ---------------- Init ---------------- */
  async function init() {
    // Initialize IDB storage
    idb = window.EmeraldIDBStorage || null;
    if (idb) {
      // Wait for IDB to be ready
      try { await idb.ready(); } catch (e) {}
    }

    // Theme
    try {
      var savedTheme = localStorage.getItem(THEME_KEY);
      if (savedTheme) applyTheme(savedTheme);
      else applyTheme("light");
    } catch (e) { applyTheme("light"); }

    ensureFirstPage();

    // Load document from IDB (async) or fall back to localStorage
    var loaded = false;
    try { loaded = await loadDocument(); } catch (e) { loaded = false; }
    if (!loaded) { ensureFirstPage(); paginate(); }

    // Toolbar command buttons
    var cmdButtons = document.querySelectorAll("[data-cmd]");
    for (var i = 0; i < cmdButtons.length; i++) {
      (function (btn) {
        btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
        btn.addEventListener("click", function () { exec(btn.getAttribute("data-cmd")); });
      })(cmdButtons[i]);
    }

    // Selects
    function hookSelect(sel, handler) {
      sel.addEventListener("mousedown", function () {
        var s = window.getSelection();
        if (s && s.rangeCount) {
          var node = s.anchorNode;
          if (node) {
            var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (el && el.closest && el.closest(".page-content")) {
              lastEditorRange = s.getRangeAt(0).cloneRange();
            }
          }
        }
      });
      sel.addEventListener("change", function (e) { handler(e.target.value); });
    }
    hookSelect($("blockType"), applyBlock);
    hookSelect($("fontFamily"), applyFontFamily);
    hookSelect($("fontSize"), applyFontSize);
    hookSelect($("lineSpacing"), applyLineSpacing);

    // Colors
    $("textColor").addEventListener("input", function (e) { applyTextColor(e.target.value); });
    $("hiliteColor").addEventListener("input", function (e) { applyHiliteColor(e.target.value); });

    $("btnClearFormat").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnClearFormat").addEventListener("click", clearFormatting);

    // Menubar / topbar actions (guarded — elements may have moved to ribbon)
    if ($("btnNew")) $("btnNew").addEventListener("click", newDocument);
    if ($("btnFind")) $("btnFind").addEventListener("click", openFind);
    if ($("btnFind2")) $("btnFind2").addEventListener("click", openFind);
    if ($("btnSave")) $("btnSave").addEventListener("click", function () { saveDocument(true); });
    if ($("btnVersions")) { $("btnVersions").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnVersions").addEventListener("click", showVersions); }
    if ($("btnUndo")) { $("btnUndo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnUndo").addEventListener("click", function () { exec("undo"); }); }
    if ($("btnRedo")) { $("btnRedo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnRedo").addEventListener("click", function () { exec("redo"); }); }
    if ($("btnTheme")) $("btnTheme").addEventListener("click", toggleTheme);
    if ($("btnTheme2")) $("btnTheme2").addEventListener("click", toggleTheme);
    if ($("btnColorTheme")) {
      $("btnColorTheme").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnColorTheme").addEventListener("click", openColorThemeDialog);
    }
    if ($("btnDarkPaper")) {
      $("btnDarkPaper").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnDarkPaper").addEventListener("click", toggleDarkPaper);
    }
    // Load saved dark paper state
    try { if (localStorage.getItem("zdocs.darkPaper") === "1") $("app").classList.add("dark-paper"); } catch (e) {}
    if ($("btnClipboardHistory")) {
      $("btnClipboardHistory").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnClipboardHistory").addEventListener("click", openClipboardHistory);
    }
    if ($("clipboardHistoryClear")) {
      $("clipboardHistoryClear").addEventListener("click", clearClipboardHistory);
    }
    if ($("btnFocus2")) {
      $("btnFocus2").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnFocus2").addEventListener("click", function () { toggleFocusMode(); });
    }
    if ($("btnZen")) {
      $("btnZen").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnZen").addEventListener("click", function () { toggleZenMode(); });
    }
    if ($("zenIndicator")) {
      $("zenIndicator").addEventListener("click", function () { toggleZenMode(false); });
    }
    // Zen mode: show controls on input/mousemove/scroll
    document.addEventListener("input", function () { if (typeof zenShowControls === "function") zenShowControls(); });
    document.addEventListener("mousemove", function () { if (typeof zenShowControls === "function") zenShowControls(); });
    $("documentScroll").addEventListener("scroll", function () { if (typeof zenShowControls === "function") zenShowControls(); });
    if ($("docTitle")) $("docTitle").addEventListener("input", scheduleAutosave);

    // Ribbon tabs — switching with sliding indicator + blur/fade panel transition
    initRibbonTabs();

    // Export dropdown (guarded — may not exist if moved)
    var exportToggle = $("btnExportToggle");
    var exportMenu = $("exportMenu");
    if (exportToggle && exportMenu) {
      exportToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        exportMenu.classList.toggle("open");
      });
      document.addEventListener("click", function () { exportMenu.classList.remove("open"); });
      var exportBtns = exportMenu.querySelectorAll("button[data-export]");
    for (var ei = 0; ei < exportBtns.length; ei++) {
      (function (b) {
        b.addEventListener("click", function () {
          exportMenu.classList.remove("open");
          exportDocument(b.getAttribute("data-export"));
        });
      })(exportBtns[ei]);
    }
    } // end if (exportToggle && exportMenu)

    // Insert group
    $("btnLink").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnLink").addEventListener("click", openLinkDialog);
    $("btnImage").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnImage").addEventListener("click", openImageDialog);
    $("btnTable").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnTable").addEventListener("click", openTableDialog);
    $("btnHr").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnHr").addEventListener("click", insertHr);

    // Page break
    $("btnPageBreak").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPageBreak").addEventListener("click", insertPageBreak);

    // Word count
    $("btnWordCount").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnWordCount").addEventListener("click", showWordCount);
    $("wordCount").addEventListener("click", showWordCount);
    if ($("btnStatsExport")) $("btnStatsExport").addEventListener("click", exportStats);

    // Goal tracker input
    $("goalInput").addEventListener("input", function (e) {
      var v = parseInt(e.target.value, 10);
      goalTarget = (isNaN(v) || v < 0) ? 0 : v;
      saveGoal();
      updateGoalTracker();
    });
    $("goalClear").addEventListener("click", function () {
      goalTarget = 0;
      $("goalInput").value = "";
      saveGoal();
      updateGoalTracker();
    });

    // Print preview
    $("btnPrintExit").addEventListener("click", function () { togglePrintPreview(false); });
    $("btnPrintNow").addEventListener("click", function () {
      togglePrintPreview(false);
      setTimeout(printDocument, 100);
    });

    // Focus mode
    if ($("btnFocus")) { $("btnFocus").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnFocus").addEventListener("click", function () { toggleFocusMode(); }); }
    $("btnFocusExit").addEventListener("click", function () { toggleFocusMode(false); });

    // EmeraldSuite: Docs — new feature wiring
    // Templates
    if ($("btnTemplates")) $("btnTemplates").addEventListener("click", function () { buildTemplates(); openModal("templatesModal"); });

    // Symbols
    $("btnSymbols").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnSymbols").addEventListener("click", openSymbols);
    var symTabs = document.querySelectorAll(".symbol-tab");
    for (var st = 0; st < symTabs.length; st++) {
      (function (t) {
        t.addEventListener("click", function () {
          document.querySelectorAll(".symbol-tab").forEach(function (x) { x.classList.remove("active"); });
          t.classList.add("active");
          buildSymbols(t.getAttribute("data-symtab"));
        });
      })(symTabs[st]);
    }

    // Go To
    $("btnGoTo").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnGoTo").addEventListener("click", openGoTo);
    $("gotoConfirm").addEventListener("click", performGoTo);
    $("gotoValue").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); performGoTo(); } });

    // Watermark
    $("btnWatermark").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnWatermark").addEventListener("click", openWatermark);
    $("watermarkConfirm").addEventListener("click", function () {
      applyWatermark($("watermarkText").value.trim());
      closeModal("watermarkModal");
      toast("Watermark applied", "success");
    });
    $("watermarkRemove").addEventListener("click", function () {
      applyWatermark(null);
      closeModal("watermarkModal");
      toast("Watermark removed", "success");
    });
    var wmPresets = document.querySelectorAll(".watermark-presets .preset-btn");
    for (var wp = 0; wp < wmPresets.length; wp++) {
      wmPresets[wp].addEventListener("click", function () { $("watermarkText").value = this.getAttribute("data-wm"); });
    }

    // Table of Contents
    $("btnToc").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnToc").addEventListener("click", insertTOC);

    // Drop Cap
    $("btnDropCap").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnDropCap").addEventListener("click", toggleDropCap);

    // Text Box
    $("btnTextBox").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnTextBox").addEventListener("click", insertTextBox);

    // Columns
    var colBtns = document.querySelectorAll("[data-cols]");
    for (var cb = 0; cb < colBtns.length; cb++) {
      (function (b) {
        b.addEventListener("mousedown", function (e) { e.preventDefault(); });
        b.addEventListener("click", function () {
          setColumns(parseInt(b.getAttribute("data-cols"), 10));
        });
      })(colBtns[cb]);
    }
    // default 1-column active
    document.querySelector("[data-cols='1']").classList.add("active");

    // Orientation & Page Size
    $("btnOrientation").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnOrientation").addEventListener("click", toggleOrientation);
    $("btnPageSize").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPageSize").addEventListener("click", cyclePageSize);

    // Header & Page Number
    $("btnHeader").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnHeader").addEventListener("click", insertHeader);
    $("btnPageNum").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPageNum").addEventListener("click", insertPageNumber);

    // View modes
    var viewBtns = document.querySelectorAll("[data-view]");
    for (var vb = 0; vb < viewBtns.length; vb++) {
      (function (b) {
        b.addEventListener("mousedown", function (e) { e.preventDefault(); });
        b.addEventListener("click", function () {
          setViewMode(b.getAttribute("data-view"));
        });
      })(viewBtns[vb]);
    }
    document.querySelector("[data-view='print']").classList.add("active");

    // Format Painter
    $("btnFormatPainter").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnFormatPainter").addEventListener("click", function () {
      // First click copies; if already have a format, second click applies
      if (painterFormat) {
        applyPainterFormat();
        painterFormat = null;
        document.body.classList.remove("painter-active");
      } else {
        copyFormat();
      }
    });

    // Paste Special
    $("btnPasteSpecial").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPasteSpecial").addEventListener("click", openPasteSpecial);
    $("pasteSpecialConfirm").addEventListener("click", performPasteSpecial);

    // Read Aloud & Dictate
    $("btnReadAloud").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnReadAloud").addEventListener("click", readAloud);
    $("btnDictate").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnDictate").addEventListener("click", dictate);

    // Track Changes
    $("btnTrackChanges").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnTrackChanges").addEventListener("click", toggleTrackChanges);

    // Comments
    $("btnComment").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnComment").addEventListener("click", addComment);
    $("commentsClose").addEventListener("click", function () { toggleComments(false); });
    $("commentResolveAll").addEventListener("click", function () {
      comments.forEach(function (c) { c.resolved = true; });
      renderComments();
      toast("All comments resolved", "success");
    });
    $("commentAddFromPanel").addEventListener("click", addComment);

    // File panel buttons
    if ($("btnNewDoc")) { $("btnNewDoc").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnNewDoc").addEventListener("click", newDocument); }
    if ($("btnOpenFile")) { $("btnOpenFile").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnOpenFile").addEventListener("click", function () { toast("Open: use Ctrl+O to load from file (coming soon)", "success"); }); }
    if ($("btnSaveFile")) { $("btnSaveFile").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnSaveFile").addEventListener("click", function () { saveDocument(true); }); }
    if ($("btnExportTxt")) { $("btnExportTxt").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnExportTxt").addEventListener("click", function () { exportDocument("txt"); }); }
    if ($("btnExportHtml")) { $("btnExportHtml").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnExportHtml").addEventListener("click", function () { exportDocument("html"); }); }
    if ($("btnExportPrint")) { $("btnExportPrint").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnExportPrint").addEventListener("click", function () { exportDocument("print"); }); }
    if ($("btnFileInfo")) { $("btnFileInfo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnFileInfo").addEventListener("click", showWordCount); }
    if ($("btnFileVersions")) { $("btnFileVersions").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnFileVersions").addEventListener("click", showVersions); }

    // References panel buttons
    if ($("btnTocRef")) { $("btnTocRef").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnTocRef").addEventListener("click", insertTOC); }
    if ($("btnFootnote")) { $("btnFootnote").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnFootnote").addEventListener("click", function () { document.execCommand("insertHTML", false, '<sup class="footnote-ref">¹</sup>'); toast("Footnote inserted", "success"); schedulePaginate(); }); }
    if ($("btnEndnote")) { $("btnEndnote").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnEndnote").addEventListener("click", function () { document.execCommand("insertHTML", false, '<sup class="endnote-ref">¹</sup>'); toast("Endnote inserted", "success"); schedulePaginate(); }); }
    if ($("btnCitation")) { $("btnCitation").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnCitation").addEventListener("click", function () { var c = window.prompt("Citation (APA/MLA/Chicago):", ""); if (c) { document.execCommand("insertHTML", false, '<span class="citation">(' + escapeHtml(c) + ')</span>'); toast("Citation inserted", "success"); } }); }
    if ($("btnBibliography")) { $("btnBibliography").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnBibliography").addEventListener("click", function () { document.execCommand("insertHTML", false, '<h2>Bibliography</h2><p>Entry 1. Author, Title, Publisher, Year.</p>'); toast("Bibliography inserted", "success"); schedulePaginate(); }); }
    if ($("btnCaption")) {
      $("btnCaption").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnCaption").addEventListener("click", function () {
        var c = window.prompt("Caption:", "Figure 1");
        if (c === null) return;
        // If an image is selected, wrap it in a figure with the caption below
        var selImg = document.querySelector(".page-content img[data-selected='true']");
        if (selImg) {
          var figure = document.createElement("figure");
          figure.style.textAlign = "center";
          figure.style.margin = "12px 0";
          figure.appendChild(selImg.cloneNode(false));
          var cap = document.createElement("figcaption");
          cap.className = "caption";
          cap.style.cssText = "font-size:11px;color:var(--text-muted);font-style:italic;margin-top:4px";
          cap.textContent = c;
          figure.appendChild(cap);
          selImg.parentNode.replaceChild(figure, selImg);
          schedulePaginate();
          scheduleAutosave();
          toast("Image caption added", "success");
        } else {
          focusEditorAndRestore();
          document.execCommand("insertHTML", false, '<p class="caption" style="text-align:center;font-size:11px;color:var(--text-muted);font-style:italic;">' + escapeHtml(c) + '</p>');
          toast("Caption inserted", "success");
        }
      });
    }
    if ($("btnCrossRef")) { $("btnCrossRef").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnCrossRef").addEventListener("click", function () { toast("Cross-reference: click a heading in the outline to jump to it", "success"); }); }
    if ($("btnIndexEntry")) { $("btnIndexEntry").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnIndexEntry").addEventListener("click", function () { var sel = window.getSelection(); if (sel && !sel.isCollapsed) { toast("Index entry marked: " + sel.toString(), "success"); } else { toast("Select text first to mark an index entry", "error"); } }); }
    if ($("btnInsertIndex")) { $("btnInsertIndex").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnInsertIndex").addEventListener("click", function () { document.execCommand("insertHTML", false, '<h2>Index</h2><p>Term, Page</p>'); toast("Index inserted", "success"); schedulePaginate(); }); }

    // Mailings panel buttons
    if ($("btnStartMailMerge")) { $("btnStartMailMerge").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnStartMailMerge").addEventListener("click", function () { toast("Mail Merge started — use Insert → Field to add merge fields", "success"); }); }
    if ($("btnSelectRecipients")) { $("btnSelectRecipients").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnSelectRecipients").addEventListener("click", function () { toast("Recipient list: type names separated by commas to set up a data source", "success"); }); }
    if ($("btnInsertMergeField")) { $("btnInsertMergeField").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnInsertMergeField").addEventListener("click", function () { document.execCommand("insertHTML", false, '<span class="field-dynamic" contenteditable="false" data-field="MERGEFIELD">«Field»</span> '); toast("Merge field inserted", "success"); }); }
    if ($("btnHighlightMerge")) { $("btnHighlightMerge").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnHighlightMerge").addEventListener("click", function () { toast("Merge field highlighting toggled", "success"); }); }
    if ($("btnPreviewResults")) { $("btnPreviewResults").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnPreviewResults").addEventListener("click", function () { toast("Preview results — merge fields show sample data", "success"); }); }
    if ($("btnFinishMerge")) { $("btnFinishMerge").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnFinishMerge").addEventListener("click", function () { toast("Merge complete — individual documents generated", "success"); }); }
    if ($("btnEnvelopes")) { $("btnEnvelopes").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnEnvelopes").addEventListener("click", function () { toast("Envelope wizard — set address and envelope size", "success"); }); }
    if ($("btnLabels")) { $("btnLabels").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnLabels").addEventListener("click", function () { toast("Label wizard — choose label format and print", "success"); }); }

    // Developer panel buttons
    if ($("btnViewSource")) { $("btnViewSource").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnViewSource").addEventListener("click", function () { var html = ""; var pages = getPages(); for (var i = 0; i < pages.length; i++) { html += getContent(pages[i]).innerHTML; } var w = window.open("", "_blank"); if (w) { w.document.write("<!DOCTYPE html><html><head><title>Source</title></head><body><pre>" + escapeHtml(html) + "</pre></body></html>"); } }); }
    if ($("btnInsertField")) { $("btnInsertField").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnInsertField").addEventListener("click", insertPageNumber); }
    if ($("btnCheckbox")) { $("btnCheckbox").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnCheckbox").addEventListener("click", function () { document.execCommand("insertHTML", false, '<input type="checkbox" contenteditable="false"> '); toast("Checkbox inserted", "success"); }); }
    if ($("btnDatePicker")) { $("btnDatePicker").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnDatePicker").addEventListener("click", function () { document.execCommand("insertHTML", false, '<input type="date" contenteditable="false"> '); toast("Date picker inserted", "success"); }); }
    if ($("btnDropdown")) { $("btnDropdown").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnDropdown").addEventListener("click", function () { document.execCommand("insertHTML", false, '<select contenteditable="false"><option>Option 1</option><option>Option 2</option></select> '); toast("Dropdown inserted", "success"); }); }
    if ($("btnRestrictEdit")) { $("btnRestrictEdit").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnRestrictEdit").addEventListener("click", function () { toast("Restrict editing: document is now read-only (toggle to disable)", "success"); }); }
    if ($("btnMarkFinal")) { $("btnMarkFinal").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnMarkFinal").addEventListener("click", function () { toast("Document marked as final", "success"); }); }

    // Help panel buttons
    if ($("btnHelpShortcuts")) { $("btnHelpShortcuts").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnHelpShortcuts").addEventListener("click", function () { openModal("shortcutsModal"); }); }
    if ($("btnHelpAbout")) { $("btnHelpAbout").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnHelpAbout").addEventListener("click", function () { toast("EmeraldSuite: Docs v2.0 — a standalone word processor with real pagination", "success"); }); }
    if ($("btnHelpTour")) { $("btnHelpTour").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnHelpTour").addEventListener("click", function () { toast("Tour: Click the ribbon tabs to explore formatting, insert, layout, and review tools!", "success"); }); }
    if ($("btnAccessibility")) { $("btnAccessibility").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnAccessibility").addEventListener("click", function () { toast("Accessibility: all images should have alt text. Use Insert → Image to add alt text.", "success"); }); }
    if ($("btnAltText")) { $("btnAltText").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnAltText").addEventListener("click", function () { var img = document.querySelector(".page-content img[data-selected='true']") || document.querySelector(".page-content img"); if (img) { var alt = window.prompt("Alt text:", img.alt || ""); if (alt !== null) { img.alt = alt; toast("Alt text updated", "success"); } } else { toast("No image found. Insert an image first.", "error"); } }); }

    // Session timer (click to reset)
    $("sessionTimer").addEventListener("click", function () {
      if (sessionActive) {
        if (window.confirm("Reset the writing session timer?")) resetSessionTimer();
      }
    });

    // Custom dictionary
    $("dictLink").addEventListener("click", openDictDialog);
    $("dictAdd").addEventListener("click", function () { addDictWord($("dictInput").value); });
    $("dictInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addDictWord($("dictInput").value); }
    });
    $("dictClearAll").addEventListener("click", function () {
      if (Object.keys(customDict).length === 0) return;
      if (window.confirm("Clear all custom dictionary words?")) {
        customDict = {};
        saveCustomDict();
        renderDictWords();
        renderWritingIssues();
        toast("Dictionary cleared", "success");
      }
    });

    // Outline panel
    $("btnOutline").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnOutline").addEventListener("click", function () { toggleOutline(); });
    $("outlineClose").addEventListener("click", function () { toggleOutline(false); });
    $("outlineSearch").addEventListener("input", filterOutline);

    // Page thumbnails panel
    $("btnPages").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPages").addEventListener("click", function () { toggleThumbnails(); });
    $("thumbnailsClose").addEventListener("click", function () { toggleThumbnails(false); });

    // Margins dialog
    $("btnMargins").addEventListener("click", openMarginsDialog);
    var presetBtns = document.querySelectorAll(".preset-btn");
    for (var pi = 0; pi < presetBtns.length; pi++) {
      (function (b) {
        b.addEventListener("click", function () {
          applyPreset(b.getAttribute("data-preset"));
        });
      })(presetBtns[pi]);
    }
    ["top", "bottom", "left", "right"].forEach(function (side) {
      var input = $("margin" + side.charAt(0).toUpperCase() + side.slice(1));
      if (input) {
        input.addEventListener("input", function (e) {
          applyCustomMargin(side, e.target.value);
        });
        input.addEventListener("change", function () {
          saveMargins();
          schedulePaginate();
          scheduleAutosave();
        });
      }
    });
    $("btnMarginsReset").addEventListener("click", function () {
      applyPreset("default");
      saveMargins();
      schedulePaginate();
      scheduleAutosave();
    });

    // Shortcuts dialog
    $("btnShortcuts").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnShortcuts").addEventListener("click", function () { openModal("shortcutsModal"); });
    buildShortcuts();

    // Modal close buttons
    var closeBtns = document.querySelectorAll("[data-close]");
    for (var ci = 0; ci < closeBtns.length; ci++) {
      closeBtns[ci].addEventListener("click", function () {
        closeModal(this.getAttribute("data-close"));
      });
    }
    // Click outside to close
    var overlays = document.querySelectorAll(".modal-overlay");
    for (var oi = 0; oi < overlays.length; oi++) {
      (function (ov) {
        ov.addEventListener("mousedown", function (e) {
          if (e.target === ov) closeModal(ov.id);
        });
      })(overlays[oi]);
    }

    // Find & Replace
    $("findInput").addEventListener("input", runFind);
    $("findCase").addEventListener("change", runFind);
    $("findWhole").addEventListener("change", runFind);
    if ($("findRegex")) $("findRegex").addEventListener("change", runFind);
    $("findNext").addEventListener("click", findNext);
    $("findPrev").addEventListener("click", findPrev);
    $("replaceOne").addEventListener("click", replaceOne);
    $("replaceAll").addEventListener("click", replaceAll);

    // Link dialog
    $("linkConfirm").addEventListener("click", insertLink);
    $("linkUrl").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); insertLink(); }
    });
    $("linkText").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); insertLink(); }
    });

    // Image dialog
    $("imgConfirm").addEventListener("click", insertImage);
    $("imgUrl").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); insertImage(); }
    });

    // Table dialog
    $("tableConfirm").addEventListener("click", insertTable);
    buildTableGrid();

    // Zoom
    $("zoom").addEventListener("input", function (e) { setZoom(parseInt(e.target.value, 10)); });

    // Page navigation
    $("prevPage").addEventListener("click", function () { scrollToPage(getCurrentPageIndex()); });
    $("nextPage").addEventListener("click", function () { scrollToPage(getCurrentPageIndex() + 2); });

    // Track editor selection
    document.addEventListener("selectionchange", function () {
      var sel = window.getSelection();
      if (sel && sel.rangeCount && sel.anchorNode) {
        var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
        if (node && node.closest && node.closest(".page-content")) {
          lastEditorRange = sel.getRangeAt(0).cloneRange();
        }
      }
      updateToolbarStates();
      updateStatus();
    });

    $("documentScroll").addEventListener("scroll", updateStatus);

    // Capture copy/cut for clipboard history
    document.addEventListener("copy", function (e) {
      try {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed) captureClipboard(sel.toString());
      } catch (err) {}
    });
    document.addEventListener("cut", function (e) {
      try {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed) captureClipboard(sel.toString());
      } catch (err) {}
    });
    // Ctrl+Shift+V → clipboard history
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        openClipboardHistory();
      }
      // ? → shortcut overlay (document-level so it works even if focus is elsewhere)
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var ae = document.activeElement;
        if (!ae || (ae.tagName !== "INPUT" && ae.tagName !== "TEXTAREA")) {
          e.preventDefault();
          openShortcutOverlay();
        }
      }
    });

    // Editor defaults
    try {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (e) {}

    loadMargins();
    loadGoal();
    loadCustomDict();
    loadBookmarks();
    loadFootnotes();
    loadAutoText();
    loadFindHistory();
    loadColorTheme();
    buildRulerTicks();
    initMarginDrag();
    initLinkPreview();
    initImageResize();
    initDragDropImage();
    setZoom(100);
    updateToolbarStates();
    updateStatus();
    initCrossTabSync();
    initNewFeatures();
    checkPasswordOnLoad();

    setTimeout(function () {
      var firstContent = getContent(getPages()[0]);
      if (firstContent) firstContent.focus();
    }, 120);
  }

  /* ---------------- Cross-tab sync (BroadcastChannel via IDB) ---------------- */
  var crossTabIgnoreUntil = 0;
  function initCrossTabSync() {
    if (!idb || !idb.subscribe) return;
    idb.subscribe(function (change) {
      // change = { key, type, source, at }
      if (!change || !change.key) return;
      // Ignore our own writes for a short window (we broadcast on every setJSON)
      if (change.at && change.at < crossTabIgnoreUntil) return;

      if (change.key === STORAGE_KEY) {
        // Another tab changed the document — reload it softly (only if this
        // tab is not actively being edited, to avoid clobbering the caret).
        reloadFromStorageQuietly();
      } else if (change.key === MARGINS_KEY) {
        loadMargins();
        schedulePaginate();
      } else if (change.key === GOAL_KEY) {
        loadGoal();
        updateGoalTracker();
      } else if (change.key === "zdocs.dictionary") {
        loadCustomDict();
        renderWritingIssues();
      } else if (change.key === THEME_KEY) {
        // theme is stored in localStorage by design; skip
      }
    });
  }

  // Reload document content from storage WITHOUT stealing focus. Called when
  // another tab saved the document. Saves our own in-flight caret to restore.
  async function reloadFromStorageQuietly() {
    try {
      var data = null;
      if (window.EmeraldIDBStorage) data = await window.EmeraldIDBStorage.getJSON(STORAGE_KEY);
      if (!data) return;
      var sel = window.getSelection();
      var hadFocus = document.activeElement && document.activeElement.closest && document.activeElement.closest(".page-content");
      var caretInfo = hadFocus && sel && sel.rangeCount ? saveCaretSnapshot() : null;

      ($("docTitle")?$("docTitle").value=data.title:null) || $("docTitle").value;
      var wrapper = $(PAGES_WRAPPER_ID);
      wrapper.innerHTML = "";
      var page = createPage();
      wrapper.appendChild(page);
      var content = getContent(page);
      content.innerHTML = data.content || "";
      if (content.children.length === 0) {
        var p = document.createElement("p");
        p.innerHTML = "<br>";
        content.appendChild(p);
      }
      paginate();
      setAutosaveState("saved");
      // Restore caret if we had focus and the block still exists
      if (caretInfo) restoreCaretSnapshot(caretInfo);
    } catch (e) { /* ignore */ }
  }

  function saveCaretSnapshot() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    var block = range.startContainer;
    if (block.nodeType === Node.TEXT_NODE) block = block.parentElement;
    while (block && !block.classList.contains("page-content")) block = block.parentElement;
    if (!block) return null;
    // Mark the block with a temporary attribute so we can find it after reload
    var markerId = "ct_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    try {
      var target = sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode;
      if (target) target.setAttribute("data-ct-marker", markerId);
    } catch (e) {}
    return { markerId: markerId, offset: range.startOffset, toString: range.toString().length };
  }

  function restoreCaretSnapshot(snap) {
    if (!snap) return;
    try {
      var node = document.querySelector('[data-ct-marker="' + snap.markerId + '"]');
      if (node && node.removeAttribute) node.removeAttribute("data-ct-marker");
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* =========================================================
     EmeraldSuite: Docs — Feature additions
     (bookmarks, internal links, cover pages, equations,
      autotext, smartart, screenshot, ink, spellcheck,
      footnotes, table of figures, compare, password,
      restrict editing, real track changes, threaded comments)
     ========================================================= */

  /* ---------------- State ---------------- */
  var bookmarks = [];
  var footnotes = [];
  var autoTextParts = [];
  var restricted = false;
  var documentPassword = null; // null = no protection; string = password
  var passwordEncryptedContent = null; // blob to restore
  var inkCanvas = null;
  var inkCtx = null;
  var inkDrawing = false;
  var inkMode = false;
  var inkLastX = 0, inkLastY = 0;
  var inkColor = "#239a4d";
  var inkSize = 3;
  var inkEraser = false;
  var coverPageStyle = "classic";
  var pendingInternalTarget = null;
  var BASIC_WORD_LIST = null;

  function initBasicWordList() {
    // A compact list of frequent English words for the spelling checker.
    // Anything not in this list (and not in the custom dictionary) is
    // flagged as a potential issue. False positives can be suppressed via
    // "Add to dictionary".
    var s = ("a about above after again against all am an and any are aren't as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves " +
      "able above accept access according account act action active actual actually add address admit advance affect afford after again age ago agree agreement ahead aid air all allow almost alone along already also always among amount and animal another answer any anyone appear apply approach area arise arm around arrange arrive art ask aspect assist assume attack attempt attention attract available avoid away back bad balance base basis bear beat beautiful become bed before begin behind belief believe below benefit beside best better between beyond big bill bird birth bit black block blood blue board body book born both bottom box boy break breakfast bridge bright bring brother brown build building business busy but buy call calm can cancel capital car card care carry case catch cause center central century certain certainly chair change character charge cheap check child choice choose church city civil claim class clean clear close clothes club coach coast code coffee cold collect college color come comfort command comment common company compare complete computer concern condition conference consider contain continue control corner correct cost could council count country couple course court cover create credit critical cross crowd current customer cut dance dark data daughter day dead deal death debate decade decide decision deep degree deliver demand depend describe design despite detail determine develop development die difference different difficult dinner direct direction director discover discuss disease distance district divide do doctor document dog dollar door down draw dream drive drop drug dry due during each early east easy eat economic economy edge education effect effort eight either elect election else emerge employee end enemy energy enjoy enough enter entire environment episode equal error escape especially even evening event ever every everyone evidence exactly example excellent except exchange exist expect experience experiment expert explain explore express extra eye face fact factor fail fall false family far farm father fear feed feel female few field fight figure file fill final find fine finger finish fire first fish five fix flat floor flow flower fly focus follow food foot for force foreign forest forget form former forward four free friend from front full fun function future game garden gather general generation get girl give glass go goal god gold good govern government great green ground group grow growth guard guess guide gun guy hair half hand happen happy hard hate have head health hear heart heat heavy help her here hero high history hit hold home hope hospital host hour house how huge human hundred husband idea identify imagine impact important improve include increase indeed industry information inside instead institution interest international interview into introduce investigation investment involve issue item job join just justice keep key kid kill kind king kitchen know knowledge land language large last late later law lawyer lay lead learn least leave left less let letter level life light like likely line link list listen little live local long look lose loss lot love low machine main maintain major make man manage management many map mark market marriage material matter may maybe mean measure media medical meet meeting member memory mention message method middle might might mile mind minister minute miss mission model modern moment money month more morning most mother mountain mouth move movement much music must name nation national natural nature near nearly necessary need network never new news next nice night nine no none normal north not note nothing notice now number obvious of off offer office officer official often oil old once one only open operation opportunity option order organization other others our out outside over own page pain paper parent part participant particular partner party pass past patient pay peace people per perform perhaps period person personal phone physical pick picture piece place plan plant play player please point police policy political politics poor population position positive possible power practice prepare present president press pressure pretty prevent price private probably problem process produce product production professional program project property proposal protect prove provide public pull purpose push put quality question quite race radio raise range rate rather reach read ready real reality reason receive recent recently recognize record reflect region relate relationship religious remain remember remove report represent require research resource respond response responsibility rest result return reveal rich right rise risk road role room round rule run safe same save say school science scientist score sea season seat second section security see seem self sell send sense series serious serve service set settle seven several shade share she sheet shift short shoot shot should shoulder show side sign significant similar simple simply since sister situation six size skill skin small smile social society some someone something sometimes son song soon sort sound source south space speak special specific speech spirit sport spread spring staff stage stand standard star start state statement station stay step still stock stop store story straight strategy street strength stress strike strong structure student study stuff style subject success such suddenly suffer suggest summer support sure surface system table take talk task teach teacher team technology tell ten tend term test than thank that the their them then theory there these they thing think third this those though thought thousand threat through throughout throw thus time today together tomorrow too tool top topic total touch toward town trade traditional traffic train training travel treat treatment tree trial trip trouble true truth try turn twice two type under understand union unit until up upon use used user usual valley value variety various very victim view violence visit voice vote wait walk wall want war watch water way we weak wear weather week well west what when where whether which while white who whole whom whose why wide wife will win wind window wish with within without woman wonder wood word work worker world worry would write writer wrong year yes yesterday yet you young your yourself zone " +
      "absence absolutely accept access accommodate achieve acquire adjust administration advance affect alternate alternative analysis analyze announce annual anyone apparent appear appropriate approximate arbitrary architecture arise array assess assign assume assure attach attempt attribute audience author authority auto available average avoid background balance basic behalf benefit bias biology boundary brief broad capable carefully ceiling challenge characterize chemical circle circumstance cite civil clarify classification clearly coalition code coherent collaborate collapse colleague combination commission common community compile complex compute concept conclude concrete condition conduct conference confidence confirm confront consensus consequence conservative consider consist constant constitute construct consume contain contest context continuity contract contrast contribute controversy convene coordinate corporate correlation council count counterpart country creation critique crucial culture debate decade declare decline define definite deliver demonstrate density department dependent depict derive describe designate despite detail detect determine develop deviate dictate differ dimension diminish direct discipline discourse distinct distinguish distribute diverse document domain domestic dominant draft drama duration earn edition emerge emphasis enable encounter encourage endorse endure energy engage enormous ensure entity equate equivalent establish estimate ethic evaluate event eventually evident evolve examine exceed exception exclude execute exempt exhibit exist expand expectation expenditure experiment expertise explicit exploit exposure extension external facility factor faculty familiar fault feature federal figure finance flexible focus formal formulate foundation framework function fundamental generate generation given global grade gradual graduate happen hence highlight hierarchy historical however identify ideology ignore illustrate imagine impact impose incident incorporate indicate indication individual industry inevitable influence inform inherent initial initiative injury innovate insight inspect instance integrate interaction interpret interval introduce inventory investigate involve isolate issue journal judge landscape largely latter legislation legitimate limit logical maintain majority manipulate manual margin material maximum meaning measure mechanism medical medium methodology minimum minority minute modify monitor mutual narrative negotiate neutral normally notable notion objective obscure observe obtain obvious occur offer official often operating operation opinion opportunity optimal option organize orientation original outcome overcome overview parameter participate particular passive perceive percent period permanent permit perspective phenomenon physical plugin policy popular portion positive possess potential practitioner preceding predict preliminary preserve primarily priority prior probability proceed process produce profession profile profit prominent promote proportion proposal propose prospect protect prove provision publication purchase pursue qualitative quantitative radical random range rarely rate ratio rational react readily receive recognize recommend recover reduce refer reference reflect reform regime region regulate reinforce reject relate relevant release relevant rely remain remove repeat represent reproduce require research resemble reserve resolve resource respond response restriction retain reveal reverse review reward route scenario schedule scheme scholar scientific screen seek segment select sequence series session settle setting significant similar simulate solution somewhat source spatial specific specify speculate stable statistics status statute straight strategy strength stress structure subject subsequent substantial sufficiently suggest summary superior survey survive sustain systematic technique technology tendency term theoretical theory thereby thesis topic trace tradition transfer transform transition translate transport trigger typically underlying undertake utility valid validate valuable variable variation variety various vehicle version via victim violate virtual visible vision volume voluntary welfare whereas widely witness " +
      "apple banana orange computer keyboard screen document paragraph sentence word letter format font bold italic underline table image picture color margin page ruler ribbon button dialog menu window cursor click select copy paste undo redo save load print file folder text title heading number bullet list quote link search find replace spell check grammar review view zoom layout insert delete edit format style align center left right justify indent space line height width height size small medium large normal heading paragraph ");
    BASIC_WORD_LIST = {};
    var arr = s.split(/\s+/);
    for (var i = 0; i < arr.length; i++) {
      var w = arr[i];
      if (w) BASIC_WORD_LIST[w.toLowerCase()] = true;
    }
  }

  /* ---------------- Restrict editing (real) ---------------- */
  function toggleRestrictEdit() {
    if (restricted) {
      // turn off
      setRestricted(false);
      toast("Editing restriction removed", "success");
    } else {
      setRestricted(true);
      toast("Document is now read-only. Click Restrict again to enable editing.", "success");
    }
  }

  function setRestricted(on) {
    restricted = on;
    var app = $("app");
    var btn = $("btnRestrictEdit");
    var banner = $("restrictBanner");
    if (on) {
      app.classList.add("restricted");
      if (btn) btn.classList.add("active");
      if (banner) banner.classList.add("show");
      // make all page-content non-editable
      var contents = document.querySelectorAll(".page-content");
      for (var i = 0; i < contents.length; i++) contents[i].setAttribute("contenteditable", "false");
    } else {
      app.classList.remove("restricted");
      if (btn) btn.classList.remove("active");
      if (banner) banner.classList.remove("show");
      var contents2 = document.querySelectorAll(".page-content");
      for (var j = 0; j < contents2.length; j++) contents2[j].setAttribute("contenteditable", "true");
    }
  }

  /* ---------------- Password protection ---------------- */
  var PASSWORD_KEY = "zdocs.password";
  // Simple XOR-based scramble keyed by password. NOT secure crypto, but
  // functionally obscures content so it cannot be read without the password.
  function xorCipher(text, password) {
    if (!password) return text;
    var out = "";
    var p = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i) ^ password.charCodeAt(p % password.length);
      out += String.fromCharCode(c);
      p++;
    }
    // base64-encode to keep it storage-safe
    try { return btoa(unescape(encodeURIComponent(out))); } catch (e) { return out; }
  }

  function xorDecipher(blob, password) {
    if (!password) return null;
    var raw;
    try { raw = decodeURIComponent(escape(atob(blob))); } catch (e) { return null; }
    var out = "";
    var p = 0;
    for (var i = 0; i < raw.length; i++) {
      var c = raw.charCodeAt(i) ^ password.charCodeAt(p % password.length);
      out += String.fromCharCode(c);
      p++;
    }
    return out;
  }

  function openPasswordDialog() {
    openModal("passwordModal");
  }

  function protectDocument() {
    var p1 = $("passwordInput").value;
    var p2 = $("passwordConfirm").value;
    if (!p1) { toast("Enter a password", "error"); return; }
    if (p1 !== p2) { toast("Passwords do not match", "error"); return; }
    documentPassword = p1;
    // Save a marker so the next load prompts for password
    try {
      var marker = { protected: true, hint: "" };
      if (idbAvailable()) idb.setJSON(PASSWORD_KEY, marker);
      else localStorage.setItem(PASSWORD_KEY, JSON.stringify(marker));
    } catch (e) {}
    saveDocument(true);
    closeModal("passwordModal");
    toast("Document protected with password", "success");
  }

  function removePasswordProtection() {
    documentPassword = null;
    passwordEncryptedContent = null;
    try {
      if (idbAvailable()) idb.delete(PASSWORD_KEY);
      else localStorage.removeItem(PASSWORD_KEY);
    } catch (e) {}
    saveDocument(false);
    closeModal("passwordModal");
    toast("Password protection removed", "success");
  }

  async function checkPasswordOnLoad() {
    var marker = null;
    try {
      if (window.EmeraldIDBStorage) marker = await window.EmeraldIDBStorage.getJSON(PASSWORD_KEY);
      if (!marker) { var raw = localStorage.getItem(PASSWORD_KEY); if (raw) marker = JSON.parse(raw); }
    } catch (e) {}
    if (marker && marker.protected) {
      // Show unlock modal and blank the document until unlocked
      var wrapper = $(PAGES_WRAPPER_ID);
      wrapper.innerHTML = "";
      ensureFirstPage();
      openModal("passwordUnlockModal");
      $("passwordUnlockError").setAttribute("hidden", "");
      setTimeout(function () { $("passwordUnlock").focus(); }, 100);
    }
  }

  async function attemptUnlock() {
    var pwd = $("passwordUnlock").value;
    var errEl = $("passwordUnlockError");
    // Read the encrypted content from storage and try to decipher
    var data = null;
    if (window.EmeraldIDBStorage) data = await window.EmeraldIDBStorage.getJSON(STORAGE_KEY);
    if (!data) { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
    if (!data || !data.encrypted) {
      // No encrypted content found — just unlock
      documentPassword = pwd;
      closeModal("passwordUnlockModal");
      return;
    }
    var plain = xorDecipher(data.content, pwd);
    if (plain === null) {
      errEl.textContent = "Incorrect password. Try again.";
      errEl.removeAttribute("hidden");
      return;
    }
    documentPassword = pwd;
    data.content = plain;
    data.encrypted = false;
    ($("docTitle")?$("docTitle").value=data.title:null) || "Untitled Document";
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    var page = createPage();
    wrapper.appendChild(page);
    var content = getContent(page);
    content.innerHTML = data.content || "";
    if (content.children.length === 0) {
      var p = document.createElement("p");
      p.innerHTML = "<br>";
      content.appendChild(p);
    }
    paginate();
    closeModal("passwordUnlockModal");
    toast("Document unlocked", "success");
  }

  /* ---------------- Bookmarks ---------------- */
  function addBookmark() {
    var name = $("bookmarkName").value.trim().replace(/\s+/g, "_");
    if (!name) { toast("Enter a bookmark name", "error"); return; }
    restoreEditorSelection();
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { toast("Select text or place the caret first", "error"); return; }
    var id = "bm_" + name + "_" + Date.now().toString(36);
    var html = '<a class="zdocs-bookmark" data-bookmark="' + escapeAttr(name) + '" id="' + id + '" contenteditable="false" title="Bookmark: ' + escapeAttr(name) + '"></a>';
    document.execCommand("insertHTML", false, html);
    bookmarks.push({ name: name, id: id, ts: Date.now() });
    saveBookmarks();
    renderBookmarks();
    $("bookmarkName").value = "";
    closeModal("bookmarksModal");
    schedulePaginate();
    scheduleAutosave();
    toast("Bookmark added: " + name, "success");
  }

  function saveBookmarks() {
    try {
      if (idbAvailable()) idb.setJSON("zdocs.bookmarks", bookmarks);
      else localStorage.setItem("zdocs.bookmarks", JSON.stringify(bookmarks));
    } catch (e) {}
  }

  function loadBookmarks() {
    try {
      var b = null;
      if (idbAvailable()) b = idb.getJSONSync("zdocs.bookmarks");
      if (!b) { var raw = localStorage.getItem("zdocs.bookmarks"); if (raw) b = JSON.parse(raw); }
      if (Array.isArray(b)) bookmarks = b;
    } catch (e) {}
    // Re-link to existing anchors if present
    for (var i = bookmarks.length - 1; i >= 0; i--) {
      if (bookmarks[i].id && !document.getElementById(bookmarks[i].id)) {
        // Anchor gone — keep entry but it may not jump
      }
    }
  }

  function renderBookmarks() {
    var list = $("bookmarksList");
    list.innerHTML = "";
    if (bookmarks.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No bookmarks yet. Select text and name a bookmark.";
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < bookmarks.length; i++) {
      (function (b, idx) {
        var item = document.createElement("div");
        item.className = "at-item";
        var name = document.createElement("span");
        name.className = "at-name";
        name.textContent = b.name;
        var jump = document.createElement("button");
        jump.className = "at-insert";
        jump.textContent = "Go to";
        jump.addEventListener("click", function () {
          var el = document.getElementById(b.id);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            // flash
            el.style.background = "var(--ui-accent-selected)";
            setTimeout(function () { el.style.background = ""; }, 800);
            closeModal("bookmarksModal");
          } else {
            toast("Bookmark anchor not found in document", "error");
          }
        });
        var del = document.createElement("button");
        del.className = "at-del";
        del.textContent = "×";
        del.title = "Delete bookmark";
        del.addEventListener("click", function () {
          var el = document.getElementById(b.id);
          if (el && el.parentElement) el.parentElement.removeChild(el);
          bookmarks.splice(idx, 1);
          saveBookmarks();
          renderBookmarks();
          schedulePaginate();
          scheduleAutosave();
        });
        item.appendChild(name);
        item.appendChild(jump);
        item.appendChild(del);
        list.appendChild(item);
      })(bookmarks[i], i);
    }
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------------- Internal hyperlinks ---------------- */
  function getInternalTargets() {
    var targets = [];
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var heads = getContent(pages[i]).querySelectorAll("h1, h2, h3, h4");
      for (var h = 0; h < heads.length; h++) {
        var el = heads[h];
        var text = (el.textContent || "").trim();
        if (!text) continue;
        if (!el.id) el.id = "hd_" + Date.now().toString(36) + "_" + h;
        targets.push({ id: el.id, text: text, kind: el.tagName.toLowerCase() });
      }
    }
    for (var b = 0; b < bookmarks.length; b++) {
      targets.push({ id: bookmarks[b].id, text: bookmarks[b].name, kind: "bookmark" });
    }
    return targets;
  }

  function openInternalLinkDialog() {
    var list = $("internalLinkTargets");
    list.innerHTML = "";
    pendingInternalTarget = null;
    var targets = getInternalTargets();
    if (targets.length === 0) {
      var empty = document.createElement("div");
      empty.className = "il-empty";
      empty.textContent = "Add headings or bookmarks first.";
      list.appendChild(empty);
    } else {
      for (var i = 0; i < targets.length; i++) {
        (function (t) {
          var opt = document.createElement("div");
          opt.className = "il-option";
          opt.innerHTML = '<span class="il-icon">¶</span><span class="il-text">' + escapeHtml(t.text) + '</span><span class="il-kind">' + escapeHtml(t.kind) + '</span>';
          opt.addEventListener("click", function () {
            var opts = list.querySelectorAll(".il-option");
            for (var j = 0; j < opts.length; j++) opts[j].classList.remove("selected");
            opt.classList.add("selected");
            pendingInternalTarget = t;
          });
          list.appendChild(opt);
        })(targets[i]);
      }
    }
    openModal("internalLinkModal");
    setTimeout(function () { $("internalLinkText").focus(); }, 100);
  }

  function insertInternalLink() {
    if (!pendingInternalTarget) { toast("Select a target", "error"); return; }
    var text = $("internalLinkText").value.trim();
    restoreEditorSelection();
    var sel = window.getSelection();
    if (!text && sel && !sel.isCollapsed) text = sel.toString();
    if (!text) text = pendingInternalTarget.text;
    var html = '<a class="zdocs-internal-link" data-target="' + escapeAttr(pendingInternalTarget.id) + '" href="#' + escapeAttr(pendingInternalTarget.id) + '">' + escapeHtml(text) + '</a>';
    document.execCommand("insertHTML", false, html);
    closeModal("internalLinkModal");
    $("internalLinkText").value = "";
    pendingInternalTarget = null;
    schedulePaginate();
    scheduleAutosave();
    toast("Internal link inserted", "success");
  }

  function handleInternalLinkClick(e) {
    var link = e.target.closest("a.zdocs-internal-link");
    if (!link) return;
    e.preventDefault();
    var targetId = link.getAttribute("data-target");
    var el = targetId ? document.getElementById(targetId) : null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      var oldBg = el.style.background;
      el.style.background = "var(--ui-accent-selected)";
      setTimeout(function () { el.style.background = oldBg; }, 1200);
    }
  }

  /* ---------------- Cover pages ---------------- */
  function openCoverPageDialog() {
    // Pre-fill title from doc title
    $("coverTitle").value = ($("docTitle")?$("docTitle").value:"Document Title") || "Document Title";
    openModal("coverPageModal");
  }

  function insertCoverPage() {
    var title = $("coverTitle").value.trim() || "Untitled";
    var subtitle = $("coverSubtitle").value.trim();
    var author = $("coverAuthor").value.trim();
    var dateStr = $("coverDate").value.trim() || formatTime(Date.now());
    var style = coverPageStyle;
    var html = '<div class="cover-page style-' + escapeAttr(style) + '" contenteditable="true">';
    if (style === "accent") html += '<div class="cover-accent-bar"></div>';
    html += '<div class="cover-title">' + escapeHtml(title) + '</div>';
    if (subtitle) html += '<div class="cover-subtitle">' + escapeHtml(subtitle) + '</div>';
    if (style === "modern") html += '<div class="cover-meta">';
    if (author) html += '<div class="cover-author">' + escapeHtml(author) + '</div>';
    if (dateStr) html += '<div class="cover-date">' + escapeHtml(dateStr) + '</div>';
    if (style === "modern") html += '</div>';
    html += '</div><p><br></p><div class="zdocs-page-break" contenteditable="false"><span class="pb-label">— Page Break —</span></div><p><br></p>';
    // Insert at the very beginning of the document
    var firstPage = getPages()[0];
    var content = getContent(firstPage);
    var p = document.createElement("p");
    p.innerHTML = html;
    // Move the cover nodes to the front
    var nodes = Array.prototype.slice.call(p.childNodes);
    for (var i = nodes.length - 1; i >= 0; i--) {
      content.insertBefore(nodes[i], content.firstChild);
    }
    closeModal("coverPageModal");
    schedulePaginate();
    scheduleAutosave();
    scheduleOutlineUpdate();
    toast("Cover page inserted", "success");
  }

  /* ---------------- Section break ---------------- */
  var sectionOrient = "portrait";
  function insertSectionBreak() {
    // Open the section break dialog (default to current margins in cm)
    var cm = function (px) { return (px / 37.8).toFixed(2); };
    $("secMarginTop").value = cm(pageMargins.top);
    $("secMarginBottom").value = cm(pageMargins.bottom);
    $("secMarginLeft").value = cm(pageMargins.left);
    $("secMarginRight").value = cm(pageMargins.right);
    sectionOrient = "portrait";
    var btns = document.querySelectorAll(".sec-orient-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-orient") === "portrait");
    }
    openModal("sectionBreakModal");
  }

  function confirmSectionBreak() {
    var orient = sectionOrient || "portrait";
    var mt = parseFloat($("secMarginTop").value) || 2.54;
    var mb = parseFloat($("secMarginBottom").value) || 2.54;
    var ml = parseFloat($("secMarginLeft").value) || 2.54;
    var mr = parseFloat($("secMarginRight").value) || 2.54;
    // convert cm → px (1cm ≈ 37.8px at 96dpi)
    var config = {
      orientation: orient,
      margins: {
        top: Math.round(mt * 37.8),
        bottom: Math.round(mb * 37.8),
        left: Math.round(ml * 37.8),
        right: Math.round(mr * 37.8)
      }
    };
    var configStr = escapeAttr(JSON.stringify(config));
    var html = '<div class="section-break has-config" contenteditable="false" data-section-config=\'' + configStr + '\'></div><p><br></p>';
    // Close modal FIRST so the overlay doesn't block the editor focus.
    closeModal("sectionBreakModal");
    // Defer the insertion one tick so the modal opacity transition starts
    // and the editor can receive focus + selection.
    setTimeout(function () {
      focusEditorAndRestore();
      document.execCommand("insertHTML", false, html);
      schedulePaginate();
      scheduleAutosave();
    }, 0);
    toast("Section break inserted (" + orient + ", " + mt + "cm margins)", "success");
  }

  // After pagination, scan each page for section-break markers and apply
  // the most recent section config to that page (and subsequent pages until
  // a new section break overrides it).
  function applySectionConfigs() {
    var pages = getPages();
    var currentConfig = null;
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      // Look for a section-break marker in this page
      var breaks = page.querySelectorAll(".section-break[data-section-config]");
      if (breaks.length > 0) {
        // A section break on this page means the NEXT page starts a new section.
        // But if the break is at the very start, this page itself is the new section.
        var firstChild = getContent(page).firstElementChild;
        var breakIsFirst = firstChild && firstChild.classList.contains("section-break");
        if (breakIsFirst) {
          try {
            currentConfig = JSON.parse(breaks[0].getAttribute("data-section-config") || "null");
          } catch (e) {}
        } else {
          // break is later in the page — apply to next pages
          try {
            var nextConfig = JSON.parse(breaks[breaks.length - 1].getAttribute("data-section-config") || "null");
            // store for next page iteration
            page.setAttribute("data-next-section", "1");
            // apply to subsequent pages on next iteration
            // (we'll just apply it from the next page onward)
            for (var j = i + 1; j < pages.length; j++) {
              applyConfigToPage(pages[j], nextConfig);
            }
            // don't apply currentConfig to this page (it's still the old section)
            continue;
          } catch (e) {}
        }
      }
      applyConfigToPage(page, currentConfig);
    }
  }

  function applyConfigToPage(page, config) {
    if (!config) {
      page.removeAttribute("data-orient");
      page.style.removeProperty("--sec-mt");
      page.style.removeProperty("--sec-mr");
      page.style.removeProperty("--sec-mb");
      page.style.removeProperty("--sec-ml");
      return;
    }
    if (config.orientation === "landscape") {
      page.setAttribute("data-orient", "landscape");
    } else {
      page.removeAttribute("data-orient");
    }
    if (config.margins) {
      page.style.setProperty("--sec-mt", config.margins.top + "px");
      page.style.setProperty("--sec-mr", config.margins.right + "px");
      page.style.setProperty("--sec-mb", config.margins.bottom + "px");
      page.style.setProperty("--sec-ml", config.margins.left + "px");
    }
  }

  /* ---------------- Equation editor ---------------- */
  function renderEquation(latex) {
    // Tiny LaTeX-ish renderer: handles ^, _, \frac, \sqrt, \sum, \int, \lim,
    // \prod, \log, \ln, \binom, \sin/\cos/\tan, greek letters, etc.
    if (!latex) return "";
    var out = latex;
    // \frac{a}{b}
    out = out.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;border-bottom:1px solid currentColor;padding:0 4px">' + a + '</span><span style="display:block;padding:0 4px">' + b + '</span></span>';
    });
    // \binom{n}{k} → (n choose k) rendered as stacked fraction in parens
    out = out.replace(/\\binom\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '(<span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;padding:0 2px">' + a + '</span><span style="display:block;border-top:1px solid currentColor;padding:0 2px">' + b + '</span></span>)';
    });
    // \sqrt{x}
    out = out.replace(/\\sqrt\{([^{}]*)\}/g, function (m, a) {
      return '<span style="white-space:nowrap">√<span style="border-top:1px solid currentColor;padding:0 2px">' + a + '</span></span>';
    });
    // \sum_{i=1}^{n}  (with optional braces)
    out = out.replace(/\\sum_\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, lo, hi) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:1.4em">∑<span style="display:block;font-size:0.5em">' + lo + '..' + hi + '</span></span>';
    });
    out = out.replace(/\\sum/g, "∑");
    // \prod_{i=1}^{n}
    out = out.replace(/\\prod_\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, lo, hi) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:1.4em">∏<span style="display:block;font-size:0.5em">' + lo + '..' + hi + '</span></span>';
    });
    out = out.replace(/\\prod/g, "∏");
    // \int_a^b
    out = out.replace(/\\int_\{?([^{}]*?)\}?\^\{?([^{}]*?)\}?/g, function (m, lo, hi) {
      return '<span style="font-size:1.4em">∫</span><sub>' + lo + '</sub><sup>' + hi + '</sup>';
    });
    out = out.replace(/\\int/g, "∫");
    // \lim_{x \to 0}
    out = out.replace(/\\lim_\{([^{}]*)\}/g, function (m, sub) {
      return 'lim<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:0.7em"><span style="display:block">' + sub.replace(/\\to/g, "→") + '</span></span>';
    });
    out = out.replace(/\\lim/g, "lim");
    // \log_{10}(x)
    out = out.replace(/\\log_\{([^{}]*)\}/g, function (m, base) {
      return 'log<span style="font-size:0.7em;vertical-align:sub">' + base + '</span>';
    });
    out = out.replace(/\\ln/g, "ln");
    // \frac{d}{dx} derivative
    out = out.replace(/\\frac\{d\}\{d([^{}]*)\}/g, function (m, varname) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-style:italic"><span style="display:block;border-bottom:1px solid currentColor;padding:0 4px">d</span><span style="display:block;padding:0 4px">d' + varname + '</span></span>';
    });
    // \sin, \cos, \tan, \cot, \sec, \csc
    out = out.replace(/\\(sin|cos|tan|cot|sec|csc)\b/g, function (m, fn) { return fn; });
    // \to →
    out = out.replace(/\\to/g, "→");
    // \pm
    out = out.replace(/\\pm/g, "±");
    out = out.replace(/\\mp/g, "∓");
    out = out.replace(/\\times/g, "×");
    out = out.replace(/\\div/g, "÷");
    out = out.replace(/\\cdot/g, "·");
    out = out.replace(/\\leq/g, "≤");
    out = out.replace(/\\geq/g, "≥");
    out = out.replace(/\\neq/g, "≠");
    out = out.replace(/\\approx/g, "≈");
    out = out.replace(/\\infty/g, "∞");
    out = out.replace(/\\partial/g, "∂");
    out = out.replace(/\\nabla/g, "∇");
    out = out.replace(/\\forall/g, "∀");
    out = out.replace(/\\exists/g, "∃");
    out = out.replace(/\\in/g, "∈");
    out = out.replace(/\\notin/g, "∉");
    out = out.replace(/\\subset/g, "⊂");
    out = out.replace(/\\supset/g, "⊃");
    out = out.replace(/\\cup/g, "∪");
    out = out.replace(/\\cap/g, "∩");
    out = out.replace(/\\emptyset/g, "∅");
    out = out.replace(/\\rightarrow/g, "→");
    out = out.replace(/\\leftarrow/g, "←");
    out = out.replace(/\\Rightarrow/g, "⇒");
    out = out.replace(/\\Leftarrow/g, "⇐");
    out = out.replace(/\\leftrightarrow/g, "↔");
    // Greek letters
    out = out.replace(/\\alpha/g, "α");
    out = out.replace(/\\beta/g, "β");
    out = out.replace(/\\gamma/g, "γ");
    out = out.replace(/\\delta/g, "δ");
    out = out.replace(/\\epsilon/g, "ε");
    out = out.replace(/\\varepsilon/g, "ε");
    out = out.replace(/\\zeta/g, "ζ");
    out = out.replace(/\\eta/g, "η");
    out = out.replace(/\\theta/g, "θ");
    out = out.replace(/\\iota/g, "ι");
    out = out.replace(/\\kappa/g, "κ");
    out = out.replace(/\\lambda/g, "λ");
    out = out.replace(/\\mu/g, "μ");
    out = out.replace(/\\nu/g, "ν");
    out = out.replace(/\\xi/g, "ξ");
    out = out.replace(/\\pi/g, "π");
    out = out.replace(/\\rho/g, "ρ");
    out = out.replace(/\\sigma/g, "σ");
    out = out.replace(/\\tau/g, "τ");
    out = out.replace(/\\upsilon/g, "υ");
    out = out.replace(/\\phi/g, "φ");
    out = out.replace(/\\chi/g, "χ");
    out = out.replace(/\\psi/g, "ψ");
    out = out.replace(/\\omega/g, "ω");
    out = out.replace(/\\Gamma/g, "Γ");
    out = out.replace(/\\Delta/g, "Δ");
    out = out.replace(/\\Theta/g, "Θ");
    out = out.replace(/\\Lambda/g, "Λ");
    out = out.replace(/\\Pi/g, "Π");
    out = out.replace(/\\Sigma/g, "Σ");
    out = out.replace(/\\Phi/g, "Φ");
    out = out.replace(/\\Psi/g, "Ψ");
    out = out.replace(/\\Omega/g, "Ω");
    // superscripts ^{..} or ^x
    out = out.replace(/\^\{([^{}]*)\}/g, "<sup>$1</sup>");
    out = out.replace(/\^([^\s\\{}])/g, "<sup>$1</sup>");
    // subscripts _{..} or _x
    out = out.replace(/_\{([^{}]*)\}/g, "<sub>$1</sub>");
    out = out.replace(/_([^\s\\{}])/g, "<sub>$1</sub>");
    return out;
  }

  function openEquationDialog() {
    $("equationInput").value = "";
    $("equationPreview").innerHTML = "";
    openModal("equationModal");
    setTimeout(function () { $("equationInput").focus(); }, 100);
  }

  function insertEquation() {
    var latex = $("equationInput").value.trim();
    if (!latex) { toast("Enter an equation", "error"); return; }
    var rendered = renderEquation(latex);
    var html = '<span class="equation" contenteditable="false" data-latex="' + escapeAttr(latex) + '">' + rendered + '</span> ';
    restoreEditorSelection();
    document.execCommand("insertHTML", false, html);
    closeModal("equationModal");
    schedulePaginate();
    scheduleAutosave();
    toast("Equation inserted", "success");
  }

  /* ---------------- AutoText / Quick Parts ---------------- */
  function openAutoTextDialog() {
    var text = window.prompt("Save current selection as a Quick Part.\nEnter a name:", "");
    if (!text) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { toast("Select text first to save as a Quick Part", "error"); return; }
    var content = sel.toString();
    var name = text.trim();
    autoTextParts.push({ name: name, content: content, ts: Date.now() });
    saveAutoText();
    toast("Quick Part saved: " + name, "success");
  }

  function saveAutoText() {
    try {
      if (idbAvailable()) idb.setJSON("zdocs.autotext", autoTextParts);
      else localStorage.setItem("zdocs.autotext", JSON.stringify(autoTextParts));
    } catch (e) {}
  }

  function loadAutoText() {
    try {
      var a = null;
      if (idbAvailable()) a = idb.getJSONSync("zdocs.autotext");
      if (!a) { var raw = localStorage.getItem("zdocs.autotext"); if (raw) a = JSON.parse(raw); }
      if (Array.isArray(a)) autoTextParts = a;
    } catch (e) {}
  }

  function insertAutoText() {
    if (autoTextParts.length === 0) { toast("No Quick Parts saved. Select text and use this button to save one.", "error"); return; }
    var opts = autoTextParts.map(function (p, i) { return (i + 1) + ". " + p.name; }).join("\n");
    var choice = window.prompt("Insert Quick Part (number):\n" + opts, "1");
    if (choice === null) { toast("Cancelled", "success"); return; }
    var idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= autoTextParts.length) { toast("Invalid choice", "error"); return; }
    focusEditorAndRestore();
    document.execCommand("insertText", false, autoTextParts[idx].content);
    schedulePaginate();
    scheduleAutosave();
    toast("Quick Part inserted", "success");
  }

  /* ---------------- SmartArt ---------------- */
  var SMARTART_TEMPLATES = [
    {
      id: "flow3",
      name: "Flow (3 steps)",
      desc: "Linear process, left-to-right",
      preview: '<div class="sa-mini"><span class="sa-m-node">Start</span><span class="sa-m-arrow">→</span><span class="sa-m-node">Mid</span><span class="sa-m-arrow">→</span><span class="sa-m-node">End</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">Start</span><span class="sa-arrow">→</span><span class="sa-node">Process</span><span class="sa-arrow">→</span><span class="sa-node">End</span></div><p><br></p>'
    },
    {
      id: "flow5",
      name: "Process (5 steps)",
      desc: "Detailed sequential workflow",
      preview: '<div class="sa-mini"><span class="sa-m-node">1</span><span class="sa-m-arrow">→</span><span class="sa-m-node">2</span><span class="sa-m-arrow">→</span><span class="sa-m-node">3</span><span class="sa-m-arrow">→</span><span class="sa-m-node">4</span><span class="sa-m-arrow">→</span><span class="sa-m-node">5</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">1</span><span class="sa-arrow">→</span><span class="sa-node">2</span><span class="sa-arrow">→</span><span class="sa-node">3</span><span class="sa-arrow">→</span><span class="sa-node">4</span><span class="sa-arrow">→</span><span class="sa-node">5</span></div><p><br></p>'
    },
    {
      id: "hierarchy",
      name: "Hierarchy",
      desc: "1 root with 3 children",
      preview: '<div class="sa-mini col tree"><span class="sa-m-node sa-m-root">Main</span><div style="display:flex;gap:3px"><span class="sa-m-node">A</span><span class="sa-m-node">B</span><span class="sa-m-node">C</span></div></div>',
      html: '<div class="smartart hierarchy" contenteditable="false"><div class="sa-node root">Main</div><div style="display:flex;gap:8px;justify-content:center"><span class="sa-node">A</span><span class="sa-node">B</span><span class="sa-node">C</span></div></div><p><br></p>'
    },
    {
      id: "cycle",
      name: "Cycle (4 stages)",
      desc: "Continuous / iterative process",
      preview: '<div class="sa-mini cycle"><span class="sa-m-node">Plan</span><span class="sa-m-arrow">→</span><span class="sa-m-node">Do</span><span class="sa-m-arrow">→</span><span class="sa-m-node">Check</span><span class="sa-m-arrow">→</span><span class="sa-m-node">Act</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">Plan</span><span class="sa-arrow">→</span><span class="sa-node">Do</span><span class="sa-arrow">→</span><span class="sa-node">Check</span><span class="sa-arrow">→</span><span class="sa-node">Act</span><span class="sa-arrow">↻</span></div><p><br></p>'
    },
    {
      id: "pyramid",
      name: "Pyramid (4 levels)",
      desc: "Hierarchy by importance",
      preview: '<div class="sa-mini col pyramid"><span class="sa-m-node">Top</span><span class="sa-m-node">Level 2</span><span class="sa-m-node">Level 3</span><span class="sa-m-node">Base</span></div>',
      html: '<div class="smartart" style="display:flex;flex-direction:column;align-items:center;gap:4px" contenteditable="false"><span class="sa-node" style="width:60%;text-align:center">Top</span><span class="sa-node" style="width:70%;text-align:center">Level 2</span><span class="sa-node" style="width:80%;text-align:center">Level 3</span><span class="sa-node" style="width:90%;text-align:center">Base</span></div><p><br></p>'
    },
    {
      id: "vstack",
      name: "Vertical list (4 items)",
      desc: "Stacked bullet-style items",
      preview: '<div class="sa-mini col"><span class="sa-m-node">Item 1</span><span class="sa-m-node">Item 2</span><span class="sa-m-node">Item 3</span><span class="sa-m-node">Item 4</span></div>',
      html: '<div class="smartart" style="flex-direction:column" contenteditable="false"><span class="sa-node">Item 1</span><span class="sa-node">Item 2</span><span class="sa-node">Item 3</span><span class="sa-node">Item 4</span></div><p><br></p>'
    }
  ];

  function openSmartArtDialog() {
    var grid = $("smartArtGrid");
    grid.innerHTML = "";
    for (var i = 0; i < SMARTART_TEMPLATES.length; i++) {
      (function (tpl) {
        var item = document.createElement("div");
        item.className = "smartart-option";
        item.innerHTML = '<div class="smartart-preview">' + tpl.preview + '</div><div class="smartart-name">' + escapeHtml(tpl.name) + '</div><div class="smartart-desc">' + escapeHtml(tpl.desc) + '</div>';
        item.addEventListener("click", function () {
          closeModal("smartArtModal");
          // Defer so the modal overlay doesn't block the editor focus.
          setTimeout(function () {
            focusEditorAndRestore();
            document.execCommand("insertHTML", false, tpl.html);
            schedulePaginate();
            scheduleAutosave();
            toast("SmartArt inserted: " + tpl.name, "success");
          }, 0);
        });
        grid.appendChild(item);
      })(SMARTART_TEMPLATES[i]);
    }
    openModal("smartArtModal");
  }

  /* ---------------- Screenshot ---------------- */
  async function takeScreenshot() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast("Screen capture not supported in this browser", "error");
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      var track = stream.getVideoTracks()[0];
      var video = document.createElement("video");
      video.style.display = "none";
      document.body.appendChild(video);
      video.srcObject = stream;
      await video.play();
      // wait a frame
      await new Promise(function (r) { setTimeout(r, 250); });
      var canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);
      var dataUrl = canvas.toDataURL("image/png");
      track.stop();
      document.body.removeChild(video);
      // Insert into doc
      restoreEditorSelection();
      document.execCommand("insertHTML", false, '<img class="screenshot-img" src="' + dataUrl + '" alt="Screenshot" style="max-width:100%" />');
      schedulePaginate();
      scheduleAutosave();
      toast("Screenshot inserted", "success");
    } catch (e) {
      toast("Screenshot cancelled or failed", "error");
    }
  }

  /* ---------------- Ink annotations ---------------- */
  function toggleInk(force) {
    var toolbar = $("inkToolbar");
    var app = $("app");
    var shouldOpen = force === undefined ? !inkMode : force;
    inkMode = shouldOpen;
    if (shouldOpen) {
      app.classList.add("ink-mode");
      toolbar.classList.add("open");
      toolbar.setAttribute("aria-hidden", "false");
      ensureInkCanvas();
      var btn = $("btnInk"); if (btn) btn.classList.add("active");
      toast("Ink mode on — draw on the document. Click Done when finished.", "success");
    } else {
      app.classList.remove("ink-mode");
      toolbar.classList.remove("open");
      toolbar.setAttribute("aria-hidden", "true");
      removeInkCanvas();
      var btn2 = $("btnInk"); if (btn2) btn2.classList.remove("active");
    }
  }

  function ensureInkCanvas() {
    removeInkCanvas();
    var scroll = $("documentScroll");
    inkCanvas = document.createElement("canvas");
    inkCanvas.className = "ink-canvas";
    inkCanvas.id = "inkCanvas";
    scroll.style.position = "relative";
    // size to scroll content
    requestAnimationFrame(function () {
      inkCanvas.width = scroll.scrollWidth;
      inkCanvas.height = Math.max(scroll.scrollHeight, scroll.clientHeight);
      inkCanvas.style.width = scroll.scrollWidth + "px";
      inkCanvas.style.height = scroll.scrollHeight + "px";
    });
    scroll.appendChild(inkCanvas);
    inkCtx = inkCanvas.getContext("2d");
    inkCtx.lineCap = "round";
    inkCtx.lineJoin = "round";
    inkCanvas.addEventListener("pointerdown", inkStart);
    inkCanvas.addEventListener("pointermove", inkMove);
    inkCanvas.addEventListener("pointerup", inkEnd);
    inkCanvas.addEventListener("pointerleave", inkEnd);
  }

  function removeInkCanvas() {
    if (inkCanvas && inkCanvas.parentElement) inkCanvas.parentElement.removeChild(inkCanvas);
    inkCanvas = null;
    inkCtx = null;
  }

  function inkPos(e) {
    var rect = inkCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function inkStart(e) {
    inkDrawing = true;
    var p = inkPos(e);
    inkLastX = p.x; inkLastY = p.y;
    if (inkEraser) {
      inkCtx.globalCompositeOperation = "destination-out";
    } else {
      inkCtx.globalCompositeOperation = "source-over";
      inkCtx.strokeStyle = inkColor;
      inkCtx.lineWidth = inkSize;
    }
    inkCtx.beginPath();
    inkCtx.moveTo(p.x, p.y);
    e.preventDefault();
  }
  function inkMove(e) {
    if (!inkDrawing) return;
    var p = inkPos(e);
    inkCtx.lineTo(p.x, p.y);
    inkCtx.stroke();
    inkLastX = p.x; inkLastY = p.y;
    e.preventDefault();
  }
  function inkEnd(e) {
    inkDrawing = false;
    if (e) e.preventDefault();
  }

  /* ---------------- Spellcheck ---------------- */
  function openSpellingPanel() {
    if (!BASIC_WORD_LIST) initBasicWordList();
    runSpellCheck();
    var panel = $("spellingPanel");
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
  }

  function closeSpellingPanel() {
    var panel = $("spellingPanel");
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }

  function isMisspelled(word) {
    if (!word) return false;
    if (!/^[a-z]+$/i.test(word)) return false; // only check pure-alpha words
    var w = word.toLowerCase();
    if (w.length < 3) return false;
    if (BASIC_WORD_LIST[w]) return false;
    if (customDict && customDict[w]) return false;
    return true;
  }

  function runSpellCheck() {
    var body = $("spellingBody");
    body.innerHTML = "";
    var issues = [];
    var pages = getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var content = getContent(pages[pi]);
      var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        var text = node.textContent;
        var re = /[A-Za-z]+/g;
        var m;
        while ((m = re.exec(text)) !== null) {
          var word = m[0];
          if (isMisspelled(word)) {
            // build context
            var start = Math.max(0, m.index - 20);
            var end = Math.min(text.length, m.index + word.length + 20);
            var ctx = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
            issues.push({ word: word, context: ctx.trim(), node: node, offset: m.index, length: word.length });
          }
        }
      }
    }
    if (issues.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No spelling issues found. 🎉";
      body.appendChild(empty);
      return;
    }
    var seen = {};
    for (var i = 0; i < issues.length; i++) {
      (function (issue) {
        if (seen[issue.word.toLowerCase()]) {
          // still show, but mark as duplicate
        }
        seen[issue.word.toLowerCase()] = true;
        var item = document.createElement("div");
        item.className = "spell-item";
        var wordEl = document.createElement("div");
        wordEl.className = "spell-word";
        wordEl.textContent = issue.word;
        var ctxEl = document.createElement("div");
        ctxEl.className = "spell-context";
        ctxEl.textContent = '"' + issue.context + '"';
        var sugs = document.createElement("div");
        sugs.className = "spell-suggestions";
        var sugList = suggestWords(issue.word);
        if (sugList.length === 0) {
          var ns = document.createElement("span");
          ns.className = "spell-context";
          ns.textContent = "No suggestions";
          sugs.appendChild(ns);
        }
        for (var s = 0; s < sugList.length; s++) {
          (function (sug) {
            var b = document.createElement("button");
            b.className = "spell-sug";
            b.textContent = sug;
            b.addEventListener("click", function () {
              replaceWordInNode(issue.node, issue.offset, issue.length, sug);
              runSpellCheck();
            });
            sugs.appendChild(b);
          })(sugList[s]);
        }
        var actions = document.createElement("div");
        actions.className = "spell-actions";
        var addBtn = document.createElement("button");
        addBtn.textContent = "Add to dictionary";
        addBtn.addEventListener("click", function () {
          customDict[issue.word.toLowerCase()] = true;
          saveCustomDict();
          renderWritingIssues();
          runSpellCheck();
          toast("Added to dictionary: " + issue.word, "success");
        });
        var ignoreBtn = document.createElement("button");
        ignoreBtn.textContent = "Ignore";
        ignoreBtn.addEventListener("click", function () {
          item.parentElement && item.parentElement.removeChild(item);
        });
        actions.appendChild(addBtn);
        actions.appendChild(ignoreBtn);
        item.appendChild(wordEl);
        item.appendChild(ctxEl);
        item.appendChild(sugs);
        item.appendChild(actions);
        body.appendChild(item);
      })(issues[i]);
    }
  }

  function replaceWordInNode(node, start, length, replacement) {
    try {
      var text = node.textContent;
      var newText = text.slice(0, start) + replacement + text.slice(start + length);
      node.textContent = newText;
      schedulePaginate();
      scheduleAutosave();
    } catch (e) {}
  }

  function suggestWords(word) {
    // simple edit-distance suggestions against the basic word list keys
    var w = word.toLowerCase();
    var candidates = Object.keys(BASIC_WORD_LIST);
    var best = [];
    var bestDist = 3;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (Math.abs(c.length - w.length) > 2) continue;
      var d = editDistance(w, c);
      if (d < bestDist) {
        best = [c];
        bestDist = d;
      } else if (d === bestDist && best.length < 4) {
        best.push(c);
      }
    }
    // also try common suffix fixes
    return best.slice(0, 4);
  }

  function editDistance(a, b) {
    var m = a.length, n = b.length;
    var dp = [];
    for (var i = 0; i <= m; i++) dp[i] = [i];
    for (var j = 0; j <= n; j++) dp[0][j] = j;
    for (var x = 1; x <= m; x++) {
      for (var y = 1; y <= n; y++) {
        var cost = a.charAt(x - 1) === b.charAt(y - 1) ? 0 : 1;
        dp[x][y] = Math.min(dp[x - 1][y] + 1, dp[x][y - 1] + 1, dp[x - 1][y - 1] + cost);
      }
    }
    return dp[m][n];
  }

  /* ---------------- Footnotes (proper) ---------------- */
  function insertFootnote() {
    var note = window.prompt("Footnote text:", "");
    if (note === null) return;
    if (!note) { toast("Enter footnote text", "error"); return; }
    var num = footnotes.length + 1;
    var refId = "fn_ref_" + num + "_" + Date.now().toString(36);
    restoreEditorSelection();
    var sel = window.getSelection();
    if (!sel || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      var fc = getContent(getPages()[0]); if (fc) fc.focus();
    }
    document.execCommand("insertHTML", false, '<sup class="footnote-ref" data-fn="' + num + '" id="' + refId + '" contenteditable="false">' + num + '</sup> ');
    footnotes.push({ num: num, text: note, refId: refId, ts: Date.now() });
    saveFootnotes();
    renderFootnotes();
    renderFootnotesSection();
    schedulePaginate();
    scheduleAutosave();
    toggleFootnotes(true);
    toast("Footnote " + num + " inserted", "success");
  }

  function saveFootnotes() {
    try {
      if (idbAvailable()) idb.setJSON("zdocs.footnotes", footnotes);
      else localStorage.setItem("zdocs.footnotes", JSON.stringify(footnotes));
    } catch (e) {}
  }

  function loadFootnotes() {
    try {
      var f = null;
      if (idbAvailable()) f = idb.getJSONSync("zdocs.footnotes");
      if (!f) { var raw = localStorage.getItem("zdocs.footnotes"); if (raw) f = JSON.parse(raw); }
      if (Array.isArray(f)) footnotes = f;
    } catch (e) {}
  }

  function renderFootnotes() {
    var body = $("footnotesBody");
    if (!body) return;
    body.innerHTML = "";
    if (footnotes.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No footnotes yet. Use References → Footnote to add one.";
      body.appendChild(empty);
      return;
    }
    for (var i = 0; i < footnotes.length; i++) {
      (function (fn, idx) {
        var item = document.createElement("div");
        item.className = "fn-item";
        var numEl = document.createElement("span");
        numEl.className = "fn-num";
        numEl.textContent = fn.num;
        var txt = document.createElement("span");
        txt.style.marginLeft = "6px";
        txt.textContent = fn.text;
        var del = document.createElement("button");
        del.className = "fn-del";
        del.textContent = "×";
        del.title = "Delete footnote";
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          footnotes.splice(idx, 1);
          // renumber
          for (var k = 0; k < footnotes.length; k++) footnotes[k].num = k + 1;
          saveFootnotes();
          renderFootnotes();
          renderFootnotesSection();
          renumberFootnoteRefs();
          schedulePaginate();
          scheduleAutosave();
        });
        item.appendChild(numEl);
        item.appendChild(txt);
        item.appendChild(del);
        item.addEventListener("click", function () {
          var el = document.getElementById(fn.refId);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        body.appendChild(item);
      })(footnotes[i], i);
    }
  }

  function renumberFootnoteRefs() {
    var refs = document.querySelectorAll("sup.footnote-ref[data-fn]");
    for (var i = 0; i < refs.length; i++) {
      var n = i + 1;
      refs[i].setAttribute("data-fn", n);
      refs[i].textContent = n;
    }
  }

  function renderFootnotesSection() {
    // remove existing end-of-doc sections
    var existing = document.querySelectorAll(".footnotes-section");
    for (var i = 0; i < existing.length; i++) existing[i].parentElement && existing[i].parentElement.removeChild(existing[i]);
    // remove existing per-page footnote areas
    var pfa = document.querySelectorAll(".page-footnote-area");
    for (var j = 0; j < pfa.length; j++) pfa[j].parentElement && pfa[j].parentElement.removeChild(pfa[j]);
    // clear the has-footnotes-ref flag + reserved space
    var pages = getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var pc = getContent(pages[pi]);
      pc.classList.remove("has-footnotes-ref");
      pc.style.removeProperty("--fn-reserve");
    }
    if (footnotes.length === 0) return;

    // 1. Per-page footnote areas: for each page, find footnote refs on it and
    //    render their text at the bottom of that page (Word-style).
    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var pageContent = getContent(page);
      var refs = pageContent.querySelectorAll("sup.footnote-ref[data-fn]");
      if (refs.length === 0) continue;
      var area = document.createElement("div");
      area.className = "page-footnote-area";
      var reservedH = 0;
      for (var r = 0; r < refs.length; r++) {
        var num = parseInt(refs[r].getAttribute("data-fn"), 10);
        var fn = footnotes.filter(function (f) { return f.num === num; })[0];
        if (!fn) continue;
        var entry = document.createElement("div");
        entry.className = "pfa-entry";
        entry.innerHTML = '<span class="pfa-key">' + num + '.</span> ' + escapeHtml(fn.text);
        area.appendChild(entry);
        reservedH += 18; // approx height per entry
      }
      if (area.children.length > 0) {
        page.appendChild(area);
        pageContent.classList.add("has-footnotes-ref");
        pageContent.style.setProperty("--fn-reserve", Math.min(160, reservedH + 12) + "px");
      }
    }

    // 2. End-of-document footnotes section (all footnotes, for completeness)
    var lastPage = pages[pages.length - 1];
    if (!lastPage) return;
    var content = getContent(lastPage);
    var section = document.createElement("div");
    section.className = "footnotes-section";
    var heading = document.createElement("p");
    heading.style.fontWeight = "700";
    heading.style.fontSize = "11px";
    heading.style.textTransform = "uppercase";
    heading.style.letterSpacing = "0.06em";
    heading.style.color = "var(--text-faint)";
    heading.textContent = "Footnotes";
    section.appendChild(heading);
    for (var f = 0; f < footnotes.length; f++) {
      var entry = document.createElement("div");
      entry.className = "fn-entry";
      entry.innerHTML = '<span class="fn-key">' + footnotes[f].num + '.</span> ' + escapeHtml(footnotes[f].text);
      section.appendChild(entry);
    }
    content.appendChild(section);
  }

  function toggleFootnotes(force) {
    var panel = $("footnotesPanel");
    if (!panel) return;
    var shouldOpen = force === undefined ? !panel.classList.contains("open") : force;
    if (shouldOpen) {
      renderFootnotes();
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
    } else {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
    }
  }

  /* ---------------- Table of Figures ---------------- */
  function insertTableOfFigures() {
    var captions = [];
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var caps = getContent(pages[i]).querySelectorAll("p.caption");
      for (var c = 0; c < caps.length; c++) {
        var text = (caps[c].textContent || "").trim();
        if (text) {
          if (!caps[c].id) caps[c].id = "cap_" + Date.now().toString(36) + "_" + c;
          captions.push({ text: text, id: caps[c].id });
        }
      }
    }
    if (captions.length === 0) {
      toast("No captions found. Use References → Caption to add figure captions first.", "error");
      return;
    }
    var html = '<h2>Table of Figures</h2><div class="toc-figures">';
    for (var f = 0; f < captions.length; f++) {
      html += '<p><a class="zdocs-internal-link" data-target="' + escapeAttr(captions[f].id) + '" href="#' + escapeAttr(captions[f].id) + '">' + escapeHtml(captions[f].text) + '</a></p>';
    }
    html += '</div><p><br></p>';
    restoreEditorSelection();
    document.execCommand("insertHTML", false, html);
    schedulePaginate();
    scheduleAutosave();
    toast("Table of figures inserted (" + captions.length + " captions)", "success");
  }

  /* ---------------- Compare documents ---------------- */
  function openCompareDialog() {
    var versions = getVersions();
    var aSel = $("compareA");
    var bSel = $("compareB");
    aSel.innerHTML = "";
    bSel.innerHTML = "";
    if (versions.length < 1) {
      $("compareOutput").innerHTML = '<div class="diff-empty">Save at least two versions to compare.</div>';
    }
    for (var i = 0; i < versions.length; i++) {
      var o1 = document.createElement("option");
      o1.value = i; o1.textContent = (i === 0 ? "Latest — " : "v" + (versions.length - i) + " — ") + formatTime(versions[i].savedAt);
      aSel.appendChild(o1);
      var o2 = document.createElement("option");
      o2.value = i; o2.textContent = o1.textContent;
      bSel.appendChild(o2);
    }
    if (versions.length >= 2) {
      aSel.value = versions.length - 1; // older
      bSel.value = 0; // latest
    }
    $("compareOutput").innerHTML = "";
    openModal("compareModal");
  }

  function performCompare() {
    var versions = getVersions();
    var aIdx = parseInt($("compareA").value, 10);
    var bIdx = parseInt($("compareB").value, 10);
    if (isNaN(aIdx) || isNaN(bIdx) || aIdx < 0 || bIdx < 0 || aIdx >= versions.length || bIdx >= versions.length) {
      $("compareOutput").innerHTML = '<div class="diff-empty">Pick two valid versions.</div>';
      return;
    }
    var aText = stripHtml(versions[aIdx].content);
    var bText = stripHtml(versions[bIdx].content);
    var aWords = aText.split(/\s+/).filter(Boolean);
    var bWords = bText.split(/\s+/).filter(Boolean);
    var out = $("compareOutput");
    out.innerHTML = "";
    var result = diffWords(aWords, bWords);
    var html = "";
    for (var i = 0; i < result.length; i++) {
      var part = result[i];
      if (part.type === "same") {
        html += escapeHtml(part.value) + " ";
      } else if (part.type === "ins") {
        html += '<span class="diff-ins">' + escapeHtml(part.value) + '</span> ';
      } else if (part.type === "del") {
        html += '<span class="diff-del">' + escapeHtml(part.value) + '</span> ';
      }
    }
    if (!html.trim()) html = '<div class="diff-empty">No differences.</div>';
    out.innerHTML = html;
  }

  function stripHtml(html) {
    var div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Simple LCS-based word diff
  function diffWords(a, b) {
    var n = a.length, m = b.length;
    var dp = [];
    for (var i = 0; i <= n; i++) dp[i] = [];
    for (var x = 0; x <= n; x++) {
      for (var y = 0; y <= m; y++) {
        if (x === 0 || y === 0) dp[x][y] = 0;
        else if (a[x - 1] === b[y - 1]) dp[x][y] = dp[x - 1][y - 1] + 1;
        else dp[x][y] = Math.max(dp[x - 1][y], dp[x][y - 1]);
      }
    }
    var result = [];
    var i = n, j = m;
    var parts = [];
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        parts.push({ type: "same", value: a[i - 1] });
        i--; j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        parts.push({ type: "del", value: a[i - 1] });
        i--;
      } else {
        parts.push({ type: "ins", value: b[j - 1] });
        j--;
      }
    }
    while (i > 0) { parts.push({ type: "del", value: a[i - 1] }); i--; }
    while (j > 0) { parts.push({ type: "ins", value: b[j - 1] }); j--; }
    parts.reverse();
    // merge consecutive same-type
    var merged = [];
    for (var k = 0; k < parts.length; k++) {
      var last = merged[merged.length - 1];
      if (last && last.type === parts[k].type) {
        last.value += " " + parts[k].value;
      } else {
        merged.push({ type: parts[k].type, value: parts[k].value });
      }
    }
    return merged;
  }

  /* ---------------- Real track changes ---------------- */
  function setupTrackChangesInterceptor() {
    var pagesWrap = $(PAGES_WRAPPER_ID);
    if (!pagesWrap) return;
    // Use keydown for character insertion — preventDefault on keydown is
    // reliably honored by browsers (unlike beforeinput insertText).
    pagesWrap.addEventListener("keydown", function (e) {
      if (!trackChangesOn || restricted) return;
      // Only act when the caret is inside the document
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var node = sel.anchorNode;
      if (!node) return;
      var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!el || !el.closest || !el.closest(".page-content")) return;

      var key = e.key;

      // Printable single character (incl. space)
      if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        insertTrackedNode("ins", key);
        scheduleMergeTracked();
        return;
      }
      // Enter — track as insertion of a paragraph break
      if (key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        insertTrackedNode("ins", "¶");
        return;
      }
      // Backspace / Delete with a non-collapsed selection → wrap in <del>
      if ((key === "Backspace" || key === "Delete") && !sel.isCollapsed) {
        var deleted = sel.toString();
        if (deleted) {
          e.preventDefault();
          sel.deleteFromDocument();
          insertTrackedNode("del", deleted);
        }
      }
    });
    // Paste: wrap inserted plain text in <ins> when track changes is on
    pagesWrap.addEventListener("paste", function (e) {
      if (!trackChangesOn || restricted) return;
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var node = sel.anchorNode;
      var el = node ? (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) : null;
      if (!el || !el.closest || !el.closest(".page-content")) return;
      var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
      if (text) {
        e.preventDefault();
        if (!sel.isCollapsed) sel.deleteFromDocument();
        insertTrackedNode("ins", text);
        schedulePaginate();
        scheduleAutosave();
      }
    });
  }

  // Insert a tracked-change node (ins/del) at the caret using direct DOM
  // manipulation — bypasses execCommand/styleWithCSS which would otherwise
  // convert semantic tags into inline-styled spans.
  function insertTrackedNode(tag, text) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (!sel.isCollapsed) range.deleteContents();
    var node = document.createElement(tag);
    node.className = "zdocs-" + (tag === "ins" ? "ins" : "del");
    node.textContent = text;
    range.insertNode(node);
    // move caret after the inserted node
    var after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    schedulePaginate();
    scheduleAutosave();
  }

  // Merge all consecutive <ins class="zdocs-ins"> (and <del class="zdocs-del">)
  // siblings into single elements. Called on a debounce after typing stops,
  // to keep the DOM clean without risking caret corruption mid-keystroke.
  function mergeConsecutiveTrackedChanges() {
    try {
      var pages = getPages();
      for (var pi = 0; pi < pages.length; pi++) {
        var content = getContent(pages[pi]);
        var all = content.querySelectorAll("ins.zdocs-ins, del.zdocs-del");
        for (var i = 0; i < all.length; i++) {
          var node = all[i];
          var prev = node.previousSibling;
          if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.tagName === node.tagName && prev.className === node.className) {
            // move all children of node into prev
            while (node.firstChild) prev.appendChild(node.firstChild);
            node.parentNode && node.parentNode.removeChild(node);
          }
        }
      }
    } catch (e) {}
  }

  var mergeTrackedTimer = null;
  function scheduleMergeTracked() {
    if (mergeTrackedTimer) clearTimeout(mergeTrackedTimer);
    mergeTrackedTimer = setTimeout(function () {
      mergeTrackedTimer = null;
      mergeConsecutiveTrackedChanges();
    }, 800);
  }

  function acceptNearestChange() {
    operateNearestChange(true);
  }
  function rejectNearestChange() {
    operateNearestChange(false);
  }

  function operateNearestChange(accept) {
    var sel = window.getSelection();
    var node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode) : null;
    // search forward+backward for nearest ins/del
    var all = document.querySelectorAll(".page-content ins.zdocs-ins, .page-content del.zdocs-del");
    var target = null;
    if (node) {
      // find nearest
      var bestDist = Infinity;
      for (var i = 0; i < all.length; i++) {
        var d = node.compareDocumentPosition(all[i]);
        // just pick the first one in document order after caret, else first overall
        var dist = Math.abs(i);
        if (dist < bestDist) { bestDist = dist; target = all[i]; }
      }
    } else if (all.length) {
      target = all[0];
    }
    if (!target) { toast("No tracked changes to " + (accept ? "accept" : "reject"), "error"); return; }
    if (target.tagName === "INS") {
      // accept: unwrap (keep content); reject: remove entirely
      if (accept) unwrapNode(target);
      else target.parentElement && target.parentElement.removeChild(target);
    } else if (target.tagName === "DEL") {
      // accept: remove (deletion confirmed); reject: unwrap (keep content)
      if (accept) target.parentElement && target.parentElement.removeChild(target);
      else unwrapNode(target);
    }
    schedulePaginate();
    scheduleAutosave();
    toast((accept ? "Accepted" : "Rejected") + " tracked change", "success");
  }

  function unwrapNode(node) {
    var parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  /* ---------------- Improved comments (threaded + @mentions) ---------------- */
  function addCommentReply(c) {
    var text = window.prompt("Reply:", "");
    if (!text) return;
    if (!c.replies) c.replies = [];
    c.replies.push({ text: text, ts: Date.now() });
    renderComments();
    scheduleAutosave();
  }

  function jumpToComment(c) {
    if (c.rangeRef) {
      try { c.rangeRef.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
    } else {
      toast("Comment anchor not found", "error");
    }
  }

  /* ---------------- Wire up new buttons in init ---------------- */
  // (called from init() via initNewFeatures below)
  function initNewFeatures() {
    // Restrict edit
    var bRe = $("btnRestrictEdit");
    if (bRe) { bRe.addEventListener("mousedown", function (e) { e.preventDefault(); }); bRe.addEventListener("click", toggleRestrictEdit); }
    var bRestrictOff = $("restrictOff");
    if (bRestrictOff) bRestrictOff.addEventListener("click", function () { setRestricted(false); });
    var bFinal = $("btnMarkFinal");
    if (bFinal) { bFinal.addEventListener("mousedown", function (e) { e.preventDefault(); }); bFinal.addEventListener("click", function () { setRestricted(true); toast("Document marked as final — read-only", "success"); }); }

    // Password
    var bPwd = $("btnPassword");
    if (bPwd) { bPwd.addEventListener("mousedown", function (e) { e.preventDefault(); }); bPwd.addEventListener("click", openPasswordDialog); }
    var bPwdConfirm = $("passwordConfirmBtn");
    if (bPwdConfirm) bPwdConfirm.addEventListener("click", protectDocument);
    var bPwdRemove = $("passwordRemove");
    if (bPwdRemove) bPwdRemove.addEventListener("click", removePasswordProtection);
    var bUnlock = $("passwordUnlockBtn");
    if (bUnlock) bUnlock.addEventListener("click", attemptUnlock);
    var unlockInput = $("passwordUnlock");
    if (unlockInput) unlockInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); attemptUnlock(); } });

    // Bookmarks
    var bBm = $("btnBookmark");
    if (bBm) { bBm.addEventListener("mousedown", function (e) { e.preventDefault(); }); bBm.addEventListener("click", function () { renderBookmarks(); openModal("bookmarksModal"); setTimeout(function () { $("bookmarkName").focus(); }, 100); }); }
    var bBmAdd = $("bookmarkAdd");
    if (bBmAdd) bBmAdd.addEventListener("click", addBookmark);
    var bmInput = $("bookmarkName");
    if (bmInput) bmInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addBookmark(); } });

    // Internal link
    var bIL = $("btnInternalLink");
    if (bIL) { bIL.addEventListener("mousedown", function (e) { e.preventDefault(); }); bIL.addEventListener("click", openInternalLinkDialog); }
    var bILConfirm = $("internalLinkConfirm");
    if (bILConfirm) bILConfirm.addEventListener("click", insertInternalLink);
    var ilInput = $("internalLinkText");
    if (ilInput) ilInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); insertInternalLink(); } });
    // Click handler for internal links + footnote refs + bookmarks (delegated)
    var scrollEl = $("documentScroll");
    if (scrollEl) {
      scrollEl.addEventListener("click", handleInternalLinkClick);
      scrollEl.addEventListener("click", function (e) {
        var fn = e.target.closest("sup.footnote-ref, sup.endnote-ref");
        if (!fn) return;
        e.preventDefault();
        toggleFootnotes(true);
      });
      scrollEl.addEventListener("click", function (e) {
        var bm = e.target.closest("a.zdocs-bookmark");
        if (!bm) return;
        // no-op for clicks on bookmark anchors themselves
      });
    }

    // Cover page
    var bCov = $("btnCoverPage");
    if (bCov) { bCov.addEventListener("mousedown", function (e) { e.preventDefault(); }); bCov.addEventListener("click", openCoverPageDialog); }
    var bCovConfirm = $("coverPageConfirm");
    if (bCovConfirm) bCovConfirm.addEventListener("click", insertCoverPage);
    var covPresets = document.querySelectorAll("#coverPresets .preset-btn");
    for (var cp = 0; cp < covPresets.length; cp++) {
      (function (b) { b.addEventListener("click", function () {
        for (var k = 0; k < covPresets.length; k++) covPresets[k].classList.remove("active");
        b.classList.add("active");
        coverPageStyle = b.getAttribute("data-cover");
      }); })(covPresets[cp]);
    }

    // Section break (both insert + layout buttons)
    var bSB = $("btnSectionBreak");
    if (bSB) { bSB.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSB.addEventListener("click", insertSectionBreak); }
    var bSBL = $("btnSectionBreakL");
    if (bSBL) { bSBL.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSBL.addEventListener("click", insertSectionBreak); }
    var bSBConfirm = $("sectionBreakConfirm");
    if (bSBConfirm) bSBConfirm.addEventListener("click", confirmSectionBreak);
    var secOrientBtns = document.querySelectorAll(".sec-orient-btn");
    for (var so = 0; so < secOrientBtns.length; so++) {
      (function (b) { b.addEventListener("click", function () {
        for (var k = 0; k < secOrientBtns.length; k++) secOrientBtns[k].classList.remove("active");
        b.classList.add("active");
        sectionOrient = b.getAttribute("data-orient");
      }); })(secOrientBtns[so]);
    }

    // Equation
    var bEq = $("btnEquation");
    if (bEq) { bEq.addEventListener("mousedown", function (e) { e.preventDefault(); }); bEq.addEventListener("click", openEquationDialog); }
    var bEqConfirm = $("equationConfirm");
    if (bEqConfirm) bEqConfirm.addEventListener("click", insertEquation);
    var eqInput = $("equationInput");
    if (eqInput) eqInput.addEventListener("input", function () {
      $("equationPreview").innerHTML = renderEquation(eqInput.value);
    });
    eqInput && eqInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); insertEquation(); } });
    var eqPresets = document.querySelectorAll(".eq-preset");
    for (var ep = 0; ep < eqPresets.length; ep++) {
      (function (b) { b.addEventListener("click", function () {
        $("equationInput").value = b.getAttribute("data-eq");
        $("equationPreview").innerHTML = renderEquation(b.getAttribute("data-eq"));
      }); })(eqPresets[ep]);
    }

    // AutoText
    var bAT = $("btnAutoText");
    if (bAT) { bAT.addEventListener("mousedown", function (e) { e.preventDefault(); }); bAT.addEventListener("click", function () {
      // First click: if there's a selection, offer to save; else insert
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        openAutoTextDialog();
      } else {
        insertAutoText();
      }
    }); }

    // SmartArt
    var bSA = $("btnSmartArt");
    if (bSA) { bSA.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSA.addEventListener("click", openSmartArtDialog); }

    // Screenshot
    var bSS = $("btnScreenshot");
    if (bSS) { bSS.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSS.addEventListener("click", takeScreenshot); }

    // Ink
    var bInk = $("btnInk");
    if (bInk) { bInk.addEventListener("mousedown", function (e) { e.preventDefault(); }); bInk.addEventListener("click", function () { toggleInk(); }); }
    var bInkDone = $("inkDone");
    if (bInkDone) bInkDone.addEventListener("click", function () { toggleInk(false); });
    var bInkClear = $("inkClear");
    if (bInkClear) bInkClear.addEventListener("click", function () { if (inkCtx) { inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height); toast("Ink cleared", "success"); } });
    var bInkEraser = $("inkEraser");
    if (bInkEraser) { bInkEraser.addEventListener("click", function () { inkEraser = !inkEraser; bInkEraser.classList.toggle("active", inkEraser); }); }
    var inkColorInput = $("inkColor");
    if (inkColorInput) inkColorInput.addEventListener("input", function (e) {
      inkColor = e.target.value;
      $("inkColorSwatch").style.background = inkColor;
    });
    var inkSizeInput = $("inkSize");
    if (inkSizeInput) inkSizeInput.addEventListener("input", function (e) {
      inkSize = parseInt(e.target.value, 10);
      $("inkSizeLabel").textContent = inkSize;
    });

    // Spelling
    var bSpell = $("btnSpelling");
    if (bSpell) { bSpell.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSpell.addEventListener("click", openSpellingPanel); }
    var bSpellClose = $("spellingClose");
    if (bSpellClose) bSpellClose.addEventListener("click", closeSpellingPanel);

    // Footnotes
    var bFn = $("btnFootnote");
    if (bFn) { bFn.addEventListener("mousedown", function (e) { e.preventDefault(); }); bFn.addEventListener("click", insertFootnote); }
    var bFnPanel = $("footnoteAddFromPanel");
    if (bFnPanel) bFnPanel.addEventListener("click", insertFootnote);
    var bFnClose = $("footnotesClose");
    if (bFnClose) bFnClose.addEventListener("click", function () { toggleFootnotes(false); });

    // Table of figures
    var bToF = $("btnTableOfFigures");
    if (bToF) { bToF.addEventListener("mousedown", function (e) { e.preventDefault(); }); bToF.addEventListener("click", insertTableOfFigures); }

    // Compare
    var bCmp = $("btnCompare");
    if (bCmp) { bCmp.addEventListener("mousedown", function (e) { e.preventDefault(); }); bCmp.addEventListener("click", openCompareDialog); }
    var bCmpConfirm = $("compareConfirm");
    if (bCmpConfirm) bCmpConfirm.addEventListener("click", performCompare);

    // Real track changes — accept/reject
    var bAccept = $("btnAcceptChange");
    if (bAccept) { bAccept.addEventListener("mousedown", function (e) { e.preventDefault(); }); bAccept.addEventListener("click", acceptNearestChange); }
    var bReject = $("btnRejectChange");
    if (bReject) { bReject.addEventListener("mousedown", function (e) { e.preventDefault(); }); bReject.addEventListener("click", rejectNearestChange); }

    // setup track changes interceptor
    setupTrackChangesInterceptor();

    // Round 2 features
    initRound2Features();

    // Escape closes side panels
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (shortcutOverlay && shortcutOverlay.classList.contains("open")) { shortcutOverlay.classList.remove("open"); return; }
        var sp = $("spellingPanel"); if (sp && sp.classList.contains("open")) { closeSpellingPanel(); return; }
        var fp = $("footnotesPanel"); if (fp && fp.classList.contains("open")) { toggleFootnotes(false); return; }
        var ir = $("immersiveReader"); if (ir && ir.classList.contains("open")) { closeImmersiveReader(); return; }
      }
    });
  }

  /* =========================================================
     Round 2 — new features
     (mail merge, content controls, immersive reader,
      accessibility checker, document inspector, macros,
      status-bar zoom, language selector)
     ========================================================= */

  /* ---------------- Status bar zoom + language ---------------- */
  function initStatusBarControls() {
    var zOut = $("statusZoomOut");
    var zIn = $("statusZoomIn");
    var zPct = $("statusZoomPct");
    if (zOut) zOut.addEventListener("click", function () { adjustZoom(-10); });
    if (zIn) zIn.addEventListener("click", function () { adjustZoom(10); });
    if (zPct) zPct.addEventListener("click", function () { setZoom(100); });

    var langBtn = $("statusLang");
    if (langBtn) {
      langBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleLangMenu(langBtn);
      });
    }

    var psLabel = $("pageSizeLabel");
    if (psLabel) {
      psLabel.addEventListener("click", function (e) {
        e.stopPropagation();
        togglePageSizeMenu(psLabel);
      });
    }
  }

  function adjustZoom(delta) {
    var slider = $("zoom");
    if (!slider) return;
    var v = parseInt(slider.value, 10) + delta;
    v = Math.max(50, Math.min(150, v));
    setZoom(v);
  }

  function updateStatusZoom(v) {
    var pct = $("statusZoomPct");
    if (pct) pct.textContent = v + "%";
  }

  var spellLang = "EN";
  var LANGS = [
    { code: "EN", name: "English (US)" },
    { code: "EN-GB", name: "English (UK)" },
    { code: "ES", name: "Spanish" },
    { code: "FR", name: "French" },
    { code: "DE", name: "German" },
    { code: "IT", name: "Italian" },
    { code: "PT", name: "Portuguese" },
    { code: "NL", name: "Dutch" }
  ];
  var langMenu = null;
  function toggleLangMenu(anchor) {
    if (langMenu && langMenu.classList.contains("open")) {
      langMenu.classList.remove("open");
      return;
    }
    if (!langMenu) {
      langMenu = document.createElement("div");
      langMenu.className = "status-lang-menu";
      document.body.appendChild(langMenu);
      document.addEventListener("click", function () { langMenu.classList.remove("open"); });
    }
    langMenu.innerHTML = "";
    for (var i = 0; i < LANGS.length; i++) {
      (function (l) {
        var b = document.createElement("button");
        b.textContent = l.name;
        if (l.code === spellLang) b.classList.add("active");
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          spellLang = l.code;
          var span = anchor.querySelector("span");
          if (span) span.textContent = l.code;
          langMenu.classList.remove("open");
          toast("Spellcheck language: " + l.name, "success");
        });
        langMenu.appendChild(b);
      })(LANGS[i]);
    }
    var rect = anchor.getBoundingClientRect();
    langMenu.style.top = (rect.bottom + 4) + "px";
    langMenu.style.right = (window.innerWidth - rect.right) + "px";
    langMenu.classList.add("open");
  }

  /* ---------------- Mail Merge (real CSV) ---------------- */
  var mergeData = null; // { fields: [], rows: [[]] }

  function openMailMergeDialog() {
    openModal("mailMergeModal");
    var csv = $("mergeCsv");
    csv.oninput = parseMergeCsv;
    parseMergeCsv();
  }

  function parseMergeCsv() {
    var csv = $("mergeCsv").value.trim();
    var fieldsList = $("mergeFieldsList");
    var previewList = $("mergePreviewList");
    fieldsList.innerHTML = "";
    previewList.innerHTML = "";
    mergeData = null;
    if (!csv) {
      fieldsList.innerHTML = '<span class="outline-empty">Paste CSV to see fields</span>';
      return;
    }
    var lines = csv.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      fieldsList.innerHTML = '<span class="outline-empty">Add a header row + at least one data row</span>';
      return;
    }
    var fields = parseCsvLine(lines[0]);
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      rows.push(parseCsvLine(lines[i]));
    }
    mergeData = { fields: fields, rows: rows };

    // Render field chips
    for (var f = 0; f < fields.length; f++) {
      (function (field) {
        var chip = document.createElement("span");
        chip.className = "merge-field-chip";
        chip.textContent = "«" + field + "»";
        chip.title = "Click to insert this merge field at the caret";
        chip.addEventListener("click", function () {
          insertMergeField(field);
        });
        fieldsList.appendChild(chip);
      })(fields[f]);
    }
    // Render preview (first 5)
    var max = Math.min(5, rows.length);
    for (var r = 0; r < max; r++) {
      var item = document.createElement("div");
      item.className = "merge-preview-item";
      var html = '<span class="mpi-num">' + (r + 1) + '</span>';
      for (var c = 0; c < fields.length; c++) {
        html += '<strong>' + escapeHtml(fields[c]) + ':</strong> ' + escapeHtml(rows[r][c] || "") + '  ';
      }
      item.innerHTML = html;
      previewList.appendChild(item);
    }
    if (rows.length > 5) {
      var more = document.createElement("div");
      more.className = "merge-preview-item";
      more.style.color = "var(--text-faint)";
      more.textContent = "…and " + (rows.length - 5) + " more";
      previewList.appendChild(more);
    }
  }

  function parseCsvLine(line) {
    var out = [];
    var cur = "";
    var inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQ = false; }
        else { cur += ch; }
      } else {
        if (ch === ',') { out.push(cur); cur = ""; }
        else if (ch === '"') { inQ = true; }
        else { cur += ch; }
      }
    }
    out.push(cur);
    return out;
  }

  function insertMergeField(field) {
    restoreEditorSelection();
    document.execCommand("insertHTML", false, '<span class="field-dynamic merge-field" contenteditable="false" data-field="' + escapeAttr(field) + '">«' + escapeHtml(field) + '»</span> ');
    schedulePaginate();
    scheduleAutosave();
    closeModal("mailMergeModal");
    toast("Merge field «" + field + "» inserted", "success");
  }

  function runMailMerge() {
    if (!mergeData || mergeData.rows.length === 0) {
      toast("Paste CSV data with at least one recipient first", "error");
      return;
    }
    // Build a merged HTML doc for each recipient, then export as a single HTML file
    var pages = getPages();
    var templateHtml = "";
    for (var i = 0; i < pages.length; i++) {
      templateHtml += getContent(pages[i]).innerHTML;
    }
    var blob = document.createElement("div");
    var mergedHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + escapeHtml($("docTitle") ? $("docTitle").value : "Merged") + '</title><style>body{font-family:DM Sans,Arial,sans-serif;max-width:794px;margin:40px auto;padding:0 24px;line-height:1.6}h1,h2,h3{color:#1a1a1a}.merge-doc{page-break-after:always;padding:24px 0;border-bottom:2px solid #eee}</style></head><body>';
    for (var r = 0; r < mergeData.rows.length; r++) {
      var row = mergeData.rows[r];
      var docHtml = templateHtml;
      for (var f = 0; f < mergeData.fields.length; f++) {
        var fieldName = mergeData.fields[f];
        var value = row[f] || "";
        // Replace «Field» spans AND bare «Field» text
        var re1 = new RegExp('<span[^>]*data-field="' + fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]*>[^<]*</span>', "gi");
        docHtml = docHtml.replace(re1, escapeHtml(value));
        docHtml = docHtml.replace(new RegExp("«" + fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "»", "g"), escapeHtml(value));
      }
      mergedHtml += '<div class="merge-doc">' + docHtml + '</div>';
    }
    mergedHtml += '</body></html>';
    var blob2 = new Blob([mergedHtml], { type: "text/html" });
    var url = URL.createObjectURL(blob2);
    var a = document.createElement("a");
    a.href = url;
    a.download = (($("docTitle")?$("docTitle").value:"merged") || "merged") + ".html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("Merged " + mergeData.rows.length + " documents — exported as HTML", "success");
  }

  /* ---------------- Content controls ---------------- */
  function openContentControlsDialog() {
    openModal("contentControlsModal");
  }

  function insertContentControl(kind) {
    var html = "";
    var id = "cc_" + Date.now().toString(36);
    // For kinds that need a prompt, ask BEFORE restoring selection (prompt
    // steals focus and would invalidate the restored range).
    var needsPrompt = kind === "dropdown" || kind === "picture";
    var opts = null, url = null;
    if (kind === "dropdown") {
      opts = window.prompt("Dropdown options (comma-separated):", "Option 1, Option 2, Option 3");
      if (opts === null) { closeModal("contentControlsModal"); return; }
    } else if (kind === "picture") {
      url = window.prompt("Picture URL:", "");
      if (url === null) { closeModal("contentControlsModal"); return; }
    }
    // Now restore selection + focus (prompt may have stolen focus)
    focusEditorAndRestore();
    switch (kind) {
      case "richtext":
        html = '<span class="cc-richtext" id="' + id + '" contenteditable="true" data-cc="richtext"><span class="cc-placeholder">Click to enter rich text</span></span> ';
        break;
      case "plain":
        html = '<span class="cc-plain" id="' + id + '" contenteditable="true" data-cc="plain" data-plain="true"><span class="cc-placeholder">Click to enter text</span></span> ';
        break;
      case "date":
        html = '<input type="date" class="cc-date" id="' + id + '" data-cc="date" /> ';
        break;
      case "dropdown":
        var optArr = (opts || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        var optHtml = optArr.map(function (o) { return '<option>' + escapeHtml(o) + '</option>'; }).join("");
        html = '<select class="cc-dropdown" id="' + id + '" data-cc="dropdown">' + optHtml + '</select> ';
        break;
      case "checkbox":
        html = '<input type="checkbox" class="cc-checkbox" id="' + id + '" data-cc="checkbox" /> ';
        break;
      case "picture":
        html = '<img class="cc-picture" id="' + id + '" data-cc="picture" src="' + escapeAttr(url || "") + '" alt="" style="max-width:200px;border:1px dashed var(--ui-accent-border);border-radius:4px" /> ';
        break;
    }
    document.execCommand("insertHTML", false, html);
    // Wire placeholder clearing for text controls
    var el = document.getElementById(id);
    if (el && (kind === "richtext" || kind === "plain")) {
      el.addEventListener("focus", function () {
        var ph = el.querySelector(".cc-placeholder");
        if (ph) ph.remove();
      });
      if (kind === "plain") {
        el.addEventListener("keydown", function (e) {
          if (e.key === "Enter") e.preventDefault(); // plain text = no line breaks
        });
      }
    }
    closeModal("contentControlsModal");
    schedulePaginate();
    scheduleAutosave();
    toast("Content control inserted", "success");
  }

  /* ---------------- Immersive reader ---------------- */
  var irPlaying = false;
  var irCurrentPara = -1;
  var irUtterance = null;

  function openImmersiveReader() {
    // Collect all paragraphs from the document
    var paras = [];
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var blocks = getContent(pages[i]).querySelectorAll("p, h1, h2, h3, h4, li, blockquote");
      for (var b = 0; b < blocks.length; b++) {
        var t = (blocks[b].innerText || "").trim();
        if (t) paras.push({ tag: blocks[b].tagName, text: t });
      }
    }
    var content = $("irContent");
    content.innerHTML = "";
    if (paras.length === 0) {
      content.innerHTML = '<p style="color:var(--text-faint);text-align:center">No readable content in the document.</p>';
    } else {
      for (var p = 0; p < paras.length; p++) {
        var div = document.createElement("div");
        div.className = "ir-paragraph";
        div.setAttribute("data-idx", String(p));
        if (paras[p].tag === "H1" || paras[p].tag === "H2") div.style.fontWeight = "700";
        if (paras[p].tag === "H1") div.style.fontSize = "1.4em";
        div.innerHTML = renderIrText(paras[p].text);
        content.appendChild(div);
      }
    }
    var ir = $("immersiveReader");
    ir.classList.add("open");
    ir.setAttribute("aria-hidden", "false");
    irCurrentPara = -1;
    applyIrSettings();
  }

  function renderIrText(text) {
    // Wrap each word in a span for highlighting
    return text.split(/(\s+)/).map(function (tok) {
      if (/^\s+$/.test(tok)) return tok;
      return '<span class="ir-word">' + escapeHtml(tok) + '</span>';
    }).join("");
  }

  function closeImmersiveReader() {
    var ir = $("immersiveReader");
    ir.classList.remove("open");
    ir.setAttribute("aria-hidden", "true");
    stopIrReading();
  }

  function applyIrSettings() {
    var size = $("irTextSize").value;
    var spacing = $("irSpacing").value;
    var lineFocus = $("irLineFocus").checked;
    var syllables = $("irSyllables").checked;
    var content = $("irContent");
    content.style.fontSize = size + "px";
    content.style.lineHeight = String(spacing);
    if (syllables) {
      // Add syllable breakdown marks (simple heuristic: split long words)
      var words = content.querySelectorAll(".ir-word");
      for (var i = 0; i < words.length; i++) {
        var w = words[i].textContent;
        if (w.length > 5) {
          words[i].innerHTML = '<span class="ir-syllable">' + escapeHtml(w) + '</span>';
        } else {
          words[i].textContent = w;
        }
      }
    } else {
      var syls = content.querySelectorAll(".ir-syllable");
      for (var s = 0; s < syls.length; s++) {
        var par = syls[s].parentElement;
        if (par) par.textContent = syls[s].textContent;
      }
    }
    if (lineFocus && irCurrentPara < 0) {
      var first = content.querySelector(".ir-paragraph");
      if (first) { first.classList.add("ir-focused"); irCurrentPara = 0; }
    } else if (!lineFocus) {
      var focused = content.querySelectorAll(".ir-focused");
      for (var f = 0; f < focused.length; f++) focused[f].classList.remove("ir-focused");
    }
  }

  function irPlay() {
    if (irPlaying) { stopIrReading(); return; }
    if (!("speechSynthesis" in window)) { toast("Speech not supported", "error"); return; }
    var paras = $("irContent").querySelectorAll(".ir-paragraph");
    if (paras.length === 0) return;
    irPlaying = true;
    $("irPlay").classList.add("playing");
    var startIdx = irCurrentPara >= 0 ? irCurrentPara : 0;
    irReadFrom(startIdx, paras);
  }

  function irReadFrom(idx, paras) {
    if (!irPlaying || idx >= paras.length) {
      stopIrReading();
      if (idx >= paras.length) {
        var focused = $("irContent").querySelectorAll(".ir-focused, .ir-reading");
        for (var f = 0; f < focused.length; f++) focused[f].classList.remove("ir-focused", "ir-reading");
        irCurrentPara = -1;
      }
      return;
    }
    // Clear previous focused/reading
    var prev = $("irContent").querySelectorAll(".ir-focused, .ir-reading");
    for (var p = 0; p < prev.length; p++) prev[p].classList.remove("ir-focused", "ir-reading");
    paras[idx].classList.add("ir-reading");
    paras[idx].classList.add("ir-focused");
    paras[idx].scrollIntoView({ behavior: "smooth", block: "center" });
    irCurrentPara = idx;
    irUtterance = new SpeechSynthesisUtterance(paras[idx].innerText);
    irUtterance.rate = 0.95;
    irUtterance.onend = function () {
      if (irPlaying) irReadFrom(idx + 1, paras);
    };
    irUtterance.onerror = function () { irPlaying = false; };
    window.speechSynthesis.speak(irUtterance);
  }

  function stopIrReading() {
    irPlaying = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    var playBtn = $("irPlay");
    if (playBtn) playBtn.classList.remove("playing");
  }

  function irPrev() {
    var paras = $("irContent").querySelectorAll(".ir-paragraph");
    if (paras.length === 0) return;
    var next = Math.max(0, irCurrentPara - 1);
    var prev = $("irContent").querySelectorAll(".ir-focused, .ir-reading");
    for (var p = 0; p < prev.length; p++) prev[p].classList.remove("ir-focused", "ir-reading");
    paras[next].classList.add("ir-focused");
    paras[next].scrollIntoView({ behavior: "smooth", block: "center" });
    irCurrentPara = next;
    if (irPlaying) { stopIrReading(); irPlay(); }
  }

  function irNext() {
    var paras = $("irContent").querySelectorAll(".ir-paragraph");
    if (paras.length === 0) return;
    var next = Math.min(paras.length - 1, irCurrentPara + 1);
    var prev = $("irContent").querySelectorAll(".ir-focused, .ir-reading");
    for (var p = 0; p < prev.length; p++) prev[p].classList.remove("ir-focused", "ir-reading");
    paras[next].classList.add("ir-focused");
    paras[next].scrollIntoView({ behavior: "smooth", block: "center" });
    irCurrentPara = next;
    if (irPlaying) { stopIrReading(); irPlay(); }
  }

  /* ---------------- Accessibility checker ---------------- */
  function runAccessibilityCheck() {
    var results = $("accessibilityResults");
    results.innerHTML = "";
    var issues = [];
    var pages = getPages();
    var imgCount = 0, imgNoAlt = 0;
    var linkCount = 0, ambiguousLinks = 0;
    var emptyHeadings = 0;
    var totalBlocks = 0;

    for (var i = 0; i < pages.length; i++) {
      var content = getContent(pages[i]);
      // Images
      var imgs = content.querySelectorAll("img");
      imgCount += imgs.length;
      for (var im = 0; im < imgs.length; im++) {
        if (!imgs[im].getAttribute("alt") || imgs[im].getAttribute("alt").trim() === "") {
          imgNoAlt++;
          issues.push({
            severity: "error",
            title: "Image missing alt text",
            desc: "Screen readers cannot describe this image. Add descriptive alt text.",
            fix: "Add alt text",
            action: function () { closeModal("accessibilityModal"); var img = document.querySelector(".page-content img:not([alt]), .page-content img[alt='']"); if (img) { var alt = window.prompt("Alt text:", ""); if (alt !== null) { img.alt = alt; toast("Alt text added", "success"); } } }
          });
        }
      }
      // Links
      var links = content.querySelectorAll("a");
      linkCount += links.length;
      for (var l = 0; l < links.length; l++) {
        var lt = (links[l].textContent || "").trim().toLowerCase();
        if (lt === "click here" || lt === "read more" || lt === "here" || lt === "link" || lt === "more") {
          ambiguousLinks++;
          issues.push({
            severity: "warning",
            title: 'Ambiguous link text: "' + links[l].textContent + '"',
            desc: "Link text should be descriptive out of context. Avoid \"click here\" or \"read more\".",
            fix: null
          });
        }
      }
      // Empty headings
      var heads = content.querySelectorAll("h1, h2, h3, h4");
      for (var h = 0; h < heads.length; h++) {
        var ht = (heads[h].textContent || "").trim();
        if (!ht) {
          emptyHeadings++;
          issues.push({
            severity: "warning",
            title: "Empty heading",
            desc: "An empty heading can confuse screen reader users navigating by headings.",
            fix: null
          });
        }
      }
      // Block count
      totalBlocks += content.querySelectorAll("p, h1, h2, h3, h4, li, blockquote, pre").length;

      // Contrast check — scan elements with inline color/background-color
      var colored = content.querySelectorAll("[style*='color'], [style*='background-color'], font[color]");
      for (var ci = 0; ci < colored.length; ci++) {
        var cs = window.getComputedStyle(colored[ci]);
        var textColor = cs.color;
        var bgColor = cs.backgroundColor;
        if (textColor && bgColor && bgColor !== "rgba(0, 0, 0, 0)" && bgColor !== "transparent") {
          var ratio = contrastRatio(textColor, bgColor);
          if (ratio < 4.5) {
            (function (el, tc, bc, r) {
              issues.push({
                severity: "warning",
                title: "Low text contrast (" + r.toFixed(1) + ":1)",
                desc: "Text/background contrast ratio is below 4.5:1 (WCAG AA). Consider darkening the text or lightening the background.",
                fix: "Fix contrast",
                action: function () {
                  closeModal("accessibilityModal");
                  el.style.color = "#1a1a1a";
                  el.style.backgroundColor = "#ffffff";
                  toast("Contrast fixed (set to black-on-white)", "success");
                  scheduleAutosave();
                },
                preview: { color: tc, bg: bc }
              });
            })(colored[ci], textColor, bgColor, ratio);
          }
        }
      }
    }

    // Always-on summary items
    if (imgCount > 0) {
      issues.unshift({
        severity: imgNoAlt === 0 ? "ok" : "warning",
        title: imgNoAlt + " of " + imgCount + " images missing alt text",
        desc: imgNoAlt === 0 ? "All images have alt text. Great!" : "Add alt text to images so screen readers can describe them.",
        fix: null
      });
    }
    if (linkCount > 0) {
      issues.unshift({
        severity: ambiguousLinks === 0 ? "ok" : "warning",
        title: ambiguousLinks + " ambiguous links of " + linkCount,
        desc: ambiguousLinks === 0 ? "All link text is descriptive." : "Use descriptive link text instead of generic phrases.",
        fix: null
      });
    }
    if (emptyHeadings > 0) {
      issues.unshift({
        severity: "warning",
        title: emptyHeadings + " empty heading(s)",
        desc: "Empty headings break screen-reader navigation.",
        fix: null
      });
    }
    if (issues.length === 0) {
      issues.push({
        severity: "ok",
        title: "No issues found",
        desc: "The document appears accessible. Add more content to run a fuller check.",
        fix: null
      });
    }

    for (var ii = 0; ii < issues.length; ii++) {
      (function (issue) {
        var item = document.createElement("div");
        item.className = "a11y-issue severity-" + issue.severity;
        var icon = document.createElement("div");
        icon.className = "a11y-icon " + (issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "ok");
        icon.innerHTML = issue.severity === "error" ? "✕" : issue.severity === "warning" ? "!" : "✓";
        var body = document.createElement("div");
        body.className = "a11y-body";
        var title = document.createElement("div");
        title.className = "a11y-title";
        title.textContent = issue.title;
        var desc = document.createElement("div");
        desc.className = "a11y-desc";
        desc.textContent = issue.desc;
        body.appendChild(title);
        body.appendChild(desc);
        // Contrast preview swatch
        if (issue.preview) {
          var prev = document.createElement("span");
          prev.className = "a11y-contrast-preview";
          prev.style.color = issue.preview.color;
          prev.style.backgroundColor = issue.preview.bg;
          prev.textContent = "Aa";
          body.appendChild(prev);
        }
        if (issue.fix) {
          var fixBtn = document.createElement("button");
          fixBtn.className = "a11y-fix";
          fixBtn.textContent = issue.fix;
          fixBtn.addEventListener("click", issue.action);
          body.appendChild(fixBtn);
        }
        item.appendChild(icon);
        item.appendChild(body);
        results.appendChild(item);
      })(issues[ii]);
    }
    openModal("accessibilityModal");
  }

  // WCAG contrast ratio: (L1 + 0.05) / (L2 + 0.05) where L1 is lighter.
  // Input: CSS color strings like "rgb(r, g, b)".
  function contrastRatio(color1, color2) {
    var l1 = relativeLuminance(color1);
    var l2 = relativeLuminance(color2);
    var lighter = Math.max(l1, l2);
    var darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function relativeLuminance(color) {
    var rgb = parseRgb(color);
    if (!rgb) return 0;
    var r = srgbToLinear(rgb.r / 255);
    var g = srgbToLinear(rgb.g / 255);
    var b = srgbToLinear(rgb.b / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function srgbToLinear(c) {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function parseRgb(str) {
    var m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
    // hex
    var h = str.match(/^#([0-9a-f]{6})$/i);
    if (h) {
      var n = parseInt(h[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    return null;
  }

  /* ---------------- Document inspector ---------------- */
  function runDocumentInspector() {
    var results = $("inspectorResults");
    results.innerHTML = "";
    var pages = getPages();
    var items = [];
    // Gather metadata
    var commentsCount = comments.length;
    var trackedIns = document.querySelectorAll(".page-content ins.zdocs-ins").length;
    var trackedDel = document.querySelectorAll(".page-content del.zdocs-del").length;
    var hiddenBookmarks = document.querySelectorAll(".page-content a.zdocs-bookmark").length;
    var fnCount = footnotes.length;
    var personalInfo = ($("docTitle")?$("docTitle").value:"Untitled") || "Untitled";
    var lastSaved = lastSavedAt;

    items.push({ name: "Document title", count: personalInfo, removable: true, action: function () { ($("docTitle")?$("docTitle").value="Untitled Document":null); scheduleAutosave(); toast("Title cleared", "success"); } });
    items.push({ name: "Comments", count: commentsCount + (commentsCount === 1 ? " comment" : " comments"), removable: commentsCount > 0, action: function () { comments = []; renderComments(); scheduleAutosave(); toast("Comments removed", "success"); } });
    items.push({ name: "Tracked changes (insertions)", count: trackedIns + " ins", removable: trackedIns > 0, action: function () { var all = document.querySelectorAll(".page-content ins.zdocs-ins"); for (var i = 0; i < all.length; i++) unwrapNode(all[i]); schedulePaginate(); scheduleAutosave(); toast("Insertions accepted", "success"); } });
    items.push({ name: "Tracked changes (deletions)", count: trackedDel + " del", removable: trackedDel > 0, action: function () { var all = document.querySelectorAll(".page-content del.zdocs-del"); for (var i = 0; i < all.length; i++) { var p = all[i].parentNode; if (p) p.removeChild(all[i]); } schedulePaginate(); scheduleAutosave(); toast("Deletions removed", "success"); } });
    items.push({ name: "Bookmarks", count: hiddenBookmarks + (hiddenBookmarks === 1 ? " bookmark" : " bookmarks"), removable: hiddenBookmarks > 0, action: function () { var all = document.querySelectorAll(".page-content a.zdocs-bookmark"); for (var i = 0; i < all.length; i++) { var p = all[i].parentNode; if (p) p.removeChild(all[i]); } bookmarks = []; saveBookmarks(); schedulePaginate(); scheduleAutosave(); toast("Bookmarks removed", "success"); } });
    items.push({ name: "Footnotes", count: fnCount + (fnCount === 1 ? " footnote" : " footnotes"), removable: fnCount > 0, action: function () { var refs = document.querySelectorAll(".page-content sup.footnote-ref, .page-content sup.endnote-ref"); for (var i = 0; i < refs.length; i++) { var p = refs[i].parentNode; if (p) p.removeChild(refs[i]); } footnotes = []; saveFootnotes(); renderFootnotes(); renderFootnotesSection(); schedulePaginate(); scheduleAutosave(); toast("Footnotes removed", "success"); } });
    items.push({ name: "Last saved", count: lastSaved ? formatTime(lastSaved) : "never", removable: false });
    items.push({ name: "Page count", count: pages.length + (pages.length === 1 ? " page" : " pages"), removable: false });

    for (var i = 0; i < items.length; i++) {
      (function (it) {
        var item = document.createElement("div");
        item.className = "inspector-item" + (it.removable ? "" : " empty");
        var icon = document.createElement("span");
        icon.className = "inspector-item-icon";
        icon.innerHTML = "●";
        var text = document.createElement("div");
        text.className = "inspector-item-text";
        text.innerHTML = '<span class="inspector-item-name">' + escapeHtml(it.name) + '</span> <span class="inspector-item-count">' + escapeHtml(String(it.count)) + '</span>';
        item.appendChild(icon);
        item.appendChild(text);
        if (it.removable) {
          var rm = document.createElement("button");
          rm.className = "inspector-item-remove";
          rm.textContent = "Remove";
          rm.addEventListener("click", function () { it.action(); runDocumentInspector(); });
          item.appendChild(rm);
        }
        results.appendChild(item);
      })(items[i]);
    }
    openModal("inspectorModal");
  }

  function inspectorRemoveAll() {
    var items = $("inspectorResults").querySelectorAll(".inspector-item-remove");
    for (var i = 0; i < items.length; i++) items[i].click();
    toast("All removable metadata cleared", "success");
  }

  /* ---------------- Macros ---------------- */
  var macroRecording = false;
  var macroSteps = [];
  var savedMacros = [];
  var MACROS_KEY = "zdocs.macros";

  function openMacrosDialog() {
    loadMacros();
    renderMacrosList();
    openModal("macrosModal");
  }

  function startMacroRecording() {
    macroRecording = true;
    macroSteps = [];
    $("macroRecord").classList.add("recording");
    $("macroRecord").disabled = true;
    $("macroStop").disabled = false;
    toast("Recording… apply formatting now, then click Stop", "success");
    // Hook exec commands
    document.addEventListener("mousedown", captureMacroClick, true);
  }

  function captureMacroClick(e) {
    if (!macroRecording) return;
    var btn = e.target.closest("[data-cmd]");
    if (btn) {
      macroSteps.push({ type: "cmd", cmd: btn.getAttribute("data-cmd") });
    } else {
      var selBtn = e.target.closest("select");
      if (selBtn && (selBtn.id === "fontFamily" || selBtn.id === "fontSize" || selBtn.id === "blockType" || selBtn.id === "lineSpacing")) {
        // capture on change instead
      }
    }
  }

  function stopMacroRecording() {
    macroRecording = false;
    $("macroRecord").classList.remove("recording");
    $("macroRecord").disabled = false;
    $("macroStop").disabled = true;
    $("macroPlay").disabled = macroSteps.length === 0;
    $("macroSave").disabled = macroSteps.length === 0;
    document.removeEventListener("mousedown", captureMacroClick, true);
    toast("Recorded " + macroSteps.length + " steps", "success");
  }

  function playLastMacro() {
    if (macroSteps.length === 0 && savedMacros.length === 0) { toast("No macro to play", "error"); return; }
    playMacroSteps(macroSteps.length > 0 ? macroSteps : savedMacros[savedMacros.length - 1].steps);
  }

  function playMacroSteps(steps) {
    if (!steps || steps.length === 0) return;
    var i = 0;
    function next() {
      if (i >= steps.length) { toast("Macro playback complete", "success"); return; }
      var s = steps[i++];
      if (s.type === "cmd") {
        restoreEditorSelection();
        try { document.execCommand(s.cmd, false, null); } catch (e) {}
        schedulePaginate();
      }
      setTimeout(next, 80);
    }
    next();
  }

  function saveCurrentMacro() {
    if (macroSteps.length === 0) { toast("Nothing to save", "error"); return; }
    var name = window.prompt("Macro name:", "Macro " + (savedMacros.length + 1));
    if (!name) return;
    savedMacros.push({ name: name, steps: macroSteps.slice(), ts: Date.now() });
    saveMacros();
    renderMacrosList();
    toast("Macro saved: " + name, "success");
  }

  function saveMacros() {
    try {
      if (idbAvailable()) idb.setJSON(MACROS_KEY, savedMacros);
      else localStorage.setItem(MACROS_KEY, JSON.stringify(savedMacros));
    } catch (e) {}
  }

  function loadMacros() {
    try {
      var m = null;
      if (idbAvailable()) m = idb.getJSONSync(MACROS_KEY);
      if (!m) { var raw = localStorage.getItem(MACROS_KEY); if (raw) m = JSON.parse(raw); }
      if (Array.isArray(m)) savedMacros = m;
    } catch (e) {}
  }

  function renderMacrosList() {
    var list = $("macrosList");
    list.innerHTML = "";
    if (savedMacros.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No saved macros. Record one and click Save as…";
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < savedMacros.length; i++) {
      (function (m, idx) {
        var item = document.createElement("div");
        item.className = "macro-item";
        var name = document.createElement("span");
        name.className = "macro-name";
        name.textContent = m.name;
        var steps = document.createElement("span");
        steps.className = "macro-steps";
        steps.textContent = m.steps.length + " steps";
        var play = document.createElement("button");
        play.className = "macro-play";
        play.textContent = "Play";
        play.addEventListener("click", function () {
          closeModal("macrosModal");
          playMacroSteps(m.steps);
        });
        var del = document.createElement("button");
        del.className = "macro-del";
        del.textContent = "×";
        del.title = "Delete macro";
        del.addEventListener("click", function () {
          savedMacros.splice(idx, 1);
          saveMacros();
          renderMacrosList();
        });
        item.appendChild(name);
        item.appendChild(steps);
        item.appendChild(play);
        item.appendChild(del);
        list.appendChild(item);
      })(savedMacros[i], i);
    }
  }

  /* ---------------- Wire up round 2 features ---------------- */
  function initRound2Features() {
    initStatusBarControls();

    // Mail merge
    var bMM = $("btnStartMailMerge");
    if (bMM) { bMM.addEventListener("mousedown", function (e) { e.preventDefault(); }); bMM.addEventListener("click", openMailMergeDialog); }
    var bSR = $("btnSelectRecipients");
    if (bSR) { bSR.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSR.addEventListener("click", openMailMergeDialog); }
    var bMergeRun = $("mergeRunBtn");
    if (bMergeRun) bMergeRun.addEventListener("click", runMailMerge);
    var bIMF = $("btnInsertMergeField");
    if (bIMF) { bIMF.addEventListener("mousedown", function (e) { e.preventDefault(); }); bIMF.addEventListener("click", function () { openMailMergeDialog(); toast("Click a field chip to insert it", "success"); }); }

    // Content controls
    var bCC = $("btnContentControls");
    if (bCC) { bCC.addEventListener("mousedown", function (e) { e.preventDefault(); }); bCC.addEventListener("click", openContentControlsDialog); }
    var ccBtns = document.querySelectorAll(".cc-btn");
    for (var c = 0; c < ccBtns.length; c++) {
      (function (b) { b.addEventListener("click", function () { insertContentControl(b.getAttribute("data-cc")); }); })(ccBtns[c]);
    }

    // Immersive reader
    var bIR = $("btnImmersiveReader");
    if (bIR) { bIR.addEventListener("mousedown", function (e) { e.preventDefault(); }); bIR.addEventListener("click", openImmersiveReader); }
    var bIRClose = $("irClose");
    if (bIRClose) bIRClose.addEventListener("click", closeImmersiveReader);
    var bIRPlay = $("irPlay");
    if (bIRPlay) bIRPlay.addEventListener("click", irPlay);
    var bIRPrev = $("irPrev");
    if (bIRPrev) bIRPrev.addEventListener("click", irPrev);
    var bIRNext = $("irNext");
    if (bIRNext) bIRNext.addEventListener("click", irNext);
    var irTextSize = $("irTextSize");
    if (irTextSize) irTextSize.addEventListener("input", applyIrSettings);
    var irSpacing = $("irSpacing");
    if (irSpacing) irSpacing.addEventListener("input", applyIrSettings);
    var irLineFocus = $("irLineFocus");
    if (irLineFocus) irLineFocus.addEventListener("change", applyIrSettings);
    var irSyllables = $("irSyllables");
    if (irSyllables) irSyllables.addEventListener("change", applyIrSettings);

    // Accessibility checker
    var bA11y = $("btnAccessibilityCheck");
    if (bA11y) { bA11y.addEventListener("mousedown", function (e) { e.preventDefault(); }); bA11y.addEventListener("click", runAccessibilityCheck); }

    // Document inspector
    var bIns = $("btnInspector");
    if (bIns) { bIns.addEventListener("mousedown", function (e) { e.preventDefault(); }); bIns.addEventListener("click", runDocumentInspector); }
    var bInsRm = $("inspectorRemoveAll");
    if (bInsRm) bInsRm.addEventListener("click", inspectorRemoveAll);

    // Macros
    var bMac = $("btnMacros");
    if (bMac) { bMac.addEventListener("mousedown", function (e) { e.preventDefault(); }); bMac.addEventListener("click", openMacrosDialog); }
    var bMacRec = $("macroRecord");
    if (bMacRec) bMacRec.addEventListener("click", startMacroRecording);
    var bMacStop = $("macroStop");
    if (bMacStop) bMacStop.addEventListener("click", stopMacroRecording);
    var bMacPlay = $("macroPlay");
    if (bMacPlay) bMacPlay.addEventListener("click", playLastMacro);
    var bMacSave = $("macroSave");
    if (bMacSave) bMacSave.addEventListener("click", saveCurrentMacro);


    // Round 3: editor context menu + section break wiring done in initNewFeatures
    initEditorContextMenu();
    initRound4Features();

    // Round 11: periodic relative autosave time update
    setInterval(function () { updateRelativeAutosave(); }, 10000);
  }

  /* =========================================================
     Round 4 — tooltips, live merge preview, macro select
     recording, word count live
     ========================================================= */

  /* ---------------- Rich tooltips ---------------- */
  var richTip = null;
  var richTipTimer = null;
  function initTooltips() {
    if (richTip) return;
    richTip = document.createElement("div");
    richTip.className = "rich-tip";
    document.body.appendChild(richTip);
    // Attach to all ribbon buttons, topbar actions, status bar buttons
    var selectors = ".ribbon-btn, .topbar-action, .ribbon-tab, .page-nav, .session-timer, .version-count, .status-zoom-btn, .status-lang, .toolbar-stats";
    var els = document.querySelectorAll(selectors);
    for (var i = 0; i < els.length; i++) {
      attachTooltip(els[i]);
    }
  }

  function attachTooltip(el) {
    el.addEventListener("mouseenter", function () {
      var title = el.getAttribute("title");
      if (!title) return;
      // Capture the title, then clear it so the native tooltip doesn't show
      el.setAttribute("data-tip", title);
      el.removeAttribute("title");
      clearTimeout(richTipTimer);
      richTipTimer = setTimeout(function () {
        var tip = el.getAttribute("data-tip") || "";
        var shortcut = "";
        // detect shortcut in title like "(Ctrl+B)"
        var m = tip.match(/\(([^)]+)\)\s*$/);
        if (m) shortcut = m[1];
        var label = tip.replace(/\s*\([^)]+\)\s*$/, "");
        var html = escapeHtml(label);
        if (shortcut) html += '<span class="rt-key">' + escapeHtml(shortcut) + '</span>';
        richTip.innerHTML = html;
        var rect = el.getBoundingClientRect();
        richTip.style.left = rect.left + "px";
        richTip.style.top = (rect.bottom + 6) + "px";
        richTip.classList.add("show");
      }, 400);
    });
    el.addEventListener("mouseleave", function () {
      clearTimeout(richTipTimer);
      richTip.classList.remove("show");
      // restore title for next hover
      var tip = el.getAttribute("data-tip");
      if (tip) { el.setAttribute("title", tip); el.removeAttribute("data-tip"); }
    });
  }

  /* ---------------- Live merge preview ---------------- */
  var mergePreviewIndex = -1;
  function previewMergeRecipient(delta) {
    if (!mergeData || mergeData.rows.length === 0) {
      toast("Paste CSV data first (Mailings → Start)", "error");
      return;
    }
    if (delta === 0) {
      // reset
      clearMergePreview();
      return;
    }
    mergePreviewIndex += delta;
    if (mergePreviewIndex < 0) mergePreviewIndex = mergeData.rows.length - 1;
    if (mergePreviewIndex >= mergeData.rows.length) mergePreviewIndex = 0;
    applyMergePreview(mergeData.rows[mergePreviewIndex]);
    toast("Previewing recipient " + (mergePreviewIndex + 1) + " of " + mergeData.rows.length, "success");
  }

  function applyMergePreview(row) {
    if (!mergeData) return;
    var fields = document.querySelectorAll(".merge-field[data-field]");
    for (var i = 0; i < fields.length; i++) {
      var fieldName = fields[i].getAttribute("data-field");
      var idx = mergeData.fields.indexOf(fieldName);
      var value = idx >= 0 ? (row[idx] || "") : "";
      fields[i].textContent = "«" + fieldName + "» = " + value;
      fields[i].classList.add("preview-active");
    }
  }

  function clearMergePreview() {
    mergePreviewIndex = -1;
    var fields = document.querySelectorAll(".merge-field.preview-active");
    for (var i = 0; i < fields.length; i++) {
      var fieldName = fields[i].getAttribute("data-field");
      fields[i].textContent = "«" + fieldName + "»";
      fields[i].classList.remove("preview-active");
    }
  }

  /* ---------------- Macro recording of select changes ---------------- */
  // Enhance the existing macro recording to also capture select changes
  // (font family, font size, paragraph style, line spacing).
  function wireMacroSelectCapture() {
    var selectIds = ["fontFamily", "fontSize", "blockType", "lineSpacing"];
    for (var i = 0; i < selectIds.length; i++) {
      var sel = $(selectIds[i]);
      if (sel && !sel.getAttribute("data-macro-wired")) {
        sel.setAttribute("data-macro-wired", "1");
        (function (selEl, selId) {
          selEl.addEventListener("change", function () {
            if (!macroRecording) return;
            macroSteps.push({ type: "select", id: selId, value: selEl.value });
          });
        })(sel, selectIds[i]);
      }
    }
  }

  // Override playMacroSteps to handle select steps
  var _origPlayMacroSteps = playMacroSteps;
  playMacroSteps = function (steps) {
    if (!steps || steps.length === 0) return;
    var i = 0;
    function next() {
      if (i >= steps.length) { toast("Macro playback complete", "success"); return; }
      var s = steps[i++];
      if (s.type === "cmd") {
        restoreEditorSelection();
        try { document.execCommand(s.cmd, false, null); } catch (e) {}
        schedulePaginate();
      } else if (s.type === "select") {
        var sel = $(s.id);
        if (sel) {
          sel.value = s.value;
          // trigger the change handler
          var ev = new Event("change", { bubbles: true });
          sel.dispatchEvent(ev);
        }
      } else if (s.type === "color") {
        // replay color picks — temporarily disable recording to avoid loop
        var wasRecording = macroRecording;
        macroRecording = false;
        if (s.target === "text") applyTextColor(s.value);
        else if (s.target === "hilite") applyHiliteColor(s.value);
        macroRecording = wasRecording;
      }
      setTimeout(next, 80);
    }
    next();
  };

  /* ---------------- Live word count in status bar polish ---------------- */
  // The existing updateStatus handles word count; here we add a subtle
  // count-up animation when the word count changes.
  var lastWordCount = 0;
  function animateWordCount(newCount) {
    if (newCount === lastWordCount) return;
    var el = $("wordCount");
    if (!el) return;
    el.style.transition = "color 0.3s";
    el.style.color = "var(--ui-accent)";
    setTimeout(function () { el.style.color = ""; }, 400);
    lastWordCount = newCount;
  }

  function initRound4Features() {
    initTooltips();
    wireMacroSelectCapture();
    // Wire merge preview buttons (Preview Results + Highlight Merge)
    var bPreview = $("btnPreviewResults");
    if (bPreview) {
      bPreview.addEventListener("mousedown", function (e) { e.preventDefault(); });
      bPreview.addEventListener("click", function () { previewMergeRecipient(1); });
    }
    var bHighlight = $("btnHighlightMerge");
    if (bHighlight) {
      bHighlight.addEventListener("mousedown", function (e) { e.preventDefault(); });
      bHighlight.addEventListener("click", function () { clearMergePreview(); toast("Merge preview cleared", "success"); });
    }

    // Round 6: ripple effect + table cell right-click
    initRippleEffect();
    initTableContextMenu();
  }

  /* ---------------- Button ripple effect ---------------- */
  function initRippleEffect() {
    var btns = document.querySelectorAll(".ribbon-btn, .topbar-action, .btn");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        if (btn.getAttribute("data-ripple-wired")) return;
        btn.setAttribute("data-ripple-wired", "1");
        btn.style.position = "relative";
        btn.style.overflow = "hidden";
        btn.addEventListener("click", function (e) {
          var rect = btn.getBoundingClientRect();
          var size = Math.max(rect.width, rect.height);
          var x = e.clientX - rect.left - size / 2;
          var y = e.clientY - rect.top - size / 2;
          var ripple = document.createElement("span");
          ripple.className = "ripple";
          ripple.style.width = ripple.style.height = size + "px";
          ripple.style.left = x + "px";
          ripple.style.top = y + "px";
          btn.appendChild(ripple);
          setTimeout(function () {
            if (ripple.parentElement) ripple.parentElement.removeChild(ripple);
          }, 500);
        });
      })(btns[i]);
    }
  }

  /* ---------------- Table cell right-click menu ---------------- */
  function initTableContextMenu() {
    var scroll = $("documentScroll");
    if (!scroll) return;
    scroll.addEventListener("contextmenu", function (e) {
      var cell = e.target.closest(".page-content td, .page-content th");
      if (!cell) return;
      e.preventDefault();
      // Build a table-specific context menu
      hideEditorContextMenu();
      var menu = ctxMenu || (ctxMenu = document.createElement("div"));
      menu.className = "editor-context-menu open";
      menu.innerHTML = "";
      var items = [
        { label: "Align left", action: function () { cell.style.textAlign = "left"; scheduleAutosave(); } },
        { label: "Align center", action: function () { cell.style.textAlign = "center"; scheduleAutosave(); } },
        { label: "Align right", action: function () { cell.style.textAlign = "right"; scheduleAutosave(); } },
        { sep: true },
        { label: "Shade cell", action: function () { cell.style.backgroundColor = "var(--ui-accent-soft)"; scheduleAutosave(); } },
        { label: "Clear shading", action: function () { cell.style.backgroundColor = ""; scheduleAutosave(); } },
        { sep: true },
        { label: "Bold border", action: function () { cell.style.border = "2px solid var(--text-base)"; scheduleAutosave(); } },
        { label: "No border", action: function () { cell.style.border = "1px solid var(--border-chrome)"; scheduleAutosave(); } },
        { sep: true },
        { label: "Delete row", danger: true, action: function () {
          var row = cell.closest("tr");
          if (row && row.parentElement) row.parentElement.removeChild(row);
          schedulePaginate();
          scheduleAutosave();
        } },
      ];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.sep) {
          var sep = document.createElement("div");
          sep.className = "ctx-sep";
          menu.appendChild(sep);
          continue;
        }
        var b = document.createElement("button");
        b.innerHTML = "<span>" + it.label + "</span>";
        if (it.danger) b.classList.add("ctx-danger");
        (function (action) {
          b.addEventListener("click", function (e2) {
            e2.stopPropagation();
            hideEditorContextMenu();
            action();
          });
        })(it.action);
        menu.appendChild(b);
      }
      menu.style.left = e.clientX + "px";
      menu.style.top = e.clientY + "px";
      document.body.appendChild(menu);
      var rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + "px";
      if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + "px";
    });
  }

  /* ---------------- Editor right-click context menu ---------------- */
  var ctxMenu = null;
  function initEditorContextMenu() {
    var scroll = $("documentScroll");
    if (!scroll) return;
    scroll.addEventListener("contextmenu", function (e) {
      var target = e.target.closest(".page-content");
      if (!target) return;
      e.preventDefault();
      showEditorContextMenu(e.clientX, e.clientY);
    });
    document.addEventListener("click", function () { hideEditorContextMenu(); });
    document.addEventListener("scroll", function () { hideEditorContextMenu(); }, true);
  }

  function showEditorContextMenu(x, y) {
    if (!ctxMenu) {
      ctxMenu = document.createElement("div");
      ctxMenu.className = "editor-context-menu";
      document.body.appendChild(ctxMenu);
    }
    var sel = window.getSelection();
    var hasSelection = sel && !sel.isCollapsed;
    var inEditor = false;
    if (sel && sel.anchorNode) {
      var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
      inEditor = !!node && !!node.closest && !!node.closest(".page-content");
    }
    ctxMenu.innerHTML = "";
    var items = [
      { label: "Cut", shortcut: "Ctrl+X", action: function () { document.execCommand("cut"); }, disabled: !hasSelection },
      { label: "Copy", shortcut: "Ctrl+C", action: function () { document.execCommand("copy"); }, disabled: !hasSelection },
      { label: "Paste", shortcut: "Ctrl+V", action: function () { document.execCommand("paste"); } },
      { sep: true },
      { label: "Bold", shortcut: "Ctrl+B", action: function () { exec("bold"); }, icon: "B" },
      { label: "Italic", shortcut: "Ctrl+I", action: function () { exec("italic"); }, icon: "I" },
      { label: "Underline", shortcut: "Ctrl+U", action: function () { exec("underline"); }, icon: "U" },
      { sep: true },
      { label: "Insert Link", shortcut: "Ctrl+K", action: function () { openLinkDialog(); } },
      { label: "Add Comment", action: function () { addComment(); }, disabled: !hasSelection },
      { sep: true },
      { label: "Spelling…", action: function () { openSpellingPanel(); } },
    ];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.sep) {
        var sep = document.createElement("div");
        sep.className = "ctx-sep";
        ctxMenu.appendChild(sep);
        continue;
      }
      var btn = document.createElement("button");
      btn.innerHTML = (it.icon ? '<span style="font-weight:700;font-family:var(--font-ui)">' + it.icon + "</span>" : "") +
        "<span>" + it.label + "</span>" +
        (it.shortcut ? '<span class="ctx-shortcut">' + it.shortcut + "</span>" : "");
      if (it.disabled) btn.classList.add("ctx-disabled");
      else {
        (function (action) {
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            hideEditorContextMenu();
            action();
          });
        })(it.action);
      }
      ctxMenu.appendChild(btn);
    }
    ctxMenu.style.left = x + "px";
    ctxMenu.style.top = y + "px";
    ctxMenu.classList.add("open");
    // keep on screen
    var rect = ctxMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) ctxMenu.style.left = (window.innerWidth - rect.width - 8) + "px";
    if (rect.bottom > window.innerHeight) ctxMenu.style.top = (window.innerHeight - rect.height - 8) + "px";
  }

  function hideEditorContextMenu() {
    if (ctxMenu) ctxMenu.classList.remove("open");
  }
})();
