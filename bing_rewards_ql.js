#!/usr/bin/env node
/**
 * name: 必应积分-新版
 * cron: 17 9,15 * * *
 */
// 新版 rewards.bing.com 是服务端渲染的 Next.js 应用，数据不在旧接口里，
// 而是随 /dashboard?_rsc= 这一次请求整体返回（RSC 飞行数据）。
// 搜索分：搜索结果页自己会发 ncheader + reportActivity 两个 POST，
// 服务端按页面里那枚 IG 这次搜索记分；脚本照抄这一对就能记上（10-31 实测 +3/条）。
// 每跑完一次推一条 PushPlus 微信通知（token 见 PUSHPLUS_DEFAULT_TOKEN，可用 PUSHPLUSTOKEN 覆盖）。
// 默认没涨分就不推（BING_REWARDS_PUSH_ONLY_GAIN=0 可改回每拍都推）。
'use strict';

const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.3.0';
const DASHBOARD = 'https://rewards.bing.com/dashboard';
const REWARDS_HOME = 'https://rewards.bing.com/';
const BING = 'https://www.bing.com';

const UA = {
    pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    mobile: 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.132 Mobile Safari/537.36',
    app: 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560'
};

// App 侧（签到 / 阅读）走的是 rewardsplattform 的 dapi，要 OAuth 令牌，网页 cookie 打不进去
const CLIENT_ID = '0000000040170455';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const REWARDS_SCOPE = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const DAPI = 'https://prod.rewardsplatform.microsoft.com/dapi';
const APP_ID = 'SAAndroid/32.6.2110003560';
const AUTHORIZE_HINT = 'https://login.live.com/oauth20_authorize.srf?client_id=' + CLIENT_ID
    + '&scope=' + encodeURIComponent(REWARDS_SCOPE)
    + '&response_type=code&redirect_uri=' + encodeURIComponent(REDIRECT_URI);
// 换到的令牌存在脚本目录，下次自动读；这样不必再往环境变量里贴长串
const TOKEN_FILE = path.join(__dirname, '.bing_rewards_token');

const PARTNER_LABEL = {
    bing: '必应搜索',
    bingapp: '必应 App',
    dailyset: '每日活动',
    edge: 'Edge 浏览',
    msn: 'MSN 文章',
    outlook: 'Outlook',
    visualsearch: '视觉搜索'
};

const FALLBACK_QUERIES = [
    '今天天气怎么样', '附近有什么好吃的', '笔记本电脑怎么选', '一寸照片尺寸',
    '高铁票改签规则', '空气炸锅食谱', '怎么快速入睡', '空调一晚上几度电',
    '显示器分辨率怎么看', '番茄炒蛋的做法', '地铁末班车时间', '体检项目有哪些',
    '手机电池怎么保养', '旧书怎么处理', '自驾游路线推荐', '冬季感冒预防',
    '怎么挑选咖啡豆', '净水器滤芯多久换', '居家健身动作', '洗衣机要不要拆洗',
    '基金定投是什么', '个人所得税怎么算', '考研和就业怎么选', '英语听力怎么练',
    '二手房交易流程', '养猫要注意什么', '绿萝叶子发黄', '打印机连不上电脑',
    '快递丢件怎么处理', '自行车链条保养', '露营装备清单', '颈椎不舒服怎么办',
    '工资条怎么看', '路由器信号差', '保温杯材质区别', '干洗和机洗的区别',
    '摩托车头盔标准', '近视手术安全吗', '电池回收去哪', '面包机怎么发面'
];

function log(tag, msg) {
    console.log('[' + tag + '] ' + msg);
}

function env(name, fallback) {
    const v = process.env[name];
    return (v === undefined || v === '') ? fallback : v;
}

function envInt(name, fallback, min, max) {
    const n = Number(env(name, fallback));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

// 兼容老脚本的变量名，他之前配过就不用再建一套
function envIntAny(names, fallback, min, max) {
    for (const n of names) {
        if (process.env[n] !== undefined && process.env[n] !== '') return envInt(n, fallback, min, max);
    }
    return fallback;
}

function envBool(name, fallback) {
    const v = String(env(name, fallback)).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v);
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

// ---------------------------------------------------------------- 通知

// PushPlus 微信推送。token 默认用脚本里这份；青龙里建 PUSHPLUSTOKEN 可以覆盖，
// 填 0 / off 就关掉通知（哪天不想收不用删代码）。
const PUSHPLUS_DEFAULT_TOKEN = '491b3fab7acd4f3fb158847c3a55222b';

function pushplusToken() {
    const v = env('PUSHPLUSTOKEN', '') || env('PUSHPLUS_TOKEN', '') || env('PUSH_PLUS_TOKEN', '');
    const t = String(v || PUSHPLUS_DEFAULT_TOKEN).trim();
    return /^(0|off|false|no)$/i.test(t) ? '' : t;
}

// 手机上的时区设置不可靠，直接用 UTC+8 算北京时刻
function beijingStamp(ms) {
    return new Date(ms + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
}

function money(v) {
    return Number.isFinite(v) ? String(v) : '—';
}

// 这一拍值不值得推：默认「积分没变、也没失败项」就不推（第二拍基本都这样）。
// 读不到收尾余额时照推 —— 那种情况本身就要人看一眼。
function shouldSkipNotice(before, after, failures) {
    if (!envBool('BING_REWARDS_PUSH_ONLY_GAIN', true)) return false;
    if (failures.length) return false;
    if (!after || !Number.isFinite(before.balance) || !Number.isFinite(after.balance)) return false;
    return after.balance === before.balance;
}

async function pushNotify(title, content) {
    const token = pushplusToken();
    if (!token) {
        log('📣', '没有 PushPlus token，跳过通知');
        return null;
    }
    try {
        const res = await rawRequest('https://www.pushplus.plus/send', {
            method: 'POST',
            timeout: 15000,
            headers: {
                'content-type': 'application/json',
                'accept': 'application/json',
                'user-agent': UA.pc
            },
            body: JSON.stringify({
                token: token,
                title: title,
                content: content,
                template: 'markdown',
                channel: 'wechat'
            })
        });
        let j = null;
        try { j = JSON.parse(res.text); } catch (_) { }
        if (j && Number(j.code) === 200) {
            log('📣', '已推送到微信（PushPlus）：' + title);
        } else {
            log('🟡', '通知没发出去：HTTP ' + res.status
                + (j ? '，code ' + j.code + '，' + (j.msg || '') : '，回包不是 JSON'));
        }
        return j;
    } catch (e) {
        log('🟡', '通知失败：' + e.message);
        return null;
    }
}

// ---------------------------------------------------------------- cookie jar

// 身份 cookie：bing.com 也会往同名的里写值（或写空），一旦盖掉就变成未登录。
// 这份账号身份只认他填进来的，别被搜索响应改写。
const AUTH_COOKIES = new Set(['_U', '.MSA.Auth']);

class Jar {
    constructor(raw) {
        this.map = new Map();
        this.blocked = [];
        this.load(raw || '');
    }

    load(raw) {
        String(raw).split(';').forEach(function (part) {
            const s = part.trim();
            if (!s) return;
            const i = s.indexOf('=');
            if (i <= 0) return;
            this.map.set(s.slice(0, i).trim(), s.slice(i + 1).trim());
        }, this);
    }

    absorb(setCookie) {
        if (!setCookie) return;
        const list = Array.isArray(setCookie) ? setCookie : [setCookie];
        for (const line of list) {
            const first = String(line).split(';')[0];
            const i = first.indexOf('=');
            if (i <= 0) continue;
            const name = first.slice(0, i).trim();
            const value = first.slice(i + 1).trim();
            if (AUTH_COOKIES.has(name)) {
                if (this.map.get(name) !== value && this.blocked.indexOf(name) < 0) this.blocked.push(name);
                continue;
            }
            if (!value) continue; // 空值=服务端在删这个 cookie，别跟着删
            this.map.set(name, value);
        }
    }

    header(filter) {
        const out = [];
        this.map.forEach(function (v, k) {
            if (filter && !filter(k)) return;
            out.push(k + '=' + v);
        });
        return out.join('; ');
    }

    has(name) {
        return this.map.has(name);
    }
}

// ---------------------------------------------------------------- http

function decodeBody(buf, encoding) {
    const enc = String(encoding || '').toLowerCase();
    try {
        if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
        if (enc.includes('gzip')) return zlib.gunzipSync(buf);
        if (enc.includes('deflate')) return zlib.inflateSync(buf);
    } catch (_) {
        // 有些服务端会标错编码，落回原文
    }
    return buf;
}

function rawRequest(url, options) {
    const opts = options || {};
    return new Promise(function (resolve, reject) {
        const u = new URL(url);
        const mod = u.protocol === 'http:' ? require('http') : https;
        const req = mod.request({
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || undefined,
            path: u.pathname + u.search,
            method: opts.method || 'GET',
            headers: opts.headers || {}
        }, function (res) {
            const chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                const buf = decodeBody(Buffer.concat(chunks), res.headers['content-encoding']);
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    buf: buf,
                    text: buf.toString('utf8')
                });
            });
        });
        req.setTimeout(opts.timeout || 25000, function () {
            req.destroy(new Error('请求超时 ' + (opts.timeout || 25000) + 'ms'));
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

async function fetchUrl(jar, url, options) {
    const opts = options || {};
    const headers = Object.assign({
        'user-agent': UA.pc,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'accept-encoding': 'gzip, deflate, br',
        'connection': 'keep-alive'
    }, opts.headers || {});

    let current = url;
    for (let hop = 0; hop < 6; hop++) {
        let cookie = jar.header(opts.cookieFilter);
        if (opts.dropCookieHost && String(current).indexOf(opts.dropCookieHost) === -1) cookie = '';
        if (cookie) headers.cookie = cookie;

        const res = await rawRequest(current, {
            method: opts.method || 'GET',
            headers: headers,
            body: opts.body,
            timeout: opts.timeout
        });
        jar.absorb(res.headers['set-cookie']);

        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.status) && location && opts.follow !== false) {
            current = new URL(location, current).toString();
            continue;
        }
        res.url = current;
        return res;
    }
    throw new Error('重定向次数过多：' + url);
}

// ---------------------------------------------------------------- 解析 RSC

// 从 "xxx":[...] 里抠出配平的 JSON 数组；找不到返回 null
function extractArray(text, marker) {
    const at = text.indexOf(marker);
    if (at < 0) return null;
    const start = text.indexOf('[', at + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let p = start; p < text.length; p++) {
        const c = text[p];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '[') depth++;
        else if (c === ']') {
            depth--;
            if (depth === 0) return text.slice(start, p + 1);
        }
    }
    return null;
}

