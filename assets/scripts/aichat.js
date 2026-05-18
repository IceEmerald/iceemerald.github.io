'use strict';

/* ---- State ---- */
let conversations = {};
let activeConvId = null;
let isGenerating = false;
let abortController = null;
let pendingFiles = [];
let contextMenuTargetId = null;
let pendingModalCallback = null;

/* ---- DOM ---- */
const sidebar        = document.getElementById('sidebar');
const sidebarToggle  = document.getElementById('sidebar-toggle');
const sidebarOpenBtn = document.getElementById('sidebar-open-btn');
const sidebarNewBtn  = document.getElementById('sidebar-newchat-btn');
const newChatBtn     = document.getElementById('new-chat-btn');
const sidebarChats   = document.getElementById('sidebar-chats');
const welcomeEl      = document.getElementById('aichat-welcome');
const messagesEl     = document.getElementById('aichat-messages');
const chatInput      = document.getElementById('chat-input');
const sendBtn        = document.getElementById('send-btn');
const stopBtn        = document.getElementById('stop-btn');
const fileInput      = document.getElementById('file-input');
const filePreviews   = document.getElementById('file-previews');
const chatCtxMenu    = document.getElementById('chat-context-menu');
const ctxRename      = document.getElementById('ctx-rename');
const ctxDelete      = document.getElementById('ctx-delete');
const toastEl        = document.getElementById('aichat-toast');
/* Modals */
const renameModal    = document.getElementById('rename-modal');
const renameInput    = document.getElementById('rename-input');
const renameSave     = document.getElementById('rename-save');
const renameCancel   = document.getElementById('rename-cancel');
const renameClose    = document.getElementById('rename-close');
const deleteModal    = document.getElementById('delete-modal');
const deleteModalName= document.getElementById('delete-modal-name');
const deleteConfirm  = document.getElementById('delete-confirm');
const deleteCancel   = document.getElementById('delete-cancel');
const clearallModal  = document.getElementById('clearall-modal');
const clearallConfirm= document.getElementById('clearall-confirm');
const clearallCancel = document.getElementById('clearall-cancel');
const dropOverlay    = createDropOverlay();

/* =============================================
   INIT
   ============================================= */
function init() {
  loadFromStorage();
  renderSidebarChats();
  if (activeConvId && conversations[activeConvId]) {
    renderMessages(activeConvId);
    showMessages();
  } else {
    showWelcome();
  }
  bindEvents();
  bindModalEvents();
  autoResizeTextarea();
}

/* =============================================
   STORAGE
   ============================================= */
function loadFromStorage() {
  try {
    const d = localStorage.getItem('emerald_chats');
    if (d) conversations = JSON.parse(d);
    activeConvId = localStorage.getItem('emerald_active_conv') || null;
    if (activeConvId && !conversations[activeConvId]) activeConvId = null;
  } catch { conversations = {}; activeConvId = null; }
}

function saveToStorage() {
  try {
    localStorage.setItem('emerald_chats', JSON.stringify(conversations));
    localStorage.setItem('emerald_active_conv', activeConvId || '');
  } catch(e) { console.warn('Storage error:', e); }
}

/* =============================================
   CONVERSATION MANAGEMENT
   ============================================= */
function createConversation() {
  const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  conversations[id] = { id, name: 'New Chat', messages: [], createdAt: Date.now() };
  activeConvId = id;
  saveToStorage();
  return id;
}

function setActiveConversation(id) {
  activeConvId = id;
  localStorage.setItem('emerald_active_conv', id);
  renderSidebarChats();
  renderMessages(id);
  showMessages();
}

function deleteConversation(id) {
  delete conversations[id];
  if (activeConvId === id) {
    activeConvId = null;
    const ids = Object.keys(conversations).sort((a,b) => (conversations[b]?.createdAt||0) - (conversations[a]?.createdAt||0));
    if (ids.length) activeConvId = ids[0];
  }
  saveToStorage();
  renderSidebarChats();
  if (activeConvId && conversations[activeConvId]) { renderMessages(activeConvId); showMessages(); }
  else showWelcome();
}

