const STORE_KEY = "alphacodes-chat-ai:v2";

const defaultSettings = {
  model: "",
  systemPrompt: "",
  temperature: 0.7,
  topP: 1,
  maxTokens: 2048,
  theme: "light"
};

const suggestions = [
  {
    title: "Ringkas meeting",
    detail: "Keputusan, risiko, dan next step",
    prompt: "Ringkas catatan meeting berikut menjadi: keputusan utama, risiko, pertanyaan terbuka, dan next step."
  },
  {
    title: "Draft ke klien",
    detail: "Nada jelas dan profesional",
    prompt: "Buat draft pesan profesional untuk klien dengan konteks berikut:"
  },
  {
    title: "Rencana eksekusi",
    detail: "Checklist kerja yang runtut",
    prompt: "Ubah kebutuhan berikut menjadi checklist eksekusi yang runtut, lengkap dengan prioritas."
  },
  {
    title: "Rapikan ide",
    detail: "Dari kasar menjadi siap dibahas",
    prompt: "Rapikan ide berikut menjadi penjelasan yang jelas, terstruktur, dan siap dibahas tim."
  }
];

const els = {
  sidebar: document.querySelector("#sidebar"),
  sidebarToggle: document.querySelector("#sidebarToggle"),
  newChatBtn: document.querySelector("#newChatBtn"),
  searchInput: document.querySelector("#searchInput"),
  conversationList: document.querySelector("#conversationList"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionText: document.querySelector("#connectionText"),
  chatTitle: document.querySelector("#chatTitle"),
  chatMeta: document.querySelector("#chatMeta"),
  modelSelect: document.querySelector("#modelSelect"),
  regenerateBtn: document.querySelector("#regenerateBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  themeBtn: document.querySelector("#themeBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  promptInput: document.querySelector("#promptInput"),
  sendBtn: document.querySelector("#sendBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  statusLine: document.querySelector("#statusLine"),
  settingsOverlay: document.querySelector("#settingsOverlay"),
  closeSettingsBtn: document.querySelector("#closeSettingsBtn"),
  manualModelInput: document.querySelector("#manualModelInput"),
  systemPromptInput: document.querySelector("#systemPromptInput"),
  temperatureInput: document.querySelector("#temperatureInput"),
  temperatureValue: document.querySelector("#temperatureValue"),
  topPInput: document.querySelector("#topPInput"),
  topPValue: document.querySelector("#topPValue"),
  maxTokensInput: document.querySelector("#maxTokensInput"),
  endpointOutput: document.querySelector("#endpointOutput"),
  toast: document.querySelector("#toast")
};

let state = loadState();
let abortController = null;
let activeAssistantId = null;
let toastTimer = null;

init();

async function init() {
  if (!state.conversations.length) {
    state.conversations.push(createConversation());
    state.activeId = state.conversations[0].id;
    saveState();
  }

  bindEvents();
  applyTheme();
  renderAll();
  resizeComposer();
  await loadConfigAndModels();
}

function bindEvents() {
  els.newChatBtn.addEventListener("click", () => {
    const conversation = createConversation();
    state.conversations.unshift(conversation);
    state.activeId = conversation.id;
    saveAndRender();
    els.promptInput.focus();
    closeSidebarOnMobile();
  });

  els.searchInput.addEventListener("input", renderConversationList);
  els.sidebarToggle.addEventListener("click", () => els.sidebar.classList.toggle("open"));

  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendPrompt();
  });

  els.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendPrompt();
    }
  });

  els.promptInput.addEventListener("input", resizeComposer);
  els.stopBtn.addEventListener("click", stopGeneration);
  els.regenerateBtn.addEventListener("click", regenerateLast);
  els.exportBtn.addEventListener("click", exportConversation);
  els.themeBtn.addEventListener("click", toggleTheme);
  els.settingsBtn.addEventListener("click", openSettings);
  els.closeSettingsBtn.addEventListener("click", closeSettings);
  els.settingsOverlay.addEventListener("click", (event) => {
    if (event.target === els.settingsOverlay) closeSettings();
  });

  els.chatTitle.addEventListener("change", () => {
    const conversation = getActiveConversation();
    conversation.title = els.chatTitle.value.trim() || "Chat baru";
    conversation.updatedAt = Date.now();
    saveAndRender();
  });

  els.modelSelect.addEventListener("change", () => {
    state.settings.model = els.modelSelect.value;
    els.manualModelInput.value = state.settings.model;
    saveState();
  });

  for (const input of [
    els.manualModelInput,
    els.systemPromptInput,
    els.temperatureInput,
    els.topPInput,
    els.maxTokensInput
  ]) {
    input.addEventListener("input", updateSettingsFromPanel);
  }
}

