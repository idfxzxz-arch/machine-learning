import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const STORE_KEY = "alphacodes-chat-ai:v3";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
const API_BACKEND_MISSING_MESSAGE =
  "API backend belum terhubung. Pastikan domain ini diarahkan ke server Node, bukan hanya file frontend.";

const defaultSettings = {
  model: "",
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

function App() {
  const [state, setState] = useState(loadState);
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("Siap");
  const [connection, setConnection] = useState({ status: "checking", text: "Memeriksa koneksi" });
  const [isBusy, setIsBusy] = useState(false);
  const [activeAssistantId, setActiveAssistantId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");

  const textareaRef = useRef(null);
  const messagesRef = useRef(null);
  const abortRef = useRef(null);
  const toastTimerRef = useRef(null);

  const activeConversation = useMemo(
    () => getActiveConversation(state),
    [state]
  );

  const filteredConversations = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...state.conversations]
      .filter((conversation) => {
        if (!query) return true;
        const content = conversation.messages.map((message) => message.content).join(" ");
        return `${conversation.title} ${content}`.toLowerCase().includes(query);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state.conversations, search]);

  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
    saveState(state);
  }, [state]);

  useEffect(() => {
    loadConfigAndModels();
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [prompt]);

  useEffect(() => {
    scrollMessagesToBottom();
  }, [activeConversation?.messages, activeAssistantId]);

  async function loadConfigAndModels() {
    try {
      const config = await fetchJson("/api/config");

      const data = await fetchJson("/api/models");
      const models = data.models || [];

      setState((prev) => {
        const selectedModel = chooseChatModel(models, prev.settings.model, config.defaultModel);
        return {
          ...prev,
          models,
          settings: {
            ...prev.settings,
            model: selectedModel || prev.settings.model
          }
        };
      });

      setConnection({ status: "ok", text: "Terhubung" });
    } catch (error) {
      setConnection({ status: "bad", text: "Belum terhubung" });
      setStatus(error.message || "Koneksi gagal");
    }
  }

  function startNewChat() {
    const conversation = createConversation();
    setState((prev) => ({
      ...prev,
      conversations: [conversation, ...prev.conversations],
      activeId: conversation.id
    }));
    setPrompt("");
    closeSidebarOnMobile();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function selectConversation(id) {
    setState((prev) => ({ ...prev, activeId: id }));
    closeSidebarOnMobile();
  }

  function deleteConversation(id) {
    setState((prev) => {
      let conversations = prev.conversations.filter((conversation) => conversation.id !== id);
      if (!conversations.length) conversations = [createConversation()];
      const activeId = prev.activeId === id ? conversations[0].id : prev.activeId;
      return { ...prev, conversations, activeId };
    });
  }

  function updateChatTitle(value) {
    const title = value.trim() || "Chat baru";
    setState((prev) => updateConversation(prev, activeConversation.id, (conversation) => ({
      ...conversation,
      title,
      updatedAt: Date.now()
    })));
  }

  async function sendPrompt(event) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || isBusy) return;

    const userMessage = createMessage("user", text);
    const assistantMessage = createMessage("assistant", "");
    const requestMessages = [...activeConversation.messages, userMessage];

    setPrompt("");
    setState((prev) => updateConversation(prev, activeConversation.id, (conversation) => ({
      ...conversation,
      title: conversation.title === "Chat baru" ? makeTitle(text) : conversation.title,
      updatedAt: Date.now(),
      messages: [...conversation.messages, userMessage, assistantMessage]
    })));

    await requestAssistant(activeConversation.id, assistantMessage.id, requestMessages);
  }

  async function regenerateLast() {
    if (isBusy) return;

    const messages = activeConversation.messages;
    const lastAssistantIndex = findLastIndex(messages, (message) => message.role === "assistant");
    if (lastAssistantIndex === -1) {
      showToast("Belum ada jawaban untuk diulang.");
      return;
    }

    const userIndex = findLastIndex(messages.slice(0, lastAssistantIndex), (message) => message.role === "user");
    if (userIndex === -1) {
      showToast("Pesan pengguna tidak ditemukan.");
      return;
    }

    const assistantMessage = createMessage("assistant", "");
    const nextMessages = [
      ...messages.slice(0, lastAssistantIndex),
      ...messages.slice(lastAssistantIndex + 1)
    ];
    nextMessages.splice(userIndex + 1, 0, assistantMessage);

    const requestMessages = nextMessages.slice(0, userIndex + 1);

    setState((prev) => updateConversation(prev, activeConversation.id, (conversation) => ({
      ...conversation,
      updatedAt: Date.now(),
      messages: nextMessages
    })));

    await requestAssistant(activeConversation.id, assistantMessage.id, requestMessages);
  }

  async function requestAssistant(conversationId, assistantId, requestMessages) {
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveAssistantId(assistantId);
    setIsBusy(true);
    setStatus("AI sedang menulis...");

    try {
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: state.settings.model,
          messages: buildRequestMessages(requestMessages),
          stream: true
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const error = await readJsonResponse(response).catch(() => ({}));
        throw new Error(error.error || "Permintaan AI gagal.");
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        await readSseResponse(response, (chunk) => appendAssistantChunk(conversationId, assistantId, chunk));
      } else if (contentType.includes("application/json")) {
        const data = await response.json();
        setAssistantContent(conversationId, assistantId, extractNonStreamContent(data));
      } else {
        throw new Error(API_BACKEND_MISSING_MESSAGE);
      }

      setStatus("Selesai");
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus("Dihentikan");
      } else {
        setAssistantContent(conversationId, assistantId, `Terjadi masalah: ${error.message}`);
        setStatus(error.message);
      }
    } finally {
      abortRef.current = null;
      setActiveAssistantId("");
      setIsBusy(false);
    }
  }

  function appendAssistantChunk(conversationId, messageId, chunk) {
    setState((prev) => updateMessage(prev, conversationId, messageId, (message) => ({
      ...message,
      content: message.content + chunk
    })));
  }

  function setAssistantContent(conversationId, messageId, content) {
    setState((prev) => updateMessage(prev, conversationId, messageId, (message) => ({
      ...message,
      content: content || ""
    })));
  }

  function stopGeneration() {
    abortRef.current?.abort();
  }

  function toggleTheme() {
    setState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        theme: prev.settings.theme === "dark" ? "light" : "dark"
      }
    }));
  }

  function exportConversation() {
    const lines = [`# ${activeConversation.title || "Chat"}`, ""];
    for (const message of activeConversation.messages) {
      lines.push(`## ${message.role === "user" ? "Anda" : "Asisten"}`);
      lines.push("");
      lines.push(message.content);
      lines.push("");
    }

    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(activeConversation.title || "chat")}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function copyText(text) {
    await navigator.clipboard.writeText(text);
    showToast("Disalin.");
  }

  function showToast(message) {
    clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(""), 1800);
  }

  function resizeComposer() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(180, textarea.scrollHeight)}px`;
  }

  function scrollMessagesToBottom() {
    const element = messagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }

  function closeSidebarOnMobile() {
    if (window.matchMedia("(max-width: 860px)").matches) {
      setSidebarOpen(false);
    }
  }

  function handleMessageContentClick(event) {
    const button = event.target.closest?.(".code-copy");
    if (!button) return;
    const code = button.parentElement?.querySelector("code")?.textContent || "";
    copyText(code);
  }

  return (
    <>
      <IconDefinitions />
      <div className="app-shell">
        <aside className={`sidebar${sidebarOpen ? " open" : ""}`} id="sidebar">
          <div className="brand-row">
            <div className="brand-mark">AC</div>
            <div>
              <div className="brand-name">AlphaCodes</div>
              <div className="brand-subtitle">AI Assistant</div>
            </div>
          </div>

          <button className="primary-action" type="button" onClick={startNewChat}>
            <Icon name="plus" />
            <span>Chat baru</span>
          </button>

          <label className="search-box">
            <input
              type="search"
              placeholder="Cari chat"
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>

          <div className="section-label">Percakapan</div>
          <nav className="conversation-list" aria-label="Daftar chat">
            {filteredConversations.map((conversation) => (
              <div
                className={`conversation-item${conversation.id === state.activeId ? " active" : ""}`}
                key={conversation.id}
              >
                <button
                  className="conversation-main"
                  type="button"
                  onClick={() => selectConversation(conversation.id)}
                >
                  <div className="conversation-title">{conversation.title || "Chat baru"}</div>
                  <div className="conversation-date">{formatRelativeTime(conversation.updatedAt)}</div>
                </button>
                <button
                  className="mini-button"
                  type="button"
                  title="Hapus"
                  aria-label="Hapus chat"
                  onClick={() => deleteConversation(conversation.id)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className={`connection-dot ${connection.status === "ok" ? "ok" : connection.status === "bad" ? "bad" : ""}`} />
            <span>{connection.text}</span>
          </div>
        </aside>

        <main className="chat-panel">
          <header className="topbar">
            <button
              className="icon-button mobile-only"
              type="button"
              title="Menu"
              aria-label="Menu"
              onClick={() => setSidebarOpen((value) => !value)}
            >
              <Icon name="menu" />
            </button>
            <div className="title-wrap">
              <input
                className="chat-title-input"
                aria-label="Judul chat"
                value={activeConversation.title || "Chat baru"}
                onChange={(event) => updateChatTitle(event.target.value)}
              />
              <div className="chat-meta">{activeConversation.messages.length} pesan</div>
            </div>
            <div className="top-actions">
              <select className="model-select hidden" aria-label="Model AI" value={state.settings.model} readOnly>
                <option value={state.settings.model}>{state.settings.model || "Model"}</option>
              </select>
              <button className="icon-button" type="button" title="Regenerate" aria-label="Regenerate" onClick={regenerateLast} disabled={isBusy}>
                <Icon name="refresh" />
              </button>
              <button className="icon-button" type="button" title="Export" aria-label="Export" onClick={exportConversation}>
                <Icon name="download" />
              </button>
              <button className="icon-button" type="button" title="Tema" aria-label="Tema" onClick={toggleTheme}>
                <Icon name="sun" />
              </button>
            </div>
          </header>

          <section className="messages" ref={messagesRef} aria-live="polite">
            {activeConversation.messages.length ? (
              activeConversation.messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <div className="avatar">{message.role === "user" ? "U" : "AI"}</div>
                  <div className="bubble">
                    <div className="message-header">
                      <div className="role">{message.role === "user" ? "Anda" : "Asisten"}</div>
                      <div className="message-actions">
                        <button
                          className="message-action"
                          type="button"
                          title="Copy"
                          aria-label="Copy pesan"
                          onClick={() => copyText(message.content)}
                        >
                          <Icon name="copy" />
                        </button>
                      </div>
                    </div>
                    <div
                      className="message-content"
                      onClick={handleMessageContentClick}
                      dangerouslySetInnerHTML={{
                        __html:
                          message.role === "assistant" && !message.content && message.id === activeAssistantId
                            ? '<div class="typing"><span></span><span></span><span></span></div>'
                            : renderMarkdown(message.content)
                      }}
                    />
                  </div>
                </article>
              ))
            ) : (
              <EmptyState onPickSuggestion={(value) => {
                setPrompt(value);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }} />
            )}
          </section>

          <footer className="composer-wrap">
            <form className="composer" onSubmit={sendPrompt}>
              <textarea
                ref={textareaRef}
                rows="1"
                placeholder="Tulis kebutuhan kerja di sini..."
                autoComplete="off"
                value={prompt}
                disabled={isBusy}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendPrompt(event);
                  }
                }}
              />
              <button
                className={`send-button${isBusy ? " hidden" : ""}`}
                type="submit"
                aria-label="Kirim"
                disabled={!prompt.trim()}
              >
                <Icon name="send" />
              </button>
              <button
                className={`send-button${isBusy ? "" : " hidden"}`}
                type="button"
                aria-label="Stop"
                onClick={stopGeneration}
              >
                <Icon name="stop" />
              </button>
            </form>
            <div className="status-line">{status}</div>
          </footer>
        </main>
      </div>

      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </>
  );
}

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function fetchJson(path, init) {
  const response = await fetch(apiUrl(path), init);
  if (!response.ok) {
    const error = await readJsonResponse(response).catch(() => ({}));
    throw new Error(error.error || "Koneksi API gagal.");
  }

  return readJsonResponse(response);
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(API_BACKEND_MISSING_MESSAGE);
  }

  return response.json();
}

function EmptyState({ onPickSuggestion }) {
  return (
    <div className="empty-state">
      <div className="empty-block">
        <div className="assistant-kicker">AlphaCodes AI</div>
        <h1>Apa yang sedang dikerjakan?</h1>
        <p>Pilih contoh di bawah atau tulis kebutuhan kamu langsung.</p>
        <div className="suggestions">
          {suggestions.map((suggestion) => (
            <button
              className="suggestion"
              type="button"
              key={suggestion.title}
              onClick={() => onPickSuggestion(suggestion.prompt)}
            >
              <span className="suggestion-title">{suggestion.title}</span>
              <span className="suggestion-detail">{suggestion.detail}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Icon({ name }) {
  return (
    <svg>
      <use href={`#icon-${name}`} />
    </svg>
  );
}