function renameConversation(id, name) {
  if (!conversations[id]) return;
  conversations[id].name = name.trim() || 'Chat';
  saveToStorage();
  renderSidebarChats();
}

function autoNameConversation(id, firstMsg) {
  if (!conversations[id] || conversations[id].name !== 'New Chat') return;
  conversations[id].name = firstMsg.slice(0, 42).replace(/\n/g,' ').trim() || 'Chat';
  saveToStorage();
  renderSidebarChats();
}

/* =============================================
   SIDEBAR RENDER
   ============================================= */
function renderSidebarChats() {
  sidebarChats.innerHTML = '';
  const ids = Object.keys(conversations).sort((a,b) => conversations[b].createdAt - conversations[a].createdAt);
  if (!ids.length) {
    sidebarChats.innerHTML = '<div class="sidebar-empty">No chats yet</div>';
    return;
  }
  ids.forEach(id => {
    const conv = conversations[id];
    const item = document.createElement('div');
    item.className = 'sidebar-chat-item' + (id === activeConvId ? ' active' : '');
    item.dataset.id = id;

    const nameEl = document.createElement('div');
    nameEl.className = 'sidebar-chat-name';
    nameEl.textContent = conv.name;

    const timeEl = document.createElement('div');
    timeEl.className = 'sidebar-chat-time';
    timeEl.textContent = relativeTime(conv.createdAt);

    const menuBtn = document.createElement('button');
    menuBtn.className = 'chat-item-menu-btn';
    menuBtn.title = 'Options';
    menuBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>`;

    item.appendChild(nameEl);
    item.appendChild(timeEl);
    item.appendChild(menuBtn);

    item.addEventListener('click', e => {
      if (e.target.closest('.chat-item-menu-btn')) return;
      setActiveConversation(id);
    });
    menuBtn.addEventListener('click', e => { e.stopPropagation(); showChatCtxMenu(e, id); });

    sidebarChats.appendChild(item);
  });
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

/* =============================================
   MESSAGES RENDER
   ============================================= */
function showWelcome() {
  welcomeEl.classList.remove('hidden'); welcomeEl.style.display = 'flex';
  messagesEl.classList.remove('active'); messagesEl.style.display = 'none';
}
function showMessages() {
  welcomeEl.classList.add('hidden'); welcomeEl.style.display = 'none';
  messagesEl.classList.add('active'); messagesEl.style.display = 'block';
}

function renderMessages(convId) {
  messagesEl.innerHTML = '';
  const conv = conversations[convId];
  if (!conv) return;
  conv.messages.forEach((msg, idx) => appendMessageToDOM(msg, idx, convId));
  scrollToBottom();
}

function appendMessageToDOM(msg, idx, convId) {
  messagesEl.appendChild(buildMessageRow(msg, idx, convId));
}

function buildMessageRow(msg, idx, convId) {
  const row = document.createElement('div');
  row.className = 'message-row ' + (msg.role === 'user' ? 'user-row' : 'ai-row');
  row.dataset.idx = idx;
  row.dataset.convId = convId;

  if (msg.role === 'model') {
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar ai-avatar';
    avatar.innerHTML = `<img src="/assets/images/favicon.webp" alt="EmeraldBot" onerror="this.style.display='none'">`;
    row.appendChild(avatar);
  }

  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';

  if (msg.role === 'user' && msg.attachments && msg.attachments.length) {
    const attachRow = document.createElement('div');
    attachRow.className = 'msg-attachments';
    msg.attachments.forEach(att => {
      const chip = document.createElement('div');
      chip.className = 'msg-attachment-chip';
      if (att.mimeType && att.mimeType.startsWith('image/')) {
        chip.innerHTML = '<img src="' + att.dataUrl + '" alt="' + escapeHtml(att.name) + '"><span>' + escapeHtml(att.name) + '</span>';
      } else {
        chip.innerHTML = '<span>' + fileIcon(att.mimeType) + '</span><span>' + escapeHtml(att.name) + '</span>';
      }
      attachRow.appendChild(chip);
    });
    wrap.appendChild(attachRow);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (msg.role === 'user') {
    bubble.textContent = msg.text;
  } else {
    bubble.innerHTML = renderMarkdownWithLatex(msg.text || '');
    attachCopyBtns(bubble);
  }
  wrap.appendChild(bubble);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  if (msg.role === 'user') {
    const editBtn = makeActionBtn('Edit', editIcon());
    editBtn.addEventListener('click', () => { if (!isGenerating) startEditMessage(idx, convId, wrap, bubble); });
    actions.appendChild(editBtn);
    const copyBtn = makeActionBtn('Copy', copyIcon());
    copyBtn.addEventListener('click', () => { copyText(msg.text); showToast('Copied!'); });
    actions.appendChild(copyBtn);
  } else {
    const copyBtn = makeActionBtn('Copy', copyIcon());
    copyBtn.addEventListener('click', () => { copyText(msg.text || ''); showToast('Copied!'); });
    actions.appendChild(copyBtn);
    const regenBtn = makeActionBtn('Regenerate', regenIcon());
    regenBtn.addEventListener('click', () => { if (!isGenerating) regenerateFromIdx(idx, convId); });
    actions.appendChild(regenBtn);
  }

  wrap.appendChild(actions);
  row.appendChild(wrap);
  return row;
}

function makeActionBtn(label, icon) {
  const btn = document.createElement('button');
  btn.className = 'msg-action-btn';
  btn.title = label;
  btn.innerHTML = icon + '<span>' + label + '</span>';
  return btn;
}

/* =============================================
   SEND MESSAGE
   ============================================= */
async function sendMessage(text, files) {
  text = text.trim();
  if (!text && !files.length) return;
  if (isGenerating) return;

  if (!activeConvId || !conversations[activeConvId]) createConversation();
  const convId = activeConvId;
  const conv = conversations[convId];

  const userMsg = {
    role: 'user', text,
    attachments: files.map(f => ({ name: f.name, mimeType: f.type, dataUrl: f.dataUrl })),
    timestamp: Date.now()
  };
  conv.messages.push(userMsg);
  if (conv.messages.filter(m => m.role === 'user').length === 1 && text) autoNameConversation(convId, text);

  saveToStorage();
  renderSidebarChats();
  showMessages();

  appendMessageToDOM(userMsg, conv.messages.length - 1, convId);
  scrollToBottom();

  await generateAIResponse(conv, convId, files);
}

async function generateAIResponse(conv, convId, extraFiles) {
  const aiMsg = { role: 'model', text: '', timestamp: Date.now() };
  conv.messages.push(aiMsg);
  const aiIdx = conv.messages.length - 1;

  const typingRow = buildTypingRow();
  messagesEl.appendChild(typingRow);
  scrollToBottom();
  setGenerating(true);

  let aiRow = null;
  let aiBubble = null;

  try {
    const { apiKey, model, systemInstruction } = await fetchConfig();
    const stream = callGeminiStream(conv.messages.slice(0, -1), extraFiles || [], apiKey, model, systemInstruction);

    typingRow.remove();
    aiRow = buildMessageRow(aiMsg, aiIdx, convId);
    aiBubble = aiRow.querySelector('.msg-bubble');
    aiBubble.innerHTML = '<span class="stream-cursor"></span>';
    messagesEl.appendChild(aiRow);
    scrollToBottom();

    let fullText = '';
    for await (const chunk of stream) {
      if (!isGenerating) break;
      fullText += chunk;
      aiMsg.text = fullText;
      aiBubble.innerHTML = renderMarkdownWithLatex(fullText) + '<span class="stream-cursor"></span>';
      scrollToBottom();
    }

    aiMsg.text = fullText;
    aiBubble.innerHTML = renderMarkdownWithLatex(fullText);
    attachCopyBtns(aiBubble);
    saveToStorage();
  } catch (err) {
    typingRow.remove();
    if (err.name !== 'AbortError') {
      const errorText = "I'm having a problem, please try again.";
      conv.messages[aiIdx] = { role: 'model', text: errorText, timestamp: Date.now() };
      if (aiBubble) {
        aiBubble.innerHTML = errorText;
      } else {
        const errRow = buildMessageRow(conv.messages[aiIdx], aiIdx, convId);
        messagesEl.appendChild(errRow);
      }
      saveToStorage();
      showToast(errorText);
    } else {
      if (aiBubble) {
        aiBubble.innerHTML = renderMarkdownWithLatex(aiMsg.text || '_Stopped._');
        attachCopyBtns(aiBubble);
      }
      saveToStorage();
    }
  } finally {
    setGenerating(false);
    scrollToBottom();
  }
}

/* =============================================
   GEMINI API
   ============================================= */
async function fetchConfig() {
  const apiBase = 'https://iceemeraldgithubio--pawclaw.replit.app';
  const r = await fetch(apiBase + '/api/config');
  if (!r.ok) throw new Error('Could not load API configuration.');
  const d = await r.json();
  if (!d.apiKey) throw new Error('API key not configured.');
  return { apiKey: d.apiKey, model: d.model, systemInstruction: d.systemInstruction };
}

async function* callGeminiStream(messages, extraFiles, apiKey, model, systemInstruction) {
  abortController = new AbortController();
  const contents = [];
  for (const msg of messages) {
    const parts = [];
    if (msg.attachments && msg.attachments.length) {
      for (const att of msg.attachments) {
        if (att.mimeType && att.mimeType.startsWith('image/')) {
          parts.push({ inlineData: { mimeType: att.mimeType, data: att.dataUrl.split(',')[1] } });
        } else {
          try { parts.push({ text: '[File: ' + att.name + ']\n' + atob(att.dataUrl.split(',')[1]) }); }
          catch { parts.push({ text: '[File: ' + att.name + ']' }); }
        }
      }
    }
    if (msg.text) parts.push({ text: msg.text });
    if (parts.length) contents.push({ role: msg.role === 'user' ? 'user' : 'model', parts });
  }
  if (extraFiles.length && contents.length) {
    const last = contents[contents.length - 1];
    for (const f of extraFiles) {
      if (f.type.startsWith('image/')) {
        last.parts.unshift({ inlineData: { mimeType: f.type, data: f.dataUrl.split(',')[1] } });
      } else {
        try { last.parts.unshift({ text: '[File: ' + f.name + ']\n' + atob(f.dataUrl.split(',')[1]) }); }
        catch { last.parts.unshift({ text: '[File: ' + f.name + ']' }); }
      }
    }
  }
  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':streamGenerateContent?key=' + apiKey + '&alt=sse',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(systemInstruction ? { system_instruction: { parts: [{ text: systemInstruction }] } } : {}),
        contents,
        generationConfig: { temperature: 0.85, topP: 0.95, maxOutputTokens: 8192 },
      }),
      signal: abortController.signal,
    }
  );
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e && e.error && e.error.message ? e.error.message : 'API error ' + resp.status);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (json === '[DONE]') return;
      try {
        const d = JSON.parse(json);
        const t = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text;
        if (t) yield t;
      } catch { /* skip */ }
    }
  }
  if (buf.startsWith('data: ')) {
    try {
      const d = JSON.parse(buf.slice(6).trim());
      const t = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text;
      if (t) yield t;
    } catch { /* skip */ }
  }
}

/* =============================================
   GENERATING STATE
   ============================================= */
function setGenerating(on) {
  isGenerating = on;
  sendBtn.classList.toggle('hidden', on);
  stopBtn.classList.toggle('hidden', !on);
  chatInput.disabled = on;
  if (!on) { chatInput.disabled = false; chatInput.focus(); abortController = null; }
}

function buildTypingRow() {
  const row = document.createElement('div');
  row.className = 'message-row ai-row';
  row.id = 'typing-row';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar ai-avatar';
  avatar.innerHTML = `<img src="/assets/images/favicon.webp" alt="EmeraldBot" onerror="this.style.display='none'">`;
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
  wrap.appendChild(bubble);
  row.appendChild(avatar);
  row.appendChild(wrap);
  return row;
}

/* =============================================
   EDIT MESSAGE  — rollback to any position
   ============================================= */
function startEditMessage(idx, convId, wrap, bubble) {
  const conv = conversations[convId];
  if (!conv || !conv.messages[idx]) return;
  const msg = conv.messages[idx];

  const ta = document.createElement('textarea');
  ta.className = 'edit-textarea';
  ta.value = msg.text;
  ta.rows = Math.min((msg.text.match(/\n/g) || []).length + 2, 8);

  const actDiv = document.createElement('div');
  actDiv.className = 'edit-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'edit-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'edit-save-btn';
  saveBtn.textContent = 'Save & Resend';
  actDiv.appendChild(cancelBtn);
  actDiv.appendChild(saveBtn);

  const existing = wrap.querySelector('.msg-actions');
  wrap.replaceChild(ta, bubble);
  if (existing) wrap.insertBefore(actDiv, existing);
  else wrap.appendChild(actDiv);

  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  cancelBtn.addEventListener('click', () => { wrap.replaceChild(bubble, ta); actDiv.remove(); });

  saveBtn.addEventListener('click', () => {
    const newText = ta.value.trim();
    if (!newText) return;
    // Update text and roll back to this message
    msg.text = newText;
    conv.messages = conv.messages.slice(0, idx + 1);
    saveToStorage();
    messagesEl.innerHTML = '';
    conv.messages.forEach((m, i) => appendMessageToDOM(m, i, convId));
    showMessages();
    scrollToBottom();
    generateAIResponse(conv, convId, []);
  });
}

/* =============================================
   REGENERATE — rollback from any AI message
   ============================================= */
async function regenerateFromIdx(aiIdx, convId) {
  if (isGenerating) return;
  const conv = conversations[convId];
  if (!conv) return;
  // Roll back: remove the AI message at aiIdx and everything after
  conv.messages = conv.messages.slice(0, aiIdx);
  saveToStorage();
  messagesEl.innerHTML = '';
  conv.messages.forEach((m, i) => appendMessageToDOM(m, i, convId));
  showMessages();
  scrollToBottom();
  await generateAIResponse(conv, convId, []);
}

/* =============================================
   MARKDOWN + LATEX
   ============================================= */
function renderMarkdownWithLatex(rawText) {
  if (!rawText) return '';
  const blocks = [];
  let text = rawText;

  // Extract display math $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, function(_, latex) {
    var ph = '__LATEX_D_' + blocks.length + '__';
    blocks.push({ ph: ph, latex: latex, display: true });
    return ph;
  });

  // Extract inline math $...$
  text = text.replace(/(?<!\$)\$([^\$\n]{1,300}?)\$(?!\$)/g, function(_, latex) {
    var ph = '__LATEX_I_' + blocks.length + '__';
    blocks.push({ ph: ph, latex: latex, display: false });
    return ph;
  });

  var html = renderMarkdown(text);

  blocks.forEach(function(b) {
    var rendered;
    try {
      if (typeof katex !== 'undefined') {
        rendered = katex.renderToString(b.latex, { displayMode: b.display, throwOnError: false, output: 'html' });
      } else {
        rendered = b.display ? '<pre>$$' + escapeHtml(b.latex) + '$$</pre>' : '$' + escapeHtml(b.latex) + '$';
      }
    } catch(e) {
      rendered = b.display ? '<pre>$$' + escapeHtml(b.latex) + '$$</pre>' : '$' + escapeHtml(b.latex) + '$';
    }
    html = html.split(b.ph).join(rendered);
  });

  return html;
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);

  // Fenced code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
    const label = lang || 'code';
    const hi = highlightCode(unescHtml(code.trim()), lang);
    return '<div class="code-block-wrap"><div class="code-block-header"><span class="code-lang-label">' + escapeHtml(label) + '</span><button class="copy-code-btn" onclick="copyCodeBlock(this)"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button></div><pre><code>' + hi + '</code></pre></div>';
  });

  // Tables
  html = html.replace(/(\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)*)/g, function(tb) {
    const lines = tb.trim().split('\n').filter(function(l) { return l.trim(); });
    if (lines.length < 2) return tb;
    const headers = lines[0].split('|').map(function(h) { return h.trim(); }).filter(Boolean);
    const rows = lines.slice(2).map(function(r) { return r.split('|').map(function(c) { return c.trim(); }).filter(Boolean); });
    let t = '<table><thead><tr>' + headers.map(function(h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    rows.forEach(function(r) { t += '<tr>' + r.map(function(c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; });
    return t + '</tbody></table>';
  });

  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^#{6} (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#{5} (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#{4} (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^#{3} (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^#{2} (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/^---+$/gm, '<hr>');
  html = html.replace(/((?:^[-*+] .+\n?)+)/gm, function(b) {
    return '<ul>' + b.trim().split('\n').map(function(l) { return '<li>' + l.replace(/^[-*+] /, '') + '</li>'; }).join('') + '</ul>';
  });
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, function(b) {
    return '<ol>' + b.trim().split('\n').map(function(l) { return '<li>' + l.replace(/^\d+\. /, '') + '</li>'; }).join('') + '</ol>';
  });
  html = html.replace(/\n\n+/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/(?<!>)\n(?!<)/g, '<br>');
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<(?:div|ul|ol|table|blockquote|pre|h[1-6]|hr))/g, '$1');
  html = html.replace(/(<\/(?:div|ul|ol|table|blockquote|pre|h[1-6]|hr)>)<\/p>/g, '$1');
  return html;
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function unescHtml(s) { return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'); }
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function highlightCode(code, lang) {
  let s = escapeHtml(code);
  if (['js','javascript','ts','typescript'].includes(lang)) {
    s = s.replace(/(\/\/[^\n]*)/g,'<span class="hljs-comment">$1</span>')
         .replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|default|async|await|new|typeof|instanceof|this|super|extends|try|catch|throw|yield)\b/g,'<span class="hljs-keyword">$1</span>')
         .replace(/(".*?"|'.*?'|`[\s\S]*?`)/g,'<span class="hljs-string">$1</span>')
         .replace(/\b(\d+\.?\d*)\b/g,'<span class="hljs-number">$1</span>');
  } else if (['py','python'].includes(lang)) {
    s = s.replace(/(#[^\n]*)/g,'<span class="hljs-comment">$1</span>')
         .replace(/\b(def|class|import|from|return|if|elif|else|for|while|in|not|and|or|try|except|finally|with|as|pass|break|continue|lambda|yield|global|nonlocal|True|False|None|async|await)\b/g,'<span class="hljs-keyword">$1</span>')
         .replace(/(".*?"|'.*?'|"""[\s\S]*?"""|'''[\s\S]*?''')/g,'<span class="hljs-string">$1</span>')
         .replace(/\b(\d+\.?\d*)\b/g,'<span class="hljs-number">$1</span>');
  } else if (['html','xml'].includes(lang)) {
    s = s.replace(/(&lt;\/?[\w-]+)/g,'<span class="hljs-tag">$1</span>')
         .replace(/([\w-]+=)/g,'<span class="hljs-attr">$1</span>')
         .replace(/(".*?")/g,'<span class="hljs-string">$1</span>');
  } else if (lang === 'css') {
    s = s.replace(/(\/\*[\s\S]*?\*\/)/g,'<span class="hljs-comment">$1</span>')
         .replace(/([.#][\w-]+)/g,'<span class="hljs-selector-class">$1</span>')
         .replace(/([\w-]+)(?=\s*:)/g,'<span class="hljs-attr">$1</span>');
  }
  return s;
}

function attachCopyBtns(container) {
  container.querySelectorAll('.copy-code-btn').forEach(function(btn) { btn.onclick = function() { copyCodeBlock(btn); }; });
}

window.copyCodeBlock = function(btn) {
  const pre = btn.closest('.code-block-wrap') && btn.closest('.code-block-wrap').querySelector('pre');
  if (!pre) return;
  copyText(pre.textContent);
  btn.classList.add('copied');
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
  setTimeout(function() {
    btn.classList.remove('copied');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
  }, 2000);
};

/* =============================================
   FILE HANDLING
   ============================================= */
function handleFiles(fileList) {
  const types = ['image/','text/','application/pdf','application/json'];
  Array.from(fileList).forEach(function(file) {
    if (pendingFiles.length >= 8) { showToast('Max 8 files per message'); return; }
    const ok = types.some(function(t) { return file.type.startsWith(t); }) ||
      /\.(txt|js|ts|py|java|c|cpp|cs|go|rs|html|css|json|md|xml|yaml|yml|pdf)$/i.test(file.name);
    if (!ok) { showToast('Unsupported: ' + file.name); return; }
    if (file.size > 20*1024*1024) { showToast('Too large: ' + file.name); return; }
    const reader = new FileReader();
    reader.onload = function(e) { pendingFiles.push({ name: file.name, type: file.type, dataUrl: e.target.result }); renderFilePreviews(); updateSendBtn(); };
    reader.readAsDataURL(file);
  });
}

function renderFilePreviews() {
  filePreviews.innerHTML = '';
  pendingFiles.forEach(function(f, idx) {
    const chip = document.createElement('div');
    chip.className = 'file-preview-chip' + (f.type.startsWith('image/') ? ' image-chip' : '');
    if (f.type.startsWith('image/')) chip.innerHTML = '<img src="' + f.dataUrl + '" alt="">';
    else chip.innerHTML = '<span>' + fileIcon(f.type) + '</span>';
    const name = document.createElement('span'); name.className = 'chip-name'; name.textContent = f.name;
    const rm = document.createElement('button'); rm.className = 'chip-remove'; rm.innerHTML = '&times;';
    rm.addEventListener('click', function() { pendingFiles.splice(idx,1); renderFilePreviews(); updateSendBtn(); });
    chip.appendChild(name); chip.appendChild(rm);
    filePreviews.appendChild(chip);
  });
}

function fileIcon(t) {
  if (!t) return '📄';
  if (t.startsWith('image/')) return '🖼️';
  if (t === 'application/pdf') return '📑';
  if (t.includes('javascript')||t.includes('typescript')) return '📜';
  if (t.startsWith('text/')) return '📝';
  return '📄';
}

/* =============================================
   DRAG & DROP
   ============================================= */
function createDropOverlay() {
  const el = document.createElement('div');
  el.className = 'drop-overlay';
  el.innerHTML = '<div class="drop-overlay-text">Drop files to attach</div>';
  document.body.appendChild(el);
  return el;
}
let dragCounter = 0;
document.addEventListener('dragenter', function(e) { if (e.dataTransfer.types.includes('Files')) { dragCounter++; dropOverlay.classList.add('active'); } });
document.addEventListener('dragleave', function() { if (--dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); } });
document.addEventListener('dragover', function(e) { e.preventDefault(); });
document.addEventListener('drop', function(e) { e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('active'); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

/* =============================================
   CHAT CONTEXT MENU
   ============================================= */
function showChatCtxMenu(e, convId) {
  contextMenuTargetId = convId;
  chatCtxMenu.classList.add('visible');
  const x = Math.min(e.clientX, window.innerWidth - 155);
  const y = Math.min(e.clientY, window.innerHeight - 90);
  chatCtxMenu.style.left = x + 'px';
  chatCtxMenu.style.top = y + 'px';
}
function hideChatCtxMenu() { chatCtxMenu.classList.remove('visible'); contextMenuTargetId = null; }
document.addEventListener('click', function() { hideChatCtxMenu(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { hideChatCtxMenu(); closeAllModals(); } });

/* =============================================
   CUSTOM MODALS
   ============================================= */
function showRenameModal(currentName, onSave) {
  renameInput.value = currentName;
  renameModal.style.display = 'flex';
  pendingModalCallback = onSave;
  requestAnimationFrame(function() { renameInput.focus(); renameInput.select(); });
}
function showDeleteModal(name, onConfirm) {
  deleteModalName.textContent = name;
  deleteModal.style.display = 'flex';
  pendingModalCallback = onConfirm;
}
function showClearAllModal(onConfirm) {
  clearallModal.style.display = 'flex';
  pendingModalCallback = onConfirm;
}
function closeAllModals() {
  [renameModal, deleteModal, clearallModal].forEach(function(m) { if (m) m.style.display = 'none'; });
  pendingModalCallback = null;
}

function bindModalEvents() {
  renameSave.addEventListener('click', function() {
    const v = renameInput.value.trim();
    if (!v) return;
    if (pendingModalCallback) pendingModalCallback(v);
    renameModal.style.display = 'none'; pendingModalCallback = null;
  });
  renameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') renameSave.click(); });
  [renameCancel, renameClose].forEach(function(b) {
    b.addEventListener('click', function() { renameModal.style.display = 'none'; pendingModalCallback = null; });
  });
  renameModal.addEventListener('click', function(e) { if (e.target === renameModal) { renameModal.style.display = 'none'; pendingModalCallback = null; } });

  deleteConfirm.addEventListener('click', function() {
    if (pendingModalCallback) pendingModalCallback();
    deleteModal.style.display = 'none'; pendingModalCallback = null;
  });
  deleteCancel.addEventListener('click', function() { deleteModal.style.display = 'none'; pendingModalCallback = null; });
  deleteModal.addEventListener('click', function(e) { if (e.target === deleteModal) { deleteModal.style.display = 'none'; pendingModalCallback = null; } });

  clearallConfirm.addEventListener('click', function() {
    if (pendingModalCallback) pendingModalCallback();
    clearallModal.style.display = 'none'; pendingModalCallback = null;
  });
  clearallCancel.addEventListener('click', function() { clearallModal.style.display = 'none'; pendingModalCallback = null; });
  clearallModal.addEventListener('click', function(e) { if (e.target === clearallModal) { clearallModal.style.display = 'none'; pendingModalCallback = null; } });
}

/* =============================================
   UI HELPERS
   ============================================= */
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function updateSendBtn() {
  const ok = (chatInput.value.trim().length > 0 || pendingFiles.length > 0) && !isGenerating;
  sendBtn.disabled = !ok;
}

function autoResizeTextarea() {
  chatInput.addEventListener('input', function() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
    updateSendBtn();
  });
}

function showToast(msg, dur) {
  dur = dur || 2500;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(function() { toastEl.classList.remove('show'); }, dur);
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(function() {
    const ta = document.createElement('textarea'); ta.value = text;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  });
}

function copyIcon() { return '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }
function editIcon() { return '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'; }
function regenIcon() { return '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'; }

/* =============================================
   EVENT BINDINGS
   ============================================= */
function bindEvents() {
  sidebarToggle.addEventListener('click', toggleSidebar);
  sidebarOpenBtn.addEventListener('click', toggleSidebar);
  newChatBtn.addEventListener('click', startNewChat);
  sidebarNewBtn.addEventListener('click', startNewChat);

  document.querySelectorAll('.prompt-card').forEach(function(card) {
    card.addEventListener('click', function() {
      chatInput.value = card.dataset.prompt;
      chatInput.dispatchEvent(new Event('input'));
      chatInput.focus();
    });
  });

  sendBtn.addEventListener('click', triggerSend);
  chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) triggerSend(); }
  });

  stopBtn.addEventListener('click', function() { if (abortController) abortController.abort(); setGenerating(false); });
  fileInput.addEventListener('change', function(e) { handleFiles(e.target.files); fileInput.value = ''; });

  ctxRename.addEventListener('click', function() {
    const id = contextMenuTargetId;
    if (!id || !conversations[id]) return;
    hideChatCtxMenu();
    showRenameModal(conversations[id].name, function(newName) { renameConversation(id, newName); });
  });
  ctxDelete.addEventListener('click', function() {
    const id = contextMenuTargetId;
    if (!id || !conversations[id]) return;
    hideChatCtxMenu();
    showDeleteModal(conversations[id].name, function() { deleteConversation(id); });
  });
}

function toggleSidebar() { sidebar.classList.toggle('collapsed'); }

function startNewChat() {
  if (!sidebar.classList.contains('collapsed') && window.innerWidth <= 768) sidebar.classList.add('collapsed');
  activeConvId = null;
  showWelcome();
  messagesEl.innerHTML = '';
  pendingFiles = []; renderFilePreviews();
  chatInput.value = ''; chatInput.style.height = 'auto';
  updateSendBtn(); chatInput.focus();
  renderSidebarChats();
}

function triggerSend() {
  if (isGenerating || sendBtn.disabled) return;
  const text = chatInput.value.trim();
  const files = pendingFiles.slice();
  chatInput.value = ''; chatInput.style.height = 'auto';
  pendingFiles = []; renderFilePreviews(); updateSendBtn();
  sendMessage(text, files);
}

/* ---- Start ---- */
document.addEventListener('DOMContentLoaded', init);
