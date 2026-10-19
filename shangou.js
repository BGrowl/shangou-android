/**
 * ==================================================================================
 *  淘宝闪购 · 整点抢券  ——  单文件版（完全在手机本地运行）
 * ==================================================================================
 *  设备假设：荣耀9X（HLK-AL00）｜ 鸿蒙 HarmonyOS 3（底层 Android 10 / API 29）｜ 2340x1080
 *  运行环境：AutoX.js v7.x 或 AutoJs6（免 root，只用无障碍服务）
 *
 *  这个文件是全部。导入、点两下、剩下它自己干：
 *    STEP 1  打开「淘宝闪购 / 饿了么」App，手动进到「开学季限时抢」那一页，别动
 *    STEP 2  回到这个界面点「① 一键标定」，从列表里点选你要抢的那一场的按钮
 *    STEP 3  点「② 启动守候」，然后就可以不管了 —— 今天剩下的每个场次它自己出手
 *
 *  不需要电脑、不需要 adb、不需要改代码。配置自动生成在脚本同目录的 config.json，
 *  想改场次/通知就编辑那个文件（界面上的参数区也会显示关键值）。
 *
 *  ── 设计上从 PC 版继承的三条硬规则（都是踩过的坑，别动） ──────────────────────
 *   1. 可抢判定必须是「反转式」：负向词一票否决 → class 状态词一票否决 → 正向词命中。
 *      PC 版曾用「文本含『抢』」当正向判据，结果把 3 次点击配额全打在残留的
 *      「已抢完 / 已错过」按钮上，真到点可抢时点击器已经死了。
 *   2. 判定「抢到没有」只看页面业务提示（恭喜 / 抢到 / 已放入…），
 *      绝不看接口的 ret:["SUCCESS::调用成功"]——那个永远成功。
 *   3. 只在目标场次、目标时间与按钮校验均满足时点击；次数及窗口由配置决定。
 *
 *  ── 免责 ────────────────────────────────────────────────────────────────────
 *  自动化操作是否符合平台用户协议请自行判断，风险自担。活动规则原文写的
 *  「同手机号/同账号/同设备号，单场次仅可抢 1 次」，所以多开多端没有意义。
 * ==================================================================================
 */

"ui";

// ==================================================================================
// 0. 路径与配置
// ==================================================================================

function selfDir() {
    try {
        var s = String(engines.myEngine().source || "");
        if (s && s.length > 1 && s.charAt(0) === "/") return files.dirname(s);
    } catch (e) {}
    return "/sdcard/shangou";
}

var DIR = selfDir();
var CFG_PATH = files.join(DIR, "config.json");
var LOG_DIR = files.join(DIR, "logs");
var SHOT_DIR = files.join(DIR, "shots");
var RESULT_PATH = files.join(DIR, "result.json");
var RESULT_HISTORY_DIR = files.join(DIR, "results");
var HEART_PATH = files.join(DIR, "daemon.heartbeat");
var DAEMON_PATH = files.join(DIR, "shangou-daemon.js");
var LAST_ENTRY_FAILURE = null;
var AUTOSTART_FLAG = files.join(DIR, "autostart.flag");
// 测试标记：写这个文件 + 重启脚本，就能免点界面直接跑一次假场次演练。
// 文件内容是「提前多少秒」（留空默认 90）。跑完自动删除。
// 为什么加它：2026-10-17 两次事故都出在\"盲点 AutoX 界面按钮\"上，
// 弹窗盖住 App、点错按钮，导致整场作废。adbd 写文件比点屏幕可靠得多。
var TEST_FLAG = files.join(DIR, "test.flag");
// 锁定自测标记：存在则跑一次「人为切错场次 → 自动救回」的诊断，跑完自删。
var LOCKTEST_FLAG = files.join(DIR, "locktest.flag");

// 演练专用开关（放文件顶部，确保在任何函数被调用前就已初始化 —— 18:00 那次
// "undefined 参与比较导致 0 次点击" 就是变量位置放错造成的，不再重犯）
var FORCE_READY = false;
var FIRE_PHASE = false;
// 仅锁定自测用：绕过「目标在 15 分钟内」的时间窗口限制，好在任意时刻验证自愈路径。
var FORCE_SELECT_ANY = false;
var BUILD_ID = "codex-20261019-recovery-7.1";

var DEFAULT_CFG = {
    _说明: "淘宝闪购抢券配置。标定后本文件会被自动更新，手工改也没问题。",
    app: {
        package: "me.ele",
        launchActivity: "me.ele.Launcher",
        launchNames: ["淘宝闪购", "饿了么"],
        // 实测（2026-10-16）：活动页独有的文字是「满18可用」「开学季限时抢」「点我通知开抢」。
        // 用它们判断"确实在活动页"最准 —— 「开学季」这种词饿么么首页也有，容易误判。
        // ⚠️ 不要放「限时」这种泛词：首页 banner 出现"限时好价"就会把 inActivityPage()
        // 误判成 true，bringUpApp() 直接 return，永远不去点「学生福利」入口 → 整天空跑。
        readyKeywords: ["满18可用", "开学季限时抢", "点我通知开抢", "满18", "限时抢", "立即抢"],
        deepLink: "",
        // 从饿么么首页进活动页的入口。
        // ⚠️ 首页那排图标是图片，无障碍读不到任何文字节点（实测 dump 搜不到"学生福利"），
        //    所以只能按坐标点。按顺序试，点完验证是否进了活动页，命中即停。
        // 实测 1080x2340：「学生福利」图标中心 = (110,578)，点一下直达活动页。
        // 首页「学生福利」图标的坐标 —— **不是固定的**！
        // 2026-10-17 实测踩坑：首页顶部多了「闪购会员日」banner，把图标行整体往下推了 282px，
        //   无 banner → (110,578)      有 banner → (147,860)
        // 脚本还在用旧坐标，结果点到了「超抢手」横幅 → 跳商家页 → 08:00/10:00/11:00 三场全废。
        // 现在放多个候选，按顺序试，每个候选点之前都会先退回首页 + 拉回顶部。
        homeEntryCoords: [
            [108, 777],   // 顶部有「闪购会员日」banner 时（2026-10-17 14:45 实测，准确进活动页）
            [110, 578],   // 顶部无 banner 时（2026-10-16 18:05 实测有效）
            [147, 860],   // 12:29 那版的 banner 坐标，14:45 复测已失效，降级保留
            [130, 720],   // banner 高度介于两者之间
            [110, 900]    // banner 更高时
        ],
        // 冷启动运营弹窗的 × 位置（整层图片，读不到节点，只能盲点）
        popupCloseCoords: [
            [536, 1895]
        ]
    },
    sessions: ["08:00", "10:00", "11:00", "14:00", "17:00", "18:00", "20:00"],
    timing: {
        prestageMs: 540000,
        enterBeforeMs: 300000,
        // 出手窗口：整点后 20 秒。
        // 拉长而不是加密 —— 券可能分批放，20 秒里给服务端更多次机会。
        fireWindowMs: 10000,
        fireMode: "timerBurst",
        readyPollMs: 10,
        blindGapMs: 20,
        blindMaxClicks: 1000,
        captureFireFeedback: true,
        feedbackPollMs: 250,
        // 荣耀9X同一H5场次条实测：click 151~154ms，press(10) 12~14ms，均能切场。
        // 0 可回退 click 作对照；只用于 fire，导航与选场仍用原 click。
        pressDurationMs: 10,
        pollIntervalMs: 25,
        // 点击上限：20 秒 / 约 1 秒一轮 ≈ 20 次，留点余量
        maxClicks: 26,
        // 连点间隔（ms）。这个数是 2026-10-17 真机 benchmark 定的：
        //   click() 本身 155ms + 读按钮 345ms ≈ 500ms 一轮，
        //   所以 500ms 是「点一次、看一眼、再点下一次」的真实节奏。
        //   不要再调小：14:00 那场用 100~200ms 的序列，实际两击只隔 13ms，
        //   71 次点击按钮文案一次都没变。间隔太小会被 App 的防连击吞掉。
        clickGapMs: 500,
        // 第一次点击的提前量：链路延迟（手势~155 + App~100 + 网络~130）≈ 300~400ms，
        // 提前 150ms 起步，靠后续轮次覆盖剩余延迟。
        leadMs: 150,
        blindTapLeadMs: 20,
        reloginBeforeMs: 45000,
        // 整点后至少等这么久才允许"强制刷新场次"（刷新一次要 2.2 秒，期间不读不点）
        refreshAfterMs: 4000,
        // 出手前多久开始锁场次（把按钮切到目标场次）。必须大于 reloginBeforeMs，
        // 且这两步的执行顺序是"先锁场次、后确认页面"，顺序反了锁场次就成了死代码。
        lockBeforeMs: 180000,
        // 保留字段，不再生成密集序列（现由 clickGapMs 控制节奏）
        firePlan: null
    },
    target: {
        positiveText: ["立即抢", "马上抢", "抢券", "抢"],
        negativeText: ["未开抢", "已抢完", "已错过", "已领", "抢光", "已结束", "活动结束", "来晚", "已抢到", "恭喜", "即将开始"],
        negativeClass: ["NOT_START", "NO_INVENTORY", "HAS_END", "DISABLED", "END"],
        boundsTolerancePx: 60,
        // 只在「券按钮」所在的矩形里认可点目标。
        // 【实测原因】场次条上的「17:00 已开抢」含「抢」字、且不含任何负向词，
        // 会被 isFireable() 判成可点；而真按钮在 (899,849)，场次标签在 y 549~645。
        // 用区域隔开比往负向词里加「已开抢」可靠 —— 后者会把真正的开抢按钮一起否掉。
        zone: { enabled: true, left: 640, top: 760, right: 1060, bottom: 940 }
    },
    blindTap: {
        enabled: false,
        coord: [0, 0],
        anchorText: ""
    },
    notify: { toast: true, vibrate: true, webhook: "" },
    // 对时源按顺序尝试。2026-10-16 实测：这台手机上 api.m.taobao.com 的 DNS 解析不了
    // （ping 报 unknown host），但 acs.m.taobao.com 正常，所以换它当主源。
    timeSync: {
        enabled: true,
        urls: [
            "https://acs.m.taobao.com/gw/mtop.common.getTimestamp/",
            "http://api.m.taobao.com/rest/api3.do?api=mtop.common.getTimestamp",
            "http://quan.suning.com/getSysTime.do"
        ]
    }
};

var CFG = null;
var TIME_OFFSET = 0;
var TIME_ANCHOR = null;
var TIME_SYNC_INFO = null;
var STOP = false;
var BUSY = false;
var WORKER_DISPATCHED = false;
var HAS_UI = true;
var HEARTBEAT_ON = false;
var LOG_BUF = [];
var CLICKS = [];
var FIRE_FEEDBACK = null;
var CURRENT_SESSION = null;
var PENDING_UI = true;

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function loadCfg() {
    var raw = null;
    try { if (files.exists(CFG_PATH)) raw = files.read(CFG_PATH); } catch (e) {}
    if (raw) {
        try {
            CFG = JSON.parse(raw);
        } catch (e) {
            CFG = null;
            log("⚠️ config.json 解析失败：" + e);
        }
    }
    if (!CFG) {
        CFG = deepClone(DEFAULT_CFG);
        saveCfg();
        log("已生成默认配置：" + CFG_PATH);
    }
    var keys = Object.keys(DEFAULT_CFG);
    for (var i = 0; i < keys.length; i++) if (CFG[keys[i]] === undefined) CFG[keys[i]] = DEFAULT_CFG[keys[i]];
    var sub = ["app", "timing", "target", "blindTap", "notify", "timeSync"];
    for (var j = 0; j < sub.length; j++) {
        var k = sub[j];
        var dk = Object.keys(DEFAULT_CFG[k]);
        for (var m = 0; m < dk.length; m++) if (CFG[k][dk[m]] === undefined) CFG[k][dk[m]] = DEFAULT_CFG[k][dk[m]];
    }
}

function saveCfg() {
    try {
        files.ensureDir(DIR + "/");
        files.write(CFG_PATH, JSON.stringify(CFG, null, 2));
    } catch (e) { log("保存配置失败: " + e); }
}

// ==================================================================================
// 1. 日志
// ==================================================================================

function p2(n) { return (n < 10 ? "0" : "") + n; }

function fmtTime(ts) {
    var d = new Date(ts);
    return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + ("00" + d.getMilliseconds()).slice(-3);
}

function dayStr(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

function log(msg) {
    var line = "[" + fmtTime(now()) + "] " + msg;
    LOG_BUF.push(line);
    if (LOG_BUF.length > 500) LOG_BUF.shift();
    console.log(line);
    if (HAS_UI) {
        var tail = LOG_BUF.slice(-40).join("\n");
        try { ui.run(function () { ui.logView.setText(tail); }); } catch (e) {}
    }
    if (LOG_BUF.length % 10 === 0) flushLog();
}

function flushLog() {
    if (!CFG) return;
    try {
        files.ensureDir(LOG_DIR + "/");
        var f = files.join(LOG_DIR, dayStr(now()) + ".log");
        var old = "";
        try { if (files.exists(f)) old = files.read(f) || ""; } catch (e) {}
        files.write(f, old + LOG_BUF.join("\n") + "\n");
        LOG_BUF = [];
    } catch (e) { console.error("写日志失败: " + e); }
}

function setStatus(s) {
    if (!HAS_UI) return;
    try { ui.run(function () { ui.status.setText(s); }); } catch (e) {}
}

// ==================================================================================
// 2. 对时
// ==================================================================================

function monotonicMs() {
    try { return Number(android.os.SystemClock.elapsedRealtime()); }
    catch (e) { return Date.now(); }
}

function now() {
    if (TIME_ANCHOR) return TIME_ANCHOR.epoch + (monotonicMs() - TIME_ANCHOR.mono);
    return Date.now() + TIME_OFFSET;
}

// 从各种返回体里抠出服务器毫秒时间戳（不同时间源格式不一样）
function parseServerTime(body) {
    var s = String(body || "");
    var m = /"t"\s*:\s*"?(\d{13})"?/.exec(s);          // 淘宝 {"data":{"t":"1792154064499"}}
    if (m) return parseInt(m[1], 10);
    m = /"timestamp"\s*:\s*(\d{13})/.exec(s);           // 通用
    if (m) return parseInt(m[1], 10);
    m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);  // 苏宁 "2026-10-16 20:47:00"
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], 0).getTime();
    m = /\b(1[6-9]\d{11})\b/.exec(s);                   // 裸时间戳
    if (m) return parseInt(m[1], 10);
    return 0;
}

