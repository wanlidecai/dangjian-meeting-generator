const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const serverPath = path.resolve(__dirname, "../server.js");
const serverSource = fs.readFileSync(serverPath, "utf8");

function createHarness(responseContent) {
  const requests = [];
  const server = {
    on() { return this; },
    listen() { return this; }
  };
  const context = vm.createContext({
    __dirname: path.dirname(serverPath),
    process: {
      env: { DEEPSEEK_API_KEY: "test-key", AUTO_OPEN: "0" },
      platform: process.platform,
      execPath: process.execPath,
      exit() { throw new Error("The test server must not exit the process."); }
    },
    console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (id === "node:http") return { createServer: () => server };
      if (id === "node:fs") {
        return {
          existsSync: () => false,
          readFileSync() { throw new Error("Tests must not read .env files."); }
        };
      }
      if (id === "node:fs/promises") {
        return { readFile: async () => { throw new Error("No static files needed by these tests."); } };
      }
      if (id === "node:child_process") {
        return { spawn() { throw new Error("Tests must not launch a browser."); } };
      }
      return require(id);
    },
    async fetch(url, options) {
      assert.equal(url, "https://api.deepseek.com/chat/completions", "Only the mocked generation endpoint may be called.");
      const body = JSON.parse(options.body);
      requests.push(body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: responseContent } }] })
      };
    }
  });
  vm.runInContext(serverSource, context, { filename: serverPath });
  vm.runInContext(`
    buildSourcePack = async (topics) => topics.map((topic) => ({
      topic,
      source: "测试参考材料",
      url: "https://example.invalid/reference",
      excerpt: "围绕议题开展学习，结合岗位职责落实工作要求。"
    }));
  `, context);
  return {
    generateRecord: context.generateRecord,
    trimExtraSections: context.trimExtraSections,
    requests,
    prompt: () => requests.at(-1).messages.find((message) => message.role === "user").content
  };
}

const learningTopic = "加强基层党组织建设";

for (const [meetingType, label] of [
  [undefined, "主题党日"],
  ["theme-day", "主题党日"],
  ["members-meeting", "党员大会"],
  ["committee-meeting", "支委会"]
]) {
  test(`${meetingType || "omitted meeting type"} selects ${label} in the prompt and result`, async () => {
    const harness = createHarness(`${label}记录\n一、学习《${learningTopic}》\n学习记录正文。`);
    const result = await harness.generateRecord({ meetingType, topics: [learningTopic] });

    assert.equal(result.meetingType, meetingType || "theme-day");
    assert.equal(result.meetingTypeLabel, label);
    assert.match(result.content, new RegExp(`^${label}记录`));
    assert.match(harness.prompt(), new RegExp(`会议类型：${label}`));
    assert.ok(harness.prompt().includes(`第一行输出“${label}记录”`));
    assert.equal(harness.requests.length, 1);
  });
}

test("committee meetings require the default branch matters when none are supplied", async () => {
  const harness = createHarness("支委会记录\n一、学习《加强基层党组织建设》\n学习记录正文。\n二、讨论党员大会议程及组织安排\n委员讨论会议准备。\n三、讨论党员发展工作及培养考察安排\n委员讨论培养考察工作。");
  const result = await harness.generateRecord({
    meetingType: "committee-meeting",
    topics: [learningTopic],
    branchMatters: []
  });

  assert.ok(harness.prompt().includes("二、讨论党员大会议程及组织安排"));
  assert.ok(harness.prompt().includes("三、讨论党员发展工作及培养考察安排"));
  assert.ok(harness.prompt().includes("必须逐项讨论下列支部事项，不能省略"));
  assert.ok(harness.prompt().includes("学习议题与支部事项合计3项"));
  assert.ok(result.content.includes("二、讨论党员大会议程及组织安排"));
  assert.ok(result.content.includes("三、讨论党员发展工作及培养考察安排"));
});

test("custom committee matters replace defaults and continue numbering after learning topics", async () => {
  const harness = createHarness("支委会记录\n一、学习《加强基层党组织建设》\n学习记录正文。\n二、学习《党员教育管理》\n学习记录正文。\n三、讨论下月党员大会议程\n事项讨论正文。\n四、讨论入党积极分子培养安排\n事项讨论正文。");
  await harness.generateRecord({
    meetingType: "committee-meeting",
    topics: [learningTopic, "党员教育管理"],
    branchMatters: [" 研究下月党员大会议程 ", "讨论入党积极分子培养安排", "研究下月党员大会议程", " "]
  });

  const prompt = harness.prompt();
  assert.ok(prompt.includes("三、讨论下月党员大会议程"));
  assert.ok(prompt.includes("四、讨论入党积极分子培养安排"));
  assert.ok(prompt.includes("学习议题与支部事项合计4项"));
  assert.ok(!prompt.includes("研究党员大会议程及组织安排"));
  assert.ok(!prompt.includes("讨论党员发展工作及培养考察安排"));
  assert.ok(prompt.includes("未明确的决定写为待进一步核实或提交讨论的建议"));
});

