"use strict";
const path = require("node:path");
const { PublicError, SettingsStore, createRuntime, listen, parseArguments } = require("./lib/runtime");
const { fetchPublicHtml, resolvePublicUrl, readLimitedJson, abortable } = require("./lib/network");
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

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

async function generateRecord(payload, options = {}) {
  const config = options.config || { api_key: "", model: "deepseek-v4-flash", source_search: true };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new PublicError("生成参数必须是 JSON 对象");
  const meetingType = normalizeMeetingType(payload.meetingType);
  const isCommitteeMeeting = meetingType === "committee-meeting";
  const branchMatters = isCommitteeMeeting ? sanitizeBranchMatters(payload.branchMatters) : [];

  if (!config.api_key) throw new PublicError("请先在应用设置中配置 DeepSeek API 密钥");

  const topics = sanitizeTopics(payload.topics);
  if (topics.length === 0) {
    throw new PublicError("请至少填写一个议题。");
  }

  const secretary = cleanText(payload.secretary) || defaultRoles.secretary;
  const deputy = cleanText(payload.deputy) || defaultRoles.deputy;
  if (secretary.length > 120 || deputy.length > 120) throw new PublicError("每个姓名最多 120 个字符");
  const committee = normalizeNameList(payload.committee, defaultRoles.committee);
  const members = isCommitteeMeeting ? [] : normalizeNameList(payload.members, defaultRoles.members);
  const people = sanitizePeople(isCommitteeMeeting ? [] : payload.people, { secretary, deputy, committee, members });
  let sourcePack;
  if (config.source_search) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.sourceTimeoutMs ?? 30000);
    try {
      sourcePack = await abortable((options.sourceProvider || buildSourcePack)(topics, { ...options.sourceOptions, signal: controller.signal }), controller.signal);
    } catch {
      sourcePack = topics.map((topic) => ({ topic, source: "搜索未成功，DeepSeek根据题目生成", url: "", excerpt: "" }));
    } finally {
      clearTimeout(timeout);
    }
  } else {
    sourcePack = topics.map((topic) => ({ topic, source: "未开启联网检索，DeepSeek根据题目生成", url: "", excerpt: "" }));
  }

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.modelTimeoutMs ?? 90000);
  let data;
  try {
    const response = await abortable((options.fetch || global.fetch)(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`
    },
    body: JSON.stringify({
      model: config.model,
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
    }),
    redirect: "error",
    signal: controller.signal
    }), controller.signal);
    if (!response.ok) {
      throw new PublicError(`模型请求失败（HTTP ${Number(response.status) || 502}），请检查密钥、模型或稍后重试`, 502);
    }
    data = await abortable(readLimitedJson(response), controller.signal);
  } catch (error) {
    if (error instanceof PublicError) throw error;
    if (controller.signal.aborted) throw new PublicError("模型生成超时，请减少议题或稍后重试", 504);
    throw new PublicError("模型连接失败，请检查网络后重试", 502);
  } finally {
    clearTimeout(timeout);
  }

  const modelContent = data?.choices?.[0]?.message?.content;
  let content = typeof modelContent === "string" ? modelContent.trim() : "";
  if (!content) {
    throw new PublicError("模型未返回有效内容，请稍后重试", 502);
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

async function buildSourcePack(topics, options = {}) {
  const result = new Array(topics.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(3, topics.length) }, async () => {
    while (next < topics.length) {
      const index = next++;
      const topic = topics[index];
      const source = options.signal?.aborted ? { source: "搜索未成功，DeepSeek根据题目生成", url: "", excerpt: "" }
        : await searchTopic(topic, index === 0, options);
      result[index] = { topic, ...source };
    }
  });
  await Promise.all(workers);
  return result;
}

const SEARCH_ENGINES = [
  {
    name: "搜狗搜索",
    search: (topic, options) => searchWithHtmlEngine("搜狗搜索", topic, (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`, options)
  },
  {
    name: "360搜索",
    search: (topic, options) => searchWithHtmlEngine("360搜索", topic, (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}`, options)
  },
  {
    name: "必应搜索",
    search: (topic, options) => searchWithBing(topic, options)
  }
];

async function searchWithHtmlEngine(name, topic, buildUrl, options) {
  let html = await fetchRemoteHtml(buildUrl(`${topic} 原文`), 12000, options);
  let results = html ? parseHtmlResults(html) : [];
  if (results.length === 0) {
    html = await fetchRemoteHtml(buildUrl(topic), 12000, options);
    results = html ? parseHtmlResults(html) : [];
  }
  return { name, results };
}

async function searchWithBing(topic, options) {
  const buildUrl = (query) =>
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=12&mkt=zh-CN&setlang=zh-hans`;
  let xml = await fetchRemoteHtml(buildUrl(`${topic} 原文`), 12000, options);
  let results = xml ? parseBingRss(xml) : [];
  if (results.length === 0) {
    xml = await fetchRemoteHtml(buildUrl(topic), 12000, options);
    results = xml ? parseBingRss(xml) : [];
  }
  return { name: "必应搜索", results };
}

async function searchTopic(topic, isFirstTopic, options = {}) {
  const maxChars = isFirstTopic ? 320 : 180;
  const fallback = {
    source: "DeepSeek根据题目生成",
    url: "",
    excerpt: ""
  };

  let engine = "";
  let results = [];
  for (const candidate of SEARCH_ENGINES) {
    if (options.signal?.aborted) return { ...fallback, source: `搜索未成功，${fallback.source}` };
    try {
      const found = await candidate.search(topic, options);
      if (found.results.length > 0) {
        engine = found.name;
        results = found.results;
        break;
      }
    } catch {
      // Fall back to another public engine; never print raw remote errors or URLs.
    }
  }
  if (results.length === 0) {
    return { ...fallback, source: `搜索未成功，${fallback.source}` };
  }

  // 搜索结果链接可能是跳转页（搜狗/360），先解析出真实地址
  const resolved = [];
  for (const item of results.slice(0, 4)) {
    if (options.signal?.aborted) break;
    const url = await resolveResultUrl(item.url, options);
    if (url) {
      try {
        const target = await resolvePublicUrl(url, options.lookup, options.signal);
        resolved.push({ ...item, url: target.url.href });
      } catch { /* omit unsafe or unresolvable search-result links */ }
    }
  }

  // 优先打开标题/摘要与议题最贴近的结果
  const scored = resolved
    .map((item) => ({ ...item, score: countTopicHits(`${item.title} ${item.snippet}`, topic) }))
    .sort((a, b) => b.score - a.score);

  // 逐个打开结果页面，提取与议题相关的正文；只接受真正的文章段落
  let excerpt = "";
  let pickedUrl = "";
  let bestExcerpt = "";
  let bestUrl = "";
  let bestHits = 0;
  for (const item of scored) {
    if (options.signal?.aborted) break;
    const text = await fetchPageText(item.url, 10000, options);
    if (!text) continue;
    const windowed = makeExcerpt(text, maxChars, topic);
    if (!windowed) continue;
    const hits = countTopicHits(windowed, topic);
    const sentences = (windowed.match(/[。，；]/g) || []).length;
    const pipes = (windowed.match(/\|/g) || []).length;
    if (windowed.length >= 80 && hits >= 1 && sentences >= 2 && pipes <= 4) {
      excerpt = windowed;
      pickedUrl = item.url;
      break;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestExcerpt = windowed;
      bestUrl = item.url;
    }
  }
  if (!excerpt && bestExcerpt) {
    excerpt = bestExcerpt;
    pickedUrl = bestUrl;
  }
  if (!excerpt) {
    excerpt = makeExcerpt(scored.map((item) => item.snippet).filter(Boolean).join(" "), maxChars, topic);
    pickedUrl = scored[0]?.url || "";
  }

  return {
    source: engine,
    url: pickedUrl,
    excerpt
  };
}

async function fetchRemoteHtml(url, timeoutMs, options = {}) {
  if (options.signal?.aborted) return "";
  try {
    return await fetchPublicHtml(url, { ...options, timeoutMs });
  } catch {
    return "";
  }
}

async function fetchPageText(url, timeoutMs, options) {
  return stripHtmlToText(await fetchRemoteHtml(url, timeoutMs, options));
}

async function resolveResultUrl(url, options) {
  if (!url || options?.signal?.aborted) return "";
  if (/^\/link\?/.test(url)) url = `https://www.sogou.com${url}`;
  if (!/sogou\.com\/link\?|so\.com\/link\?/i.test(url)) return url;
  const html = await fetchRemoteHtml(url, 8000, options);
  if (!html) return "";
  const match =
    /window\.location(?:\.replace|\.href)\s*[=(]\s*["']([^"']+)["']/i.exec(html) ||
    /<noscript>[\s\S]*?URL=['"]([^'"]+)['"]/i.exec(html) ||
    /http-equiv=["']refresh["']\s+content=["'][^"']*url=([^"';\s]+)/i.exec(html);
  return match ? match[1] : "";
}

function parseHtmlResults(html) {
  const results = [];
  const h3Pattern = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match;
  while ((match = h3Pattern.exec(html)) && results.length < 8) {
    const anchor = /<a[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/i.exec(match[1]);
    if (!anchor) continue;
    const title = stripHtmlToText(match[1]);
    if (title.length < 6) continue;
    let rest = html.slice(h3Pattern.lastIndex, h3Pattern.lastIndex + 1600);
    const nextH3 = rest.search(/<h3[^>]*>/i);
    if (nextH3 !== -1) rest = rest.slice(0, nextH3);
    const cut = rest.search(/推荐您搜索|猜你|相关搜索|搜索历史/);
    if (cut !== -1) rest = rest.slice(0, cut);
    const snippet = stripHtmlToText(rest).slice(0, 260);
    results.push({ title, url: anchor[1], snippet });
  }
  return results;
}

function parseBingRss(xml) {
  const results = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(xml)) && results.length < 8) {
    const block = match[1];
    const title = decodeXml(extractTag(block, "title"));
    const link = decodeXml(extractTag(block, "link"));
    const description = stripHtmlToText(decodeXml(extractTag(block, "description")));
    if (!title || !link) continue;
    results.push({ title, url: link, snippet: description.slice(0, 260) });
  }
  return results;
}

function extractTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match ? match[1] : "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtmlToText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMeetingType(value) {
  const meetingType = cleanText(value) || "theme-day";
  if (!Object.prototype.hasOwnProperty.call(meetingTypes, meetingType)) {
    throw new PublicError("不支持的会议类型，请选择主题党日、党员大会或支委会。");
  }
  return meetingType;
}

function sanitizeBranchMatters(value) {
  const matters = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const cleaned = matters.map(cleanText).filter(Boolean);
  if (cleaned.length > 20 || cleaned.some((matter) => matter.length > 1000)) throw new PublicError("支部事项最多 20 项，每项最多 1000 个字符");
  return cleaned.length ? Array.from(new Set(cleaned)) : [...defaultBranchMatters];
}

function sanitizeTopics(rawTopics) {
  if (!Array.isArray(rawTopics)) return [];
  if (rawTopics.length > 30 || rawTopics.some((topic) => typeof topic !== "string" || topic.length > 1000)) {
    throw new PublicError("一次最多生成 30 个议题，每个议题最多 1000 个字符");
  }
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
    if (list.length > 50 || list.some((name) => name.length > 120)) throw new PublicError("名单最多 50 人，每个姓名最多 120 个字符");
    return list.length ? list : fallback;
  }
  const text = cleanText(value);
  if (!text) return fallback;
  const list = text
    .split(/[、,，\s]+/)
    .map(cleanText)
    .filter(Boolean);
  if (list.length > 50 || list.some((name) => name.length > 120)) throw new PublicError("名单最多 50 人，每个姓名最多 120 个字符");
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

function topicKeywordPattern(topic) {
  const cleaned = String(topic || "")
    .replace(/[《》〈〉（）()【】\[\]“”"'‘’.,。，：:；;！!？?\s]/g, "");
  if (!cleaned) return null;
  const parts = [];
  if (cleaned.length <= 8) {
    parts.push(cleaned);
  } else {
    for (let size = Math.min(6, cleaned.length); size >= 2; size -= 1) {
      for (let index = 0; index + size <= cleaned.length; index += 1) {
        parts.push(cleaned.slice(index, index + size));
      }
    }
  }
  try {
    return new RegExp(Array.from(new Set(parts)).map(escapeRegExp).join("|"), "g");
  } catch {
    return null;
  }
}

function countTopicHits(text, topic) {
  const pattern = topicKeywordPattern(topic);
  if (!pattern) return 0;
  return (String(text || "").match(pattern) || []).length;
}

function makeExcerpt(text, maxChars, topic) {
  const compact = cleanSearchText(text);
  if (!compact) return "";
  if (compact.length <= maxChars) return compact;

  const topicPattern = topicKeywordPattern(topic);
  const genericPattern = /(习近平|中国共产党|中共中央|作风|党性|会议|条例|规定|决定|通知|学习|贯彻|精神)/g;

  // 候选位置：先找议题关键词，找不到再用通用党建关键词
  const positions = [];
  if (topicPattern) {
    let match;
    while ((match = topicPattern.exec(compact)) && positions.length < 12) {
      positions.push(match.index);
    }
  }
  if (positions.length === 0) {
    let match;
    while ((match = genericPattern.exec(compact)) && positions.length < 12) {
      positions.push(match.index);
    }
  }
  if (positions.length === 0) return compact.slice(0, maxChars);

  // 选择关键词密度最高的窗口，避开导航栏等与正文无关的内容
  let bestStart = 0;
  let bestScore = -1;
  for (const position of positions) {
    const start = Math.max(0, position - 30);
    const windowText = compact.slice(start, start + maxChars);
    const topicHits = topicPattern ? (windowText.match(topicPattern) || []).length : 0;
    const genericHits = (windowText.match(genericPattern) || []).length;
    const score = topicHits * 3 + genericHits;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return compact.slice(bestStart, bestStart + maxChars);
}

function toChineseNumber(number) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (number <= 10) return number === 10 ? "十" : digits[number];
  if (number < 20) return `十${digits[number - 10]}`;
  const tens = Math.floor(number / 10);
  const ones = number % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ""}`;
}

function createApplication(options = {}) {
  let active = 0;
  return createRuntime({ options, publicDir: options.publicDir || path.join(__dirname, "public"), defaultRoles,
    generate: async (payload, config) => {
      if (active >= 2) throw new PublicError("当前已有生成任务，请等待完成后重试", 429);
      active++;
      try { return await generateRecord(payload, { ...options, config }); }
      finally { active--; }
    } });
}

async function startServer(options = {}) {
  const server = createApplication(options);
  try { return await listen(server, options); }
  catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError("服务无法启动，请检查监听路径、端口或权限", 500);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("开发：node server.js --dev --port 8787 --data-dir <目录>\n飞牛：node server.js --socket <Unix Socket> --data-dir <目录>");
    return;
  }
  options.dataDir ||= process.env.TRIM_PKGVAR || (options.dev ? path.join(__dirname, "..", ".dev-data") : "");
  const server = await startServer(options);
  console.log("党建会议记录生成器已启动：" + (options.dev ? `http://127.0.0.1:${server.address().port}${server.settings.publicSettings(true).entry_path}` : "飞牛原生网关"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
}

module.exports = { createApplication, startServer, generateRecord, buildPrompt, buildSourcePack,
  trimExtraSections, normalizeMeetingType, sanitizeTopics, sanitizeBranchMatters, defaultRoles, meetingTypes,
  SettingsStore, PublicError, fetchRemoteHtml, fetchPublicHtml };

if (require.main === module) main().catch((error) => {
  console.error(error instanceof PublicError ? error.message : "应用启动失败，请检查配置与运行环境");
  process.exitCode = 1;
});
