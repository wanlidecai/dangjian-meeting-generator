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
let resultMeetingType = null;

document.querySelector("#addTopicBtn").addEventListener("click", () => addTopic(""));
addPersonBtn.addEventListener("click", () => addPerson(""));
meetingTypeInput.addEventListener("change", updateMeetingTypeUI);
document.querySelector("#copyBtn").addEventListener("click", copyResult);
document.querySelector("#downloadBtn").addEventListener("click", downloadResult);
generateBtn.addEventListener("click", generateRecord);

for (const topic of defaultTopics) addTopic(topic);
for (const person of defaultPeople) addPerson(person);
updateMeetingTypeUI();

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
  const payload = collectPayload();
  if (payload.topics.length === 0) {
    setStatus("请先填写议题", true);
    return;
  }

  setBusy(true);
  setStatus("正在检索并生成...");
  sourcesBox.classList.remove("show");
  sourcesBox.innerHTML = "";

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成失败");

    resultText.value = data.content || "";
    resultMeetingType = meetingTypeLabels[data.meetingType] ? data.meetingType : payload.meetingType;
    const resultLabel = meetingTypeLabels[resultMeetingType];
    resultTitle.textContent = `${resultLabel}记录`;
    resultText.setAttribute("aria-label", `${resultLabel}记录，可直接修改`);
    renderSources(data.sources || []);
    setStatus(`已生成${resultLabel}记录`);
  } catch (error) {
    setStatus(error.message || "生成失败", true);
  } finally {
    setBusy(false);
  }
}

function renderSources(sources) {
  if (!sources.length) return;
  const items = sources
    .map((item) => {
      const source = item.url
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.source)}</a>`
        : escapeHtml(item.source || "无");
      return `<div><strong>${escapeHtml(item.topic)}</strong>：${source}</div>`;
    })
    .join("");
  sourcesBox.innerHTML = `<div>参考来源</div>${items}`;
  sourcesBox.classList.add("show");
}

async function copyResult() {
  if (!resultText.value.trim()) {
    setStatus("没有可复制的内容", true);
    return;
  }
  await navigator.clipboard.writeText(resultText.value);
  setStatus("已复制");
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
  link.click();
  URL.revokeObjectURL(url);
  setStatus("已下载");
}

function setBusy(isBusy) {
  generateBtn.disabled = isBusy;
  generateBtn.textContent = isBusy ? "生成中..." : "生成记录";
}

function setStatus(text, isError = false) {
  statusText.textContent = text;
  statusText.style.color = isError ? "#b3261e" : "";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