function IconDefinitions() {
  return (
    <svg className="icon-defs" aria-hidden="true">
      <symbol id="icon-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
      <symbol id="icon-send" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></symbol>
      <symbol id="icon-stop" viewBox="0 0 24 24"><path d="M8 8h8v8H8z" /></symbol>
      <symbol id="icon-trash" viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></symbol>
      <symbol id="icon-copy" viewBox="0 0 24 24"><path d="M8 8h11v11H8z" /><path d="M5 16H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></symbol>
      <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /></symbol>
      <symbol id="icon-download" viewBox="0 0 24 24"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></symbol>
      <symbol id="icon-sun" viewBox="0 0 24 24"><path d="M12 4V2" /><path d="M12 22v-2" /><path d="m4.93 4.93-1.41-1.41" /><path d="m20.48 20.48-1.41-1.41" /><path d="M4 12H2" /><path d="M22 12h-2" /><path d="m4.93 19.07-1.41 1.41" /><path d="m20.48 3.52-1.41 1.41" /><path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" /></symbol>
      <symbol id="icon-menu" viewBox="0 0 24 24"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></symbol>
    </svg>
  );
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

function buildRequestMessages(messages) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }));
}

function updateConversation(state, conversationId, updater) {
  return {
    ...state,
    conversations: state.conversations.map((conversation) =>
      conversation.id === conversationId ? updater(conversation) : conversation
    )
  };
}

function updateMessage(state, conversationId, messageId, updater) {
  return updateConversation(state, conversationId, (conversation) => ({
    ...conversation,
    updatedAt: Date.now(),
    messages: conversation.messages.map((message) =>
      message.id === messageId ? updater(message) : message
    )
  }));
}

function getActiveConversation(state) {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || state.conversations[0];
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
    const conversations = Array.isArray(parsed.conversations) && parsed.conversations.length
      ? parsed.conversations
      : [createConversation()];
    return {
      conversations,
      activeId: parsed.activeId || conversations[0].id,
      models: [],
      settings: { ...defaultSettings, ...(parsed.settings || {}) }
    };
  } catch {
    const conversation = createConversation();
    return {
      conversations: [conversation],
      activeId: conversation.id,
      models: [],
      settings: { ...defaultSettings }
    };
  }
}

function saveState(state) {
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

  const chunks = safe.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
  let html = chunks
    .map((chunk) => {
      if (chunk.startsWith(tokenPrefix)) return chunk;
      if (/^<h[1-3]>/.test(chunk)) return chunk;

      const lines = chunk.split(/\n/);
      const listLines = lines.filter((line) => /^[-*]\s+/.test(line));
      if (listLines.length && listLines.length === lines.length) {
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

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
