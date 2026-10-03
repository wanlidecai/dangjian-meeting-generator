const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
loadEnv(path.join(rootDir, ".env"));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DEEPSEEK_API_KEY = normalizeApiKey(process.env.DEEPSEEK_API_KEY || "");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const defaultRoles = {
  secretary: "李强",
  deputy: "郭琳",
  committee: ["王丽"],
  members: ["刘广彪", "魏鹏飞", "许茜", "杨可来尔", "尹泽华"]
};

const meetingTypes = {
  "theme-day": "主题党日",
  "members-meeting": "党员大会",
  "committee-meeting": "支委会"
};
const defaultBranchMatters = [
  "研究党员大会议程及组织安排",
  "讨论党员发展工作及培养考察安排"
];

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && requestUrl.pathname === "/api/generate") {
      const payload = await readJson(req);
      const result = await generateRecord(payload);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/defaults") {
      return sendJson(res, 200, { roles: defaultRoles, model: DEEPSEEK_MODEL });
    }

    if (req.method === "GET") {
      return serveStatic(requestUrl.pathname, res);
    }

    return sendJson(res, 405, { error: "不支持的请求方式" });
  } catch (error) {
    console.error(error);
    return sendJson(res, error.statusCode || 500, {
      error: error.message || "生成失败，请稍后重试。"
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用。请关闭其他正在运行的生成器窗口，或修改 .env 中的 PORT。`);
  } else if (error.code === "EPERM") {
    console.error(`系统不允许监听 ${HOST}:${PORT}。请换一个端口，或检查安全权限设置。`);
  } else {
    console.error(error.message || error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`党建会议记录生成器已启动：http://${HOST}:${PORT}`);
});

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

function normalizeApiKey(value) {
  const key = String(value || "").trim();
  const repeatedPrefix = key.indexOf("sk-", 3);
  if (repeatedPrefix > -1) return key.slice(0, repeatedPrefix);
  return key;
}

async function serveStatic(urlPath, res) {
  const normalized = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const resolved = path.resolve(publicDir, `.${normalized}`);
  if (!resolved.startsWith(publicDir)) {
    return sendJson(res, 403, { error: "禁止访问" });
  }

  try {
    const data = await fsp.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "页面不存在" });
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("请求内容过大");
  }
  return JSON.parse(body || "{}");
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function generateRecord(payload) {
  const meetingType = normalizeMeetingType(payload.meetingType);
  const isCommitteeMeeting = meetingType === "committee-meeting";
  const branchMatters = isCommitteeMeeting ? sanitizeBranchMatters(payload.branchMatters) : [];

  if (!DEEPSEEK_API_KEY) {
    throw new Error("缺少 DeepSeek API 密钥，请检查 .env 文件。");
  }

  const topics = sanitizeTopics(payload.topics);
  if (topics.length === 0) {
    throw new Error("请至少填写一个议题。");
  }

  const secretary = cleanText(payload.secretary) || defaultRoles.secretary;
  const deputy = cleanText(payload.deputy) || defaultRoles.deputy;
  const committee = normalizeNameList(payload.committee, defaultRoles.committee);
  const members = isCommitteeMeeting ? [] : normalizeNameList(payload.members, defaultRoles.members);
  const people = sanitizePeople(isCommitteeMeeting ? [] : payload.people, { secretary, deputy, committee, members });
  const sourcePack = await buildSourcePack(topics);

  const prompt = buildPrompt({
    meetingType,
    branchMatters,
    topics,
    secretary,
    deputy,
    committee,
    members,
    people,
    sourcePack
  });

  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        {
          role: "system",
          content:
            "你是一名严谨的党建工作记录专家。必须严格按用户给出的会议记录格式输出，中文表达正式、简洁、可直接归档。"
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.25,
      max_tokens: 3800,
      thinking: { type: "disabled" }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `DeepSeek 请求失败：${response.status}`);
  }

  let content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("DeepSeek 未返回有效内容。");
  }
  content = trimExtraSections(content, topics.length);

  return {
    content,
    meetingType,
    meetingTypeLabel: meetingTypes[meetingType],
    sources: sourcePack.map((item) => ({
      topic: item.topic,
      source: item.source,
      url: item.url,
      excerpt: item.excerpt
    }))
  };
}