async function loadConfigAndModels() {
  try {
    const configResponse = await fetch("/api/config");
    const config = await configResponse.json();
    if (els.endpointOutput) {
      els.endpointOutput.value = config.appName || "AlphaCodes AI";
    }

    if (config.defaultModel && !state.settings.model) {
      state.settings.model = config.defaultModel;
    }

    const response = await fetch("/api/models");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Model tidak bisa dimuat");
    }

    const data = await response.json();
    state.models = data.models || [];

    const selectedModel = chooseChatModel(state.models, state.settings.model, config.defaultModel);
    if (selectedModel && selectedModel !== state.settings.model) {
      state.settings.model = selectedModel;
    }

    els.connectionDot.className = "connection-dot ok";
    els.connectionText.textContent = "Terhubung";
    saveState();
  } catch (error) {
    els.connectionDot.className = "connection-dot bad";
    els.connectionText.textContent = "Belum terhubung";
    setStatus(error.message || "Koneksi gagal");
  } finally {
    renderModelSelect();
    syncSettingsPanel();
  }
}

async function sendPrompt() {
  const text = els.promptInput.value.trim();
  if (!text || abortController) return;

  const conversation = getActiveConversation();
  const userMessage = createMessage("user", text);
  conversation.messages.push(userMessage);
  conversation.updatedAt = Date.now();

  if (!conversation.title || conversation.title === "Chat baru") {
    conversation.title = makeTitle(text);
  }

  els.promptInput.value = "";
  resizeComposer();
  saveAndRender();
  await requestAssistant(conversation, conversation.messages.length - 1);
}

async function regenerateLast() {
  if (abortController) return;

  const conversation = getActiveConversation();
  const lastAssistantIndex = findLastIndex(conversation.messages, (message) => message.role === "assistant");
  if (lastAssistantIndex === -1) {
    showToast("Belum ada jawaban untuk diulang.");
    return;
  }

  const userIndex = findLastIndex(
    conversation.messages.slice(0, lastAssistantIndex),
    (message) => message.role === "user"
  );

  if (userIndex === -1) {
    showToast("Pesan pengguna tidak ditemukan.");
    return;
  }

  conversation.messages.splice(lastAssistantIndex, 1);
  conversation.updatedAt = Date.now();
  saveAndRender();
  await requestAssistant(conversation, userIndex);
}

async function requestAssistant(conversation, afterUserIndex) {
  const assistantMessage = createMessage("assistant", "");
  conversation.messages.splice(afterUserIndex + 1, 0, assistantMessage);
  activeAssistantId = assistantMessage.id;
  abortController = new AbortController();

  setBusy(true);
  setStatus("AI sedang menulis...");
  saveAndRender(false);

  try {
    const messages = buildRequestMessages(conversation, assistantMessage.id);
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: state.settings.model,
        messages,
        stream: true
      }),
      signal: abortController.signal
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Permintaan AI gagal.");
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      await readSseResponse(response, (chunk) => appendAssistantChunk(conversation, assistantMessage.id, chunk));
    } else {
      const data = await response.json();
      const content = extractNonStreamContent(data);
      setAssistantContent(conversation, assistantMessage.id, content);
    }

    conversation.updatedAt = Date.now();
    setStatus("Selesai");
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("Dihentikan");
    } else {
      setAssistantContent(conversation, assistantMessage.id, `Terjadi masalah: ${error.message}`);
      setStatus(error.message);
    }
  } finally {
    abortController = null;
    activeAssistantId = null;
    setBusy(false);
    saveAndRender(false);
  }
}

