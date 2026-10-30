/**
 * 福彩双色球历史开奖 → data/ssq_history.json
 *
 * 源：https://data.17500.cn/ssq_asc.txt —— 一行一期的纯文本全量档案，2003 年至今。
 *     挑它和挑 3D 那份同一个理由：它不挑出口 IP，GitHub 机房、Cloudflare 边缘、家里电脑都是 200。
 *     一行 31 列，列义已逐列核过（下面 parseTxt 里写死了）。
 *
 * 没给双色球配官方备胎：cwl 那个接口对机房 IP 一律 403（2026-10-30 在 3D 上实测过三轮），
 * 从家里敲它又有可能把你整个浏览器会话拦掉。所以这一条是单源 —— 主源挂了就不写盘、
 * 档案停在原地，宁可旧，不可假。
 *
 * 用法：node fetch_ssq.mjs [--out=<路径>] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';

const TXT = 'https://data.17500.cn/ssq_asc.txt';
const OUT = process.env.SSQ_OUT || 'data/ssq_history.json';
const FORCE = process.argv.includes('--force');
const argvOut = process.argv.find(a => a.startsWith('--out='));
const target = argvOut ? argvOut.slice(6) : OUT;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};
const WD = '日一二三四五六';
/* 上游偶尔回 429（实测：连发两次就 429，歇 45 秒单发就好），所以只重试一次 */
const RETRY_MS = 45000;

function fail(msg) {
  console.error('[✗] ' + msg);
  process.exit(1);
}

/* 期号是「年份 + 年内序号」，字典序即时间序 */
function byCode(a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; }

function isoDate(raw) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw || '').trim());
  return m ? m[1] : null;
}
function weekOf(date) {
  const d = new Date(date + 'T00:00:00Z');
  return isNaN(d) ? '' : WD[d.getUTCDay()];
}
function num(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 一行 = 31 列：
 *   [0] 期号  [1] 开奖日期  [2..7] 红球（已升序）  [8] 蓝球
 *   [9..14] 红球出球顺序 —— 只用它反查过 [2..7] 的组合是否自洽，本身不进档案
 *   [15] 当期销售额（元）  [16] 开奖后一等奖奖池（元）
 *   [17..28] 一至六等，各两列：注数、单注奖金
 *   [29..30] 福运奖（注数、单注奖金）—— 2026014 期起才有，见下
 *
 * 福运奖不是脏数据：2026-02-01（第 2026014 期）起双色球执行特别规定，奖池 ≥15 亿时增设
 * 这一档，中任意 3 个红球得 5 元；某期开奖后奖池跌破 3 亿即停发。档案里 2026075 开奖后
 * 奖池 2.83 亿，紧接着的 2026076 期福运奖注数就是 0 —— 判据对得上，所以照实带进档案。
 *
 * 早期缺的是「没记」不是「零」：2003 年那 89 期销售额/奖池/各档奖金整列都是 0，
 * 一律落成 null，行不删（号码是真的）。反过来「一等奖注数 = 0」是真的空开，原样留 0。
 */
function parseTxt(text) {
  const out = [];
  let bad = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (!t[0]) continue;
    if (!/^\d{7}$/.test(t[0]) || t.length !== 31) { bad++; continue; }
    const date = isoDate(t[1]);
    const red = t.slice(2, 8).map(n => num(n));
    const blue = num(t[8]);
    if (!date) { bad++; continue; }
    if (red.some(v => !Number.isInteger(v) || v < 1 || v > 33) || red.join() !== red.slice().sort((a, b) => a - b).join()) { bad++; continue; }
    if (new Set(red).size !== 6 || !Number.isInteger(blue) || blue < 1 || blue > 16) { bad++; continue; }
    /* 出球顺序那 6 列必须和升序那 6 列是同一副号，对不上就是上游串行了 */
    const order = t.slice(9, 15).map(n => num(n));
    if (order.slice().sort((a, b) => a - b).join() !== red.join()) { bad++; continue; }

    const sales = num(t[15]) || null;
    const pool = num(t[16]) || null;
    const prize = [];
    let broken = false;
    for (let i = 0; i < 7; i++) {
      const n = num(t[17 + i * 2]);
      const v = num(t[18 + i * 2]);
      if (!Number.isInteger(n) || n < 0) { broken = true; break; }
      /* 奖金列 0 有两种：注数本来就是 0（空开，真），或注数 > 0 却没印奖金（上游漏，假） */
      prize.push([n, v > 0 ? v : null]);
    }
    if (broken) { bad++; continue; }
    out.push({ code: t[0], date, week: weekOf(date), red, blue, sales, pool, prize });
  }
  return { out, bad };
}