function parseDashboard(text) {
    const out = {
        balance: null,
        level: null,
        levelProgress: null,
        pointsPerSearch: null,
        claimable: null,
        dailySet: [],
        streaks: [],
        hasLoginWall: false
    };

    const bal = /"balance":(\d+)/.exec(text);
    if (bal) out.balance = Number(bal[1]);

    const lvl = /"level":(\d+)/.exec(text);
    if (lvl) out.level = Number(lvl[1]);

    const pps = /"pointsPerSearch":(\d+)/.exec(text);
    if (pps) out.pointsPerSearch = Number(pps[1]);

    const prog = /"pointsProgress":(\d+)/.exec(text);
    const remain = /"pointsRemaining":(\d+)/.exec(text);
    const need = /"pointsRequirement":(\d+)/.exec(text);
    const target = /"targetLevel":(\d+)/.exec(text);
    if (prog && need) {
        out.levelProgress = {
            progress: Number(prog[1]),
            remaining: remain ? Number(remain[1]) : Math.max(0, Number(need[1]) - Number(prog[1])),
            requirement: Number(need[1]),
            targetLevel: target ? Number(target[1]) : null
        };
    }

    // 新版积分要先「领取」才能兑换：pointClaim 为 null 表示没有待领取的
    if (/"pointClaim":null/.test(text)) out.claimable = 0;
    else {
        const c = /"pointClaim":\{[^}]{0,300}?"(?:amount|points)":(\d+)/.exec(text);
        if (c) out.claimable = Number(c[1]);
    }

    const arr = extractArray(text, '"dailySetItems":');
    if (arr) {
        try {
            const items = JSON.parse(arr);
            out.dailySet = items.map(function (it) {
                return {
                    offerId: it.offerId || '',
                    title: it.title || '',
                    points: Number(it.points || 0),
                    done: it.isCompleted === true,
                    url: it.destination || '',
                    // 原样留一份：判断「这张卡怎么才算做完」要看卡对象自己带了哪些字段
                    raw: it
                };
            });
        } catch (e) {
            log('🟡', '每日活动解析失败：' + e.message);
        }
    }

    // 打卡卡片：先按卡片组件名切段，每段里各字段都属于同一张卡。
    // 不能整页扫 isCurrentDayCompleted 再前视找 partner —— 卡片头部和卡片数据相距几千字符。
    const CARD = '"DashboardStreakSection_StreakCard"';
    const parts = text.split(CARD).slice(1);
    for (const part of parts) {
        const chunk = part;
        const done = /"isCurrentDayCompleted":(true|false)/.exec(chunk);
        const partner = /"partner":"([a-z]+)"/.exec(chunk);
        const days = /"totalDays":(\d+)/.exec(chunk);
        if (!partner) continue;
        const name = partner[1];
        out.streaks.push({
            partner: name,
            label: PARTNER_LABEL[name] || name,
            done: done ? done[1] === 'true' : false,
            totalDays: days ? Number(days[1]) : null
        });
    }

    if (out.balance === null) out.hasLoginWall = true;
    return out;
}

async function fetchDashboard(jar) {
    // _rsc 的值会被服务端抹掉再重定向一次；带空值加一个时间戳就既不重定向也不吃缓存
    let url = DASHBOARD + '?_rsc&_=' + Date.now();
    let res = null;
    for (let hop = 0; hop < 4; hop++) {
        res = await fetchUrl(jar, url, {
            headers: {
                'RSC': '1',
                'accept': '*/*',
                'referer': DASHBOARD,
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
            },
            follow: false
        });
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.status) && location) {
            const next = new URL(location, url);
            if (next.hostname !== 'rewards.bing.com') {
                throw new Error('登录态无效：被重定向到 ' + next.hostname + '（微软登录页）');
            }
            url = next.toString();
            continue;
        }
        break;
    }

    if (res.status !== 200) throw new Error('dashboard 返回 HTTP ' + res.status);

    const text = res.text;
    if (/"balance":\d+/.test(text)) return text;

    if (text.indexOf('HeaderProfile_Login') >= 0 || text.indexOf('"/auth/login"') >= 0) {
        throw new Error('登录态无效：返回的是未登录页面（cookie 过期，或只贴了半份）');
    }
    throw new Error('返回内容里没有余额字段（页面结构可能又改了，长度 ' + text.length + '）');
}

// ---------------------------------------------------------------- 动作

function pickQueries(count, usedSet) {
    if (!(count > 0)) return []; // 没这个 guard 时 count=0 也会塞出一条
    const pool = FALLBACK_QUERIES.slice();
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const out = [];
    for (const q of pool) {
        if (usedSet.has(q)) continue;
        out.push(q);
        usedSet.add(q);
        if (out.length >= count) break;
    }
    return out;
}

// 微软的登录令牌只属于 login.live.com，浏览器不会把它带到 www.bing.com；
// 我们照浏览器来，别把令牌泼到搜索域上。
function searchCookieFilter(name) {
    return name !== '.MSA.Auth';
}

// 每次搜索服务端都会发一个 IG（32 位大写 hex）并把这次搜索记在它名下；
// 上报时必须带同一枚 IG，服务端才认得出加给哪次搜索。
function igOf(html) {
    const m = /(?:^|[^0-9A-Za-z_])IG:"([0-9A-Fa-f]{32})"/.exec(String(html || ''));
    return m ? m[1].toUpperCase() : '';
}

// ---------------------------------------------------------------- 领取

// 网页上「待领取」的积分（月度奖励）要点一次「领取」才进余额。那个按钮背后是
// Next.js 的 Server Action：reportClaimAllPoints，不带参数，成功回 true。
// 它的 id 每发一次版就换，所以运行时从公开静态资源里现抠，抠到就缓存到脚本目录；
// 服务端回 400/409 + x-nextjs-action-not-found 就说明缓存过期，再抠一次。
const REWARDS_ORIGIN = 'https://rewards.bing.com';
const CLAIM_CACHE_FILE = path.join(__dirname, '.bing_rewards_claim');
const CLAIM_ACTION_NAME = 'reportClaimAllPoints';

function readClaimCache() {
    try {
        const d = JSON.parse(fs.readFileSync(CLAIM_CACHE_FILE, 'utf8'));
        if (d && typeof d.id === 'string' && /^[0-9a-f]{32,64}$/.test(d.id)) return d;
    } catch (_) { /* 没缓存过、或文件坏了，重抠就是 */ }
    return null;
}

