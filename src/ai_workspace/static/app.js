import { WorkspaceApi, conversationMessages } from "./api.js";

const $ = (id) => document.getElementById(id);
const state = {
  user: null, conversations: [], messages: [], active: null, provider: undefined,
  sending: false, preparing: false, loading: false, historyFailed: false, authBusy: false, providerBusy: false, historyError: "",
  model: "", effort: "", authMode: "login", settingsTab: "account", session: 0, read: 0,
  providerRead: 0, historyRead: 0,
};
const api = new WorkspaceApi(expireSession);
let toastTimer;

try {
  state.model = localStorage.getItem("workspace-model") || "";
  state.effort = localStorage.getItem("workspace-effort") || "";
} catch { /* Preferences are optional. */ }
if (!["", "none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(state.effort)) state.effort = "";

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (className) svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5000);
}

function feedback(id, message = "", success = false) {
  $(id).textContent = message;
  $(id).hidden = !message;
  $(id).classList.toggle("success", success);
}

function notice(message = "") {
  $("chat-notice").textContent = message;
  $("chat-notice").hidden = !message;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function showSidebar(show) {
  $("sidebar").hidden = !show;
  $("expand-sidebar").hidden = show && !matchMedia("(max-width: 760px)").matches;
  $("sidebar-scrim").hidden = !show || !matchMedia("(max-width: 760px)").matches;
}

function closeMobileSidebar() {
  if (matchMedia("(max-width: 760px)").matches) showSidebar(false);
}

function updateControls() {
  $("send-button").disabled = state.sending || state.preparing || state.loading || state.historyFailed || !$("message-input").value.trim();
  $("message-input").disabled = state.sending || state.preparing || state.loading || state.historyFailed;
  $("model-button").disabled = state.sending;
  $("new-chat").disabled = state.sending;
  $("refresh-history").disabled = state.sending || state.loading || !state.user;
  $("logout-button").disabled = state.sending || state.providerBusy;
  document.querySelectorAll(".history-item").forEach((node) => { node.disabled = state.sending; });
  $("send-button").replaceChildren(state.sending ? element("span", "spinner") : icon("arrow"));
  $("send-button").setAttribute("aria-label", state.sending ? "正在生成回复" : "发送消息");
}

function updateModel() {
  $("model-label").textContent = state.model || "选择模型";
  $("model-button").title = state.model ? `${state.model} · ${state.effort || "模型默认"}` : "设置 OpenRouter 模型";
}

function renderHistory() {
  const container = $("history-list");
  container.replaceChildren();
  const conversations = state.conversations;
  if (!conversations.length) {
    const empty = element("div", "history-empty");
    empty.append(icon("chat"), element("p", "", state.historyError || (!state.user ? "登录后，你的对话会出现在这里" : "还没有对话，从一个想法开始吧")));
    if (state.historyError) {
      const retry = element("button", "text-button", "重新加载");
      retry.addEventListener("click", refreshHistory);
      empty.append(retry);
    }
    container.append(empty);
    return;
  }
  for (const conversation of conversations) {
    const button = element("button", `history-item${conversation.id === state.active?.id ? " active" : ""}`);
    button.type = "button";
    button.title = conversation.title;
    button.disabled = state.sending;
    if (conversation.id === state.active?.id) button.setAttribute("aria-current", "true");
    button.append(icon("chat"), element("span", "", conversation.title));
    button.addEventListener("click", () => openConversation(conversation));
    container.append(button);
  }
}

function renderAccount() {
  const user = state.user;
  $("header-login").hidden = !!user;
  $("account-name").textContent = user ? user.email.split("@")[0] : "登录 Workspace";
  $("account-caption").textContent = user ? "个人账户" : "保存对话，继续灵感";
  $("account-avatar").replaceChildren(user ? document.createTextNode(user.email.slice(0, 2).toUpperCase()) : icon("user"));
  if (!user) return;
  $("settings-avatar").textContent = user.email.slice(0, 2).toUpperCase();
  $("settings-email").textContent = user.email;
  $("detail-email").textContent = user.email;
  $("detail-id").textContent = user.id;
  $("detail-created").textContent = formatDate(user.created_at);
  $("detail-status").textContent = user.is_active ? "已激活" : "未激活";
}

function renderProvider() {
  const configured = !!state.provider;
  $("provider-dot").classList.toggle("connected", configured);
  $("header-dot").classList.toggle("connected", configured);
  $("connection-card").hidden = configured;
  $("provider-status").textContent = configured ? "已配置" : state.provider === null ? "未配置" : "状态待确认";
  $("provider-status").classList.toggle("neutral", !configured);
  $("configured-key-info").hidden = !configured;
  $("key-description").textContent = configured ? "已保存密钥。输入新密钥可更新连接，旧密钥不会回显。" : "密钥加密保存在服务端，保存后不会回显。";
  $("api-key").placeholder = configured ? "输入新密钥以替换已保存的密钥" : "sk-or-v1-…";
  $("save-key").textContent = configured ? "更新密钥" : "保存密钥";
  if (configured) $("key-updated").textContent = `最近更新于 ${formatDate(state.provider.updated_at)}`;
}

// Render a small Markdown subset with DOM nodes; user and model text never become HTML.
function renderText(container, text) {
  const parts = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("```")) {
      const pre = element("pre");
      const content = part.replace(/^```[^\n]*\n/, "").replace(/```$/, "");
      pre.append(element("code", "", content));
      container.append(pre);
      continue;
    }
    let paragraph = [];
    let list;
    const flush = () => {
      if (paragraph.length) container.append(element("p", "", paragraph.join("\n")));
      paragraph = [];
      list = undefined;
    };
    for (const line of part.split("\n")) {
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (heading) {
        flush();
        container.append(element(`h${heading[1].length + 1}`, "", heading[2]));
      } else if (bullet) {
        if (!list) {
          flush();
          list = element(/^\s*\d/.test(line) ? "ol" : "ul");
          container.append(list);
        }
        list.append(element("li", "", bullet[1]));
      } else if (!line.trim()) flush();
      else {
        if (list) flush();
        paragraph.push(line);
      }
    }
    flush();
  }
}

