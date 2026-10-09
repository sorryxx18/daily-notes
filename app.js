// 工作筆記：iPAS 小考網頁版。資料流：本頁 ⇄ GAS（notes-sync）⇄ Mac mini ⇄ 備考 bot。
const POLL_MS = 20000;
const SESSION_KEY = "dn_session";   // {id, exp}
let session = null;
let snapshot = null;
let pendingInbox = [];
let lastConvLen = -1;
const drafts = {};   // set_no -> {qIndex: letter}，輪詢重畫時保留尚未送出的選擇
// 說明、講解的展開狀態：使用者點開或收起過的照他的，重畫（每 20 秒輪詢）時不會被還原成預設
const OPEN_KEY = "dn_open";
let openState = {};
try { openState = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}") || {}; } catch (e) {}
const isOpen = (key, dflt) => (key in openState ? openState[key] : dflt);
let lastDrawn = "";   // 上次畫的內容；資料沒變就不重畫，捲動位置和選取的文字才不會被打斷

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 低調：把 bot 回覆裡的表情符號換成文字或拿掉
function plain(s) {
  return String(s ?? "")
    .replace(/✅/g, "【對】").replace(/❌/g, "【錯】").replace(/⚠️?/g, "【注意】")
    .replace(/🔑/g, "重點：").replace(/➕/g, "加碼").replace(/⏰/g, "")
    .replace(/([0-9])\uFE0F?\u20E3/g, "$1.")   // 1️⃣ 這種數字方塊改成「1.」
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "");
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

// ---- 登入 ----
// Google 登入拿到 ID token 後，送去後端排隊；Mac mini 向 Google 驗證通過才核准這個 session（約 20 秒）。
// 核准後 14 天內這台電腦不用再登入。
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (s && s.id && s.exp > Date.now()) return s;
  } catch (e) {}
  return null;
}

function newSessionId() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function initGoogle(retries) {
  if (!(window.google && google.accounts && google.accounts.id)) {
    if (retries > 0) setTimeout(() => initGoogle(retries - 1), 150);
    return;
  }
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true });
  google.accounts.id.renderButton($("#gbtn"), { theme: "outline", size: "medium", text: "signin_with" });
  if (!session) google.accounts.id.prompt();
}

async function onCredential(resp) {
  const id = newSessionId();
  $("#loginErr").textContent = "確認身分中，約 20 秒…";
  try {
    await post({ action: "login", session: id, id_token: resp.credential });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await post({ action: "login_status", session: id });
      if (st.status === "approved") {
        session = { id, exp: Date.now() + 13.5 * 86400000 };
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
        $("#loginErr").textContent = "";
        showMain();
        refresh();
        return;
      }
      if (st.status === "rejected") { $("#loginErr").textContent = "此帳號沒有權限。"; return; }
    }
    $("#loginErr").textContent = "確認逾時，請稍後再按一次登入。";
  } catch (e) {
    $("#loginErr").textContent = "連線失敗，請稍後再試。";
  }
}

function showLogin(msg) {
  session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  $("#main").hidden = true; $("#logout").hidden = true; $("#login").hidden = false;
  $("#loginErr").textContent = msg || "";
}

function showMain() { $("#login").hidden = true; $("#main").hidden = false; $("#logout").hidden = false; }

// ---- 後端 ----
async function post(payload) {
  const res = await fetch(GAS_URL, { method: "POST", body: JSON.stringify(payload) });
  return res.json();
}

async function api(payload) {
  const data = await post({ ...payload, session: session && session.id });
  if (!data.ok && ["login required", "login expired"].includes(data.error)) { showLogin("登入已過期，請重新登入。"); throw new Error(data.error); }
  if (!data.ok && data.error === "forbidden") { showLogin("此帳號沒有權限。"); throw new Error("forbidden"); }
  return data;
}

