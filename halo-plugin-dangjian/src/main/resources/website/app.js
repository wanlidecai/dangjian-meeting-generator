"use strict";

const defaultPeople = ["刘广彪", "魏鹏飞", "许茜", "杨可来尔", "尹泽华"];
const defaultTopics = ["作风问题本质上是党性问题"];
const meetingTypeLabels = {
  "theme-day": "主题党日",
  "members-meeting": "党员大会",
  "committee-meeting": "支委会"
};

const meetingTypeInput = document.querySelector("#meetingTypeInput");
const branchMattersPanel = document.querySelector("#branchMattersPanel");
const branchMattersInput = document.querySelector("#branchMattersInput");
const committeePeopleHint = document.querySelector("#committeePeopleHint");
const topicsList = document.querySelector("#topicsList");
const peopleList = document.querySelector("#peopleList");
const addPersonBtn = document.querySelector("#addPersonBtn");
const topicTemplate = document.querySelector("#topicTemplate");
const personTemplate = document.querySelector("#personTemplate");
const secretaryInput = document.querySelector("#secretaryInput");
const deputyInput = document.querySelector("#deputyInput");
const committeeInput = document.querySelector("#committeeInput");
const resultText = document.querySelector("#resultText");
const resultTitle = document.querySelector("#resultTitle");
const statusText = document.querySelector("#statusText");
const sourcesBox = document.querySelector("#sourcesBox");
const generateBtn = document.querySelector("#generateBtn");
const accessText = document.querySelector("#accessText");
const loginLink = document.querySelector("#loginLink");
const retryDefaultsBtn = document.querySelector("#retryDefaultsBtn");
let resultMeetingType = null;
let runtimeConfig = null;
let isBusy = false;
let isLoadingDefaults = false;
let hasLoadedRoles = false;

document.querySelector("#addTopicBtn").addEventListener("click", () => addTopic(""));
addPersonBtn.addEventListener("click", () => addPerson(""));
meetingTypeInput.addEventListener("change", updateMeetingTypeUI);
document.querySelector("#copyBtn").addEventListener("click", copyResult);
document.querySelector("#downloadBtn").addEventListener("click", downloadResult);
generateBtn.addEventListener("click", generateRecord);
retryDefaultsBtn.addEventListener("click", loadDefaults);

for (const topic of defaultTopics) addTopic(topic);
for (const person of defaultPeople) addPerson(person);
updateMeetingTypeUI();
loadDefaults();

function getBasePath() {
  const value = document.querySelector('meta[name="dj-base-path"]').content;
  if (!value.startsWith("/") || value.startsWith("//") || /[?#\\]/.test(value)) {
    throw new Error("页面路径配置无效，请联系管理员");
  }
  const path = value.replace(/\/+$/, "");
  const url = new URL(path || "/", window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== (path || "/")) {
    throw new Error("页面路径配置无效，请联系管理员");
  }
  return path;
}

async function readJson(response, fallbackMessage) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(fallbackMessage);
  }
  return data;
}

async function loadDefaults() {
  if (isLoadingDefaults || isBusy) return;
  isLoadingDefaults = true;
  runtimeConfig = null;
  updateGenerateButton();
  showAccess("正在读取生成服务配置…");
  retryDefaultsBtn.hidden = true;
  loginLink.hidden = true;

  try {
    const response = await fetch(`${getBasePath()}/api/defaults`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    const data = await readJson(response, "未能读取生成服务配置，请稍后重试");
    if (!response.ok) throw new Error(data.error || "未能读取生成服务配置，请稍后重试");
    if (typeof data.canGenerate !== "boolean" || typeof data.requiresLogin !== "boolean"
        || !data.roles || typeof data.roles !== "object"
        || !Array.isArray(data.roles.committee) || !Array.isArray(data.roles.members)
        || typeof data.roles.secretary !== "string" || typeof data.roles.deputy !== "string") {
      throw new Error("生成服务配置不完整，请联系管理员或重新读取配置");
    }
    runtimeConfig = data;
    if (!hasLoadedRoles) {
      secretaryInput.value = data.roles.secretary;
      deputyInput.value = data.roles.deputy;
      committeeInput.value = data.roles.committee.join("、");
      peopleList.replaceChildren();
      for (const person of data.roles.members) addPerson(String(person));
      hasLoadedRoles = true;
    }
    updateAccess();
    setStatus(data.canGenerate ? "等待生成" : (getConfigurationMessage() || (data.requiresLogin ? "请先登录后生成" : "暂时无法生成")), !data.canGenerate);
  } catch (error) {
    showAccess(error.message || "未能读取生成服务配置，请稍后重试", true);
    retryDefaultsBtn.hidden = false;
    setStatus("配置读取失败，暂时无法生成", true);
  } finally {
    isLoadingDefaults = false;
    updateGenerateButton();
  }
}

function setLoginUrl(value) {
  if (typeof value !== "string" || !value || value.includes("__DJ_LOGIN_URL__")) return false;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol)) return false;
    loginLink.href = url.href;
    return true;
  } catch {
    return false;
  }
}

