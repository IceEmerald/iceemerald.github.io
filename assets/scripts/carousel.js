window.addEventListener('load', function () {
    var wrapper   = document.querySelector('.news-carousel-wrapper');
    var track     = document.getElementById('newsCarouselTrack');
    var prevBtn   = document.getElementById('newsPrev');
    var nextBtn   = document.getElementById('newsNext');
    var counterEl = document.getElementById('newsCounter');
    if (!track || !prevBtn || !nextBtn) return;

    var currentIndex  = 0;
    var gap           = 16;
    var carouselReady = false;

    var DESKTOP_VISIBLE = 3;
    var CARD_WIDTH = 336;

    function isMobile() {
        return window.innerWidth <= 768;
    }

    function getVisibleCount() {
        return isMobile() ? 1 : DESKTOP_VISIBLE;
    }

    function getItemWidth() {
        if (isMobile()) {
            return Math.min(CARD_WIDTH, wrapper.offsetWidth - 32);
        }
        return CARD_WIDTH;
    }

    function getItems() {
        return Array.from(track.querySelectorAll('.news-carousel-item'));
    }

    function maxIndex() {
        return Math.max(0, getItems().length - getVisibleCount());
    }

    function getStartOffset() {
        var iw = getItemWidth();
        if (isMobile()) {
            var wrapperWidth = wrapper.offsetWidth;
            return Math.max(0, Math.floor((wrapperWidth - iw) / 2));
        }
        var pageWidth = window.innerWidth;
        var wrapperLeft = wrapper.getBoundingClientRect().left;
        var totalVisible = DESKTOP_VISIBLE * iw + (DESKTOP_VISIBLE - 1) * gap;
        var targetLeft = (pageWidth - totalVisible) / 2;
        return Math.round(targetLeft - wrapperLeft);
    }

    function updateCounter() {
        if (!counterEl) return;
        var items = getItems();
        if (items.length === 0) { counterEl.textContent = ''; return; }
        var steps = maxIndex() + 1;
        counterEl.textContent = (currentIndex + 1) + ' / ' + steps;
    }

    function applyItemWidths(iw) {
        getItems().forEach(function (item) {
            item.style.width    = iw + 'px';
            item.style.minWidth = iw + 'px';
            item.style.maxWidth = iw + 'px';
        });
    }

    function updateCarousel() {
        var iw          = getItemWidth();
        applyItemWidths(iw);
        var startOffset = getStartOffset();
        var slideOffset = currentIndex * (iw + gap);
        track.style.transform = 'translateX(' + (startOffset - slideOffset) + 'px)';
        prevBtn.disabled = currentIndex === 0;
        nextBtn.disabled = currentIndex >= maxIndex();
        updateCounter();
    }

    function initCarousel() {
        updateCarousel();

        prevBtn.addEventListener('click', function () {
            if (currentIndex > 0) { currentIndex--; updateCarousel(); }
        });
        nextBtn.addEventListener('click', function () {
            if (currentIndex < maxIndex()) { currentIndex++; updateCarousel(); }
        });

        var resizeTimer;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                currentIndex = Math.min(currentIndex, maxIndex());
                updateCarousel();
            }, 80);
        });
    }

    var base = '/assets/images/ui/news/news';

    function addNewsItem(imgSrc) {
        var img       = document.createElement('img');
        img.src       = imgSrc;
        img.className = 'animate-on-scroll hover-zoom hover-img';
        img.alt       = '';

        var item       = document.createElement('div');
        item.className = 'news-carousel-item';
        item.appendChild(img);
        track.insertBefore(item, track.firstChild);

        if (!carouselReady) {
            carouselReady = true;
            initCarousel();
        } else {
            updateCarousel();
        }
    }

    function probeNews(num) {
        var probe     = new Image();
        probe.onload  = function () { addNewsItem(base + num + '.webp'); probeNews(num + 1); };
        probe.onerror = function () {};
        probe.src = base + num + '.webp';
    }

    probeNews(1);
});