test("committee meetings accept one matter per line", async () => {
  const harness = createHarness("支委会记录\n一、学习《加强基层党组织建设》\n学习记录正文。");
  await harness.generateRecord({
    meetingType: "committee-meeting",
    topics: [learningTopic],
    branchMatters: "研究党员大会会务安排\n\n 讨论党员教育计划 "
  });

  assert.ok(harness.prompt().includes("二、讨论党员大会会务安排"));
  assert.ok(harness.prompt().includes("三、讨论党员教育计划"));
});

for (const meetingType of ["theme-day", "members-meeting"]) {
  test(`${meetingType} ignores committee-only branch matters`, async () => {
    const harness = createHarness("会议记录\n一、学习《加强基层党组织建设》\n学习记录正文。");
    await harness.generateRecord({
      meetingType,
      topics: [learningTopic],
      branchMatters: ["研究机密分组事项", "讨论特殊党员发展事项"]
    });

    const prompt = harness.prompt();
    assert.ok(!prompt.includes("机密分组事项"));
    assert.ok(!prompt.includes("特殊党员发展事项"));
    assert.ok(!prompt.includes("支部事项（按以下顺序"));
    assert.ok(prompt.includes("输出的议题数量必须与输入议题数量完全一致"));
  });
}

test("committee speakers exclude ordinary members and raw people lists", async () => {
  const harness = createHarness("支委会记录\n一、学习《加强基层党组织建设》\n学习记录正文。");
  await harness.generateRecord({
    meetingType: "committee-meeting",
    topics: [learningTopic],
    secretary: "书记甲",
    deputy: "副书记乙",
    committee: ["委员丙", "委员丁"],
    members: ["普通党员戊"],
    people: ["外部人员己", "普通党员戊"]
  });

  const prompt = harness.prompt();
  assert.ok(prompt.includes("全部参会人员：书记甲、副书记乙、委员丙、委员丁"));
  assert.ok(!prompt.includes("普通党员戊"));
  assert.ok(!prompt.includes("外部人员己"));
  assert.doesNotMatch(prompt, /^成员：/m);
});

test("unknown meeting types fail validation before any model request", async () => {
  const harness = createHarness("不应生成此内容");
  for (const meetingType of ["invalid-type", "__proto__", "constructor"]) {
    await assert.rejects(
      harness.generateRecord({ meetingType, topics: [learningTopic] }),
      (error) => error.statusCode === 400 && /不支持的会议类型/.test(error.message)
    );
  }
  assert.equal(harness.requests.length, 0);
});

test("generation removes a surplus learning section while preserving later committee discussion", async () => {
  const original = "支委会记录\n一、学习《加强基层党组织建设》\n有效学习正文。\n二、学习《未提供的议题》\n应删除的学习正文。\n三、讨论党员大会议程及组织安排\n保留的委员讨论意见。\n四、讨论党员发展工作及培养考察安排\n保留的后续工作安排。";
  const harness = createHarness(original);
  const result = await harness.generateRecord({ meetingType: "committee-meeting", topics: [learningTopic] });

  assert.ok(result.content.includes("有效学习正文"));
  assert.ok(!result.content.includes("未提供的议题"));
  assert.ok(!result.content.includes("应删除的学习正文"));
  assert.ok(result.content.includes("保留的委员讨论意见"));
  assert.ok(result.content.includes("保留的后续工作安排"));
});

test("section trimming retains all supplied learning topics and subsequent discussion", () => {
  const harness = createHarness("unused");
  const original = "党员大会记录\n一、学习《第一议题》\n第一项正文。\n二、学习《第二议题》\n第二项正文。\n三、学习《多余议题》\n多余正文。\n四、讨论支部事项\n应保留的讨论。";
  assert.equal(
    harness.trimExtraSections(original, 2),
    "党员大会记录\n一、学习《第一议题》\n第一项正文。\n二、学习《第二议题》\n第二项正文。\n四、讨论支部事项\n应保留的讨论。"
  );
});