function writeClaimCache(value) {
    try {
        if (!value) {
            if (fs.existsSync(CLAIM_CACHE_FILE)) fs.unlinkSync(CLAIM_CACHE_FILE);
            return;
        }
        fs.writeFileSync(CLAIM_CACHE_FILE, JSON.stringify(value));
    } catch (_) { /* 写不进去也不影响本次领取 */ }
}

// createServerReference("<id>", …, "<名字>")：取名字前面最近的那个十六进制串
function actionIdBefore(text, name) {
    let at = text.indexOf('"' + name + '"');
    if (at < 0) at = text.indexOf("'" + name + "'");
    if (at < 0) return '';
    const win = text.slice(Math.max(0, at - 400), at);
    const m = win.match(/["']([0-9a-f]{32,64})["']/g);
    return m ? m[m.length - 1].slice(1, -1) : '';
}

// 页面里两种写法都有：HTML 是 "/_next/static/chunks/x.js"，映射表里是 "static/chunks/x.js"
function chunkPathsIn(text) {
    const out = [];
    const re = /((?:\/_next)?\/?static\/chunks\/[A-Za-z0-9_.\-]+\.js)/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
        let p = m[1];
        if (p.indexOf('/_next/') !== 0) p = '/_next/' + p.replace(/^\/+/, '');
        if (out.indexOf(p) < 0) out.push(p);
    }
    return out;
}

async function fetchChunkText(chunkPath) {
    const res = await rawRequest(REWARDS_ORIGIN + chunkPath, {
        headers: {
            'user-agent': UA.pc,
            'accept': '*/*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
            'accept-encoding': 'gzip, deflate, br'
        },
        timeout: 30000
    });
    return res.status === 200 ? res.text : '';
}

// 不用登录：未登录首页是 307，但 body 就是整页 HTML 外壳，chunk 清单在里面；
// 领取面板是懒加载的，它的 chunk 名只出现在首页某个 chunk 的映射表里，所以要扫两轮。
async function findClaimActionId() {
    const cache = readClaimCache();
    let scanned = 0;

    async function scan(chunkPath) {
        scanned += 1;
        let text = '';
        // 手机流量下偶尔会有一个文件卡住；扫不到就跳过，别让它把整次领取带走
        try { text = await fetchChunkText(chunkPath); } catch (_) { return null; }
        if (!text) return null;
        const id = actionIdBefore(text, CLAIM_ACTION_NAME);
        return id ? { id: id, chunk: chunkPath, text: text } : { id: '', chunk: chunkPath, text: text };
    }

    if (cache && cache.chunk) {
        const hit = await scan(cache.chunk);
        if (hit && hit.id) return { id: hit.id, chunk: hit.chunk, scanned: scanned };
    }

    const page = await rawRequest(REWARDS_ORIGIN + '/dashboard', {
        headers: {
            'user-agent': UA.pc,
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
            'accept-encoding': 'gzip, deflate, br'
        },
        timeout: 30000
    });
    if (page.status !== 200 && page.status !== 307) throw new Error('首页返回 HTTP ' + page.status + '，拿不到 chunk 清单');
    const initial = chunkPathsIn(page.text);
    if (!initial.length) throw new Error('首页 body 里没有 chunk 清单（长度 ' + page.text.length + '，可能整站结构又换了）');

    const tried = new Set();
    const lazy = [];
    for (const chunkPath of initial) {
        if (tried.has(chunkPath)) continue;
        tried.add(chunkPath);
        const hit = await scan(chunkPath);
        if (hit && hit.id) return { id: hit.id, chunk: hit.chunk, scanned: scanned };
        if (hit) chunkPathsIn(hit.text).forEach(function (p) { if (!tried.has(p) && lazy.indexOf(p) < 0) lazy.push(p); });
        if (scanned >= 60) break;
    }
    for (const chunkPath of lazy) {
        if (tried.has(chunkPath) || scanned >= 70) continue;
        tried.add(chunkPath);
        const hit = await scan(chunkPath);
        if (hit && hit.id) return { id: hit.id, chunk: hit.chunk, scanned: scanned };
    }
    throw new Error('扫了 ' + scanned + ' 个 chunk 都没找到 ' + CLAIM_ACTION_NAME);
}

async function claimPendingPoints(jar) {
    const cache = readClaimCache();
    let id = cache && cache.id ? cache.id : '';
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!id) {
            const hit = await findClaimActionId();
            id = hit.id;
            writeClaimCache({ id: id, chunk: hit.chunk, at: Date.now() });
            log('🔑', '领取 action id ' + id + '（在 ' + hit.chunk + ' 里找到，扫了 ' + hit.scanned + ' 个文件）');
        }
        const res = await rawRequest(REWARDS_ORIGIN + '/dashboard', {
            method: 'POST',
            timeout: 45000,
            headers: {
                'user-agent': UA.pc,
                'accept': 'text/x-component',
                'content-type': 'text/plain;charset=UTF-8',
                'next-action': id,
                'origin': REWARDS_ORIGIN,
                'referer': REWARDS_ORIGIN + '/dashboard',
                'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
                'accept-encoding': 'gzip, deflate, br',
                'cookie': jar.header()
            },
            body: '[]'
        });
        // 400 = id 形状不对、409 = 形状对但当前部署里没这个 action，两种都带这个头
        if (String(res.headers['x-nextjs-action-not-found'] || '') === '1') {
            log('🟡', '缓存里的 action id 在当前部署里不存在（HTTP ' + res.status + '），重新找一次');
            writeClaimCache(null);
            id = '';
            lastErr = new Error('action id 失效');
            continue;
        }
        if (res.status !== 200) throw new Error('领取请求返回 HTTP ' + res.status);
        const ret = /^1:(true|false)\s*$/m.exec(res.text);
        return { id: id, returned: ret ? ret[1] === 'true' : null };
    }
    throw lastErr || new Error('领取 action id 连续两次都被判为失效');
}

async function doSearch(jar, query, mobile) {
    const url = BING + '/search?q=' + encodeURIComponent(query) + '&form=QBLH&qs=n&sp=-1';
    const res = await fetchUrl(jar, url, {
        headers: {
            'user-agent': mobile ? UA.mobile : UA.pc,
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
            'referer': REWARDS_HOME,
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'upgrade-insecure-requests': '1'
        },
        cookieFilter: searchCookieFilter
    });
    return {
        status: res.status,
        url: res.url,
        query: query,
        mobile: mobile,
        bytes: res.buf.length,
        ig: igOf(res.text)
    };
}

// 搜索结果页加载完自己会发这一对 POST，服务端按页面里那枚 IG 给这次搜索记分。
// 10-31 在已登录浏览器里抓到的真形状：
//   POST cn.bing.com/rewardsapp/ncheader?...&IID=SERP.5047&IG=<32位>&ajaxreq=1   body wb=1;i=1;v=1
//   POST cn.bing.com/rewardsapp/reportActivity?...&IID=SERP.5057&q=<词>&ajaxreq=1 body url=<这次搜索页的 URL>&V=web
// 回包里 Balance 已含本次加分、DailySearchPointsEarned/Limit 是今天的搜索分进度。
// 同一枚 IG 重报不重复加分（10-31 实测），所以每条搜索只报一次。
function reportSearchUrl(target) {
    const u = String(target.url || '');
    try {
        const p = new URL(u);
        return 'https://cn.bing.com' + p.pathname + p.search;
    } catch (_) {
        return u;
    }
}

async function reportSerp(jar, target) {
    const ig = String(target.ig || '');
    if (!ig) {
        log('🟡', '上报跳过：这一页里没有 IG（' + (target.bytes || 0) + ' 字节）');
        return null;
    }
    const pageUrl = reportSearchUrl(target);
    let q = '';
    try { q = new URL(pageUrl).searchParams.get('q') || ''; } catch (_) { }
    const headers = {
        'user-agent': target.mobile ? UA.mobile : UA.pc,
        'accept': '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://cn.bing.com',
        'referer': pageUrl
    };
    try {
        await fetchUrl(jar, 'https://cn.bing.com/rewardsapp/ncheader?ver=75605716&IID=SERP.5047'
            + '&IG=' + ig + '&ajaxreq=1', {
            method: 'POST', headers: headers, body: 'wb=1;i=1;v=1', cookieFilter: searchCookieFilter
        });
    } catch (_) {
        // ncheader 只是头部的 UI 数据，失败不影响记分那一步
    }
    const body = 'url=' + encodeURIComponent(pageUrl).replace(/%2F/g, '/') + '&V=web';
    const res = await fetchUrl(jar, 'https://cn.bing.com/rewardsapp/reportActivity?IG=' + ig
        + '&IID=SERP.5057&q=' + encodeURIComponent(q) + '&ajaxreq=1', {
        method: 'POST', headers: headers, body: body, cookieFilter: searchCookieFilter
    });
    const t = String(res.text || '');
    const pick = function (re) { const m = re.exec(t); return m ? Number(m[1]) : null; };
    return {
        status: res.status,
        auth: /"IsAuthenticated":(true|false)/.test(t) ? /"IsAuthenticated":(true|false)/.exec(t)[1] === 'true' : null,
        balance: pick(/"Balance":(-?\d+)/),
        increment: pick(/"RewardsIncrement":(-?\d+)/),
        earned: pick(/"DailySearchPointsEarned":(\d+)/),
        limit: pick(/"DailySearchPointsLimit":(\d+)/)
    };
}

