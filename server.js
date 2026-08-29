#!/usr/bin/env node
// phone-remote —— 把手机当 Mac(mini) 的无线键盘 + 快捷键遥控面板 + CLI 启动器
//
// 原理：手机浏览器打开本服务的网页，文本框用手机输入法(含语音)输入，
// 快捷键做成按钮。指令发到本服务后，在 *本机* 用 osascript 合成键盘事件，
// 打进当前最前的窗口。因为是本机注入、不是远程软件跨机转发，
// 中文和组合键都不受 UU 远程那类工具的 IME 转发限制。
//
// 安全：
//  - 仅 Tailscale/局域网可达 + token 校验（无 token 的请求一律 401）。
//  - 文本经临时文件中转、osascript 读文件写剪贴板再 Cmd+V；快捷键走白名单映射。
//    用户输入绝不拼进 osascript 脚本，杜绝命令注入。

const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "0.0.0.0";
const DIR = __dirname;
const CLIP_TMP = path.join(DIR, ".clip.tmp"); // 文本中转文件（覆盖写，已 gitignore）
const LAUNCH_TMP = path.join(DIR, ".launch.command"); // 一键打开的启动脚本（覆盖写，已 gitignore）

// ── 持久 token（首次生成写入 .token，重启后 URL 不变）──
const tokenFile = path.join(DIR, ".token");
let TOKEN;
try {
  TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
} catch {
  TOKEN = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
}

const INDEX = fs.readFileSync(path.join(DIR, "index.html"));

// ── 快捷键白名单：前端传 action 名，后端查表，查不到即拒绝 ──
// 每项：{ code:<AppleScript key code> } 或 { char:"<单字符>" }，可选 mods:[修饰键]
const MODS = { cmd: "command down", ctrl: "control down", opt: "option down", shift: "shift down" };
const KEYS = {
  // 导航
  up: { code: 126 }, down: { code: 125 }, left: { code: 123 }, right: { code: 124 },
  home: { code: 115 }, end: { code: 119 }, pageup: { code: 116 }, pagedown: { code: 121 },
  // 编辑
  tab: { code: 48 }, enter: { code: 36 }, esc: { code: 53 },
  backspace: { code: 51 }, fdelete: { code: 117 }, space: { code: 49 },
  // 终端常用（Ctrl 组合）
  "ctrl-c": { char: "c", mods: ["ctrl"] }, "ctrl-d": { char: "d", mods: ["ctrl"] },
  "ctrl-r": { char: "r", mods: ["ctrl"] }, "ctrl-l": { char: "l", mods: ["ctrl"] },
  "ctrl-u": { char: "u", mods: ["ctrl"] }, "ctrl-a": { char: "a", mods: ["ctrl"] },
  "ctrl-e": { char: "e", mods: ["ctrl"] }, "ctrl-k": { char: "k", mods: ["ctrl"] },
  "ctrl-w": { char: "w", mods: ["ctrl"] }, "ctrl-z": { char: "z", mods: ["ctrl"] },
  // 系统 Cmd 组合
  "cmd-c": { char: "c", mods: ["cmd"] }, "cmd-v": { char: "v", mods: ["cmd"] },
  "cmd-x": { char: "x", mods: ["cmd"] }, "cmd-z": { char: "z", mods: ["cmd"] },
  "cmd-shift-z": { char: "z", mods: ["cmd", "shift"] }, "cmd-a": { char: "a", mods: ["cmd"] },
  "cmd-s": { char: "s", mods: ["cmd"] }, "cmd-f": { char: "f", mods: ["cmd"] },
  "cmd-w": { char: "w", mods: ["cmd"] }, "cmd-t": { char: "t", mods: ["cmd"] },
  "cmd-tab": { code: 48, mods: ["cmd"] }, "cmd-left": { code: 123, mods: ["cmd"] },
  "cmd-right": { code: 124, mods: ["cmd"] }, "opt-left": { code: 123, mods: ["opt"] },
  "opt-right": { code: 124, mods: ["opt"] },
};

// ── 应用白名单：一键在新终端窗口里启动某个 CLI ──
// 同 KEYS 的思路：前端只传 key 名，命令字符串写死在这里，用户输入永远进不来。
// 想加工具就在这里补一行，再去 index.html 的「一键打开」区加个按钮。
const APPS = {
  cc: { label: "Claude Code", cmd: "claude" },
  codex: { label: "Codex", cmd: "codex" },
  kimi: { label: "Kimi", cmd: "$HOME/.kimi-code/bin/kimi" }, // 不在 PATH，得写全路径
};
// 新终端的工作目录。默认 home；想固定到某个项目就给服务设环境变量 LAUNCH_CWD。
const LAUNCH_CWD = process.env.LAUNCH_CWD || os.homedir();

function buildKeyScript(k) {
  const target = k.char !== undefined ? `keystroke "${k.char}"` : `key code ${k.code}`;
  const using = k.mods && k.mods.length
    ? ` using {${k.mods.map((m) => MODS[m]).join(", ")}}`
    : "";
  return `tell application "System Events" to ${target}${using}`;
}