async function readSseResponse(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const json = JSON.parse(data);
        const chunk =
          json.choices?.[0]?.delta?.content ??
          json.choices?.[0]?.message?.content ??
          json.choices?.[0]?.text ??
          "";
        if (chunk) onChunk(chunk);
      } catch {
        onChunk(data);
      }
    }
  }
}

function buildRequestMessages(conversation, activeAssistantMessageId) {
  const messages = [];

  for (const message of conversation.messages) {
    if (message.id === activeAssistantMessageId) break;
    if (message.role === "user" || message.role === "assistant") {
      messages.push({ role: message.role, content: message.content });
    }
  }

  return messages;
}

function appendAssistantChunk(conversation, messageId, chunk) {
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message) return;

  message.content += chunk;
  conversation.updatedAt = Date.now();
  renderMessages();
  scrollMessagesToBottom();
  saveState();
}

function setAssistantContent(conversation, messageId, content) {
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message) return;

  message.content = content || "";
  conversation.updatedAt = Date.now();
  renderMessages();
}

function stopGeneration() {
  if (abortController) {
    abortController.abort();
  }
}

function setBusy(isBusy) {
  els.sendBtn.classList.toggle("hidden", isBusy);
  els.stopBtn.classList.toggle("hidden", !isBusy);
  els.promptInput.disabled = isBusy;
  els.regenerateBtn.disabled = isBusy;
}

function renderAll() {
  renderConversationList();
  renderHeader();
  renderMessages();
  renderModelSelect();
  syncSettingsPanel();
}

function renderConversationList() {
  const query = els.searchInput.value.trim().toLowerCase();
  const conversations = state.conversations
    .filter((conversation) => {
      const haystack = `${conversation.title} ${conversation.messages.map((message) => message.content).join(" ")}`;
      return haystack.toLowerCase().includes(query);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  els.conversationList.innerHTML = "";

  for (const conversation of conversations) {
    const item = document.createElement("div");
    item.className = `conversation-item${conversation.id === state.activeId ? " active" : ""}`;

    const main = document.createElement("button");
    main.className = "conversation-main";
    main.type = "button";
    main.addEventListener("click", () => {
      state.activeId = conversation.id;
      saveAndRender();
      closeSidebarOnMobile();
    });

    const title = document.createElement("div");
    title.className = "conversation-title";
    title.textContent = conversation.title || "Chat baru";

    const date = document.createElement("div");
    date.className = "conversation-date";
    date.textContent = formatRelativeTime(conversation.updatedAt);

    main.append(title, date);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "mini-button";
    deleteBtn.type = "button";
    deleteBtn.title = "Hapus";
    deleteBtn.setAttribute("aria-label", "Hapus chat");
    deleteBtn.innerHTML = `<svg><use href="#icon-trash"></use></svg>`;
    deleteBtn.addEventListener("click", () => deleteConversation(conversation.id));

    item.append(main, deleteBtn);
    els.conversationList.append(item);
  }
}

function renderHeader() {
  const conversation = getActiveConversation();
  els.chatTitle.value = conversation.title || "Chat baru";

  const count = conversation.messages.length;
  els.chatMeta.textContent = `${count} pesan`;
}

function renderMessages() {
  const conversation = getActiveConversation();
  els.messages.innerHTML = "";

  if (!conversation.messages.length) {
    els.messages.append(renderEmptyState());
    return;
  }

  for (const message of conversation.messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = message.role === "user" ? "U" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const header = document.createElement("div");
    header.className = "message-header";

    const role = document.createElement("div");
    role.className = "role";
    role.textContent = message.role === "user" ? "Anda" : "Asisten";

    const actions = document.createElement("div");
    actions.className = "message-actions";

    const copyBtn = document.createElement("button");
    copyBtn.className = "message-action";
    copyBtn.type = "button";
    copyBtn.title = "Copy";
    copyBtn.setAttribute("aria-label", "Copy pesan");
    copyBtn.innerHTML = `<svg><use href="#icon-copy"></use></svg>`;
    copyBtn.addEventListener("click", () => copyText(message.content));
    actions.append(copyBtn);

    header.append(role, actions);

    const content = document.createElement("div");
    content.className = "message-content";
    if (message.role === "assistant" && !message.content && message.id === activeAssistantId) {
      content.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
    } else {
      content.innerHTML = renderMarkdown(message.content);
    }

    bubble.append(header, content);
    article.append(avatar, bubble);
    els.messages.append(article);
  }

  bindCodeCopyButtons();
}

function renderEmptyState() {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";

  const block = document.createElement("div");
  block.className = "empty-block";
  block.innerHTML = `
    <div class="assistant-kicker">AlphaCodes AI</div>
    <h1>Apa yang sedang dikerjakan?</h1>
  `;

  const grid = document.createElement("div");
  grid.className = "suggestions";

  for (const suggestion of suggestions) {
    const button = document.createElement("button");
    button.className = "suggestion";
    button.type = "button";
    button.innerHTML = `
      <span class="suggestion-title">${escapeHtml(suggestion.title)}</span>
      <span class="suggestion-detail">${escapeHtml(suggestion.detail)}</span>
    `;
    button.addEventListener("click", () => {
      els.promptInput.value = suggestion.prompt;
      resizeComposer();
      els.promptInput.focus();
    });
    grid.append(button);
  }

  block.append(grid);
  wrapper.append(block);
  return wrapper;
}

function renderModelSelect() {
  const current = state.settings.model || "";
  els.modelSelect.innerHTML = "";

  if (!state.models?.length) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = current || "Model manual";
    els.modelSelect.append(option);
  } else {
    const chatModels = getChatModels(state.models);
    const modelsToRender = chatModels.length ? chatModels : state.models;

    for (const model of modelsToRender) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.id;
      els.modelSelect.append(option);
    }

    if (current && !modelsToRender.some((model) => model.id === current)) {
      const custom = document.createElement("option");
      custom.value = current;
      custom.textContent = current;
      els.modelSelect.prepend(custom);
    }
  }

  els.modelSelect.value = current;
}

