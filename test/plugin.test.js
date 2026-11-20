import { test } from "node:test";
import assert from "node:assert/strict";

import { _internal } from "../plugin.js";

test("normalizeBase: default, trim, trailing slash, scheme check", () => {
  assert.equal(_internal.normalizeBase(""), _internal.DEFAULT_BASE);
  assert.equal(_internal.normalizeBase(undefined), _internal.DEFAULT_BASE);
  assert.equal(_internal.normalizeBase("  http://box:18610// "), "http://box:18610");
  assert.equal(_internal.normalizeBase("https://m2.example.com/"), "https://m2.example.com");
  assert.equal(_internal.normalizeBase("ftp://x"), null);
  assert.equal(_internal.normalizeBase("127.0.0.1:18610"), null);
});

test("isValidKey rejects empty and whitespace", () => {
  assert.equal(_internal.isValidKey("m2a-abc"), true);
  assert.equal(_internal.isValidKey(""), false);
  assert.equal(_internal.isValidKey("m2a abc"), false);
  assert.equal(_internal.isValidKey(undefined), false);
});

test("resolveCtx: metadata baseURL wins, default otherwise, null without key", () => {
  assert.deepEqual(
    _internal.resolveCtx({ key: "k", metadata: { baseURL: "http://box:1/" } }),
    { base: "http://box:1", key: "k" });
  assert.deepEqual(
    _internal.resolveCtx({ key: "k" }),
    { base: _internal.DEFAULT_BASE, key: "k" });
  assert.equal(_internal.resolveCtx(undefined), null);
  assert.equal(_internal.resolveCtx({ key: " " }), null);
  assert.equal(_internal.resolveCtx({ key: "k", metadata: { baseURL: "bad" } }), null);
});

test("staticModels: every entry has limits and honest tool_call", () => {
  const m = _internal.staticModels();
  assert.ok(m["muse-chat"] && m["gpt-4o"] && m["gpt-5"]);
  for (const entry of Object.values(m)) {
    assert.equal(entry.limit.context, 131072);
    assert.equal(entry.limit.output, 16384);
    assert.equal(entry.tool_call, true);
  }
  for (const id of ["muse-image", "muse-video", "dall-e-3", "sora"]) assert.ok(!(id in m));
});

test("mapModels: reuses base entries, synthesizes new ids, drops non-chat", () => {
  const base = _internal.staticModels();
  const list = [{ id: "muse-chat" }, { id: "brand-new-alias" },
    { id: "muse-video" }, { id: "dall-e-3" }, "plain-string-id", { nope: 1 }];
  const out = _internal.mapModels(list, base);
  assert.deepEqual(out["muse-chat"], base["muse-chat"]);
  assert.notEqual(out["muse-chat"], base["muse-chat"]); // copied, not shared
  assert.equal(out["brand-new-alias"].tool_call, true);
  assert.equal(out["plain-string-id"].name, "plain-string-id → Muse Chat");
  assert.ok(!("muse-video" in out) && !("dall-e-3" in out));
  assert.ok(!("nope" in out));
  assert.equal(Object.keys(_internal.mapModels([], base)).length, 0);
  assert.equal(Object.keys(_internal.mapModels(undefined, base)).length, 0);
});

test("forwardHeaders: adds Authorization, keeps existing, never duplicates", async () => {
  const h = _internal.forwardHeaders({ headers: { "x-a": "1" } }, "m2a-k");
  assert.equal(h.get("authorization"), "Bearer m2a-k");
  assert.equal(h.get("x-a"), "1");
  const replaced = _internal.forwardHeaders(
    { headers: { Authorization: "Bearer old" } }, "m2a-new");
  assert.equal(replaced.get("authorization"), "Bearer m2a-new");
});

test("sanitizeHeaders drops length/encoding, keeps content-type", () => {
  const h = _internal.sanitizeHeaders(new Headers({
    "content-type": "text/event-stream",
    "content-length": "123",
    "content-encoding": "gzip",
  }));
  assert.equal(h.get("content-type"), "text/event-stream");
  assert.equal(h.get("content-length"), null);
  assert.equal(h.get("content-encoding"), null);
});

test("errorResponse: OpenAI-style body, exact status", async () => {
  const res = _internal.errorResponse(502, "服务没起来", "bridge_unreachable");
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, "bridge_unreachable");
  assert.equal(body.error.message, "服务没起来");
});