function describeReport(rep) {
    if (!rep) return '';
    return 'HTTP ' + rep.status
        + '｜登录 ' + (rep.auth === null ? '未知' : (rep.auth ? '是' : '否'))
        + '｜余额 ' + (rep.balance === null ? '—' : rep.balance)
        + (rep.earned === null ? '' : '｜今日搜索分 ' + rep.earned + (rep.limit === null ? '' : '/' + rep.limit));
}

async function openDailyItem(jar, item) {
    const res = await fetchUrl(jar, item.url, {
        headers: {
            'user-agent': UA.pc,
            'referer': DASHBOARD,
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'same-site',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1'
        },
        cookieFilter: searchCookieFilter
    });
    return {
        status: res.status,
        url: res.url || item.url,
        bytes: res.buf.length,
        ig: igOf(res.text)
    };
}

// ---------------------------------------------------------------- App 令牌 + dapi

async function tokenRequest(params) {
    const body = new URLSearchParams(params).toString();
    const res = await rawRequest(TOKEN_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body)
        },
        body: body
    });
    let data = null;
    try { data = JSON.parse(res.text); } catch (_) { /* 下面统一报错 */ }
    if (!data) throw new Error('令牌端点返回非 JSON（HTTP ' + res.status + '）');
    if (!data.access_token) {
        throw new Error(data.error_description || data.error || ('HTTP ' + res.status));
    }
    return data;
}

// 从整条回调链接里取出 code= 后面的原文，不做任何解码
function extractCodeRaw(s) {
    const i = s.indexOf('code=');
    if (i < 0) return s;
    let v = s.slice(i + 5);
    const cut = v.search(/[&#]/);
    if (cut >= 0) v = v.slice(0, cut);
    return v;
}

// 同一串 code 的几种可能写法都试一遍：+ 既可能是字面加号，也可能是空格的转义，
// 按查询串解析会把它变成空格，而授权码里真有加号的概率不低。
function codeVariants(raw) {
    const out = [];
    function add(v) { if (v && out.indexOf(v) < 0) out.push(v); }
    try { add(decodeURIComponent(raw)); } catch (_) { /* 不是合法转义 */ }
    try { add(new URLSearchParams('code=' + raw).get('code') || ''); } catch (_) { /* 跳过 */ }
    add(raw);
    return out;
}

// 青龙起任务时会把变量拼进 shell 命令（export NAME="…"），令牌末尾的 $$ 会被当成
// 「当前进程号」展开成数字：353 字符的令牌变 355、结尾从 avag$$ 变 avag4341。
// 真令牌固定以 $$ 收尾，所以「开头 M.C5、结尾一串数字」的值按几种位数还原再试。
function refreshRepairs(value) {
    const out = [];
    if (!/^M\.C5/.test(value)) return out;
    const m = /(\d{3,7})$/.exec(value);
    if (!m) return out;
    for (let n = Math.min(7, m[1].length); n >= 3; n--) {
        out.push(value.slice(0, value.length - n) + '$$');
    }
    return out;
}

function readCachedToken() {
    try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function saveCachedToken(token, cached) {
    if (!token || token === cached) return;
    try {
        fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
        log('🔑', '新令牌已存到 ' + TOKEN_FILE + '，以后不用再往环境变量里贴');
    } catch (_) { /* 存不了就继续靠环境变量 */ }
}

async function obtainAccessToken() {
    const refresh = env('BING_REWARDS_REFRESH_TOKEN', '').trim();
    const code = env('BING_REWARDS_AUTH_CODE', '').trim();
    const cached = readCachedToken();
    // 两个变量填反了也不影响：下面的 attempts 会两种方式都试
    if (!refresh && !code && !cached) {
        log('🟡', '没配 refresh token 也没有授权码，跳过 App 签到与阅读');
        log('🔑', '取授权码（火狐里打开，登录后地址栏停在 code=…）：' + AUTHORIZE_HINT);
        log('🔑', '把那条链接整个填进 BING_REWARDS_AUTH_CODE，十几分钟内跑一次 DRY_RUN=1');
        return null;
    }

    const errors = [];
    // 两个变量都可能填错栏，所以每个值两种方式都试，不靠前缀猜
    const seen = new Set();
    const attempts = [];
    function addAttempt(type, value, source, repaired) {
        if (!value) return;
        const key = type + '|' + value;
        if (seen.has(key)) return;
        seen.add(key);
        attempts.push({ type: type, value: value, source: source, repaired: Boolean(repaired) });
    }
    addAttempt('refresh', cached, 'TOKEN_FILE');
    addAttempt('refresh', refresh, 'REFRESH_TOKEN');
    addAttempt('refresh', code, 'AUTH_CODE');
    for (const v of refreshRepairs(cached)) addAttempt('refresh', v, 'TOKEN_FILE', true);
    for (const v of refreshRepairs(refresh)) addAttempt('refresh', v, 'REFRESH_TOKEN', true);
    for (const v of refreshRepairs(code)) addAttempt('refresh', v, 'AUTH_CODE', true);
    for (const v of codeVariants(extractCodeRaw(cached))) addAttempt('code', v, 'TOKEN_FILE');
    for (const v of codeVariants(extractCodeRaw(refresh))) addAttempt('code', v, 'REFRESH_TOKEN');
    for (const v of codeVariants(extractCodeRaw(code))) addAttempt('code', v, 'AUTH_CODE');

    for (const one of attempts) {
        try {
            let d;
            if (one.type === 'refresh') {
                d = await tokenRequest({
                    client_id: CLIENT_ID,
                    redirect_uri: REDIRECT_URI,
                    scope: REWARDS_SCOPE,
                    grant_type: 'refresh_token',
                    refresh_token: one.value
                });
            } else {
                d = await tokenRequest({
                    client_id: CLIENT_ID,
                    redirect_uri: REDIRECT_URI,
                    grant_type: 'authorization_code',
                    code: one.value
                });
            }
            if (one.repaired) {
                log('🟡', one.source + ' 末尾的 $$ 被青龙展开成了数字，已自动还原成 $$ 后换到令牌');
            }
            if (one.type === 'code' && one.source === 'REFRESH_TOKEN') {
                log('🟡', 'REFRESH_TOKEN 里那串其实是授权码，已按授权码换到令牌');
            }
            if (one.type === 'refresh' && one.source === 'AUTH_CODE') {
                log('🟡', 'AUTH_CODE 里那串其实是刷新令牌，已按刷新令牌用');
            }
            const next = d.refresh_token || (one.type === 'refresh' ? one.value : '');
            saveCachedToken(next, cached);
            return {
                token: d.access_token,
                refresh: next,
                fresh: one.type === 'code' && !one.repaired
            };
        } catch (e) {
            errors.push({ source: one.source, type: one.type, msg: e.message });
        }
    }

    // 同一串码的几种解码都失败时只报一行，别把同样的错抄三遍
    const grouped = [];
    const index = new Map();
    for (const e of errors) {
        const key = e.source + '|' + e.type;
        if (index.has(key)) {
            const g = grouped[index.get(key)];
            g.n += 1;
            if (g.msgs.indexOf(e.msg) < 0) g.msgs.push(e.msg);
        } else {
            index.set(key, grouped.length);
            grouped.push({ source: e.source, type: e.type, n: 1, msgs: [e.msg] });
        }
    }
    const SOURCE_LABEL = { REFRESH_TOKEN: 'BING_REWARDS_REFRESH_TOKEN', AUTH_CODE: 'BING_REWARDS_AUTH_CODE', TOKEN_FILE: '脚本目录里的令牌文件' };
    throw new Error(grouped.map(function (g) {
        return (SOURCE_LABEL[g.source] || g.source) + ' 按 ' + (g.type === 'refresh' ? '刷新令牌' : '授权码') + ' 用'
            + (g.n > 1 ? '（' + g.n + ' 种写法都试过）' : '') + '：' + g.msgs.join(' / ');
    }).join('；'));
}

function dapiHeaders(token, country, extra) {
    return Object.assign({
        'content-type': 'application/json; charset=UTF-8',
        'user-agent': UA.app,
        'authorization': 'Bearer ' + token,
        'x-rewards-appid': APP_ID,
        'x-rewards-ismobile': 'true',
        'x-rewards-country': country,
        'x-rewards-language': 'zh'
    }, extra || {});
}

async function dapiRequest(token, country, path, options) {
    const opts = options || {};
    const headers = dapiHeaders(token, country, opts.headers);
    let body;
    if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
        headers['content-length'] = Buffer.byteLength(body);
    }
    // 手机流量偶尔会卡过 25 秒。重试时请求体原样重发，POST 里的 id 不变，服务端按它去重。
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await rawRequest(DAPI + path, {
                method: opts.method || 'GET',
                headers: headers,
                body: body,
                timeout: opts.timeout || 45000
            });
            let data = null;
            try { data = JSON.parse(res.text); } catch (_) { /* 下面统一报错 */ }
            if (res.status === 401) throw new Error('令牌被拒（401），需要重新取授权码');
            if (!data) throw new Error('dapi 返回非 JSON（HTTP ' + res.status + '）');
            return data;
        } catch (e) {
            lastErr = e;
            if (/令牌被拒/.test(e.message)) throw e;
            if (attempt < 2) await sleep(randInt(2, 5) * 1000);
        }
    }
    throw lastErr;
}

