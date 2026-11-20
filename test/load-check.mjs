// 模拟宿主加载检查：按 Magpie 契约逐条验证插件，不依赖真实 magpie 宿主。
//
//  1. 模块导出形状（只允许插件入口 + _internal）
//  2. config 钩子 ??= 语义（不覆盖用户已有配置）
//  3. auth.methods / prompts 形状
//  4. loader：未登录返回 {}；登录后返回 baseURL + 自定义 fetch
//  5. 对 mock 上游端到端：非流式 JSON、SSE 帧（含 [DONE]）、错误码透传
//     （401/404/429/500）、服务不可达 → 502、Authorization 正确、
//     错误负载与日志不泄漏 API Key
//
// 用法：node test/load-check.mjs

import assert from "node:assert/strict";
import http from "node:http";
import process from "node:process";

const plugin = await import("../plugin.js");

// ---- 1. 导出形状 ----
const exportKeys = Object.keys(plugin).sort();
assert.deepEqual(exportKeys, ["MuseBridge", "_internal"],
  `模块只能导出插件入口和 _internal，实际：${exportKeys}`);
assert.equal(typeof plugin.MuseBridge, "function");
assert.equal(typeof plugin._internal, "object");
console.log("ok 1/6 导出形状");

// ---- 2. config ??= 语义 ----
const hooks = await plugin.MuseBridge({}, {});
assert.equal(typeof hooks.config, "function");

const fresh = {};
await hooks.config(fresh);
const declared = fresh.provider?.musebridge;
assert.ok(declared, "config 未声明 musebridge 供应商");
assert.equal(declared.npm, "@ai-sdk/openai-compatible");
assert.ok(declared.models["muse-chat"]);

const userCfg = { provider: { musebridge: { name: "我的改名", models: { custom: { name: "C" } } } } };
await hooks.config(userCfg);
assert.equal(userCfg.provider.musebridge.name, "我的改名", "覆盖了用户配置！");
assert.ok(userCfg.provider.musebridge.models.custom, "覆盖了用户模型！");
console.log("ok 2/6 config ??= 不覆盖用户配置");

// ---- 3. auth 形状 ----
assert.equal(hooks.auth.provider, "musebridge");
assert.ok(Array.isArray(hooks.auth.methods) && hooks.auth.methods.length === 1);
const method = hooks.auth.methods[0];
assert.equal(method.type, "api");
assert.ok(method.label);
const promptKeys = method.prompts.map((p) => p.key);
assert.ok(promptKeys.includes("baseURL"), "缺少服务地址 prompt");
assert.equal(method.prompts.find((p) => p.key === "baseURL").validate("ftp://x"),
  "需为 http(s):// 开头的服务地址");
assert.equal(method.prompts.find((p) => p.key === "baseURL").validate(""), undefined);
console.log("ok 3/6 auth methods/prompts 形状");

// ---- 4. loader ----
assert.deepEqual(await hooks.auth.loader(async () => undefined), {},
  "未登录时 loader 应返回 {}");
assert.deepEqual(await hooks.auth.loader(async () => ({ key: " " })), {});
const KEY = "m2a-check-key";
const loaded = await hooks.auth.loader(
  async () => ({ key: KEY, metadata: { baseURL: "http://127.0.0.1:8777" } }));
assert.equal(loaded.baseURL, "http://127.0.0.1:8777/v1");
assert.equal(typeof loaded.fetch, "function");
console.log("ok 4/6 loader（未登录 {}，登录后 baseURL+fetch）");

// ---- 5. mock 上游端到端 ----
const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${KEY}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key", code: "invalid_api_key" } }));
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "muse-chat" }, { id: "gpt-4o" },
      { id: "muse-video" }, { id: "brand-new" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.model === "sora") {  // MuseBridge v1.7.2：类型不符 → 404 model_not_found
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "model sora is a video model",
      code: "model_not_found" } }));
    return;
  }
  if (body.model === "busy") {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "rate limited" } }));
    return;
  }
  if (body.model === "boom") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
    return;
  }
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frames = [
      { id: "c1", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "你" } }] },
      { id: "c1", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "好😀" } }] },  // 代理码点边界
      { id: "c1", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } },
    ];
    for (const f of frames) await new Promise((r) => res.write(`data: ${JSON.stringify(f)}\n\n`, r));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "c2", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: `echo:${body.model}` },
      finish_reason: "stop" }] }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
