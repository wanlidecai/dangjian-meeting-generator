"use strict";
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");

const GATEWAY_PREFIX = "/app/DangjianRecorder";
const DEFAULT_CONFIG = { api_key: "", model: "deepseek-v4-flash", source_search: true, base_path: "/dangjian" };
const MAX_BODY = 1024 * 1024;

class PublicError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.public = true;
  }
}

function normalizeBasePath(value) {
  if (typeof value !== "string") throw new PublicError("入口路径格式不正确");
  const normalized = value.trim().replace(/\/+$/, "") || "/";
  if (normalized.length > 120 || !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(normalized)) {
    throw new PublicError("入口路径应以 / 开头，只使用字母、数字、下划线或短横线");
  }
  if (normalized === GATEWAY_PREFIX || normalized.startsWith(GATEWAY_PREFIX + "/")) {
    throw new PublicError("入口路径不用包含飞牛网关前缀");
  }
  return normalized;
}

class SettingsStore {
  constructor(dataDir) {
    if (!dataDir) throw new PublicError("请指定应用数据目录", 500);
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, "config.json");
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.config = { ...DEFAULT_CONFIG };
    if (fs.existsSync(this.file)) {
      try {
        const stat = fs.lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error();
        const loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.config = this.validate(loaded, { initial: true });
        fs.chmodSync(this.file, 0o600);
      } catch {
        throw new PublicError("应用配置无法读取，请检查数据目录中的 config.json", 500);
      }
    } else {
      this.persist(this.config);
    }
  }

  validate(input, { initial = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new PublicError("设置必须是 JSON 对象");
    if (Object.keys(input).some((key) => !["api_key", "clear_api_key", "model", "source_search", "base_path"].includes(key))) {
      throw new PublicError("设置包含不支持的字段");
    }
    const result = { ...this.config };
    if (Object.hasOwn(input, "api_key")) {
      if (typeof input.api_key !== "string") throw new PublicError("API 密钥格式不正确");
      const key = input.api_key.trim();
      if (key && !/^[A-Za-z0-9_-]{1,512}$/.test(key)) throw new PublicError("API 密钥格式不正确，请粘贴完整密钥");
      if (key || initial) result.api_key = key;
    }
    if (Object.hasOwn(input, "clear_api_key")) {
      if (typeof input.clear_api_key !== "boolean") throw new PublicError("清除密钥参数不正确");
      if (input.clear_api_key) result.api_key = "";
    }
    if (Object.hasOwn(input, "model")) {
      if (typeof input.model !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(input.model.trim())) throw new PublicError("模型名称格式不正确");
      result.model = input.model.trim();
    }
    if (Object.hasOwn(input, "source_search")) {
      if (typeof input.source_search !== "boolean") throw new PublicError("联网检索开关不正确");
      result.source_search = input.source_search;
    }
    if (Object.hasOwn(input, "base_path")) result.base_path = normalizeBasePath(input.base_path);
    return result;
  }

  persist(config) {
    const temporary = path.join(this.dataDir, `.config-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch {
      throw new PublicError("保存配置失败，请检查数据目录权限", 500);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* atomic rename already removed it */ }
    }
  }

  update(input) {
    const config = this.validate(input);
    this.persist(config);
    this.config = config;
    return config;
  }

  publicSettings(dev) {
    const { model, source_search, base_path } = this.config;
    return { api_key_configured: Boolean(this.config.api_key), model, source_search, base_path,
      entry_path: (dev ? "" : GATEWAY_PREFIX) + (base_path === "/" ? "/" : base_path + "/") };
  }
}

function sendJson(res, status, value, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
  res.end(body);
}

async function readJson(req, maximum = MAX_BODY) {
  const type = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json" || req.headers["x-dangjian-request"] !== "1") {
    req.resume();
    throw new PublicError("写入请求需要 JSON 格式和应用请求标识", 403);
  }
  if (req.headers["content-length"] !== undefined && (!/^\d+$/.test(req.headers["content-length"]) || Number(req.headers["content-length"]) > maximum)) {
    req.resume();
    throw new PublicError("请求内容过大", 413);
  }
  const raw = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => finish(new PublicError("读取请求超时，请重试", 408)), 15000);
    function cleanup() {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
    }
    function finish(error, value) {
      cleanup();
      if (error) { req.resume(); reject(error); } else resolve(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > maximum) return finish(new PublicError("请求内容过大", 413));
      chunks.push(chunk);
    }
    function onEnd() { finish(null, Buffer.concat(chunks).toString("utf8")); }
    function onError() { finish(new PublicError("请求读取失败", 400)); }
    function onAbort() { finish(new PublicError("请求已中断", 400)); }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAbort);
  });
  let parsed;
  try { parsed = JSON.parse(raw || "{}"); } catch { throw new PublicError("JSON 请求格式不正确"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PublicError("请求内容必须是 JSON 对象");
  return parsed;
}

function requestPath(req) {
  try {
    const decoded = decodeURIComponent(String(req.url || "/").split("?", 1)[0]);
    if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)
        || decoded.split("/").some((part) => part === "." || part === "..")) throw new Error();
    return decoded;
  } catch {
    throw new PublicError("请求路径不合法");
  }
}

function authorize(req, server, dev) {
  if (dev) {
    const port = server.address()?.port;
    const hosts = ["localhost", "127.0.0.1", `localhost:${port}`, `127.0.0.1:${port}`];
    if (!hosts.includes(String(req.headers.host || "").trim().toLowerCase())) throw new PublicError("本地开发模式仅允许 localhost 或 127.0.0.1 访问", 403);
  } else {
    if (!/^\d+$/.test(String(req.headers["x-trim-userid"] || "")) || String(req.headers["x-trim-isadmin"] || "").trim().toLowerCase() !== "true") {
      throw new PublicError("仅允许通过飞牛统一网关访问的管理员使用", 403);
    }
  }
}

async function serveStatic(publicDir, suffix, res) {
  const root = await fsp.realpath(publicDir);
  const candidate = path.resolve(root, "." + (suffix === "/" ? "/index.html" : suffix));
  let target;
  try { target = await fsp.realpath(candidate); } catch { throw new PublicError("页面不存在", 404); }
  if (target !== root && !target.startsWith(root + path.sep)) throw new PublicError("页面不存在", 404);
  const stat = await fsp.stat(target);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new PublicError("页面不存在", 404);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml; charset=utf-8", ".ico": "image/x-icon", ".png": "image/png" };
  const body = await fsp.readFile(target);
  res.writeHead(200, { "Content-Type": types[path.extname(target).toLowerCase()] || "application/octet-stream", "Content-Length": body.length,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'" });
  res.end(body);
}

function createRuntime({ options = {}, publicDir, defaultRoles, generate }) {
  const dev = Boolean(options.dev);
  const settings = options.settingsStore || new SettingsStore(options.dataDir);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") throw new PublicError("不允许跨域预检请求", 403);
      authorize(req, server, dev);
      const pathname = requestPath(req);
      const suffix = pathname === GATEWAY_PREFIX ? "/" : pathname.startsWith(GATEWAY_PREFIX + "/") ? pathname.slice(GATEWAY_PREFIX.length) : pathname;
      const config = { ...settings.config };
      const base = config.base_path === "/" ? "" : config.base_path;
      const entry = settings.publicSettings(dev).entry_path;
      if (req.method === "GET" && (suffix === "/" && base || suffix === base && base || !dev && pathname === GATEWAY_PREFIX)) {
        return sendJson(res, 302, { ok: true }, { Location: entry });
      }
      if (base && !suffix.startsWith(base + "/")) throw new PublicError("页面不存在", 404);
      const route = base ? suffix.slice(base.length) : suffix;
      if (req.method === "GET" && route === "/api/settings") return sendJson(res, 200, settings.publicSettings(dev));
      if (req.method === "GET" && route === "/api/defaults") {
        return sendJson(res, 200, { roles: defaultRoles, model: config.model, api_key_configured: Boolean(config.api_key), source_search: config.source_search });
      }
      if (req.method === "GET" && !route.startsWith("/api/")) return await serveStatic(publicDir, route, res);
      if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
        const payload = await readJson(req, options.maxBody || MAX_BODY);
        if (req.method === "PUT" && route === "/api/settings") {
          settings.update(payload);
          return sendJson(res, 200, { ok: true, ...settings.publicSettings(dev) });
        }
        if (req.method === "POST" && route === "/api/generate") return sendJson(res, 200, await generate(payload, config));
      }
      throw new PublicError(route.startsWith("/api/") ? "接口不存在或请求方法不支持" : "不支持的请求方式", 404);
    } catch (error) {
      const safe = error instanceof PublicError;
      sendJson(res, safe ? error.statusCode : 500, { error: safe ? error.message : "服务处理失败，请稍后重试" });
    }
  });
  server.settings = settings;
  server.dev = dev;
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.timeout = 150000;
  return server;
}

async function removeStaleSocket(socketPath) {
  let stat;
  try { stat = await fsp.lstat(socketPath); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isSocket() || stat.isSymbolicLink()) throw new PublicError("监听路径已存在且不是 Unix Socket", 500);
  const active = await new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.setTimeout(500);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("timeout", () => { probe.destroy(); resolve(true); });
    probe.once("error", (error) => resolve(!["ECONNREFUSED", "ENOENT"].includes(error.code)));
  });
  if (active) throw new PublicError("应用服务已在运行", 500);
  await fsp.unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
}

async function listen(server, options) {
  if (options.dev && options.socketPath) throw new PublicError("开发模式不能同时指定 Unix Socket");
  if (!options.dev && !options.socketPath) throw new PublicError("生产模式必须显式指定 --socket");
  let socketPath;
  if (!options.dev) {
    socketPath = path.resolve(options.socketPath);
    await fsp.mkdir(path.dirname(socketPath), { recursive: true });
    await removeStaleSocket(socketPath);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    const onReady = () => { server.off("error", reject); resolve(); };
    if (options.dev) server.listen(options.port ?? 8787, "127.0.0.1", onReady);
    else server.listen(socketPath, onReady);
  });
  if (socketPath) {
    await fsp.chmod(socketPath, 0o660);
    const inode = (await fsp.lstat(socketPath)).ino;
    server.once("close", () => {
      try { if (fs.lstatSync(socketPath).ino === inode) fs.unlinkSync(socketPath); } catch { /* already removed */ }
    });
  }
  return server;
}

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--dev") options.dev = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--socket", "--port", "--data-dir"].includes(argument)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new PublicError("启动参数缺少值");
      if (argument === "--socket") options.socketPath = value;
      else if (argument === "--data-dir") options.dataDir = value;
      else {
        if (!/^\d+$/.test(value) || Number(value) > 65535 || Number(value) < 1) throw new PublicError("端口应为 1 至 65535");
        options.port = Number(value);
      }
    } else throw new PublicError("不支持的启动参数");
  }
  if (!options.help) {
    if (!options.dev && !options.socketPath) throw new PublicError("请选择 --dev 本地开发，或通过 --socket 启动飞牛原生服务");
    if (options.dev && options.socketPath) throw new PublicError("开发模式不能同时指定 Unix Socket");
    if (!options.dev && options.port) throw new PublicError("生产模式只能监听 Unix Socket");
  }
  return options;
}

module.exports = { PublicError, SettingsStore, createRuntime, listen, parseArguments, readJson, sendJson, normalizeBasePath, GATEWAY_PREFIX };
