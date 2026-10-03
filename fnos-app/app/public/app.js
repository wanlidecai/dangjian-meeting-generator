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
const settingsDetails = document.querySelector("#settingsDetails");
const settingsForm = document.querySelector("#settingsForm");
const apiKeyInput = document.querySelector("#apiKeyInput");
const clearApiKeyInput = document.querySelector("#clearApiKeyInput");
const modelInput = document.querySelector("#modelInput");
const basePathInput = document.querySelector("#basePathInput");
const sourceSearchInput = document.querySelector("#sourceSearchInput");
const settingsStatus = document.querySelector("#settingsStatus");
const keyConfiguredBadge = document.querySelector("#keyConfiguredBadge");
const configurationCallout = document.querySelector("#configurationCallout");
const saveSettingsBtn = document.querySelector("#saveSettingsBtn");
let resultMeetingType = null;
let savedSettings = null;
let settingsDirty = false;
let settingsLoading = null;
let settingsSaving = false;
let generating = false;

document.querySelector("#addTopicBtn").addEventListener("click", () => addTopic(""));
addPersonBtn.addEventListener("click", () => addPerson(""));
meetingTypeInput.addEventListener("change", updateMeetingTypeUI);
document.querySelector("#copyBtn").addEventListener("click", copyResult);
document.querySelector("#downloadBtn").addEventListener("click", downloadResult);
generateBtn.addEventListener("click", generateRecord);
settingsForm.addEventListener("submit", saveSettings);
document.querySelector("#configureBtn").addEventListener("click", openSettings);
[apiKeyInput, clearApiKeyInput, modelInput, basePathInput, sourceSearchInput].forEach((input) => input.addEventListener("input", () => {
  settingsDirty = true;
  apiKeyInput.disabled = clearApiKeyInput.checked || settingsSaving;
  setSettingsStatus("有修改待保存");
}));

for (const topic of defaultTopics) addTopic(topic);
for (const person of defaultPeople) addPerson(person);
updateMeetingTypeUI();
loadSettings().catch(() => {});

function apiUrl(endpoint) {
  const pathname = window.location.pathname;
  const directory = pathname.endsWith("/") ? pathname : pathname.endsWith("/index.html") ? pathname.slice(0, -10) : `${pathname}/`;
  return new URL(`./api/${endpoint}`, `${window.location.origin}${directory}`).href;
}