function updateAccess() {
  const configurationMessage = getConfigurationMessage();
  const canLogin = setLoginUrl(runtimeConfig.loginUrl) || setLoginUrl(loginLink.getAttribute("href"));
  loginLink.hidden = runtimeConfig.canGenerate || Boolean(configurationMessage) || !runtimeConfig.requiresLogin || !canLogin;
  if (configurationMessage) {
    showAccess(configurationMessage, !runtimeConfig.canGenerate);
  } else if (runtimeConfig.canGenerate) {
    showAccess(runtimeConfig.requiresLogin ? "已登录，可以生成会议记录。" : "生成服务已就绪，可以生成会议记录。");
  } else if (runtimeConfig.requiresLogin) {
    showAccess(canLogin ? "请先登录 Halo 账号，再生成会议记录。输入内容可以先编辑。" : "生成记录需要登录，请联系管理员获取登录入口。");
  } else {
    showAccess("生成服务暂不可用，请联系管理员或重新读取配置。", true);
  }
  retryDefaultsBtn.hidden = runtimeConfig.canGenerate || (runtimeConfig.requiresLogin && !configurationMessage);
}

function getConfigurationMessage() {
  return typeof runtimeConfig?.configurationMessage === "string" ? runtimeConfig.configurationMessage.trim() : "";
}

function showAccess(message, isError = false) {
  accessText.textContent = message;
  accessText.closest(".access-panel").dataset.error = String(isError);
}

function updateMeetingTypeUI() {
  const isCommittee = meetingTypeInput.value === "committee-meeting";
  branchMattersPanel.hidden = !isCommittee;
  peopleList.hidden = isCommittee;
  addPersonBtn.hidden = isCommittee;
  committeePeopleHint.hidden = !isCommittee;
}

function addTopic(value) {
  const node = topicTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".topic-input").value = value;
  node.querySelector(".remove-btn").addEventListener("click", () => {
    if (topicsList.children.length === 1) {
      node.querySelector(".topic-input").value = "";
    } else {
      node.remove();
      refreshTopicIndexes();
    }
  });
  topicsList.appendChild(node);
  refreshTopicIndexes();
}

function addPerson(value) {
  const node = personTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".person-input").value = value;
  node.querySelector(".remove-person-btn").addEventListener("click", () => node.remove());
  peopleList.appendChild(node);
}

function refreshTopicIndexes() {
  [...topicsList.children].forEach((row, index) => {
    row.querySelector(".topic-index").textContent = index + 1;
    row.querySelector(".topic-input").setAttribute("aria-label", `议题 ${index + 1}`);
  });
}

function getValues(selector, root = document) {
  return [...root.querySelectorAll(selector)].map((input) => input.value.trim()).filter(Boolean);
}

