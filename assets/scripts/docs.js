/* BUILD 2026-08-26.12 (References: Footnote/Endnote/Citation custom modals; proper endnote system â€” numbered refs, end-of-doc section, panel management; Styles group (Title/H1-H3/Normal via formatBlock); Caption/Cross-ref/Table-of-Figures removed) */
/* =========================================================
   Z Docs â€” Word Processor  (v2)
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
   - Insert Link (Ctrl+K; Ctrl+click opens in new tab), Image (OS file
     picker, Slides-style), Table (grid), HR. Page-break markers are
     click-to-remove.
   - Undo/Redo, Dark theme toggle, Export (.txt/.html/print),
     Word-count stats dialog, Ruler.
   ========================================================= */
(function () {
  "use strict";

  /* ---------------- Constants ---------------- */
  var PAGES_WRAPPER_ID = "pagesWrapper";
  var CARET_BLOCK_ATTR = "data-caret-block";
  var CARET_OFFSET_ATTR = "data-caret-offset";
  // Legacy single-document key (pre-multi-document builds). Kept only to
  // migrate an existing document into the new model on first run.
  var STORAGE_KEY = "zdocs.document.v3";
  // Multi-document storage: one index of metadata + one key per document,
  // mirroring the Slides app (emeraldslides_index / emeraldslides_pres_<id>).
  var DOC_INDEX_KEY = "emeralddocs_index";
  function docDataKey(id) { return "emeralddocs_doc_" + id; }
  // THEME_KEY removed â€” dark mode is no longer supported.
  var LEGACY_VERSIONS_KEY = "zdocs.versions";
  function versionsKey(id) { return "zdocs.versions." + id; }
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
  // Zoom limits match Slides: 20% â€“ 400% (Slides uses clamp(scale, 0.2, 4)).
  var MIN_ZOOM = 20;
  var MAX_ZOOM = 400;

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
  // Multi-document state (Slides pattern)
  var documents = [];        // metadata index [{id, title, updatedAt, wordCount}]
  var currentDocId = null;   // id of the document loaded in the editor (null â†’ welcome screen)
  var currentTitle = "Untitled Document";
  var _welcomeRenderToken = 0;
  var _deleteTargetId = null;
  var _legacyMigratedId = null; // id of the document created from the legacy single-document key

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

    page.appendChild(content);

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
     overflow unchanged â€” producing cascades of empty pages.
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
            // Single overflowing block â†’ SPLIT it (don't push whole)
            if (splitOverflowingBlock(content, pages[i])) {
              changed = true;
              continue;
            }
            break; // cannot split further (e.g. one giant word)
          }
          // Multiple blocks â†’ push the last block down
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
    syncHeaderFooter(); // re-apply header/footer strips to new pages
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
        // Break is already the last block on this page â€” nothing to move.
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
    // NOTE: do NOT auto-add an empty <p> to a childless page here â€” that
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
            return false; // single token too big â€” give up
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

    // Never pull a page-break marker up â€” it must stay as a boundary.
    if (first.classList && first.classList.contains("zdocs-page-break")) return false;

    // If the current page already ends with a page-break marker,
    // content after it belongs on the next page â€” don't pull across.
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
    // must NOT cause its page to be deleted â€” otherwise pressing Enter on
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
    var wc = $("wordCount");
    if (wc) wc.textContent = stats.words + " " + (stats.words === 1 ? "word" : "words");
    $("charCount").textContent = stats.chars + " " + (stats.chars === 1 ? "character" : "characters");

    var cur = getCurrentPageIndex() + 1;
    if (cur < 1) cur = 1;
    $("pageInfo").textContent = "Page " + cur + " of " + stats.pages;

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
    if (!sel || !sel.rangeCount) {
      // No selection â€” reset to "Ln 1, Col 1" (e.g. when the editor loses focus
      // or the page is empty and nothing is selected).
      el.textContent = "Ln 1, Col 1";
      return;
    }
    var node = sel.anchorNode;
    if (!node) {
      el.textContent = "Ln 1, Col 1";
      return;
    }
    // Check if we're in the editor
    var inEditor = false;
    var checkNode = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (checkNode) {
      if (checkNode.classList && checkNode.classList.contains("page-content")) { inEditor = true; break; }
      checkNode = checkNode.parentElement;
    }
    if (!inEditor) {
      el.textContent = "Ln 1, Col 1";
      return;
    }

    // Find the block element containing the caret â€” i.e. the direct child of
    // .page-content (typically a <p>, <h1>, <ul>, <blockquote>, etc.).
    // We walk UP from the anchor node until the parent has .page-content.
    var block = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (block && block.parentElement && !block.parentElement.classList.contains("page-content")) {
      block = block.parentElement;
    }
    // Guard: if block walked PAST .page-content (happens when the selection is
    // directly on the .page-content element itself â€” e.g. an empty page with no
    // <p> child yet), the walk escapes to <body> and `selectNodeContents(block)`
    // would grab the entire document, producing a bogus column like "Col 15733".
    // In that case, default to line 1, col 1.
    if (!block || !block.parentElement || !block.parentElement.classList.contains("page-content")) {
      el.textContent = "Ln 1, Col 1";
      return;
    }

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
    // If we somehow didn't find the block in any page (shouldn't happen, but be safe):
    if (!found) {
      el.textContent = "Ln 1, Col 1";
      return;
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
    } catch (e) {
      col = 1;
    }

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

    // Ctrl+Enter â†’ page break
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

    // Ctrl++ / Ctrl+= â†’ zoom in
    if (k === "+" || k === "=") { e.preventDefault(); adjustZoom(10); return; }
    // Ctrl+- â†’ zoom out
    if (k === "-") { e.preventDefault(); adjustZoom(-10); return; }
    // Ctrl+0 â†’ reset zoom
    if (k === "0") { e.preventDefault(); setZoom(100); return; }
    if (k === "z" && !e.shiftKey) { e.preventDefault(); exec("undo"); return; }
    if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); exec("redo"); return; }
  }

  /* Cycle through margin presets in order: default â†’ narrow â†’ moderate â†’ wide â†’ default */
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
    // Insert a page-break marker element followed by an empty paragraph.
    // The marker is clickable afterwards to remove (cancel) the break.
    var html = '<div class="zdocs-page-break" contenteditable="false" title="Click to remove this page break"><span class="pb-label">â€” Page Break â€”</span></div><p><br></p>';
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
      empty.textContent = "Add headings (Title, Heading 1â€“3) to see them here.";
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
            '<button class="modal-close" id="shortcutOverlayClose" aria-label="Close">Ã—</button>' +
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
    var modKey = navigator.platform.indexOf("Mac") >= 0 ? "âŒ˜" : "Ctrl";
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
    var href = normalizeExternalUrl(a.getAttribute("href") || "");
    var text = a.textContent || "";
    linkPreviewEl.innerHTML =
      '<div class="lp-url">' + escapeHtml(href) + "</div>" +
      '<div class="lp-hint">' + (text ? "â€œ" + escapeHtml(text) + "â€ Â· " : "") + "Ctrl+click to open</div>";
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
    if (!currentDocId) return; // nothing open (welcome screen)
    // Show "Savingâ€¦" immediately (matching slides pattern)
    setAutosaveState("saving");
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      autosaveTimer = null;
      saveDocument(false);
    }, 800);
  }

  // Periodic version snapshots â€” every 5 minutes, push a version snapshot
  // so the user can roll back to an earlier point in their writing session.
  function startAutosaveSnapshots() {
    if (autosaveSnapshotTimer) return; // already running
    autosaveSnapshotTimer = setInterval(function () {
      try {
        var data = serialize();
        pushVersion(data);
        // (Version count badge removed from status bar â€” no UI to update.)
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
  // Used after modal/prompt dialogs steal focus â€” execCommand('insertHTML')
  // only works when the editor is focused and has a selection inside it.
  function focusEditorAndRestore() {
    var firstContent = getContent(getPages()[0]);
    if (firstContent) {
      try { firstContent.focus(); } catch (e) {}
    }
    restoreEditorSelection();
  }

  function exec(cmd, value) {
    // Indent/Outdent: plain margin-left indentation â€” NOT execCommand's
    // blockquote wrapper (which rendered as a blue quote block).
    if (cmd === "indent" || cmd === "outdent") {
      applyIndent(cmd === "indent" ? 1 : -1);
      return;
    }
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

  function applyIndent(direction) {
    restoreEditorSelection();
    var block = getCurrentBlock();
    if (!block) return;
    var cur = parseFloat(block.style.marginLeft) || 0;
    var next = direction > 0 ? cur + 40 : Math.max(0, cur - 40);
    if (next === cur) return;
    block.style.marginLeft = next + "px";
    schedulePaginate();
    scheduleAutosave();
  }
  function applyFontFamily(value) { exec("fontName", value); }

  /* Exact pixel font sizes (Slides parity): execCommand only supports a
     coarse 1â€“7 scale, so we wrap the selection with <font size="7"> and then
     convert that wrapper into a <span style="font-size:Npx"> carrying the
     exact size picked in the dropdown. */
  function applyFontSize(value) {
    var v = parseFloat(value);
    if (isNaN(v) || v <= 0) return;
    // Legacy 1â€“7 values (old macros / format painter) still pass straight through
    if (v >= 1 && v <= 7) { exec("fontSize", String(Math.round(v))); return; }

    // Remember pre-existing size="7" wrappers so only the new one is converted
    var before = document.querySelectorAll('.page-content font[size="7"]');
    var skip = [];
    for (var b = 0; b < before.length; b++) skip.push(before[b]);

    try { document.execCommand("styleWithCSS", false, false); } catch (e) {}
    exec("fontSize", "7");

    var fonts = document.querySelectorAll('.page-content font[size="7"]');
    var converted = 0;
    for (var i = 0; i < fonts.length; i++) {
      var f = fonts[i];
      if (skip.indexOf(f) !== -1) continue;
      var span = document.createElement("span");
      span.style.fontSize = v + "px";
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
      converted++;
    }
    if (converted) {
      schedulePaginate();
      scheduleAutosave();
      setTimeout(updateToolbarStates, 10);
    }
  }

  function applyTextColor(color) {
    var bar = $("textColorBar");
    if (bar) bar.style.background = color;
    var input = $("textColor");
    if (input) input.value = color;
    exec("foreColor", color);
  }

  function applyHiliteColor(color) {
    var bar = $("hiliteColorBar");
    if (bar) bar.style.background = color;
    var input = $("hiliteColor");
    if (input) input.value = color;
    try { document.execCommand("styleWithCSS", false, true); } catch (e) {}
    exec("hiliteColor", color);
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
    updateDropCapState();
    // Block-type dropdown removed â€” nothing else to sync.
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
      id: currentDocId,
      title: currentTitle,
      content: combined.innerHTML,
      savedAt: Date.now(),
      theme: theme,
      header: headerActive && hfHasContent(headerHTML) ? headerHTML : "",
      footer: footerActive && hfHasContent(footerHTML) ? footerHTML : "",
      footnotes: footnotes,
      endnotes: endnotes,
    };
  }

  /* ---------------- Multi-document index (Slides pattern) ---------------- */
  async function loadIndex() {
    try {
      var idx = null;
      if (window.EmeraldIDBStorage) {
        idx = await window.EmeraldIDBStorage.getJSON(DOC_INDEX_KEY);
        if (!idx) idx = await window.EmeraldIDBStorage.migrateLocalJSON(DOC_INDEX_KEY);
      }
      if (!idx) {
        var raw = localStorage.getItem(DOC_INDEX_KEY);
        if (raw) idx = JSON.parse(raw);
      }
      documents = Array.isArray(idx) ? idx : [];
      // De-duplicate by id, newest first (same defensive cleanup as Slides)
      var seen = {};
      var cleaned = [];
      for (var i = 0; i < documents.length; i++) {
        var m = documents[i];
        if (!m || !m.id || seen[m.id]) continue;
        seen[m.id] = true;
        cleaned.push(m);
      }
      cleaned.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      documents = cleaned;
    } catch (e) {
      documents = [];
    }
  }

  async function saveIndex() {
    try {
      // EmeraldIDBStorage.setJSON removes the localStorage copy of the key
      // (IDB is primary), so mirror to localStorage only afterwards â€”
      // same pattern as slides.js saveIndex().
      if (window.EmeraldIDBStorage) await window.EmeraldIDBStorage.setJSON(DOC_INDEX_KEY, documents);
      localStorage.setItem(DOC_INDEX_KEY, JSON.stringify(documents));
    } catch (e) {}
  }

  async function loadDocData(id) {
    try {
      var data = null;
      if (window.EmeraldIDBStorage) {
        data = await window.EmeraldIDBStorage.getJSON(docDataKey(id));
        if (!data) data = await window.EmeraldIDBStorage.migrateLocalJSON(docDataKey(id));
      }
      if (!data) {
        var raw = localStorage.getItem(docDataKey(id));
        if (raw) data = JSON.parse(raw);
      }
      return data;
    } catch (e) { return null; }
  }

  async function writeDocData(data) {
    try {
      // IDB first, localStorage mirror second (setJSON removes the LS copy)
      if (window.EmeraldIDBStorage) await window.EmeraldIDBStorage.setJSON(docDataKey(data.id), data);
      localStorage.setItem(docDataKey(data.id), JSON.stringify(data));
    } catch (e) {}
  }

  async function deleteDocData(id) {
    try {
      localStorage.removeItem(docDataKey(id));
      if (window.EmeraldIDBStorage) await window.EmeraldIDBStorage.delete(docDataKey(id));
    } catch (e) {}
  }

  // Strip tags â†’ plain text (for card snippets). Block elements become line
  // breaks so headings/paragraphs don't run together. Never throws.
  function htmlToText(html) {
    if (!html) return "";
    var d = document.createElement("div");
    d.innerHTML = String(html).replace(/<\/(p|h[1-6]|li|blockquote|pre|div|tr|figcaption)>/gi, "\n");
    return (d.textContent || "")
      .split("\n")
      .map(function (s) { return s.replace(/\s+/g, " ").trim(); })
      .filter(Boolean)
      .join("\n");
  }

  // Random hex id, identical scheme to Slides'/Notes' generateSecureId()
  function generateSecureId(length) {
    var arr = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("").slice(0, length);
  }

  // Same id format as Slides (pres_<ms>_<hex9>) and Notes (note_<ms>_<hex9>):
  // doc_<decimal timestamp>_<9 hex chars>  â†’  ?owned=doc_1734567890123_a1b2c3d4e
  function makeDocId() {
    return "doc_" + Date.now() + "_" + generateSecureId(9);
  }

  // Sequential "Untitled Document" titles so multiple fresh documents don't
  // show up as identical cards on the welcome screen (same as Slides).
  function nextUntitledTitle() {
    var base = "Untitled Document";
    var maxN = 0;
    for (var i = 0; i < documents.length; i++) {
      var t = documents[i] && documents[i].title;
      if (!t) continue;
      if (t === base) { maxN = Math.max(maxN, 1); continue; }
      var m = /^Untitled Document\s+(\d+)$/.exec(t);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return maxN === 0 ? base : base + " " + (maxN + 1);
  }

  function updateOwnedUrl() {
    try {
      if (currentDocId) {
        var url = new URL(location.href);
        url.searchParams.set("owned", currentDocId);
        history.replaceState({}, document.title, url);
      } else if (location.search) {
        history.replaceState({}, document.title, location.pathname);
      }
    } catch (e) {}
  }

  function saveDocument(showToast) {
    if (!currentDocId) return;
    var data;
    try { data = serialize(); } catch (e) {
      if (showToast) toast("Save failed", "error");
      return;
    }
    try {
      // Update the index entry first so the welcome screen metadata stays
      // in sync even if the content write is still in flight.
      var meta = null;
      for (var i = 0; i < documents.length; i++) {
        if (documents[i].id === currentDocId) { meta = documents[i]; break; }
      }
      if (!meta) {
        meta = { id: currentDocId, title: currentTitle, updatedAt: Date.now(), wordCount: 0 };
        documents.unshift(meta);
      }
      meta.title = currentTitle;
      meta.updatedAt = Date.now();
      try { meta.wordCount = getStats().words; } catch (e) {}
      saveIndex();
      writeDocData(data);
      setAutosaveState("saved");
      if (showToast) {
        // Explicit save â†’ also push to version history (store plaintext for versions)
        pushVersion(serialize());
        toast("Document saved", "success");
      }
    } catch (e) {
      setAutosaveState("error");
      if (showToast) toast("Save failed (storage full?)", "error");
    }
  }

  /* ---------------- Version history (per document, IndexedDB-backed) ---------------- */
  function pushVersion(data) {
    if (!currentDocId) return;
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
        idb.setJSON(versionsKey(currentDocId), versions);
      } else {
        localStorage.setItem(versionsKey(currentDocId), JSON.stringify(versions));
      }
    } catch (e) {}
  }

  function getVersions() {
    if (!currentDocId) return [];
    try {
      var raw = null;
      if (idbAvailable()) {
        raw = idb.getJSONSync(versionsKey(currentDocId));
        // getJSONSync returns parsed object, not string
        if (raw) return raw;
      }
      // fallback to localStorage
      raw = localStorage.getItem(versionsKey(currentDocId));
      if (raw) return JSON.parse(raw) || [];
      // Legacy fallback: documents migrated from the old single-document
      // builds adopt the old global version list until they create their own.
      if (currentDocId === _legacyMigratedId) {
        raw = localStorage.getItem(LEGACY_VERSIONS_KEY);
        if (raw) return JSON.parse(raw) || [];
        if (idbAvailable()) return idb.getJSONSync(LEGACY_VERSIONS_KEY) || [];
      }
      return [];
    } catch (e) { return []; }
  }

  function restoreVersion(index) {
    var versions = getVersions();
    if (index < 0 || index >= versions.length) return;
    var v = versions[index];
    currentTitle = v.title || "Untitled Document";
    syncFileModalNameInput();
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

  /* ---------------- Document lifecycle (open / close / new / delete) ---------------- */

  // Put a serialized document's content into the editor pages.
  function applyDocData(data) {
    currentTitle = data.title || "Untitled Document";
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
    // Restore editable header/footer strips (syncHeaderFooter runs inside
    // paginate() and creates them on every page).
    headerActive = hfHasContent(data.header);
    headerHTML = headerActive ? data.header : "";
    footerActive = hfHasContent(data.footer);
    footerHTML = footerActive ? data.footer : "";
    // Footnotes/endnotes are per-document. Docs saved before this existed
    // have no field â€” keep whatever loadFootnotes()/loadEndnotes() loaded
    // from the legacy global store so their notes aren't lost.
    if (Array.isArray(data.footnotes)) footnotes = data.footnotes;
    if (Array.isArray(data.endnotes)) endnotes = data.endnotes;
    paginate();
  }

  async function openDocument(id) {
    var data = await loadDocData(id);
    if (!data) { toast("Could not open document", "error"); return; }
    // Exit any focus/zen/print states left over from the previous document
    try { if ($("app").classList.contains("focus-mode")) toggleFocusMode(false); } catch (e) {}
    try { if ($("app").classList.contains("zen-mode")) toggleZenMode(false); } catch (e) {}
    try { togglePrintPreview(false); } catch (e) {}
    currentDocId = id;
    applyDocData(data);
    // Re-render footnote/endnote areas for the freshly-loaded content
    try { renderFootnotesSection(); renderEndnotesSection(); } catch (e) {}
    document.body.classList.remove("no-active-doc");
    showWelcomeScreen(false);
    switchRibbonTab("home");
    // Ribbon just became visible â€” re-measure the tab underline (it may have
    // been measured while display:none, leaving a 0-width indicator).
    refreshRibbonIndicator();
    updateOwnedUrl();
    updateStatus();
  }

  function closeDocument() {
    if (currentDocId) saveDocument(false);
    currentDocId = null;
    currentTitle = "Untitled Document";
    syncFileModalNameInput();
    // Leave a fresh blank page behind so status/interval code that touches
    // the pages never runs against an empty wrapper.
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    headerActive = false; headerHTML = "";
    footerActive = false; footerHTML = "";
    ensureFirstPage();
    paginate();
    updateStatus();
    history.replaceState({}, document.title, location.pathname);
    document.body.classList.add("no-active-doc");
    showWelcomeScreen(true);
  }

  async function createNewDocument() {
    var id = makeDocId();
    var title = nextUntitledTitle();
    documents.unshift({ id: id, title: title, updatedAt: Date.now(), wordCount: 0 });
    await saveIndex();
    await writeDocData({
      id: id,
      title: title,
      content: "<p><br></p>",
      savedAt: Date.now(),
      theme: theme,
      header: "",
      footer: "",
      footnotes: [],
      endnotes: [],
    });
    await openDocument(id);
    setTimeout(function () {
      var c = getContent(getPages()[0]);
      if (c) c.focus();
    }, 80);
  }

  function confirmDeleteCurrentDoc() {
    if (!currentDocId) return;
    _deleteTargetId = currentDocId;
    var modal = $("deleteDocModal");
    if (modal) modal.classList.add("show");
  }

  function closeDeleteDocModal() {
    var modal = $("deleteDocModal");
    if (!modal) { _deleteTargetId = null; return; }
    modal.classList.add("closing");
    setTimeout(function () {
      modal.classList.remove("show");
      modal.classList.remove("closing");
    }, 230);
    _deleteTargetId = null;
  }

  async function deleteDocument(id) {
    var wasCurrent = (currentDocId === id);
    if (wasCurrent) {
      // Detach BEFORE any awaits so a pending debounced autosave can't fire
      // mid-delete and resurrect this document via saveDocument()'s
      // re-create-missing-meta branch.
      currentDocId = null;
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    }
    documents = documents.filter(function (d) { return d.id !== id; });
    await saveIndex();
    await deleteDocData(id);
    if (wasCurrent) closeDocument();
    renderWelcomeCards();
    toast("Document deleted", "success");
  }

  /* ---------------- File modal (Backstage-style, Slides pattern) ---------------- */
  function syncFileModalNameInput() {
    var nameInput = $("fileModalNameInput");
    if (nameInput) nameInput.value = currentTitle;
  }

  function openFileModal() {
    var modal = $("fileModal");
    if (!modal || !currentDocId) return;
    syncFileModalNameInput();
    modal.classList.add("show");
  }

  function fileModalOpen() {
    var modal = $("fileModal");
    return !!(modal && modal.classList.contains("show"));
  }

  function closeFileModal() {
    var modal = $("fileModal");
    if (!modal) return;
    // Commit the (possibly renamed) title before closing
    commitFileModalRename();
    modal.classList.add("closing");
    setTimeout(function () {
      modal.classList.remove("show");
      modal.classList.remove("closing");
    }, 250);
    // Return to the Home tab so no tab is stuck on File
    switchRibbonTab("home");
  }

  function commitFileModalRename() {
    var nameInput = $("fileModalNameInput");
    if (!nameInput || !currentDocId) return;
    var newTitle = nameInput.value.trim() || "Untitled Document";
    if (newTitle !== currentTitle) {
      currentTitle = newTitle;
      scheduleAutosave(); // persists title + updates index meta
    }
  }

  /* ---------------- Legacy migration (single â†’ multi document) ----------------
     Old builds stored one document at STORAGE_KEY. If it exists and holds real
     content, adopt it as the first card on the welcome screen. Completely empty
     untitled leftovers are ignored so new users get a clean welcome screen. */
  async function migrateLegacyDocument() {
    var legacy = null;
    if (window.EmeraldIDBStorage) {
      legacy = await window.EmeraldIDBStorage.getJSON(STORAGE_KEY);
      if (!legacy) legacy = await window.EmeraldIDBStorage.migrateLocalJSON(STORAGE_KEY);
    }
    if (!legacy) {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { try { legacy = JSON.parse(raw); } catch (e) {} }
    }
    if (!legacy) return;

    var text = htmlToText(legacy.content);
    var isEmpty = !text && (!legacy.title || legacy.title === "Untitled Document");
    if (isEmpty) return; // nothing meaningful to carry over

    var id = makeDocId();
    _legacyMigratedId = id;
    var title = legacy.title || "Untitled Document";
    documents.unshift({
      id: id,
      title: title,
      updatedAt: legacy.savedAt || Date.now(),
      wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
    });
    await saveIndex();
    await writeDocData({
      id: id,
      title: title,
      content: legacy.content || "<p><br></p>",
      savedAt: legacy.savedAt || Date.now(),
      theme: legacy.theme || theme,
      header: legacy.header || "",
      footer: legacy.footer || "",
    });
  }

  /* ---------------- Welcome screen (home) ---------------- */
  function showWelcomeScreen(show) {
    var ws = $("welcomeScreen");
    if (!ws) return;
    ws.style.display = show ? "flex" : "none";
    if (show) renderWelcomeCards();
  }

  function formatCardDate(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  // Slides-style welcome cards: parallel data loads + a single atomic DOM
  // commit guarded by a render token (prevents stale/duplicate cards).
  function renderWelcomeCards() {
    var container = $("documentsDisplay");
    var noContainer = $("noDocsContainer");
    if (!container) return;

    var myToken = (_welcomeRenderToken = (_welcomeRenderToken || 0) + 1);

    function applyEmpty(empty) {
      // Hide the card grid entirely when empty so it doesn't reserve space
      // (matches Slides, where the image sits right under the section title)
      container.style.display = empty ? "none" : "";
      if (noContainer) noContainer.style.display = empty ? "flex" : "none";
    }

    if (documents.length === 0) {
      container.innerHTML = "";
      applyEmpty(true);
      return;
    }
    applyEmpty(false);

    var snapshot = documents.slice(0, 12);
    Promise.all(snapshot.map(async function (meta) {
      var data = await loadDocData(meta.id);
      return { meta: meta, data: data };
    })).then(function (results) {
      if (myToken !== _welcomeRenderToken) return; // a newer render started
      var frag = document.createDocumentFragment();
      for (var i = 0; i < results.length; i++) {
        (function (r) {
          var meta = r.meta, data = r.data;
          var snippet = data ? htmlToText(data.content) : "";
          var words = meta.wordCount || (snippet ? snippet.split(/\s+/).filter(Boolean).length : 0);

          var card = document.createElement("div");
          card.className = "document-card";

          var thumb = document.createElement("div");
          thumb.className = "document-card-thumb";
          var snip = document.createElement("div");
          snip.className = "document-card-snippet" + (snippet ? "" : " is-empty");
          snip.textContent = snippet ? snippet.slice(0, 220) : "Empty page";
          thumb.appendChild(snip);

          var info = document.createElement("div");
          info.className = "document-card-info";
          info.innerHTML =
            '<div class="document-card-title"></div>' +
            '<div class="document-card-meta"></div>';
          info.querySelector(".document-card-title").textContent = meta.title || "Untitled Document";
          info.querySelector(".document-card-meta").textContent =
            words + (words === 1 ? " word \u00B7 " : " words \u00B7 ") + formatCardDate(meta.updatedAt);

          card.appendChild(thumb);
          card.appendChild(info);
          card.addEventListener("click", function () { openDocument(meta.id); });
          frag.appendChild(card);
        })(results[i]);
      }
      container.innerHTML = "";
      container.appendChild(frag);
    }).catch(function () {});
  }

  /* ---------------- Import (.txt / .md / .html) ---------------- */
  function importTextToHtml(text, isMarkdown) {
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var inCode = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isMarkdown && /^\s*```/.test(line)) { inCode = !inCode; continue; }
      if (inCode) { out.push("<pre>" + escapeHtml(line) + "</pre>"); continue; }
      if (line.trim() === "") { out.push("<p><br></p>"); continue; }
      if (isMarkdown) {
        var h = /^(#{1,4})\s+(.*)$/.exec(line);
        if (h) { out.push("<h" + h[1].length + ">" + escapeHtml(h[2]) + "</h" + h[1].length + ">"); continue; }
        if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out.push("<hr>"); continue; }
        if (/^\s*>\s?/.test(line)) {
          out.push("<blockquote>" + escapeHtml(line.replace(/^\s*>\s?/, "")) + "</blockquote>");
          continue;
        }
        var li = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (li) { out.push("<ul><li>" + escapeHtml(li[1]) + "</li></ul>"); continue; }
        var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (ol) { out.push("<ol><li>" + escapeHtml(ol[1]) + "</li></ol>"); continue; }
        out.push("<p>" + escapeHtml(line) + "</p>");
      } else {
        out.push("<p>" + escapeHtml(line) + "</p>");
      }
    }
    return out.join("");
  }

  function importHtmlToContent(htmlText) {
    var parsed = new DOMParser().parseFromString(htmlText, "text/html");
    // Drop anything executable or page-structural before taking the body.
    var bad = parsed.querySelectorAll("script, iframe, object, embed, link, meta, style");
    for (var i = 0; i < bad.length; i++) bad[i].remove();
    var html = parsed.body ? parsed.body.innerHTML : "";
    return html && html.replace(/\S/g, "") ? html : "<p><br></p>";
  }

  async function importDocumentFromFile(file) {
    var ext = (file.name.toLowerCase().split(".").pop() || "");
    var baseName = file.name.replace(/\.[^.]+$/, "").trim() || "Imported Document";

    var contentPromise;
    if (ext === "html" || ext === "htm") {
      contentPromise = file.text().then(function (t) { return importHtmlToContent(t); });
    } else if (ext === "md" || ext === "markdown") {
      contentPromise = file.text().then(function (t) { return importTextToHtml(t, true); });
    } else if (ext === "txt" || ext === "text" || file.type.indexOf("text/") === 0) {
      contentPromise = file.text().then(function (t) { return importTextToHtml(t, false); });
    } else {
      toast("Unsupported file type. Please use .txt, .md or .html.", "error");
      return;
    }

    var content;
    try { content = await contentPromise; } catch (e) {
      toast("Could not read file", "error");
      return;
    }

    var id = makeDocId();
    var plain = htmlToText(content);
    documents.unshift({
      id: id,
      title: baseName,
      updatedAt: Date.now(),
      wordCount: plain ? plain.split(/\s+/).filter(Boolean).length : 0,
    });
    await saveIndex();
    await writeDocData({
      id: id,
      title: baseName,
      content: content,
      savedAt: Date.now(),
      theme: theme,
      header: "",
      footer: "",
      footnotes: [],
      endnotes: [],
    });
    toast("Imported \u201C" + baseName + "\u201D", "success");
    await openDocument(id);
  }

  function setAutosaveState(state) {
    // Save indicator pill: green=saved, yellow=saving, red=error (matching slides)
    var pill = $("saveIndicator");
    var pillText = pill ? pill.querySelector(".save-text") : null;
    if (pill) {
      pill.classList.remove("saving", "error");
      if (state === "saving") {
        pill.classList.add("saving");
        if (pillText) pillText.textContent = "Savingâ€¦";
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
        el.textContent = "Savingâ€¦";
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
  function printDocument() {
    saveDocument(false);
    // Force a paginate pass before printing so the latest content is split
    // into pages correctly (otherwise the printout may use stale page breaks).
    try { schedulePaginate(); } catch (e) {}
    // Defer window.print() to the next tick so the paginate pass has a chance
    // to flush DOM changes before the browser snapshots the page for printing.
    setTimeout(function () { window.print(); }, 50);
  }

  function exportDocument(format) {
    var title = (currentTitle || "document").replace(/[^\w\-]+/g, "_").toLowerCase() || "document";
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
        escapeHtml(currentTitle || "Document") +
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

  /* ---------------- Zoom (Slides-style buttons: fit / 100 / in / out) ---------------- */
  var currentZoom = 100;
  function setZoom(percent) {
    percent = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(percent)));
    currentZoom = percent;
    var wrapper = $(PAGES_WRAPPER_ID);
    if (wrapper) wrapper.style.zoom = String(percent / 100);
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

  /* ---------------- Theme ----------------
     Dark mode and accent color switching have been removed.
     The accent color is locked to cyan via the CSS :root variables,
     and there is no dark theme anymore â€” the app is always in light mode. */
  function applyTheme() {
    /* no-op â€” kept for backward compat with older code that calls applyTheme("light") */
  }

  function toggleTheme() {
    /* no-op â€” dark mode removed */
  }

  function toggleDarkPaper() {
    /* no-op â€” dark paper removed */
  }

  /* ---------------- Document color themes (accent presets) ----------------
     All accent-color switching has been removed. The app uses cyan as the
     single, locked accent color (defined in :root in docs.css). These stubs
     exist only so older code paths that still call applyColorTheme() /
     openColorThemeDialog() don't throw. */
  function applyColorTheme() { /* no-op â€” cyan is locked via CSS */ }
  function loadColorTheme()  { /* no-op */ }
  function openColorThemeDialog() { /* no-op â€” modal removed */ }
  function hexToRgba(hex, alpha) {
    var m = hex.match(/^#([0-9a-f]{6})$/i);
    if (!m) return "rgba(0,0,0," + alpha + ")";
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  /* ---------------- Clipboard history ---------------- */
  var clipboardHistory = [];
  var CLIPBOARD_MAX = 12;

  function captureClipboard(text) {
    if (!text || text.length < 1) return;
    // dedupe â€” if the same text is already the most recent, skip
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
          var preview = text.length > 60 ? text.slice(0, 60) + "â€¦" : text;
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
      // Cancel any in-flight closing animation (Slides re-opens instantly).
      clearTimeout(m._closeTimer);
      m.classList.remove("closing");
      m.classList.add("open");
      m.setAttribute("aria-hidden", "false");
      var first = m.querySelector("input[type='text'], input[type='url'], input:not([type])");
      if (first) setTimeout(function () { first.focus(); }, 80);
    }
  }

  function closeModal(id) {
    var m = $(id);
    if (!m) return;
    m.setAttribute("aria-hidden", "true");
    if (!m.classList.contains("open")) return;
    // Slides' close: add .closing (0.23s fadeOutOverlay/fadeOutModal), then
    // drop .open 230ms later â€” same timing as the Slides app's modals.
    clearTimeout(m._closeTimer);
    m.classList.add("closing");
    m._closeTimer = setTimeout(function () {
      m.classList.remove("closing");
      m.classList.remove("open");
    }, 230);
  }

  function closeAllModals() {
    var modals = document.querySelectorAll(".modal-overlay");
    for (var i = 0; i < modals.length; i++) {
      closeModal(modals[i].id);
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
      // show on focus â€” rebuild items each time so new searches appear
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
    var url = normalizeExternalUrl($("linkUrl").value.trim());
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

  /* Bare domains typed into the Link dialog ("youtube.com") must NOT resolve
     relative to the app origin (which produced http://127.0.0.1:5500/youtube.com).
     Anything without an explicit scheme/anchor/root path gets https:// prefixed. */
  function normalizeExternalUrl(url) {
    var u = String(url || "").trim();
    if (!u) return u;
    if (/^(https?:\/\/|mailto:|tel:|ftp:|file:|#|\/)/i.test(u)) return u;
    return "https://" + u;
  }

  /* ---------------- Insert Image (Slides-style: OS file picker directly) ---------------- */
  function openImagePicker() {
    // Slides parity: no dialog â€” clicking the ribbon button opens the
    // native file explorer straight away via a hidden <input type=file>.
    var input = $("insertImageInput");
    if (input) input.click();
  }

  function handleImageFileSelect(e) {
    var input = e.target;
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      // Alt text defaults to the file name (without extension).
      var alt = (file.name || "image").replace(/\.[^.]+$/, "");
      doInsertImage(ev.target.result, alt);
    };
    reader.readAsDataURL(file);
    // Reset so selecting the same file again still fires "change".
    input.value = "";
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
    $("tableGridLabel").textContent = tableDims.rows + " Ã— " + tableDims.cols;
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
    toast("Table inserted (" + tableDims.rows + "Ã—" + tableDims.cols + ")", "success");
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
    var title = currentTitle || "Untitled Document";
    var date = formatTime(Date.now());
    var sentences = countSentences();
    var avgWordsPerSentence = sentences > 0 ? Math.round(stats.words / sentences) : 0;
    var readingTime = stats.readingMin + " min";
    var speakingTime = Math.max(1, Math.ceil(stats.words / 130)) + " min";

    // Build a printable stats overlay
    var overlay = document.createElement("div");
    overlay.className = "stats-printable";
    overlay.innerHTML =
      '<h1>' + escapeHtml(title) + ' â€” Statistics Report</h1>' +
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
      '<p style="margin-top:32px;color:#999;font-size:11px">EmeraldSuite: Docs â€” generated automatically</p>';
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
     EmeraldSuite pattern (matches Slides): clicking a tab animates a sliding
     underline indicator to the active tab, and cross-fades the corresponding
     ribbon-panel with a blur-out â†’ blur-in transition.

     IMPORTANT: We listen for `transitionend` on the blur-out animation
     rather than using a fixed setTimeout. The blur-out transition is 0.18s;
     firing at 140ms (the old behaviour) left the panel at ~5% opacity when
     its position flipped from `relative` (centered via margin:auto) to
     `absolute; left:0` â€” causing a brief flash on the left edge of the
     ribbon before the new panel appeared in the center. */
  /* ---------------- Ribbon tab indicator helpers ---------------- */
  // Position the sliding underline under a tab. No-ops safely when the
  // ribbon is hidden (welcome screen) â€” the rect is just 0Ã—0 then.
  function moveRibbonIndicatorTo(tab) {
    var indicator = $("ribbonTabIndicator");
    if (!indicator || !tab) return;
    var rect = tab.getBoundingClientRect();
    var parentRect = tab.parentElement.getBoundingClientRect();
    indicator.style.width = rect.width + "px";
    indicator.style.transform = "translateX(" + (rect.left - parentRect.left) + "px)";
  }

  // Re-measure the active tab's underline after the ribbon becomes visible
  // (opening a document, fonts loading, resizeâ€¦). Double rAF so layout has
  // settled â€” measuring while display:none yields a 0-width underline.
  function refreshRibbonIndicator() {
    if (window.requestAnimationFrame) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var active = document.querySelector(".ribbon-tab.active");
          if (active) moveRibbonIndicatorTo(active);
        });
      });
    } else {
      setTimeout(function () {
        var active = document.querySelector(".ribbon-tab.active");
        if (active) moveRibbonIndicatorTo(active);
      }, 50);
    }
  }

  function initRibbonTabs() {
    var tabs = document.querySelectorAll(".ribbon-tab");
    var panels = document.querySelectorAll(".ribbon-panel");
    var indicator = $("ribbonTabIndicator");
    if (!tabs.length || !indicator) return;

    // Position under the initially-active tab after layout settles. If the
    // ribbon is hidden at that point (welcome screen) the measure is skipped
    // â€” refreshRibbonIndicator() re-runs it when a document opens.
    setTimeout(function () {
      var active = document.querySelector(".ribbon-tab.active");
      if (active && active.getBoundingClientRect().width > 0) moveRibbonIndicatorTo(active);
    }, 100);

    // Re-align when fonts finish loading (tab widths can shift) â€” same as Slides
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(refreshRibbonIndicator);
    }

    // Activate a tab's classes + move the indicator (no panel logic).
    function activateTabClasses(tab) {
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
      tab.classList.add("active");
      moveRibbonIndicatorTo(tab);
    }

    // Blur-out whatever panel is active, then run `mid` when invisible.
    function blurOutActivePanel(mid) {
      var currentActive = document.querySelector(".ribbon-panel.active");
      if (!currentActive) { mid(); return; }
      currentActive.classList.add("blur-out");
      currentActive.classList.remove("active");
      var onBlurred = function (e) {
        if (e.propertyName !== "opacity") return;
        currentActive.removeEventListener("transitionend", onBlurred);
        currentActive.classList.remove("blur-out");
        mid();
      };
      currentActive.addEventListener("transitionend", onBlurred);
      // Fallback: force at 220ms (past the 0.18s transition + buffer)
      setTimeout(function () {
        if (currentActive.classList.contains("blur-out")) {
          currentActive.removeEventListener("transitionend", onBlurred);
          currentActive.classList.remove("blur-out");
          mid();
        }
      }, 220);
    }

    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        var tab = this;
        var target = tab.getAttribute("data-tab");
        // already active?
        if (tab.classList.contains("active") && target !== "file") return;

        // FILE TAB â†’ Backstage-style File modal (Slides behaviour).
        // The File tab has no inline ribbon panel; clicking it opens the
        // file modal overlay over the editor instead.
        if (target === "file") {
          blurOutActivePanel(function () {});
          activateTabClasses(tab);
          openFileModal();
          return;
        }

        activateTabClasses(tab);

        var targetPanel = document.querySelector('.ribbon-panel[data-panel="' + target + '"]');

        blurOutActivePanel(function () {
          if (targetPanel) targetPanel.classList.add("active");
        });
      });
    }

    // Reposition indicator on resize
    window.addEventListener("resize", function () {
      var active = document.querySelector(".ribbon-tab.active");
      if (active) moveRibbonIndicatorTo(active);
    });
  }

  /* ---------------- Programmatic tab switch (used by the File modal) ---------------- */
  function switchRibbonTab(name) {
    var tab = document.querySelector('.ribbon-tab[data-tab="' + name + '"]');
    if (!tab) return;
    var active = document.querySelector(".ribbon-tab.active");
    if (active === tab) return;
    var panels = document.querySelectorAll(".ribbon-panel");
    var targetPanel = document.querySelector('.ribbon-panel[data-panel="' + name + '"]');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.remove("active");
      panels[j].classList.remove("blur-out");
    }
    var tabsAll = document.querySelectorAll(".ribbon-tab");
    for (var t = 0; t < tabsAll.length; t++) tabsAll[t].classList.toggle("active", tabsAll[t] === tab);
    if (targetPanel) targetPanel.classList.add("active");
    moveRibbonIndicatorTo(tab);
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
      if (pct >= 25 && !goalMilestones[25]) { goalMilestones[25] = true; toastMilestone("25% there â€” keep going!"); }
      if (pct >= 50 && !goalMilestones[50]) { goalMilestones[50] = true; toastMilestone("Halfway there!"); }
      if (pct >= 75 && !goalMilestones[75]) { goalMilestones[75] = true; toastMilestone("75% â€” almost done!"); }

      // Celebration: fire confetti once when goal is first reached
      if (current >= goalTarget && !goalCelebrated) {
        goalCelebrated = true;
        fireConfetti();
        toastMilestone("Goal reached! Well done.");
      } else if (current < goalTarget && goalCelebrated) {
        // reset so it can celebrate again if user dips below and re-reaches
        goalCelebrated = false;
      }
      // reset milestones if user drops below
      if (pct < 75) goalMilestones[75] = false;
      if (pct < 50) goalMilestones[50] = false;
      if (pct < 25) goalMilestones[25] = false;
    } else {
      targetEl.textContent = "â€”";
      fillEl.style.width = "0%";
      fillEl.className = "goal-bar-fill";
      if (inputEl && document.activeElement !== inputEl) inputEl.value = "";
      goalCelebrated = false;
      goalMilestones = { 25: false, 50: false, 75: false };
    }
  }

  function toastMilestone(msg) {
    // Milestones reuse the standard Slides-style toast (white pill + award
    // icon picked by _toastIcon) â€” no more special gradient styling.
    toast(msg, "success");
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

  /* Smart sentence tokenizer â€” protects abbreviations and decimals. */
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
      return { score: 0, grade: "â€”", level: "â€”", desc: "Not enough text to analyze.", words: 0, sentences: 0, syllables: 0 };
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
    else if (score >= 60) { level = "Standard"; desc = "8thâ€“9th grade. Plain English. Good for most content."; }
    else if (score >= 50) { level = "Fairly Difficult"; desc = "10thâ€“12th grade. Fairly difficult to read."; }
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
  // A small curated list of common misspellings â†’ corrections
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
          context: "â€¦" + tokens[j - 1] + " " + tokens[j] + "â€¦",
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
          context: "â€¦" + match[0] + "â€¦",
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
          text.innerHTML = 'Repeated word: <span class="issue-highlight">' + escapeHtml(issue.word) + '</span> â€” <span class="issue-suggestion">' + escapeHtml(issue.suggestion) + '</span>';
        } else {
          text.innerHTML = 'Possible misspelling: <span class="issue-highlight">' + escapeHtml(issue.word) + '</span> â†’ <span class="issue-suggestion">' + escapeHtml(issue.suggestion) + '</span>';
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
      toast("Focus mode on â€” press Esc to exit", "success");
      setTimeout(function () {
        var fc = getContent(getPages()[0]);
        if (fc) fc.focus();
      }, 100);
    } else {
      app.classList.remove("focus-mode");
    }
  }

  /* ---------------- Zen mode (auto-hide chrome on typing) ---------------- */
  // Zen mode is a softer Focus Mode: when enabled via View â†’ Zen (or Ctrl+Shift+Z),
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
      toast("Zen mode on â€” type or move mouse to show controls", "success");
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
    // render last 35 days as 5 rows Ã— 7 cols (5 weeks)
    var cells = 35;
    var start = new Date(today);
    start.setDate(start.getDate() - (cells - 1));
    for (var c = 0; c < cells; c++) {
      var d = new Date(start);
      d.setDate(d.getDate() + c);
      var ds = d.toISOString().slice(0, 10);
      var cell = document.createElement("div");
      cell.className = "streak-cell" + (daySet[ds] ? " streak-cell-active" : "");
      cell.title = ds + (daySet[ds] ? " â€” wrote" : " â€” no activity");
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
        remove.textContent = "Ã—";
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
     EMERALDSUITE: DOCS â€” additional features
     =================================================================== */

  /* ---------------- Templates ---------------- */
  var TEMPLATES = [
    { id: "blank", name: "Blank Document", desc: "Start from scratch", html: "<p><br></p>" },
    { id: "resume", name: "Resume", desc: "Clean professional CV", html:
      "<h1>First Last</h1><p>email@example.com Â· (555) 123-4567 Â· City, Country</p>" +
      "<h2>Summary</h2><p>Experienced professional with a track record of...</p>" +
      "<h2>Experience</h2><p><strong>Job Title</strong> â€” Company, 2020â€“Present</p><p>Description of role and achievements.</p>" +
      "<p><strong>Previous Role</strong> â€” Company, 2017â€“2020</p><p>Description.</p>" +
      "<h2>Education</h2><p><strong>Degree</strong> â€” University, Year</p>" +
      "<h2>Skills</h2><p>Skill Â· Skill Â· Skill Â· Skill</p>"
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
      "<h2>Action Items</h2><p>Â· Task â€” Owner â€” Due date</p>"
    },
    { id: "essay", name: "Essay", desc: "Academic 5-paragraph", html:
      "<h1>Essay Title</h1>" +
      "<p><em>Introduction</em> â€” Hook, context, and thesis statement that previews three main points.</p>" +
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
    currentTitle = t.name;
    syncFileModalNameInput();
    paginate();
    saveDocument(false);
    toast(t.name + " template applied", "success");
    setTimeout(function () { content.focus(); }, 100);
  }

  /* ---------------- Symbol bar (Slides-style floating bottom bar) ----------------
     Ported from the Slides app's symbolToolbar: a bottom-docked floating
     pill (no modal box) with grouped symbol buttons â€” Stars, Marks, Arrows,
     Math, Greek, Numbers, Special. Clicking a symbol inserts it at the
     caret; the bar STAYS OPEN so several symbols can be inserted in a row
     (Slides parity). Done â€” or the ribbon button again â€” closes it. */
  function toggleSymbolBar(force) {
    var bar = $("symbolToolbar");
    var btn = $("btnSymbols");
    if (!bar) return;
    var shouldOpen = force === undefined ? !bar.classList.contains("visible") : force;
    if (shouldOpen) {
      // Only one bottom toolbar at a time â€” exit draw mode if it is on.
      if (drawMode) toggleDrawMode(false);
      bar.classList.add("visible");
      if (btn) btn.classList.add("active");
    } else {
      bar.classList.remove("visible");
      if (btn) btn.classList.remove("active");
    }
  }

  function initSymbolBar() {
    var bar = $("symbolToolbar");
    if (!bar) return;
    var buttons = bar.querySelectorAll(".sym-bar-btn");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var sym = btn.getAttribute("data-s") || btn.textContent;
          restoreEditorSelection();
          document.execCommand("insertText", false, sym);
          schedulePaginate();
          scheduleAutosave();
          toast('Inserted "' + sym + '"');
        });
      })(buttons[i]);
    }
    var done = $("symbolDoneBtn");
    if (done) done.addEventListener("click", function () { toggleSymbolBar(false); });
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
    var btnDropCap = $("btnDropCap");
    if (block.classList.contains("has-dropcap")) {
      block.classList.remove("has-dropcap");
      if (btnDropCap) btnDropCap.classList.remove("active");
      toast("Drop cap removed", "success");
    } else {
      block.classList.add("has-dropcap");
      if (btnDropCap) btnDropCap.classList.add("active");
      toast("Drop cap applied", "success");
    }
    schedulePaginate();
    scheduleAutosave();
  }

  /* Sync the Drop Cap button's toggle-ON look with the paragraph under the
     caret, so the button visually reflects the applied state (ON/OFF) while
     moving through the document â€” same behavior as Bold/Italic buttons. */
  function updateDropCapState() {
    var btn = document.getElementById("btnDropCap");
    if (!btn) return;
    var block = getCurrentBlock();
    var on = !!(block && block.tagName === "P" && block.classList.contains("has-dropcap"));
    btn.classList.toggle("active", on);
    btn.title = on ? "Drop cap (currently ON â€” click to remove)" : "Drop cap";
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
  // Order matches the Layout -> Size dropdown (Letter ... Envelope).
  // Dimensions are 96dpi CSS pixels: Letter 8.5x11", Legal 8.5x14",
  // Executive 7.25x10.5", A4/A5/A6 ISO paper, Envelope #10 4.125x9.5".
  var PAGE_SIZES = {
    Letter: { w: 816, h: 1056 },
    Legal: { w: 816, h: 1344 },
    Executive: { w: 696, h: 1008 },
    A4: { w: 794, h: 1123 },
    A5: { w: 559, h: 794 },
    A6: { w: 397, h: 559 },
    Envelope: { w: 396, h: 912 },
  };
  var currentPageSizeName = "A4";

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

  // Sync the Layout -> Size dropdown + status-bar label with the current
  // size. Detection matches width AND height (Letter and Legal share a
  // width, so width-only matching would confuse them). Falls back to the
  // last chosen name when pages use a custom size (e.g. landscape).
  function syncPageSizeUI() {
    var pages = getPages();
    if (pages[0]) {
      var w = pages[0].style.width;
      var h = pages[0].style.height;
      for (var name in PAGE_SIZES) {
        if (PAGE_SIZES[name].w + "px" === w && PAGE_SIZES[name].h + "px" === h) {
          currentPageSizeName = name;
          break;
        }
      }
    }
    var dd = $("pageSizeDropdown");
    if (dd) {
      var lbl = dd.querySelector(".dropdown-value");
      if (lbl) lbl.textContent = currentPageSizeName;
      var items = dd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var it = 0; it < items.length; it++) {
        items[it].classList.toggle("active", items[it].getAttribute("data-value") === currentPageSizeName);
      }
    }
    var label = document.querySelector(".page-size-label");
    if (label) label.textContent = currentPageSizeName;
  }

  function setPageSize(name) {
    var dim = PAGE_SIZES[name];
    if (!dim) return;
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      pages[i].style.width = dim.w + "px";
      pages[i].style.height = dim.h + "px";
      pages[i].classList.remove("landscape"); // a named size is always portrait
    }
    currentPageSizeName = name;
    syncPageSizeUI();
    schedulePaginate();
    scheduleAutosave();
    toast("Page size: " + name, "success");
  }

  /* ---------------- Header / Footer / Page Number ---------------- */
  // Robust "is the selection inside X" check. anchorNode can BE the element
  // itself (caret at (container, childCount)) â€” parentElement would then point
  // ABOVE the container and closest() would miss it.
  function selectionInside(sel, selector) {
    if (!sel || !sel.rangeCount || !sel.anchorNode) return false;
    var el = sel.anchorNode.nodeType === Node.ELEMENT_NODE
      ? sel.anchorNode
      : sel.anchorNode.parentElement;
    return !!(el && el.closest && el.closest(selector));
  }

  // When the caret is parked at a container's very end ((el, childCount)),
  // execCommand insertHTML drops the new node as a SIBLING below the last
  // paragraph â€” it then renders on its own line (outside a footer strip's
  // height). Deepening the caret into the last line keeps inserts inline.
  function deepenEndCaret(el) {
    if (!el) return;
    var sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.anchorNode !== el ||
        sel.anchorOffset !== el.childNodes.length) return;
    var node = el.lastChild;
    if (!node) return;
    while (node.nodeType === Node.ELEMENT_NODE && node.lastChild && node.tagName !== "BR") {
      node = node.lastChild;
    }
    try {
      var r = document.createRange();
      r.setStart(node, node.nodeType === Node.TEXT_NODE ? node.textContent.length : node.childNodes.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }

  // Move field spans that Chrome dropped as direct children of a header/
  // footer strip (outside any <p>) into the strip's last paragraph, so they
  // render INLINE like Word page numbers. Also refreshes the saved
  // headerHTML/footerHTML state from the normalized strips.
  function normalizeStrayHF() {
    var strips = document.querySelectorAll(".page-header.editable, .page-footer.editable");
    var firstH = null, firstF = null;
    for (var i = 0; i < strips.length; i++) {
      var strip = strips[i];
      var strays = strip.querySelectorAll(":scope > .field-dynamic");
      for (var s = 0; s < strays.length; s++) {
        var ps = strip.querySelectorAll(":scope > p");
        var last = ps.length ? ps[ps.length - 1] : null;
        if (last) last.appendChild(strays[s]);
        else {
          var p = document.createElement("p");
          p.appendChild(strays[s]);
          strip.appendChild(p);
        }
      }
      if (!firstH && strip.classList.contains("page-header")) firstH = strip;
      if (!firstF && strip.classList.contains("page-footer")) firstF = strip;
    }
    if (firstH) headerHTML = firstH.innerHTML;
    if (firstF) footerHTML = firstF.innerHTML;
  }

  function insertPageNumber() {
    // If the caret is inside a header/footer strip, insert the field there
    // (so "Page N" can live in the footer like real Word documents).
    var sel = window.getSelection();
    if (!selectionInside(sel, ".page-header.editable, .page-footer.editable")) {
      restoreEditorSelection();
      sel = window.getSelection();
      if (!selectionInside(sel, ".page-content")) {
        var fc = getContent(getPages()[0]);
        if (fc) fc.focus();
      }
    }
    // Caret at a container's end â†’ deepen into the last line (inline insert)
    var anchor = sel && sel.anchorNode ? sel.anchorNode : null;
    deepenEndCaret(anchor && anchor.nodeType === Node.ELEMENT_NODE ? anchor : null);
    document.execCommand("insertHTML", false, '<span class="field-dynamic" contenteditable="false" data-field="PAGE">Page 1</span> ');
    // Chrome drops contenteditable=false nodes AFTER the paragraph when the
    // caret sits at a block's end â€” pull strays back inline + re-mirror.
    normalizeStrayHF();
    updateDynamicFields();
    schedulePaginate();
    scheduleAutosave();
    toast("Page number field inserted", "success");
  }

  /* MS Word-style editable header/footer strips:
     - Layout -> Header / Footer toggles an editable strip on EVERY page.
     - Strips mirror each other: editing any copy updates all of them.
     - Page-number fields work inside them (Page # with the caret in the
       strip inserts "Page N"; every page shows its own number).
     - Clearing all text removes the strip when it loses focus (like Word).
     - Content lives OUTSIDE .page-content so the paginator never moves it;
       syncHeaderFooter() re-applies strips to pages the paginator creates. */
  var headerActive = false;
  var footerActive = false;
  var headerHTML = "";
  var footerHTML = "";

  function isHFEmpty(el) {
    if (!el) return true;
    var text = el.textContent.replace(/\u200B/g, "").trim();
    if (text !== "") return false;
    return el.querySelectorAll("img, svg, table, hr, .field-dynamic").length === 0;
  }

  // Keep the .is-empty class in sync â€” CSS shows the grayed hint through it.
  function refreshHFHint(el) {
    if (el) el.classList.toggle("is-empty", isHFEmpty(el));
  }

  function hfHasContent(html) {
    if (!html) return false;
    var probe = document.createElement("div");
    probe.innerHTML = html;
    return !isHFEmpty(probe);
  }

  function makeHeaderFooter(kind, html) {
    var el = document.createElement("div");
    el.className = "page-" + kind + " editable";
    el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "false");
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-label", kind === "header" ? "Page header" : "Page footer");
    // Hint text as a CSS variable so the grayed "Header"/"Footer" label can
    // be rendered by CSS INSIDE the empty <p> (exactly where Word shows it).
    el.style.setProperty("--hf-hint", kind === "header" ? "Header" : "Footer");
    el.innerHTML = html || "";
    refreshHFHint(el);

    el.addEventListener("input", function () {
      var html2 = el.innerHTML;
      if (kind === "header") headerHTML = html2; else footerHTML = html2;
      // Mirror to every other page's strip
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        var peers = pages[i].querySelectorAll(":scope > .page-" + kind + ".editable");
        for (var p = 0; p < peers.length; p++) {
          if (peers[p] !== el && peers[p].innerHTML !== html2) {
            peers[p].innerHTML = html2;
            refreshHFHint(peers[p]);
          }
        }
      }
      refreshHFHint(el);
      updateDynamicFields(); // re-number PAGE fields on every page
      scheduleAutosave();
    });

    el.addEventListener("blur", function () {
      // Word behavior: an emptied header/footer removes itself on blur.
      if (isHFEmpty(el)) {
        if (kind === "header") { headerActive = false; headerHTML = ""; }
        else { footerActive = false; footerHTML = ""; }
        removeAllHF(kind);
        toast((kind === "header" ? "Header" : "Footer") + " removed", "info");
        scheduleAutosave();
      }
    });

    el.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        var first = getContent(getPages()[0]);
        if (first) first.focus();
      }
    });

    return el;
  }

  function removeAllHF(kind) {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var els = pages[i].querySelectorAll(":scope > .page-" + kind + ".editable");
      for (var k = 0; k < els.length; k++) els[k].remove();
    }
  }

  // Re-apply strips to every page â€” called from paginate() so pages the
  // paginator creates (or removes) stay in sync.
  function syncHeaderFooter() {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var h = page.querySelector(":scope > .page-header.editable");
      if (headerActive) {
        if (!h) page.insertBefore(makeHeaderFooter("header", headerHTML), page.firstChild);
      } else if (h) {
        h.remove();
      }
      var f = page.querySelector(":scope > .page-footer.editable");
      if (footerActive) {
        if (!f) page.appendChild(makeHeaderFooter("footer", footerHTML));
      } else if (f) {
        f.remove();
      }
    }
  }

  // Layout -> Header / Footer button: create the strip (or jump to it).
  function editHeaderFooter(kind) {
    var isActive = kind === "header" ? headerActive : footerActive;
    if (!isActive) {
      if (kind === "header") { headerActive = true; headerHTML = "<p><br></p>"; }
      else { footerActive = true; footerHTML = "<p><br></p>"; }
      syncHeaderFooter();
      scheduleAutosave();
      toast((kind === "header" ? "Header" : "Footer") + " added â€” type in the " +
            (kind === "header" ? "top" : "bottom") + " strip", "success");
    } else {
      toast((kind === "header" ? "Header" : "Footer") + " â€” edit the " +
            (kind === "header" ? "top" : "bottom") + " strip of any page", "info");
    }
    // Jump to the first strip so the user can type right away
    // (Word's "Edit Header" does the same).
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var el = pages[i].querySelector(":scope > .page-" + kind + ".editable");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: kind === "header" ? "start" : "end" });
        el.focus();
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        break;
      }
    }
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
      // default â€” no class needed
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
      fontSize: (function () {
        // Computed px (works for both legacy <font> tags and exact-size spans)
        try { return getComputedStyle(el).fontSize; } catch (e) { return null; }
      })(),
    };
    document.body.classList.add("painter-active");
    toast("Format copied â€” select text to apply", "success");
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
    if (painterFormat.fontSize) applyFontSize(parseFloat(painterFormat.fontSize));
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
        // strip all formatting â†’ plain text
        document.execCommand("insertText", false, text);
      } else if (mode === "html") {
        document.execCommand("insertHTML", false, escapeHtml(text));
      } else {
        // keep source â€” try insertFromPaste, fallback to text
        document.execCommand("insertText", false, text);
      }
      schedulePaginate();
      scheduleAutosave();
      closeModal("pasteSpecialModal");
      toast("Pasted (" + mode + ")", "success");
    }).catch(function () {
      // clipboard read denied â€” use last clipboard text if available
      toast("Clipboard access denied â€” use Ctrl+V", "error");
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
    ":-)": "ðŸ˜Š", ":-(": "ðŸ˜ž", "<3": "â¤",
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
      quote: quote.substring(0, 80) + (quote.length > 80 ? "â€¦" : ""),
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
      empty.textContent = "No comments yet. Select text and use Review â†’ Comment.";
      body.appendChild(empty);
      return;
    }
    for (var i = 0; i < comments.length; i++) {
      (function (c) {
        var item = document.createElement("div");
        item.className = "comment-item" + (c.resolved ? " resolved" : "");
        var quote = document.createElement("div");
        quote.className = "comment-quote";
        quote.textContent = "â€œ" + c.quote + "â€";
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
    toast("Reading aloudâ€¦", "success");
  }

  function formatTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return d.toLocaleString([], { hour: "2-digit", minute: "2-digit" });
  }

  /* ---------------- Toast (Slides design) ----------------
     Same pattern as the Slides app's showToast + _toastIcon:
     white glass pill, monochrome black 16px SVG icon, 10px gap,
     3000ms duration. The old colored success/error variants were
     removed to match Slides exactly. */
  function _toastIcon(rawMsg, type) {
    // Strip leading emoji/whitespace so the icon doesn't double up with
    // a &#10003; or âš  character that was baked into the message string.
    var msg = String(rawMsg || "").replace(/^\s*[\u2705\u2714\u2716\u2728\u26a0\ufe0f\u2757\u2753\u2139]+\s*/u, "").trim();
    var m = msg.toLowerCase();

    // Monochrome black â€” matches the Slides app's toast icon color.
    var INK = "#111";

    // SVG stroke wrapper helper
    var svg = function (paths) {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
    };

    // 1. Loading / progress (reading, recording, generatingâ€¦)
    if (m.indexOf("generating") === 0 || m.indexOf("importing") === 0 || m.indexOf("recording") === 0 ||
        m.indexOf("reading") === 0 || m.indexOf("previewing") === 0 ||
        m.indexOf("searching") === 0 || m.indexOf("loading") === 0 || m.indexOf("this may take") !== -1) {
      return { icon: svg('<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>'), msg: msg };
    }

    // 2. Clipboard / copied / pasted
    if (m.indexOf("clipboard") !== -1 || m.indexOf("copied") !== -1 || m.indexOf("pasted") !== -1 || m.indexOf("paste ") !== -1) {
      return { icon: svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'), msg: msg };
    }

    // 3. Failed / error (hard errors)
    if (m.indexOf("failed") !== -1 || m.indexOf("error") !== -1 || m.indexOf("could not") !== -1 ||
        m.indexOf("not supported") !== -1 || m.indexOf("denied") !== -1 || m.indexOf("invalid") !== -1 ||
        m.indexOf("skipping") !== -1 || m.indexOf("cancelled") === -1 && type === "error" && (
          m.indexOf("do not match") !== -1)) {
      return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'), msg: msg };
    }

    // 4. Warnings / hints: must / select first / no X found / enter a â€¦
    if (m.indexOf("must have") !== -1 || m.indexOf("must be") !== -1 || m.indexOf("select ") !== -1 ||
        m.indexOf("place cursor") !== -1 || m.indexOf("no headings") !== -1 || m.indexOf("no captions") !== -1 ||
        m.indexOf("no text") !== -1 || m.indexOf("no image") !== -1 || m.indexOf("no comments") !== -1 ||
        m.indexOf("no bookmarks") !== -1 || m.indexOf("no footnote") !== -1 || m.indexOf("no tracked") !== -1 ||
        m.indexOf("no quick parts") !== -1 || m.indexOf("no captions") !== -1 ||
        m.indexOf("enter a ") !== -1 || m.indexOf("provide a url") !== -1 || m.indexOf("coming soon") !== -1) {
      return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'), msg: msg };
    }

    // 5. Deleted / removed
    if (m.indexOf("deleted") !== -1 || m.indexOf("removed") !== -1) {
      return { icon: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'), msg: msg };
    }

    // 6. Milestones / goals (word-count goal celebrations)
    if (m.indexOf("%") !== -1 || m.indexOf("halfway") !== -1 || m.indexOf("goal") !== -1 || m.indexOf("well done") !== -1) {
      return { icon: svg('<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>'), msg: msg };
    }

    // 7. Modes toggled (focus / zen / draw / track changes / read-only)
    if (m.indexOf("mode") !== -1 || m.indexOf("track changes") !== -1 || m.indexOf("read-only") !== -1 || m.indexOf("final") !== -1) {
      return { icon: svg('<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/><path d="M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>'), msg: msg };
    }

    // 8. Success confirmations (saved / inserted / applied / added / exportedâ€¦)
    if (m.indexOf("saved") !== -1 || m.indexOf("inserted") !== -1 || m.indexOf("applied") !== -1 ||
        m.indexOf("added") !== -1 || m.indexOf("created") !== -1 || m.indexOf("restored") !== -1 ||
        m.indexOf("exported") !== -1 || m.indexOf("merged") !== -1 || m.indexOf("complete") !== -1 ||
        m.indexOf("finished") !== -1 || m.indexOf("fixed") !== -1 || m.indexOf("cleared") !== -1 ||
        m.indexOf("unlocked") !== -1 || m.indexOf("updated") !== -1 || m.indexOf("jumped to") !== -1 ||
        m.indexOf("toggled") !== -1 || m.indexOf("stopped") !== -1 || m.indexOf("reset") !== -1 ||
        m.indexOf("protected") !== -1 || m.indexOf("marked") !== -1 || m.indexOf("protected") !== -1) {
      return { icon: svg('<polyline points="20 6 9 17 4 12"/>'), msg: msg };
    }

    // 9. Default info icon
    return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'), msg: msg };
  }

  function toast(message, type) {
    var el = $("toast");
    if (!el) return;
    var pair = _toastIcon(message, type);
    // Same structure as Slides' showToast: flex row, icon + message, 10px gap.
    var outer = document.createElement("span");
    outer.style.cssText = "display:flex;align-items:center;gap:10px;";
    var iconSpan = document.createElement("span");
    iconSpan.style.cssText = "display:inline-flex;flex-shrink:0;";
    iconSpan.innerHTML = pair.icon;
    var msgSpan = document.createElement("span");
    msgSpan.textContent = pair.msg;
    outer.appendChild(iconSpan);
    outer.appendChild(msgSpan);
    el.replaceChildren(outer);
    el.className = "toast show";
    clearTimeout(toastTimer);
    // Slides' default duration: 3000ms.
    toastTimer = setTimeout(function () { el.className = "toast"; }, 3000);
  }

  /* ---------------- Init ---------------- */
  async function init() {
    // Initialize IDB storage
    idb = window.EmeraldIDBStorage || null;
    if (idb) {
      // Wait for IDB to be ready
      try { await idb.ready(); } catch (e) {}
    }

    // Theme â€” dark mode removed; cyan is the only accent color and is set via CSS.
    // (The old THEME_KEY localStorage lookup is no longer needed.)

    ensureFirstPage();
    paginate();

    // Load footnote/endnote arrays BEFORE any document open â€” the deep-link
    // ?owned= path below opens a document immediately, and openDocument
    // renders the per-page footnote areas + end-of-doc endnotes section.
    loadFootnotes();
    loadEndnotes();

    // Multi-document model: load the index, adopt a legacy single document
    // if one exists, then land on the welcome screen unless a specific
    // document is requested via ?owned=<docId>.
    await loadIndex();
    try { await migrateLegacyDocument(); } catch (e) {}
    showWelcomeScreen(true);

    var ownedParam = null;
    try { ownedParam = new URLSearchParams(location.search).get("owned"); } catch (e) {}
    if (ownedParam) {
      var meta = null;
      for (var mi = 0; mi < documents.length; mi++) {
        if (documents[mi].id === ownedParam) { meta = documents[mi]; break; }
      }
      if (meta) {
        await openDocument(ownedParam);
      } else {
        // Stale URL â€” clean it so a refresh lands on the welcome screen
        history.replaceState({}, document.title, location.pathname);
      }
    }

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
    hookSelect($("fontFamily"), applyFontFamily);
    hookSelect($("fontSize"), applyFontSize);

    // Colors (hidden native inputs kept for compatibility â€” Slides-style
    // dropdown lists below drive them)
    if ($("textColor")) $("textColor").addEventListener("input", function (e) { applyTextColor(e.target.value); });
    if ($("hiliteColor")) $("hiliteColor").addEventListener("input", function (e) { applyHiliteColor(e.target.value); });

    /* ---------------- Slides-style ms-dropdowns (portal-based) ----------------
       Ported from slides.js: menus are appended to <body> while open so they
       escape the ribbon's overflow, with the same open/close animations. */
    var _portalDropdown = null, _portalMenu = null, _portalBtn = null;

    function closePortalDropdown(animate) {
      if (!_portalMenu) return;
      var menu = _portalMenu, dropdown = _portalDropdown, btn = _portalBtn;
      _portalMenu = null; _portalDropdown = null; _portalBtn = null;
      if (dropdown) dropdown.classList.remove("active");
      if (btn) btn.setAttribute("aria-expanded", "false");

      var done = false;
      var cleanup = function () {
        if (done) return;
        done = true;
        menu.removeEventListener("animationend", cleanup);
        menu.classList.remove("ms-portal-closing");
        menu.style.cssText = "";
        if (dropdown) dropdown.appendChild(menu);
      };
      if (animate === false) {
        cleanup();
      } else {
        menu.classList.add("ms-portal-closing");
        menu.addEventListener("animationend", cleanup);
        setTimeout(cleanup, 220);
      }
    }

    function openPortalDropdown(dropdown, btn, menu) {
      closePortalDropdown(false);
      document.body.appendChild(menu);
      _portalMenu = menu;
      _portalDropdown = dropdown;
      _portalBtn = btn;
      dropdown.classList.add("active");
      btn.setAttribute("aria-expanded", "true");

      var isColorList = menu.classList && menu.classList.contains("color-list-menu");
      var isColorGrid = menu.classList && menu.classList.contains("color-grid-menu");
      var cap = isColorList ? 240 : (isColorGrid ? 320 : 320);
      var maxH = Math.min(cap, window.innerHeight * 0.6);
      // First, measure invisibly
      menu.style.cssText = "position:fixed;visibility:hidden;display:block;z-index:999999;margin:0;max-height:" + maxH + "px;overflow-y:auto;";
      var btnRect = btn.getBoundingClientRect();
      var mW = menu.offsetWidth || 200;
      var mH = menu.offsetHeight || 280;
      var vW = window.innerWidth;
      var vH = window.innerHeight;
      var top = btnRect.bottom + 4;
      if (top + mH > vH - 8) top = btnRect.top - mH - 4;
      if (top < 8) top = btnRect.bottom + 4;
      var left = btnRect.left;
      if (left + mW > vW - 8) left = vW - mW - 8;
      if (left < 8) left = 8;
      menu.style.cssText = "position:fixed;display:block;visibility:visible;z-index:999999;margin:0;left:" + left + "px;top:" + top + "px;max-height:" + maxH + "px;overflow-y:auto;animation:dropdownFadeIn 0.18s ease;";
    }

    function storeEditorSelectionFromContext() {
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
    }

    // Generic portal dropdown open/close for every .ms-dropdown in the ribbon
    var msDropdowns = document.querySelectorAll(".ms-dropdown");
    for (var d = 0; d < msDropdowns.length; d++) {
      (function (dropdown) {
        var btn = dropdown.querySelector(":scope > .ms-dropdown-btn, :scope > button.ribbon-btn.ms-dropdown-btn");
        var menu = dropdown.querySelector(":scope > .ms-dropdown-menu");
        if (!btn || !menu) return;

        btn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-haspopup", "listbox");

        btn.addEventListener("mousedown", function (e) {
          // Same selection preservation hookSelect used for native selects
          storeEditorSelectionFromContext();
        });

        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (_portalDropdown === dropdown) {
            closePortalDropdown();
            return;
          }
          openPortalDropdown(dropdown, btn, menu);
        });

        btn.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            btn.click();
          } else if (e.key === "Escape") {
            closePortalDropdown();
          }
        });
      })(msDropdowns[d]);
    }

    // Close portal on outside click
    document.addEventListener("mousedown", function (e) {
      if (_portalMenu &&
        !_portalMenu.contains(e.target) &&
        _portalBtn && !_portalBtn.contains(e.target)) {
        closePortalDropdown();
      }
    });

    // Close portal on scroll or resize â€” but NOT when scrolling inside the menu itself
    window.addEventListener("scroll", function (e) {
      if (_portalMenu && (e.target === _portalMenu || _portalMenu.contains(e.target))) return;
      closePortalDropdown();
    }, true);
    window.addEventListener("resize", function () { closePortalDropdown(); });

    // Helper: pick an item, keep the hidden native select in sync (so state
    // sync and legacy change handlers keep working), update the label
    function wireSelectDropdown(dropdownId, selectId) {
      var dropdown = $(dropdownId);
      var select = $(selectId);
      if (!dropdown || !select) return;

      var items = dropdown.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var i = 0; i < items.length; i++) {
        (function (item) {
          item.addEventListener("click", function () {
            var val = item.getAttribute("data-value");
            var label = item.getAttribute("data-label") || item.textContent;
            if (select) {
              // Only pick values the native select understands; if absent,
              // extend the select so change handlers receive the right value.
              var known = false;
              for (var o = 0; o < select.options.length; o++) {
                if (select.options[o].value === val) { known = true; break; }
              }
              if (!known) {
                var opt = document.createElement("option");
                opt.value = val;
                opt.textContent = label;
                select.appendChild(opt);
              }
              select.value = val;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
              var lbl = dropdown.querySelector(".dropdown-value");
              if (lbl) lbl.textContent = label;
            }
            dropdown.classList.remove("active");
            closePortalDropdown();
          });
        })(items[i]);
      }

      // Keep the button label in sync whenever the select changes (user pick,
      // updateToolbarStatesâ€¦)
      select.addEventListener("change", function () {
        var lbl = dropdown.querySelector(".dropdown-value");
        if (!lbl) return;
        var chosen = dropdown.querySelector('.ms-dropdown-item[data-value="' + select.value + '"]');
        if (chosen) {
          lbl.textContent = chosen.getAttribute("data-label") || chosen.textContent;
        } else {
          // Fallback: mirror the selected <option> text
          var optSel = select.options[select.selectedIndex];
          if (optSel) lbl.textContent = optSel.textContent;
        }
      });

      // Initial label sync (directly from current select value)
      var lbl0 = dropdown.querySelector(".dropdown-value");
      if (lbl0) {
        var chosen0 = dropdown.querySelector('.ms-dropdown-item[data-value="' + select.value + '"]');
        if (chosen0) lbl0.textContent = chosen0.getAttribute("data-label") || chosen0.textContent;
        else { var o0 = select.options[select.selectedIndex]; if (o0) lbl0.textContent = o0.textContent; }
      }
    }

    wireSelectDropdown("fontFamilyDropdown", "fontFamily");
    wireSelectDropdown("fontSizeDropdown", "fontSize");

    // Font color â€” vertical list (same behavior as Slides)
    var fontColorDd = $("fontColorDropdown");
    if (fontColorDd) {
      var fcItems = fontColorDd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var f = 0; f < fcItems.length; f++) {
        (function (item) {
          item.addEventListener("click", function () {
            var color = item.getAttribute("data-value");
            var btn = fontColorDd.querySelector(".ms-dropdown-btn");
            var swatch = btn ? btn.querySelector(".color-preview") : null;
            var label = btn ? btn.querySelector(".dropdown-value") : null;
            if (swatch) {
              swatch.style.background = color === "transparent" ? "transparent" : color;
              swatch.style.border = (color === "transparent") ? "1px solid #ccc" : "";
            }
            if (label) label.textContent = item.getAttribute("data-label") || "Text";
            applyTextColor(color === "transparent" ? "#000000" : color);
            fontColorDd.classList.remove("active");
            closePortalDropdown();
          });
        })(fcItems[f]);
      }
    }

    // Highlight color â€” vertical list (same behavior as Slides)
    var hlColorDd = $("highlightColorDropdown");
    if (hlColorDd) {
      var hlItems = hlColorDd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var h = 0; h < hlItems.length; h++) {
        (function (item) {
          item.addEventListener("click", function () {
            var color = item.getAttribute("data-value");
            var btn = hlColorDd.querySelector(".ms-dropdown-btn");
            var swatch = btn ? btn.querySelector(".color-preview") : null;
            var label = btn ? btn.querySelector(".dropdown-value") : null;
            if (swatch) {
              if (color === "transparent") {
                swatch.style.background = "transparent";
                swatch.style.border = "1px solid #ccc";
              } else {
                swatch.style.background = color;
                swatch.style.border = "";
              }
            }
            if (label) label.textContent = item.getAttribute("data-label") || "Highlight";
            applyHiliteColor(color === "transparent" ? "transparent" : color);
            hlColorDd.classList.remove("active");
            closePortalDropdown();
          });
        })(hlItems[h]);
      }
    }

    // Page size (Layout tab) â€” custom dropdown with no native select behind
    // it. The generic .ms-dropdown portal code above handles open/close.
    var psDd = $("pageSizeDropdown");
    if (psDd) {
      var psItems = psDd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var psi = 0; psi < psItems.length; psi++) {
        (function (item) {
          item.addEventListener("click", function () {
            var val = item.getAttribute("data-value");
            setPageSize(val);
            var lbl = psDd.querySelector(".dropdown-value");
            if (lbl) lbl.textContent = val;
            psDd.classList.remove("active");
            closePortalDropdown();
          });
        })(psItems[psi]);
      }
      syncPageSizeUI();
    }

    var bClear = $("btnClearFormat");
    if (bClear) {
      bClear.addEventListener("mousedown", function (e) { e.preventDefault(); });
      bClear.addEventListener("click", clearFormatting);
    }

    // Styles group â€” Title / Heading 1-3 / Normal (formatBlock; feeds TOC + outline)
    var styleBtns = document.querySelectorAll("#stylesGroup .style-btn");
    for (var sb = 0; sb < styleBtns.length; sb++) {
      (function (btn) {
        btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
        btn.addEventListener("click", function () {
          if (!currentDocId) { toast("Open a document first", "error"); return; }
          applyBlock(btn.getAttribute("data-block"));
          schedulePaginate();
          scheduleAutosave();
          toast("Style applied: " + btn.textContent.trim(), "success");
        });
      })(styleBtns[sb]);
    }

    // Menubar / topbar actions (guarded â€” elements may have moved to ribbon)
    if ($("btnNew")) $("btnNew").addEventListener("click", newDocument);
    if ($("btnFind")) $("btnFind").addEventListener("click", openFind);
    if ($("btnFind2")) $("btnFind2").addEventListener("click", openFind);
    if ($("btnSave")) $("btnSave").addEventListener("click", function () { saveDocument(true); });
    if ($("btnVersions")) { $("btnVersions").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnVersions").addEventListener("click", showVersions); }
    if ($("btnUndo")) { $("btnUndo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnUndo").addEventListener("click", function () { exec("undo"); }); }
    if ($("btnRedo")) { $("btnRedo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnRedo").addEventListener("click", function () { exec("redo"); }); }
    // Theme / color theme / dark paper buttons have been removed from the UI.
    // (No click handlers to wire up â€” cyan is locked via CSS.)
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

    // Ribbon tabs â€” switching with sliding indicator + blur/fade panel transition
    initRibbonTabs();

    // Export dropdown (guarded â€” may not exist if moved)
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
    $("btnImage").addEventListener("click", openImagePicker);
    var imgInput = $("insertImageInput");
    if (imgInput) imgInput.addEventListener("change", handleImageFileSelect);
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
    // (The old #wordCount span in the ribbon-tabs-right has been replaced by
    // the Print button â€” the live word counter is gone from the ribbon.
    // Word count is still available via Review â†’ Word Count.)
    if ($("btnPrint")) {
      $("btnPrint").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnPrint").addEventListener("click", function () {
        // Save first, then open the browser print dialog. togglePrintPreview
        // is not used here because the user clicked Print directly â€” they
        // want the OS print dialog, not the in-app preview bar.
        printDocument();
      });
    }
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

    // EmeraldSuite: Docs â€” new feature wiring
    // Templates
    if ($("btnTemplates")) $("btnTemplates").addEventListener("click", function () { buildTemplates(); openModal("templatesModal"); });

    // Symbols (Slides-style floating bottom bar â€” toggle, insert at caret)
    $("btnSymbols").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnSymbols").addEventListener("click", function () { toggleSymbolBar(); });
    initSymbolBar();

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

    // Drop Cap
    $("btnDropCap").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnDropCap").addEventListener("click", toggleDropCap);

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

    // Orientation & Page Size (size is a dropdown now â€” it is wired with
    // the other ms-dropdowns above)
    $("btnOrientation").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnOrientation").addEventListener("click", toggleOrientation);

    // Header / Footer / Page Number
    $("btnHeader").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnHeader").addEventListener("click", function () { editHeaderFooter("header"); });
    $("btnFooter").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnFooter").addEventListener("click", function () { editHeaderFooter("footer"); });
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

    // Read Aloud
    $("btnReadAloud").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnReadAloud").addEventListener("click", readAloud);

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

    // â”€â”€ FILE MODAL (opened from the File ribbon tab) â”€â”€
    // Close X button + backdrop click
    if ($("fileModalCloseXBtn")) $("fileModalCloseXBtn").addEventListener("click", closeFileModal);
    $("fileModal").addEventListener("click", function (e) {
      if (e.target === $("fileModal")) closeFileModal();
    });
    // Actions
    if ($("fileSaveBtn")) $("fileSaveBtn").addEventListener("click", function () {
      commitFileModalRename();
      saveDocument(true);
      syncFileModalNameInput();
    });
    if ($("fileDeleteBtn")) $("fileDeleteBtn").addEventListener("click", function () {
      var wasCurrent = currentDocId;
      closeFileModal();
      if (wasCurrent) confirmDeleteCurrentDoc();
    });
    if ($("fileCloseBtn")) $("fileCloseBtn").addEventListener("click", function () {
      closeFileModal();
      closeDocument();
    });
    // Export (Docs-supported formats)
    if ($("fileExportTxtBtn")) $("fileExportTxtBtn").addEventListener("click", function () { closeFileModal(); exportDocument("txt"); });
    if ($("fileExportHtmlBtn")) $("fileExportHtmlBtn").addEventListener("click", function () { closeFileModal(); exportDocument("html"); });
    if ($("fileExportPrintBtn")) $("fileExportPrintBtn").addEventListener("click", function () { closeFileModal(); exportDocument("print"); });
    // Tools (Docs-specific)
    if ($("fileStatsBtn")) $("fileStatsBtn").addEventListener("click", showWordCount);
    if ($("fileVersionsBtn")) $("fileVersionsBtn").addEventListener("click", showVersions);
    if ($("fileInspectorBtn")) $("fileInspectorBtn").addEventListener("click", runDocumentInspector);
    // Rename input: Enter commits + closes; typing renames live
    var nameInput = $("fileModalNameInput");
    if (nameInput) {
      nameInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); e.target.blur(); closeFileModal(); }
      });
      nameInput.addEventListener("input", function () {
        if (!currentDocId) return;
        currentTitle = nameInput.value.trim() || "Untitled Document";
        scheduleAutosave();
      });
    }

    // â”€â”€ WELCOME SCREEN (home) â”€â”€
    if ($("welcomeNewBtn")) $("welcomeNewBtn").addEventListener("click", createNewDocument);
    if ($("welcomeImportBtn")) $("welcomeImportBtn").addEventListener("click", function () { $("fileImportInput").click(); });
    var importInput = $("fileImportInput");
    if (importInput) importInput.addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      importDocumentFromFile(file);
      e.target.value = "";
    });

    // â”€â”€ DELETE DOCUMENT CONFIRMATION (Slides/Notes-style) â”€â”€
    if ($("deleteDocConfirm")) $("deleteDocConfirm").addEventListener("click", function () {
      var target = _deleteTargetId;
      // Animate the dialog out first, then delete once it's gone (Slides pattern)
      closeDeleteDocModal();
      if (target) setTimeout(function () { deleteDocument(target); }, 250);
    });
    if ($("deleteDocCancel")) $("deleteDocCancel").addEventListener("click", closeDeleteDocModal);
    var delModal = $("deleteDocModal");
    if (delModal) delModal.addEventListener("click", function (e) {
      if (e.target === delModal) closeDeleteDocModal();
    });

    // â”€â”€ FOOTNOTE / ENDNOTE / CITATION MODALS â”€â”€
    if ($("footnoteInsert")) $("footnoteInsert").addEventListener("click", function () {
      var note = ($("footnoteText").value || "").trim();
      if (!note) { toast("Enter footnote text", "error"); return; }
      closeModal("footnoteModal");
      performInsertFootnote(note);
    });
    if ($("endnoteInsert")) $("endnoteInsert").addEventListener("click", function () {
      var note = ($("endnoteText").value || "").trim();
      if (!note) { toast("Enter endnote text", "error"); return; }
      closeModal("endnoteModal");
      performInsertEndnote(note);
    });
    if ($("citeInsert")) $("citeInsert").addEventListener("click", function () {
      var cite = ($("citeText").value || "").trim();
      if (!cite) { toast("Enter citation text", "error"); return; }
      closeModal("citeModal");
      performInsertCite(cite);
    });
    // Ctrl/âŒ˜+Enter inside the textarea = Insert; plain Enter in the cite input = Insert
    [["footnoteText", "footnoteInsert"], ["endnoteText", "endnoteInsert"]].forEach(function (pair) {
      var ta = $(pair[0]);
      if (ta) ta.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $(pair[1]).click(); }
      });
    });
    var citeInput = $("citeText");
    if (citeInput) citeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("citeInsert").click(); }
    });

    // References panel buttons
    if ($("btnTocRef")) { $("btnTocRef").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnTocRef").addEventListener("click", insertTOC); }
    if ($("btnFootnote")) { $("btnFootnote").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnFootnote").addEventListener("click", openFootnoteModal); }
    if ($("btnEndnote")) { $("btnEndnote").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnEndnote").addEventListener("click", openEndnoteModal); }
    if ($("btnCitation")) { $("btnCitation").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnCitation").addEventListener("click", openCiteModal); }
    if ($("btnBibliography")) { $("btnBibliography").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnBibliography").addEventListener("click", function () { document.execCommand("insertHTML", false, '<h2>Bibliography</h2><p>Entry 1. Author, Title, Publisher, Year.</p>'); toast("Bibliography inserted", "success"); schedulePaginate(); }); }
    if ($("btnIndexEntry")) { $("btnIndexEntry").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnIndexEntry").addEventListener("click", function () { var sel = window.getSelection(); if (sel && !sel.isCollapsed) { toast("Index entry marked: " + sel.toString(), "success"); } else { toast("Select text first to mark an index entry", "error"); } }); }
    if ($("btnInsertIndex")) { $("btnInsertIndex").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnInsertIndex").addEventListener("click", function () { document.execCommand("insertHTML", false, '<h2>Index</h2><p>Term, Page</p>'); toast("Index inserted", "success"); schedulePaginate(); }); }

    // Session timer (click to reset) â€” element removed in Slides-style bar; guard.
    var stBtn = $("sessionTimer");
    if (stBtn) {
      stBtn.addEventListener("click", function () {
        if (sessionActive) {
          if (window.confirm("Reset the writing session timer?")) resetSessionTimer();
        }
      });
    }

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

    // Table dialog
    $("tableConfirm").addEventListener("click", insertTable);
    buildTableGrid();

    // Zoom (Slides-style buttons â€” the old slider was removed)
    $("zoomFitBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomFitBtn").addEventListener("click", zoomFitToWindow);
    $("zoom100Btn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoom100Btn").addEventListener("click", function () { setZoom(100); });
    $("zoomInBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomInBtn").addEventListener("click", function () { adjustZoom(10); });
    $("zoomOutBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomOutBtn").addEventListener("click", function () { adjustZoom(-10); });

    // Page navigation buttons removed from status bar (no more â€¹ â€º buttons).

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
    // Ctrl+Shift+V â†’ clipboard history
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        openClipboardHistory();
      }
      // Escape â†’ close the File modal or delete dialog if open
      if (e.key === "Escape") {
        if (fileModalOpen()) { e.preventDefault(); closeFileModal(); return; }
        var delModalOpen = $("deleteDocModal");
        if (delModalOpen && delModalOpen.classList.contains("show")) {
          e.preventDefault();
          closeDeleteDocModal();
          return;
        }
      }
      // ? â†’ shortcut overlay (document-level so it works even if focus is elsewhere)
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
    loadFindHistory();
    // Color theme loading is a no-op now (cyan is locked via CSS).
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

    setTimeout(function () {
      // Only auto-focus the editor when a document is actually open â€”
      // on the welcome screen the user may be about to click a card.
      if (!currentDocId) return;
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

      if (change.key === DOC_INDEX_KEY) {
        // Another tab changed the document index (created/deleted/renamed a
        // document) â€” refresh the welcome screen cards if it is visible.
        loadIndex().then(function () {
          if (!currentDocId) renderWelcomeCards();
        });
      } else if (currentDocId && change.key === docDataKey(currentDocId)) {
        // Another tab changed the open document â€” reload it softly (only if
        // this tab is not actively being edited, to avoid clobbering the caret).
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
      }
    });
  }

  // Reload document content from storage WITHOUT stealing focus. Called when
  // another tab saved the open document. Saves our own in-flight caret to restore.
  async function reloadFromStorageQuietly() {
    try {
      if (!currentDocId) return;
      var data = null;
      if (window.EmeraldIDBStorage) data = await window.EmeraldIDBStorage.getJSON(docDataKey(currentDocId));
      if (!data) return;
      var sel = window.getSelection();
      var hadFocus = document.activeElement && document.activeElement.closest && document.activeElement.closest(".page-content");
      var caretInfo = hadFocus && sel && sel.rangeCount ? saveCaretSnapshot() : null;

      currentTitle = data.title || currentTitle;
      syncFileModalNameInput();
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
      headerActive = hfHasContent(data.header);
      headerHTML = headerActive ? data.header : "";
      footerActive = hfHasContent(data.footer);
      footerHTML = footerActive ? data.footer : "";
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
     EmeraldSuite: Docs â€” Feature additions
     (cover pages, equations, smartart, screenshot, draw mode,
      spellcheck, footnotes, table of figures, compare,
      real track changes, threaded comments)
     ========================================================= */

  /* ---------------- State ---------------- */
  var footnotes = [];
  var endnotes = [];
  var drawCanvas = null;
  var drawCtx = null;
  var isDrawing = false;
  var drawMode = false;
  var drawPoints = [];
  var drawColor = "#000000";
  var drawWidth = 2;
  var drawTool = "pen";
  var coverPageStyle = "classic";
  var pendingInternalTarget = null;

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    $("coverTitle").value = currentTitle || "Document Title";
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
    html += '</div><p><br></p><div class="zdocs-page-break" contenteditable="false"><span class="pb-label">â€” Page Break â€”</span></div><p><br></p>';
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
    // convert cm â†’ px (1cm â‰ˆ 37.8px at 96dpi)
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
          // break is later in the page â€” apply to next pages
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
    // \binom{n}{k} â†’ (n choose k) rendered as stacked fraction in parens
    out = out.replace(/\\binom\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '(<span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;padding:0 2px">' + a + '</span><span style="display:block;border-top:1px solid currentColor;padding:0 2px">' + b + '</span></span>)';
    });
    // \sqrt{x}
    out = out.replace(/\\sqrt\{([^{}]*)\}/g, function (m, a) {
      return '<span style="white-space:nowrap">âˆš<span style="border-top:1px solid currentColor;padding:0 2px">' + a + '</span></span>';
    });
    // \sum_{i=1}^{n}  (with optional braces)
    out = out.replace(/\\sum_\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, lo, hi) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:1.4em">âˆ‘<span style="display:block;font-size:0.5em">' + lo + '..' + hi + '</span></span>';
    });
    out = out.replace(/\\sum/g, "âˆ‘");
    // \prod_{i=1}^{n}
    out = out.replace(/\\prod_\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, lo, hi) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:1.4em">âˆ<span style="display:block;font-size:0.5em">' + lo + '..' + hi + '</span></span>';
    });
    out = out.replace(/\\prod/g, "âˆ");
    // \int_a^b
    out = out.replace(/\\int_\{?([^{}]*?)\}?\^\{?([^{}]*?)\}?/g, function (m, lo, hi) {
      return '<span style="font-size:1.4em">âˆ«</span><sub>' + lo + '</sub><sup>' + hi + '</sup>';
    });
    out = out.replace(/\\int/g, "âˆ«");
    // \lim_{x \to 0}
    out = out.replace(/\\lim_\{([^{}]*)\}/g, function (m, sub) {
      return 'lim<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:0.7em"><span style="display:block">' + sub.replace(/\\to/g, "â†’") + '</span></span>';
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
    // \to â†’
    out = out.replace(/\\to/g, "â†’");
    // \pm
    out = out.replace(/\\pm/g, "Â±");
    out = out.replace(/\\mp/g, "âˆ“");
    out = out.replace(/\\times/g, "Ã—");
    out = out.replace(/\\div/g, "Ã·");
    out = out.replace(/\\cdot/g, "Â·");
    out = out.replace(/\\leq/g, "â‰¤");
    out = out.replace(/\\geq/g, "â‰¥");
    out = out.replace(/\\neq/g, "â‰ ");
    out = out.replace(/\\approx/g, "â‰ˆ");
    out = out.replace(/\\infty/g, "âˆž");
    out = out.replace(/\\partial/g, "âˆ‚");
    out = out.replace(/\\nabla/g, "âˆ‡");
    out = out.replace(/\\forall/g, "âˆ€");
    out = out.replace(/\\exists/g, "âˆƒ");
    out = out.replace(/\\in/g, "âˆˆ");
    out = out.replace(/\\notin/g, "âˆ‰");
    out = out.replace(/\\subset/g, "âŠ‚");
    out = out.replace(/\\supset/g, "âŠƒ");
    out = out.replace(/\\cup/g, "âˆª");
    out = out.replace(/\\cap/g, "âˆ©");
    out = out.replace(/\\emptyset/g, "âˆ…");
    out = out.replace(/\\rightarrow/g, "â†’");
    out = out.replace(/\\leftarrow/g, "â†");
    out = out.replace(/\\Rightarrow/g, "â‡’");
    out = out.replace(/\\Leftarrow/g, "â‡");
    out = out.replace(/\\leftrightarrow/g, "â†”");
    // Greek letters
    out = out.replace(/\\alpha/g, "Î±");
    out = out.replace(/\\beta/g, "Î²");
    out = out.replace(/\\gamma/g, "Î³");
    out = out.replace(/\\delta/g, "Î´");
    out = out.replace(/\\epsilon/g, "Îµ");
    out = out.replace(/\\varepsilon/g, "Îµ");
    out = out.replace(/\\zeta/g, "Î¶");
    out = out.replace(/\\eta/g, "Î·");
    out = out.replace(/\\theta/g, "Î¸");
    out = out.replace(/\\iota/g, "Î¹");
    out = out.replace(/\\kappa/g, "Îº");
    out = out.replace(/\\lambda/g, "Î»");
    out = out.replace(/\\mu/g, "Î¼");
    out = out.replace(/\\nu/g, "Î½");
    out = out.replace(/\\xi/g, "Î¾");
    out = out.replace(/\\pi/g, "Ï€");
    out = out.replace(/\\rho/g, "Ï");
    out = out.replace(/\\sigma/g, "Ïƒ");
    out = out.replace(/\\tau/g, "Ï„");
    out = out.replace(/\\upsilon/g, "Ï…");
    out = out.replace(/\\phi/g, "Ï†");
    out = out.replace(/\\chi/g, "Ï‡");
    out = out.replace(/\\psi/g, "Ïˆ");
    out = out.replace(/\\omega/g, "Ï‰");
    out = out.replace(/\\Gamma/g, "Î“");
    out = out.replace(/\\Delta/g, "Î”");
    out = out.replace(/\\Theta/g, "Î˜");
    out = out.replace(/\\Lambda/g, "Î›");
    out = out.replace(/\\Pi/g, "Î ");
    out = out.replace(/\\Sigma/g, "Î£");
    out = out.replace(/\\Phi/g, "Î¦");
    out = out.replace(/\\Psi/g, "Î¨");
    out = out.replace(/\\Omega/g, "Î©");
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

  /* ---------------- SmartArt ---------------- */
  var SMARTART_TEMPLATES = [
    {
      id: "flow3",
      name: "Flow (3 steps)",
      desc: "Linear process, left-to-right",
      preview: '<div class="sa-mini"><span class="sa-m-node">Start</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">Mid</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">End</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">Start</span><span class="sa-arrow">â†’</span><span class="sa-node">Process</span><span class="sa-arrow">â†’</span><span class="sa-node">End</span></div><p><br></p>'
    },
    {
      id: "flow5",
      name: "Process (5 steps)",
      desc: "Detailed sequential workflow",
      preview: '<div class="sa-mini"><span class="sa-m-node">1</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">2</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">3</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">4</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">5</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">1</span><span class="sa-arrow">â†’</span><span class="sa-node">2</span><span class="sa-arrow">â†’</span><span class="sa-node">3</span><span class="sa-arrow">â†’</span><span class="sa-node">4</span><span class="sa-arrow">â†’</span><span class="sa-node">5</span></div><p><br></p>'
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
      preview: '<div class="sa-mini cycle"><span class="sa-m-node">Plan</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">Do</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">Check</span><span class="sa-m-arrow">â†’</span><span class="sa-m-node">Act</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">Plan</span><span class="sa-arrow">â†’</span><span class="sa-node">Do</span><span class="sa-arrow">â†’</span><span class="sa-node">Check</span><span class="sa-arrow">â†’</span><span class="sa-node">Act</span><span class="sa-arrow">â†»</span></div><p><br></p>'
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
      // Bring the focus back to this Docs tab. When the user captured a
      // different app/window the OS focus usually stays on that app after
      // the native picker closes â€” browsers cannot fully "steal" focus
      // back, but window.focus() restores it whenever the browser allows
      // (same-window contexts), and the toast confirms the capture landed.
      try { window.focus(); } catch (_) {}
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

  /* ---------------- Draw mode (Slides/Notes-style drawing toolbar) ----------------
     Ported from the Slides/Notes apps: a bottom-docked toolbar with Pen,
     Highlighter and Eraser tools, color presets, size presets, and
     Clear/Done buttons. Strokes are drawn on a canvas overlaying the
     document scroll area. The canvas STAYS in the DOM after Done so the
     drawing remains visible on the page (like Slides persists per-slide
     drawings); re-entering draw mode continues on top of it. */
  function toggleDrawMode(force) {
    var toolbar = $("drawToolbar");
    var app = $("app");
    var btn = $("btnDraw");
    var shouldOpen = force === undefined ? !drawMode : force;
    drawMode = shouldOpen;
    if (shouldOpen) {
      // Only one bottom toolbar at a time â€” close the symbol bar if open.
      toggleSymbolBar(false);
      app.classList.add("draw-mode");
      toolbar.classList.add("visible");
      ensureDrawCanvas();
      if (btn) btn.classList.add("active");
      // No "on" toast â€” the toolbar appearing IS the signal (user request);
      // only the "Draw mode off." toast below is shown, on Done/Exit.
    } else {
      app.classList.remove("draw-mode");
      toolbar.classList.remove("visible");
      // Canvas stays visible (pointer-events off) so the drawing persists.
      if (drawCanvas) drawCanvas.style.pointerEvents = "none";
      if (btn) btn.classList.remove("active");
      toast("Draw mode off.");
    }
  }

  function ensureDrawCanvas() {
    var scroll = $("documentScroll");
    if (!drawCanvas) {
      drawCanvas = document.createElement("canvas");
      drawCanvas.className = "draw-canvas";
      drawCanvas.id = "drawCanvas";
      scroll.style.position = "relative";
      scroll.appendChild(drawCanvas);
      drawCtx = drawCanvas.getContext("2d");
      drawCtx.lineCap = "round";
      drawCtx.lineJoin = "round";
      drawCtx.imageSmoothingEnabled = true;
      drawCtx.imageSmoothingQuality = "high";
      drawCanvas.addEventListener("mousedown", function (e) { drawStart(e); });
      drawCanvas.addEventListener("mousemove", function (e) { drawLine(e); });
      window.addEventListener("mouseup", function () { drawEnd(); });
      drawCanvas.addEventListener("touchstart", function (e) { e.preventDefault(); drawStart(e.touches[0]); }, { passive: false });
      drawCanvas.addEventListener("touchmove", function (e) { if (isDrawing) e.preventDefault(); drawLine(e.touches[0]); }, { passive: false });
      drawCanvas.addEventListener("touchend", function () { drawEnd(); });
    }
    // Size the canvas to the full scrollable document area.
    // NOTE: assigning canvas.width/height CLEARS the bitmap â€” only resize
    // when the dimensions actually changed, and carry the strokes over.
    requestAnimationFrame(function () {
      var w = scroll.scrollWidth;
      var h = Math.max(scroll.scrollHeight, scroll.clientHeight);
      if (drawCanvas.width !== w || drawCanvas.height !== h) {
        var snapshot = null;
        try { if (drawCanvas.width > 0 && drawCanvas.height > 0) snapshot = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height); } catch (_) {}
        drawCanvas.width = w;
        drawCanvas.height = h;
        drawCanvas.style.width = w + "px";
        drawCanvas.style.height = h + "px";
        // Resizing also resets context state â€” restore it.
        drawCtx.lineCap = "round";
        drawCtx.lineJoin = "round";
        if (snapshot) {
          try { drawCtx.putImageData(snapshot, 0, 0); } catch (_) {}
        }
      }
    });
    drawCanvas.style.pointerEvents = "all";
    drawCanvas.style.display = "block";
  }

  function clearDrawing() {
    // Silent clear â€” the canvas visibly emptying is its own feedback
    // (user request: no "Drawing cleared" toast).
    if (drawCtx && drawCanvas) drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  }

  function drawPos(e) {
    var rect = drawCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function drawStart(e) {
    if (!drawMode || !drawCtx) return;
    isDrawing = true;
    var p = drawPos(e);
    drawPoints = [{ x: p.x, y: p.y }];
    var tool = drawTool;
    if (tool === "eraser") {
      drawCtx.globalCompositeOperation = "destination-out";
      drawCtx.lineWidth = (drawWidth || 2) * 5;
      drawCtx.strokeStyle = "#000";
      drawCtx.fillStyle = "#000";
      drawCtx.globalAlpha = 1;
    } else if (tool === "highlighter") {
      drawCtx.globalCompositeOperation = "source-over";
      drawCtx.strokeStyle = drawColor;
      drawCtx.fillStyle = drawColor;
      drawCtx.lineWidth = (drawWidth || 2) * 2.5;
      drawCtx.globalAlpha = 0.4; // translucent, like a real highlighter
    } else {
      drawCtx.globalCompositeOperation = "source-over";
      drawCtx.strokeStyle = drawColor;
      drawCtx.fillStyle = drawColor;
      drawCtx.lineWidth = drawWidth || 2;
      drawCtx.globalAlpha = 1;
    }
    // Dot for single-click strokes
    drawCtx.beginPath();
    drawCtx.arc(p.x, p.y, Math.max(0.5, drawCtx.lineWidth / 2), 0, Math.PI * 2);
    drawCtx.fill();
    drawCtx.beginPath();
    drawCtx.moveTo(p.x, p.y);
    if (e.cancelable && e.preventDefault) e.preventDefault();
  }

  function drawLine(e) {
    if (!drawMode || !isDrawing || !drawCtx) return;
    var p = drawPos(e);
    drawPoints.push({ x: p.x, y: p.y });
    var pts = drawPoints;
    // Quadratic-curve smoothing through midpoints (Slides-style natural strokes)
    if (pts.length >= 3) {
      var p0 = pts[pts.length - 3];
      var p1 = pts[pts.length - 2];
      var p2 = pts[pts.length - 1];
      var mid1x = (p0.x + p1.x) / 2, mid1y = (p0.y + p1.y) / 2;
      var mid2x = (p1.x + p2.x) / 2, mid2y = (p1.y + p2.y) / 2;
      drawCtx.beginPath();
      drawCtx.moveTo(mid1x, mid1y);
      drawCtx.quadraticCurveTo(p1.x, p1.y, mid2x, mid2y);
      drawCtx.stroke();
    } else if (pts.length === 2) {
      drawCtx.beginPath();
      drawCtx.moveTo(pts[0].x, pts[0].y);
      drawCtx.lineTo(pts[1].x, pts[1].y);
      drawCtx.stroke();
    }
    if (e.cancelable && e.preventDefault) e.preventDefault();
  }

  function drawEnd() {
    if (!isDrawing) return;
    isDrawing = false;
    if (drawCtx) drawCtx.globalAlpha = 1;
    // Final segment so the stroke doesn't stop mid-curve.
    var pts = drawPoints;
    if (pts.length >= 2 && drawCtx) {
      var p1 = pts[pts.length - 2], p2 = pts[pts.length - 1];
      var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      drawCtx.beginPath();
      drawCtx.moveTo(mx, my);
      drawCtx.lineTo(p2.x, p2.y);
      drawCtx.stroke();
    }
    drawPoints = [];
  }

  function initDrawToolbar() {
    var penBtn = $("drawPenBtn");
    var highlighterBtn = $("drawHighlighterBtn");
    var eraserBtn = $("drawEraserBtn");
    var colorSection = document.querySelector(".draw-color-section");
    var colorDivider = colorSection ? colorSection.previousElementSibling : null;
    var setTool = function (tool) {
      drawTool = tool;
      [penBtn, highlighterBtn, eraserBtn].forEach(function (b) { if (b) b.classList.remove("active"); });
      if (tool === "pen" && penBtn) penBtn.classList.add("active");
      if (tool === "highlighter" && highlighterBtn) highlighterBtn.classList.add("active");
      if (tool === "eraser" && eraserBtn) eraserBtn.classList.add("active");
      // Hide the color section while the eraser is active (nothing to color).
      var hideColor = (tool === "eraser");
      if (colorSection) colorSection.classList.toggle("eraser-hidden", hideColor);
      if (colorDivider && colorDivider.classList.contains("color-divider")) colorDivider.classList.toggle("eraser-hidden", hideColor);
      if (drawCanvas) drawCanvas.classList.toggle("eraser-active", tool === "eraser");
    };
    if (penBtn) penBtn.addEventListener("click", function () { setTool("pen"); });
    if (highlighterBtn) highlighterBtn.addEventListener("click", function () { setTool("highlighter"); });
    if (eraserBtn) eraserBtn.addEventListener("click", function () { setTool("eraser"); });

    // Color presets
    var colorPresets = $("drawColorPresets");
    if (colorPresets) {
      colorPresets.addEventListener("click", function (e) {
        var sw = e.target.closest(".draw-color-swatch");
        if (!sw) return;
        drawColor = sw.getAttribute("data-color");
        var swatches = colorPresets.querySelectorAll(".draw-color-swatch");
        for (var i = 0; i < swatches.length; i++) swatches[i].classList.remove("active");
        sw.classList.add("active");
        var picker = $("drawColorPicker");
        if (picker) picker.value = drawColor;
      });
      // Custom color (white swatch opens the native color picker)
      var whiteSwatch = colorPresets.querySelector('.draw-color-swatch[data-color="#ffffff"]');
      if (whiteSwatch) {
        whiteSwatch.addEventListener("click", function () {
          var picker = $("drawColorPicker");
          if (picker) picker.click();
        });
      }
    }
    var colorPicker = $("drawColorPicker");
    if (colorPicker) {
      colorPicker.addEventListener("input", function () {
        drawColor = colorPicker.value;
        var colorPresets2 = $("drawColorPresets");
        if (colorPresets2) {
          var swatches = colorPresets2.querySelectorAll(".draw-color-swatch");
          for (var k = 0; k < swatches.length; k++) swatches[k].classList.remove("active");
        }
      });
    }

    // Size presets
    var toolbar = $("drawToolbar");
    if (toolbar) {
      toolbar.addEventListener("click", function (e) {
        var sizeBtn = e.target.closest(".draw-size-btn");
        if (!sizeBtn) return;
        drawWidth = parseInt(sizeBtn.getAttribute("data-size"), 10) || 2;
        var sizeBtns = toolbar.querySelectorAll(".draw-size-btn");
        for (var s = 0; s < sizeBtns.length; s++) sizeBtns[s].classList.remove("active");
        sizeBtn.classList.add("active");
        var slider = $("drawThickness");
        if (slider) slider.value = drawWidth;
      });
    }

    // Clear / Done
    var clearBtn = $("drawClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearDrawing);
    var doneBtn = $("drawDoneBtn");
    if (doneBtn) doneBtn.addEventListener("click", function () { toggleDrawMode(false); });

    // Ribbon button
    var bDraw = $("btnDraw");
    if (bDraw) {
      bDraw.addEventListener("mousedown", function (e) { e.preventDefault(); });
      bDraw.addEventListener("click", function () { toggleDrawMode(); });
    }
  }

  /* ---------------- Spellcheck ---------------- */
  /* ---------------- Footnotes & Endnotes (proper) ---------------- */
  function openFootnoteModal() {
    var t = $("footnoteText");
    if (t) t.value = "";
    openModal("footnoteModal");
    setTimeout(function () { if (t) t.focus(); }, 60);
  }

  function performInsertFootnote(note) {
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
    renumberFootnoteRefs();
    schedulePaginate();
    scheduleAutosave();
    toggleFootnotes(true);
    toast("Footnote " + num + " inserted", "success");
  }

  function openEndnoteModal() {
    var t = $("endnoteText");
    if (t) t.value = "";
    openModal("endnoteModal");
    setTimeout(function () { if (t) t.focus(); }, 60);
  }

  function performInsertEndnote(note) {
    var num = endnotes.length + 1;
    var refId = "en_ref_" + num + "_" + Date.now().toString(36);
    restoreEditorSelection();
    var sel = window.getSelection();
    if (!sel || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      var fc = getContent(getPages()[0]); if (fc) fc.focus();
    }
    document.execCommand("insertHTML", false, '<sup class="endnote-ref" data-en="' + num + '" id="' + refId + '" contenteditable="false">' + num + '</sup> ');
    endnotes.push({ num: num, text: note, refId: refId, ts: Date.now() });
    saveEndnotes();
    renderFootnotes();
    renderEndnotesSection();
    schedulePaginate();
    scheduleAutosave();
    toggleFootnotes(true);
    toast("Endnote " + num + " inserted", "success");
  }

  function saveEndnotes() {
    try {
      if (idbAvailable()) idb.setJSON("zdocs.endnotes", endnotes);
      else localStorage.setItem("zdocs.endnotes", JSON.stringify(endnotes));
    } catch (e) {}
  }

  /* ---------------- Citation (modal) ---------------- */
  function openCiteModal() {
    var t = $("citeText");
    if (t) t.value = "";
    openModal("citeModal");
    setTimeout(function () { if (t) t.focus(); }, 60);
  }

  function performInsertCite(text) {
    restoreEditorSelection();
    var sel = window.getSelection();
    if (!sel || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      var fc = getContent(getPages()[0]); if (fc) fc.focus();
    }
    document.execCommand("insertHTML", false, '<span class="citation">(' + escapeHtml(text) + ')</span>');
    schedulePaginate();
    scheduleAutosave();
    toast("Citation inserted", "success");
  }

  function loadEndnotes() {
    try {
      var f = null;
      if (idbAvailable()) f = idb.getJSONSync("zdocs.endnotes");
      if (!f) { var raw = localStorage.getItem("zdocs.endnotes"); if (raw) f = JSON.parse(raw); }
      if (Array.isArray(f)) endnotes = f;
    } catch (e) {}
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
    if (footnotes.length === 0 && endnotes.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No footnotes or endnotes yet. Use References â†’ Footnote / Endnote to add one.";
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
        del.textContent = "Ã—";
        del.title = "Delete footnote";
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          footnotes.splice(idx, 1);
          // remove the superscript ref from the text, then renumber the rest
          var refEl = document.getElementById(fn.refId);
          if (refEl && refEl.parentNode) refEl.parentNode.removeChild(refEl);
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

    // Endnotes â€” listed below footnotes in the same panel
    if (endnotes.length > 0) {
      var enHead = document.createElement("p");
      enHead.className = "outline-empty";
      enHead.style.fontWeight = "700";
      enHead.style.textTransform = "uppercase";
      enHead.style.fontSize = "10px";
      enHead.style.letterSpacing = "0.06em";
      enHead.style.margin = "10px 0 2px";
      enHead.textContent = "Endnotes";
      body.appendChild(enHead);
      for (var e2 = 0; e2 < endnotes.length; e2++) {
        (function (en, idx) {
          var item = document.createElement("div");
          item.className = "fn-item";
          var numEl = document.createElement("span");
          numEl.className = "fn-num";
          numEl.textContent = en.num;
          var txt = document.createElement("span");
          txt.style.marginLeft = "6px";
          txt.textContent = en.text;
          var del = document.createElement("button");
          del.className = "fn-del";
          del.textContent = "Ã—";
          del.title = "Delete endnote";
          del.addEventListener("click", function (e) {
            e.stopPropagation();
            endnotes.splice(idx, 1);
            // remove the superscript ref from the text, then renumber the rest
            var refEl = document.getElementById(en.refId);
            if (refEl && refEl.parentNode) refEl.parentNode.removeChild(refEl);
            for (var k = 0; k < endnotes.length; k++) endnotes[k].num = k + 1;
            saveEndnotes();
            renderFootnotes();
            renderEndnotesSection();
            renumberEndnoteRefs();
            schedulePaginate();
            scheduleAutosave();
          });
          item.appendChild(numEl);
          item.appendChild(txt);
          item.appendChild(del);
          item.addEventListener("click", function () {
            var el = document.getElementById(en.refId);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
          });
          body.appendChild(item);
        })(endnotes[e2], e2);
      }
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

  /* ---------------- Endnotes (collected at end of document) ---------------- */
  function renderEndnotesSection() {
    // Remove any existing end-of-document endnotes section
    var existing = document.querySelectorAll(".endnotes-section");
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].parentElement) existing[i].parentElement.removeChild(existing[i]);
    }
    if (endnotes.length === 0) return;
    var pages = getPages();
    var lastPage = pages[pages.length - 1];
    if (!lastPage) return;
    var content = getContent(lastPage);
    var section = document.createElement("div");
    section.className = "endnotes-section";
    var heading = document.createElement("p");
    heading.style.fontWeight = "700";
    heading.style.fontSize = "11px";
    heading.style.textTransform = "uppercase";
    heading.style.letterSpacing = "0.06em";
    heading.style.color = "var(--text-faint)";
    heading.textContent = "Endnotes";
    section.appendChild(heading);
    for (var f = 0; f < endnotes.length; f++) {
      var entry = document.createElement("div");
      entry.className = "fn-entry";
      entry.innerHTML = '<span class="fn-key">' + endnotes[f].num + '.</span> ' + escapeHtml(endnotes[f].text);
      section.appendChild(entry);
    }
    content.appendChild(section);
  }

  function renumberEndnoteRefs() {
    var refs = document.querySelectorAll("sup.endnote-ref[data-en]");
    for (var i = 0; i < refs.length; i++) {
      var n = i + 1;
      refs[i].setAttribute("data-en", n);
      refs[i].textContent = n;
    }
  }

  /* ---------------- Table of Figures â€” removed (feature cut) ---------------- */

  /* ---------------- Real track changes ---------------- */
  function setupTrackChangesInterceptor() {
    var pagesWrap = $(PAGES_WRAPPER_ID);
    if (!pagesWrap) return;
    // Use keydown for character insertion â€” preventDefault on keydown is
    // reliably honored by browsers (unlike beforeinput insertText).
    pagesWrap.addEventListener("keydown", function (e) {
      if (!trackChangesOn) return;
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
      // Enter â€” track as insertion of a paragraph break
      if (key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        insertTrackedNode("ins", "Â¶");
        return;
      }
      // Backspace / Delete with a non-collapsed selection â†’ wrap in <del>
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
      if (!trackChangesOn) return;
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
  // manipulation â€” bypasses execCommand/styleWithCSS which would otherwise
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

    // Click handler for internal links + footnote refs (delegated)
    var scrollEl = $("documentScroll");
    if (scrollEl) {
      scrollEl.addEventListener("click", handleInternalLinkClick);
      // External links: Ctrl/Cmd+click opens in a NEW TAB (links inside a
      // contenteditable never navigate on their own â€” without this handler
      // Ctrl+click did nothing at all).
      scrollEl.addEventListener("click", function (e) {
        var a = e.target.closest("a");
        if (!a) return;
        // Internal links / bookmarks / TOC anchors are handled by their own
        // delegated handlers above â€” skip them here.
        if (a.classList.contains("zdocs-internal-link") || a.classList.contains("zdocs-bookmark")) return;
        if (a.closest(".zdocs-toc")) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          var href = a.getAttribute("href");
          if (href && href !== "#" && href.indexOf("javascript:") !== 0) {
            // normalizeExternalUrl fixes links stored without a scheme
            // (e.g. href="youtube.com") so they open https://youtube.com
            // instead of a path under this app's origin.
            window.open(normalizeExternalUrl(href), "_blank", "noopener");
          }
        } else {
          // Plain click keeps the caret for editing (no navigation).
          e.preventDefault();
        }
      });
      // Page-break markers: click to remove (cancel the break).
      scrollEl.addEventListener("click", function (e) {
        var pb = e.target.closest(".zdocs-page-break");
        if (!pb) return;
        e.preventDefault();
        if (pb.parentElement) {
          // Remove the marker; the empty <p> that followed a manual page
          // break is left alone â€” the paginator prunes trailing empties.
          pb.parentElement.removeChild(pb);
          schedulePaginate();
          scheduleAutosave();
          scheduleOutlineUpdate();
          toast("Page break removed", "success");
        }
      });
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

    // Section break (Insert tab only â€” the Layout tab's Breaks group was removed)
    var bSB = $("btnSectionBreak");
    if (bSB) { bSB.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSB.addEventListener("click", insertSectionBreak); }
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

    // SmartArt
    var bSA = $("btnSmartArt");
    if (bSA) { bSA.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSA.addEventListener("click", openSmartArtDialog); }

    // Screenshot
    var bSS = $("btnScreenshot");
    if (bSS) { bSS.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSS.addEventListener("click", takeScreenshot); }

    // Draw mode (Slides/Notes-style toolbar)
    initDrawToolbar();

    // Footnotes
    var bFn = $("btnFootnote");
    if (bFn) { bFn.addEventListener("mousedown", function (e) { e.preventDefault(); }); bFn.addEventListener("click", openFootnoteModal); }
    var bFnPanel = $("footnoteAddFromPanel");
    if (bFnPanel) bFnPanel.addEventListener("click", openFootnoteModal);
    var bEnPanel = $("endnoteAddFromPanel");
    if (bEnPanel) bEnPanel.addEventListener("click", openEndnoteModal);
    var bFnClose = $("footnotesClose");
    if (bFnClose) bFnClose.addEventListener("click", function () { toggleFootnotes(false); });

    // setup track changes interceptor
    setupTrackChangesInterceptor();

    // Round 2 features
    initRound2Features();

    // Escape closes side panels
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (shortcutOverlay && shortcutOverlay.classList.contains("open")) { shortcutOverlay.classList.remove("open"); return; }
        var fp = $("footnotesPanel"); if (fp && fp.classList.contains("open")) { toggleFootnotes(false); return; }
      }
    });
  }

  /* =========================================================
     Round 2 â€” new features
     (mail merge,
      accessibility checker, document inspector,
      status-bar zoom)
     ========================================================= */

  /* ---------------- Status bar zoom + language ---------------- */
  function initStatusBarControls() {
    // The zoom % label is NOT clickable â€” it's a plain informational span,
    // exactly like Slides' #zoomStatus. Zoom is changed ONLY via Ctrl+Scroll
    // (or the View â†’ Zoom ribbon controls / keyboard shortcuts).

    // Ctrl + Scroll to zoom in / out â€” matches the Slides editor behavior.
    // Slides uses an 8% multiplicative step (factor 1.08) rather than a fixed
    // Â±10% additive step â€” this feels smoother at high zoom levels.
    // Listens on the document scroll area first so we can stopPropagation()
    // before the document-level handler double-fires.
    var scrollEl = $("documentScroll");
    if (scrollEl) {
      scrollEl.addEventListener("wheel", function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();
        // deltaY > 0 = scroll down = zoom out; < 0 = zoom in.
        var delta = e.deltaY > 0 ? -1 : 1;
        var factor = 1 + (delta * 0.08); // 8% zoom step (same as Slides)
        zoomByFactor(factor);
      }, { passive: false });
    }
    // Also handle Ctrl+Scroll anywhere in the app (e.g. over the ribbon) so
    // the user isn't surprised when they scroll over the wrong area.
    document.addEventListener("wheel", function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Don't hijack scrolling inside a modal or scrollable panel.
      var target = e.target;
      if (target && target.closest && target.closest(".modal-overlay, .outline-panel, .thumbnails-panel, .comments-panel, .footnotes-panel")) return;
      e.preventDefault();
      var delta = e.deltaY > 0 ? -1 : 1;
      var factor = 1 + (delta * 0.08);
      zoomByFactor(factor);
    }, { passive: false });

    var psLabel = $("pageSizeLabel");
    if (psLabel) {
      // Informational only â€” no click handler. Page size is changed via
      // Layout -> Size (the ms-dropdown drives setPageSize).
    }
  }

  // Additive zoom step (Zoom In / Zoom Out buttons + Ctrl+= / Ctrl+- keys).
  // Keeps the Â±10 step, since that's what users expect.
  function adjustZoom(delta) {
    setZoom(currentZoom + delta);
  }

  // Multiplicative zoom step (used by Ctrl+Scroll).
  // Matches Slides' factor-based zoom: factor 1.08 = zoom in 8%, 0.9259 = out 8%.
  function zoomByFactor(factor) {
    setZoom(Math.round(currentZoom * factor));
  }

  // Base (un-zoomed) page size. CSS `zoom` inflates offsetWidth and
  // getBoundingClientRect, so the authored inline size is read instead â€”
  // falling back to the A4 default that .page gets from the stylesheet.
  function getBasePageSize() {
    var page = getPages()[0];
    if (page) {
      var w = parseFloat(page.style.width);
      var h = parseFloat(page.style.height);
      if (!isNaN(w) && w > 0 && !isNaN(h) && h > 0) return { w: w, h: h };
    }
    return { w: PAGE_WIDTH, h: PAGE_HEIGHT };
  }

  // Layout -> Zoom -> Fit To Window: scale the page so its width fits the
  // visible scroll area (minus padding, scrollbar and a small margin).
  function zoomFitToWindow() {
    var scrollEl = $("documentScroll");
    var base = getBasePageSize().w;
    var avail = (scrollEl ? scrollEl.clientWidth : window.innerWidth) - 80;
    if (avail < 100) avail = 100;
    var fit = Math.floor((avail / base) * 100);
    setZoom(fit);
    toast("Fit to window Â· " + currentZoom + "%", "success");
  }

  function updateStatusZoom(v) {
    var pct = $("statusZoomPct");
    if (pct) pct.textContent = v + "%";
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

      // Contrast check â€” scan elements with inline color/background-color
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
        icon.innerHTML = issue.severity === "error" ? "&times;" : issue.severity === "warning" ? "!" : "&#10003;";
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
    var personalInfo = currentTitle || "Untitled";
    var lastSaved = lastSavedAt;

    items.push({ name: "Document title", count: personalInfo, removable: true, action: function () { currentTitle = "Untitled Document"; syncFileModalNameInput(); scheduleAutosave(); toast("Title cleared", "success"); } });
    items.push({ name: "Comments", count: commentsCount + (commentsCount === 1 ? " comment" : " comments"), removable: commentsCount > 0, action: function () { comments = []; renderComments(); scheduleAutosave(); toast("Comments removed", "success"); } });
    items.push({ name: "Tracked changes (insertions)", count: trackedIns + " ins", removable: trackedIns > 0, action: function () { var all = document.querySelectorAll(".page-content ins.zdocs-ins"); for (var i = 0; i < all.length; i++) unwrapNode(all[i]); schedulePaginate(); scheduleAutosave(); toast("Insertions accepted", "success"); } });
    items.push({ name: "Tracked changes (deletions)", count: trackedDel + " del", removable: trackedDel > 0, action: function () { var all = document.querySelectorAll(".page-content del.zdocs-del"); for (var i = 0; i < all.length; i++) { var p = all[i].parentNode; if (p) p.removeChild(all[i]); } schedulePaginate(); scheduleAutosave(); toast("Deletions removed", "success"); } });
    items.push({ name: "Bookmarks", count: hiddenBookmarks + (hiddenBookmarks === 1 ? " bookmark" : " bookmarks"), removable: hiddenBookmarks > 0, action: function () { var all = document.querySelectorAll(".page-content a.zdocs-bookmark"); for (var i = 0; i < all.length; i++) { var p = all[i].parentNode; if (p) p.removeChild(all[i]); } schedulePaginate(); scheduleAutosave(); toast("Bookmarks removed", "success"); } });
    items.push({ name: "Footnotes & endnotes", count: fnCount + (fnCount === 1 ? " footnote" : " footnotes"), removable: fnCount > 0 || endnotes.length > 0, action: function () { var refs = document.querySelectorAll(".page-content sup.footnote-ref, .page-content sup.endnote-ref"); for (var i = 0; i < refs.length; i++) { var p = refs[i].parentNode; if (p) p.removeChild(refs[i]); } footnotes = []; endnotes = []; saveFootnotes(); saveEndnotes(); renderFootnotes(); renderFootnotesSection(); renderEndnotesSection(); schedulePaginate(); scheduleAutosave(); toast("Footnotes removed", "success"); } });
    items.push({ name: "Last saved", count: lastSaved ? formatTime(lastSaved) : "never", removable: false });
    items.push({ name: "Page count", count: pages.length + (pages.length === 1 ? " page" : " pages"), removable: false });

    for (var i = 0; i < items.length; i++) {
      (function (it) {
        var item = document.createElement("div");
        item.className = "inspector-item" + (it.removable ? "" : " empty");
        var icon = document.createElement("span");
        icon.className = "inspector-item-icon";
        icon.innerHTML = "â—";
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

  /* ---------------- Wire up round 2 features ---------------- */
  function initRound2Features() {
    initStatusBarControls();


    // Accessibility checker
    var bA11y = $("btnAccessibilityCheck");
    if (bA11y) { bA11y.addEventListener("mousedown", function (e) { e.preventDefault(); }); bA11y.addEventListener("click", runAccessibilityCheck); }

    // Document inspector
    var bIns = $("btnInspector");
    if (bIns) { bIns.addEventListener("mousedown", function (e) { e.preventDefault(); }); bIns.addEventListener("click", runDocumentInspector); }
    var bInsRm = $("inspectorRemoveAll");
    if (bInsRm) bInsRm.addEventListener("click", inspectorRemoveAll);

    // Round 3: editor context menu + section break wiring done in initNewFeatures
    initEditorContextMenu();
    initRound4Features();

    // Round 11: periodic relative autosave time update
    setInterval(function () { updateRelativeAutosave(); }, 10000);
  }

  /* =========================================================
     Round 4 â€” tooltips, live merge preview, word count live
     ========================================================= */

  /* ---------------- Rich tooltips ---------------- */
  var richTip = null;
  var richTipTimer = null;
  function initTooltips() {
    if (richTip) return;
    richTip = document.createElement("div");
    richTip.className = "rich-tip";
    document.body.appendChild(richTip);
    // Attach to all ribbon buttons, topbar actions, status bar items
    var selectors = ".ribbon-btn, .topbar-action, .ribbon-tab, .statbar-toggle, .session-timer, .toolbar-stats";
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
    // Custom rich tooltips removed (Slides parity) â€” buttons keep their
    // native title= tooltips.

    // Round 6: ripple effect + table cell right-click
    initRippleEffect();
    initTableContextMenu();
  }

  /* ---------------- Button ripple effect ---------------- */
  function initRippleEffect() {
    // Slides parity: no ripple on ribbon buttons â€” keep it for other chrome buttons only
    var btns = document.querySelectorAll(".topbar-action, .btn");
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
