// Run with Node's test runner; requires Playwright and an installed Chrome.
// NODE_PATH=<path containing playwright> node --test tests/website.test.cjs
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { chromium } = require("playwright");

const websitePath = path.join(__dirname, "../src/main/resources/website");
let browser;

before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => {
  await browser?.close();
});

function defaults(overrides = {}) {
  return {
    roles: { secretary: "测试书记", deputy: "测试副书记", committee: ["测试委员", "第二委员"], members: ["测试成员"] },
    model: "test-model",
    canGenerate: true,
    requiresLogin: true,
    csrfToken: "csrf-test-token",
    csrfHeader: "X-DJ-CSRF",
    ...overrides
  };
}

async function fixture(t, options = {}) {
  const basePath = options.basePath || "/dangjian";
  const requests = [];
  let defaultsRequestCount = 0;
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, "http://localhost").pathname;
    try {
      if (route === `${basePath}/api/defaults`) {
        defaultsRequestCount++;
        const response = options.defaultsResponse
          ? options.defaultsResponse(defaultsRequestCount)
          : { status: 200, body: defaults(options.config) };
        response.body.loginUrl ||= `/login?redirect_uri=${encodeURIComponent(basePath)}`;
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response.body));
      } else if (route === `${basePath}/api/generate`) {
        let body = "";
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body);
        requests.push({ payload, headers: req.headers, url: req.url });
        res.writeHead(options.generateStatus || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(options.generateBody || {
          content: `记录正文：${payload.meetingType}`,
          meetingType: payload.meetingType,
          meetingTypeLabel: "服务端类型",
          sources: [
            { topic: "正常议题", source: "有效来源", url: "https://example.com/meeting" },
            { topic: "<script>议题</script>", source: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" },
            { topic: "无来源", source: "不允许数据链接", url: "data:text/html,unsafe" }
          ]
        }));
      } else if (route === basePath || route === `${basePath}/`) {
        const html = (await readFile(path.join(websitePath, "index.html"), "utf8"))
          .replaceAll("__DJ_BASE_PATH__", basePath)
          .replaceAll("__DJ_LOGIN_URL__", `/login?redirect_uri=${encodeURIComponent(basePath)}`);
        res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
        res.end(html);
      } else if (route === `${basePath}/assets/app.js` || route === `${basePath}/assets/styles.css`) {
        const filename = route.endsWith("app.js") ? "app.js" : "styles.css";
        res.writeHead(200, { "Content-Type": filename.endsWith("js") ? "application/javascript" : "text/css" });
        res.end(await readFile(path.join(websitePath, filename)));
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "halo-session", value: "test-session", url: origin }]);
  if (options.initScript) await context.addInitScript(options.initScript);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.deepEqual(errors, [], "Page should have no uncaught errors");
  });
  await page.goto(`${origin}${basePath}`);
  await page.waitForFunction(() => !document.querySelector("#accessText").textContent.includes("正在读取"));
  return { page, requests, basePath, origin };
}

test("both supported base paths send same-origin generation with defaults and CSRF", async (t) => {
  for (const basePath of ["/dangjian", "/tools/dangjian"]) {
    await t.test(basePath, async (t) => {
      const { page, requests } = await fixture(t, { basePath });
      assert.equal(await page.inputValue("#secretaryInput"), "测试书记");
      assert.equal(await page.inputValue("#committeeInput"), "测试委员、第二委员");
      assert.equal(await page.locator(".person-input").count(), 1);
      const requestOptions = await page.evaluate(() => {
        const calls = [];
        const originalFetch = window.fetch;
        window.fetch = (input, options) => {
          calls.push({ input, credentials: options.credentials });
          return originalFetch(input, options);
        };
        window.__fetchCalls = calls;
        return document.querySelector("#generateBtn").disabled;
      });
      assert.equal(requestOptions, false);
      for (const meetingType of ["theme-day", "members-meeting", "committee-meeting"]) {
        await page.selectOption("#meetingTypeInput", meetingType);
        const isCommittee = meetingType === "committee-meeting";
        assert.equal(await page.locator("#branchMattersPanel").isVisible(), isCommittee);
        assert.equal(await page.locator("#peopleList").isVisible(), !isCommittee);
        if (isCommittee) await page.fill("#branchMattersInput", "事项一\n事项二");
        await page.click("#generateBtn");
        await page.waitForFunction(() => document.querySelector("#statusText").textContent.startsWith("已生成"));
        assert.equal(await page.inputValue("#resultText"), `记录正文：${meetingType}`);
        const request = requests.at(-1);
        assert.equal(request.url, `${basePath}/api/generate`);
        assert.equal(request.headers["x-dj-csrf"], "csrf-test-token");
        assert.match(request.headers.cookie, /halo-session=test-session/);
        assert.equal(request.payload.meetingType, meetingType);
        assert.deepEqual(request.payload.members, isCommittee ? [] : ["测试成员"]);
        assert.deepEqual(request.payload.branchMatters, isCommittee ? ["事项一", "事项二"] : []);
        assert.deepEqual(request.payload.committee, ["测试委员", "第二委员"]);
      }
      assert.deepEqual(await page.evaluate(() => window.__fetchCalls), [
        { input: `${basePath}/api/generate`, credentials: "same-origin" },
        { input: `${basePath}/api/generate`, credentials: "same-origin" },
        { input: `${basePath}/api/generate`, credentials: "same-origin" }
      ]);
      assert.equal(await page.locator("#sourcesBox a").count(), 1);
      assert.equal(await page.locator("#sourcesBox a").getAttribute("href"), "https://example.com/meeting");
      assert.equal(await page.locator("#sourcesBox script, #sourcesBox img").count(), 0);
      assert.match(await page.locator("#sourcesBox").innerText(), /<img src=x onerror=alert\(1\)>/);
    });
  }
});

