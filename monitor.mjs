import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const DATA_DIR = path.join(ROOT, ".data");
const PROFILE_DIR = path.join(DATA_DIR, "edge-profile");
const STATE_FILE = path.join(DATA_DIR, "state.json");

function loadDotEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function config() {
  const interval = Math.max(30, Number(process.env.CHECK_INTERVAL_SECONDS || 60));
  return {
    sisUrl: process.env.SIS_URL || "https://sis.cuhk.edu.cn/",
    username: process.env.SIS_USERNAME || "",
    password: process.env.SIS_PASSWORD || "",
    courseQuery: (process.env.COURSE_QUERY || "GEA").trim(),
    sectionTokens: (process.env.SECTION_TOKENS || "L09,T23").split(",").map(x => x.trim()).filter(Boolean),
    matchMode: (process.env.MATCH_MODE || "all").toLowerCase() === "any" ? "any" : "all",
    intervalSeconds: interval,
    pushplusToken: process.env.PUSHPLUS_TOKEN || "",
    serverchanKey: process.env.SERVERCHAN_SENDKEY || "",
    headless: boolEnv("HEADLESS"),
    stopAfterNotify: boolEnv("STOP_AFTER_NOTIFY"),
    edgePath: process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function writeState(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STATE_FILE);
}

function now() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function log(message) {
  console.log(`[${now()}] ${message}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasToken(text, token) {
  return new RegExp(`(^|[^A-Z0-9])${escapeRegex(token.toUpperCase())}([^A-Z0-9]|$)`, "i").test(text.toUpperCase());
}

export function detectStatus(text, signals = "") {
  const joined = `${text} ${signals}`.replace(/\s+/g, " ").trim();
  const seatPatterns = [
    /(?:available\s*seats?|open\s*seats?|seats?\s*available|剩余(?:名额|座位)|可用(?:名额|座位))\s*[:：]?\s*(\d+)/i,
    /(?:available|open)\s*[:：]?\s*(\d+)\s*(?:seats?)?/i
  ];
  for (const pattern of seatPatterns) {
    const match = joined.match(pattern);
    if (match) return { status: Number(match[1]) > 0 ? "open" : "closed", seats: Number(match[1]), reason: match[0] };
  }

  const capacity = joined.match(/(?:enrollment\s*capacity|容量上限|班级容量)\s*[:：]?\s*(\d+)/i);
  const total = joined.match(/(?:enrollment\s*total|已选人数|注册人数)\s*[:：]?\s*(\d+)/i);
  if (capacity && total) {
    const seats = Number(capacity[1]) - Number(total[1]);
    return { status: seats > 0 ? "open" : "closed", seats: Math.max(0, seats), reason: `${total[0]} / ${capacity[0]}` };
  }

  if (/(PS_CS_STATUS_CLOSED|\bclosed\b|\bfull\b|已满|关闭|无名额)/i.test(joined)) {
    return { status: "closed", seats: 0, reason: "页面标记为 Closed/Full" };
  }
  if (/(PS_CS_STATUS_OPEN|\bstatus\s*[:：]?\s*open\b|\bopen\s*(?:class|section)?\b|有名额|开放)/i.test(joined)) {
    return { status: "open", seats: null, reason: "页面标记为 Open" };
  }
  return { status: "unknown", seats: null, reason: "未找到可靠的名额字段或状态图标" };
}

export function analyseRows(rows, courseQuery, sectionTokens, matchMode = "all", pageText = "") {
  if (courseQuery && !pageText.toUpperCase().includes(courseQuery.toUpperCase())) {
    return { status: "unknown", reason: `当前页面没有找到课程关键词 ${courseQuery}`, sections: [] };
  }

  const sections = sectionTokens.map(token => {
    const candidates = rows
      .filter(row => hasToken(`${row.text} ${row.signals}`, token))
      .map(row => ({ ...row, result: detectStatus(row.text, row.signals) }));
    if (!candidates.length) return { token, status: "unknown", seats: null, reason: "没有找到对应班级" };

    const ranked = candidates.sort((a, b) => {
      const knownA = a.result.status === "unknown" ? 0 : 1;
      const knownB = b.result.status === "unknown" ? 0 : 1;
      return knownB - knownA || a.text.length - b.text.length;
    });
    const best = ranked[0];
    return { token, ...best.result, excerpt: best.text.slice(0, 240) };
  });

  const known = sections.filter(x => x.status !== "unknown");
  let status = "unknown";
  if (matchMode === "all") {
    if (sections.some(x => x.status === "closed")) status = "closed";
    else if (sections.length && sections.every(x => x.status === "open")) status = "open";
  } else {
    if (sections.some(x => x.status === "open")) status = "open";
    else if (known.length === sections.length && sections.length) status = "closed";
  }
  return { status, reason: `${matchMode === "all" ? "全部" : "任一"}目标班级判定结果`, sections };
}

async function importPlaywright() {
  try { return await import("playwright-core"); }
  catch {
    throw new Error("缺少依赖。请先在本目录运行 npm install，或双击 setup.cmd。", { cause: undefined });
  }
}

async function launchBrowser(cfg, forceVisible = false) {
  const { chromium } = await importPlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: cfg.edgePath,
    headless: forceVisible ? false : cfg.headless,
    viewport: { width: 1440, height: 980 },
    locale: "zh-CN",
    args: ["--disable-background-timer-throttling"]
  });
}

async function visibleFirst(frame, selectors) {
  for (const selector of selectors) {
    const locator = frame.locator(selector).first();
    try { if (await locator.isVisible({ timeout: 250 })) return locator; } catch {}
  }
  return null;
}

async function loginForm(page) {
  for (const frame of page.frames()) {
    const user = await visibleFirst(frame, ["#userid", "input[name='userid']", "input[name='USERID']", "input[autocomplete='username']"]);
    const password = await visibleFirst(frame, ["#pwd", "input[name='pwd']", "input[name='PASSWORD']", "input[type='password']"]);
    if (user && password) return { frame, user, password };
  }
  return null;
}

async function promptEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { await rl.question(`${message}\n完成后按回车继续…… `); }
  finally { rl.close(); }
}

async function ensureLogin(page, cfg, manualAllowed) {
  let form = await loginForm(page);
  if (!form) return;

  if (cfg.username && cfg.password) {
    log("检测到登录页，正在使用本机 .env 中的凭据登录（不会输出凭据）。");
    await form.user.fill(cfg.username);
    await form.password.fill(cfg.password);
    const submit = await visibleFirst(form.frame, ["input[name='Submit']", "#login", "button[type='submit']", "input[type='submit']"]);
    if (!submit) throw new Error("找到了账号密码框，但没有找到登录按钮。");
    await submit.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    form = await loginForm(page);
  }

  if (form) {
    if (!manualAllowed || cfg.headless) {
      throw new Error("仍停留在登录页，可能存在验证码、动态验证、密码错误或 VPN 未连接。请运行 npm run setup 手动完成一次登录。");
    }
    await promptEnter("请在打开的 Edge 中完成验证码/动态验证或手动登录。脚本不会代做验证码。 ");
    if (await loginForm(page)) throw new Error("仍停留在登录页，登录尚未完成。");
  }
}

async function collectPage(page) {
  const rows = [];
  const pageTexts = [];
  for (const frame of page.frames()) {
    try {
      const body = await frame.locator("body").innerText({ timeout: 3000 });
      pageTexts.push(body);
      const frameRows = await frame.locator("tr, [role='row']").evaluateAll(nodes => nodes.slice(0, 2500).map(node => {
        const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        const signalNodes = [node, ...node.querySelectorAll("img, [title], [aria-label], [data-status]")];
        const signals = signalNodes.map(el => [
          el.getAttribute?.("alt"), el.getAttribute?.("title"), el.getAttribute?.("aria-label"),
          el.getAttribute?.("src"), el.getAttribute?.("class"), el.getAttribute?.("data-status")
        ].filter(Boolean).join(" ")).filter(Boolean).join(" ");
        return { text, signals };
      }).filter(row => row.text || row.signals));
      rows.push(...frameRows);
    } catch {}
  }
  return { rows, pageText: pageTexts.join("\n") };
}

async function inspect(page, cfg) {
  const captured = await collectPage(page);
  return { ...analyseRows(captured.rows, cfg.courseQuery, cfg.sectionTokens, cfg.matchMode, captured.pageText), url: page.url() };
}

async function saveDebug(page, result) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "last-result.json"), JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(DATA_DIR, "last-page.png"), fullPage: true }).catch(() => {});
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return data;
}

export async function notify(cfg, title, content) {
  if (cfg.pushplusToken) {
    const data = await postJson("https://www.pushplus.plus/send", {
      token: cfg.pushplusToken, title, content, template: "markdown", channel: "wechat"
    });
    if (data.code != null && Number(data.code) !== 200) throw new Error(`PushPlus 推送失败：${data.msg || data.code}`);
    return "PushPlus";
  }
  if (cfg.serverchanKey) {
    const body = new URLSearchParams({ title, desp: content });
    const response = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(cfg.serverchanKey)}.send`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`Server酱推送失败：HTTP ${response.status}`);
    return "Server酱";
  }
  throw new Error("未配置微信通知：请在 .env 填 PUSHPLUS_TOKEN 或 SERVERCHAN_SENDKEY。");
}

