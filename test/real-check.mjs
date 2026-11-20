// 真机集成检查：让插件对一台真实运行的 MuseBridge 服务发一次
// /v1/models 和 /v1/chat/completions（非流式 + 流式）。
//
// 不读取任何文件、不内置任何密钥——密钥只从环境变量来，且任何输出都不打印它：
//   MUSE2API_KEY=m2a-… MUSE2API_BASE=http://127.0.0.1:18610 node test/real-check.mjs
//
// 需要先启动 muse2api（建议 mock 驱动即可验证插件链路：
//   MUSE2API_DRIVER=mock MUSE2API_DATA_DIR=/tmp/m2a-magpie MUSE2API_PORT=18699 python -m muse2api）

import assert from "node:assert/strict";
import process from "node:process";

const KEY = process.env.MUSE2API_KEY;
const BASE = process.env.MUSE2API_BASE ?? "http://127.0.0.1:18610";
if (!KEY) {
  console.error("请设置 MUSE2API_KEY（m2a-…）后重试；MUSE2API_BASE 可选，默认 "
    + "http://127.0.0.1:18610");
  process.exit(2);
}

const plugin = await import("../plugin.js");
const hooks = await plugin.MuseBridge({}, {});
const live = await hooks.auth.loader(
  async () => ({ key: KEY, metadata: { baseURL: BASE } }));
assert.ok(live.fetch, "loader 未返回 fetch——检查 key/地址");

// 1. 模型列表
const models = await live.fetch(`${BASE}/v1/models`, { method: "GET" });
assert.equal(models.status, 200, `GET /v1/models → ${models.status}`);
const ids = (await models.json()).data.map((m) => m.id);
assert.ok(ids.includes("muse-chat"), "模型列表缺 muse-chat");
console.log("ok /v1/models →", ids.join(", "));

// 2. provider.models 钩子按账号刷新
const refreshed = await hooks.provider.models(
  { models: plugin._internal.staticModels() }, { auth: { key: KEY, metadata: { baseURL: BASE } } });
assert.ok(refreshed["muse-chat"]);
console.log("ok provider.models 刷新 →", Object.keys(refreshed).join(", "));

// 3. 非流式对话
const chat = await live.fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o",
    messages: [{ role: "user", content: "请只回复两个字：成功" }] }),
});
assert.equal(chat.status, 200, `chat → ${chat.status}: ${await chat.text()}`);
const reply = (await chat.json()).choices[0].message.content;
assert.ok(reply && reply.length > 0, "空回复");
console.log("ok 非流式对话 →", JSON.stringify(reply.slice(0, 40)));

// 4. 流式对话（SSE 透传）
const stream = await live.fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o", stream: true,
    messages: [{ role: "user", content: "数到三" }] }),
});
assert.equal(stream.status, 200);
assert.equal(stream.headers.get("content-type"), "text/event-stream");
const text = await stream.text();
assert.ok(text.includes("data: [DONE]"), "流缺 [DONE] 结尾");
console.log("ok 流式对话 →", text.split("\n").length, "行 SSE，含 [DONE]");

console.log(`\n真机集成检查全部通过 ✓（${BASE}，密钥未回显）`);