function assistantHeading() {
  const heading = element("div", "assistant-heading");
  const mark = element("span", "brand-mark");
  mark.append(icon("spark"));
  heading.append(mark, element("span", "", "Workspace"));
  return heading;
}

function renderMessages() {
  const container = $("messages");
  container.replaceChildren();
  for (const message of state.messages) {
    const node = element("article", `message ${message.role === "user" ? "user" : "assistant"}`);
    if (message.role === "user") node.append(element("div", "user-content", message.content));
    else {
      node.append(assistantHeading());
      const content = element("div", "assistant-content");
      renderText(content, message.content);
      const footer = element("div", "message-footer");
      const copy = element("button", "icon-button");
      copy.setAttribute("aria-label", "复制回复");
      copy.title = "复制回复";
      copy.append(icon("copy"));
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(message.content); toast("回复已复制"); }
        catch { toast("无法访问剪贴板，请选择文字后复制。"); }
      });
      footer.append(copy);
      if (message.model) footer.append(element("span", "", message.model));
      if (message.usage?.total_tokens != null) footer.append(element("span", "", `${message.usage.total_tokens} tokens`));
      node.append(content, footer);
    }
    container.append(node);
  }
  if (state.sending) {
    const node = element("article", "message assistant");
    node.append(assistantHeading());
    const thinking = element("div", "thinking");
    const dots = element("span", "thinking-dots");
    dots.append(element("i"), element("i"), element("i"));
    thinking.append(dots, element("span", "", "正在思考，请稍候…"));
    node.append(thinking);
    container.append(node);
  }
  if (!state.messages.length && !state.sending && state.active) container.append(element("div", "loading-state", "从第一条消息开始这段对话。"));
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function showChat() {
  $("settings-view").hidden = true;
  $("chat-view").hidden = false;
  const hasConversation = !!state.active || state.sending || state.messages.length > 0;
  $("welcome").hidden = hasConversation;
  $("messages").hidden = !hasConversation;
  $("conversation-heading").hidden = !hasConversation;
  $("conversation-title").textContent = state.active?.title || "新对话";
  closeMobileSidebar();
}

function newChat() {
  if (state.sending) return;
  state.read++;
  state.loading = false;
  state.historyFailed = false;
  state.active = null;
  state.messages = [];
  $("message-input").value = "";
  resizeInput();
  notice();
  showChat();
  renderHistory();
  renderMessages();
  updateControls();
  $("message-input").focus();
}