async function refresh() {
  if (!session) return;
  if (session.exp < Date.now()) { showLogin("登入已過期，請重新登入。"); return; }
  try {
    const data = await api({ action: "state" });
    snapshot = data.snapshot || {};
    pendingInbox = data.inbox || [];
    const sig = JSON.stringify([{ ...snapshot, synced_at: null }, pendingInbox]);
    if (sig === lastDrawn) { $("#sync").textContent = snapshot.synced_at ? `更新 ${fmtTime(snapshot.synced_at)}` : ""; return; }
    lastDrawn = sig;
    render();
  } catch (e) {
    $("#sync").textContent = "連線失敗，稍後重試";
  }
}

// ---- 畫面 ----
function render() {
  const s = snapshot || {};
  $("#sync").textContent = s.synced_at ? `更新 ${fmtTime(s.synced_at)}` : "";
  const n = (s.open_sets || []).length;
  $("#todoCount").textContent = n ? `(${n})` : "";
  document.title = n ? `(${n}) 工作筆記` : "工作筆記";
  renderTodo(s); renderDone(s); renderTalk(s);
}

function pendingSets() {
  return new Set(pendingInbox.filter((i) => i.kind === "answer").map((i) => Number(i.payload.set_no)));
}

function renderTodo(s) {
  const box = $("#tab-todo");
  const sets = s.open_sets || [];
  if (!sets.length) { box.innerHTML = `<p class="note">目前沒有待辦。</p>`; return; }
  const waiting = pendingSets();
  box.innerHTML = sets.map((set) => {
    const busy = waiting.has(set.set_no);
    const qs = set.questions.map((q, i) => {
      const chosen = (drafts[set.set_no] || {})[i];
      const opts = Object.entries(q.options).map(([k, v]) =>
        `<label class="opt"><input type="radio" name="s${set.set_no}q${i}" value="${k}" ${chosen === k ? "checked" : ""} ${busy ? "disabled" : ""}>${k}. ${esc(v)}</label>`).join("");
      const unsure = `<label class="opt"><input type="radio" name="s${set.set_no}q${i}" value="?" ${chosen === "?" ? "checked" : ""} ${busy ? "disabled" : ""}>不確定</label>`;
      return `<div class="q"><div class="src">${i + 1}．${esc(q.point)}${q.mode === "review" ? "（複習）" : ""}</div><p>${esc(q.question)}</p>${opts}${unsure}</div>`;
    }).join("");
    return `<div class="set" data-set="${set.set_no}">
      <h2>第 ${set.set_no} 組${set.extra ? "（加碼）" : ""} <span class="note">${fmtTime(set.asked_at)}</span></h2>
      ${qs}
      ${busy ? `<p class="note">已送出，批改中…（約 1 分鐘）</p>` : `<button class="submit" data-set="${set.set_no}">送出答案</button> <span class="err" id="err${set.set_no}"></span>`}
    </div>`;
  }).join("");
  box.querySelectorAll("input[type=radio]").forEach((el) => el.addEventListener("change", () => {
    const [, sn, qi] = el.name.match(/^s(\d+)q(\d+)$/);
    (drafts[sn] = drafts[sn] || {})[qi] = el.value;
  }));
  box.querySelectorAll("button.submit").forEach((b) => b.addEventListener("click", () => submitSet(Number(b.dataset.set))));
}

async function submitSet(setNo) {
  const set = (snapshot.open_sets || []).find((x) => x.set_no === setNo);
  const letters = set.questions.map((q, i) => (drafts[setNo] || {})[i] || "").join("");
  if (letters.length !== set.questions.length) { $(`#err${setNo}`).textContent = "每題都要選一個（不會可以選「不確定」）"; return; }
  try {
    await api({ action: "send", kind: "answer", payload: { set_no: setNo, letters } });
    pendingInbox.push({ kind: "answer", payload: { set_no: setNo } });
    lastDrawn = "";
    render();
  } catch (e) {
    const el = $(`#err${setNo}`); if (el) el.textContent = "送出失敗，請再試一次";
  }
}

