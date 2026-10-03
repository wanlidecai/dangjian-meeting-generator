"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const { isPublicAddress, resolvePublicUrl, fetchPublicHtml } = require("../app/lib/network");
const { buildSourcePack } = require("../app/server");

const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];

function fakeTransport(handler) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; request.emit("error", new Error("cancelled")); };
    request.end = () => {
      Promise.resolve().then(() => handler(url, options)).then((result) => {
        if (request.destroyed) return;
        const response = Readable.from(result.chunks || [Buffer.from(result.body || "")]);
        response.statusCode = result.status || 200;
        response.headers = result.headers || { "content-type": "text/html; charset=utf-8" };
        callback(response);
      }).catch((error) => request.emit("error", error));
    };
    return request;
  };
}

test("public-IP filter rejects private, loopback, linklocal, reserved and mapped IPv6", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "192.0.2.1", "224.0.0.1",
    "::1", "::", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.1.1", "2002:7f00:1::", "2001:db8::1", "2001::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(address), true, address);
});

test("URLs require public HTTP(S) standard ports without embedded credentials", async () => {
  for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://[::ffff:127.0.0.1]/", "http://localhost/", "http://nas.local/", "file:///etc/passwd", "https://public.example:8443/", "https://user:pass@public.example/"]) {
    await assert.rejects(resolvePublicUrl(url, publicLookup));
  }
  await assert.rejects(resolvePublicUrl("https://mixed.example/", async () => [{ address: "8.8.8.8", family: 4 }, { address: "192.168.0.1", family: 4 }]), /私网/);
  await assert.rejects(resolvePublicUrl("https://mapped.example/", async () => [{ address: "::ffff:7f00:1", family: 6 }]), /私网/);
});

test("connection lookup is pinned to the validated public address", async () => {
  let lookups = 0;
  const result = await fetchPublicHtml("https://public.example/article", { lookup: async () => {
    lookups++;
    return [{ address: lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
  }, transport: fakeTransport(async (url, options) => {
    assert.equal(url.hostname, "public.example");
    assert.equal(options.agent, false);
    const records = await new Promise((resolve, reject) => options.lookup("public.example", { all: true }, (error, values) => error ? reject(error) : resolve(values)));
    assert.deepEqual(records, [{ address: "8.8.8.8", family: 4 }]);
    return { body: "<html>安全公开材料</html>" };
  }) });
  assert.equal(lookups, 1);
  assert.match(result, /安全公开材料/);
});

test("each redirect is revalidated and private destinations are never requested", async () => {
  let calls = 0;
  await assert.rejects(fetchPublicHtml("https://public.example/start", { lookup: publicLookup, transport: fakeTransport(() => {
    calls++;
    return { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } };
  }) }), /私网/);
  assert.equal(calls, 1);
  let hops = 0;
  const html = await fetchPublicHtml("https://first.example/start", { lookup: publicLookup, transport: fakeTransport((url) => {
    hops++;
    return url.hostname === "first.example" ? { status: 302, headers: { location: "https://second.example/article" } } : { body: "公开正文" };
  }) });
  assert.equal(hops, 2);
  assert.equal(html, "公开正文");
});

test("redirect count and 2MiB response limits are bounded", async () => {
  await assert.rejects(fetchPublicHtml("https://public.example/loop", { lookup: publicLookup, maxRedirects: 2,
    transport: fakeTransport(() => ({ status: 302, headers: { location: "/loop" } })) }), /重定向过多/);
  await assert.rejects(fetchPublicHtml("https://public.example/large", { lookup: publicLookup,
    transport: fakeTransport(() => ({ chunks: [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024 + 1)] })) }), /大小限制/);
  await assert.rejects(fetchPublicHtml("https://public.example/header-large", { lookup: publicLookup,
    transport: fakeTransport(() => ({ headers: { "content-length": "2097153" }, body: "small" })) }), /大小限制/);
});

test("timeout covers DNS and requests, and an aborted budget starts no new transport", async () => {
  let calls = 0;
  await assert.rejects(fetchPublicHtml("https://public.example/hanging-dns", { timeoutMs: 10, lookup: () => new Promise(() => {}),
    transport: () => { calls++; throw new Error(); } }), (error) => error.statusCode === 504);
  assert.equal(calls, 0);
  const signal = AbortSignal.abort();
  await assert.rejects(fetchPublicHtml("https://public.example/", { signal, lookup: () => { calls++; throw new Error(); } }));
  assert.equal(calls, 0);
  await assert.rejects(fetchPublicHtml("https://public.example/hanging", { timeoutMs: 10, lookup: publicLookup,
    transport: () => { const request = new EventEmitter(); request.end = () => {}; request.destroy = () => request.emit("error", new Error()); return request; } }), (error) => error.statusCode === 504);
});

test("source search runs at most three requests concurrently and keeps topic order", async () => {
  let active = 0;
  let maximum = 0;
  const topics = Array.from({ length: 7 }, (_, index) => `议题${index}`);
  const sources = await buildSourcePack(topics, { lookup: publicLookup, transport: fakeTransport(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(1);
    active--;
    return { body: "<html>没有搜索结果</html>" };
  }) });
  assert.equal(sources.length, topics.length);
  assert.deepEqual(sources.map((source) => source.topic), topics);
  assert.ok(maximum <= 3);
  assert.equal(maximum, 3);
});