async function openConversation(conversation) {
  if (state.sending || !state.user) return;
  const read = ++state.read;
  const session = state.session;
  state.active = conversation;
  state.messages = [];
  state.loading = true;
  state.historyFailed = false;
  $("message-input").value = "";
  resizeInput();
  notice();
  showChat();
  renderHistory();
  updateControls();
  const loading = element("div", "loading-state", "正在加载对话…");
  loading.prepend(element("span", "spinner"));
  $("messages").replaceChildren(loading);
  try {
    const detail = await api.conversation(conversation.id);
    if (read !== state.read || session !== state.session) return;
    state.messages = conversationMessages(detail);
    renderMessages();
  } catch (error) {
    if (read !== state.read || session !== state.session) return;
    $("messages").replaceChildren();
    notice(`${error.message} 点击左侧对话可重新加载。`);
    // Do not send against an incomplete history view after a failed read.
    state.historyFailed = true;
  } finally {
    if (read === state.read && session === state.session) {
      state.loading = false;
      updateControls();
    }
  }
}

async function refreshHistory() {
  if (!state.user || state.sending) return;
  const session = state.session;
  const read = ++state.historyRead;
  $("refresh-history").disabled = true;
  try {
    const conversations = await api.conversations();
    if (session !== state.session || read !== state.historyRead) return;
    state.conversations = conversations;
    state.historyError = "";
    renderHistory();
  } catch (error) {
    if (session !== state.session || read !== state.historyRead) return;
    state.historyError = error.message;
    renderHistory();
    toast(error.message);
  } finally { updateControls(); }
}

async function loadProvider() {
  const session = state.session;
  const read = ++state.providerRead;
  try {
    const credential = await api.credential();
    if (session !== state.session || read !== state.providerRead) return;
    state.provider = credential;
    feedback("provider-feedback");
  } catch (error) {
    if (session !== state.session || read !== state.providerRead) return;
    if (error.status === 404) {
      state.provider = null;
      feedback("provider-feedback");
    } else {
      state.provider = undefined;
      feedback("provider-feedback", `${error.message} 重新打开 API 连接可重试。`);
    }
  }
  if (session === state.session && read === state.providerRead) renderProvider();
}

function showSettings(tab) {
  if (!state.user) { openAuth(); return; }
  state.settingsTab = tab;
  $("chat-view").hidden = true;
  $("settings-view").hidden = false;
  $("account-settings").hidden = tab !== "account";
  $("provider-settings").hidden = tab !== "provider";
  $("account-tab").classList.toggle("active", tab === "account");
  $("provider-tab").classList.toggle("active", tab === "provider");
  closeMobileSidebar();
  if (tab === "provider" && state.provider === undefined && !state.providerBusy) void loadProvider();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === "register";
  $("auth-title").textContent = registering ? "让想法有个家" : "欢迎回来";
  $("auth-description").textContent = registering ? "创建账户，开始你的第一段对话。" : "登录，继续你的想法。";
  $("auth-submit").textContent = registering ? "创建账户" : "登录";
  $("auth-switch-description").textContent = registering ? "已经有账户？" : "还没有账户？";
  $("auth-switch").textContent = registering ? "立即登录" : "创建账户";
  $("auth-password").autocomplete = registering ? "new-password" : "current-password";
  feedback("auth-feedback");
}

function openAuth() {
  if (state.user) return;
  closeMobileSidebar();
  if (!$("auth-dialog").open) $("auth-dialog").showModal();
}

function clearSession() {
  state.session++;
  state.read++;
  api.setToken("");
  state.user = null;
  state.provider = undefined;
  state.conversations = [];
  state.historyError = "";
  state.messages = [];
  state.active = null;
  state.loading = false;
  state.historyFailed = false;
  state.sending = false;
  state.preparing = false;
  $("auth-password").value = "";
  $("api-key").value = "";
  $("api-key").type = "password";
  $("toggle-key").textContent = "显示";
  $("confirm-dialog").close();
  feedback("provider-feedback");
  renderAccount();
  renderProvider();
  renderHistory();
  showChat();
  renderMessages();
  updateControls();
}

function expireSession() {
  clearSession();
  notice("登录已过期，请重新登录后继续。未发送的文字仍在输入框中。");
  openAuth();
}