async function appProfile(token, country) {
    try {
        const d = await dapiRequest(token, country, '/me?channel=SAAndroid&options=105');
        const balance = Number((d.response || {}).balance);
        return { balance: Number.isFinite(balance) ? balance : null };
    } catch (e) {
        return { balance: null, error: e.message };
    }
}

async function appSignIn(token, country) {
    const d = await dapiRequest(token, country, '/me/activities', {
        method: 'POST',
        headers: { 'x-rewards-partnerid': 'startapp', 'x-rewards-flights': 'rwgobig' },
        json: {
            amount: 1,
            id: crypto.randomBytes(32).toString('hex'),
            type: 103,
            country: country,
            channel: 'SAAndroid'
        }
    });
    const resp = d.response || {};
    if (resp.activity) {
        const a = resp.activity;
        return { points: Number(a.p !== undefined ? a.p : a.points) || 0, duplicate: false };
    }
    if (resp.isDuplicate || resp.activity === null) return { points: 0, duplicate: true };
    return { points: 0, duplicate: false, unclear: true };
}

async function readTask(token, country) {
    const d = await dapiRequest(token, country, '/me?channel=SAAndroid&options=613');
    const promos = (d.response || {}).promotions || [];
    const hit = promos.find(function (p) {
        const a = (p && p.attributes) || {};
        return /readarticle/i.test(String(a.offerid || ''));
    });
    if (!hit) return null;
    const a = hit.attributes || {};
    const offerId = String(a.offerid);
    const per = /readarticle(\d+)/i.exec(offerId);
    return {
        offerId: offerId,
        progress: Number(a.progress || 0),
        max: Number(a.max || 30),
        perRead: per ? Number(per[1]) : 3
    };
}

// 北京日期键，用来从 promotions 里挑出「今天」那三张卡
function beijingDateKey() {
    return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
}

// promotions 的自述字段不统一：有的写 complete:"True"，有的只给 progress/max
function promoDone(a) {
    if (String(a.complete).toLowerCase() === 'true') return true;
    const prog = Number(a.progress !== undefined ? a.progress : a.activity_progress);
    const max = Number(a.max !== undefined ? a.max : a.activitymax);
    return Number.isFinite(prog) && Number.isFinite(max) && max > 0 && prog >= max;
}

async function appBalance(token, country) {
    try {
        const d = await dapiRequest(token, country, '/me?channel=SAAndroid&options=105');
        const b = Number((d.response || {}).balance);
        return Number.isFinite(b) ? b : null;
    } catch (_) {
        return null;
    }
}

// 网页那三张卡（Gamification_DailySet_*）在 App 的 promotions 里也是同一批 offerid。
// 阅读那条用 type:101 + attributes.offerid 能直接记分，每日活动照打；101 不动再试 102。
// 这条路只要 App 令牌，不碰 bing.com 搜索侧的登录态 —— 那正是网页侧记不上分的地方。
async function appDailySet(token, country, out, webDone, startBalance) {
    const doneIds = webDone || new Set();
    let known = Number.isFinite(startBalance) ? startBalance : null;
    if (known === null) known = await appBalance(token, country);
    // 余额读不到就证明不了「记上了」。这时只打 101 这一发：101 真记了、可我们又看不出来，
    // 再补一发 102 就可能同一张卡记两次。
    const blind = known === null;
    const types = blind ? [101] : [101, 102];
    const d = await dapiRequest(token, country, '/me?channel=SAAndroid&options=613');
    const promos = (d.response || {}).promotions || [];
    const today = beijingDateKey();
    const cards = promos.filter(function (p) {
        const a = (p && p.attributes) || {};
        const id = String(a.offerid || '');
        return /^Gamification_DailySet_/i.test(id) && id.indexOf(today) >= 0;
    });
    out.lines.push('App 每日活动：promotions 里今天的卡 ' + cards.length + ' 张');
    if (!cards.length) return 0;

    let credited = 0;
    let submitted = 0;
    for (const p of cards) {
        const a = p.attributes || {};
        const offerId = String(a.offerid);
        out.lines.push('  · ' + offerId + ' | ' + JSON.stringify(a).slice(0, 500));
        if (doneIds.has(offerId)) {
            out.lines.push('    网页那边已完成，跳过');
            continue;
        }
        if (promoDone(a)) {
            out.lines.push('    自述已完成，跳过');
            continue;
        }
        submitted += 1;
        for (const type of types) {
            try {
                const r = await dapiRequest(token, country, '/me/activities', {
                    method: 'POST',
                    json: {
                        amount: 1,
                        country: country,
                        id: crypto.randomBytes(32).toString('hex'),
                        type: type,
                        attributes: { offerid: offerId }
                    }
                });
                // 回执里自带 balance，就不用再单独读一次账号（少一次超时机会）
                const receipt = Number((r.response || {}).balance);
                const after = Number.isFinite(receipt) ? receipt : await appBalance(token, country);
                out.lines.push('    → type ' + type + '：余额 ' + (known === null ? '—' : known)
                    + ' → ' + (after === null ? '—' : after)
                    + '，回执 ' + JSON.stringify(r.response || r).slice(0, 120));
                const creditedNow = known !== null && after !== null && after > known;
                if (after !== null) known = after;
                if (creditedNow) {
                    credited += 1;
                    break;
                }
            } catch (e) {
                out.lines.push('    → type ' + type + ' 失败：' + e.message);
            }
        }
    }
    out.lines.push(credited > 0
        ? 'App 每日活动：记上 ' + credited + ' 张'
        : submitted === 0
            ? 'App 每日活动：网页那边都已完成，没有要补的'
            : blind
                ? 'App 每日活动：余额读不到，已按 101 各打了一发，记上没有这一拍证明不了（看下一拍网页那边的分数）'
                : 'App 每日活动：提交 ' + submitted + ' 张，回执里余额没涨（101 / 102 都被收下但不加分）');
    return credited;
}