async function requestApi(endpoint, method = "GET", payload, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const options = { method, signal: controller.signal, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } };
  if (method !== "GET") {
    options.headers["Content-Type"] = "application/json";
    options.headers["X-Dangjian-Request"] = "1";
    options.body = JSON.stringify(payload || {});
  }
  try {
    const response = await fetch(apiUrl(endpoint), options);
    let data;
    try { data = await response.json(); }
    catch { throw new Error("服务返回了无法读取的结果，请检查应用是否正在运行。"); }
    if (!response.ok || data.ok === false) throw new Error(data.error || "操作失败，请稍后重试。");
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(method === "POST" ? "生成超时，请稍后重试。原有结果已保留。" : "连接超时，请检查 NAS 与本应用是否正常运行。");
    if (error instanceof TypeError) throw new Error("暂时无法连接服务，请检查 NAS 与本应用是否正在运行。");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function setSettingsStatus(text, isError = false) {
  settingsStatus.textContent = text;
  settingsStatus.classList.toggle("is-error", isError);
}

function showConfiguredState(settings) {
  const configured = Boolean(settings.api_key_configured);
  keyConfiguredBadge.textContent = configured ? "API Key 已配置" : "API Key 未配置";
  keyConfiguredBadge.classList.toggle("is-configured", configured);
  configurationCallout.hidden = configured;
  apiKeyInput.placeholder = configured ? "输入新密钥可替换；留空保留" : "输入 DeepSeek API Key";
}

async function loadSettings() {
  if (settingsLoading) return settingsLoading;
  settingsLoading = (async () => {
    try {
      const settings = await requestApi("settings");
      savedSettings = settings;
      showConfiguredState(settings);
      if (!settingsDirty) {
        modelInput.value = settings.model || "deepseek-v4-flash";
        sourceSearchInput.checked = settings.source_search !== false;
        basePathInput.value = settings.base_path || "/dangjian";
        setSettingsStatus("配置已读取，修改后请保存");
      }
      return settings;
    } catch (error) {
      keyConfiguredBadge.textContent = "配置读取失败";
      setSettingsStatus(error.message, true);
      throw error;
    }
  })();
  try { return await settingsLoading; }
  finally { settingsLoading = null; }
}

function openSettings() {
  settingsDetails.open = true;
  settingsDetails.scrollIntoView({ behavior: "smooth", block: "start" });
  apiKeyInput.focus({ preventScroll: true });
}

function lockSettings(locked) {
  [apiKeyInput, clearApiKeyInput, modelInput, basePathInput, sourceSearchInput, saveSettingsBtn].forEach((input) => { input.disabled = locked; });
  if (!locked) apiKeyInput.disabled = clearApiKeyInput.checked;
  saveSettingsBtn.textContent = locked ? "正在保存…" : "保存设置";
  saveSettingsBtn.setAttribute("aria-busy", String(locked));
}

async function saveSettings(event) {
  event.preventDefault();
  if (settingsSaving || generating) return;
  const model = modelInput.value.trim();
  const basePath = basePathInput.value.trim();
  if (!model) { setSettingsStatus("请填写模型名称。", true); modelInput.focus(); return; }
  if (!basePath.startsWith("/") || basePath.startsWith("//") || /[?#\\\s]/.test(basePath)) { setSettingsStatus("访问路径请以单个 / 开头，不要包含空格、查询参数或 #。", true); basePathInput.focus(); return; }
  const payload = { api_key: clearApiKeyInput.checked ? "" : apiKeyInput.value.trim(), clear_api_key: clearApiKeyInput.checked, model, source_search: sourceSearchInput.checked, base_path: basePath };
  settingsSaving = true;
  lockSettings(true);
  setSettingsStatus("正在保存设置…");
  try {
    const settings = await requestApi("settings", "PUT", payload);
    savedSettings = settings;
    settingsDirty = false;
    apiKeyInput.value = "";
    clearApiKeyInput.checked = false;
    modelInput.value = settings.model || model;
    sourceSearchInput.checked = settings.source_search !== false;
    basePathInput.value = settings.base_path || basePath;
    showConfiguredState(settings);
    setSettingsStatus(settings.api_key_configured ? "设置已保存，可以生成会议记录" : "设置已保存，请配置 API Key 后生成");
    if (settings.entry_path) {
      const entry = new URL(settings.entry_path, window.location.origin);
      if (entry.origin !== window.location.origin || entry.username || entry.password) throw new Error("设置已保存，但服务返回的访问路径不合法，请刷新后检查。");
      const currentPath = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
      if (entry.pathname !== currentPath) {
        setSettingsStatus("访问路径已保存，正在打开新路径…");
        window.location.assign(entry.pathname);
      }
    }
  } catch (error) {
    setSettingsStatus(error.message, true);
  } finally {
    settingsSaving = false;
    lockSettings(generating);
  }
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
  });
}

function getValues(selector, root = document) {
  return [...root.querySelectorAll(selector)]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function splitNames(text) {
  return text
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectPayload() {
  const meetingType = meetingTypeInput.value;
  const isCommittee = meetingType === "committee-meeting";
  const secretary = secretaryInput.value.trim() || "李强";
  const deputy = deputyInput.value.trim() || "郭琳";
  const committee = splitNames(committeeInput.value.trim() || "王丽");
  const members = isCommittee ? [] : getValues(".person-input", peopleList);
  const people = Array.from(new Set([secretary, deputy, ...committee, ...members]));

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
  if (generateBtn.disabled || settingsSaving) return;
  const payload = collectPayload();
  if (payload.topics.length === 0) {
    setStatus("请先填写议题", true);
    return;
  }

  setBusy(true);

  try {
    const settings = savedSettings || await loadSettings();
    if (!settings.api_key_configured) {
      setStatus("请先在应用设置中配置 DeepSeek API Key", true);
      setSettingsStatus("填写 API Key 并保存后即可生成", true);
      openSettings();
      return;
    }
    setStatus(settings.source_search ? "正在检索并生成..." : "正在生成...");
    const data = await requestApi("generate", "POST", payload, 240000);

    resultText.value = data.content || "";
    resultMeetingType = meetingTypeLabels[data.meetingType] ? data.meetingType : payload.meetingType;
    const resultLabel = meetingTypeLabels[resultMeetingType];
    resultTitle.textContent = `${resultLabel}记录`;
    resultText.setAttribute("aria-label", `${resultLabel}记录，可直接修改`);
    renderSources(data.sources || []);
    setStatus(`已生成${resultLabel}记录`);
  } catch (error) {
    setStatus(error.message || "生成失败", true);
    if (/密钥|API Key/i.test(error.message || "")) openSettings();
  } finally {
    setBusy(false);
  }
}

function renderSources(sources) {
  sourcesBox.replaceChildren();
  sourcesBox.classList.remove("show");
  if (!Array.isArray(sources) || !sources.length) return;
  const heading = document.createElement("div");
  heading.textContent = "参考来源";
  sourcesBox.append(heading);
  sources.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const row = document.createElement("div");
    const topic = document.createElement("strong");
    topic.textContent = String(item.topic || "议题");
    row.append(topic, document.createTextNode("："));
    const safeUrl = safeSourceUrl(item.url);
    if (safeUrl) {
      const link = document.createElement("a");
      link.href = safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = String(item.source || safeUrl);
      row.append(link);
    } else {
      row.append(document.createTextNode(String(item.source || "来源未提供")));
    }
    sourcesBox.append(row);
  });
  sourcesBox.classList.add("show");
}

function safeSourceUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

async function copyResult() {
  if (!resultText.value.trim()) {
    setStatus("没有可复制的内容", true);
    return;
  }
  const button = document.querySelector("#copyBtn");
  button.disabled = true;
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(resultText.value); setStatus("已复制"); return; }
      catch { /* NAS HTTP pages and denied clipboard permissions use the selection fallback. */ }
    }
    const previousFocus = document.activeElement;
    const selectionStart = resultText.selectionStart;
    const selectionEnd = resultText.selectionEnd;
    resultText.focus({ preventScroll: true });
    resultText.select();
    resultText.setSelectionRange(0, resultText.value.length);
    let copied = false;
    try { copied = document.execCommand("copy"); }
    catch { /* Keep all text selected so manual copy remains available. */ }
    if (!copied) { setStatus("浏览器未允许自动复制。内容已选中，请使用复制快捷键或长按复制。", true); return; }
    resultText.setSelectionRange(selectionStart, selectionEnd);
    if (previousFocus?.focus) previousFocus.focus({ preventScroll: true });
    setStatus("已复制");
  } catch {
    setStatus("复制未成功，请选中结果后使用复制快捷键或长按复制。", true);
  } finally {
    button.disabled = false;
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
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("已下载");
}

function setBusy(isBusy) {
  generating = isBusy;
  generateBtn.disabled = isBusy;
  generateBtn.setAttribute("aria-busy", String(isBusy));
  generateBtn.textContent = isBusy ? "生成中..." : "生成记录";
  lockSettings(isBusy || settingsSaving);
  if (isBusy) {
    saveSettingsBtn.textContent = "生成期间暂不可保存";
    saveSettingsBtn.setAttribute("aria-busy", "false");
  }
}

function setStatus(text, isError = false) {
  statusText.textContent = text;
  statusText.classList.toggle("is-error", isError);
}