function syncTime() {
    if (!CFG.timeSync.enabled) { log("对时已关闭，使用本机时间"); return; }

    var urls = CFG.timeSync.urls;
    if (!urls || !urls.length) urls = (CFG.timeSync.url ? [CFG.timeSync.url] : []);
    if (!urls.length) { log("没有配置时间源，使用本机时间"); return; }

    var count = Math.max(1, Math.min(5, Number(CFG.timeSync.samples) || 3));
    var budget = Math.max(1000, Math.min(15000, Number(CFG.timeSync.budgetMs) || 5000));
    var deadline = monotonicMs() + budget;
    for (var u = 0; u < urls.length && monotonicMs() < deadline; u++) {
        var samples = [], best = null;
        for (var i = 1; i <= count && monotonicMs() < deadline; i++) {
            try {
                var remaining = Math.max(1, deadline - monotonicMs());
                var m1 = monotonicMs();
                var t1 = Date.now();
                var body = readServerTimeBody(urls[u], Math.min(2000, remaining));
                var t2 = Date.now();
                var m2 = monotonicMs(), rtt = m2 - m1;
                var st = parseServerTime(body);
                if (!st) throw new Error("解析不出时间戳");
                if (Math.abs((t2 - t1) - rtt) > 50) throw new Error("采样期间系统时间发生跳变");
                var off = st - Math.round(t1 + rtt / 2);
                // 防呆：偏超过 1 小时基本是解析错了（时区/格式），宁可不用
                if (Math.abs(off) > 3600000) throw new Error("偏差过大 " + off + "ms，疑似解析错");
                var sample = {offsetMs:off, rttMs:rtt, epoch:st+rtt/2, mono:m2};
                samples.push(sample);
                if (!best || rtt < best.rttMs) best = sample;
            } catch (e) {
                log("对时源 " + (u + 1) + " 第 " + i + " 次失败：" + e);
            }
            if (i < count && monotonicMs() + 60 < deadline) sleep(60);
        }
        if (best) {
            TIME_OFFSET = best.offsetMs;
            TIME_ANCHOR = {epoch:best.epoch, mono:best.mono};
            TIME_SYNC_INFO = {source:urls[u], samples:samples, selected:best, synchronizedAt:now(), clock:"elapsedRealtime"};
            log("对时成功：" + samples.length + " 个有效样本，选 RTT 最小的 " + best.rttMs + "ms；偏差 " + best.offsetMs + "ms，使用单调时钟维持时间（不代表业务服务器零误差）");
            return;
        }
    }
    log(TIME_ANCHOR ? "⚠️ 本次对时失败，保留上次校准及单调时钟" : "⚠️ 全部时间源都失败，暂用本机时间");
}

// 原 http.get 的 options.timeout 不会在当前 AutoX 实现里配置网络超时。
// 独立 client 的总调用超时涵盖响应体读取，不修改其他 HTTP 调用的设置。
function readServerTimeBody(url, timeoutMs) {
    if (typeof http.client === "function" && typeof http.buildRequest === "function") {
        var client = http.client().newBuilder().callTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).build();
        var response = client.newCall(http.buildRequest(url, {method:"GET"})).execute();
        try {
            if (!response.isSuccessful()) throw new Error("HTTP " + response.code());
            return String(response.body().string());
        } finally { response.close(); }
    }
    return http.get(url, {timeout:timeoutMs}).body.string();
}

// ==================================================================================
// 3. 时间等待
// ==================================================================================

function sleepUntil(ts) {
    var lastKeep = 0;
    while (!STOP && now() < ts - 120) {
        var left = ts - now();
        sleep(left > 60000 ? Math.min(left - 500, 30000) : Math.min(left - 100, 500));
        if (now() - lastKeep > 15000) {
            keepAlive();
            if (HEARTBEAT_ON) writeHeartbeat();
            lastKeep = now();
        }
    }
    while (!STOP && now() < ts) { /* 末段自旋，保毫秒精度 */ }
}

function keepAlive() {
    try { device.keepScreenOn(3600000); } catch (e) {}
    try {
        if (!device.isScreenOn()) {
            device.wakeUp();
            sleep(400);
            var w = device.width, h = device.height;
            swipe(w / 2, h * 0.82, w / 2, h * 0.18, 300);
            sleep(600);
        }
    } catch (e) {}
}

// ==================================================================================
// 4. 场次
// ==================================================================================

function todaySessions() {
    var out = [];
    for (var i = 0; i < CFG.sessions.length; i++) {
        var p = String(CFG.sessions[i]).split(":");
        if (p.length !== 2) continue;
        var d = new Date(now());
        d.setHours(parseInt(p[0], 10), parseInt(p[1], 10), 0, 0);
        out.push({ label: CFG.sessions[i], ts: d.getTime() });
    }
    out.sort(function (a, b) { return a.ts - b.ts; });
    return out;
}

function nextSession() {
    var list = todaySessions(), n = now();
    for (var i = 0; i < list.length; i++) if (list[i].ts > n) return list[i];
    return null;
}

function tomorrowAt(hh, mm) {
    var d = new Date(now());
    d.setDate(d.getDate() + 1);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
}

// ==================================================================================
// 5. 节点工具
// ==================================================================================

function ensureAuto() {
    if (!auto.service) {
        var ok = false;
        try { auto.waitFor(); ok = !!auto.service; } catch (e) { try { auto(); ok = !!auto.service; } catch (e2) {} }
        if (!ok) throw new Error("无障碍服务未开启");
    }
}

function safeBounds(n) {
    try { var b = n.bounds(); return { l: b.left, t: b.top, r: b.right, b2: b.bottom }; } catch (e) { return null; }
}

function boundsStr(n) {
    var b = safeBounds(n);
    return b ? (b.l + "," + b.t + "," + b.r + "," + b.b2) : "?";
}

function nodeCenter(n) {
    var b = safeBounds(n);
    if (!b) return null;
    return { x: Math.round((b.l + b.r) / 2), y: Math.round((b.t + b.b2) / 2) };
}

function nodeText(n) {
    var t = "";
    try { t += (n.text() || ""); } catch (e) {}
    try { t += "|" + (n.desc() || ""); } catch (e) {}
    return t;
}

function scanByWords(words, useDesc) {
    var out = [], seen = {};
    for (var i = 0; i < words.length; i++) {
        var ns = null;
        try { ns = useDesc ? descContains(words[i]).find() : textContains(words[i]).find(); } catch (e) { ns = null; }
        if (!ns) continue;
        for (var j = 0; j < ns.length; j++) {
            var key = (function (n) { return boundsStr(n) + "|" + nodeText(n); })(ns[j]);
            if (seen[key]) continue;
            seen[key] = 1;
            out.push(ns[j]);
        }
    }
    return out;
}

// 标定用：把页面上所有「看起来像抢券控件」的节点捞出来
function candidates() {
    var kws = ["抢", "券", "¥", "¥18", "满18", "限时", "开学", "立即", "马上", "领取", "开抢", "错过", "结束"];
    var a = scanByWords(kws, false);
    var b = scanByWords(kws, true);
    var all = a.concat(b);
    all.sort(function (m, n) {
        var cm = nodeCenter(m), cn = nodeCenter(n);
        if (!cm || !cn) return 0;
        return cm.y - cn.y;
    });
    return all;
}

function describeNode(n) {
    var t = "";
    try { t = n.text() || ""; } catch (e) {}
    var d = "";
    try { d = n.desc() || ""; } catch (e) {}
    var c = nodeCenter(n);
    var label = "";
    if (t) label += t;
    if (d && d !== t) label += (label ? " / " : "") + d;
    if (!label) label = "(无文字)";
    return label + "   @ " + (c ? c.x + "," + c.y : "?");
}

// 反转式判定：负向一票否决 → class 状态词一票否决 → 正向命中
function isFireable(n) {
    var t = nodeText(n);
    var cls = "";
    try { cls = n.className() || ""; } catch (e) {}

    var negs = CFG.target.negativeText || [];
    for (var i = 0; i < negs.length; i++) if (negs[i] && t.indexOf(negs[i]) >= 0) return false;

    var negCls = CFG.target.negativeClass || [];
    for (var j = 0; j < negCls.length; j++) if (cls.indexOf(negCls[j]) >= 0) return false;
    if (/\s[A-Z]/.test(cls)) return false;

    var poss = CFG.target.positiveText || [];
    for (var k = 0; k < poss.length; k++) if (t.indexOf(poss[k]) >= 0) return true;
    return false;
}

// 区域过滤：只在券按钮所在的矩形里认目标，避开场次条上的状态标签。
// 实测：场次条「17:00 已开抢」含「抢」且无负向词，会被误判成可点；
// 真按钮在 (899,849)，场次标签在 y 549~645 —— 用区域一刀切开最稳。
function inTargetZone(n) {
    var z = CFG.target.zone;
    if (!z || !z.enabled) return true;
    var c = nodeCenter(n);
    if (!c) return true; // 拿不到坐标就不拦，交给其它判据
    return (c.x >= z.left && c.x <= z.right && c.y >= z.top && c.y <= z.bottom);
}

function fireableNodes() {
    var raw = scanByWords(CFG.target.positiveText, false).concat(scanByWords(CFG.target.positiveText, true));
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
        if (!isFireable(raw[i])) continue;
        if (!inTargetZone(raw[i])) continue;
        var key = boundsStr(raw[i]);
        if (seen[key]) continue;
        seen[key] = 1;
        out.push(raw[i]);
    }
    return out;
}

// 从一堆节点里挑最靠近标定坐标的那个（页面有多个场次按钮时用）
function pickNearest(nodes, coord) {
    if (!nodes.length) return null;
    if (!coord || (coord[0] === 0 && coord[1] === 0)) return nodes[0];
    var best = nodes[0], bestD = 1e9;
    for (var i = 0; i < nodes.length; i++) {
        var c = nodeCenter(nodes[i]);
        if (!c) continue;
        var d = Math.abs(c.x - coord[0]) + Math.abs(c.y - coord[1]);
        if (d < bestD) { bestD = d; best = nodes[i]; }
    }
    return best;
}

// ==================================================================================
// 6. App 与活动页
// ==================================================================================

function foregroundPackage() {
    // currentPackage() 是无障碍事件缓存；实测曾返回 me.ele，而屏幕已是桌面。
    try {
        if (typeof auto !== "undefined") {
            if (!auto.service) return "";
            var root = auto.service.getRootInActiveWindow();
            if (!root) return "";
            try { return String(root.getPackageName() || ""); }
            finally { try { root.recycle(); } catch (re) {} }
        }
    } catch (e) { return ""; }
    try { return currentPackage() || ""; } catch (e2) { return ""; }
}

function captureEntryFailure(reason) {
    var evidence = {reason:reason, build:BUILD_ID, at:new Date(now()).toISOString(),
        session:CURRENT_SESSION, foreground:foregroundPackage(), activity:"", dialogTexts:[]};
    try { evidence.activity=String(currentActivity() || ""); } catch (e) {}
    if (evidence.foreground === "com.huawei.android.internal.app" || evidence.foreground === "android") {
        try {
            var ns=textMatches(".+").packageName(evidence.foreground).find();
            for(var i=0;i<ns.length && i<20;i++) evidence.dialogTexts.push(nodeText(ns[i]));
        } catch (e2) { evidence.readError=String(e2); }
    }
    LAST_ENTRY_FAILURE=evidence;
    try { files.write(files.join(DIR,"entry-status.json"),JSON.stringify(evidence,null,2)); } catch (e3) {}
    log("进场失败证据："+JSON.stringify(evidence));
    return evidence;
}

function inActivityPage() {
    if (foregroundPackage() !== CFG.app.package) return false;
    var kws = (CFG.app.readyKeywords || []).concat(["未开抢", "已抢完", "立即抢", "马上抢"]);
    for (var i = 0; i < kws.length; i++) {
        try { if (kws[i] && textContains(kws[i]).exists()) return true; } catch (e) {}
    }
    return false;
}

// 从饿么么首页点进活动页。
// ⚠️ 实测纠正（2026-10-16）：首页那排图标（含「学生福利」）都是图片，
//    无障碍读不到任何文字节点 —— uiautomator dump 里根本搜不到"学生福利"。
//    所以文字定位这条路走不通，只能按坐标点。
//    实测 1080x2340 上「学生福利」图标中心 = (110,578)，点一下直达活动页。
// 做法：按顺序试多个候选坐标，每点一次就验证是否真的进了活动页，命中即停。
// 用多种方式把 App 拉到前台，返回是否真的成功。
// 【为什么需要多种】2026-10-17 18:39 实测：`app.launchPackage` 调完前台仍在桌面，
// 于是后面所有坐标都点在桌面上（把夸克浏览器点开了）。
// launchPackage 不抛异常 ≠ 拉起成功，必须验证包名，并且准备后手。
function launchAppForeground() {
    var methods = [
        function () {
            app.startActivity({
                packageName: CFG.app.package,
                className: CFG.app.launchActivity || "me.ele.Launcher",
                action: "android.intent.action.MAIN",
                category: "android.intent.category.LAUNCHER",
                flags: 0x10200000
            });
        },
        function () { app.launchPackage(CFG.app.package); }
    ];
    for (var i = 0; i < methods.length; i++) {
        try { methods[i](); } catch (e) { log("    启动方式" + (i + 1) + "异常：" + e); }
        sleep(6500);
        var p = "";
        p = foregroundPackage();
        if (p === CFG.app.package) {
            if (i > 0) log("    ✅ 启动方式" + (i + 1) + "生效");
            return true;
        }
        log("    启动方式" + (i + 1) + "之后前台仍是「" + p + "」，换下一种");
        captureEntryFailure("launch_method_"+(i+1));
    }
    return false;
}