async function grab(url, label, referer) {
  for (let tryNo = 1; tryNo <= 2; tryNo++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { ...HEADERS, Referer: referer } });
      if (!res.ok) {
        if (res.status === 429 && tryNo === 1) {
          console.log('[·] ' + label + ' 回 429（它嫌我连发），歇 45 秒再发一次');
          await new Promise(r => setTimeout(r, RETRY_MS));
          continue;
        }
        throw new Error('HTTP ' + res.status);
      }
      const text = await res.text();
      console.log('[·] ' + label + ' 回了 ' + res.status + ' · ' + Buffer.byteLength(text) + ' B');
      return text;
    } catch (e) {
      if (tryNo === 1 && (e.name === 'AbortError' || /fetch failed|ECONN/i.test(String(e.message)))) {
        console.log('[·] ' + label + ' 第一发没通：' + (e.name === 'AbortError' ? '25 秒超时' : e.message) + '，45 秒后重试');
        await new Promise(r => setTimeout(r, RETRY_MS));
        continue;
      }
      console.log('[·] ' + label + ' 没答话：' + (e.name === 'AbortError' ? '25 秒超时' : String(e.message || e)));
      return null;
    } finally { clearTimeout(timer); }
  }
  return null;
}

/* 一处改动就能报警的东西：号码串了是真出事，奖金填法变了是口径变了 */
function digest(d) {
  return d.red.join(',') + '|' + d.blue;
}

async function main() {
  const txt = await grab(TXT, '17500 纯文本', 'https://www.17500.cn/');
  if (!txt) fail('上游没答话，这一轮不动档案');

  const p = parseTxt(txt);
  const rows = p.out;
  if (rows.length < 500) fail('清洗后只有 ' + rows.length + ' 期（丢弃异常行 ' + p.bad + '），远少于预期，判为改版或截断，不写盘');
  rows.sort(byCode);
  const newest = rows[rows.length - 1];

  const dir = path.dirname(target);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  let old = null;
  try { old = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { old = null; }
  const oldCount = old && Array.isArray(old.draws) ? old.draws.length : 0;
  if (old && rows.length < oldCount && !FORCE) {
    fail('新档案 ' + rows.length + ' 期比现有 ' + oldCount + ' 期还少，判为上游截断，不覆盖（确认可覆盖再加 --force）');
  }

  /* 同一期被改号是真实发生过的（官方勘误、或上游自己串了行）⇒ 原值进 fixes，不静默丢。
     销售额和奖池也一起比：它们影响算钱那一栏，值变了同样要留痕。 */
  const fixes = [];
  if (old && Array.isArray(old.draws)) {
    const map = new Map(rows.map(d => [d.code, d]));
    const at = new Date().toISOString();
    for (const d of old.draws) {
      const now = map.get(d.code);
      if (!now) continue;
      const was = digest(d), nowS = digest(now);
      if (was !== nowS) fixes.push({ code: d.code, field: 'num', was, now: nowS, at });
      else if (d.sales != null && now.sales != null && now.sales !== d.sales)
        fixes.push({ code: d.code, field: 'sales', was: d.sales, now: now.sales, at });
      else if (d.pool != null && now.pool != null && now.pool !== d.pool)
        fixes.push({ code: d.code, field: 'pool', was: d.pool, now: now.pool, at });
    }
  }
  if (fixes.length) {
    const numFix = fixes.filter(f => f.field === 'num').length;
    console.log('[!] ' + fixes.length + ' 个字段和现有档案不一致（其中号码 ' + numFix + ' 处）：'
      + fixes.slice(0, 5).map(f => f.code + ' ' + f.field + ' ' + f.was + '→' + f.now).join('、'));
  }

  /* 周一、三、五不开奖，闹钟每半小时一格的其中一大半回来都是「最新期号和文件里一样」。
     这时候只有 fetchedAt 会变 —— 照写就是每周五六条空提交。所以没新期号、条数没变、
     没人改号，就一个字节都不动。条数必须一起比：上游回填旧年份时最新期号不动但档案变长。 */
  if (old && old.asofCode === newest.code && rows.length === oldCount && !fixes.length && !FORCE) {
    console.log('[=] 最新仍是 ' + newest.code + '（' + newest.date + '），上游没有新期号，文件不动');
    return;
  }

  const doc = {
    source: '17500.cn ssq_asc.txt',
    fetchedAt: new Date().toISOString(),
    asof: newest.date,
    asofCode: newest.code,
    count: rows.length,
    first: rows[0].code,
    fixes,
    draws: rows
  };

  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, target);

  console.log('[✓] ' + rows.length + ' 期（' + rows[0].code + ' → ' + newest.code
    + '，红' + newest.red.join(',') + ' 蓝' + newest.blue + '）源=' + doc.source
    + (p.bad ? '，丢弃异常行 ' + p.bad + ' 条' : '')
    + (fixes.length ? '，改号/改值 ' + fixes.length + ' 条' : '')
    + ' 已写入 ' + target + '（' + fs.statSync(target).size + ' B）');
}

main();
