import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const STORE_KEY = "alphacodes-chat-ai:v3";
const WEB_MODE_KEY = "alphacodes-chat-ai:web-mode:v1";
const ADMIN_PATH = "/admin";
const RESTRICTION_PATH = "/pembatasan";
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
  const [route, setRoute] = useState(getRoute);
  const [webMode, setWebMode] = useState(loadWebMode);
  const [adminSession, setAdminSession] = useState({ status: "checking", authenticated: false, username: "" });
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
  const isAdminRoute = route === "admin";
  const isRestrictedRoute = route === "restricted";
  const isRestrictionActive = Boolean(webMode.restricted);

  const activeConversation = useMemo(
    () => getActiveConversation(state),
    [state]
  );
  const selectedModelInfo = useMemo(
    () => describeModel(state.settings.model),
    [state.settings.model]
  );
  const modelFeaturePack = useMemo(
    () => getModelFeaturePack(selectedModelInfo),
    [selectedModelInfo]
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
    if (!isAdminRoute && !isRestrictedRoute && !isRestrictionActive) {
      loadConfigAndModels();
    }
  }, [isAdminRoute, isRestrictedRoute, isRestrictionActive]);

  useEffect(() => {
    if (!isAdminRoute) return;
    let cancelled = false;

    async function checkSession() {
      setAdminSession((prev) => ({ ...prev, status: "checking" }));
      try {
        const data = await fetchJson("/api/admin/session");
        if (!cancelled) {
          setAdminSession({
            status: "ready",
            authenticated: Boolean(data.authenticated),
            username: data.username || ""
          });
        }
      } catch {
        if (!cancelled) {
          setAdminSession({ status: "ready", authenticated: false, username: "" });
        }
      }
    }

    checkSession();
    return () => {
      cancelled = true;
    };
  }, [isAdminRoute]);

  useEffect(() => {
    function handlePopState() {
      setRoute(getRoute());
    }

    function handleStorage(event) {
      if (event.key === WEB_MODE_KEY) {
        const nextMode = loadWebMode();
        setWebMode(nextMode);
        if (nextMode.restricted && getRoute() === "chat") {
          setRoute("restricted");
          window.history.replaceState({}, "", RESTRICTION_PATH);
        } else if (!nextMode.restricted && getRoute() === "restricted") {
          setRoute("chat");
          window.history.replaceState({}, "", "/");
        }
      }
    }

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("storage", handleStorage);
    };
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

  function selectModel(model) {
    setState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        model
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

  function navigateTo(path) {
    window.history.pushState({}, "", path);
    setRoute(getRoute());
    setSidebarOpen(false);
  }

  function updateRestrictionMode(restricted) {
    const nextMode = {
      restricted,
      updatedAt: Date.now()
    };
    saveWebMode(nextMode);
    setWebMode(nextMode);
    navigateTo(restricted ? RESTRICTION_PATH : "/");
  }

  async function loginAdmin(credentials) {
    const data = await fetchJson("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials)
    });
    setAdminSession({
      status: "ready",
      authenticated: Boolean(data.authenticated),
      username: data.username || ""
    });
  }

  async function logoutAdmin() {
    await fetchJson("/api/admin/logout", { method: "POST" }).catch(() => ({}));
    setAdminSession({ status: "ready", authenticated: false, username: "" });
  }

  if (isAdminRoute) {
    return (
      <>
        <IconDefinitions />
        {adminSession.status === "checking" ? (
          <AdminLoading onOpenChat={() => navigateTo(isRestrictionActive ? RESTRICTION_PATH : "/")} />
        ) : adminSession.authenticated ? (
          <AdminPanel
            webMode={webMode}
            username={adminSession.username}
            onEnableRestriction={() => updateRestrictionMode(true)}
            onDisableRestriction={() => updateRestrictionMode(false)}
            onOpenChat={() => navigateTo(isRestrictionActive ? RESTRICTION_PATH : "/")}
            onLogout={logoutAdmin}
          />
        ) : (
          <AdminLogin
            onLogin={loginAdmin}
            onOpenChat={() => navigateTo(isRestrictionActive ? RESTRICTION_PATH : "/")}
          />
        )}
      </>
    );
  }

  if (isRestrictionActive || isRestrictedRoute) {
    return (
      <>
        <IconDefinitions />
        <RestrictionPage onOpenAdmin={() => navigateTo(ADMIN_PATH)} />
      </>
    );
  }

  return (
    <>
      <IconDefinitions />
      <div className="app-shell">
        {sidebarOpen && (
          <button
            className="sidebar-backdrop mobile-only"
            type="button"
            aria-label="Tutup menu"
            onClick={() => setSidebarOpen(false)}
          />
        )}
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
            <div className="connection-state">
              <div className={`connection-dot ${connection.status === "ok" ? "ok" : connection.status === "bad" ? "bad" : ""}`} />
              <span>{connection.text}</span>
            </div>
            <button className="footer-admin" type="button" onClick={() => navigateTo(ADMIN_PATH)}>
              <Icon name="lock" />
              <span>Admin</span>
            </button>
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
              <ModelPicker
                models={state.models}
                value={state.settings.model}
                disabled={isBusy || !state.models.length}
                onSelect={selectModel}
              />
              <button className="icon-button secondary-action" type="button" title="Regenerate" aria-label="Regenerate" onClick={regenerateLast} disabled={isBusy}>
                <Icon name="refresh" />
              </button>
              <button className="icon-button secondary-action" type="button" title="Export" aria-label="Export" onClick={exportConversation}>
                <Icon name="download" />
              </button>
              <button className="icon-button theme-action" type="button" title="Tema" aria-label="Tema" onClick={toggleTheme}>
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
              <EmptyState modelFeaturePack={modelFeaturePack} onPickSuggestion={(value) => {
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

function AdminLoading({ onOpenChat }) {
  return (
    <main className="admin-shell">
      <div className="admin-top">
        <button className="admin-brand" type="button" onClick={onOpenChat}>
          <span className="brand-mark">AC</span>
          <span>
            <span className="brand-name">AlphaCodes</span>
            <span className="brand-subtitle">Admin Panel</span>
          </span>
        </button>
      </div>
      <section className="admin-card admin-card-main">
        <div className="admin-status normal">
          <span className="admin-status-dot" />
          <span>Memeriksa sesi</span>
        </div>
        <h1>Admin Panel</h1>
        <p>Sedang memeriksa akses admin.</p>
      </section>
    </main>
  );
}

function AdminLogin({ onLogin, onOpenChat }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitLogin(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onLogin({ username, password });
    } catch (loginError) {
      setError(loginError.message || "Login gagal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-shell">
      <div className="admin-top">
        <button className="admin-brand" type="button" onClick={onOpenChat}>
          <span className="brand-mark">AC</span>
          <span>
            <span className="brand-name">AlphaCodes</span>
            <span className="brand-subtitle">Admin Panel</span>
          </span>
        </button>
        <button className="admin-secondary compact" type="button" onClick={onOpenChat}>
          Buka web
        </button>
      </div>

      <section className="admin-card admin-card-main admin-login-card">
        <div className="admin-status">
          <span className="admin-status-dot" />
          <span>Login admin</span>
        </div>
        <h1>Masuk Admin</h1>
        <p>Masukkan ID dan password admin untuk mengatur mode pembatasan.</p>

        <form className="admin-login-form" onSubmit={submitLogin}>
          <label>
            <span>ID admin</span>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <div className="admin-error">{error}</div>}
          <button className="primary-action admin-primary" type="submit" disabled={busy || !username.trim() || !password}>
            <Icon name="lock" />
            <span>{busy ? "Memeriksa..." : "Login"}</span>
          </button>
        </form>
      </section>
    </main>
  );
}

function AdminPanel({ webMode, username, onEnableRestriction, onDisableRestriction, onOpenChat, onLogout }) {
  const restricted = Boolean(webMode.restricted);

  return (
    <main className="admin-shell">
      <div className="admin-top">
        <button className="admin-brand" type="button" onClick={onOpenChat}>
          <span className="brand-mark">AC</span>
          <span>
            <span className="brand-name">AlphaCodes</span>
            <span className="brand-subtitle">Admin Panel</span>
          </span>
        </button>
        <button className="admin-secondary compact" type="button" onClick={onOpenChat}>
          Buka web
        </button>
      </div>

      <section className="admin-card admin-card-main">
        <div className={`admin-status ${restricted ? "restricted" : "normal"}`}>
          <span className="admin-status-dot" />
          <span>{restricted ? "Pembatasan aktif" : "Mode normal"}</span>
        </div>
        <h1>Admin Panel</h1>
        <p>Atur mode akses web chat AI dari satu tempat.</p>
        <div className="admin-user-row">
          <span>Login sebagai</span>
          <strong>{username || "Admin"}</strong>
          <button className="admin-secondary compact" type="button" onClick={onLogout}>
            Logout
          </button>
        </div>

        <div className="admin-control">
          <div>
            <div className="admin-control-title">Mode web</div>
            <div className="admin-control-copy">
              Saat pembatasan aktif, halaman chat otomatis diganti menjadi halaman bertuliskan pembatasan.
            </div>
          </div>
          <div className={`admin-switch ${restricted ? "on" : ""}`} aria-hidden="true">
            <span />
          </div>
        </div>

        <div className="admin-actions">
          <button
            className="primary-action admin-primary"
            type="button"
            disabled={restricted}
            onClick={onEnableRestriction}
          >
            <Icon name="lock" />
            <span>Aktifkan pembatasan</span>
          </button>
          <button
            className="admin-secondary"
            type="button"
            disabled={!restricted}
            onClick={onDisableRestriction}
          >
            Matikan pembatasan
          </button>
        </div>
      </section>

      <section className="admin-card admin-detail">
        <h2>Status</h2>
        <div className="admin-detail-grid">
          <div>
            <span>Mode</span>
            <strong>{restricted ? "Pembatasan" : "Normal"}</strong>
          </div>
          <div>
            <span>Terakhir diubah</span>
            <strong>{formatAdminTime(webMode.updatedAt)}</strong>
          </div>
          <div>
            <span>Halaman tujuan</span>
            <strong>{restricted ? RESTRICTION_PATH : "/"}</strong>
          </div>
        </div>
      </section>
    </main>
  );
}

function RestrictionPage({ onOpenAdmin }) {
  return (
    <main className="restriction-shell">
      <section className="restriction-card">
        <div className="restriction-mark">
          <Icon name="lock" />
        </div>
        <h1>Pembatasan</h1>
        <p>Akses chat AI sedang dibatasi oleh admin.</p>
        <button className="admin-secondary compact" type="button" onClick={onOpenAdmin}>
          Admin panel
        </button>
      </section>
    </main>
  );
}

function EmptyState({ modelFeaturePack, onPickSuggestion }) {
  const activeSuggestions = modelFeaturePack?.suggestions?.length ? modelFeaturePack.suggestions : suggestions;

  return (
    <div className="empty-state">
      <div className="empty-block">
        <div className="assistant-kicker">{modelFeaturePack?.label || "AlphaCodes AI"}</div>
        <h1>{modelFeaturePack?.headline || "Mulai dari bahan mentah."}</h1>
        <p>{modelFeaturePack?.description || "Ringkas, susun, atau rapikan tanpa kehilangan konteks kerja."}</p>
        <div className="suggestions">
          {activeSuggestions.map((suggestion) => (
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

function ModelPicker({ models, value, disabled, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [intent, setIntent] = useState("all");
  const [source, setSource] = useState("all");
  const pickerRef = useRef(null);
  const modelInfos = useMemo(() => models.map((model) => describeModel(model)), [models]);
  const selectedInfo = useMemo(() => describeModel(value), [value]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event) {
      if (!pickerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const filters = useMemo(() => buildModelFilters(modelInfos), [modelInfos]);
  const sourceFilters = useMemo(() => buildProviderFilters(modelInfos), [modelInfos]);
  const filteredModels = useMemo(
    () => filterModelInfos(modelInfos, query, intent, source),
    [modelInfos, query, intent, source]
  );
  const groupedModels = useMemo(() => groupModelsByProvider(filteredModels), [filteredModels]);
  const triggerMeta = selectedInfo.id
    ? `${selectedInfo.providerLabel}, ${selectedInfo.badges.join(", ")}`
    : `${models.length} model tersedia`;

  function pickModel(modelId) {
    onSelect(modelId);
    setOpen(false);
  }

  return (
    <div className={`model-picker${open ? " open" : ""}`} ref={pickerRef}>
      <button
        className="model-trigger"
        type="button"
        aria-label="Pilih model AI"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="model-trigger-copy">
          <span className="model-trigger-title">{selectedInfo.shortName || "Model"}</span>
          <span className="model-trigger-meta">{triggerMeta}</span>
        </span>
        <Icon name="chevron" />
      </button>

      {open && (
        <>
          <button className="model-scrim" type="button" aria-label="Tutup pilihan model" onClick={() => setOpen(false)} />
          <div className="model-panel" role="dialog" aria-label="Pilih model AI">
            <div className="model-panel-head">
              <div>
                <div className="model-panel-title">Model AI</div>
                <div className="model-panel-subtitle">{models.length} model tersedia dari endpoint</div>
              </div>
              <button className="mini-button model-close" type="button" aria-label="Tutup pilihan model" onClick={() => setOpen(false)}>
                <Icon name="x" />
              </button>
            </div>

            <label className="model-search">
              <input
                type="search"
                placeholder="Cari model, provider, atau kemampuan"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>

            <div className="model-filters" role="tablist" aria-label="Filter model">
              {filters.map((filter) => (
                <button
                  className={`model-filter${intent === filter.id ? " active" : ""}`}
                  type="button"
                  key={filter.id}
                  disabled={!filter.count}
                  onClick={() => setIntent(filter.id)}
                >
                  <span>{filter.label}</span>
                  <span>{filter.count}</span>
                </button>
              ))}
            </div>

            <div className="model-filters provider-filters" role="tablist" aria-label="Filter sumber model">
              {sourceFilters.map((filter) => (
                <button
                  className={`model-filter source-filter${source === filter.id ? " active" : ""}`}
                  type="button"
                  key={filter.id}
                  disabled={!filter.count}
                  onClick={() => setSource(filter.id)}
                >
                  <span>{filter.label}</span>
                  <span>{filter.count}</span>
                </button>
              ))}
            </div>

            <div className="model-list">
              {groupedModels.length ? (
                groupedModels.map((group) => (
                  <section className="model-group" key={group.provider}>
                    <div className="model-group-title">
                      <span>{group.label}</span>
                      <span>{group.items.length}</span>
                    </div>
                    <div className="model-options">
                      {group.items.map((model) => (
                        <button
                          className={`model-option${model.id === value ? " selected" : ""}`}
                          type="button"
                          key={model.id}
                          onClick={() => pickModel(model.id)}
                        >
                          <span className="model-option-main">
                            <span className="model-option-name">{model.shortName}</span>
                            <span className="model-option-id">{model.id}</span>
                          </span>
                          <span className="model-option-side">
                            <span className="model-badges">
                              {model.badges.map((badge) => (
                                <span className="model-badge" key={badge}>{badge}</span>
                              ))}
                            </span>
                            {model.id === value && <span className="model-selected"><Icon name="check" /></span>}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))
              ) : (
                <div className="model-empty">Model tidak ditemukan.</div>
              )}
            </div>
          </div>
        </>
      )}
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
      <symbol id="icon-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></symbol>
      <symbol id="icon-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></symbol>
      <symbol id="icon-x" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></symbol>
      <symbol id="icon-lock" viewBox="0 0 24 24"><path d="M7 11V8a5 5 0 0 1 10 0v3" /><path d="M6 11h12v10H6z" /></symbol>
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

function getRoute() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === ADMIN_PATH) return "admin";
  if (path === RESTRICTION_PATH) return "restricted";
  return "chat";
}

function loadWebMode() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WEB_MODE_KEY) || "{}");
    return {
      restricted: Boolean(parsed.restricted),
      updatedAt: Number(parsed.updatedAt) || 0
    };
  } catch {
    return {
      restricted: false,
      updatedAt: 0
    };
  }
}

function saveWebMode(mode) {
  localStorage.setItem(
    WEB_MODE_KEY,
    JSON.stringify({
      restricted: Boolean(mode.restricted),
      updatedAt: Number(mode.updatedAt) || Date.now()
    })
  );
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

function getModelFeaturePack(model) {
  const info = model?.id ? model : describeModel("");
  const has = (badge) => info.badges.includes(badge);

  if (has("Review")) {
    return {
      label: "Mode Review",
      headline: "Audit sebelum ship.",
      description: "Model ini cocok untuk mencari risiko, regresi, dan test gap dari perubahan yang ada.",
      suggestions: [
        {
          title: "Review PR",
          detail: "Bug, risiko, dan test gap",
          prompt: "Review perubahan berikut seperti code reviewer senior. Fokus pada bug, risiko regresi, security, dan test gap:"
        },
        {
          title: "Audit rilis",
          detail: "Checklist sebelum deploy",
          prompt: "Buat audit readiness sebelum rilis dari catatan berikut. Pisahkan blocker, risiko, dan langkah verifikasi:"
        },
        {
          title: "Cari edge case",
          detail: "Kasus yang mudah terlewat",
          prompt: "Cari edge case dan failure mode dari implementasi berikut, lalu beri prioritas per dampak:"
        },
        {
          title: "Ringkas temuan",
          detail: "Komentar siap dikirim",
          prompt: "Ubah temuan review berikut menjadi komentar yang jelas, spesifik, dan mudah ditindaklanjuti:"
        }
      ]
    };
  }

  if (has("Code")) {
    return {
      label: "Mode Code",
      headline: "Kirim bug atau potongan kode.",
      description: "Model ini cocok untuk debug, refactor, review implementasi, dan rencana coding bertahap.",
      suggestions: [
        {
          title: "Debug error",
          detail: "Akar masalah dan fix",
          prompt: "Bantu debug error berikut. Jelaskan akar masalah, file yang perlu dicek, dan patch yang disarankan:"
        },
        {
          title: "Refactor aman",
          detail: "Tetap jaga perilaku",
          prompt: "Refactor kode berikut agar lebih rapi tanpa mengubah perilaku. Jelaskan risiko dan test yang perlu dijalankan:"
        },
        {
          title: "Buat patch",
          detail: "Langkah implementasi",
          prompt: "Ubah kebutuhan berikut menjadi rencana patch kecil yang bisa langsung dikerjakan di repo:"
        },
        {
          title: "Test plan",
          detail: "Unit, integration, manual",
          prompt: "Buat test plan untuk perubahan berikut. Pisahkan unit test, integration test, dan verifikasi manual:"
        }
      ]
    };
  }

  if (has("Agent")) {
    return {
      label: "Mode Agent",
      headline: "Rancang alur kerja otomatis.",
      description: "Model ini cocok untuk tugas multi-step, orkestrasi agent, dan workflow yang perlu keputusan bertahap.",
      suggestions: [
        {
          title: "Rancang agent",
          detail: "Role, tools, guardrail",
          prompt: "Rancang agent untuk kebutuhan berikut. Sertakan role, tool yang dibutuhkan, guardrail, dan alur eksekusi:"
        },
        {
          title: "Workflow kerja",
          detail: "Input, langkah, output",
          prompt: "Ubah proses berikut menjadi workflow agentik dengan input, langkah, kondisi gagal, dan output akhir:"
        },
        {
          title: "Checklist otomasi",
          detail: "Urutan eksekusi jelas",
          prompt: "Buat checklist otomasi dari target berikut. Tandai bagian yang perlu human approval:"
        },
        {
          title: "Evaluasi agent",
          detail: "Tes kualitas output",
          prompt: "Buat kriteria evaluasi untuk agent berikut. Sertakan skenario sukses, gagal, dan contoh input uji:"
        }
      ]
    };
  }

  if (has("Reasoning")) {
    return {
      label: "Mode Reasoning",
      headline: "Pecah masalah kompleks.",
      description: "Model ini cocok untuk arsitektur, trade-off, keputusan teknis, dan rencana eksekusi yang butuh penalaran.",
      suggestions: [
        {
          title: "Bandingkan opsi",
          detail: "Trade-off dan rekomendasi",
          prompt: "Bandingkan opsi berikut. Jelaskan trade-off, risiko, biaya implementasi, dan rekomendasi akhir:"
        },
        {
          title: "Rencana sistem",
          detail: "Arsitektur dan risiko",
          prompt: "Buat rencana arsitektur untuk kebutuhan berikut. Sertakan komponen, data flow, risiko, dan mitigasi:"
        },
        {
          title: "Ambil keputusan",
          detail: "Kriteria dan alasan",
          prompt: "Bantu ambil keputusan dari konteks berikut. Buat kriteria, nilai tiap opsi, lalu simpulkan:"
        },
        {
          title: "Peta risiko",
          detail: "Prioritas dan mitigasi",
          prompt: "Petakan risiko dari rencana berikut. Urutkan berdasarkan dampak dan kemungkinan, lalu beri mitigasi:"
        }
      ]
    };
  }

  if (has("Cepat")) {
    return {
      label: "Mode Cepat",
      headline: "Selesaikan tugas ringan cepat.",
      description: "Model ini cocok untuk ringkasan, draft singkat, klasifikasi, dan editing cepat.",
      suggestions: [
        {
          title: "Ringkas cepat",
          detail: "Poin penting saja",
          prompt: "Ringkas teks berikut menjadi poin penting yang singkat dan mudah dibaca:"
        },
        {
          title: "Draft balasan",
          detail: "Jelas dan sopan",
          prompt: "Buat draft balasan singkat dan profesional untuk konteks berikut:"
        },
        {
          title: "Klasifikasi",
          detail: "Label dan alasan",
          prompt: "Klasifikasikan item berikut, beri label yang konsisten, dan jelaskan alasan singkat:"
        },
        {
          title: "Rapikan teks",
          detail: "Lebih jelas dibaca",
          prompt: "Rapikan teks berikut agar lebih jelas, singkat, dan enak dibaca tanpa mengubah makna:"
        }
      ]
    };
  }

  return {
    label: "AlphaCodes AI",
    headline: "Mulai dari bahan mentah.",
    description: "Ringkas, susun, atau rapikan tanpa kehilangan konteks kerja.",
    suggestions
  };
}

function describeModel(model) {
  const id = typeof model === "string" ? String(model || "").trim() : String(model?.id || "").trim();
  const owner = typeof model === "string" ? "" : String(model?.owned_by || "").trim();
  const parts = id.split("/").filter(Boolean);
  const provider = (parts.length > 1 ? parts[0] : owner).toLowerCase();
  const rawPath = parts.length > 1 ? parts.slice(1).join("/") : id;
  const shortName = parts.length > 2 ? parts[parts.length - 1] : rawPath || id;
  const lower = id.toLowerCase();
  const capabilityBadges = [];
  const family = getModelFamily(lower);

  if (lower.includes("review")) capabilityBadges.push("Review");
  if (/(codex|opencode|code|mimo)/.test(lower)) capabilityBadges.push("Code");
  if (/(flash|mini|lite|free|low|ultraspeed)/.test(lower)) capabilityBadges.push("Cepat");
  if (/(r1|reasoning|thinking|plan|pro|opus|max|large|120b|122b|397b|deepseek|qwen|glm|kimi)/.test(lower)) {
    capabilityBadges.push("Reasoning");
  }
  if (lower.includes("agent")) capabilityBadges.push("Agent");
  if (!capabilityBadges.length) capabilityBadges.push("Chat");

  const badges = family ? [...capabilityBadges, family] : capabilityBadges;
  const providerLabel = getProviderLabel(provider);

  return {
    id,
    provider,
    providerLabel,
    shortName: shortName || id,
    modelPath: rawPath,
    searchable: `${id} ${rawPath} ${providerLabel} ${family || ""} ${badges.join(" ")}`.toLowerCase(),
    badges
  };
}

function buildModelFilters(models) {
  const definitions = [
    { id: "all", label: "Semua", match: () => true },
    { id: "chat", label: "Umum", match: (model) => hasBadge(model, "Chat") },
    { id: "code", label: "Code", match: (model) => hasBadge(model, "Code") },
    { id: "review", label: "Review", match: (model) => hasBadge(model, "Review") },
    { id: "fast", label: "Cepat", match: (model) => hasBadge(model, "Cepat") },
    { id: "reasoning", label: "Reasoning", match: (model) => hasBadge(model, "Reasoning") },
    { id: "agent", label: "Agent", match: (model) => hasBadge(model, "Agent") }
  ];

  return definitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
    count: models.filter(definition.match).length
  }));
}

function buildProviderFilters(models) {
  const counts = new Map();
  for (const model of models) {
    const provider = model.provider || "custom";
    if (!counts.has(provider)) {
      counts.set(provider, {
        id: provider,
        label: model.providerLabel || getProviderLabel(provider),
        count: 0
      });
    }
    counts.get(provider).count += 1;
  }

  return [
    { id: "all", label: "Semua sumber", count: models.length },
    ...[...counts.values()].sort((a, b) => a.label.localeCompare(b.label))
  ];
}

function filterModelInfos(models, query, intent, source = "all") {
  const normalizedQuery = query.trim().toLowerCase();
  const filter = buildModelFilters(models).find((item) => item.id === intent);

  return models.filter((model) => {
    const matchesIntent = !filter || intent === "all" || hasIntent(model, intent);
    const matchesSource = source === "all" || model.provider === source;
    const matchesQuery = !normalizedQuery || model.searchable.includes(normalizedQuery);
    return matchesIntent && matchesSource && matchesQuery;
  });
}

function groupModelsByProvider(models) {
  const groups = new Map();
  for (const model of models) {
    const provider = model.provider || "custom";
    if (!groups.has(provider)) {
      groups.set(provider, {
        provider,
        label: model.providerLabel || getProviderLabel(provider),
        items: []
      });
    }
    groups.get(provider).items.push(model);
  }

  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function hasIntent(model, intent) {
  if (intent === "chat") return hasBadge(model, "Chat");
  if (intent === "code") return hasBadge(model, "Code");
  if (intent === "review") return hasBadge(model, "Review");
  if (intent === "fast") return hasBadge(model, "Cepat");
  if (intent === "reasoning") return hasBadge(model, "Reasoning");
  if (intent === "agent") return hasBadge(model, "Agent");
  return true;
}

function hasBadge(model, badge) {
  return model.badges.includes(badge);
}

function getModelFamily(lowerId) {
  if (lowerId.includes("codex")) return "Codex";
  if (lowerId.includes("opencode")) return "OpenCode";
  if (lowerId.includes("deepseek")) return "DeepSeek";
  if (lowerId.includes("claude")) return "Claude";
  if (lowerId.includes("gemini")) return "Gemini";
  if (lowerId.includes("gpt")) return "GPT";
  if (lowerId.includes("qwen")) return "Qwen";
  if (lowerId.includes("kimi")) return "Kimi";
  if (lowerId.includes("glm") || lowerId.includes("zai-org")) return "GLM";
  if (lowerId.includes("mimo")) return "MiMo";
  if (lowerId.includes("minimax")) return "MiniMax";
  if (lowerId.includes("mistral")) return "Mistral";
  if (lowerId.includes("tencent")) return "Tencent";
  return "";
}

function getProviderLabel(provider) {
  const labels = {
    "9router": "9Router",
    ag: "Antigravity",
    antigravity: "Antigravity",
    cx: "OpenAI Codex",
    gc: "Google Cloud",
    nara: "byNara",
    bynara: "byNara",
    siliconflow: "SiliconFlow",
    sf: "SiliconFlow",
    opencode: "OpenCode Free",
    "opencode-free": "OpenCode Free",
    mimo: "MiMo Code Free",
    "mimo-code-free": "MiMo Code Free",
    openai: "OpenAI"
  };
  return labels[provider] || prettifyProvider(provider) || "Custom";
}

function prettifyProvider(provider) {
  return String(provider || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function formatAdminTime(timestamp) {
  if (!timestamp) return "Belum pernah";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
