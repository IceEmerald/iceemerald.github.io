document.addEventListener('DOMContentLoaded', () => {
        const appsLinks = document.querySelectorAll('.aboutice-link');
        const mainEl = document.querySelector('main');
        const appsEl = document.querySelector('.aboutice');
        const allNavLinks = document.querySelectorAll('a[href^="#"]');

          const fadeOut = (el, done) => {
            el.style.transition = 'opacity 0.5s ease';
            el.style.opacity = '0';
            el.addEventListener('transitionend', function handler() {
              el.removeEventListener('transitionend', handler);
              done();
            });
          };

          const fadeIn = (el, done) => {
            el.style.display = 'block';
            el.offsetHeight;
            el.style.transition = 'opacity 0.5s ease';
            el.style.opacity = '1';

            if (done) {
              el.addEventListener('transitionend', function handler() {
                el.removeEventListener('transitionend', handler);
                done();
                window.scrollTo({
                  top: el.getBoundingClientRect().top + window.scrollY - 500,
                });
              });
            }
          };
     appsLinks.forEach(link => {
       link.addEventListener('click', e => {
         e.preventDefault();

         if (appsEl.style.display !== 'block') {
           fadeOut(mainEl, () => {
             mainEl.style.display = 'none';
             fadeIn(appsEl, () => {
               history.pushState(null, '', '#aboutice');
             });
           });
         } else {
           fadeOut(appsEl, () => {
             appsEl.style.display = 'none';
             fadeIn(mainEl);
             history.pushState(null, '', '#');
           });
         }
       });
     });


   allNavLinks.forEach(link => {
     if (!link.classList.contains('aboutice-link')) {
       link.addEventListener('click', () => {
         appsEl.style.display = 'none';
         mainEl.style.display = 'block';
         fadeIn(mainEl);
       });
     }
   });

   window.addEventListener('popstate', () => {
     if (location.hash === '#apps') {
       mainEl.style.display = 'none';
       appsEl.style.display = 'block';
       fadeIn(appsEl);
     } else {
       appsEl.style.display = 'none';
       mainEl.style.display = 'block';
       fadeIn(mainEl);
     }
   });
 });