// 确保淘宝闪购真的在前台。返回 true 才允许点任何坐标。
//
// 【2026-10-17 18:39 真机实测教训】冷启动那一次，bringUpApp 的 launchPackage 没生效，
// 页面还停在桌面，接着 5 个「学生福利」候选坐标全部点在桌面上 →
// 把「夸克浏览器」点开并弹出了搜索键盘。之后即使再点，也全点在夸克上，
// 整轮彻底失败，日志看起来像"入口坐标全失效"，实际是**前台根本不是我们的 App**。
// 所以：点坐标之前必须先验包名，拉不回来就宁可放弃，绝不对别的 App 动手。
function ensureAppForeground(tries) {
    tries = tries || 2;
    for (var i = 0; i < tries; i++) {
        var p = "";
        p = foregroundPackage();
        if (p === CFG.app.package) return true;

        log("  ⚠️ 前台是「" + p + "」而不是 " + CFG.app.package + " → 重新拉起（第 " + (i + 1) + "/" + tries + " 次）");
        try { home(); } catch (e) {}
        sleep(800);
        launchAppForeground();
    }
    var q = "";
    q = foregroundPackage();
    if (q !== CFG.app.package) {
        log("  ❌ 反复拉起仍不在 App（前台：" + q + "）→ 本轮不盲点，避免点到桌面/别的应用");
        return false;
    }
    return true;
}

function tapHomeEntry() {
    var coords = CFG.app.homeEntryCoords;
    if (!coords || !coords.length) {
        coords = (CFG.app.homeEntryCoord ? [CFG.app.homeEntryCoord] : []);
    }
    for (var i = 0; i < coords.length; i++) {
        var c = coords[i];
        if (!c || (c[0] === 0 && c[1] === 0)) continue;

        // ★ 每个候选点之前，都必须先回到「App 首页 + 滚到顶部」。
        // 原因有两个：
        //  1) 上一个候选可能把我们带到了商家页/子页面（2026-10-17 就是这样连跳商家页）
        //  2) 首页会滚动，图标行被滚出屏幕后坐标全错
        if (inActivityPage()) return true;

        // ★ 硬闸：前台不是 App 就拉回来；拉不回来直接放弃（见 ensureAppForeground 注释）
        if (!ensureAppForeground(2)) return false;

        for (var b = 0; b < 2; b++) {
            if (inActivityPage()) break;
            if (foregroundPackage() !== CFG.app.package) break;
            try { back(); } catch (e) {}
            sleep(1000);
        }
        if (!ensureAppForeground(1)) return false;
        for (var s = 0; s < 2; s++) {
            if (foregroundPackage() !== CFG.app.package) return false;
            try { swipe(540, 520, 540, 1750, 320); } catch (e) {}
            sleep(600);
        }

        // 回退/上滑之后包名也可能变（back 退出 App），出手前再验一次
        if (!ensureAppForeground(1)) return false;

        log("  点首页「学生福利」候选 " + (i + 1) + "/" + coords.length + " @ (" + c[0] + "," + c[1] + ")");
        tapAt(c[0], c[1], "首页入口" + (i + 1));
        sleep(4500);
        if (inActivityPage()) { log("  ✅ 入口命中，已进活动页"); return true; }
    }
    log("  ⚠️ 所有候选都没能进活动页");
    return false;
}

// 关掉冷启动运营弹窗。
// 【2026-10-17 14:43 真机实测】淘宝闪购从桌面冷启动会弹「天降红包待使用」全屏弹窗：
//   · 整层是图片/H5，uiautomator dump 只捞得到底部导航栏和地址栏，弹窗本体**一个节点都没有**
//   · 没有 content-desc="关闭"，无障碍无法定位；连"关闭"文字也读不到
//   · back 键无效（按了弹窗纹丝不动，实测前后截图像素级几乎相同）
//   · × 在 (536,1895)，点一下即关（实测有效）
// 所以只能按坐标盲点。调用前提：当前不在活动页（点错了最多跳个页面，不会误触抢券）。
function dismissPopup() {
    if (foregroundPackage() !== CFG.app.package) {
        captureEntryFailure("popup_wrong_foreground");
        return false;
    }
    // 先给原生弹窗一个机会：能读到「关闭」就直接点节点，比盲点可靠
    var n = null;
    try { n = textContains("关闭").findOnce(); } catch (e) { n = null; }
    if (!n) { try { n = descContains("关闭").findOnce(); } catch (e) { n = null; } }
    if (n) {
        var c0 = nodeCenter(n);
        if (c0) {
            if (foregroundPackage() !== CFG.app.package) return false;
            log("  发现可读的「关闭」节点 → 点 (" + c0.x + "," + c0.y + ")");
            tapAt(c0.x, c0.y, "关闭弹窗(节点)");
            sleep(1800);
            if (inActivityPage()) return true;
        }
    }
    var cands = (CFG.app.popupCloseCoords || [[536, 1895]]);
    for (var i = 0; i < cands.length; i++) {
        if (STOP || foregroundPackage() !== CFG.app.package) return false;
        var c = cands[i];
        if (!c || (c[0] === 0 && c[1] === 0)) continue;
        log("  盲点关闭运营弹窗 @(" + c[0] + "," + c[1] + ")");
        tapAt(c[0], c[1], "关闭运营弹窗");
        sleep(1800);
        if (inActivityPage()) return true;
    }
    return false;
}

function bringUpApp() {
    // 已经在活动页就什么都不做 —— 无谓的 launchPackage 会把任务栈重置回首页
    if (foregroundPackage() === CFG.app.package && inActivityPage()) {
        log("  已在活动页，不用动");
        return true;
    }

    // ① 确保 App 在前台
    if (foregroundPackage() !== CFG.app.package) {
        var front = foregroundPackage();
        log("拉起 App：" + CFG.app.package + "（当前前台：" + front + "）");
        // ⚠️ 2026-10-17 17:11 踩过的坑：如果前台是我们自己的 AutoX 界面，
        //    dialogs.confirm 的模态 AlertDialog 会一直压在最上层，
        //    之后每一次 click 都点在弹窗/UI 上 —— 日志里表现为"入口坐标失效"，
        //    实际是 App 压根没到前台（5 个候选坐标全打在 UI 上）。
        //    所以先把 AutoX 连同它的弹窗一起压到后台，再拉 App。
        if (front.indexOf("autojs") >= 0 || front.indexOf("autox") >= 0) {
            log("  前台是 AutoX 自己的界面 → 先 HOME 把它（含弹窗）压到后台");
            try { home(); } catch (e) {}
            sleep(800);
        }
        if (!launchAppForeground()) {
            captureEntryFailure("launch_failed");
            log("  ❌ 未能把 App 拉到前台，结束本次进场");
            return false;
        }
    }
    log("  当前 " + currentPackage() + " / " + currentActivity());

    // ② launchPackage 会把饿么么重置回首页，所以从首页点入口进活动页
    for (var k = 0; k < 3 && !STOP; k++) {
        if (inActivityPage()) { log("  ✅ 已在活动页"); break; }
        if (!tapHomeEntry()) break;
        sleep(4500);
        if (inActivityPage()) { log("  ✅ 已进活动页"); break; }
        log("  点了入口但还没到活动页，重试第 " + (k + 2) + " 次…");
    }

    // ③ 三轮都进不去 → 极可能是被冷启动运营弹窗挡住了（弹窗读不到、back 关不掉、
    //    所有入口坐标其实都点在弹窗上）。清一次障再试一遍。
    if (!inActivityPage() && !STOP) {
        if (foregroundPackage() !== CFG.app.package) return false;
        log("  ⚠️ 三轮都没能进活动页 → 怀疑被冷启动运营弹窗挡住，尝试关闭");
        var cleared = dismissPopup();
        if (cleared) {
            log("  ✅ 弹窗已关，已在活动页");
        } else if (!STOP) {
            log("  弹窗已清/不存在，再点一次入口");
            if (tapHomeEntry()) sleep(4500);
            if (inActivityPage()) log("  ✅ 已进活动页");
        }
    }
    return inActivityPage();
}

function ensureActivityPage(waitSec) {
    if (inActivityPage()) { log("✅ 已在活动页"); return true; }
    var limit = waitSec || 20;
    log("⚠️ 没看到活动页特征文字，等 " + limit + " 秒（这段时间可以手动切过去）…");
    for (var i = 0; i < limit; i++) {
        if (STOP) return false;
        sleep(1000);
        if (inActivityPage()) { log("✅ 已进入活动页"); return true; }
    }
    log("❌ 仍未进入活动页 —— 不做任何盲点，本轮放弃");
    shot("not_in_page");
    return false;
}

// ==================================================================================
// 7. 出手
// ==================================================================================

var SHOT_DEAD = false;
function shot(name) {
    // 这台机器上截图权限一直拿不到（No screen capture permission），
    // 每次失败要耗掉约 200ms，正好卡在出手前的关键路径上。失败一次就彻底停用。
    if (SHOT_DEAD || CFG.screenshots === false) return "";
    try {
        files.ensureDir(SHOT_DIR + "/");
        var img = captureScreen();
        if (!img) return "";
        var p = files.join(SHOT_DIR, dayStr(now()) + "_" + name + "_" + now() + ".png");
        images.save(img, p);
        return p;
    } catch (e) {
        var msg = String(e);
        if (msg.indexOf("screen capture") >= 0 || msg.indexOf("SecurityException") >= 0) {
            SHOT_DEAD = true;
            log("截图权限不可用（" + msg.slice(0, 60) + "）→ 本轮起停用截图，不再拖慢出手");
        } else {
            log("截图失败：" + msg);
        }
        return "";
    }
}

function tapAt(x, y, why, kind) {
    var t = now(), ok = false;
    var started = Date.now();
    var duration = CFG && CFG.timing ? CFG.timing.pressDurationMs : 0;
    var shortPress = kind === "fire" && typeof duration === "number" && duration > 0;
    var method = shortPress ? "press" : "click";
    try {
        ok = shortPress ? press(x, y, duration) : click(x, y);
    } catch (e) { log("  " + method + " 异常：" + e); }
    var elapsed = Date.now() - started;
    // kind: "fire" = 真正打向抢券按钮的出手点击；"op" = 锁场次/切跳板/关弹窗这类操作点击
    CLICKS.push({ at: t, x: x, y: y, why: why, ok: ok, kind: kind || "op", method: method, durationMs: elapsed });
    // 连点热路径只保留内存记录，窗口结束后再输出摘要。
    if (!(kind === "fire" && FIRE_PHASE && (CFG.timing.fireMode === "blind" || CFG.timing.fireMode === "readyBurst" || CFG.timing.fireMode === "timerBurst"))) {
        log("  🔫 " + why + " → (" + x + "," + y + ") @" + fmtTime(t) + (ok ? " ✓" : " ✗") + " " + method + "=" + elapsed + "ms");
    }
    return ok;
}

// 盲点前校验：page 上必须存在「锚点文字」的节点，且离标定坐标足够近
function blindTapReady(coord) {
    var bt = CFG.blindTap;
    if (!bt || bt.enabled !== true) return false;
    if (!coord || (coord[0] === 0 && coord[1] === 0)) return false;
    var anchor = bt.anchorText;
    if (!anchor) { log("  ⚠️ 没记录锚点文字 → 跳过结构校验"); return true; }

    var nodes = scanByWords([anchor], false);
    if (!nodes.length) { log("  ⚠️ 找不到锚点『" + anchor + "』→ 页面可能已改版（仍按坐标出手）"); return false; }
    var nearest = pickNearest(nodes, coord);
    var c = nearest ? nodeCenter(nearest) : null;
    if (!c) { log("  ⚠️ 锚点无坐标 → 跳过结构校验"); return true; }

    // ⚠️ 修正（2026-10-17）：原实现拿「锚点坐标」去比「按钮坐标」，
    // 但锚点『开学季红包』本来就离按钮 341px，于是每场都打出
    // 「差 341px」这种看着像异常的日志。正确做法是拿锚点比**锚点自己**的标定位置。
    var ac = bt.anchorCoord;
    if (ac && (ac[0] !== 0 || ac[1] !== 0)) {
        var d = Math.abs(c.x - ac[0]) + Math.abs(c.y - ac[1]);
        var tol = bt.anchorTolerancePx || 60;
        if (d <= tol) {
            log("  ✓ 页面结构校验通过（锚点『" + anchor + "』实测 " + c.x + "," + c.y + " vs 标定 " + ac[0] + "," + ac[1] + "，差 " + d + "px）");
        } else {
            log("  ⚠️ 页面结构校验未过（锚点『" + anchor + "』实测 " + c.x + "," + c.y + " vs 标定 " + ac[0] + "," + ac[1] + "，差 " + d + "px > " + tol + "）→ 页面可能改版，仍按坐标出手");
        }
        return true;
    }
    log("  ✓ 页面结构校验通过（锚点『" + anchor + "』存在 @ " + c.x + "," + c.y + "，未标定锚点坐标故只查存在性）");
    return true;
}

// 读券按钮区域当前文案。注意：这是一次全树扫描，耗时 3~7 秒，
// 所以只能在出手之前/之后调用，整点前后绝对不能调。
function readButtonText() {
    var z = CFG.target.zone;
    if (!z) return "?";
    var out = [];
    try {
        var ns = textMatches(".+").boundsInside(z.left, z.top, z.right, z.bottom).find();
        for (var i = 0; i < ns.length; i++) {
            var s = "";
            try { s = ns[i].text() || ""; } catch (e) {}
            if (s) out.push(s);
        }
    } catch (e) {}
    return out.join("/");
}

