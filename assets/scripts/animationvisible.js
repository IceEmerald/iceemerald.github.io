document.addEventListener('DOMContentLoaded', () => {
  const BLOCK_TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P']);
  const ALL_TEXT_TAGS   = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN']);

  const originalHTML       = new WeakMap();
  const splitState         = new WeakMap();
  const managedByContainer = new WeakSet();

  // ── helpers ────────────────────────────────────────────────────────────────

  function isTextEl(el)     { return ALL_TEXT_TAGS.has(el.tagName); }
  function isGradient(el)   { return el.style.webkitTextFillColor === 'transparent'; }
  function hasChildEls(el)  { return Array.from(el.childNodes).some(n => n.nodeType === 1); }

  // ── word-split animation (plain text only) ─────────────────────────────────

  function splitWords(el, baseDelay) {
    if (splitState.get(el) || hasChildEls(el)) return;
    originalHTML.set(el, el.innerHTML);
    const raw = el.textContent;
    el.innerHTML = '';
    let wi = 0;
    raw.split(/(\s+)/).forEach(part => {
      if (/^\s+$/.test(part)) {
        el.appendChild(document.createTextNode(part));
      } else if (part) {
        const s = document.createElement('span');
        s.textContent = part;
        s.className = 'anim-word';
        s.style.transitionDelay = ((baseDelay || 0) + wi * 0.07) + 's';
        el.appendChild(s);
        wi++;
      }
    });
    splitState.set(el, true);
  }

  function showWords(el) {
    requestAnimationFrame(() =>
      el.querySelectorAll('.anim-word').forEach(s => s.classList.add('visible'))
    );
  }

  function restoreText(el) {
    if (!splitState.get(el)) return;
    el.innerHTML = originalHTML.get(el) ?? '';
    splitState.set(el, false);
  }

  // ── whole-element text animation (gradient text) ───────────────────────────

  function initWhole(el) {
    el.style.opacity    = '0';
    el.style.transform  = 'translateY(20px)';
    el.style.filter     = 'blur(5px)';
    el.style.transition = 'opacity 0.45s ease-out, transform 0.45s ease-out, filter 0.45s ease-out';
    el.style.willChange = 'opacity, transform, filter';
  }

  function showWhole(el, delay) {
    el.style.transitionDelay = (delay || 0) + 's';
    requestAnimationFrame(() => {
      el.style.opacity   = '1';
      el.style.transform = 'translateY(0)';
      el.style.filter    = 'blur(0px)';
    });
  }

  function resetWhole(el) {
    el.style.transition      = 'none';
    el.style.transitionDelay = '0s';
    el.style.opacity         = '0';
    el.style.transform       = 'translateY(20px)';
    el.style.filter          = 'blur(5px)';
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.45s ease-out, transform 0.45s ease-out, filter 0.45s ease-out';
    });
  }

  // ── non-text element animation ─────────────────────────────────────────────

  function siblingIdx(el) {
    const parent = el.parentElement;
    if (!parent) return 0;
    const sibs = Array.from(parent.children).filter(c =>
      c.classList.contains('animate-on-scroll') &&
      !c.classList.contains('no-animation') &&
      !isTextEl(c)
    );
    const i = sibs.indexOf(el);
    return i < 0 ? 0 : i;
  }

  function initBlock(el) {
    el.style.opacity    = '0';
    el.style.transform  = 'translateY(30px)';
    el.style.filter     = 'blur(4px)';
    el.style.transition = 'opacity 0.5s ease-out, transform 0.5s ease-out, filter 0.5s ease-out';
    el.style.willChange = 'opacity, transform, filter';
  }

  function showBlock(el) {
    el.style.transitionDelay = (siblingIdx(el) * 0.1) + 's';
    requestAnimationFrame(() => {
      el.style.opacity   = '1';
      el.style.transform = 'translateY(0)';
      el.style.filter    = 'blur(0px)';
    });
  }

  function resetBlock(el) {
    el.style.transition      = 'none';
    el.style.transitionDelay = '0s';
    el.style.opacity         = '0';
    el.style.transform       = 'translateY(30px)';
    el.style.filter          = 'blur(4px)';
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.5s ease-out, transform 0.5s ease-out, filter 0.5s ease-out';
    });
  }

  // ── child text discovery ───────────────────────────────────────────────────
  // Walk a non-text container and collect block-level text descendants.
  // KEY: check BLOCK_TEXT_TAGS FIRST — so h2.animate-on-scroll is still found.
  // Stop recursing into nested non-text animate-on-scroll elements (they own themselves).

  function findTextKids(container) {
    const result = [];
    function walk(node) {
      for (const child of node.children) {
        if (child.classList.contains('no-animation')) continue;
        if (BLOCK_TEXT_TAGS.has(child.tagName)) {
          result.push(child);            // ← include even if it has animate-on-scroll
        } else if (!child.classList.contains('animate-on-scroll')) {
          walk(child);                   // recurse only into non-animated wrappers
        }
      }
    }
    walk(container);
    return result;
  }

  // ── unified animate / reset per text child ─────────────────────────────────

  function animChild(child, delay) {
    if (isGradient(child)) {
      showWhole(child, delay);
    } else {
      splitWords(child, delay);
      delay === 0
        ? showWords(child)
        : setTimeout(() => showWords(child), delay * 1000);
    }
  }

  function resetChild(child) {
    if (isGradient(child)) {
      resetWhole(child);
    } else {
      restoreText(child);
    }
  }

  // ── setup ──────────────────────────────────────────────────────────────────

  const allEls = Array.from(document.querySelectorAll('.animate-on-scroll:not(.no-animation)'));
  const containerKids = new WeakMap(); // non-text el → [text children]

  allEls.forEach(el => {
    if (!isTextEl(el)) {
      const kids = findTextKids(el);
      if (kids.length > 0) {
        containerKids.set(el, kids);
        kids.forEach(kid => {
          managedByContainer.add(kid);
          if (isGradient(kid)) initWhole(kid); // hide gradient text kids early
        });
      } else {
        initBlock(el);
      }
    } else {
      // Direct text element with animate-on-scroll
      if (isGradient(el)) initWhole(el);
      // plain text: starts visible, word-split hides then reveals on entry
    }
  });

  // Only observe elements that aren't already managed by a container
  const toObserve = allEls.filter(el => !managedByContainer.has(el));

  // ── intersection logic ─────────────────────────────────────────────────────

  function onEnter(el) {
    if (isTextEl(el)) {
      // Direct text element
      if (isGradient(el)) {
        showWhole(el, 0);
      } else {
        splitWords(el);
        showWords(el);
      }
    } else {
      const kids = containerKids.get(el);
      if (kids && kids.length > 0) {
        kids.forEach((kid, i) => animChild(kid, i * 0.15));
      } else {
        showBlock(el);
      }
    }
  }

  function onExit(el) {
    if (isTextEl(el)) {
      if (isGradient(el)) resetWhole(el);
      else restoreText(el);
    } else {
      const kids = containerKids.get(el);
      if (kids && kids.length > 0) {
        kids.forEach(kid => resetChild(kid));
      } else {
        resetBlock(el);
      }
    }
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.intersectionRatio > 0.05)    onEnter(entry.target);
        else if (entry.intersectionRatio === 0) onExit(entry.target);
      });
    }, { threshold: [0, 0.05] });

    toObserve.forEach(el => observer.observe(el));
  } else {
    toObserve.forEach(el => setTimeout(() => onEnter(el), 100));
  }

  // ── smooth scroll ──────────────────────────────────────────────────────────

  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (href && href.length > 1 && href.startsWith('#')) {
        try {
          const target = document.querySelector(href);
          if (target) {
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth' });
            history.pushState(null, null, href);
          }
        } catch (err) {
          console.error('Smooth scroll error:', href, err);
        }
      }
    });
  });

  // ── year ───────────────────────────────────────────────────────────────────

  const yearEl = document.getElementById('current-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
});