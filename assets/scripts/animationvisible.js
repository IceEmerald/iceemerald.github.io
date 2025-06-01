document.addEventListener('DOMContentLoaded', () => {
  const animatedSections = document.querySelectorAll('.animate-on-scroll:not(.no-animation)');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.intersectionRatio > 0.05) {
          setTimeout(() => {
            entry.target.classList.add('visible');
          }, 100); // 0.5 second delay
        } else if (entry.intersectionRatio === 0) {
          entry.target.classList.remove('visible');
        }
      });
    }, {
      threshold: [0, 0.05]
    });

    animatedSections.forEach(section => {
      observer.observe(section);
    });
  } else {
    animatedSections.forEach(section => {
      setTimeout(() => {
        section.classList.add('visible');
      }, 500); // fallback delay
    });
  }

  // Smooth scrolling for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const hrefValue = this.getAttribute('href');
      if (hrefValue && hrefValue.length > 1 && hrefValue.startsWith('#')) {
        try {
          const targetElement = document.querySelector(hrefValue);
          if (targetElement) {
            e.preventDefault();
            targetElement.scrollIntoView({
              behavior: 'smooth'
            });
            history.pushState(null, null, hrefValue);
          }
        } catch (error) {
          console.error("Failed to process smooth scroll for selector:", hrefValue, error);
        }
      }
    });
  });

  const currentYearSpan = document.getElementById('current-year');
  if (currentYearSpan) {
    currentYearSpan.textContent = new Date().getFullYear().toString();
  }
});
