"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const app = require("../app/server");
const { parseArguments } = require("../app/lib/runtime");

const SECRET = "sk-unit-private-secret";
const PREFIX = "/app/DangjianRecorder";
const writeHeaders = { "Content-Type": "application/json", "X-Dangjian-Request": "1" };
const adminHeaders = { "X-Trim-Userid": "1000", "X-Trim-Isadmin": "true" };
const payload = { meetingType: "theme-day", topics: ["学习纪律要求"], secretary: "李书记", deputy: "郭副书记", committee: ["王委员"], members: ["刘党员"] };

function mockModel(calls = []) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    const label = body.messages[1].content.match(/会议类型：([^\n]+)/)[1];
    return new Response(JSON.stringify({ choices: [{ message: { content: `${label}记录\n一、学习《学习纪律要求》\n测试正文\n二、学习《额外议题》\n应被删除` } }] }), { status: 200 });
  };
}

async function temporary(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dangjian-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function running(t, options = {}) {
  const dataDir = options.dataDir || await temporary(t);
  const publicDir = path.join(dataDir, "test-public");
  await fsp.mkdir(publicDir, { recursive: true });
  await fsp.writeFile(path.join(publicDir, "index.html"), '<html><script src="app.js"></script>党建会议记录生成器</html>');
  await fsp.writeFile(path.join(publicDir, "app.js"), "console.log('fixture');");
  const server = await app.startServer({ dev: true, port: 0, dataDir, publicDir, fetch: mockModel(), ...options });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

async function request(server, method, route, body, headers = {}) {
  const bytes = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const address = server.address();
  const options = typeof address === "string" ? { socketPath: address } : { host: "127.0.0.1", port: address.port };
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, method, path: route, headers: { Host: typeof address === "string" ? "nas.example" : `127.0.0.1:${address.port}`,
      ...(bytes === undefined ? {} : { "Content-Length": Buffer.byteLength(bytes) }), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, headers: res.headers, data, text });
      });
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

