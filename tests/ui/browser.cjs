/* Run against Uvicorn with Node and Playwright; API requests are mocked, never billed. */
const assert = require("node:assert/strict");
const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require(process.env.AI_WORKSPACE_PLAYWRIGHT_PATH || "playwright");

const baseURL = process.env.AI_WORKSPACE_UI_URL || "http://127.0.0.1:8000";
const user = { id: "00000000-0000-4000-8000-000000000001", email: "tester@example.com", is_active: true, created_at: "2026-10-08T12:00:00Z" };
const timestamp = "2026-10-08T12:00:00Z";

async function run() {
  await mkdir("artifacts/ui", { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.AI_WORKSPACE_BROWSER_CHANNEL ? { channel: process.env.AI_WORKSPACE_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  let credential = null;
  let loginError = true;
  let chatError = false;
  let networkError = false;
  let expired = false;
  let conversations = [];
  const history = new Map();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!/^\/(auth|users|conversations|providers)(\/|$)/.test(pathname)) return route.continue();
    const method = request.method();
    const body = request.postDataJSON();
    requests.push({ pathname, method, body, headers: request.headers() });
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (pathname === "/users/register") return json(user, 201);
    if (pathname === "/auth/login") return loginError ? json({ detail: "Invalid email or password" }, 401) : json({ access_token: "test-token", token_type: "bearer" });
    if (expired) return json({ detail: "Invalid token" }, 401);
    assert.equal(request.headers().authorization, "Bearer test-token");
    if (pathname === "/users/me") return json(user);
    if (pathname === "/providers/openrouter") {
      if (method === "PUT") {
        assert.deepEqual(body, { api_key: "test-only-openrouter-key" });
        credential = { provider: "openrouter", configured: true, created_at: timestamp, updated_at: timestamp };
      }
      if (method === "DELETE") { credential = null; return route.fulfill({ status: 204 }); }
      return credential ? json(credential) : json({ detail: "Provider credential not found" }, 404);
    }
    if (pathname === "/conversations") {
      if (method === "POST") {
        const conversation = { id: `conversation-${conversations.length + 1}`, title: body.title, created_at: timestamp, updated_at: timestamp };
        conversations.unshift(conversation);
        history.set(conversation.id, []);
        return json(conversation, 201);
      }
      return json(conversations);
    }
    const id = pathname.split("/")[2];
    if (method === "GET" && history.has(id)) return json({ ...conversations.find((item) => item.id === id), messages: history.get(id) });
    if (pathname.endsWith("/chat")) {
      if (networkError) return route.abort("failed");
      if (chatError) return json({ detail: "Chat provider request failed" }, 502);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const content = "## 你好\n这是一个测试回复。\n\n```html\n<img src=x onerror=alert(1)>\n```";
      history.get(id).push({ role: "user", content: body.content }, { role: "assistant", content });
      return json({ content, model: body.model, usage: { total_tokens: 42 } });
    }
    return json({ detail: "Not found" }, 404);
  });
  try {
    await page.goto(baseURL);
    await page.getByRole("heading", { name: "你的下一步，从这里开始。" }).waitFor();
    await page.screenshot({ path: "artifacts/ui/desktop-welcome.png", fullPage: true });
    await page.getByRole("button", { name: "写出好表达" }).click();
    assert.match(await page.locator("#message-input").inputValue(), /润色/);
    await page.locator("#send-button").click();
    await page.locator("#auth-dialog").waitFor({ state: "visible" });
    await page.locator("#auth-email").fill(user.email);
    await page.locator("#auth-password").fill("test-password");
    await page.locator("#auth-submit").click();
    await page.getByText("邮箱或密码不正确，请重新输入。").waitFor();
    loginError = false;
    await page.locator("#auth-switch").click();
    await page.locator("#auth-submit").click();
    await page.locator("#auth-dialog").waitFor({ state: "hidden" });
    await page.getByText("还没有对话，从一个想法开始吧").waitFor();
    assert.ok(requests.some((r) => r.pathname === "/users/register"));
    assert.equal(await page.locator("#auth-password").inputValue(), "");
    await page.locator("#provider-nav").click();
    await page.getByText("未配置", { exact: true }).waitFor();
    await page.locator("#api-key").fill("test-only-openrouter-key");
    await page.locator("#save-key").click();
    await page.getByText("已配置", { exact: true }).waitFor();
    assert.equal(await page.locator("#api-key").inputValue(), "");
    await page.screenshot({ path: "artifacts/ui/provider-settings.png", fullPage: true });
    await page.locator("#account-tab").click();
    assert.equal(await page.locator("#detail-email").textContent(), user.email);
    await page.screenshot({ path: "artifacts/ui/account-settings.png", fullPage: true });
    await page.locator("#back-to-chat").click();
    await page.locator("#model-button").click();
    await page.locator("#model-input").fill("test/model");
    await page.locator("#reasoning-select").selectOption("high");
    await page.getByRole("button", { name: "使用此模型" }).click();
    await page.locator("#message-input").fill("  测试问题\n保留空白  ");
    await page.locator("#send-button").click();
    await page.getByText("这是一个测试回复。", { exact: true }).waitFor();
    assert.deepEqual(requests.find((r) => r.pathname.endsWith("/chat")).body, { model: "test/model", content: "  测试问题\n保留空白  ", reasoning_effort: "high" });
    assert.equal(await page.locator("#messages img").count(), 0);
    assert.equal(await page.locator(".assistant-content code").textContent(), "<img src=x onerror=alert(1)>\n");
    await page.locator("#message-input").fill("下一条用户追问");
    await page.locator("#send-button").click();
    await page.locator(".assistant-content").nth(1).waitFor();
    await page.screenshot({ path: "artifacts/ui/desktop-conversation.png", fullPage: true });
    await page.reload();
    await page.locator(".history-item").waitFor();
    await page.locator(".history-item").click();
    await page.locator(".assistant-content").nth(1).waitFor();
    assert.equal(await page.locator(".message").count(), 4);
    assert.deepEqual(await page.locator(".message").evaluateAll((nodes) => nodes.map((node) => node.className)), ["message user", "message assistant", "message user", "message assistant"]);
    chatError = true;
    await page.locator("#message-input").fill("失败后保留的草稿");
    await page.locator("#send-button").click();
    await page.locator("#chat-notice").waitFor({ state: "visible" });
    assert.equal(await page.locator("#message-input").inputValue(), "失败后保留的草稿");
    assert.equal(await page.locator(".message").count(), 4);
    chatError = false;
    networkError = true;
    await page.locator("#send-button").click();
    await page.getByText("连接中断，消息可能已在服务端完成。请先点击左侧当前对话检查结果，再决定是否重发。").waitFor();
    networkError = false;
    await page.locator("#search-toggle").click();
    await page.locator("#history-search").fill("不存在的标题");
    await page.getByText("没有找到相关对话").waitFor();
    await page.locator("#search-close").click();
    await page.locator("#provider-nav").click();
    await page.locator("#remove-key").click();
    await page.locator("#confirm-remove-key").click();
    await page.getByText("未配置", { exact: true }).waitFor();
    await page.locator("#account-tab").click();
    await page.locator("#logout-button").click();
    await page.locator("#header-login").waitFor({ state: "visible" });
    assert.equal(await page.locator(".history-item").count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workspace-token")), null);
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.ok(!stored.includes("test-only-openrouter-key"));
    assert.ok(!stored.includes("失败后保留的草稿"));
    // Expiry clears private history while retaining an unsent draft.
    await page.locator("#header-login").click();
    await page.locator("#auth-email").fill(user.email);
    await page.locator("#auth-password").fill("test-password");
    await page.locator("#auth-submit").click();
    await page.locator("#auth-dialog").waitFor({ state: "hidden" });
    await page.locator(".history-item").waitFor();
    await page.locator("#message-input").fill("登录过期时保留草稿");
    expired = true;
    await page.locator("#refresh-history").click();
    await page.locator("#auth-dialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#message-input").inputValue(), "登录过期时保留草稿");
    assert.equal(await page.locator(".history-item").count(), 0);
    await page.getByRole("button", { name: "关闭登录窗口" }).click();
    await page.locator("#new-chat").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#sidebar").waitFor({ state: "hidden" });
    await page.screenshot({ path: "artifacts/ui/mobile-welcome.png", fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator("#expand-sidebar").click();
    await page.locator("#sidebar").waitFor({ state: "visible" });
    await page.screenshot({ path: "artifacts/ui/mobile-sidebar.png", fullPage: true });
    await page.locator("#sidebar-scrim").click({ position: { x: 350, y: 400 } });
    await page.locator("#sidebar").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log("Browser checks passed: registration/login, credentials, model/effort, chat/history, safe rendering, failures, search, logout/expiry, desktop/mobile.");
  } catch (error) {
    await page.screenshot({ path: "artifacts/ui/failure.png", fullPage: true });
    console.error("UI feedback:", await page.locator("#auth-feedback").textContent());
    console.error("Last API paths:", requests.slice(-6).map((r) => `${r.method} ${r.pathname}`));
    throw error;
  } finally { await browser.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