// App 的「更多活动」（拼图 / 问答，每条 +5、日上限 25）也在同一份 promotions 里。
// 先把条目原样打出来，再按阅读那套 type:101 + attributes.offerid 挨个试提交。
async function runExtraActivities(token, country, out) {
    const d = await dapiRequest(token, country, '/me?channel=SAAndroid&options=613');
    const promos = (d.response || {}).promotions || [];
    out.lines.push('更多活动：dapi 里共 ' + promos.length + ' 条，带 offerid 的才打印');
    const targets = [];
    for (const p of promos) {
        const a = (p && p.attributes) || {};
        const offerId = String(a.offerid || '');
        if (!offerId) continue;
        out.lines.push('  · ' + offerId + ' | ' + JSON.stringify(p).slice(0, 220));
        if (/readarticle|dailyset|checkin|streak/i.test(offerId)) continue;
        const max = Number(a.max);
        const prog = Number(a.progress);
        if (Number.isFinite(max) && Number.isFinite(prog) && prog >= max) continue;
        targets.push(offerId);
    }
    if (!targets.length) {
        out.lines.push('更多活动：没有可提交的条目');
        return 0;
    }
    let credited = 0;
    for (const offerId of targets.slice(0, 10)) {
        try {
            const r = await dapiRequest(token, country, '/me/activities', {
                method: 'POST',
                json: {
                    amount: 1,
                    country: country,
                    id: crypto.randomBytes(32).toString('hex'),
                    type: 101,
                    attributes: { offerid: offerId }
                }
            });
            const p = Number(((r.response || {}).activity || {}).p || 0);
            if (p > 0) credited += p;
            out.lines.push('  → ' + offerId + '：' + JSON.stringify(r.response || r).slice(0, 160));
        } catch (e) {
            out.lines.push('  → ' + offerId + ' 失败：' + e.message);
        }
        await sleep(randInt(2, 5) * 1000);
    }
    return credited;
}

async function readOnce(token, country, offerId) {
    const d = await dapiRequest(token, country, '/me/activities', {
        method: 'POST',
        json: {
            amount: 1,
            country: country,
            id: crypto.randomBytes(32).toString('hex'),
            type: 101,
            attributes: { offerid: offerId }
        }
    });
    const resp = d.response || {};
    return { points: Number((resp.activity || {}).p || 0), duplicate: Boolean(resp.isDuplicate) };
}

function describeSecret(name, value) {
    if (!value) return name + ' 空';
    const head = value.slice(0, 14);
    const tail = value.length > 20 ? value.slice(-4) : '';
    const marks = [];
    if (/\s/.test(value)) marks.push('含空白');
    if (value.indexOf('+') >= 0) marks.push('含+');
    if (value.indexOf('%') >= 0) marks.push('含%');
    if (/^M\.C5/.test(value) && /\d{3,7}$/.test(value)) marks.push('结尾是一串数字，末尾的 $$ 被 shell 展开过');
    return name + ' 有值(' + value.length + ' 字符，开头 ' + head + (tail ? '…' + tail : '')
        + (marks.length ? '，' + marks.join('/') : '') + ')';
}

async function runAppTasks(tasks, dryRun, webBalance, webDone) {
    const out = {
        lines: [],
        failures: [],
        stats: { sign: null, read: null, dailySet: null, extra: 0 }
    };
    const country = env('BING_REWARDS_APP_COUNTRY', 'cn').toLowerCase();

    let auth;
    try {
        auth = await obtainAccessToken();
    } catch (e) {
        out.lines.push('App：取令牌失败 — ' + e.message);
        out.lines.push('诊断：' + describeSecret('REFRESH_TOKEN', env('BING_REWARDS_REFRESH_TOKEN', ''))
            + '；' + describeSecret('AUTH_CODE', env('BING_REWARDS_AUTH_CODE', '')));
        out.lines.push('取值链接（授权码一次性、十几分钟内有效，取到就马上跑）：' + AUTHORIZE_HINT);
        out.failures.push('App 令牌');
        return out;
    }
    if (!auth) return out;

    if (auth.fresh && auth.refresh) {
        out.lines.push('[🔑] 新的 refresh token 已自动存盘，以后不用再往环境变量里贴；想留一份就抄进 BING_REWARDS_REFRESH_TOKEN：');
        out.lines.push(auth.refresh);
    }

    const prof = await appProfile(auth.token, country);
    if (prof.error) {
        out.lines.push('App：读账号失败 — ' + prof.error + '（重试 3 次仍不通，跳过余额比对，App 任务继续做）');
        out.failures.push('App 账号');
    } else {
        if (webBalance !== null && prof.balance !== null && prof.balance !== webBalance) {
            out.lines.push('App：令牌余额 ' + prof.balance + ' 与网页 ' + webBalance + ' 不一致，可能是另一个微软账号，已跳过 App 任务');
            out.failures.push('App 账号不匹配');
            return out;
        }
        out.lines.push('App 账号余额：' + (prof.balance === null ? '—' : prof.balance));
    }

    if (dryRun) {
        out.lines.push('App：dry-run，未提交签到与阅读');
        return out;
    }

    if (tasks.has('sign')) {
        try {
            const r = await appSignIn(auth.token, country);
            out.stats.sign = { points: r.points, duplicate: r.duplicate };
            out.lines.push('App 签到：' + (r.duplicate ? '今天已签过'
                : r.points > 0 ? '+' + r.points : '已提交，未确认')
                + (r.unclear ? '（响应里没有活动字段）' : ''));
        } catch (e) {
            out.lines.push('App 签到失败：' + e.message);
            out.failures.push('App 签到');
        }
    }

    if (tasks.has('read')) {
        try {
            let task = await readTask(auth.token, country);
            if (!task) {
                out.lines.push('阅读：App 里没找到阅读任务（可能这个账号没有这项）');
            } else {
                const before = task.progress;
                const need = Math.max(0, Math.ceil((task.max - task.progress) / task.perRead));
                out.lines.push('阅读：' + task.progress + '/' + task.max + '，本轮提交 ' + Math.min(need, 12) + ' 篇');
                for (let i = 0; i < Math.min(need, 12); i++) {
                    await readOnce(auth.token, country, task.offerId);
                    await sleep(randInt(3, 8) * 1000);
                }
                const after = await readTask(auth.token, country);
                if (after) {
                    out.stats.read = { before: before, after: after.progress, max: after.max };
                    out.lines.push('阅读：' + before + '/' + task.max + ' → ' + after.progress + '/' + after.max);
                    if (after.progress < after.max) out.failures.push('阅读未满');
                } else {
                    out.failures.push('阅读复查失败');
                }
            }
        } catch (e) {
            out.lines.push('阅读失败：' + e.message);
            out.failures.push('阅读');
        }
    }

    if (tasks.has('dailyset')) {
        try {
            out.dailySetCredited = await appDailySet(auth.token, country, out, webDone, prof.balance);
            out.stats.dailySet = out.dailySetCredited;
        } catch (e) {
            out.lines.push('App 每日活动失败：' + e.message);
            out.failures.push('App 每日活动');
        }
    }

    if (envBool('BING_REWARDS_EXTRA', false) || tasks.has('extra')) {
        try {
            out.stats.extra = await runExtraActivities(auth.token, country, out);
        } catch (e) {
            out.lines.push('更多活动失败：' + e.message);
            out.failures.push('更多活动');
        }
    }

    return out;
}

// ---------------------------------------------------------------- 主流程

// 每日活动逐张打明细：卡片换日期换链接不要紧，脚本每跑一次就重新读一遍，
// 这里印的是「这一次读到的那几张卡」到底是什么类型、链接打了哪儿。
function dumpDailySet(state) {
    if (!state.dailySet.length) return;
    console.log('—— 每日活动明细 ——');
    state.dailySet.forEach(function (it, idx) {
        console.log('[' + (idx + 1) + '] ' + (it.done ? '已完成' : '未完成')
            + ' · ' + (it.title || '(无标题)') + ' · ' + it.points + ' 分');
        console.log('    offerId: ' + (it.offerId || '(空)'));
        console.log('    链接　: ' + (it.url || '(空)'));
        if (it.raw) {
            let s;
            try { s = JSON.stringify(it.raw); } catch (_) { s = String(it.raw); }
            if (s.length > 1200) s = s.slice(0, 1200) + '…(截断)';
            console.log('    原始　: ' + s);
        }
    });
    console.log('—— 明细结束 ——');
}

function summarize(state) {
    const lines = [];
    let head = '积分：' + (state.balance === null ? '—' : state.balance)
        + '（等级 ' + (state.level === null ? '—' : state.level);
    if (state.levelProgress) {
        head += ' · ' + state.levelProgress.progress + '/' + state.levelProgress.requirement
            + '，还差 ' + state.levelProgress.remaining;
    }
    lines.push(head + '）');
    if (state.claimable !== null) {
        lines.push('待领取：' + (state.claimable > 0 ? state.claimable + ' 分（要先领取才能兑换）' : '无'));
    }
    if (state.pointsPerSearch !== null) lines.push('每次搜索：' + state.pointsPerSearch + ' 分');

    if (state.dailySet.length) {
        const done = state.dailySet.filter(function (i) { return i.done; }).length;
        lines.push('每日活动：' + done + '/' + state.dailySet.length);
        state.dailySet.forEach(function (it, idx) {
            lines.push('  ' + (it.done ? '✓' : '·') + ' ' + (idx + 1) + '. '
                + (it.title || it.offerId) + '（' + it.points + ' 分）');
        });
    } else {
        lines.push('每日活动：未解析到');
    }

    if (state.streaks.length) {
        lines.push('连续打卡：');
        state.streaks.forEach(function (s) {
            lines.push('  ' + (s.done ? '✓' : '·') + ' ' + s.label
                + '（' + (s.totalDays || '?') + ' 天）');
        });
    }
    return lines.join('\n');
}

