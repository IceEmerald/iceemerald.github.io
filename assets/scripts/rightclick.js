const contextMenu = document.getElementById("custom-context-menu");
let clickedElement = null;
let selectedText = "";

window.addEventListener("contextmenu", function (e) {
  e.preventDefault();
  clickedElement = e.target;
  const sel = window.getSelection();
  selectedText = sel ? sel.toString().trim() : "";
  if (!contextMenu) return;
  contextMenu.style.top = "-9999px";
  contextMenu.style.left = "-9999px";
  contextMenu.style.display = "block";
  const menuWidth = contextMenu.offsetWidth || 260;
  const menuHeight = contextMenu.offsetHeight || 160;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  let left = e.clientX;
  let top = e.clientY;
  if (left + menuWidth > viewportWidth) left = viewportWidth - menuWidth - 8;
  if (left < 8) left = 8;
  if (top + menuHeight > viewportHeight) top = viewportHeight - menuHeight - 8;
  if (top < 8) top = 8;
  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
});

if (contextMenu) {
  window.addEventListener("click", () => {
    contextMenu.style.display = "none";
  });
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function normalizeToast(content) {
  const items = Array.isArray(content) ? content : [content];
  const toast = document.getElementById("custom-toast");
  if (!toast) return;

  toast.replaceChildren();
  items.forEach((item) => {
    const text = String(item ?? "");
    const wrapper = document.createElement("div");
    wrapper.className = "toast-line";
    wrapper.textContent = text.replace(/<br\s*\/?>/gi, "\n");
    toast.appendChild(wrapper);
  });
}

let toastTimer;
function showToast(message) {
  const toast = document.getElementById("custom-toast");
  if (!toast) return;

  normalizeToast(message);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 5000);
}

const _svgTag = "";
const _svgId = "";
const _svgClass = "";
const _svgText = "";
const _svgLink = "";
const _svgImg = "";
const _svgTitle = "";
const _svgEdit = "";
const _svgFile = "";
const _svgName = "";
const _svgFor = "";
const _svgLabel = "";
const _svgInfo = "";
const _svgRole = "";
const _svgData = "";
const _svgSize = "";
const _svgChild = "";
const _svgStyle = "";
const _svgCopy = "";
const _svgWarn = "";
const _svgPage = "";

function copyPageLink() {
  navigator.clipboard.writeText(location.href);
  showToast("Page link copied!");
}

function truncate(str, maxLength = 100) {
  return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
}

function copyTextContent() {
  if (selectedText) {
    navigator.clipboard.writeText(selectedText);
    const preview = escHtml(truncate(selectedText.trim(), 100));
    showToast(`Copied: "${preview}"`);
  } else {
    showToast("No text selected.");
  }
}

function showElementInfo() {
  if (!clickedElement) {
    showToast("No element selected.");
    return;
  }
  const attr = (name) => clickedElement.getAttribute(name) || "";
  const infoLines = [
    `Tag: ${clickedElement.tagName}`,
    clickedElement.id ? `ID: #${clickedElement.id}` : null,
    clickedElement.className ? `Class: ${clickedElement.className}` : null,
    clickedElement.textContent ? `Text: ${clickedElement.textContent.trim().replace(/\s+/g, " ").slice(0, 100)}` : null,
    attr("href") ? `Href: ${attr("href")}` : null,
    attr("src") ? `Src: ${attr("src")}` : null,
    attr("alt") ? `Alt: ${attr("alt")}` : null,
    attr("title") ? `Title: ${attr("title")}` : null,
    attr("placeholder") ? `Placeholder: ${attr("placeholder")}` : null,
    attr("value") ? `Value: ${attr("value")}` : null,
    attr("name") ? `Name: ${attr("name")}` : null,
    attr("role") ? `Role: ${attr("role")}` : null,
    `Child index: ${Array.from(clickedElement.parentNode?.children || []).indexOf(clickedElement)}`
  ].filter(Boolean);
  showToast(infoLines);
}