function syncSettingsPanel() {
  els.manualModelInput.value = state.settings.model || "";
  els.systemPromptInput.value = state.settings.systemPrompt;
  els.temperatureInput.value = state.settings.temperature;
  els.temperatureValue.textContent = state.settings.temperature;
  els.topPInput.value = state.settings.topP;
  els.topPValue.textContent = state.settings.topP;
  els.maxTokensInput.value = state.settings.maxTokens;
}

function updateSettingsFromPanel() {
  state.settings.model = els.manualModelInput.value.trim();
  state.settings.systemPrompt = els.systemPromptInput.value;
  state.settings.temperature = Number(els.temperatureInput.value);
  state.settings.topP = Number(els.topPInput.value);
  state.settings.maxTokens = Number(els.maxTokensInput.value);

  els.temperatureValue.textContent = state.settings.temperature;
  els.topPValue.textContent = state.settings.topP;
  renderModelSelect();
  saveState();
}

function deleteConversation(id) {
  const wasActive = id === state.activeId;
  state.conversations = state.conversations.filter((conversation) => conversation.id !== id);

  if (!state.conversations.length) {
    state.conversations.push(createConversation());
  }

  if (wasActive) {
    state.activeId = state.conversations[0].id;
  }

  saveAndRender();
}

function exportConversation() {
  const conversation = getActiveConversation();
  const lines = [`# ${conversation.title || "Chat"}`, ""];

  for (const message of conversation.messages) {
    lines.push(`## ${message.role === "user" ? "Anda" : "Asisten"}`);
    lines.push("");
    lines.push(message.content);
    lines.push("");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(conversation.title || "chat")}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openSettings() {
  syncSettingsPanel();
  els.settingsOverlay.classList.remove("hidden");
  els.manualModelInput.focus();
}

function closeSettings() {
  els.settingsOverlay.classList.add("hidden");
}

function toggleTheme() {
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
  applyTheme();
  saveState();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
}

function resizeComposer() {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = `${Math.min(180, els.promptInput.scrollHeight)}px`;
}

function setStatus(text) {
  els.statusLine.textContent = text;
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function saveAndRender(shouldScroll = true) {
  saveState();
  renderAll();
  if (shouldScroll) requestAnimationFrame(scrollMessagesToBottom);
}

function getActiveConversation() {
  let conversation = state.conversations.find((item) => item.id === state.activeId);
  if (!conversation) {
    conversation = state.conversations[0] || createConversation();
    state.conversations = [conversation];
    state.activeId = conversation.id;
  }
  return conversation;
}

function createConversation() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "Chat baru",
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

function createMessage(role, content) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now()
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      activeId: parsed.activeId || "",
      models: [],
      settings: { ...defaultSettings, ...(parsed.settings || {}) }
    };
  } catch {
    return {
      conversations: [],
      activeId: "",
      models: [],
      settings: { ...defaultSettings }
    };
  }
}

