// --- Configuration ---
 const SENSITIVITY = 0.15; // How much the wheel influences velocity. Higher = more responsive.
 const FRICTION = 0.85;  // How quickly the scroll slows down. Closer to 1 = more "slippery".
 const MIN_VELOCITY = 0.1; // Below this speed, scrolling stops.

 // --- State Variables ---
 let currentScrollY = window.pageYOffset; // Our virtual scroll position
 let velocityY = 0; // Current scroll speed
 let isWheeling = false; // Flag to track if a wheel event is active
 let animationFrameId = null; // To store the requestAnimationFrame ID

 // --- Main Scroll Logic ---
 function smoothScroll() {
     currentScrollY += velocityY;
     velocityY *= FRICTION;

     const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
     currentScrollY = Math.max(0, Math.min(currentScrollY, maxScroll));

     window.scrollTo(0, currentScrollY);

     if (Math.abs(velocityY) > MIN_VELOCITY) {
         animationFrameId = requestAnimationFrame(smoothScroll);
     } else {
         velocityY = 0;
         isWheeling = false;
         animationFrameId = null;
     }
 }

 // --- Event Listener for Mouse Wheel ---
 window.addEventListener('wheel', function(event) {

     event.preventDefault();
     if (!isWheeling || animationFrameId === null) {
          currentScrollY = window.pageYOffset;
     }

     isWheeling = true;

     velocityY += event.deltaY * SENSITIVITY;

     velocityY = Math.max(-150, Math.min(velocityY, 150));

     if (!animationFrameId) {
         animationFrameId = requestAnimationFrame(smoothScroll);
     }
 }, { passive: false });

 window.addEventListener('load', () => {
     currentScrollY = window.pageYOffset;
 });

 window.addEventListener('resize', () => {
     currentScrollY = window.pageYOffset; 
     if (animationFrameId) {
         cancelAnimationFrame(animationFrameId);
         animationFrameId = null;
     }
     velocityY = 0;
     isWheeling = false;
 });