function splitNames(text) {
  return text.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function collectPayload() {
  const meetingType = meetingTypeInput.value;
  const isCommittee = meetingType === "committee-meeting";
  const roles = runtimeConfig.roles;
  const secretary = secretaryInput.value.trim() || roles.secretary;
  const deputy = deputyInput.value.trim() || roles.deputy;
  const committee = splitNames(committeeInput.value.trim() || roles.committee.join("、"));
  const members = isCommittee ? [] : getValues(".person-input", peopleList);
  const people = Array.from(new Set([secretary, deputy, ...committee, ...members].filter(Boolean)));
  return {
    meetingType,
    branchMatters: isCommittee
      ? branchMattersInput.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : [],
    topics: getValues(".topic-input", topicsList),
    secretary,
    deputy,
    committee,
    members,
    people
  };
}

async function generateRecord() {
  if (isBusy) return;
  if (!runtimeConfig || !runtimeConfig.canGenerate) {
    setStatus(getConfigurationMessage() || (runtimeConfig?.requiresLogin ? "请先登录后生成" : "生成服务尚未就绪，请重新读取配置"), true);
    return;
  }
  const payload = collectPayload();
  if (payload.topics.length === 0) {
    setStatus("请先填写议题", true);
    return;
  }
  setBusy(true);
  setStatus("正在检索并生成...");
  sourcesBox.classList.remove("show");
  sourcesBox.replaceChildren();

  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (typeof runtimeConfig.csrfToken === "string" && runtimeConfig.csrfToken
        && typeof runtimeConfig.csrfHeader === "string" && runtimeConfig.csrfHeader) {
      headers[runtimeConfig.csrfHeader] = runtimeConfig.csrfToken;
    }
    const response = await fetch(`${getBasePath()}/api/generate`, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(payload)
    });
    const data = await readJson(response, "生成服务响应异常，请稍后重试");
    if (!response.ok) {
      if (response.status === 401) {
        runtimeConfig.canGenerate = false;
        runtimeConfig.requiresLogin = true;
        updateAccess();
      } else if (response.status === 403) {
        runtimeConfig.canGenerate = false;
        showAccess("登录状态或安全校验已变化，请重新读取配置后再生成。", true);
        retryDefaultsBtn.hidden = false;
      }
      throw new Error(data.error || (response.status === 401 ? "登录已失效，请重新登录" : "生成失败，请稍后重试"));
    }
    if (typeof data.content !== "string" || !data.content.trim()) {
      throw new Error("生成结果为空，请调整议题后重试");
    }
    resultText.value = data.content;
    resultMeetingType = Object.prototype.hasOwnProperty.call(meetingTypeLabels, data.meetingType) ? data.meetingType : payload.meetingType;
    const resultLabel = meetingTypeLabels[resultMeetingType];
    resultTitle.textContent = `${resultLabel}记录`;
    resultText.setAttribute("aria-label", `${resultLabel}记录，可直接修改`);
    renderSources(Array.isArray(data.sources) ? data.sources : []);
    setStatus(`已生成${resultLabel}记录`);
  } catch (error) {
    setStatus(error.message || "生成失败，请稍后重试", true);
  } finally {
    setBusy(false);
  }
}

function sourceUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function renderSources(sources) {
  sourcesBox.replaceChildren();
  const items = sources.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!items.length) return;
  const title = document.createElement("div");
  title.textContent = "参考来源";
  sourcesBox.appendChild(title);
  for (const item of items) {
    const row = document.createElement("div");
    const topic = document.createElement("strong");
    topic.textContent = String(item.topic || "议题");
    row.append(topic, "：");
    const url = sourceUrl(item.url);
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = String(item.source || "查看来源");
      row.appendChild(link);
    } else {
      row.append(String(item.source || "无"));
    }
    sourcesBox.appendChild(row);
  }
  sourcesBox.classList.add("show");
}

async function copyResult() {
  if (!resultText.value.trim()) {
    setStatus("没有可复制的内容", true);
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用");
    await navigator.clipboard.writeText(resultText.value);
    setStatus("已复制");
    return;
  } catch {
    // Legacy copy also works on many plain-HTTP pages and restricted browsers.
  }
  const activeElement = document.activeElement;
  const selectionStart = resultText.selectionStart;
  const selectionEnd = resultText.selectionEnd;
  resultText.focus();
  resultText.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  if (copied) {
    resultText.setSelectionRange(selectionStart, selectionEnd);
    activeElement?.focus();
    setStatus("已复制");
  } else {
    setStatus("浏览器未允许自动复制，已选中记录，请长按复制或按 Ctrl+C / ⌘C。", true);
  }
}

function downloadResult() {
  const content = resultText.value.trim();
  if (!content) {
    setStatus("没有可下载的内容", true);
    return;
  }
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  link.href = url;
  const resultLabel = meetingTypeLabels[resultMeetingType || meetingTypeInput.value];
  link.download = `${resultLabel}记录-${date}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("已下载");
}

function updateGenerateButton() {
  generateBtn.disabled = isBusy || isLoadingDefaults || !runtimeConfig?.canGenerate;
  generateBtn.textContent = isBusy ? "生成中..." : "生成记录";
  generateBtn.setAttribute("aria-busy", String(isBusy));
}

function setBusy(value) {
  isBusy = value;
  updateGenerateButton();
}

function setStatus(text, isError = false) {
  statusText.textContent = text;
  statusText.style.color = isError ? "#b3261e" : "";
}