// 极速版：只取按钮区第一个文字节点。
//
// 【2026-10-17 14:22 实测】各种读法的真实耗时：
//   textMatches(".+").boundsInside(zone).findOnce()   ≈ 25ms   ← 本函数
//   textContains("抢").boundsInside(zone).findOnce()  ≈ 27ms
//   textMatches(".+").boundsInside(zone).find()       ≈ 74ms
//   textContains("立即抢").exists()（找不到时）        ≈ 430ms
// 之前一直以为要 345ms，那是**测法有问题**：那次跑的是全树 find() 再在 JS 里
// 逐个算 bounds 中心点。换成 boundsInside + findOnce 后只要 25ms ——
// 所以「点一次就顺手看一眼」完全负担得起，一轮 click155 + read25 ≈ 180ms。
function readButtonTextFast() {
    var z = CFG.target.zone;
    if (!z) return "";
    try {
        var n = textMatches(".+").boundsInside(z.left, z.top, z.right, z.bottom).findOnce();
        if (n) return n.text() || "";
    } catch (e) {}
    // 兜底：findOnce 取不到（节点树异常/按钮区暂时为空）时退回全量读法。
    // 只在异常路径走到，正常行情不会多花这 74ms。
    return readButtonText();
}

// 独立低频观察；只写内存，不参与点击决策，不逐次输出日志。
function observeFireFeedback(target, endAt, sink) {
    var gap = CFG.timing.feedbackPollMs;
    if (typeof gap !== "number" || gap < 100) gap = 250;
    var lastText = "", lastMessage = "";
    var messagePattern = ".*(操作太频繁|活动火爆|太火爆|当前活动热|挤爆了|系统繁忙|本场活动还未开始|来晚一步|已抢完|领取失败|活动已结束|领取成功|恭喜|不符合|不满足|未认证|认证失败|请先.*认证|无.*资格|暂无.*资格|资格.*异常|重新登录).*";
    sink.metrics = {iterations:0, buttonReads:0, failedReads:0, maxButtonReadMs:0, maxMessageReadMs:0, maxCycleMs:0};
    try {
        while (!STOP && !sink.stop && now() < endAt && !FIRE_PHASE) sleep(10);
        while (!STOP && !sink.stop && FIRE_PHASE && now() < endAt) {
            try {
                var cycleStart = monotonicMs(), at = now(), started = monotonicMs();
                sink.metrics.iterations++;
                var text = readButtonTextFast();
                var readMs = monotonicMs() - started, observedAt = now();
                sink.metrics.buttonReads++;
                sink.metrics.maxButtonReadMs = Math.max(sink.metrics.maxButtonReadMs, readMs);
                if (text && text !== lastText) {
                    sink.samples.push({ at: at, offsetMs: at - target, text: text, readMs: readMs, observedAt:observedAt, observedOffsetMs:observedAt-target });
                    lastText = text;
                }
                var message = "";
                var messageStarted = monotonicMs();
                var n = textMatches(messagePattern).boundsInside(0, 650, device.width || 1080, 1550).findOnce();
                sink.metrics.maxMessageReadMs = Math.max(sink.metrics.maxMessageReadMs, monotonicMs()-messageStarted);
                if (n) message = String(n.text() || "");
                if (message && message !== lastMessage) {
                    sink.messages.push({ at: now(), offsetMs: now() - target, text: message });
                }
                lastMessage = message;
                sink.metrics.maxCycleMs = Math.max(sink.metrics.maxCycleMs, monotonicMs()-cycleStart);
            } catch (e) {
                sink.metrics.failedReads++;
                if (sink.errors.length < 20) sink.errors.push(String(e));
            }
            sleep(gap);
        }
    } finally { sink.finished = true; sink.metrics.finishedAt = now(); }
}

// ==================================================================================
// 出手前「锁定目标场次」
//
// 血泪教训（2026-10-16 20:00 真机实测，用户一句话点破）：
//   按钮 (899,849) 不是"某个固定场次的按钮"，而是"当前选中场次的按钮" ——
//   **场次条停在哪个场次，它就显示哪个场次的状态**。
//   20:00 那一次场次条停在了 14:00 附近，按钮显示 14:00 的状态「已错过」，
//   于是 31 次点击全部打在了一个已过期的按钮上，一次有效请求都没发出去。
//   （对比 18:00 那场：按钮当时正确对应下一个场次，显示"18:00开抢"，
//    点击立刻生效 →"立即抢"→"正在抢"，服务器回了"活动太火爆"。）
//
// 所以：位置固定是真的，但"位置上的语义"不固定。出手前必须先确认按钮
// 对应的是目标场次，不对就想办法把它切过去。
// ==================================================================================
function hhmmOf(ts) {
    var d = new Date(ts);
    return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
}

// 强制把场次条切到目标场次，并验证「按钮真的属于这一场」。
// 返回 true = 已确认（按钮文案含目标 HH:MM，或已点目标格且该场已开放）。
//
// 【2026-10-18 真机血泪 · 这是 10:00 / 11:00 两场全丢的直接原因】
//   08:00 场结束后，按钮**停留在「立即抢」**（它属于 08:00 那张券，后文一直没变）。
//   09:57 锁 10:00 时，旧代码判断 `btn 含「立即抢」→ ✅ 按钮已是可抢状态 → return true`，
//   **一次都没去点场次条**。于是 09:59:58 的两次点击全打在 08:00 那张券上，
//   服务端立刻回「已错过」，脚本判定本场结束收手。11:00 完全复现。
//
//   结论：「立即抢」这三个字**不带任何场次信息**，只有「HH:MM开抢」才带。
//   只要按钮文案里没有目标 HH:MM，就必须去场次条点目标格，不能再"看着像可抢就放过"。
// 点完场次格后，轮询等按钮文案变成目标 HH:MM（最多 maxMs）。
// 用轮询替代固定 sleep(2500)：快的话 300~600ms 就返回，
// 这样"重新锁场次"能压到 1 秒内，才敢在整点前 10 秒还去纠正场次。
function waitButtonContains(hhmm, maxMs) {
    var t0 = now();
    var b = null;
    while (!STOP && now() - t0 < maxMs) {
        b = readButtonTextFast();
        if (b && b.indexOf(hhmm) >= 0) return b;
        sleep(120);
    }
    return b || readButtonTextFast();
}

function forceSelectSession(hhmm, ts) {
    var z = CFG.target.zone;
    var top = z ? Math.max(0, z.top - 320) : 480;
    var bottom = z ? z.top : 760;
    var SW = device.width || 1080;

    function findCell(txt) {
        var ns = null;
        try { ns = textContains(txt).boundsInside(0, top, SW, bottom).find(); } catch (e) { ns = null; }
        if (ns && ns.length) {
            for (var i = 0; i < ns.length; i++) {
                var c = nodeCenter(ns[i]);
                if (c) return c;
            }
        }
        return null;
    }

    function verify(stage) {
        var b = readButtonText();
        log("    " + stage + "改后按钮[" + b + "]");
        if (b && b.indexOf(hhmm) >= 0) return true;
        if (now() >= ts && /立即抢|马上抢|去抢|点击领取|立即领取/.test(b || "")) {
            // 点了目标格之后按钮变"可抢"，说明目标场次此刻已开放 —— 可以接受
            log("    ⚠️ 已点目标格但按钮显示可抢（该场应已开放）→ 接受");
            return true;
        }
        return false;
    }

    // ① 场次条上有目标 HH:MM 文本 → 直接点它
    var c = findCell(hhmm);
    if (!c) {
        // 场次条横向滚动，目标可能在屏幕外 —— 左右各滑两次再找
        log("    场次条里没看到「" + hhmm + "」，横向滑动再找");
        var yBar = Math.round((top + bottom) / 2);
        for (var a = 0; a < 4 && !c; a++) {
            try {
                if (a % 2 === 0) swipe(250, yBar, 950, yBar, 300);   // 手指右滑 → 露出更早的场次
                else swipe(950, yBar, 250, yBar, 300);               // 手指左滑 → 露出更晚的场次
            } catch (e) {}
            sleep(800);
            c = findCell(hhmm);
        }
    }
    if (c) {
        log("    点场次条「" + hhmm + "」@ (" + c.x + "," + c.y + ")");
        tapAt(c.x, c.y, "场次" + hhmm);
        waitButtonContains(hhmm, 2200);
        if (verify("①")) { log("  ✅ 锁定成功（场次条点「" + hhmm + "」）"); return true; }
    }

    // ② 兜底：下一场那一格没有 HH:MM，只显示倒计时 +「即将开始」
    //    **只在目标确实就是"下一场"时才敢点这一格**：场次最小间隔 1 小时，
    //    所以只有目标在 15 分钟内时，点「即将开始」格才必然是点中它。
    //    （原先写成 90 分钟，12:21 自测时 14:00 还有 99 分钟，判据直接失效 —— 已收紧）
    var dl = ts - now();
    var near = FORCE_SELECT_ANY || (dl >= -60000 && dl <= 15 * 60000);
    if (near) {
        var c2 = findCell("即将开始");
        if (c2) {
            log("    目标格只显示倒计时 → 点「即将开始」格 @ (" + c2.x + "," + c2.y + ")");
            tapAt(c2.x, c2.y, "场次即将开始格");
            waitButtonContains(hhmm, 2200);
            if (verify("②")) { log("  ✅ 锁定成功（经「即将开始」格）"); return true; }
        } else {
            log("    ⚠️ 场次条上连「即将开始」都没有，无法定位目标场次");
        }
    }
    return false;
}

function lockTargetSession(ts) {
    var hhmm = hhmmOf(ts);
    var btn = readButtonText();
    log("  场次锁定：目标 " + hhmm + "，当前按钮[" + btn + "]");

    // 只有文案里带目标 HH:MM 才算"已经锁定"。见 forceSelectSession 顶部注释。
    if (btn && btn.indexOf(hhmm) >= 0) { log("  ✅ 按钮已对应 " + hhmm); return true; }

    if (/立即抢|正在抢/.test(btn || "")) {
        log("  ⚠️ 按钮显示「" + btn + "」但不带场次信息（很可能是上一场遗留）→ 强制去场次条重选");
    }

    if (forceSelectSession(hhmm, ts)) return true;

    log("  ❌ 场次锁定失败（按钮未对应 " + hhmm + "）");
    return false;
}

// 没有坐标时的退路：靠节点找按钮。慢，但能兜底。
function fallbackNodeFire(target) {
    var T = CFG.timing;
    var winEnd = target + T.fireWindowMs;
    var lastClick = 0;
    var coord = CFG.blindTap.coord;
    log("=== 出手窗口开始（节点模式，较慢）===");
    while (!STOP && now() < winEnd) {
        var n = now();
        if (n >= target - 200) {
            var list = fireableNodes();
            if (list.length && CLICKS.length < T.maxClicks && (n - lastClick) >= 500) {
                var node = pickNearest(list, coord);
                var c = node ? nodeCenter(node) : null;
                if (c) {
                    var txt = "";
                    try { txt = node.text() || node.desc() || "?"; } catch (e) { txt = "?"; }
                    tapAt(c.x, c.y, "节点[" + txt + "]");
                    lastClick = n;
                }
            }
        }
        if (CLICKS.length >= T.maxClicks) break;
        sleep(T.pollIntervalMs);
    }
    log("=== 出手窗口结束，共点击 " + CLICKS.length + " 次 ===");
    return CLICKS.length ? "fired" : "no_click";
}

/*
 * 出手：先锁定目标场次与坐标，不早于校准后的目标时间。
 * readyBurst 首次确认按钮可抢后连续短按，独立线程采样反馈。
 * 手势返回成功仅表示触控调用成功，不能据此推断领取请求或领取结果。
 */