async function authenticate(event) {
  event.preventDefault();
  if (state.authBusy) return;
  state.authBusy = true;
  $("auth-submit").disabled = true;
  $("auth-switch").disabled = true;
  $("auth-email").readOnly = true;
  $("auth-password").readOnly = true;
  feedback("auth-feedback");
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  try {
    if (state.authMode === "register") {
      await api.register(email, password);
      setAuthMode("login");
      feedback("auth-feedback", "账户已创建，正在登录…", true);
    }
    const { access_token } = await api.login(email, password);
    api.setToken(access_token);
    state.user = await api.me();
    state.session++;
    $("auth-password").value = "";
    $("auth-dialog").close();
    renderAccount();
    notice();
    toast("已登录，欢迎回来");
    await Promise.allSettled([refreshHistory(), loadProvider()]);
  } catch (error) {
    feedback("auth-feedback", error.message);
  } finally {
    state.authBusy = false;
    $("auth-submit").disabled = false;
    $("auth-switch").disabled = false;
    $("auth-email").readOnly = false;
    $("auth-password").readOnly = false;
    updateControls();
  }
}

function resizeInput() {
  const input = $("message-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(180, Math.max(51, input.scrollHeight))}px`;
}

async function sendMessage(event) {
  event.preventDefault();
  const content = $("message-input").value;
  if (state.sending || state.preparing || state.loading || state.historyFailed || !content.trim()) return;
  if (!state.user) { openAuth(); return; }
  if (state.provider === undefined) {
    state.preparing = true;
    updateControls();
    try { await loadProvider(); }
    finally { state.preparing = false; updateControls(); }
  }
  if (!state.user) return;
  if (!state.provider) {
    showSettings("provider");
    toast(state.provider === null ? "先连接 OpenRouter，即可开始对话" : "无法确认 API 连接，请检查网络后重试");
    return;
  }
  if (!state.model) { openModel(); return; }
  const session = state.session;
  state.sending = true;
  notice();
  const previousMessages = [...state.messages];
  state.messages.push({ role: "user", content });
  $("message-input").value = "";
  resizeInput();
  showChat();
  renderMessages();
  updateControls();
  let completed = false;
  try {
    if (!state.active) {
      state.active = await api.create(content.trim().replace(/\s+/g, " ").slice(0, 60));
      if (session !== state.session) return;
      state.conversations.unshift(state.active);
      state.historyRead++;
      renderHistory();
      $("conversation-title").textContent = state.active.title;
    }
    const result = await api.chat(state.active.id, state.model, content, state.effort);
    if (session !== state.session) return;
    completed = true;
    state.messages.push({ role: "assistant", ...result });
    state.active.updated_at = new Date().toISOString();
    state.conversations = [state.active, ...state.conversations.filter((item) => item.id !== state.active.id)];
    state.historyRead++;
    renderHistory();
  } catch (error) {
    if (session !== state.session) {
      $("message-input").value = content;
      resizeInput();
      return;
    }
    state.messages = previousMessages;
    $("message-input").value = content;
    resizeInput();
    notice(error.network ? "连接中断，消息可能已在服务端完成。请先点击左侧当前对话检查结果，再决定是否重发。" : error.message);
  } finally {
    if (session === state.session) {
      state.sending = false;
      renderMessages();
      updateControls();
      if (completed) $("message-input").focus();
    }
  }
}

function openModel() {
  $("model-input").value = state.model;
  $("reasoning-select").value = state.effort;
  $("model-dialog").showModal();
}

function setProviderBusy(busy) {
  state.providerBusy = busy;
  $("save-key").disabled = busy;
  $("remove-key").disabled = busy;
  $("confirm-remove-key").disabled = busy;
  $("api-key").disabled = busy;
  updateControls();
}

async function saveKey(event) {
  event.preventDefault();
  if (state.providerBusy || !state.user) return;
  const key = $("api-key").value.trim();
  if (!key) return;
  const session = state.session;
  state.providerRead++;
  setProviderBusy(true);
  feedback("provider-feedback");
  try {
    const credential = await api.saveKey(key);
    if (session !== state.session) return;
    state.provider = credential;
    $("api-key").value = "";
    $("api-key").type = "password";
    $("toggle-key").textContent = "显示";
    renderProvider();
    feedback("provider-feedback", "密钥已加密保存。返回对话并选择模型，即可开始。", true);
    toast("OpenRouter 连接已保存");
  } catch (error) {
    if (session === state.session) feedback("provider-feedback", error.message);
  } finally { setProviderBusy(false); }
}

async function removeKey() {
  if (state.providerBusy || !state.user) return;
  const session = state.session;
  state.providerRead++;
  setProviderBusy(true);
  try {
    await api.removeKey();
    if (session !== state.session) return;
    state.provider = null;
    $("api-key").value = "";
    feedback("provider-feedback");
    renderProvider();
    $("confirm-dialog").close();
    toast("API 密钥已移除");
  } catch (error) {
    $("confirm-dialog").close();
    if (session === state.session) feedback("provider-feedback", error.message);
  } finally { setProviderBusy(false); }
}

$("new-chat").addEventListener("click", newChat);
$("collapse-sidebar").addEventListener("click", () => showSidebar(false));
$("expand-sidebar").addEventListener("click", () => showSidebar(true));
$("sidebar-scrim").addEventListener("click", () => showSidebar(false));
$("header-login").addEventListener("click", openAuth);
$("account-button").addEventListener("click", () => state.user ? showSettings("account") : openAuth());
$("provider-nav").addEventListener("click", () => showSettings("provider"));
$("connect-shortcut").addEventListener("click", () => showSettings("provider"));
$("account-tab").addEventListener("click", () => showSettings("account"));
$("provider-tab").addEventListener("click", () => showSettings("provider"));
$("back-to-chat").addEventListener("click", showChat);
$("refresh-history").addEventListener("click", refreshHistory);
$("auth-switch").addEventListener("click", () => setAuthMode(state.authMode === "login" ? "register" : "login"));
$("auth-form").addEventListener("submit", authenticate);
$("auth-dialog").addEventListener("cancel", (event) => { if (state.authBusy) event.preventDefault(); });
$("auth-dialog").addEventListener("close", () => { $("auth-password").value = ""; });
$("model-button").addEventListener("click", openModel);
$("model-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const model = $("model-input").value.trim();
  if (!model) { $("model-input").focus(); return; }
  state.model = model;
  state.effort = $("reasoning-select").value;
  try { localStorage.setItem("workspace-model", model); localStorage.setItem("workspace-effort", state.effort); } catch { /* Optional preferences. */ }
  updateModel();
  $("model-dialog").close();
  $("message-input").focus();
});
$("chat-form").addEventListener("submit", sendMessage);
$("message-input").addEventListener("input", () => { resizeInput(); updateControls(); });
$("message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) { event.preventDefault(); newChat(); }
  if (event.key === "Escape") closeMobileSidebar();
});
document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => {
  $("message-input").value = button.dataset.prompt;
  resizeInput();
  updateControls();
  $("message-input").focus();
}));
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.close === "auth-dialog" && state.authBusy) return;
  $(button.dataset.close).close();
}));
$("provider-form").addEventListener("submit", saveKey);
$("toggle-key").addEventListener("click", () => {
  const show = $("api-key").type === "password";
  $("api-key").type = show ? "text" : "password";
  $("toggle-key").textContent = show ? "隐藏" : "显示";
  $("toggle-key").setAttribute("aria-label", show ? "隐藏密钥" : "显示密钥");
});
$("remove-key").addEventListener("click", () => $("confirm-dialog").showModal());
$("confirm-remove-key").addEventListener("click", removeKey);
$("logout-button").addEventListener("click", () => {
  if (state.sending || state.providerBusy) return;
  clearSession();
  $("message-input").value = "";
  resizeInput();
  notice();
  toast("已退出登录");
});
const mobileMedia = matchMedia("(max-width: 760px)");
mobileMedia.addEventListener("change", () => showSidebar(!mobileMedia.matches));

async function boot() {
  renderAccount();
  renderHistory();
  renderProvider();
  updateModel();
  updateControls();
  showSidebar(!mobileMedia.matches);
  if (!api.token) return;
  const session = state.session;
  const token = api.token;
  $("header-login").disabled = true;
  try {
    const user = await api.me();
    if (session !== state.session || token !== api.token) return;
    state.user = user;
    renderAccount();
    await Promise.allSettled([refreshHistory(), loadProvider()]);
  } catch (error) {
    if (error.status !== 401) toast(`${error.message} 可重新登录以恢复会话。`);
  } finally { $("header-login").disabled = false; updateControls(); }
}

void boot();
