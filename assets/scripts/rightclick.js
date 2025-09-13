const contextMenu = document.getElementById("custom-context-menu");
const toast = document.getElementById("custom-toast");
let clickedElement = null;
let selectedText = "";

window.addEventListener("contextmenu", function (e) {
  e.preventDefault();
  clickedElement = e.target;

  // Capture selected text when right-click is triggered
  const sel = window.getSelection();
  selectedText = sel ? sel.toString().trim() : "";

  contextMenu.style.top = `${e.pageY}px`;
  contextMenu.style.left = `${e.pageX}px`;
  contextMenu.style.display = "block";
});

window.addEventListener("click", () => {
  contextMenu.style.display = "none";
});

let toastTimer; // Global timer reference

function showToast(message) {
  const toast = document.getElementById("custom-toast");
  toast.innerHTML = message;
  toast.classList.add("show");

  // Clear previous timer
  clearTimeout(toastTimer);

  // Start new 5-second timer
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 5000);
}

function copyPageLink() {
  navigator.clipboard.writeText(location.href);
  showToast("📎 Page link copied!");
}

function truncate(str, maxLength = 100) {
  return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
}

function copyTextContent() {
  if (selectedText) {
    navigator.clipboard.writeText(selectedText);

    const preview = truncate(selectedText.trim(), 100);
    showToast(`📋 Copied: "${preview}"`);
  } else {
    showToast("⚠️ No text selected.");
  }
}

function showElementInfo() {
  if (!clickedElement) {
    showToast("⚠️ No element selected.");
    return;
  }

  const tag = clickedElement.tagName;
  const id = clickedElement.id ? `#${truncate(clickedElement.id, 100)}` : null;
  const classList = clickedElement.className
    ? clickedElement.className
        .split(" ")
        .filter(cls => cls)
        .map(cls => `.${truncate(cls, 100)}`)
        .join(" ")
    : null;

  const rawText = clickedElement.textContent || "";
  const cleanText = rawText.trim().replace(/\s+/g, " ");
  const text = cleanText ? `“${truncate(cleanText, 100)}”` : null;

  const attributes = {
    href: truncate(clickedElement.getAttribute("href") || "", 100),
    src: truncate(clickedElement.getAttribute("src") || "", 100),
    alt: truncate(clickedElement.getAttribute("alt") || "", 100),
    title: truncate(clickedElement.getAttribute("title") || "", 100),
    placeholder: truncate(clickedElement.getAttribute("placeholder") || "", 100),
    value: truncate(clickedElement.getAttribute("value") || "", 100),
    role: truncate(clickedElement.getAttribute("role") || "", 100),
    name: truncate(clickedElement.getAttribute("name") || "", 100),
    for: truncate(clickedElement.getAttribute("for") || "", 100),
    label: clickedElement.labels
      ? truncate(Array.from(clickedElement.labels).map(label => label.textContent.trim()).join(", "), 100)
      : null,
    ariaLabel: truncate(clickedElement.getAttribute("aria-label") || "", 100)
  };

  const dataset = Object.entries(clickedElement.dataset || {})
    .map(([k, v]) => `data-${k}="${truncate(v, 100)}"`)
    .join(", ");
  const truncatedDataset = dataset ? truncate(dataset, 100) : null;

  const rect = clickedElement.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const size = (width && height) ? `${width}×${height}px` : null;

  const childIndex = Array.from(clickedElement.parentNode?.children || []).indexOf(clickedElement);
  const inlineStyle = truncate(clickedElement.getAttribute("style") || "", 100);

  const infoLines = [
    `🔖 <strong>Tag:</strong> ${tag}`,
    id ? `🆔 <strong>ID:</strong> ${id}` : null,
    classList ? `🎨 <strong>Class:</strong> ${classList}` : null,
    text ? `📝 <strong>Text:</strong> ${text}` : null,
    attributes.href ? `🔗 <strong>Href:</strong> ${attributes.href}` : null,
    attributes.src ? `🖼️ <strong>Src:</strong> ${attributes.src}` : null,
    attributes.alt ? `🖼️ <strong>Alt:</strong> ${attributes.alt}` : null,
    attributes.title ? `💡 <strong>Title:</strong> ${attributes.title}` : null,
    attributes.placeholder ? `✏️ <strong>Placeholder:</strong> ${attributes.placeholder}` : null,
    attributes.value ? `💾 <strong>Value:</strong> ${attributes.value}` : null,
    attributes.name ? `🔤 <strong>Name:</strong> ${attributes.name}` : null,
    attributes.for ? `🔁 <strong>For:</strong> ${attributes.for}` : null,
    attributes.label ? `🏷️ <strong>Labels:</strong> ${attributes.label}` : null,
    attributes.ariaLabel ? `♿ <strong>ARIA Label:</strong> ${attributes.ariaLabel}` : null,
    attributes.role ? `🧩 <strong>Role:</strong> ${attributes.role}` : null,
    truncatedDataset ? `📦 <strong>Data Attributes:</strong> ${truncatedDataset}` : null,
    size ? `📏 <strong>Size:</strong> ${size}` : null,
    `🧭 <strong>Child Index:</strong> ${childIndex}`,
    inlineStyle ? `🎨 <strong>Inline Style:</strong> ${inlineStyle}` : null
  ].filter(Boolean); // remove null entries

  showToast(infoLines.join("<br>"));
}