function buildPrompt({ meetingType, branchMatters, topics, secretary, deputy, committee, members, people, sourcePack }) {
  const meetingLabel = meetingTypes[meetingType];
  const isCommitteeMeeting = meetingType === "committee-meeting";
  const topicLines = topics
    .map((topic, index) => `${index + 1}. ${topic}`)
    .join("\n");
  const sourceLines = sourcePack
    .map((item, index) => {
      const label = index === 0 ? "第一议题参考材料" : `第${toChineseNumber(index + 1)}议题检索材料`;
      return `${label}：${item.topic}\n来源：${item.source || "未取得明确来源"}\n摘录：${item.excerpt || "未检索到可用摘录，请根据题目进行规范生成。"}\n`;
    })
    .join("\n");
  const formatHint =
    topics.length === 1
      ? `输出格式示例：
一、学习《${topics[0]}》
xx同志领学了《${topics[0]}》。围绕检索材料和学习内容作约100字概括摘抄，说明主要内容、核心要求和实践指向。与会人员结合自身工作谈了学习体会。
xx同志:
不少于50字的心得体会。
xx同志:
不少于50字的心得体会。
党支部书记${secretary}同志:
不少于50字的学习总结。

注意：本次只有一个学习议题，严禁输出“二、学习”。支部事项按其专门要求继续编号。`
      : `输出格式示例：
一、学习《${topics[0]}》
xx同志领学了《${topics[0]}》。围绕检索材料和学习内容作约100字概括摘抄，说明主要内容、核心要求和实践指向。与会人员结合自身工作谈了学习体会。
xx同志:
不少于50字的心得体会。
xx同志:
不少于50字的心得体会。
党支部书记${secretary}同志:
不少于50字的学习总结。

二、学习《${topics[1] || "第二议题题目"}》
约100字原文摘取或整理内容。`;

  const meetingRequirement = isCommitteeMeeting
    ? "本次为支部委员会会议，参会人员和发言人员仅限党支部书记、副书记及委员。学习议题结束后，必须逐项讨论下列支部事项，不能省略。"
    : meetingType === "members-meeting"
      ? "本次为党员大会，体现全体参会党员围绕学习议题开展学习交流，由党支部书记提出贯彻落实要求。"
      : "本次为主题党日，围绕学习议题体现主题学习、党员交流和联系工作实际落实要求；未提供的实践活动不得自行编造。";
  const scopeRequirement = isCommitteeMeeting
    ? `只能输出用户输入的${topics.length}个学习议题及下列${branchMatters.length}项支部事项，严禁自行新增其他议题。学习议题与支部事项合计${topics.length + branchMatters.length}项。`
    : `只能输出用户输入的学习议题，严禁新增、联想或补充其他议题；输出的议题数量必须与输入议题数量完全一致。`;
  const branchMatterInstructions = isCommitteeMeeting
    ? `\n支部事项（按以下顺序接在全部学习议题之后）：
${branchMatters.map((matter, index) => `${toChineseNumber(topics.length + index + 1)}、讨论${matter.replace(/^(研究|讨论)/, "")}`).join("\n")}

支部事项记录要求：
每项使用上述标题，编号承接学习议题。正文按“事项内容、委员讨论意见、书记归纳及后续安排”的结构展开，副书记和委员的意见必须围绕该项具体事项，不要套用学习心得格式。
涉及党员大会议程时，讨论议题设置、会议准备和组织安排；涉及党员发展时，讨论培养教育、考察材料及后续工作安排，具体内容以输入事项为准。
用户未提供的具体人名、日期、发展阶段、票数、表决结果或审批结论不得编造；未明确的具体信息用“待补充”标识，未明确的决定写为待进一步核实或提交讨论的建议，不得写成已经表决通过、批准发展或完成审批。
`
    : "";

  return `请根据以下信息生成${meetingLabel}记录。

会议类型：${meetingLabel}
${meetingRequirement}

固定要求：
0. 第一行输出“${meetingLabel}记录”，接着输出编号议题正文。
1. 第一议题必须写成“领学 + 两名同志分享心得 + 党支部书记作学习总结”。
2. 只有第一议题需要领学、两分享、党支部书记总结。
3. 第一议题领学段必须围绕第一议题题目和检索材料进行概括摘抄，正文约100字，体现“领学人员检索题目、总结内容摘抄”的效果；如果检索材料为空，根据该题目常见公开原文内容进行规范凝练。
4. 第一议题两名分享人员的心得每人至少50字，必须结合岗位职责或工作实际，不能写成口号。
5. 党支部书记学习总结至少50字，必须使用“党支部书记${secretary}同志:”作为姓名行，内容要体现总结、要求和落实方向。
6. 第二个及以后的学习议题，只输出“二、学习《题目》”这类标题，并摘取或整理约100字原文内容；如果有检索材料，优先从检索材料中摘取；如果检索材料为空，根据该题目常见公开原文内容进行凝练，不要再写心得、领学和总结。${isCommitteeMeeting ? "支部事项另按下方要求记录。" : ""}
7. 如有多个议题，按“一、二、三、四、五……”顺序继续编号，议题数量不限制。
8. 所有姓名必须从参会人员中选取，领学人员和两名分享人员不能是党支部书记${secretary}，优先从副书记、委员、成员中选择；如实际参会人员不足两名非书记人员，只使用现有人员，不能编造姓名。职务仅使用输入信息，未明确委员分工时只称“委员”，不得自行指定为组织委员、宣传委员或纪检委员。
9. ${scopeRequirement}
10. 语言正式、准确、可直接复制到会议记录中，不要添加说明、注释、Markdown代码块或除会议类型和编号议题以外的多余标题。

党支部书记：${secretary}
副书记：${deputy}
委员：${committee.join("、")}
${isCommitteeMeeting ? "" : `成员：${members.join("、")}\n`}全部参会人员：${people.join("、")}

议题：
${topicLines}

检索/参考材料：
${sourceLines}

${formatHint}
${branchMatterInstructions}`;
}