test("anonymous users can edit but must log in before generating", async (t) => {
  const { page, requests, basePath } = await fixture(t, { basePath: "/tools/dangjian", config: { canGenerate: false } });
  assert.equal(await page.locator("#generateBtn").isDisabled(), true);
  assert.equal(await page.locator("#loginLink").isVisible(), true);
  const loginUrl = new URL(await page.locator("#loginLink").getAttribute("href"));
  assert.equal(loginUrl.searchParams.get("redirect_uri"), basePath);
  await page.fill(".topic-input", "编辑后的议题");
  await page.click("#addPersonBtn");
  await page.locator(".person-input").last().fill("新增成员");
  assert.equal(await page.locator(".person-input").count(), 2);
  await page.evaluate(() => generateRecord());
  assert.equal(requests.length, 0);
  assert.match(await page.locator("#statusText").innerText(), /登录/);
});

test("public generation can be enabled without a login link", async (t) => {
  const { page, requests } = await fixture(t, { config: { canGenerate: true, requiresLogin: false } });
  assert.equal(await page.locator("#generateBtn").isDisabled(), false);
  assert.equal(await page.locator("#loginLink").isVisible(), false);
  await page.click("#generateBtn");
  await page.waitForFunction(() => document.querySelector("#statusText").textContent.startsWith("已生成"));
  assert.equal(requests.length, 1);
});

test("configuration errors take priority over login prompts for disabled generation", async (t) => {
  const configurationMessage = "尚未配置生成服务密钥，请联系管理员完成配置。";
  const { page, requests } = await fixture(t, {
    config: { canGenerate: false, requiresLogin: true, configurationMessage }
  });
  assert.equal(await page.locator("#accessText").innerText(), configurationMessage);
  assert.equal(await page.locator("#statusText").innerText(), configurationMessage);
  assert.equal(await page.locator("#generateBtn").isDisabled(), true);
  assert.equal(await page.locator("#loginLink").isVisible(), false);
  assert.equal(await page.locator("#retryDefaultsBtn").isVisible(), true);
  await page.evaluate(() => generateRecord());
  assert.equal(requests.length, 0);
  assert.equal(await page.locator("#statusText").innerText(), configurationMessage);
});

test("defaults failure stays visible and blocks generation until a successful retry", async (t) => {
  const { page, requests } = await fixture(t, {
    defaultsResponse: (count) => count === 1
      ? { status: 503, body: { error: "配置服务暂不可用" } }
      : { status: 200, body: defaults() }
  });
  assert.equal(await page.locator("#generateBtn").isDisabled(), true);
  assert.match(await page.locator("#accessText").innerText(), /配置服务暂不可用/);
  await page.evaluate(() => generateRecord());
  assert.equal(requests.length, 0);
  await page.click("#retryDefaultsBtn");
  await page.waitForFunction(() => !document.querySelector("#generateBtn").disabled);
  assert.equal(await page.locator("#statusText").innerText(), "等待生成");
});

test("editing, topic validation, copy fallbacks and TXT export preserve the selected meeting label", async (t) => {
  const { page, requests } = await fixture(t, {
    initScript: () => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
      document.execCommand = () => true;
    }
  });
  await page.fill(".topic-input", "");
  await page.click("#generateBtn");
  assert.equal(requests.length, 0);
  assert.equal(await page.locator("#statusText").innerText(), "请先填写议题");
  await page.fill(".topic-input", "议题一");
  await page.click("#addTopicBtn");
  await page.locator(".topic-input").last().fill("议题二");
  await page.locator(".remove-btn").first().click();
  assert.equal(await page.locator(".topic-index").innerText(), "1");
  await page.selectOption("#meetingTypeInput", "members-meeting");
  await page.click("#generateBtn");
  await page.waitForFunction(() => document.querySelector("#statusText").textContent.startsWith("已生成"));
  assert.deepEqual(requests[0].payload.topics, ["议题二"]);
  await page.fill("#resultText", "人工编辑后的记录");
  await page.click("#copyBtn");
  assert.equal(await page.locator("#statusText").innerText(), "已复制");
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.click("#copyBtn");
  assert.match(await page.locator("#statusText").innerText(), /已选中记录/);
  assert.equal(await page.evaluate(() => {
    const textarea = document.querySelector("#resultText");
    return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
  }), "人工编辑后的记录");
  await page.selectOption("#meetingTypeInput", "committee-meeting");
  const downloadPromise = page.waitForEvent("download");
  await page.click("#downloadBtn");
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^党员大会记录-\d{4}-\d{2}-\d{2}\.txt$/);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "人工编辑后的记录");
});

test("an expired login disables another generation and presents the login link", async (t) => {
  const { page, requests } = await fixture(t, { generateStatus: 401, generateBody: { error: "请先登录" } });
  await page.click("#generateBtn");
  await page.waitForFunction(() => document.querySelector("#statusText").textContent === "请先登录");
  assert.equal(await page.locator("#generateBtn").isDisabled(), true);
  assert.equal(await page.locator("#loginLink").isVisible(), true);
  assert.equal(requests.length, 1);
});

test("mobile layout has no horizontal overflow at a 375 px viewport", async (t) => {
  const { page } = await fixture(t, { viewport: { width: 375, height: 812 }, config: { canGenerate: false } });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.locator("#loginLink").isVisible(), true);
  await page.selectOption("#meetingTypeInput", "committee-meeting");
  assert.equal(await page.locator("#branchMattersPanel").isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});