function doFire(target, label) {
    var T = CFG.timing;
    var coord = CFG.blindTap.coord;
    var hasCoord = !!(coord && (coord[0] !== 0 || coord[1] !== 0));

    // ⚠️ 顺序铁律（2026-10-17 14:40 演练抓到的致命 bug）：
    //   这两步必须**先锁场次（T-3min）再确认页面（T-45s）**。
    //   旧代码把 T-45s 写在前面，sleepUntil(target-45000) 把时间推到了 T-45s，
    //   紧接着的 `target - now() > 180000` 恒等于 `45000 > 180000` = false，
    //   于是 lockTargetSession 一次都没执行过 —— 是彻底的死代码。
    //   20:00 那场"按钮停在 14:00 已错过、31 次点击全打空"就是这么来的。

    // ① T-3min：把抢券按钮锁定到目标场次（最早，必须先做）
    var LOCK_BEFORE = T.lockBeforeMs || 180000;
    if (target - now() > LOCK_BEFORE) {
        sleepUntil(target - LOCK_BEFORE);
        keepAlive();
        log("=== 出手前锁定场次「" + hhmmOf(target) + "」===");
        if (!lockTargetSession(target)) {
            log("⚠️ 锁定失败，重新进一次活动页再试");
            bringUpApp();
            if (!ensureActivityPage(30)) return "lost_page";
            if (!lockTargetSession(target)) {
                log("⛔ 未确认目标场次，本轮停止");
                return "wrong_session";
            }
        }
    } else if (target - now() > 0) {
        // 启动太晚（进 doFire 时已不足 3 分钟）→ 没法走完整的锁定等待，
        // 但仍然立即做一次同步锁定，不能裸奔。
        log("⚠️ 进场时已不足 3 分钟，直接做一次即时场次锁定");
        if (!lockTargetSession(target)) {
            log("⛔ 即时锁定失败，本轮停止");
            return "wrong_session";
        }
    }

    // ①.3 场次看门狗：从锁完到 T-45s，每 20 秒读一次按钮（25ms），漂了就重锁
    //
    // 【2026-10-18 12:32 真机实测，这条是整个下午最重要的一笔】
    //   12:24 屏幕上是「14:00开抢」，12:32 变成「08:00 已错过」，
    //   而日志文件 mtime 停在 12:23:38 —— 脚本一行都没写过，**没有任何点击参与**。
    //   也就是说：这个 H5 会自己把选中的场次退回第一场（08:00）。
    //   所以"T-3min 锁一次就放心"是错的，必须在等待期间持续盯。
    var hhW = hhmmOf(target);
    var wdEnd = target - (T.reloginBeforeMs || 45000) - 800;
    var nextChk = now() + 15000;
    while (!STOP && now() < wdEnd) {
        if (now() >= nextChk) {
            nextChk = now() + 20000;
            var bw = readButtonTextFast();
            if (!bw || bw.indexOf(hhW) < 0) {
                log("⚠️ 场次看门狗：按钮[" + bw + "]不含「" + hhW + "」→ 重锁");
                if (!forceSelectSession(hhW, target)) return "wrong_session";
            }
        }
        sleep(400);
    }

    // ② T-45s：确认还在活动页，否则重新摆一次（这一步慢没关系）
    if (target - now() > T.reloginBeforeMs) {
        sleepUntil(target - T.reloginBeforeMs);
        keepAlive();
        if (!inActivityPage() || currentPackage() !== CFG.app.package) {
            log("⚠️ 出手前发现已离开活动页，重新摆一次");
            bringUpApp();
            if (!ensureActivityPage(25)) return "lost_page";
        }
    }

    // ①.5 T-30s：再复核一次场次
    //
    // 判据只看「按钮文案里有没有目标 HH:MM」——「立即抢」不算数（它不带场次信息）。
    // 实测页面会自己退回 08:00（见看门狗注释），所以 T-3min 锁过不能代表 T-30s 还锁着。
    if (target - now() > 30000) {
        sleepUntil(target - 30000);
        keepAlive();
        var hhT = hhmmOf(target);
        var b30 = readButtonTextFast();
        if (b30 && b30.indexOf(hhT) >= 0) {
            log("✅ T-30s 复核：按钮[" + b30 + "]仍是目标场次");
        } else {
            log("⚠️ T-30s 复核：按钮[" + b30 + "]不含「" + hhT + "」→ 立即重新锁定");
            if (!forceSelectSession(hhT, target)) return "wrong_session";
        }
    }

    // ①.6 T-10s：最后一道场次闸（此时重锁≈1~2 秒，还赶得上）
    if (target - now() > 10000) {
        sleepUntil(target - 10000);
        var b10 = readButtonTextFast();
        var hh10 = hhmmOf(target);
        if (!b10 || b10.indexOf(hh10) < 0) {
            log("⚠️ T-10s 复核：按钮[" + b10 + "]不含「" + hh10 + "」→ 最后重锁");
            if (!forceSelectSession(hh10, target)) return "wrong_session";
        }
    }

    // 结构检查提前完成，最后3秒只读按钮区域，避免全页扫描或截图吞掉窗口。
    if (hasCoord && !blindTapReady(coord)) log("⚠️ 锚点校验未通过，等待点前按钮校验");

    // T-3s 再核实场次。目标时间到来前，泛化的 ready 文案不能证明场次身份。
    sleepUntil(target - 3000);
    var preBtn = readButtonTextFast();
    if (!FORCE_READY && (!preBtn || preBtn.indexOf(hhmmOf(target)) < 0)) {
        log("⚠️ T-3s 场次不符：按钮[" + preBtn + "]，最后重选目标");
        if (!forceSelectSession(hhmmOf(target), target)) return "wrong_session";
        preBtn = readButtonTextFast();
    }
    log("T-3s 核验：按钮区[" + preBtn + "] ｜ 包名=" + currentPackage());

    if (!hasCoord) {
        log("⚠️ 没有盲点坐标，退回节点点击");
        return fallbackNodeFire(target);
    }

    // ③ 出手窗口。各模式共享场次与几何预检，触发方式在分支内定义。
    var endAt = target + T.fireWindowMs;
    var n = 0;
    var stopReason = "";
    var transitions = [];
    var lastBtn = preBtn || "";
    var notstartHits = 0;
    var refreshCount = 0;
    var refreshBroken = false;   // 一旦切不回目标场次，就彻底放弃"切场次"这条路，改纯轮询
    var MAX_REFRESH = 3;
    var sentinelGap = T.sentinelGapMs || 15;

    // 快速连点：窗口与次数上限在此初始化，避免依赖未赋值的变量。
    if (T.fireMode === "blind" || T.fireMode === "readyBurst" || T.fireMode === "timerBurst") {
        var bGap = T.blindGapMs;
        if (typeof bGap !== "number" || bGap < 0) bGap = 50;
        var bCap = T.blindMaxClicks;
        if (typeof bCap !== "number" || bCap <= 0) bCap = 150;
        var bWin = T.fireWindowMs;
        if (typeof bWin !== "number" || bWin <= 0) bWin = 10000;

        var bEnd = target + bWin;
        var precheck;
        try { precheck = preClickCheck(preBtn, classifyButton(preBtn), true); }
        catch (pe) { precheck = { ok: false, why: "连点预检异常：" + pe }; }
        if (!precheck.ok) {
            log("⛔ 连点预检未过：" + precheck.why);
            return "precheck_failed";
        }
        log("=== 连点模式：" + (T.fireMode === "readyBurst" ? "整点后等可抢再触发；" : "整点触发；") + "短按 " + T.pressDurationMs + "ms + 额外间隔 " + bGap + "ms；窗口截止整点+" + bWin + "ms / 上限 " + bCap + " 次；开始后不逐次查状态、不切场次、不逐次写盘 ===");
        var feedbackThread = null;
        FIRE_FEEDBACK = { enabled: T.captureFireFeedback === true, samples: [], messages: [], errors: [], stop: false, finished: false };
        if (FIRE_FEEDBACK.enabled) {
            try {
                feedbackThread = threads.start(function () { observeFireFeedback(target, bEnd, FIRE_FEEDBACK); });
            } catch (fe) { FIRE_FEEDBACK.errors.push("observer start: " + fe); }
        }
        sleepUntil(target);
        if (T.fireMode !== "readyBurst") {
            FIRE_FEEDBACK.triggerAt = now();
            FIRE_FEEDBACK.triggerOffsetMs = FIRE_FEEDBACK.triggerAt - target;
            FIRE_FEEDBACK.triggerMode = "timer";
        }

        // 只在首次出手前等待可抢。开始连点后，状态采样由独立观察器承担。
        if (T.fireMode === "readyBurst") {
            var readyGap = typeof T.readyPollMs === "number" ? Math.max(1, T.readyPollMs) : 10;
            var readySeen = false, waitText = "";
            while (!STOP && now() < bEnd) {
                if (currentPackage() !== CFG.app.package) {
                    FIRE_FEEDBACK.stop = true;
                    return "lost_page";
                }
                var readyText = readButtonTextFast();
                if (readyText && readyText !== waitText) {
                    var observedAt = now();
                    FIRE_FEEDBACK.samples.push({at:observedAt, offsetMs:observedAt-target, text:readyText, phase:"waiting"});
                    waitText = readyText;
                }
                var readyState = classifyButton(readyText);
                if (readyState === "dead") break;
                if (readyState === "ready") {
                    var readyCheck;
                    try { readyCheck = preClickCheck(readyText, readyState); }
                    catch (re) { readyCheck = {ok:false, why:"触发校验异常：" + re}; }
                    if (!readyCheck.ok) {
                        FIRE_FEEDBACK.stop = true;
                        log("⛔ 可抢触发校验未过：" + readyCheck.why);
                        return "precheck_failed";
                    }
                    readySeen = true;
                    FIRE_FEEDBACK.triggerAt = now();
                    FIRE_FEEDBACK.triggerOffsetMs = FIRE_FEEDBACK.triggerAt - target;
                    FIRE_FEEDBACK.triggerMode = "ready";
                    break;
                }
                sleep(readyGap);
            }
            if (!readySeen) {
                FIRE_FEEDBACK.stop = true;
                log("⏹ 等待可抢结束，未触发连点；最后按钮[" + waitText + "]");
                return "no_click";
            }
        }

        var bStart = now();
        var bN = 0;
        var gestureFailed = false;
        FIRE_PHASE = true;
        try {
            while (!STOP && now() < bEnd && bN < bCap) {
                if (currentPackage() !== CFG.app.package) {
                    log("⛔ 连点中前台已改变，本轮停止");
                    return "lost_page";
                }
                if (STOP || now() >= bEnd) break;
                bN++;
                if (!tapAt(coord[0], coord[1], "连点#" + bN + "(整点+" + (now() - target) + "ms)", "fire")) {
                    gestureFailed = true;
                    break;
                }
                sleep(bGap);
            }
        } finally {
            FIRE_PHASE = false;
            FIRE_FEEDBACK.stop = true;
        }
        if (feedbackThread) { try { feedbackThread.join(1000); } catch (je) { FIRE_FEEDBACK.errors.push("observer join: " + je); } }
        n = bN;
        log("=== 连点结束：触控调用 " + bN + " 次，用时 " + Math.round((now() - bStart) / 100) / 10 + " 秒；业务响应另判 ===");
        if (FIRE_FEEDBACK.samples.length) log("    实际观察的按钮状态：" + JSON.stringify(FIRE_FEEDBACK.samples));
        if (FIRE_FEEDBACK.messages.length) log("    实际观察的页面提示：" + JSON.stringify(FIRE_FEEDBACK.messages));
        sleep(1200);
        var bp = readButtonText();
        log("    连点后按钮[" + bp + "]");
        if (gestureFailed) return "gesture_failed";
        return bN ? "fired" : "no_click";
    }

    FIRE_PHASE = true;
    log("=== 出手：哨兵只读不点（整点前 " + (T.sentinelMs || 1500) + "ms 起，每 " + (sentinelGap + 25) + "ms 读一次）→ 整点后**只在按钮可抢时才点** → (" + coord[0] + "," + coord[1] + ") ===");

    // ---- ① 哨兵：整点前盯住按钮，只读不点 ----
    sleepUntil(target - (T.sentinelMs || 1500));
    var polls = 0, earlyMs = null;
    while (!STOP && now() < target) {
        polls++;
        var sv = readButtonTextFast();
        if (classifyButton(sv) === "ready") {
            earlyMs = now() - target;
            log("  ⚡ 哨兵命中：整点前 " + (-earlyMs) + "ms 按钮已变「" + sv + "」→ 立刻出手");
            break;
        }
        sleep(sentinelGap);
    }
    if (earlyMs === null) log("  哨兵轮询 " + polls + " 次，整点前按钮一直是「" + lastBtn + "」（要等整点切状态）");
    // ready 文案可能来自残留场次；状态命中不能越过目标时间。
    sleepUntil(target);

    // ---- ② 主循环：只在「可抢」时才点，绝不对「未开始」的按钮动手 ----
    //
    // 【为什么不能对「未开始」点】用户实测：第一次提前点完之后像是有个冷却期，
    // 之后即使按钮变成可抢也点不动了。而「XX:00开抢」状态下点击本来就只弹
    // 「本场活动还未开始」、一个请求都不发 —— 等于**白白打开冷却、还把机会用掉**。
    //
    // 【为什么可抢状态下也要限速】对照两次实测：
    //   18:00 三次点击、间隔 2.2s → 按钮变成「立即抢」→「正在抢」，服务端有响应
    //   14:00 七十一次、间隔 168ms → 按钮全程停在「14:00开抢」，毫无反应
    //   密度高反而全无反应，更像被节流打死，而不是"抢不到"。
    // 所以可抢状态下的两次点击之间至少隔 clickGapMs。
    var clickGap = T.clickGapMs || 500;
    var pollGap = T.pollGapMs || 15;
    var lastClickAt = 0;
    var procSeen = false;   // 是否正处于「正在抢」的观察期
    var procPolls = 0;

    while (!STOP && now() < endAt && n < T.maxClicks) {
        var txt = readButtonTextFast();
        if (txt && txt !== lastBtn) {
            transitions.push("@" + (now() - target) + "ms [" + lastBtn + "]→[" + txt + "]");
            log("  ⇢ 按钮变化：" + JSON.stringify(lastBtn) + " → " + JSON.stringify(txt));
            lastBtn = txt;
        }
        var st = classifyButton(txt);

        // ★★★ 2026-10-17 17:00 真机血泪，这是整场失败的直接原因 ★★★
        // 旧代码在这里 `break`，把「正在抢」当成终态。它不是终态，是**暂态**：
        //   17:00:01.306 按钮变「正在抢」
        //   17:00:03.129 按钮自己退回「立即抢」   ← 请求失败了，券还能抢，按钮重新可用
        // 脚本却从 01.3 秒起彻底停手，把剩下 17 秒全扔了。
        // 「正在抢」只证明前端进入处理状态；请求是否发出需另行验证。
        if (st === "processing") {
            if (!procSeen) {
                procSeen = true;
                procPolls = 0;
                log("  ⇢ 前端显示「" + txt + "」，继续观察；是否发出领取请求尚未确认");
            }
            procPolls++;
            sleep(pollGap);
            continue;
        }
        if (st === "dead") { stopReason = "本场已结束（按钮显示「" + txt + "」）"; break; }

        if (procSeen) {
            // 前端恢复可抢，继续尝试；不能仅凭文案推断请求结果。
            procSeen = false;
            log("  ↺ 前端已从处理中恢复（观察 " + procPolls + " 轮）→ 继续尝试");
            procPolls = 0;
            notstartHits = 0;
        }

        if (st === "ready") {
            notstartHits = 0;
            // 可抢了 —— 但要避开冷却，两次点击至少隔 clickGap
            if (now() - lastClickAt >= clickGap) {
                // ★★ 点前确认（用户明确要求）：三道闸全过才允许出手 ★★
                // 校验失败或异常时不注入点击，保留原因供排查。
                var chk = { ok: false };
                try { chk = preClickCheck(txt, st); }
                catch (e) { chk = { ok: false, why: "点前校验异常：" + e }; }
                if (!chk.ok) {
                    log("  ⛔ 点前校验未过：" + chk.why + " → 本次不出手");
                    sleep(pollGap);
                    continue;
                }
                n++;
                lastClickAt = now();
                tapAt(coord[0], coord[1], "第" + n + "次(整点" + (now() - target >= 0 ? "+" : "") + (now() - target) + "ms，状态=" + txt + ")", "fire");
                // 点完立刻看：变了就记为变化；变成处理中/已结束就收工
                var t2 = readButtonTextFast();
                if (t2 && t2 !== lastBtn) {
                    transitions.push("@" + (now() - target) + "ms [" + lastBtn + "]→[" + t2 + "]");
                    log("  ⇢ 点后变化：" + JSON.stringify(lastBtn) + " → " + JSON.stringify(t2));
                    lastBtn = t2;
                }
                var st2 = classifyButton(t2);
                // 点完变「正在抢」也**不停手** —— 交给下一轮循环静默观察，回落就再点。
                if (st2 === "dead") { stopReason = "本场已结束（" + t2 + "）"; break; }
            }
        } else {
            // notstart / unknown —— 一律不点。只累计，超阈值才刷新场次。
            notstartHits++;
            // ⚠️ 2026-10-17 14:40 演练：25 次 × ~40ms ≈ 整点后 **1 秒**就会触发刷新，
            //    而一次刷新（点跳板 + 切回 + 两次 sleep）要吃掉 2.2 秒，
            //    这期间完全不读按钮、不点击。若服务端在 +1.0s ~ +3.2s 之间放开，
            //    正好被这次刷新整个吞掉 —— 等于自己制造了一次"错过"。
            //    加时间下限：整点后至少 refreshAfterMs（默认 4s）才允许刷新，
            //    把整点后最宝贵的头 4 秒完整留给"纯轮询、纯出手"。
            var sinceT = now() - target;
            if (notstartHits >= (T.notstartRefreshAfter || 25) && refreshCount < MAX_REFRESH
                && !refreshBroken && sinceT >= (T.refreshAfterMs || 4000)) {
                log("  ⚠️ 已 " + notstartHits + " 次轮询都是「" + txt + "」（前端在拦，一直没放开）→ 第 " + (refreshCount + 1) + " 次强制刷新场次");
                notstartHits = 0;
                refreshCount++;
                var okRefresh = forceRefreshSession(target);
                if (!okRefresh) {
                    log("  ⛔ 切回目标场次失败，本轮停止");
                    FIRE_PHASE = false;
                    return "wrong_session";
                }
                var t3 = readButtonTextFast();
                var st3 = classifyButton(t3);
                log("  刷新后按钮[" + t3 + "] → " + st3 + (okRefresh ? "" : "（⚠️ 未确认切回目标场次）"));
                if (t3 && t3 !== lastBtn) {
                    transitions.push("@" + (now() - target) + "ms [" + lastBtn + "]→[" + t3 + "]");
                    lastBtn = t3;
                    notstartHits = 0;
                }
                if (st3 === "processing") {
                    procSeen = true;
                    procPolls = 0;
                    sleep(pollGap);
                    continue;
                }
                if (st3 === "dead") {
                    // ⚠️ 刷新路径上的 dead 不可全信：如果切回目标场次失败，
                    // 读到的是**跳板场次**的状态（实测：14:00 场的「已抢完」），
                    // 据此停手会白丢一整场。复读一次，两次完全一致才认。
                    sleep(150);
                    var t4 = readButtonTextFast();
                    var st4 = classifyButton(t4);
                    if (st4 === "dead" && t4 === t3) {
                        stopReason = "刷新后本场已结束（" + t3 + "，复核一致）";
                        break;
                    }
                    log("  ↺ 死状态复核不一致：[" + t3 + "] vs [" + t4 + "] → 状态在变，继续轮询");
                    notstartHits = 0;
                }
            }
        }
        sleep(pollGap);
    }
    if (stopReason) log("  ⏹ " + stopReason);
    else log("  ⏹ 出手窗口结束（整点+" + T.fireWindowMs + "ms）");

    // ④ 出手后再看一次结果（这时慢无所谓）
    sleep(1200);
    var postBtn = readButtonText();
    log("=== 出手结束：共点击 " + n + " 次（" + Math.round((now() - target) / 100) / 10 + " 秒）===");
    log("    按钮文案 " + JSON.stringify(preBtn) + " → " + JSON.stringify(postBtn));
    if (transitions.length) log("    中间变化 " + transitions.length + " 次：" + transitions.join(" ｜ "));
    else log("    ⚠️ 未观测到按钮文案变化，业务响应仍未证实");
    FIRE_PHASE = false;
    return n ? "fired" : "no_click";
}