function saveState() {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      conversations: state.conversations,
      activeId: state.activeId,
      settings: state.settings
    })
  );
}

function renderMarkdown(text) {
  if (!text) return "";

  const blocks = [];
  const tokenPrefix = `__CODE_${crypto.randomUUID()}_`;
  let index = 0;
  let safe = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, language, code) => {
    const token = `${tokenPrefix}${index++}__`;
    blocks.push({
      token,
      html: `<div class="code-block"><button class="code-copy" type="button">Copy</button><pre><code>${escapeHtml(code.trim())}</code></pre></div>`
    });
    return token;
  });

  safe = escapeHtml(safe)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const lines = safe.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
  let html = lines
    .map((chunk) => {
      if (chunk.startsWith(tokenPrefix)) return chunk;
      if (/^<h[1-3]>/.test(chunk)) return chunk;

      const listLines = chunk.split(/\n/).filter((line) => /^[-*]\s+/.test(line));
      if (listLines.length && listLines.length === chunk.split(/\n/).length) {
        return `<ul>${listLines.map((line) => `<li>${line.replace(/^[-*]\s+/, "")}</li>`).join("")}</ul>`;
      }

      return `<p>${chunk.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  for (const block of blocks) {
    html = html.replace(escapeHtml(block.token), block.html).replace(block.token, block.html);
  }

  return html;
}

function bindCodeCopyButtons() {
  for (const button of document.querySelectorAll(".code-copy")) {
    button.addEventListener("click", () => {
      const code = button.parentElement?.querySelector("code")?.textContent || "";
      copyText(code);
    });
  }
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  showToast("Disalin.");
}

function showToast(text) {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.classList.add("show");
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
}

function extractNonStreamContent(data) {
  return (
    data.choices?.[0]?.message?.content ||
    data.choices?.[0]?.text ||
    data.output_text ||
    data.response ||
    JSON.stringify(data, null, 2)
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function makeTitle(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 42) || "Chat baru";
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chat";
}

function findLastIndex(array, predicate) {
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (predicate(array[index], index)) return index;
  }
  return -1;
}

function chooseChatModel(models, currentModel, defaultModel) {
  const ids = models.map((model) => model.id).filter(Boolean);
  if (!ids.length) return currentModel || defaultModel || "";

  const chatModels = ids.filter((id) => !isCodexModel(id) && !isReviewModel(id));
  const nonCodexModels = ids.filter((id) => !isCodexModel(id));
  const candidates = chatModels.length ? chatModels : nonCodexModels.length ? nonCodexModels : ids;

  for (const preferred of [defaultModel, currentModel, "cx/gpt-5.5", "cx/gpt-5.4", "cx/gpt-5.4-mini"]) {
    if (preferred && candidates.includes(preferred)) return preferred;
  }

  return candidates[0] || currentModel || defaultModel || "";
}

function getChatModels(models) {
  const chatModels = models.filter((model) => !isCodexModel(model.id) && !isReviewModel(model.id));
  return chatModels.length ? chatModels : models.filter((model) => !isCodexModel(model.id));
}

function isCodexModel(modelId) {
  return String(modelId || "").toLowerCase().includes("codex");
}

function isReviewModel(modelId) {
  return String(modelId || "").toLowerCase().includes("review");
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "Baru saja";
  if (diff < hour) return `${Math.floor(diff / minute)} menit lalu`;
  if (diff < day) return `${Math.floor(diff / hour)} jam lalu`;
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short" }).format(timestamp);
}

function closeSidebarOnMobile() {
  if (window.matchMedia("(max-width: 860px)").matches) {
    els.sidebar.classList.remove("open");
  }
}
