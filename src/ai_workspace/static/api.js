const messages = {
  "Invalid email or password": "邮箱或密码不正确，请重新输入。",
  "Email is already registered": "这个邮箱已注册，请直接登录。",
  "User is inactive": "账户未激活，暂时无法登录。",
  "Conversation not found": "这段对话不存在，或你没有访问权限。",
  "Provider credential not configured": "请先在 API 连接中配置 OpenRouter 密钥。",
  "Chat provider request failed": "模型请求失败，请检查密钥、余额以及模型和思考强度是否可用。",
  "Invalid provider credential request": "密钥格式不正确，请重新输入。",
};

export class ApiError extends Error {
  constructor(status, detail) {
    super(messages[detail] || (status === 401 ? "登录已过期，请重新登录。" :
      status === 422 ? "输入格式不正确，请检查后重试。" :
      status === 403 ? "当前账户无法执行此操作。" :
      status === 404 ? "请求的内容不存在。" :
      "服务暂时不可用，请稍后重试。"));
    this.status = status;
  }
}

export function conversationMessages(conversation) {
  return conversation.messages.map((message, index) => ({
    ...(typeof message === "string" ? { content: message } : message),
    role: index % 2 === 0 ? "user" : "assistant",
  }));
}

export class WorkspaceApi {
  constructor(onExpired) {
    this.onExpired = onExpired;
    this.token = "";
    try { this.token = sessionStorage.getItem("workspace-token") || ""; } catch { /* In-memory session still works. */ }
  }

  setToken(token) {
    this.token = token;
    try {
      if (token) sessionStorage.setItem("workspace-token", token);
      else sessionStorage.removeItem("workspace-token");
    } catch { /* Storage may be disabled in the browser. */ }
  }

  async request(path, { method = "GET", body, authenticated = true } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const requestToken = authenticated ? this.token : "";
    if (requestToken) headers.Authorization = `Bearer ${requestToken}`;
    let response;
    try {
      response = await fetch(path, {
        method, headers, cache: "no-store", credentials: "omit",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      const error = new Error("网络连接失败，请检查网络后重试。");
      error.network = true;
      throw error;
    }
    if (response.status === 204) return null;
    let data;
    try { data = await response.json(); } catch { throw new ApiError(response.status); }
    if (!response.ok) {
      if (response.status === 401 && requestToken && requestToken === this.token) this.onExpired();
      throw new ApiError(response.status, typeof data.detail === "string" ? data.detail : "");
    }
    return data;
  }

  login(email, password) { return this.request("/auth/login", { method: "POST", body: { email, password }, authenticated: false }); }
  register(email, password) { return this.request("/users/register", { method: "POST", body: { email, password }, authenticated: false }); }
  me() { return this.request("/users/me"); }
  conversations() { return this.request("/conversations"); }
  conversation(id) { return this.request(`/conversations/${encodeURIComponent(id)}`); }
  create(title) { return this.request("/conversations", { method: "POST", body: { title } }); }
  chat(id, model, content, effort) {
    return this.request(`/conversations/${encodeURIComponent(id)}/chat`, {
      method: "POST", body: { model, content, ...(effort ? { reasoning_effort: effort } : {}) },
    });
  }
  credential() { return this.request("/providers/openrouter"); }
  saveKey(api_key) { return this.request("/providers/openrouter", { method: "PUT", body: { api_key } }); }
  removeKey() { return this.request("/providers/openrouter", { method: "DELETE" }); }
}