// 强制刷新目标场次的券状态。
//
// 【2026-10-17 实测依据】点击「XX:00开抢」这种"未开始"状态的按钮，只会弹一句
// 「本场活动还未开始」的 toast（不到 1 秒就消失），**不会向服务端发出任何请求**。
// 也就是说：页面状态不刷新时，点一万次也是空枪。
// 而点场次条上的某一格 = 重新拉该场次的券数据（实测：点 18:00 后按钮立刻
// 从「17:00开抢」变成「18:00开抢」，券卡片整体重绘）。
//
// 所以整点后如果一直读到"未开始"，就用「切到别的场次再切回来」逼页面去取最新状态。
function forceRefreshSession(ts) {
    var hhmm = hhmmOf(ts);
    var z = CFG.target.zone;
    var top = z ? Math.max(0, z.top - 320) : 480;
    var bottom = z ? z.top : 760;
    var SW = device.width || 1080;

    // 目标格在哪：还没轮到时显示「hh:mm」；正好是"下一场"时显示倒计时 +「即将开始」
    function findTarget() {
        var ns = null;
        try { ns = textContains(hhmm).boundsInside(0, top, SW, bottom).find(); } catch (e) { ns = null; }
        if (ns && ns.length) return nodeCenter(ns[0]);
        var ns2 = null;
        try { ns2 = textContains("即将开始").boundsInside(0, top, SW, bottom).find(); } catch (e) { ns2 = null; }
        if (ns2 && ns2.length) return nodeCenter(ns2[0]);
        return null;
    }

    var tc = findTarget();
    if (!tc) { log("  ⚠️ 场次条上定位不到目标格，无法刷新"); return false; }

    // 找一个别的时刻格当跳板（必须在同一行，避免点到别处的时刻文字）
    var jump = null;
    try {
        var all = textMatches("\\d{1,2}:\\d{2}").boundsInside(0, top, SW, bottom).find();
        for (var i = 0; i < all.length; i++) {
            var s = "";
            try { s = all[i].text() || ""; } catch (e) {}
            if (!s || s === hhmm) continue;
            var c = nodeCenter(all[i]);
            if (c && Math.abs(c.y - tc.y) < 90) { jump = c; break; }
        }
    } catch (e) { jump = null; }

    if (jump) {
        tapAt(jump.x, jump.y, "跳板场次" + "@(" + jump.x + "," + jump.y + ")");
        sleep(1000);

        // ★★ 关键修复（2026-10-17 14:52 真机测试抓到的致命误判）★★
        // 切到跳板场次后，场次条会重新布局（选中格放大/居中/滚动），
        // 目标格的坐标**已经变了**。原来这里直接用切换前算好的 tc 去点，
        // 结果点空、页面停在跳板场次上：
        //   点跳板 14:00 → 想点回 (485,624) 却点空 → 页面仍是 14:00 场的
        //   按钮「已抢完」→ 主循环把它当成"本场已结束"→ 直接停手。
        // 如果这发生在 17:00 后的 +4 秒，等于**白丢一整场**。
        // 所以：每次点击前重新定位，点完还要校验按钮文案是否对得上目标场次。
        var tcBack = findTarget() || tc;
        tapAt(tcBack.x, tcBack.y, "切回目标场次");
        sleep(1200);

        var chk = readButtonTextFast();
        var mchk = /(\d{1,2}:\d{2})/.exec(chk || "");
        if (mchk && mchk[1] !== hhmm) {
            log("  ⚠️ 切回后按钮显示「" + chk + "」（" + mchk[1] + " 场），不是目标「" + hhmm + "」→ 再切一次");
            var tcBack2 = findTarget() || tcBack;
            tapAt(tcBack2.x, tcBack2.y, "二次切回目标场次");
            sleep(1400);
            var chk2 = readButtonTextFast();
            var m2 = /(\d{1,2}:\d{2})/.exec(chk2 || "");
            if (m2 && m2[1] !== hhmm) {
                log("  ❌ 两次都没能切回目标「" + hhmm + "」，按钮仍显示「" + chk2 + "」→ 本次刷新判为失败");
                return false;
            }
            log("  ✅ 二次切回成功，按钮[" + chk2 + "]");
        }
        log("  🔄 已做一次「切换-切回」刷新");
        return true;
    }
    tapAt(tc.x, tc.y, "刷新目标场次格");
    sleep(1300);
    log("  🔄 已重戳目标场次格（没有找到跳板）");
    return true;
}
// ★ 仅演练用：把「未开始」也当成「可抢」（定义见文件顶部 FORCE_READY）
function classifyButton(txt) {
    var s = String(txt || "");
    if (!s) return "unknown";
    if (/正在抢|领取中|抢购中|加载中|处理中|排队|请稍候|努力抢|正在领取/.test(s)) return "processing";
    if (/已抢完|已领完|无库存|已错过|已结束|已抢光|明天再来|已领/.test(s)) return "dead";
    if (/立即抢|马上抢|立即领取|点击领取|去抢|^抢$/.test(s)) return "ready";
    if (FORCE_READY && FIRE_PHASE) return "ready";   // 演练专用
    return "notstart";
}

// ==================================================================================
// 7.5 点前确认（2026-10-17 18:03 用户要求：每次点击之前必须确认"这个按钮真的能点"）
//
// 【为什么必须有】18:00 那场我写错了变量作用域，导致 0 次点击、整场白扔。
// 从那之后规则改为：**任何一次打向券按钮的点击，出手前都要过三道闸**，
// 任一不过就不点，宁愿少点一次也不要打空枪。
//   ① 按钮文案必须是"可抢"（立即抢/马上抢/去抢…），不是"未开始/已抢完"
//   ② 当前前台必须真的是 me.ele —— 否则点击会落在 AutoX 自己的界面或弹窗上
//      （17:11 踩过：弹窗挂最上层，5 个入口全点在弹窗上）
//   ③ 读到的那个节点的 bounds 必须真的覆盖盲点坐标 (899,849) ——
//      防止 WebView 重绘的瞬间读到"别的场次"的按钮，点了个寂寞
// ==================================================================================
function preClickCheck(txt, st, allowNotStarted) {
    // 连点只在开抢前做一次几何预检，允许此时仍显示目标 HH:MM 开抢。
    if (st !== "ready" && !(allowNotStarted && st === "notstart")) return { ok: false, why: "状态不是可抢（" + st + "）" };

    var pkg = "";
    try { pkg = currentPackage() || ""; } catch (e) {}
    if (pkg !== CFG.app.package) {
        return { ok: false, why: "前台是「" + pkg + "」不是 " + CFG.app.package + "，点击会打到别处" };
    }

    var z = CFG.target.zone, c = CFG.blindTap.coord;
    if (!z || !c) return { ok: true, txt: txt };
    var n = null;
    try { n = textMatches(".+").boundsInside(z.left, z.top, z.right, z.bottom).findOnce(); } catch (e) { n = null; }
    if (!n) return { ok: false, why: "按钮区读不到任何节点" };
    var b = null;
    try { b = n.bounds(); } catch (e) { b = null; }
    if (!b) return { ok: false, why: "节点拿不到 bounds" };
    if (!(b.left <= c[0] && c[0] <= b.right && b.top <= c[1] && c[1] <= b.bottom)) {
        return { ok: false, why: "节点[" + b.left + "," + b.top + "][" + b.right + "," + b.bottom + "] 不覆盖盲点(" + c[0] + "," + c[1] + ")" };
    }
    var t2 = "";
    try { t2 = n.text() || ""; } catch (e) {}
    var checkedState = classifyButton(t2);
    if (checkedState !== "ready" && !(allowNotStarted && checkedState === "notstart")) {
        return { ok: false, why: "节点文案复核不是可抢态「" + t2 + "」" };
    }
    return { ok: true, txt: t2 };
}



// ==================================================================================
// 8. 判定
// ==================================================================================

function summarizePageEvidence(feedback, finalText) {
    var out = {status:"unconfirmed", hints:[], processingObserved:false, returnedToReady:false,
        finalButtonText:finalText || "", serviceErrorCode:null, causeConfirmed:false};
    var seenProcessing = false, samples = feedback && feedback.samples || [];
    for (var i=0; i<samples.length; i++) {
        var state = classifyButton(samples[i].text);
        if (state === "processing") { seenProcessing=true; out.processingObserved=true; }
        if (seenProcessing && state === "ready") out.returnedToReady=true;
    }
    if (seenProcessing && classifyButton(finalText) === "ready") out.returnedToReady=true;
    var messages = feedback && feedback.messages || [], rejected=false, notStarted=false;
    for (var j=0; j<messages.length; j++) {
        var message=String(messages[j].text || ""), kind="";
        if (/未开始|未开抢|太早/.test(message)) { kind="not_started"; notStarted=true; }
        else if (/太频繁/.test(message)) { kind="frequency_hint"; rejected=true; }
        else if (/火爆|活动热|挤爆|繁忙/.test(message)) { kind="busy_or_restricted"; rejected=true; }
        else if (/不符合|不满足|未认证|认证失败|请先.*认证|无.*资格|暂无.*资格|资格.*异常/.test(message)) { kind="eligibility_hint"; rejected=true; }
        else if (/重新登录/.test(message)) { kind="login_hint"; rejected=true; }
        else if (/来晚|抢完|已结束/.test(message)) { kind="ended_or_sold_out"; rejected=true; }
        else if (/领取失败/.test(message)) { kind="failure_hint"; rejected=true; }
        if (kind) out.hints.push({kind:kind, text:message, at:messages[j].at, offsetMs:messages[j].offsetMs});
    }
    if (rejected) out.status="rejection_observed";
    else if (out.processingObserved) out.status="processing_observed";
    else if (notStarted) out.status="not_started_observed";
    return out;
}

