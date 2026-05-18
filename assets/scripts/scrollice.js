 const SENSITIVITY = 0.15; 
 const FRICTION = 0.85;  
 const MIN_VELOCITY = 0.1; 
 let currentScrollY = window.pageYOffset; 
 let velocityY = 0; 
 let isWheeling = false; 
 let animationFrameId = null; 
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
 window.addEventListener('wheel', function(event) {
     if (event.target === document.body || event.target === document.documentElement) {
         event.preventDefault();
     } else {
         return;
     }
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