// 执行 osascript。scriptLines: 字符串或数组（每项一个 -e）。
function osa(scriptLines) {
  const lines = Array.isArray(scriptLines) ? scriptLines : [scriptLines];
  const args = [];
  for (const l of lines) args.push("-e", l);
  return new Promise((resolve, reject) => {
    execFile("osascript", args, { timeout: 5000 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve();
    });
  });
}

// 文本注入：写临时文件 → osascript 读文件写剪贴板(AppKit) → Cmd+V。
// 为什么不用 pbcopy：后台/非 Aqua 会话里 pbcopy 命令常连不到 GUI pasteboard
//   （写入后 pbpaste 读回空，已实测），而 osascript 的 `the clipboard` 走 AppKit 正常。
// 为什么走文件而非 system attribute 传参：后者对中文报 -1700。
// 文本走文件、路径为固定常量，绝不拼进脚本，杜绝注入；read as «class utf8» 保证中文正确。
// simplified: 覆盖 mini 当前剪贴板；.clip.tmp 覆盖写不删（已 gitignore）。
function typeText(text) {
  fs.writeFileSync(CLIP_TMP, text, "utf8");
  return osa([
    `set the clipboard to (read POSIX file "${CLIP_TMP}" as «class utf8»)`,
    'tell application "System Events" to keystroke "v" using command down',
  ]);
}

// shell 单引号转义：把值裹进单引号，内部的单引号按 '"'"' 的老办法拆开。
const shq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";

// 一键启动：写一个 .command 脚本，交给 open 让 Terminal 跑起来。
// 为什么不用 `tell application "Terminal" to do script`：那条路走 Apple Events，
//   需要单独的「自动化」TCC 授权，而本服务由 launchd 后台拉起，授权弹窗未必有人看得见。
//   open 走 LaunchServices，不需要额外授权 —— 实测从非 GUI 会话也能开出窗口并执行脚本。
// 脚本内容全部来自 APPS 表和 LAUNCH_CWD 两个常量，没有一个字符来自请求体，无注入面。
// simplified: 用 exec，CLI 退出后窗口即完；要接着干就再点一次按钮。
//
// 窗口抢焦点这件事放在脚本里做，不在服务端做：本服务由 launchd 拉起、无 UI，
// 系统不让它把别的 app 提到前台（实测 open 出来的窗口停在后台）。而脚本是
// Terminal 自己的子进程，activate 由它发出就能生效，也不需要给本服务申请
// 「自动化」授权。失败就静默跳过——窗口照样开着，只是得手点一下。
function launchApp(key) {
  const app = APPS[key];
  const script = `#!/bin/zsh\ncd ${shq(LAUNCH_CWD)} || exit 1\nosascript -e 'tell application "Terminal" to activate' >/dev/null 2>&1\nexec ${app.cmd}\n`;
  fs.writeFileSync(LAUNCH_TMP, script, { mode: 0o700 });
  fs.chmodSync(LAUNCH_TMP, 0o700); // writeFileSync 的 mode 只在新建时生效，覆盖写要补一刀
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", "Terminal", LAUNCH_TMP], { timeout: 5000 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve();
    });
  });
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function send(res, code, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "content-type": typeof obj === "string" ? "text/plain; charset=utf-8" : "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 首页：返回遥控器网页（页面本身无秘密，token 由访问者从 URL 带入）
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(INDEX);
  }
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

  // 以下为注入类接口，一律校验 token
  if (req.method === "POST" && (url.pathname === "/type" || url.pathname === "/key" || url.pathname === "/launch")) {
    if (url.searchParams.get("t") !== TOKEN) return send(res, 401, { error: "bad token" });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e.message) }); }
    try {
      if (url.pathname === "/type") {
        const text = typeof body.text === "string" ? body.text : "";
        if (text) await typeText(text);
        if (body.enter) await osa(buildKeyScript(KEYS.enter));
        return send(res, 200, { ok: true });
      } else if (url.pathname === "/key") {
        const k = KEYS[body.action];
        if (!k) return send(res, 400, { error: "unknown action: " + body.action });
        await osa(buildKeyScript(k));
        return send(res, 200, { ok: true });
      } else {
        if (!APPS[body.app]) return send(res, 400, { error: "unknown app: " + body.app });
        await launchApp(body.app);
        return send(res, 200, { ok: true, launched: APPS[body.app].label });
      }
    } catch (e) {
      // 最常见：辅助功能权限未授予 → osascript 报 -1719 / -25211 / not allowed。原样回给前端。
      return send(res, 500, { error: String(e.message) });
    }
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  execFile("tailscale", ["ip", "-4"], (err, out) => {
    const ip = (!err && out.trim().split("\n")[0]) || "<本机IP>";
    console.log(`phone-remote 已启动`);
    console.log(`  手机访问: http://${ip}:${PORT}/?t=${TOKEN}`);
    console.log(`  局域网也可用 ${os.hostname()}:${PORT}`);
  });
});