function judge(preVerdict) {
    sleep(2600);
    var s = shot("after_fire");
    var hits = ["恭喜", "抢到", "抢中", "领取成功", "已放入", "已到账", "已领取"];
    var biz = "";
    for (var i = 0; preVerdict !== "not_in_page" && i < hits.length; i++) {
        try { if (textContains(hits[i]).exists()) { biz = hits[i]; break; } } catch (e) {}
    }
    var verdict;
    // 只统计"真正打向抢券按钮"的点击。锁场次、切跳板、关弹窗这些操作点击不能算作出手，
    // 否则"一次都没打出去"却会被判成 fired_no_confirm（2026-10-17 14:52 测试就出现了这种误报）。
    var nFire = 0;
    for (var ci = 0; ci < CLICKS.length; ci++) { if (CLICKS[ci].kind === "fire") nFire++; }

    if (preVerdict === "not_in_page") verdict = "not_in_page";
    else if (biz) verdict = "success";
    else if (preVerdict === "lost_page") verdict = "lost_page";
    else if (preVerdict === "wrong_session") verdict = "wrong_session";
    else if (preVerdict === "precheck_failed") verdict = "precheck_failed";
    else if (preVerdict === "gesture_failed") verdict = "gesture_failed";
    else if (!nFire) verdict = "no_click";
    else verdict = "fired_no_confirm";

    var result = {
        build: BUILD_ID,
        session: CURRENT_SESSION,
        generatedAt: new Date(now()).toISOString(),
        device: device.brand + " " + device.model + " / Android " + device.release,
        clicks: CLICKS,
        fireCount: nFire,
        gestureAccepted: CLICKS.filter(function (c) { return c.kind === "fire" && c.ok; }).length,
        timeSync: TIME_SYNC_INFO,
        uiFeedback: FIRE_FEEDBACK,
        pageEvidence: summarizePageEvidence(FIRE_FEEDBACK, preVerdict === "not_in_page" ? "" : readButtonTextFast()),
        entryFailure: preVerdict === "not_in_page" ? LAST_ENTRY_FAILURE : null,
        verdict: verdict,
        bizText: biz,
        shot: s,
        logTail: LOG_BUF.slice(-30)
    };
    var archiveTs=now(), sessionTs=CURRENT_SESSION && CURRENT_SESSION.target || archiveTs;
    result.archivePath=files.join(RESULT_HISTORY_DIR, dayStr(sessionTs)+"_"+hhmmOf(sessionTs).replace(":","")+"_"+Math.round(archiveTs)+".json");
    result.archiveSaved=false;
    try {
        files.ensureDir(RESULT_HISTORY_DIR+"/");
        result.archiveSaved=true;
        files.write(result.archivePath, JSON.stringify(result,null,2));
    } catch (ae) { result.archiveSaved=false; result.archiveError=String(ae); log("独立归档失败："+ae); }
    try { files.write(RESULT_PATH, JSON.stringify(result, null, 2)); } catch (e) { log("写结果失败：" + e); }
    log("页面证据："+result.pageEvidence.status+"，提示="+JSON.stringify(result.pageEvidence.hints)+"；实际服务端返回码尚未取得");
    return result;
}

function notify(title, msg) {
    log("【结果】" + title + " — " + msg);
    if (CFG.notify.toast) { try { toast(title + "\n" + msg); } catch (e) {} }
    if (CFG.notify.vibrate) { try { device.vibrate(600); } catch (e) {} }
    if (CFG.notify.webhook) {
        try { http.postJson(CFG.notify.webhook, { msgtype: "text", text: { content: title + " " + msg } }, { timeout: 5000 }); }
        catch (e) { log("webhook 失败：" + e); }
    }
}

// ==================================================================================
// 9. 跑一场 / 常驻
// ==================================================================================

function runSession(s) {
    CLICKS = [];
    FIRE_FEEDBACK = null;
    CURRENT_SESSION = {label:s.label, target:s.ts};
    LAST_ENTRY_FAILURE = null;
    log("──── 场次 " + s.label + "（" + Math.round((s.ts - now()) / 1000) + " 秒后）────");
    keepAlive();

    var enterAt = s.ts - CFG.timing.enterBeforeMs;
    if (enterAt > now()) {
        log("先静默守候 " + Math.round((enterAt - now()) / 1000) + " 秒，到开抢前 " + Math.round(CFG.timing.enterBeforeMs / 60000) + " 分钟再摆页面");
        sleepUntil(enterAt - 1500);
    }
    if (STOP) return null;

    keepAlive();
    // 每场进场前重新取样，网络操作远离最后出手窗口。
    if (s.ts - now() > 60000) syncTime();
    if (!inActivityPage()) { bringUpApp(); }
    if (!ensureActivityPage(25)) {
        captureEntryFailure("not_in_activity_page");
        var failed=judge("not_in_page");flushLog();return failed;
    }

    var v = doFire(s.ts, s.label);
    var r = judge(v);
    if (r.verdict === "success") notify("✅ 抢到了", s.label + " 场 · " + (r.bizText || "页面已出中奖提示"));
    else log("本场判定 " + r.verdict + "（按规则不打扰）");
    flushLog();
    return r;
}

function daemonLoop() {
    STOP = false;
    HEARTBEAT_ON = true;
    log("======== 常驻守候启动 [" + BUILD_ID + "] ========");
    syncTime();

    // ★ 启动时就把活动页摆好，然后**全程保持在前台**，不再反复进出。
    //
    // 为什么改回来（2026-10-17 的血泪教训）：
    //   昨晚我把这里改成"每场出手前 5 分钟才摆页面"，理由是怕 WebView 挂太久失效。
    //   结果今早首页「学生福利」入口坐标变了（顶部多了「闪购会员日」banner，
    //   图标行整体下移 282px），每次摆都点进商家页 →
    //   08:00 / 10:00 / 11:00 三场全部"未进入活动页，本轮放弃"，一次都没出手。
    //
    //   教训：**入口用得越少越好**。宁可页面挂一整天（场次错位有 lockTargetSession 兜底），
    //   也不要每一场都去赌那个不稳定的入口坐标。
    log("把活动页摆到前台，之后全程保持…");
    // ⚠️ 2026-10-17 14:43 实测新增：这里原来先 home() 再 bringUpApp()，
    // 等于把 App 踢回桌面再"从桌面冷启动"，会触发「天降红包」全屏运营弹窗。
    // 那个弹窗整层是图片/H5：无障碍读不到任何节点、没有 desc="关闭"、back 键关不掉，
    // 只能盲点 (536,1895) 才能关。它会把首页和入口整个挡住，
    // 于是 tapHomeEntry 的每一个候选坐标其实都点在弹窗上 —— 必然全部失败。
    // 改为：App 在后台就直接 bringToFront（不触发弹窗）；只有进程真没了才走冷启动 + 清障。
    bringUpApp();
    if (inActivityPage()) {
        log("✅ 活动页已就位，全程保持在前台（每场只切换场次，不再重新进入）");
        try { toast("守候已启动：活动页已就位"); } catch (e) {}
    } else {
        log("⚠️ 启动时没能进活动页 —— 每场出手前 5 分钟还会再试，但建议手动确认一次");
        try { toast("没能自动进活动页，请手动打开活动页"); } catch (e) {}
    }

    while (!STOP) {
        writeHeartbeat();
        var s = nextSession();
        if (!s) {
            var t = tomorrowAt(7, 0);
            log("今日场次已结束，休眠到明天 07:00（" + Math.round((t - now()) / 3600000) + " 小时后）");
            sleepUntil(t);
            syncTime();
            continue;
        }
        var d = s.ts - now();
        if (d <= CFG.timing.prestageMs) {
            try { runSession(s); } catch (e) { log("❌ 本场异常：" + e + "\n" + (e.stack || "")); flushLog(); }
        } else {
            var wake = Math.min(s.ts - CFG.timing.prestageMs, now() + 600000);
            setStatus("下一场 " + s.label + " · 还有 " + Math.round(d / 60000) + " 分钟");
            sleepUntil(wake);
        }
    }
    HEARTBEAT_ON = false;
    log("已停止。");
}

function writeHeartbeat() {
    try { files.write(HEART_PATH, String(now())); } catch (e) {}
}

function startDaemonWorker() {
    var main=String(engines.myEngine().source);
    // 不含 ui 模式或界面布局，执行器由 AutoX 独立脚本服务持有。
    var worker="var mainPath="+JSON.stringify(main)+";\n"+
        "eval(files.read(mainPath).split('var UI_'+'OK = true;')[0]);\n"+
        "HAS_UI=false;loadCfg();\n"+
        "if(anotherInstanceAlive())exit();\n"+
        "try{daemonLoop();}catch(e){log('守候异常：'+e+'\\n'+(e.stack||''));}finally{flushLog();}\n";
    files.write(DAEMON_PATH,worker);
    return engines.execScriptFile(DAEMON_PATH);
}

function anotherInstanceAlive() {
    try {
        var own=engines.myEngine().id, active=engines.all();
        for(var i=0;i<active.length;i++) {
            if(active[i].id !== own && String(active[i].source) === DAEMON_PATH) return true;
        }
        return false;
    } catch (engineError) {}
    try {
        if (!files.exists(HEART_PATH)) return false;
        var t = parseInt(files.read(HEART_PATH), 10);
        return (now() - t) < 90000;
    } catch (e) { return false; }
}

// ==================================================================================
// 10. UI
// ==================================================================================

var UI_OK = true;
try {
ui.layout(
    <scroll>
        <vertical padding="14">
            <text text="淘宝闪购 · 整点抢券" textSize="20sp" textStyle="bold" textColor="#0C447C"/>
            <text id="status" text="正在检查无障碍服务…" textSize="12sp" textColor="#5F5E5A" marginTop="4"/>
            <text id="cfgInfo" text="" textSize="12sp" textColor="#5F5E5A" marginTop="2"/>

            <button id="bCal" text="① 一键标定（先在 App 里打开活动页）" marginTop="12"/>
            <button id="bRun" text="② 启动守候（覆盖今天剩余场次）" marginTop="6"/>
            <button id="bTest" text="③ 立即测试一次（2 分钟后出手）" marginTop="6"/>
            <button id="bNodes" text="查看当前页面控件（诊断）" marginTop="6"/>
            <button id="bResult" text="查看上次结果" marginTop="6"/>
            <button id="bStop" text="停止" marginTop="6" textColor="#A32D2D"/>

            <text text="运行日志" textSize="13sp" textStyle="bold" marginTop="14"/>
            <text id="logView" text="" textSize="11sp" textColor="#2C2C2A" typeface="monospace"/>
        </vertical>
    </scroll>
);
} catch (e) {
    UI_OK = false;
    HAS_UI = false;
    console.warn("界面创建失败，转入无界面模式：" + e);
}

function refreshCfgInfo() {
    var bt = CFG.blindTap;
    var txt = "场次 " + CFG.sessions.join("/") + " ｜ 盲点" + ((bt && bt.enabled) ? "已开(" + bt.coord[0] + "," + bt.coord[1] + ")" : "未标定");
    if (!HAS_UI) { console.log(txt); return; }
    try { ui.run(function () { ui.cfgInfo.setText(txt); }); } catch (e) {}
}

// ==================================================================================
// 11. 动作
// ==================================================================================

function actCalibrate() {
    ensureAuto();
    var go = dialogs.confirm("准备标定",
        "1) 请先切到「淘宝闪购 / 饿了么」App，手动进入『开学季限时抢』那个活动页\n" +
        "2) 让那一屏完整显示出来（能看到 18 元券和各个场次时间）\n" +
        "3) 回来后点『确定』，我会自动扫一遍这个页面");
    if (!go) return;
    sleep(1200);

    if (!inActivityPage()) {
        var c = dialogs.confirm("好像不在活动页", "当前页面没看到活动页的特征文字。\n\n确定要强行继续扫描吗？");
        if (!c) return;
    }

    var list = candidates();
    if (!list.length) {
        dialogs.alert("没扫到任何候选控件",
            "当前页面上没有含『抢 / 券 / 满18 / 限时』这类文字的控件。\n\n" +
            "请检查：\n" +
            "1) 无障碍服务是否已开启（本界面顶部状态栏会显示）\n" +
            "2) 是否真的停在了活动页，而不是 App 首页\n" +
            "3) 页面是否还在加载中（多等几秒再试）");
        return;
    }

    var labels = [];
    for (var i = 0; i < list.length; i++) labels.push(describeNode(list[i]));
    var idx = dialogs.select("请点选『你要抢的那一场』的按钮", labels);
    if (idx < 0) { log("标定取消"); return; }

    var chosen = list[idx];
    var c = nodeCenter(chosen);
    var t = "";
    try { t = chosen.text() || chosen.desc() || ""; } catch (e) {}

    if (!c) { dialogs.alert("取不到坐标", "这个控件读不到位置信息，换一个再试。"); return; }

    // 目标坐标
    CFG.blindTap.coord = [c.x, c.y];
    CFG.blindTap.enabled = true;
    CFG.blindTap.anchorText = t;

    // 把该控件当前文字（通常是「未开抢」）以及页面上其它否定态文字，全部并入负向词表
    var negs = CFG.target.negativeText.slice();
    function addNeg(w) {
        w = String(w || "").trim();
        if (!w || w.length > 8) return;
        if (negs.indexOf(w) < 0) negs.push(w);
    }
    addNeg(t);
    var all = candidates();
    for (var j = 0; j < all.length; j++) {
        var s = "";
        try { s = all[j].text() || ""; } catch (e) { s = ""; }
        if (/未开抢|已抢完|已错过|已领|抢光|已结束|活动结束|来晚|即将开始/.test(s)) addNeg(s);
    }
    CFG.target.negativeText = negs;

    saveCfg();
    refreshCfgInfo();
    log("标定完成：坐标 (" + c.x + "," + c.y + ")，锚点文字「" + t + "」，负向词 " + negs.length + " 个");
    shot("calibrated");

    dialogs.alert("标定完成",
        "目标坐标：(" + c.x + "," + c.y + ")\n" +
        "锚点文字：" + (t || "(空)") + "\n" +
        "负向词表：" + negs.length + " 个\n\n" +
        "下一步：回到活动页把页面停好，然后点『② 启动守候』。\n" +
        "（配置已存到 " + CFG_PATH + "）");
}