async function main() {
    const started = Date.now();
    const rawCookie = env('BING_REWARDS_COOKIE', '');
    if (!rawCookie) throw new Error('未配置 BING_REWARDS_COOKIE');

    const jar = new Jar(rawCookie);
    const dryRun = envBool('BING_REWARDS_DRY_RUN', false);
    const tasks = new Set(env('BING_REWARDS_TASKS', 'status,dailyset,sign,read,search,mobile')
        .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean));
    // 只有搜索侧真的登录了才会用到这两个数；10 次正好吃满 2 级的 30 分上限。
    // 移动和 PC 共用同一个日额度，所以移动默认 0。
    const pcCount = envIntAny(['BING_REWARDS_PC_SEARCHES', 'BING_REWARDS_SEARCH_COUNT'], 10, 0, 20);
    const mbCount = envIntAny(['BING_REWARDS_MOBILE_SEARCHES', 'BING_REWARDS_MOBILE_SEARCH_COUNT'], 0, 0, 20);
    const interval = envInt('BING_REWARDS_SEARCH_INTERVAL', 20, 5, 300);

    console.log('必应积分（青龙·新版）v' + VERSION);
    console.log('任务：' + Array.from(tasks).join(', ')
        + (envBool('BING_REWARDS_CLAIM', true) ? '（含自动领取）' : '')
        + (dryRun ? '（dry-run：只读不提交）' : ''));
    if (!jar.has('_U')) log('🟡', 'cookie 里没有 _U，可能只贴了半份');
    const cookieNames = [];
    jar.map.forEach(function (v, k) { cookieNames.push(k); });
    log('🍪', 'cookie 共 ' + cookieNames.length + ' 个（只列名字）：' + cookieNames.join(', '));

    // 1. 读状态
    let before;
    try {
        const text = await fetchDashboard(jar);
        before = parseDashboard(text);
        log('📊', '余额已读到');
    } catch (e) {
        console.log('\n❌ ' + e.message);
        console.log('排查顺序：1) cookie 是否带 _U 和 .MSA.Auth 两个；2) 手机能不能直连 rewards.bing.com；3) 在火狐里重登一次再取。');
        process.exitCode = 1;
        await pushNotify('🔴 必应积分失败', '### 🔴 必应积分 · ' + beijingStamp(started)
            + '\n\n读不到余额：' + e.message
            + '\n\n**排查顺序**'
            + '\n\n1. cookie 里有没有 `_U` 和 `.MSA.Auth`'
            + '\n2. 手机能不能直连 rewards.bing.com'
            + '\n3. 在火狐里重登一次，从 dashboard 请求里复制 Cookie');
        return;
    }
    console.log('\n' + summarize(before) + '\n');
    dumpDailySet(before);

    const failures = [];
    const stats = { app: null, claim: null, daily: null, search: null };

    // 2. App 侧：签到 + 阅读（要 OAuth 令牌，跟网页 cookie 是两套）
    //    dry-run 也会走这一段：只换令牌、只读余额，不提交
    if (tasks.has('sign') || tasks.has('read') || tasks.has('dailyset') || tasks.has('extra')
        || envBool('BING_REWARDS_EXTRA', false)) {
        const webDone = new Set(before.dailySet.filter(function (i) { return i.done; }).map(function (i) { return i.offerId; }));
        const app = await runAppTasks(tasks, dryRun, before.balance, webDone);
        app.lines.forEach(function (line) { console.log(line); });
        app.failures.forEach(function (f) { failures.push(f); });
        stats.app = app.stats;
        console.log('');
    }

    if (dryRun) {
        log('🔎', 'dry-run 结束，未执行任何动作');
        return;
    }

    // 2.4 领取：网页上的「待领取」要点一次「领取」才会进余额。按钮背后是 Server Action，
    //     跟 cookie 走，不需要浏览器；待领取为 0 的日子不发任何请求。
    if (before.claimable !== null && before.claimable > 0 && envBool('BING_REWARDS_CLAIM', true)) {
        log('🎁', '待领取 ' + before.claimable + ' 分，开始领取');
        stats.claim = { from: before.claimable, to: null };
        try {
            const c = await claimPendingPoints(jar);
            log(c.returned === true ? '🟢' : '🟡',
                '领取请求已发出：Server Action 回 ' + (c.returned === null ? '（没解析到返回值）' : String(c.returned)));
            await sleep(randInt(3, 5) * 1000);
            let st = parseDashboard(await fetchDashboard(jar));
            // 服务端记账有时要缓一拍；看着没变就再等几秒复读一次
            if (st.claimable !== null && st.claimable >= before.claimable) {
                await sleep(randInt(5, 8) * 1000);
                try { st = parseDashboard(await fetchDashboard(jar)); } catch (_) { }
            }
            stats.claim.to = st.claimable;
            if (st.claimable === null) {
                log('🟡', '复读没读到「待领取」，这一拍看不清领没领到（看面板）');
                failures.push('领取未确认');
            } else if (st.claimable < before.claimable) {
                log('🟢', '领取成功：待领取 ' + before.claimable + ' → ' + st.claimable + ' 分'
                    + (st.balance !== null && before.balance !== null ? '，余额 ' + before.balance + ' → ' + st.balance : ''));
            } else if (c.returned === true) {
                log('🟡', 'Server Action 回了 true，但待领取仍是 ' + st.claimable + ' 分（可能只是接口收下了）');
                failures.push('领取');
            } else {
                log('🟡', '领取没生效：待领取仍是 ' + st.claimable + ' 分（Server Action 回 ' + c.returned + '）');
                failures.push('领取');
            }
        } catch (e) {
            log('🔴', '领取失败：' + e.message);
            failures.push('领取');
        }
        console.log('');
    }

    // 2.5 搜索侧不再做「登录自检」：10-31 在他已登录的火狐里看过，搜索页上
    //     同样没有 data-uid、data-report-activity=false，但搜索照样记分 ——
    //     那两个属性不是登录标记，按它判断只会把真能记分的搜索挡掉。
    await sleep(randInt(2, 4) * 1000);

    // 3. 每日活动：App 侧已经补过的这里就不用再打；剩下的网页落地页也走同一套上报
    if (tasks.has('dailyset')) {
        let state = before;
        try {
            state = parseDashboard(await fetchDashboard(jar));
        } catch (_) { /* 读不到就用开头那份 */ }
        const todo = state.dailySet.filter(function (i) { return !i.done && i.url; });
        stats.daily = { todo: todo.length, credited: 0 };
        if (!todo.length) {
            log('✅', '每日活动已全部完成');
        } else {
            log('📝', '待补 ' + todo.length + ' 项每日活动');
            for (const item of todo) {
                let ok = 0;
                try {
                    const r = await openDailyItem(jar, item);
                    log('🟢', '已打开：' + item.title + '（HTTP ' + r.status
                        + '，页面 IG ' + (r.ig ? r.ig.slice(0, 8) + '…' : '无') + '）');
                    const rep = await reportSerp(jar, { ig: r.ig, url: r.url, bytes: r.bytes });
                    if (rep) log(rep.balance === null ? '🟡' : '🟢', '  上报：' + describeReport(rep));
                    if (rep && rep.balance !== null) ok += 1;
                } catch (e) {
                    log('🟡', '打开或上报失败：' + item.title + ' — ' + e.message);
                }
                if (!ok) failures.push('每日活动:' + (item.title || item.offerId));
                else stats.daily.credited += 1;
                await sleep(randInt(6, 12) * 1000);
            }
        }
    }

    // 4. 搜索 → 上报。搜索页只负责发一枚 IG，真正记分的是随后那一对 POST。
    //    别再按 data-uid 判断「有没有登录」（10-31 已证伪，见 2.5）。
    //    每条被服务端收下并加了分，回执里的余额是含本次加分的真值。
    const pcNeed = tasks.has('search') ? pcCount : 0;
    const mbNeed = tasks.has('mobile') ? mbCount : 0;
    const used = new Set();
    const pcQueries = pickQueries(pcNeed, used);
    const mbQueries = pickQueries(mbNeed, used);
    const searchPlan = [];
    pcQueries.forEach(function (q) { searchPlan.push({ q: q, mobile: false }); });
    mbQueries.forEach(function (q) { searchPlan.push({ q: q, mobile: true }); });

    if (searchPlan.length) {
        stats.search = { done: 0, reported: 0, earned: null, limit: null, full: false };
        log('🔍', '待搜索 ' + searchPlan.length + ' 条（PC ' + pcQueries.length
            + ' / 移动 ' + mbQueries.length + '），每条搜完照搜索页的样子上报一次');
        for (let i = 0; i < searchPlan.length; i++) {
            const one = searchPlan[i];
            try {
                const r = await doSearch(jar, one.q, one.mobile);
                stats.search.done += 1;
                if (r.ig) stats.search.reported += 1;
                log(r.ig ? '🟢' : '🟡', (one.mobile ? '移动' : 'PC') + ' 搜索 ' + (i + 1) + '/' + searchPlan.length
                    + '：' + one.q + '（HTTP ' + r.status + '，IG ' + (r.ig ? r.ig.slice(0, 8) + '…' : '无') + '）');
                const rep = await reportSerp(jar, r);
                if (rep) {
                    log(rep.balance === null ? '🟡' : '🟢', '  上报：' + describeReport(rep));
                    if (rep.earned !== null) stats.search.earned = rep.earned;
                    if (rep.limit !== null) stats.search.limit = rep.limit;
                }
                if (rep && rep.earned !== null && rep.limit !== null && rep.earned >= rep.limit) {
                    stats.search.full = true;
                    log('🟢', '今日搜索分已满（' + rep.earned + '/' + rep.limit + '），这一拍不再往下搜');
                    break;
                }
            } catch (e) {
                log('🔴', '搜索失败：' + one.q + ' — ' + e.message);
                failures.push('搜索:' + one.q);
            }
            if (i < searchPlan.length - 1) await sleep(randInt(Math.max(5, interval - 5), interval + 10) * 1000);
        }
    } else if (tasks.has('search') || tasks.has('mobile')) {
        log('⏭️', '搜索次数是 0，这一拍不搜'
            + '（BING_REWARDS_PC_SEARCHES / BING_REWARDS_MOBILE_SEARCHES）');
    }

    // 5. 收尾：再读一次看涨了多少
    if (jar.blocked.length) {
        log('🟡', '本次运行期间 ' + jar.blocked.join(' / ') + ' 被改写，已忽略以保住登录态');
    }
    await sleep(randInt(6, 12) * 1000);
    let after = null;
    try {
        after = parseDashboard(await fetchDashboard(jar));
    } catch (e) {
        try {
            after = parseDashboard(await fetchDashboard(new Jar(rawCookie)));
            log('🟡', '收尾复读成功（原会话被改写，已用原始 cookie 重读）');
        } catch (e2) {
            log('🟡', '收尾读取失败：' + e2.message);
        }
    }

    if (after && after.dailySet.length) {
        const still = after.dailySet.filter(function (i) { return !i.done; });
        if (still.length) {
            console.log('仍未完成：' + still.map(function (i) {
                return (i.title || '(无标题)') + '（' + (i.offerId || '无 offerId') + '）';
            }).join('；'));
        }
    }

    console.log('\n' + summaryLines(before, after, failures));
    console.log('\n## 执行结束，耗时 ' + Math.round((Date.now() - started) / 1000) + ' 秒');

    if (failures.length) {
        console.log('未完成：' + failures.join('；'));
        process.exitCode = 1;
    }

    const note = buildNotice(before, after, failures, stats, started);
    if (shouldSkipNotice(before, after, failures)) {
        log('📣', '这一拍积分没变、也没有失败项，不推送（BING_REWARDS_PUSH_ONLY_GAIN=0 可改回每拍都推）');
    } else {
        await pushNotify(note.title, note.content);
    }
}

