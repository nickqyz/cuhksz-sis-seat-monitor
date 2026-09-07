import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import playwright from "playwright-core";

const { chromium } = playwright;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, ".data");
const PROFILE_DIR = path.join(DATA_DIR, "webvpn-edge-profile");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "monitor.log");
const VPN_URL = "https://vpn.cuhk.edu.cn/";
const SIS_URL = "https://sis.cuhk.edu.cn/";
const TARGETS = [
  { id: "gea-l09-t23", subject: "GEA", course: "GEA 2000", sectionTokens: ["L09", "T23"] },
  { id: "gfh-l04-t11", subject: "GFH", course: "GFH", sectionTokens: ["L04", "T11"] }
];

function cfg() {
  const defaultBrowser = process.platform === "win32"
    ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    : "/usr/bin/google-chrome";
  return {
    username: process.env.SIS_USERNAME || "",
    password: process.env.SIS_PASSWORD || "",
    wxpusherSpt: process.env.WXPUSHER_SPT || "",
    pushplusToken: process.env.PUSHPLUS_TOKEN || "",
    serverchanKey: process.env.SERVERCHAN_SENDKEY || "",
    intervalMs: Math.max(60, Number(process.env.CHECK_INTERVAL_SECONDS || 120)) * 1000,
    browserPath: process.env.BROWSER_PATH || process.env.EDGE_PATH || defaultBrowser,
    headless: !/^(0|false|no)$/i.test(process.env.HEADLESS || "true"),
    dryRun: /^(1|true|yes)$/i.test(process.env.DRY_RUN || "false"),
    directSis: /^(1|true|yes)$/i.test(process.env.USE_DIRECT_SIS || "false")
  };
}

