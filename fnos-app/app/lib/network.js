"use strict";
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns/promises");
const net = require("node:net");
const { PublicError } = require("./runtime");

const USER_AGENT = "Mozilla/5.0 (compatible; DangjianRecorder/1.0)";

function ipv6Words(address) {
  let text = address.toLowerCase();
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const octets = text.slice(lastColon + 1).split(".").map(Number);
    text = text.slice(0, lastColon + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ":" + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const sides = text.split("::");
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  const words = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return words.map((word) => parseInt(word, 16));
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
      || a === 192 && b === 0 && [0, 2].includes(c) || a === 198 && [18, 19].includes(b)
      || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6 || address.includes("%")) return false;
  const words = ipv6Words(address);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
  if (words[0] === 0x2002 || words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)
      || words[0] === 0x3fff && words[1] < 0x1000) return false;
  return true;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new PublicError("请求超时或已取消", 504));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new PublicError("请求超时或已取消", 504));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function resolvePublicUrl(value, lookup = dns.lookup, signal) {
  if (signal?.aborted) throw new PublicError("检索请求超时或已取消", 504);
  let url;
  try { url = new URL(value); } catch { throw new PublicError("检索链接格式不正确", 502); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.port && url.port !== (url.protocol === "http:" ? "80" : "443")) {
    throw new PublicError("检索只允许公开的 HTTP 或 HTTPS 标准端口", 502);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new PublicError("检索不允许访问本机或私网地址", 502);
  let addresses;
  const literalFamily = net.isIP(hostname);
  if (literalFamily) addresses = [{ address: hostname, family: literalFamily }];
  else {
    try { addresses = await abortable(lookup(hostname, { all: true, verbatim: true }), signal); }
    catch {
      if (signal?.aborted) throw new PublicError("检索请求超时或已取消", 504);
      throw new PublicError("检索域名无法安全解析", 502);
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new PublicError("检索不允许访问本机、私网或保留地址", 502);
  }
  const selected = addresses[0];
  return { url, address: selected.address, family: net.isIP(selected.address), hostname };
}

function requestHtml(target, { signal, maximum, transport }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => { finish(new PublicError("检索请求超时或已取消", 504)); request?.destroy(); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const fixedLookup = (hostname, options, callback) => {
      if (typeof options === "function") callback = options;
      if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    };
    try {
      const makeRequest = transport || (target.url.protocol === "https:" ? https.request : http.request);
      request = makeRequest(target.url, { method: "GET", agent: false, family: target.family,
        lookup: fixedLookup, headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain,text/xml,*/*",
          "Accept-Language": "zh-CN,zh;q=0.9", "Accept-Encoding": "identity" } }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          return finish(null, { redirect: response.headers.location });
        }
        if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); return finish(null, { html: "" }); }
        if (Number(response.headers["content-length"] || 0) > maximum) {
          response.destroy();
          return finish(new PublicError("检索页面超过大小限制", 502));
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maximum) { response.destroy(); return finish(new PublicError("检索页面超过大小限制", 502)); }
          chunks.push(chunk);
        });
        response.on("end", () => {
          let html;
          const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers["content-type"] || "")?.[1] || "utf-8";
          try { html = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { html = Buffer.concat(chunks).toString("utf8"); }
          finish(null, { html });
        });
        response.on("error", () => finish(new PublicError("检索页面读取失败", 502)));
      });
      request.on("error", () => finish(new PublicError("检索连接失败", 502)));
      request.end();
    } catch {
      finish(new PublicError("检索连接失败", 502));
    }
  });
}

async function fetchPublicHtml(url, options = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);
  try {
    for (let redirects = 0; redirects <= (options.maxRedirects ?? 4); redirects++) {
      if (signal.aborted) throw new PublicError("检索请求超时或已取消", 504);
      const target = await resolvePublicUrl(url, options.lookup || dns.lookup, signal);
      const result = await requestHtml(target, { signal, maximum: options.maximum ?? 2 * 1024 * 1024, transport: options.transport });
      if (Object.hasOwn(result, "html")) return result.html;
      if (!result.redirect) return "";
      url = new URL(result.redirect, target.url).href;
    }
    throw new PublicError("检索链接重定向过多", 502);
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedJson(response, maximum = 2 * 1024 * 1024) {
  if (!response.body) return response.json(); // injectable lightweight test responses
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new PublicError("模型响应内容过大，请减少议题后重试", 502);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PublicError("模型响应格式不正确，请稍后重试", 502); }
}

module.exports = { isPublicAddress, resolvePublicUrl, fetchPublicHtml, readLimitedJson, abortable };