// 真实宿主里网关会用 loader.baseURL 拼完整 URL 再调 fetch，插件原样转发；
// 这里用真实的 mock 上游地址模拟同样的 input。
const CHAT_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
const live = await hooks.auth.loader(
  async () => ({ key: KEY, metadata: { baseURL: `http://127.0.0.1:${port}` } }));

const call = (payload) => live.fetch(CHAT_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(5000),
});

// 非流式 + Authorization 正确（mock 已校验 Bearer）
const plain = await call({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
assert.equal(plain.status, 200);
assert.equal((await plain.json()).choices[0].message.content, "echo:gpt-4o");

// 流式：帧序列原样透传、[DONE] 收尾
const streamed = await call({ model: "gpt-4o", stream: true,
  messages: [{ role: "user", content: "hi" }] });
assert.equal(streamed.status, 200);
assert.equal(streamed.headers.get("content-type"), "text/event-stream");
assert.equal(streamed.headers.get("content-length"), null);
const text = await streamed.text();
const frames = text.split("\n\n").filter((b) => b.startsWith("data: "))
  .map((b) => b.slice(6));
assert.equal(frames.at(-1), "[DONE]");
const deltas = frames.slice(0, -1).map((f) => JSON.parse(f));
assert.equal(deltas[0].choices[0].delta.content, "你");
assert.equal(deltas[1].choices[0].delta.content, "好😀");  // 码点未截断
assert.equal(deltas.at(-1).choices[0].finish_reason, "stop");
assert.equal(deltas.at(-1).usage.total_tokens, 6);

// 错误码透传（网关契约：401 标账号 / 404 模型拒绝 / 429、5xx 切换）
for (const [model, status] of [["sora", 404], ["busy", 429], ["boom", 500]]) {
  const res = await call({ model, messages: [{ role: "user", content: "x" }] });
  assert.equal(res.status, status, `model ${model} 应透传 ${status}`);
  const err = await res.json();
  assert.ok(err.error.message);
}
const unauthorized = await hooks.auth.loader(async () => ({ key: "wrong" }))
  .then((l) => l.fetch(CHAT_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", messages: [] }),
  }));
assert.equal(unauthorized.status, 401);
console.log("ok 5/6 mock 上游端到端（JSON / SSE / 401·404·429·500 透传）");

// provider.models：按服务器刷新 + 失败回退
const refreshed = await hooks.provider.models(
  { models: { "muse-chat": { name: "static" } } },
  { auth: { key: KEY, metadata: { baseURL: `http://127.0.0.1:${port}` } } });
assert.equal(refreshed["muse-chat"].name, "static");
assert.ok(refreshed["brand-new"].tool_call === true);
assert.ok(!("muse-video" in refreshed));
const fallbackProvider = { models: { "muse-chat": { name: "static" } } };
const fellBack = await hooks.provider.models(fallbackProvider,
  { auth: { key: KEY, metadata: { baseURL: "http://127.0.0.1:1" } } });
assert.equal(fellBack, fallbackProvider.models, "失败时应原样返回 provider.models");
const noAuthProvider = { models: { "muse-chat": { name: "marker" } } };
assert.equal(await hooks.provider.models(noAuthProvider), noAuthProvider.models,
  "未登录时 models 钩子应原样返回 provider.models");
console.log("ok 6a/6 provider.models 刷新与回退");

// 服务不可达 → 502，错误信息可读且不含 Key
const down = await hooks.auth.loader(
  async () => ({ key: KEY, metadata: { baseURL: "http://127.0.0.1:1" } }))
  .then((l) => l.fetch("http://127.0.0.1:1/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", messages: [] }),
  }));
assert.equal(down.status, 502);
const downBody = await down.json();
assert.ok(downBody.error.message.includes("无法连接 MuseBridge 服务"));
assert.ok(!JSON.stringify(downBody).includes(KEY), "502 错误体泄漏了 API Key！");
console.log("ok 6b/6 服务不可达 → 502，无凭证泄漏");

server.close();
console.log("\n加载检查全部通过 ✓（真实 magpie 宿主沙盒步骤见 README）");
process.exit(0);
