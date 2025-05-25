
document.addEventListener('DOMContentLoaded', () => {
  const animatedSections = document.querySelectorAll('.animate-on-scroll:not(.no-animation)');

  if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.intersectionRatio > 0.6) {
            entry.target.classList.add('visible');
          } else if (entry.intersectionRatio === 0) {
            entry.target.classList.remove('visible');
          }
        });
      }, {
        threshold: [0, 0.6]
      });
      animatedSections.forEach(section => {
          observer.observe(section);
      });
  } else {
      animatedSections.forEach(section => {
          section.classList.add('visible');
      });
  }

  // Smooth scrolling for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function (e) {
          const hrefValue = this.getAttribute('href');
          // Ensure hrefValue is not null, is longer than just "#", and actually starts with "#"
          if (hrefValue && hrefValue.length > 1 && hrefValue.startsWith('#')) {
              try {
                  const targetElement = document.querySelector(hrefValue);
                  if (targetElement) {
                      e.preventDefault(); // Prevent default jump only if we are handling the scroll
                      targetElement.scrollIntoView({
                          behavior: 'smooth'
                      });
                      history.pushState(null, null, hrefValue); // <-- Add this line
                  }
                  // If targetElement is null (ID not found), default browser behavior will occur.
              } catch (error) {
                  // Log error if querySelector fails for some malformed href (e.g., "#invalid-char!")
                  console.error("Failed to process smooth scroll for selector:", hrefValue, error);
              }
          }
          // For href="#" (like logo links), or if hrefValue is not a valid ID selector,
          // let default browser behavior occur (e.g., scroll to top or navigate).
      });
  });

    const currentYearSpan = document.getElementById('current-year');
    if (currentYearSpan) {
        currentYearSpan.textContent = new Date().getFullYear().toString();
    }
});