function describeResult(result) {
  return result.sections.map(s => `${s.token}=${s.status}${s.seats == null ? "" : `(${s.seats}个名额)`}`).join("；");
}

async function setupMode(cfg) {
  const context = await launchBrowser(cfg, true);
  try {
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    await page.goto(cfg.sisUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await ensureLogin(page, cfg, true);
    console.log("\n请在 Edge 中进入：自助服务 → 课程搜索/浏览目录 → 课程搜索。\n选择正确学期，打开能同时看到目标课程和班级状态的结果页。\n本脚本只读取页面，不会替你提交选课。\n");
    await promptEnter(`确认页面上能看到 ${cfg.courseQuery}、${cfg.sectionTokens.join("、")} 及 Open/Closed 或剩余名额`);
    const result = await inspect(page, cfg);
    await saveDebug(page, result);
    if (result.status === "unknown" && result.sections.every(s => s.reason === "没有找到对应班级")) {
      throw new Error(`当前页面没有识别到 ${cfg.sectionTokens.join("、")}。请保持目标结果可见后重新运行 setup。`);
    }
    writeState({ ...readState(), monitorUrl: page.url(), lastStatus: "unknown", setupAt: new Date().toISOString() });
    console.log(`\n设置完成：${describeResult(result) || result.reason}`);
    console.log("现在可关闭浏览器，然后双击 start-monitor.cmd。\n");
  } finally {
    await context.close();
  }
}

async function monitorMode(cfg) {
  if (!cfg.sectionTokens.length) throw new Error("SECTION_TOKENS 不能为空。");
  if (!cfg.pushplusToken && !cfg.serverchanKey) throw new Error("请先配置微信推送 token，并运行 npm run test-notify。");
  const state = readState();
  if (!state.monitorUrl) throw new Error("尚未保存监控页面。请先运行 npm run setup。");

  const context = await launchBrowser(cfg);
  const page = context.pages()[0] || await context.newPage();
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; log("收到停止信号，将在本轮结束后退出。"); });
  try {
    await page.goto(state.monitorUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    while (!stopping) {
      await ensureLogin(page, cfg, !cfg.headless);
      if (page.url() !== state.monitorUrl && !page.url().includes("CLASS_SEARCH")) {
        await page.goto(state.monitorUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      const result = await inspect(page, cfg);
      await saveDebug(page, result);
      log(`${result.status.toUpperCase()} — ${describeResult(result) || result.reason}`);

      const current = readState();
      if (result.status === "open" && current.lastStatus !== "open") {
        const title = `SIS 有名额：${cfg.courseQuery} ${cfg.sectionTokens.join("+")}`;
        const content = `检测时间：${now()}\n\n${describeResult(result)}\n\n请尽快自行登录 SIS 选课。脚本没有自动提交选课。`;
        const provider = await notify(cfg, title, content);
        log(`已通过 ${provider} 发送微信通知。`);
      }
      writeState({ ...current, monitorUrl: state.monitorUrl, lastStatus: result.status, lastCheckAt: new Date().toISOString(), lastResult: result });
      if (result.status === "open" && cfg.stopAfterNotify) break;

      await new Promise(resolve => setTimeout(resolve, cfg.intervalSeconds * 1000));
      if (!stopping) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(error => log(`刷新失败，将重试：${error.message}`));
      }
    }
  } finally {
    await context.close();
  }
}

async function testNotifyMode(cfg) {
  const provider = await notify(cfg, "SIS 名额监控测试", `测试时间：${now()}\n\n如果你在微信中看到这条消息，通知配置成功。`);
  console.log(`测试消息已提交给 ${provider}。`);
}

async function main() {
  loadDotEnv();
  const cfg = config();
  const mode = process.argv[2] || "monitor";
  if (mode === "setup") return setupMode(cfg);
  if (mode === "monitor") return monitorMode(cfg);
  if (mode === "test-notify") return testNotifyMode(cfg);
  throw new Error("用法：node monitor.mjs setup|monitor|test-notify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`\n错误：${error.message}`);
    process.exitCode = 1;
  });
}