function timestamp() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function log(message) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = `[${timestamp()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function writeState(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(value, null, 2), { mode: 0o600 });
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`通知 HTTP ${response.status}: ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function notify(config, title, content) {
  if (config.wxpusherSpt) {
    // The SPT endpoint is path-based; Tomcat rejects encoded CR/LF in the URL.
    const message = `${title} — ${content}`
      .replace(/\s+/g, " ")
      .replace(/[\\/?#%]/g, "-")
      .trim();
    const response = await fetch(
      `https://wxpusher.zjiecode.com/api/send/message/${encodeURIComponent(config.wxpusherSpt)}/${encodeURIComponent(message)}`,
      { signal: AbortSignal.timeout(20000) }
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`WxPusher HTTP ${response.status}: ${text.slice(0, 160)}`);
    try {
      const data = JSON.parse(text);
      if (data.code != null && Number(data.code) !== 1000) throw new Error(`WxPusher：${data.msg || data.code}`);
    } catch (error) {
      if (error.message?.startsWith("WxPusher：")) throw error;
    }
    return "WxPusher";
  }
  if (config.pushplusToken) {
    const data = await postJson("https://www.pushplus.plus/send", {
      token: config.pushplusToken,
      title,
      content,
      template: "markdown",
      channel: "wechat"
    });
    if (data.code != null && Number(data.code) !== 200) throw new Error(`PushPlus：${data.msg || data.code}`);
    return "PushPlus";
  }
  if (config.serverchanKey) {
    const response = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(config.serverchanKey)}.send`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, desp: content }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`Server酱 HTTP ${response.status}`);
    return "Server酱";
  }
  throw new Error("尚未配置 WxPusher SPT、PushPlus token 或 Server酱 SendKey");
}

async function visible(locator, timeout = 800) {
  return locator.isVisible({ timeout }).catch(() => false);
}

async function firstVisible(locator) {
  for (let i = 0; i < await locator.count(); i += 1) {
    if (await visible(locator.nth(i))) return locator.nth(i);
  }
  return null;
}

async function firstVisibleAcrossFrames(page, selector) {
  for (const frame of page.frames()) {
    const match = await firstVisible(frame.locator(selector));
    if (match) return match;
  }
  return null;
}

async function waitForVisibleAcrossFrames(page, selector, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const match = await firstVisibleAcrossFrames(page, selector);
    if (match) return match;
    await delay(300);
  }
  return null;
}

async function findFrame(page, selector) {
  for (const frame of page.frames()) {
    if (await frame.locator(selector).count().catch(() => 0)) return frame;
  }
  return null;
}

async function waitForFrame(page, selector, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const frame = await findFrame(page, selector);
    if (frame) return frame;
    await delay(500);
  }
  throw new Error(`等待 SIS 控件超时：${selector}`);
}

async function waitForPeopleSoftIdle(page, timeout = 60000) {
  await delay(700);
  const started = Date.now();
  let quietPasses = 0;
  while (Date.now() - started < timeout) {
    let busy = false;
    for (const frame of page.frames()) {
      const indicators = frame.locator("[id^='WAIT_'], [class*='PROCESSING'], [class*='processing']");
      for (let i = 0; i < await indicators.count().catch(() => 0); i += 1) {
        if (await visible(indicators.nth(i), 200)) { busy = true; break; }
      }
      if (busy) break;
    }
    quietPasses = busy ? 0 : quietPasses + 1;
    if (quietPasses >= 3) return;
    await delay(500);
  }
  throw new Error("PeopleSoft 页面处理超时");
}

async function clickSearchReset(page) {
  for (const frame of page.frames()) {
    const controls = frame.locator("input, button, a");
    for (let index = 0; index < await controls.count(); index += 1) {
      const control = controls.nth(index);
      const label = [
        await control.getAttribute("value").catch(() => ""),
        await control.getAttribute("aria-label").catch(() => ""),
        await control.getAttribute("title").catch(() => ""),
        await control.innerText().catch(() => ""),
        await control.getAttribute("id").catch(() => "")
      ].filter(Boolean).join(" ");
      if (!/(modify|return|new).*search|search.*(modify|return|new)/i.test(label)) continue;
      if (await visible(control)) {
        await control.click();
        return true;
      }
    }
  }
  return false;
}

async function portalLogin(page, config) {
  await page.goto(VPN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await delay(1000);
  if (await visible(page.locator("select[name='group_list']"))) {
    await page.locator("select[name='group_list']").selectOption("CUHKSZ");
    await page.locator("#username").fill(config.username);
    await page.locator("#password_input").fill(config.password);
    await page.locator("input[value='Login'], input[type='submit']").first().click();
  }
  await page.locator("#unicorn_form_url").waitFor({ state: "visible", timeout: 30000 });
}

async function openSis(page, config) {
  if (config.directSis) {
    await page.goto(SIS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  } else {
    await page.locator("#unicorn_form_url").fill(SIS_URL);
    await page.locator("#unicorn_form_url").press("Enter");
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
  await delay(2500);

  const english = page.getByRole("link", { name: "English", exact: true });
  if (await visible(english)) {
    await english.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
    await delay(1500);
  }

  const usernameSelector = "#userNameInput, input[name*='user' i], input[type='email'], input[type='text']";
  let username = await firstVisibleAcrossFrames(page, usernameSelector);
  const loadingAuth = /adfs|oauth2|loading/i.test(`${page.url()} ${await page.title().catch(() => "")}`);
  if (!username && loadingAuth) username = await waitForVisibleAcrossFrames(page, usernameSelector, 30000);
  const adfsLogin = Boolean(username) || /\/adfs\//i.test(page.url()) || /登录|sign[ -]?in/i.test(await page.title().catch(() => ""));
  if (adfsLogin) {
    username ||= await waitForVisibleAcrossFrames(page, usernameSelector);
    if (!username) throw new Error("ADFS 登录页未找到账号输入框");
    await username.fill(config.username);

    let password = await firstVisibleAcrossFrames(page, "#passwordInput, input[name*='pass' i], input[type='password']");
    if (!password) {
      const next = await waitForVisibleAcrossFrames(page, "#nextButton, button[type='submit'], input[type='submit']", 10000);
      if (!next) throw new Error("ADFS 登录页未找到下一步按钮");
      await next.click();
      const started = Date.now();
      while (!password && Date.now() - started < 10000) {
        await delay(300);
        password = await firstVisibleAcrossFrames(page, "#passwordInput, input[name*='pass' i], input[type='password']");
      }
    }
    if (!password) throw new Error("ADFS 登录页未找到密码输入框");
    await password.fill(config.password);
    const submit = await firstVisibleAcrossFrames(page, "#submitButton, button[type='submit'], input[type='submit']");
    if (!submit) throw new Error("ADFS 登录页未找到登录按钮");
    await submit.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
    await delay(4000);
  }

  if (/errorCode=105/i.test(page.url())) throw new Error("SIS SSO 会话冲突（errorCode=105），稍后自动重试");
  if (await visible(english)) throw new Error("SIS 登录未完成");
}

async function enterClassSearch(page) {
  if (await findFrame(page, "[id='SSR_CLSRCH_WRK_SUBJECT$0']")) return;
  const link = page.locator("a").filter({ hasText: /^Class Search$/ }).last();
  await link.waitFor({ state: "visible", timeout: 30000 });
  await link.click();
  await waitForFrame(page, "[id='SSR_CLSRCH_WRK_SUBJECT$0']", 45000);
}

async function prepareSearch(page, subject) {
  let frame = await findFrame(page, "[id='SSR_CLSRCH_WRK_SUBJECT$0']");
  if (!frame) {
    if (!await clickSearchReset(page)) throw new Error("结果页未找到返回搜索按钮");
    frame = await waitForFrame(page, "[id='SSR_CLSRCH_WRK_SUBJECT$0']", 30000);
  }

  const term = frame.locator("[id='CLASS_SRCH_WRK2_STRM$35$']");
  if (await term.inputValue().catch(() => "") !== "2610") {
    await term.selectOption("2610");
    await waitForPeopleSoftIdle(page);
    frame = await waitForFrame(page, "[id='SSR_CLSRCH_WRK_SUBJECT$0']");
  }

  await frame.locator("[id='SSR_CLSRCH_WRK_SUBJECT$0']").selectOption(subject);
  await waitForPeopleSoftIdle(page);
  frame = await waitForFrame(page, "[id='SSR_CLSRCH_WRK_ACAD_CAREER$2']");
  await frame.locator("[id='SSR_CLSRCH_WRK_ACAD_CAREER$2']").selectOption("UG");
  await waitForPeopleSoftIdle(page);
  frame = await waitForFrame(page, "[id='SSR_CLSRCH_WRK_ACAD_CAREER$2']");
  const openOnly = frame.locator("[id='SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3']");
  if (await openOnly.isChecked()) await openOnly.uncheck();
  log(`查询条件已确认：term=${await frame.locator("[id='CLASS_SRCH_WRK2_STRM$35$']").inputValue()} subject=${await frame.locator("[id='SSR_CLSRCH_WRK_SUBJECT$0']").inputValue()} career=${await frame.locator("[id='SSR_CLSRCH_WRK_ACAD_CAREER$2']").inputValue()} openOnly=${await openOnly.isChecked()}`);
  await frame.locator("[id='CLASS_SRCH_WRK2_SSR_PB_CLASS_SRCH']").click();
  await waitForPeopleSoftIdle(page, 90000);

  frame = await waitForFrame(page, "[id^='DERIVED_CLSRCH_SSR_CLASSNAME_LONG$']", 90000);
  const viewAll = frame.locator("[id='$ICField106$hviewall$0']");
  if (await visible(viewAll)) {
    await viewAll.click();
    await delay(1500);
    frame = await waitForFrame(page, "[id^='DERIVED_CLSRCH_SSR_CLASSNAME_LONG$']");
  }
  return frame;
}

async function readSection(frame, token) {
  const links = frame.locator("[id^='DERIVED_CLSRCH_SSR_CLASSNAME_LONG$']");
  for (let i = 0; i < await links.count(); i += 1) {
    const link = links.nth(i);
    const name = (await link.innerText()).trim();
    if (!name.toUpperCase().startsWith(`${token.toUpperCase()}-`)) continue;
    const id = await link.getAttribute("id");
    const row = id?.match(/\$(\d+)$/)?.[1];
    if (row == null) continue;
    const status = await frame.locator(`[id='win0divDERIVED_CLSRCH_SSR_STATUS_LONG$${row}'] img`).getAttribute("alt").catch(() => "Unknown");
    const totalText = await frame.locator(`[id='SSR_CLS_DTL_WRK_ENRL_TOT$${row}']`).innerText().catch(() => "");
    const capacityText = await frame.locator(`[id='SSR_CLS_DTL_WRK_ENRL_CAP$${row}']`).innerText().catch(() => "");
    const note = await frame.locator(`[id='CUSZ_OT017_WRK_LINK1_PB$${row}']`).innerText().catch(() => "");
    const total = Number.parseInt(totalText, 10);
    const capacity = Number.parseInt(capacityText, 10);
    const open = /^open$/i.test(status || "") && Number.isFinite(total) && Number.isFinite(capacity) && total < capacity;
    return { token, name, status: status || "Unknown", total, capacity, seats: Math.max(0, capacity - total), note, open };
  }
  return { token, name: "", status: "Not found", total: null, capacity: null, seats: null, note: "", open: false };
}

async function checkTarget(page, target) {
  const frame = await prepareSearch(page, target.subject);
  const sections = [];
  for (const token of target.sectionTokens) sections.push(await readSection(frame, token));
  return { id: target.id, checkedAt: new Date().toISOString(), term: "2026-27 Term 1", course: target.course, sections, allOpen: sections.every(item => item.open) };
}

function describe(result) {
  return result.sections.map(item => `${item.name || item.token}: ${item.status}, ${item.total ?? "?"}/${item.capacity ?? "?"}, 剩余 ${item.seats ?? "?"}${item.note ? `（${item.note}）` : ""}`).join("；");
}

function previousOpen(state, target, index) {
  const current = state.targets?.[target.id]?.allOpen;
  if (typeof current === "boolean") return current;
  if (index === 0 && typeof state.lastAllOpen === "boolean") return state.lastAllOpen;
  return false;
}

async function processResults(config, state, results) {
  let stateChanged = false;
  for (let index = 0; index < results.length; index += 1) {
    const target = TARGETS[index];
    const result = results[index];
    const wasOpen = previousOpen(state, target, index);
    if (wasOpen !== result.allOpen) stateChanged = true;
    log(`${target.course} ${result.allOpen ? "OPEN" : "CLOSED"} — ${describe(result)}`);
    if (result.allOpen && !wasOpen && !config.dryRun) {
      const content = `检测时间：${timestamp()}\n\n${describe(result)}\n\n请尽快自行登录 SIS 选课。本工具不会自动提交选课。`;
      const provider = await notify(config, `SIS 有名额：${target.course} ${target.sectionTokens.join(" + ")}`, content);
      log(`已通过 ${provider} 发送微信通知。`);
    }
  }
  const targets = Object.fromEntries(results.map(result => [result.id, result]));
  writeState({ ...state, lastAllOpen: results[0].allOpen, lastCheckAt: results.at(-1).checkedAt, lastResult: results[0], targets });
  return stateChanged;
}

async function checkAll(page) {
  const results = [];
  const classSearchUrl = page.url();
  for (let index = 0; index < TARGETS.length; index += 1) {
    if (index > 0) {
      await page.goto(classSearchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await waitForFrame(page, "[id='SSR_CLSRCH_WRK_SUBJECT$0']", 45000);
    }
    results.push(await checkTarget(page, TARGETS[index]));
  }
  return results;
}

async function saveDebug(page, result) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "last-result.json"), JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(DATA_DIR, "last-page.png"), fullPage: true }).catch(() => {});
}

async function runMonitor(config) {
  if (!config.username || !config.password) throw new Error("缺少 SIS/VPN 账号密码");
  if (!config.dryRun && !config.wxpusherSpt && !config.pushplusToken && !config.serverchanKey) throw new Error("缺少微信推送 token");
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });

  while (!stopping) {
    let context;
    try {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: config.browserPath,
        headless: config.headless,
        locale: "zh-CN",
        viewport: { width: 1440, height: 1000 },
        args: ["--disable-background-timer-throttling"]
      });
      const page = context.pages()[0] || await context.newPage();
      await portalLogin(page, config);
      await openSis(page, config);
      await enterClassSearch(page);
      log("Web VPN 与 SIS 登录成功，开始监控 GEA 2000 L09 + T23、GFH L04 + T11。");

      while (!stopping) {
        const results = await checkAll(page);
        await saveDebug(page, results);
        const state = readState();
        await processResults(config, state, results);
        await delay(config.intervalMs);
      }
    } catch (error) {
      log(`本轮失败：${error.message}；60 秒后自动重新登录。`);
    } finally {
      await context?.close().catch(() => {});
    }
    if (!stopping) await delay(60000);
  }
}

function setActionOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function runOnce(config) {
  if (!config.username || !config.password) throw new Error("缺少 SIS/VPN 账号密码");
  if (!config.dryRun && !config.wxpusherSpt && !config.pushplusToken && !config.serverchanKey) throw new Error("缺少微信推送 token");
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: config.browserPath,
    headless: true,
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 }
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    if (!config.directSis) {
      await portalLogin(page, config);
      log(`云端阶段：Web VPN 已登录（${await page.title().catch(() => "未知标题")}）`);
    } else {
      log("云端阶段：已使用系统级校园 VPN");
    }
    await openSis(page, config);
    log(`云端阶段：SIS SSO 已处理（${await page.title().catch(() => "未知标题")}）`);
    await enterClassSearch(page);
    log("云端阶段：已进入 Class Search");
    const results = await checkAll(page);
    await saveDebug(page, results);
    const state = readState();
    const stateChanged = await processResults(config, state, results);
    setActionOutput("state_changed", stateChanged ? "true" : "false");
  } catch (error) {
    const page = context.pages()[0];
    const title = await page?.title().catch(() => "未知标题");
    const url = page?.url()?.replace(/[?#].*$/, "") || "未知地址";
    log(`云端诊断：页面标题=${title}，地址=${url}`);
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const config = cfg();
  const mode = process.argv[2] || "monitor";
  if (mode === "test-notify") {
    const provider = await notify(config, "SIS 名额监控测试", `测试时间：${timestamp()}\n\n微信通知配置成功。`);
    console.log(`测试消息已提交给 ${provider}。`);
    return;
  }
  if (mode === "once") {
    await runOnce(config);
    return;
  }
  await runMonitor(config);
}

main().catch(error => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
