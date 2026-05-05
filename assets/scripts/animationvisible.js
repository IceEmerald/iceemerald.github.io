document.addEventListener('DOMContentLoaded', () => {
  const BLOCK_TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P']);
  const ALL_TEXT_TAGS   = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN']);
  const originalHTML       = new WeakMap();
  const splitState         = new WeakMap();
  const managedByContainer = new WeakSet();
  function isTextEl(el)     { return ALL_TEXT_TAGS.has(el.tagName); }
  function isGradient(el)   { return el.style.webkitTextFillColor === 'transparent'; }
  function hasChildEls(el)  { return Array.from(el.childNodes).some(n => n.nodeType === 1); }
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
  function findTextKids(container) {
    const result = [];
    function walk(node) {
      for (const child of node.children) {
        if (child.classList.contains('no-animation')) continue;
        if (BLOCK_TEXT_TAGS.has(child.tagName)) {
          result.push(child);            
        } else if (!child.classList.contains('animate-on-scroll')) {
          walk(child);                   
        }
      }
    }
    walk(container);
    return result;
  }
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
  const allEls = Array.from(document.querySelectorAll('.animate-on-scroll:not(.no-animation)'));
  const containerKids = new WeakMap(); 
  allEls.forEach(el => {
    if (!isTextEl(el)) {
      const kids = findTextKids(el);
      if (kids.length > 0) {
        containerKids.set(el, kids);
        kids.forEach(kid => {
          managedByContainer.add(kid);
          if (isGradient(kid)) initWhole(kid); 
        });
      } else {
        initBlock(el);
      }
    } else {
      if (isGradient(el)) initWhole(el);
    }
  });
  const toObserve = allEls.filter(el => !managedByContainer.has(el));
  function onEnter(el) {
    if (isTextEl(el)) {
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
  const yearEl = document.getElementById('current-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
});