function summaryLines(before, after, failures) {
    const out = [];
    const b = before.balance === null ? '—' : before.balance;
    const a = !after || after.balance === null ? '—' : after.balance;
    out.push('积分：' + b + ' → ' + a);
    if (after && after.claimable !== null) {
        out.push('待领取：' + (before.claimable === null ? '—' : before.claimable) + ' → ' + after.claimable);
    }
    if (after && after.dailySet.length) {
        const done = after.dailySet.filter(function (i) { return i.done; }).length;
        out.push('每日活动：' + done + '/' + after.dailySet.length);
    }
    if (after) {
        const doneStreak = after.streaks.filter(function (s) { return s.done; }).map(function (s) { return s.label; });
        out.push('已打卡：' + (doneStreak.join('、') || '无'));
    }
    if (failures.length) out.push('未完成：' + failures.join('；'));
    return out.join('\n');
}

// 推送正文：一行一个结果，带得走的账都印上；拿不到的字段直接略过，不印「—」
function buildNotice(before, after, failures, stats, startedAt) {
    const b = before.balance;
    const a = after ? after.balance : null;
    const delta = (Number.isFinite(b) && Number.isFinite(a)) ? a - b : null;

    let title = delta !== null
        ? '必应积分 ' + (delta >= 0 ? '+' : '') + delta + '（' + b + '→' + a + '）'
        : '必应积分 ' + (failures.length ? '没跑完' : '已跑完');
    if (failures.length) title += ' · ' + failures.length + ' 项未完成';
    title = (failures.length ? '⚠️ ' : '🔔 ') + title;

    const lines = [];
    lines.push('### 🔔 必应积分 · ' + beijingStamp(startedAt));
    lines.push('');
    let score = '**💰 积分：' + money(b) + ' → ' + money(a);
    if (delta !== null) score += '（' + (delta >= 0 ? '+' : '') + delta + '）';
    score += '**';
    lines.push(score);
    if (after && after.level !== null) {
        let lv = '🏅 等级 ' + after.level;
        if (after.levelProgress) {
            lv += ' · 升级 ' + after.levelProgress.progress + '/' + after.levelProgress.requirement
                + '（还差 ' + after.levelProgress.remaining + '）';
        }
        lines.push(lv);
    }
    lines.push('');

    const s = stats.app;
    if (s && (s.sign || s.read || s.dailySet !== null || s.extra > 0)) {
        lines.push('**📱 App**');
        lines.push('');
        if (s.sign) {
            lines.push('- ' + (s.sign.duplicate ? '✅ 签到：今天已签过'
                : s.sign.points > 0 ? '✅ 签到 +' + s.sign.points
                    : '🟡 签到：已提交，未确认'));
        }
        if (s.read) lines.push('- 📖 阅读：' + s.read.after + '/' + s.read.max);
        if (s.dailySet !== null) {
            lines.push('- 🎯 每日活动：' + (s.dailySet > 0 ? '补上 ' + s.dailySet + ' 张' : '今天都做过'));
        }
        if (s.extra > 0) lines.push('- 🧩 更多活动：+' + s.extra + ' 分');
        lines.push('');
    }

    lines.push('**🌐 网页**');
    lines.push('');
    if (after && after.dailySet.length) {
        const done = after.dailySet.filter(function (i) { return i.done; }).length;
        lines.push('- ✅ 每日活动：' + done + '/' + after.dailySet.length
            + (stats.daily && stats.daily.credited > 0 ? '（本轮补 ' + stats.daily.credited + ' 项）' : ''));
    }
    if (stats.search) {
        let one = '- 🔍 搜索：' + stats.search.done + ' 条';
        if (stats.search.earned !== null) {
            one += ' · 今日搜索分 ' + stats.search.earned
                + (stats.search.limit === null ? '' : '/' + stats.search.limit);
        }
        if (stats.search.full) one += '（已满）';
        lines.push(one);
    }
    if (stats.claim) {
        lines.push('- 🎁 领取：待领取 ' + money(stats.claim.from) + ' → ' + money(stats.claim.to));
    }
    if (!after) lines.push('- 🟡 收尾没读到余额');
    lines.push('');

    const streaks = after
        ? after.streaks.filter(function (x) { return x.done; }).map(function (x) { return x.label; })
        : [];
    if (streaks.length) lines.push('🔥 已打卡：' + streaks.join('、'));
    lines.push('⏱ 耗时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒');
    lines.push(failures.length ? '❌ 未完成：' + failures.join('；') : '🎉 全部完成，没有失败项');

    return { title: title, content: lines.join('\n') };
}

main().catch(async function (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('未处理异常：' + msg);
    process.exitCode = 1;
    await pushNotify('🔴 必应积分异常', '### 🔴 必应积分 · ' + beijingStamp(Date.now())
        + '\n\n未处理异常：' + msg);
});
