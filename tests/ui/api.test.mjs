import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { WorkspaceApi, conversationMessages } from "../../src/ai_workspace/static/api.js";

beforeEach(() => {
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
});

test("chat uses the local authenticated API and omits default reasoning", async () => {
  const api = new WorkspaceApi(() => assert.fail("unexpected expiry"));
  api.setToken("test-token");
  globalThis.fetch = async (path, options) => {
    assert.equal(path, "/conversations/conversation-id/chat");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.deepEqual(JSON.parse(options.body), { model: "vendor/model", content: "  message\n  " });
    return Response.json({ content: "reply", model: "vendor/model", usage: null });
  };
  assert.equal((await api.chat("conversation-id", "vendor/model", "  message\n  ", "")).content, "reply");
});

test("history comes from conversation JSON and alternates user/assistant", async () => {
  const api = new WorkspaceApi(() => {});
  globalThis.fetch = async (pathname) => {
    assert.equal(pathname, "/conversations/conversation-id");
    return Response.json({ messages: ["first question", { content: "first answer" }, "next question", { content: "next answer" }] });
  };
  assert.deepEqual(conversationMessages(await api.conversation("conversation-id")), [
    { content: "first question", role: "user" }, { content: "first answer", role: "assistant" },
    { content: "next question", role: "user" }, { content: "next answer", role: "assistant" },
  ]);
});

test("login never sends a stale bearer token", async () => {
  const api = new WorkspaceApi(() => assert.fail("login must not expire another session"));
  api.setToken("stale-token");
  globalThis.fetch = async (path, options) => {
    assert.equal(path, "/auth/login");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ detail: "Invalid email or password" }, { status: 401 });
  };
  await assert.rejects(api.login("test@example.com", "password"), /邮箱或密码不正确/);
  assert.equal(api.token, "stale-token");
});

test("credential bodies only contain api_key and deletion accepts 204", async () => {
  const api = new WorkspaceApi(() => {});
  api.setToken("test-token");
  globalThis.fetch = async (path, options) => {
    assert.equal(path, "/providers/openrouter");
    if (options.method === "PUT") {
      assert.deepEqual(JSON.parse(options.body), { api_key: "test-only-key" });
      return Response.json({ configured: true });
    }
    assert.equal(options.method, "DELETE");
    return new Response(null, { status: 204 });
  };
  await api.saveKey("test-only-key");
  assert.equal(await api.removeKey(), null);
  assert.equal([...Object.values(sessionStorage)].includes("test-only-key"), false);
});

test("only an unauthorized response for the current session expires it", async () => {
  let expired = 0;
  const api = new WorkspaceApi(() => { expired++; api.setToken(""); });
  api.setToken("old-token");
  globalThis.fetch = async () => {
    api.setToken("new-token");
    return Response.json({ detail: "Unauthorized" }, { status: 401 });
  };
  await assert.rejects(api.me(), /登录已过期/);
  assert.equal(expired, 0);
  assert.equal(api.token, "new-token");
  globalThis.fetch = async () => Response.json({ detail: "Unauthorized" }, { status: 401 });
  await assert.rejects(api.me(), /登录已过期/);
  assert.equal(expired, 1);
  assert.equal(sessionStorage.getItem("workspace-token"), undefined);
});

test("unknown upstream details are not echoed and network errors are distinguishable", async () => {
  const api = new WorkspaceApi(() => {});
  globalThis.fetch = async () => Response.json({ detail: "private secret" }, { status: 500 });
  await assert.rejects(api.me(), (error) => !error.message.includes("private secret") && error.status === 500);
  globalThis.fetch = async () => { throw new Error("private network detail"); };
  await assert.rejects(api.me(), (error) => error.network && !error.message.includes("private network detail"));
});