function renderDone(s) {
  const sets = s.graded || [];
  $("#tab-done").innerHTML = sets.length ? sets.map((set, n) => {
    const score = set.questions.filter((q) => q.given === q.answer).length;
    const qs = set.questions.map((q, i) => {
      const ok = q.given === q.answer;
      return `<div class="q"><div class="src">${i + 1}．${esc(q.point)}</div><p>${esc(q.question)}</p>
        ${Object.entries(q.options).map(([k, v]) => `<div class="opt">${k}. ${esc(v)}</div>`).join("")}
        <div class="res ${ok ? "ok" : "bad"}">${ok ? "正確" : "錯誤"}：選 ${esc(q.given || "-")}，答案 ${esc(q.answer)}</div>
        <details data-k="${set.set_no}-${i}" ${isOpen(`${set.set_no}-${i}`, !ok) ? "open" : ""}><summary>說明</summary><div class="explain">${esc(plain(q.explain))}</div></details></div>`;
    }).join("");
    // 助教當下的完整批改（和手機上看到的同一則）；最新一組預設展開，其餘預設收起
    const review = set.review ? `<details class="review" data-k="${set.set_no}-r" ${isOpen(`${set.set_no}-r`, n === 0) ? "open" : ""}><summary>助教完整講解</summary><div class="explain">${esc(plain(set.review))}</div></details>` : "";
    return `<div class="set"><h2>第 ${set.set_no} 組　${score}/${set.questions.length} <span class="note">${fmtTime(set.answered_at)}</span></h2>${qs}${review}</div>`;
  }).join("") : `<p class="note">還沒有紀錄。</p>`;
  $("#tab-done").querySelectorAll("details[data-k]").forEach((d) => d.addEventListener("toggle", () => {
    openState[d.dataset.k] = d.open;
    const keys = Object.keys(openState);
    if (keys.length > 400) keys.slice(0, keys.length - 400).forEach((k) => delete openState[k]);   // 只留最近的，免得越存越多
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(openState)); } catch (e) {}
  }));
}

function renderTalk(s) {
  const conv = s.conversation || [];
  const waiting = pendingInbox.filter((i) => i.kind === "message");
  const who = { web: "我（網頁）", tg: "我（手機）", bot: "助教" };
  const box = $("#talk");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = conv.map((m) => `<div class="m ${m.src === "bot" ? "" : "me"}"><div class="who">${who[m.src] || m.src}　${fmtTime(m.ts)}</div><div class="body">${esc(plain(m.text))}</div></div>`).join("")
    + waiting.map((m) => `<div class="m me"><div class="who">我（網頁）　傳送中</div><div class="body">${esc(m.payload.text)}</div></div>`).join("")
    + (conv.length || waiting.length ? "" : `<p class="note">還沒有內容。</p>`);
  if (atBottom || conv.length !== lastConvLen) box.scrollTop = box.scrollHeight;
  lastConvLen = conv.length;
}

async function sendMsg(text) {
  text = text.trim();
  if (!text) return;
  $("#send").disabled = true;
  try {
    await api({ action: "send", kind: "message", payload: { text } });
    pendingInbox.push({ kind: "message", payload: { text } });
    $("#msg").value = "";
    renderTalk(snapshot || {});
  } catch (e) {
    alert("送出失敗，請再試一次");
  } finally {
    $("#send").disabled = false;
  }
}

// ---- 事件 ----
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
  document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.id !== `tab-${t.dataset.tab}`; });
  if (t.dataset.tab === "talk") $("#talk").scrollTop = $("#talk").scrollHeight;
}));
$("#send").addEventListener("click", () => sendMsg($("#msg").value));
$("#msg").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMsg($("#msg").value); });
document.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => sendMsg(b.dataset.q)));
$("#logout").addEventListener("click", () => { if (window.google) google.accounts.id.disableAutoSelect(); showLogin(""); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#cover").hidden = !$("#cover").hidden; });

// ---- 啟動 ----
session = loadSession();
if (session) { showMain(); refresh(); } else { $("#login").hidden = false; }
initGoogle(40);
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