function trimExtraSections(content, topicCount) {
  if (topicCount < 1) return content.trim();
  const allowedNumbers = new Set(
    Array.from({ length: topicCount }, (_, index) => toChineseNumber(index + 1))
  );
  const headings = [...content.matchAll(/^[ \t]*([一二三四五六七八九十百千零\d]+)、[^\r\n]+/gm)];
  let result = "";
  let start = 0;
  for (const [index, heading] of headings.entries()) {
    const isLearning = /^[ \t]*[一二三四五六七八九十百千零\d]+、学习《[^》]+》/.test(heading[0]);
    const isAllowed = allowedNumbers.has(heading[1]) || (/^\d+$/.test(heading[1]) && Number(heading[1]) <= topicCount);
    if (isLearning && !isAllowed) {
      result += content.slice(start, heading.index);
      start = headings[index + 1]?.index ?? content.length;
    }
  }
  return (result + content.slice(start)).trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function buildSourcePack(topics) {
  const results = [];
  for (const [index, topic] of topics.entries()) {
    const source = await searchTopic(topic, index === 0);
    results.push({ topic, ...source });
  }
  return results;
}

async function searchTopic(topic, isFirstTopic) {
  const query = isFirstTopic ? `${topic} 原文 第二章 作风问题本质上是党性问题` : `${topic} 原文`;
  const fallback = {
    source: "DeepSeek根据题目生成",
    url: "",
    excerpt: ""
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      headers: {
        Accept: "text/plain",
        "X-Return-Format": "text"
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!response.ok) return fallback;
    const text = cleanSearchText(await response.text());
    if (!text) return fallback;

    return {
      source: "Jina Reader Search",
      url: `https://s.jina.ai/?q=${encodeURIComponent(query)}`,
      excerpt: makeExcerpt(text, isFirstTopic ? 320 : 180)
    };
  } catch (error) {
    return {
      ...fallback,
      source: `检索未完成，${fallback.source}`
    };
  }
}

function normalizeMeetingType(value) {
  const meetingType = cleanText(value) || "theme-day";
  if (!Object.prototype.hasOwnProperty.call(meetingTypes, meetingType)) {
    const error = new Error("不支持的会议类型，请选择主题党日、党员大会或支委会。");
    error.statusCode = 400;
    throw error;
  }
  return meetingType;
}

function sanitizeBranchMatters(value) {
  const matters = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const cleaned = matters.map(cleanText).filter(Boolean);
  return cleaned.length ? Array.from(new Set(cleaned)) : [...defaultBranchMatters];
}

function sanitizeTopics(rawTopics) {
  if (!Array.isArray(rawTopics)) return [];
  return rawTopics.map(cleanText).filter(Boolean);
}

function sanitizePeople(rawPeople, roles) {
  const defaultPeople = [roles.secretary, roles.deputy, ...roles.committee, ...roles.members];
  const people = normalizeNameList(rawPeople, defaultPeople);
  const merged = [roles.secretary, roles.deputy, ...roles.committee, ...people];
  return Array.from(new Set(merged.filter(Boolean)));
}

function normalizeNameList(value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map(cleanText).filter(Boolean);
    return list.length ? list : fallback;
  }
  const text = cleanText(value);
  if (!text) return fallback;
  const list = text
    .split(/[、,，\s]+/)
    .map(cleanText)
    .filter(Boolean);
  return list.length ? list : fallback;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSearchText(text) {
  return String(text || "")
    .replace(/\[(\d+)\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/Title:\s*/gi, "")
    .replace(/URL Source:\s*/gi, "")
    .replace(/Markdown Content:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeExcerpt(text, maxChars) {
  const compact = cleanSearchText(text);
  if (compact.length <= maxChars) return compact;
  const start = compact.search(/(习近平|中国共产党|中共中央|作风|党性|会议|条例|规定|决定|通知)/);
  const safeStart = start > 20 ? start : 0;
  return compact.slice(safeStart, safeStart + maxChars);
}

function toChineseNumber(number) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (number <= 10) return number === 10 ? "十" : digits[number];
  if (number < 20) return `十${digits[number - 10]}`;
  const tens = Math.floor(number / 10);
  const ones = number % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ""}`;
}