// 真正跑一次「假场次」的完整链路。leadMs = 距\"整点\"多久，测试用 60~120 秒。
// 抽成独立函数，是为了让「点界面按钮」和「写标记文件」两条入口走同一段代码。
function startTestSession(leadMs) {
    ensureAuto();
    leadMs = (typeof leadMs === "number" && leadMs > 5000) ? leadMs : 120000;
    BUSY = true;
    threads.start(function () {
        var oldLock = CFG.timing.lockBeforeMs;
        var oldForce = FORCE_READY;
        try {
            syncTime();
            // 演练专用：锁场次前置量压到 lead 的 1/3，好在窗口内走完全链路。
            // 真实场次仍用 config 里的 lockBeforeMs（默认 180000）。
            CFG.timing.lockBeforeMs = Math.max(20000, Math.round(leadMs / 3));

            // ★ 演练专用：把「未开始」也当成可抢，否则一次都不会点、验证不到点击通路。
            // 只在内存里打开，不写盘，真实场次不受影响。
            FORCE_READY = true;
            log("⚠️ 演练模式：临时把「未开始」也视为可抢，用于验证点击通路（未开始状态点击无害，不写盘）");

            var fake = { label: "TEST(" + Math.round(leadMs / 1000) + "s)", ts: now() + leadMs };
            runSession(fake);
        } catch (e) {
            log("测试异常：" + e + "\n" + (e.stack || ""));
        }
        CFG.timing.lockBeforeMs = oldLock;
        FORCE_READY = oldForce;
        BUSY = false;
        setStatus("测试结束");
        flushLog();
    });
}

// 锁定自测：人为把场次切错（点场次条上别的时刻格），再让 lockTargetSession 去救。
// 用来复现 2026-10-18 10:00/11:00 的失败场景，不必干等下一场。
function runLockTest() {
    ensureAuto();
    BUSY = true;
    threads.start(function () {
        try {
            syncTime();
            var s = nextSession();
            if (!s) { log("锁定自测：今天已无下一场"); return; }
            // 自测是通过重启脚本触发的，此刻前台是 AutoX 自己的界面 —— 必须先把 App 摆回来
            if (!inActivityPage() || currentPackage() !== CFG.app.package) {
                log("  当前不在活动页（前台=" + currentPackage() + "），先摆页面");
                bringUpApp();
                if (!ensureActivityPage(25)) { log("❌ 摆页面失败，自测终止"); BUSY = false; flushLog(); return; }
            }
            var hh = hhmmOf(s.ts);
            log("=== 锁定自测：目标 " + s.label + "（" + Math.round((s.ts - now()) / 1000) + " 秒后）===");
            log("  当前按钮[" + readButtonText() + "]");

            // 人为切错场次
            var z = CFG.target.zone;
            var top = z ? Math.max(0, z.top - 320) : 480;
            var bottom = z ? z.top : 760;
            var SW = device.width || 1080;
            var others = null;
            try { others = textMatches("\\d{1,2}:\\d{2}").boundsInside(0, top, SW, bottom).find(); } catch (e) { others = null; }
            var picked = null;
            if (others) {
                for (var i = 0; i < others.length; i++) {
                    var tx = "";
                    try { tx = others[i].text() || ""; } catch (e) {}
                    if (!tx || tx === hh) continue;
                    var c = nodeCenter(others[i]);
                    if (c && c.x > 40 && c.x < SW - 40) { picked = { c: c, t: tx }; break; }
                }
            }
            if (picked) {
                log("  制造错场：点场次条「" + picked.t + "」@(" + picked.c.x + "," + picked.c.y + ")");
                tapAt(picked.c.x, picked.c.y, "错场(自测)");
                sleep(2500);
                log("  错场后按钮[" + readButtonText() + "]");
            } else {
                log("  ⚠️ 没找到可用的错场格，直接验证锁定");
            }

            // 自测时目标可能在 1 小时后，正常流程不会在这么早锁场次，
            // 所以临时放开时间窗口，只验证"点格 → 复核 → 恢复"这条路能不能走通
            FORCE_SELECT_ANY = true;
            var ok = lockTargetSession(s.ts);
            FORCE_SELECT_ANY = false;
            log("=== 锁定自测结果：" + (ok ? "✅ 通过" : "❌ 失败") + "，最终按钮[" + readButtonText() + "] ===");
        } catch (e) {
            log("锁定自测异常：" + e + "\n" + (e.stack || ""));
        }
        BUSY = false;
        flushLog();
    });
}

function actTest() {
    var ok = dialogs.confirm("立即测试一次",
        "会在 2 分钟后走一次完整的『摆页面 → 锁场次 → 确认页面 → 哨兵 → 出手 → 判定』流程。\n\n" +
        "建议先把活动页打开、页面停在那一屏，方便观察。\n" +
        "（按钮处于「未开始」状态时脚本一次都不会点，这是设计如此，不是没跑。）");
    if (!ok) return;
    startTestSession(120000);
}

function actRun(silent) {
    ensureAuto();
    if (WORKER_DISPATCHED && !anotherInstanceAlive()) { BUSY=false;WORKER_DISPATCHED=false; }
    if (BUSY) { if (!silent) dialogs.alert("已经在跑了", "先点『停止』再重新启动。"); return; }
    if (anotherInstanceAlive()) {
        log("已有独立守候实例在跑，本次不重复启动");
        if (!silent) dialogs.alert("已有实例在跑", "检测到已有独立守候实例。\n\n不用重复启动，避免两个实例操作同一部手机。");
        return;
    }
    // 今天还有场次 → 正常提示；今天已经打完也**不要退出** ——
    // daemonLoop 里对 nextSession()===null 的处理是「休眠到明天 07:00 再继续」，
    // 所以晚上启动照样能覆盖明天的首场（08:00）。
    var s = nextSession();
    if (!silent) {
        var when = s
            ? "下一场：" + s.label + "（" + Math.round((s.ts - now()) / 60000) + " 分钟后）"
            : "今天场次已结束，将自动守候到明天第一场（" + CFG.sessions[0] + "）";
        var ok = dialogs.confirm("启动守候",
            "将从现在开始，自动覆盖后续每一个场次。\n\n" + when + "\n\n" +
            "启动后请不要清理后台、不要点『一键清理』；\n" +
            "手机建议插电并保持屏幕常亮。");
        if (!ok) return;
    }

    // 记住"开机/定时拉起时要自动恢复守候"，这样手机重启后也能自愈
    try { files.write(AUTOSTART_FLAG, String(now())); } catch (e) {}

    BUSY = true;
    if (HAS_UI) {
        try {
            startDaemonWorker();
            WORKER_DISPATCHED=true;
            setStatus("独立守候已启动，可关闭控制界面");
            if (silent) { try { ui.finish(); } catch (finishError) {} }
        } catch (workerError) { BUSY=false;log("独立守候启动失败："+workerError); }
        return;
    }
    threads.start(function () {
        try { daemonLoop(); } catch (e) { log("❌ 守候异常：" + e + "\n" + (e.stack || "")); }
        BUSY = false;
        setStatus("已停止");
    });
    setStatus("守候中…");
}

function actNodes() {
    ensureAuto();
    var list = candidates();
    if (!list.length) { dialogs.alert("没扫到控件", "当前页面上没有候选控件。确认无障碍已开启、并且停在活动页。"); return; }
    var lines = [];
    for (var i = 0; i < list.length && i < 25; i++) {
        var cls = "";
        try { cls = list[i].className() || ""; } catch (e) {}
        lines.push(describeNode(list[i]) + "\n    class=" + cls);
    }
    dialogs.alert("当前页面控件（" + list.length + " 个，显示前 25）", lines.join("\n\n"));
}

function actResult() {
    try {
        if (!files.exists(RESULT_PATH)) { dialogs.alert("还没有结果", "跑过一次之后才会有 " + RESULT_PATH); return; }
        var r = JSON.parse(files.read(RESULT_PATH));
        var msg = "时间：" + r.generatedAt + "\n" +
            "判定：" + r.verdict + "\n" +
            "业务提示：" + (r.bizText || "(无)") + "\n" +
            "出手点击：" + (r.fireCount !== undefined ? r.fireCount : "?") + " 次（含操作点击共 " + (r.clicks ? r.clicks.length : 0) + "）\n";
        if (r.clicks && r.clicks.length) {
            for (var i = 0; i < r.clicks.length; i++) {
                msg += "  · (" + r.clicks[i].x + "," + r.clicks[i].y + ") " + r.clicks[i].why + " " + fmtTime(r.clicks[i].at) + "\n";
            }
        }
        msg += "截图：" + (r.shot || "(无)");
        dialogs.alert("上次结果", msg);
    } catch (e) {
        dialogs.alert("读结果失败", String(e));
    }
}

function actStop() {
    STOP = true;
    WORKER_DISPATCHED = false;
    try {
        var active=engines.all(), own=engines.myEngine().id;
        for(var i=0;i<active.length;i++) {
            if(active[i].id !== own && String(active[i].source) === DAEMON_PATH) active[i].forceStop();
        }
    } catch (workerStopError) { log("停止独立守候失败："+workerStopError); }
    BUSY = false;
    try { if (files.exists(HEART_PATH)) files.remove(HEART_PATH); } catch (e) {}
    try { if (files.exists(AUTOSTART_FLAG)) files.remove(AUTOSTART_FLAG); } catch (e) {}
    log("已请求停止（已取消自动恢复）");
    setStatus("已停止");
}

function bindUI(id, fn, errTitle) {
    if (!UI_OK) return;
    try {
        ui[id].on("click", function () {
            threads.start(function () {
                try { fn(); } catch (e) { log("❌ " + errTitle + "：" + e); if (UI_OK) dialogs.alert(errTitle, String(e)); }
            });
        });
    } catch (e) { log("绑定按钮 " + id + " 失败：" + e); }
}

bindUI("bCal", actCalibrate, "标定出错");
bindUI("bRun", function () { actRun(false); }, "启动出错");
bindUI("bTest", actTest, "测试出错");
bindUI("bNodes", actNodes, "诊断出错");
bindUI("bResult", actResult, "读取出错");
if (UI_OK) { try { ui.bStop.on("click", function () { actStop(); }); } catch (e) {} }

// 无界面模式（定时任务拉起）下要有地方看日志
if (!UI_OK) { try { console.show(); } catch (e) {} }

// 是否自动进入守候：
//  ① 定时任务用 engines.execScriptFile(path, {arguments:["auto"]}) 拉起
//  ② 或脚本目录里存在 autostart.flag（用户点过『启动守候』就会生成，点『停止』会删掉）
var AUTO_START = false;
try {
    var argv = engines.myEngine().execArgv;
    if (argv && argv.length && String(argv[0]) === "auto") AUTO_START = true;
} catch (e) {}
try { if (files.exists(AUTOSTART_FLAG)) AUTO_START = true; } catch (e) {}

// ==================================================================================
// 12. 启动
// ==================================================================================

loadCfg();
refreshCfgInfo();

threads.start(function () {
    var ok = false;
    try { auto.waitFor(); ok = !!auto.service; } catch (e) { try { auto(); ok = !!auto.service; } catch (e2) {} }
    if (!ok) {
        setStatus("❌ 无障碍服务未开启 —— 去 系统设置 → 辅助功能 → 无障碍 → 打开 AutoX.js");
        log("无障碍服务未开启，所有点击功能不可用");
        return;
    }
    setStatus("✅ 无障碍已就绪 ｜ 还没启动守候");
    log("无障碍服务已就绪");

    // ★ 锁定自测优先：存在 locktest.flag 就跑一次「切错场 → 自动救回」诊断
    var lockTest = false;
    try {
        if (files.exists(LOCKTEST_FLAG)) {
            lockTest = true;
            try { files.remove(LOCKTEST_FLAG); } catch (e2) {}
        }
    } catch (e) {}
    if (lockTest) {
        log("检测到锁定自测标记，开始验证场次锁定的自愈能力");
        runLockTest();
        return;
    }

    // ★ 测试标记优先于守候：有 test.flag 就跑一次假场次，跑完自动删。
    //   这样测试可完全由 adb 触发（写文件 + 重启脚本），不碰屏幕、不点按钮、不出弹窗。
    var testLead = 0;
    try {
        if (files.exists(TEST_FLAG)) {
            var raw = "";
            try { raw = String(files.read(TEST_FLAG) || "").replace(/[^0-9]/g, ""); } catch (e2) {}
            testLead = raw ? parseInt(raw, 10) * 1000 : 90000;
            try { files.remove(TEST_FLAG); } catch (e2) {}
        }
    } catch (e) {}

    if (testLead > 0) {
        log("检测到测试标记：将在 " + Math.round(testLead / 1000) + " 秒后走一次完整演练（假场次，不占真实整点）");
        startTestSession(testLead);
        return;
    }

    if (AUTO_START) {
        log("检测到自动启动标记（定时任务或上次未停止），尝试直接进入守候");
        if (anotherInstanceAlive()) { setStatus("独立守候正在运行，可在此停止");log("已有独立守候实例在跑，本次不重复启动"); return; }
        actRun(true);
    }
});

try { ui.emitter.on("pause", function () { flushLog(); }); } catch (e) {}
try { ui.emitter.on("destroy", function () { flushLog(); }); } catch (e) {}