test("default configuration is private, ignores .env, and redirects to the configured base", async (t) => {
  const dataDir = await temporary(t);
  await fsp.writeFile(path.join(dataDir, ".env"), `DEEPSEEK_API_KEY=${SECRET}`);
  const server = await running(t, { dataDir });
  const root = await request(server, "GET", "/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, "/dangjian/");
  const settings = await request(server, "GET", "/dangjian/api/settings");
  assert.deepEqual(settings.data, { api_key_configured: false, model: "deepseek-v4-flash", source_search: true, base_path: "/dangjian", entry_path: "/dangjian/" });
  assert.equal((await fsp.stat(path.join(dataDir, "config.json"))).mode & 0o777, 0o600);
  const generation = await request(server, "POST", "/dangjian/api/generate", payload, writeHeaders);
  assert.equal(generation.status, 400);
  assert.match(generation.data.error, /应用设置/);
  assert.ok(!generation.text.includes(SECRET));
  assert.equal((await request(server, "GET", "/dangjian/app.js")).status, 200);
});

test("settings retain blank keys, clear explicitly, change paths immediately, and survive restart", async (t) => {
  const dataDir = await temporary(t);
  const calls = [];
  const server = await running(t, { dataDir, fetch: mockModel(calls) });
  let result = await request(server, "PUT", "/dangjian/api/settings", { api_key: SECRET, model: "custom-model", source_search: false, base_path: "/records/team" }, writeHeaders);
  assert.equal(result.status, 200);
  assert.equal(result.data.entry_path, "/records/team/");
  assert.ok(!result.text.includes(SECRET));
  assert.equal((await request(server, "GET", "/")).headers.location, "/records/team/");
  assert.equal((await request(server, "GET", "/dangjian/api/settings")).status, 404);
  result = await request(server, "PUT", "/records/team/api/settings", { api_key: "   " }, writeHeaders);
  assert.equal(result.data.api_key_configured, true);
  result = await request(server, "POST", "/records/team/api/generate", payload, writeHeaders);
  assert.equal(result.status, 200);
  assert.equal(calls[0].body.model, "custom-model");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${SECRET}`);
  await new Promise((resolve) => server.close(resolve));
  const restarted = await running(t, { dataDir });
  result = await request(restarted, "GET", "/records/team/api/settings");
  assert.equal(result.data.api_key_configured, true);
  assert.equal(result.data.model, "custom-model");
  result = await request(restarted, "PUT", "/records/team/api/settings", { clear_api_key: true }, writeHeaders);
  assert.equal(result.data.api_key_configured, false);
  assert.equal(JSON.parse(await fsp.readFile(path.join(dataDir, "config.json"), "utf8")).api_key, "");
});

test("three meeting types retain prompts and results with independent model/source mocks", async () => {
  for (const meetingType of ["theme-day", "members-meeting", "committee-meeting"]) {
    const calls = [];
    let searched = 0;
    const result = await app.generateRecord({ ...payload, meetingType, people: ["不应出席支委会的人"], branchMatters: ["研究会议安排", "讨论培养工作"] }, {
      config: { api_key: SECRET, model: "deepseek-v4-flash", source_search: true }, fetch: mockModel(calls),
      sourceProvider: async (topics) => { searched++; return topics.map((topic) => ({ topic, source: "模拟公开材料", url: "https://example.com/article", excerpt: "根据纪律要求开展规范学习交流。" })); }
    });
    assert.equal(result.meetingType, meetingType);
    assert.equal(result.meetingTypeLabel, app.meetingTypes[meetingType]);
    assert.ok(result.content.startsWith(app.meetingTypes[meetingType] + "记录"));
    assert.ok(!result.content.includes("额外议题"));
    assert.equal(result.sources[0].source, "模拟公开材料");
    assert.equal(searched, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(calls[0].options.redirect, "error");
    assert.ok(!calls[0].body.messages[1].content.includes(SECRET));
    if (meetingType === "committee-meeting") {
      assert.match(calls[0].body.messages[1].content, /二、讨论会议安排/);
      assert.ok(!calls[0].body.messages[1].content.includes("不应出席支委会的人"));
    }
  }
});

test("source search can be disabled or time out without leaking source errors", async () => {
  let invoked = false;
  const result = await app.generateRecord(payload, { config: { api_key: SECRET, model: "deepseek-v4-flash", source_search: false }, fetch: mockModel(),
    sourceProvider: () => { invoked = true; throw new Error(SECRET); } });
  assert.equal(invoked, false);
  assert.match(result.sources[0].source, /未开启/);
  const timed = await app.generateRecord(payload, { config: { api_key: SECRET, model: "deepseek-v4-flash", source_search: true }, fetch: mockModel(),
    sourceTimeoutMs: 10, sourceProvider: () => new Promise(() => {}) });
  assert.match(timed.sources[0].source, /搜索未成功/);
  assert.ok(!JSON.stringify(timed).includes(SECRET));
});

test("real HTTP generation preserves all three meeting types with mocked external services", async (t) => {
  const server = await running(t, { sourceProvider: async (topics) => topics.map((topic) => ({ topic, source: "模拟检索", url: "https://example.com/article", excerpt: "公开测试材料。" })) });
  server.settings.update({ api_key: SECRET });
  for (const meetingType of ["theme-day", "members-meeting", "committee-meeting"]) {
    const result = await request(server, "POST", "/dangjian/api/generate", { ...payload, meetingType }, writeHeaders);
    assert.equal(result.status, 200);
    assert.equal(result.data.meetingType, meetingType);
    assert.ok(result.data.content.startsWith(app.meetingTypes[meetingType] + "记录"));
    assert.equal(result.data.sources[0].source, "模拟检索");
    assert.ok(!result.text.includes(SECRET));
  }
});

test("model rejection and timeout return controlled errors without reflecting keys", async (t) => {
  const server = await running(t, { fetch: async () => new Response(JSON.stringify({ error: { message: SECRET } }), { status: 401 }) });
  server.settings.update({ api_key: SECRET, source_search: false });
  const result = await request(server, "POST", "/dangjian/api/generate", payload, writeHeaders);
  assert.equal(result.status, 502);
  assert.match(result.data.error, /HTTP 401/);
  assert.ok(!result.text.includes(SECRET));
  await assert.rejects(app.generateRecord(payload, { config: { api_key: SECRET, model: "m", source_search: false }, modelTimeoutMs: 10,
    fetch: () => new Promise(() => {}) }), (error) => error.statusCode === 504 && !error.message.includes(SECRET));
});

test("Unix gateway requires valid user and administrator headers on all routes", async (t) => {
  const dataDir = await temporary(t);
  const server = await running(t, { dataDir, dev: false, socketPath: path.join(dataDir, "gateway.sock") });
  assert.equal((await fsp.stat(server.address())).mode & 0o777, 0o660);
  for (const headers of [{}, { "X-Trim-Userid": "1000", "X-Trim-Isadmin": "false" }, { "X-Trim-Userid": "bad", "X-Trim-Isadmin": "true" }]) {
    assert.equal((await request(server, "GET", PREFIX + "/dangjian/api/settings", undefined, headers)).status, 403);
  }
  const root = await request(server, "GET", PREFIX, undefined, adminHeaders);
  assert.equal(root.headers.location, PREFIX + "/dangjian/");
  const updated = await request(server, "PUT", PREFIX + "/dangjian/api/settings", { api_key: SECRET, source_search: false, base_path: "/custom" }, { ...adminHeaders, ...writeHeaders });
  assert.equal(updated.data.entry_path, PREFIX + "/custom/");
  assert.equal((await request(server, "GET", PREFIX + "/", undefined, adminHeaders)).headers.location, PREFIX + "/custom/");
  assert.equal((await request(server, "GET", PREFIX + "/custom/", undefined, adminHeaders)).status, 200);
  assert.equal((await request(server, "POST", PREFIX + "/custom/api/generate", payload, { ...adminHeaders, ...writeHeaders })).status, 200);
});

test("write header/JSON, CORS, request limits, host and traversal are enforced", async (t) => {
  const server = await running(t, { maxBody: 128 });
  assert.equal(server.address().address, "127.0.0.1");
  for (const headers of [{}, { "Content-Type": "application/json" }, { "Content-Type": "text/plain", "X-Dangjian-Request": "1" }]) {
    assert.equal((await request(server, "PUT", "/dangjian/api/settings", {}, headers)).status, 403);
  }
  assert.equal((await request(server, "OPTIONS", "/dangjian/api/settings")).status, 403);
  assert.equal((await request(server, "PUT", "/dangjian/api/settings", "not-json", writeHeaders)).status, 400);
  assert.equal((await request(server, "PUT", "/dangjian/api/settings", { api_key: "x".repeat(300) }, writeHeaders)).status, 413);
  assert.equal((await request(server, "GET", "/dangjian/api/settings", undefined, { Host: "attacker.example" })).status, 403);
  for (const route of ["/dangjian/%2e%2e/config.json", "/dangjian/%2e%2e%2fconfig.json", "/dangjian/%5c..%5cconfig.json", "/dangjian/%ZZ"]) {
    assert.equal((await request(server, "GET", route)).status, 400);
  }
  await fsp.symlink(server.settings.file, path.join(server.settings.dataDir, "test-public", "private.json"));
  assert.equal((await request(server, "GET", "/dangjian/private.json")).status, 404);
});

test("base paths, settings and generation size have explicit validation", () => {
  assert.throws(() => parseArguments([]), /--socket/);
  assert.throws(() => parseArguments(["--dev", "--socket", "x"]), /同时/);
  assert.throws(() => parseArguments(["--socket", "x", "--port", "1000"]), /Unix/);
  assert.throws(() => app.sanitizeTopics(Array(31).fill("议题")), /30/);
  assert.throws(() => app.sanitizeTopics(["长".repeat(1001)]), /1000/);
  assert.throws(() => app.normalizeMeetingType("invalid"), /会议类型/);
});

test("at most two generation requests run concurrently", async (t) => {
  const releases = [];
  const server = await running(t, { fetch: async () => {
    await new Promise((resolve) => releases.push(resolve));
    return new Response(JSON.stringify({ choices: [{ message: { content: "主题党日记录\n一、学习《议题》\n测试" } }] }), { status: 200 });
  } });
  server.settings.update({ api_key: SECRET, source_search: false });
  const first = request(server, "POST", "/dangjian/api/generate", payload, writeHeaders);
  const second = request(server, "POST", "/dangjian/api/generate", payload, writeHeaders);
  for (let i = 0; releases.length < 2 && i < 50; i++) await delay(5);
  assert.equal(releases.length, 2);
  try { assert.equal((await request(server, "POST", "/dangjian/api/generate", payload, writeHeaders)).status, 429); }
  finally { releases.forEach((resolve) => resolve()); }
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test("real CLI Unix service persists configuration without invoking AI", async (t) => {
  const dataDir = await temporary(t);
  const socketPath = path.join(dataDir, "real.sock");
  let child;
  let output = "";
  const start = async () => {
    child = spawn(process.execPath, [path.join(__dirname, "..", "app", "server.js"), "--socket", socketPath, "--data-dir", dataDir], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("CLI exited unexpectedly");
      if (fs.existsSync(socketPath)) return;
      await delay(10);
    }
    throw new Error("CLI did not start");
  };
  const stop = async () => {
    if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  };
  t.after(stop);
  await start();
  const handle = { address: () => socketPath };
  const saved = await request(handle, "PUT", PREFIX + "/dangjian/api/settings", { api_key: SECRET, model: "saved-model", source_search: false, base_path: "/saved" }, { ...adminHeaders, ...writeHeaders });
  assert.equal(saved.status, 200);
  await stop();
  await start();
  const settings = await request(handle, "GET", PREFIX + "/saved/api/settings", undefined, adminHeaders);
  assert.equal(settings.data.api_key_configured, true);
  assert.equal(settings.data.model, "saved-model");
  assert.equal((await request(handle, "GET", PREFIX + "/", undefined, adminHeaders)).headers.location, PREFIX + "/saved/");
  assert.ok(!output.includes(SECRET));
  await stop();
});
