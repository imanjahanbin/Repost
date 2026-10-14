// ربات بله: ارسال آخرین پست‌های کانال‌های عمومی تلگرام
// هر کاربر کانال‌های خودش را اضافه می‌کند و فقط همان‌ها را دریافت می‌کند (مجزا از بقیه).
// تنظیمات را ترجیحاً در Cloudflare: Settings > Variables and Secrets بگذارید.
// اگر آنجا خالی بود، مقدار همین بخش استفاده می‌شود.
const CONFIG = {
  BOT_TOKEN: "YOUR_BALE_BOT_TOKEN",
  ADMIN_ID: "YOUR_ADMIN_ID", // فقط برای پنل مدیریت کلی (آمار/کاربران/لاگ/روشن‌خاموش کلی) — کانال‌ها مال خود کاربرهاست
  SECRET: "CHANGE_ME_TO_RANDOM_TEXT", // رمز آدرس webhook و تست دستی (حداقل 12 کاراکتر)
  FETCHER_URL: "",   // اختیاری: آدرس Fetcher شخصی (فرمت در توضیحات)
  FETCHER_KEY: "",   // اختیاری: توکن Fetcher
  RSS_X: "",         // اختیاری و فقط برای حرفه‌ای‌ها: منبع RSS شخصی توییتر، مثل https://my-rsshub/twitter/user/{u}
  LIMIT: 45,         // سقف درخواست خروجی در هر اجرا (پلن رایگان 50 / پلن پولی مثلاً 900)
  MAX_NEW: 10,       // حداکثر پست جدید از هر کانال در هر بررسی
  MAX_MB: 20,        // حداکثر حجم فایل برای دانلود و آپلود
  BALE_API: "https://tapi.bale.ai",
};

const WELCOME = "سلام 👋\n\nبه ربات اطلاع‌رسانی خوش آمدید.\n\nهر کانال تلگرام یا حساب X (توییتر) که بخواهید را خودتان اضافه می‌کنید و فقط پست‌های همان‌ها برای خودتان ارسال می‌شود (مستقل از سایر کاربران).\n\nبرای توقف کامل دریافت پیام‌ها: /stop";
const BACK = [[["🔙 منو", "menu"]]];
const ABACK = [[["🔙 منوی مدیریت", "a_menu"]]];

let ENV = {}, used = 0, blobs = {};
const C = k => ENV[k] || CONFIG[k];
const isAdmin = id => String(id) === String(C("ADMIN_ID"));
const T = ts => ts ? new Date(ts + 12600000).toISOString().slice(5, 16).replace("T", " ") : "—"; // وقت تهران
const clean = s => { s = String(s); const t = C("BOT_TOKEN"); return (t ? s.split(t).join("***") : s).slice(0, 120); };

const lab = u => /^x:/.test(u) ? u.replace(":", " @") : "@" + u; // برچسب نمایشی
const ico = c => /^x:/.test(c) ? "🐦" : "📢";

// ---------- KV (ENV.DATA) ----------
const kvGet = async (k, d) => { used++; return (await ENV.DATA.get(k, "json")) ?? d; };
const kvSet = (k, v) => { used++; return ENV.DATA.put(k, JSON.stringify(v)); };
const getSet = async () => ({ on: true, backfill: 1, ...(await kvGet("settings", {})) });

async function log(msg) {
  const l = await kvGet("logs", []);
  l.unshift(T(Date.now()) + " " + clean(msg));
  await kvSet("logs", l.slice(0, 30));
}

// ---------- کاربران (هر کاربر یک کلید u:ID، اطلاعات در metadata) ----------
const putUser = u => ENV.DATA.put("u:" + u.id, JSON.stringify(u), { metadata: u });
async function allUsers() {
  const out = []; let cursor;
  do {
    used++;
    const r = await ENV.DATA.list({ prefix: "u:", cursor });
    out.push(...r.keys.map(k => k.metadata).filter(Boolean));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}
async function setActive(id, active) {
  const u = await ENV.DATA.get("u:" + id, "json");
  if (u && u.active !== active) { u.active = active; await putUser(u); }
}

// ---------- کانال‌های هر کاربر (کلید جداگانه uc:ID، کاملاً مجزا از بقیه) ----------
const getChans = (id) => kvGet("uc:" + id, []);
const setChans = (id, list) => kvSet("uc:" + id, list);
async function allChanKeys() { // فهرست کلیدهای uc:* برای Cron (بدون محتوا)
  const out = []; let cursor;
  do {
    used++;
    const r = await ENV.DATA.list({ prefix: "uc:", cursor });
    out.push(...r.keys.map(k => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

// ---------- API بله ----------
async function bale(method, data = {}) {
  used++;
  let body, headers = {};
  if (Object.values(data).some(v => v instanceof Blob)) {
    body = new FormData();
    for (const [k, v] of Object.entries(data))
      v instanceof Blob ? body.append(k, v, v.name || "file") : body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  } else { body = JSON.stringify(data); headers["Content-Type"] = "application/json"; }
  try {
    const r = await fetch(`${C("BALE_API")}/bot${C("BOT_TOKEN")}/${method}`, { method: "POST", headers, body });
    return await r.json();
  } catch (e) { return { ok: false, error_code: 0, description: "network error" }; }
}
const kb = rows => ({ inline_keyboard: rows.map(r => r.map(([text, cb]) => ({ text, callback_data: cb }))) });

// ویرایش همان پیام (در صورت نبودن mid، پیام جدید)
async function show(ctx, text, rows) {
  text = text.slice(0, 4000);
  if (ctx.mid) {
    const r = await bale("editMessageText", { chat_id: ctx.chat, message_id: ctx.mid, text, reply_markup: kb(rows) });
    if (r.ok || /modif/i.test(r.description || "")) return;
  }
  return bale("sendMessage", { chat_id: ctx.chat, text, reply_markup: kb(rows) });
}
async function sendText(chat, text) {
  let r;
  for (let i = 0; i < text.length; i += 4000) r = await bale("sendMessage", { chat_id: chat, text: text.slice(i, i + 4000) });
  return r;
}

// ---------- دریافت پست‌ها (Fetcher) — جدا از ارسال ----------
// خروجی: { title, posts: [{ id, text, photo, video, audio, file }] }
async function getPosts(u) {
  const sm = u.match(/^x:(.+)$/);
  if (sm) return getX(sm[1]);
  used++;
  if (C("FETCHER_URL")) { // منبع واسط شخصی شما
    const r = await fetch(`${C("FETCHER_URL")}?channel=${u}`, { headers: { Authorization: "Bearer " + C("FETCHER_KEY") } });
    if (!r.ok) throw new Error("fetcher " + r.status);
    return await r.json();
  }
  // پیش‌نمایش عمومی وب تلگرام (غیررسمی؛ ممکن است تغییر کند)
  const r = await fetch(`https://t.me/s/${u}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("telegram " + r.status);
  const html = await r.text();
  if (!html.includes("tgme_widget_message")) throw new Error("کانال عمومی نیست یا پیش‌نمایش وب ندارد");
  return parseHtml(html, u);
}
const dec = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function parseHtml(html, u) {
  const title = dec((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || u);
  const posts = [];
  for (const part of html.split("tgme_widget_message_wrap").slice(1)) {
    const id = +((part.match(/data-post="[^"\/]+\/(\d+)"/) || [])[1] || 0);
    if (!id) continue;
    const t = (part.match(/js-message_text"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
    const text = dec(t.replace(/<br\s*\/?>/g, "\n")
      .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, h, x) => /^[#@]|^https?:/.test(x.replace(/<[^>]+>/g, "")) ? x : x + " (" + h + ")")
      .replace(/<[^>]+>/g, "")).trim();
    posts.push({
      id, text,
      photo: (part.match(/tgme_widget_message_photo_wrap[^>]*url\('([^']+)'\)/) || [])[1],
      video: (part.match(/<video[^>]*src="([^"]+)"/) || [])[1],
      audio: (part.match(/<audio[^>]*src="([^"]+)"/) || [])[1],
      file: /tgme_widget_message_document/.test(part),
    });
  }
  return { title, posts };
}

// ---------- X (توییتر): بدون کلید و بدون تنظیمات ----------
// چند منبع عمومی به‌ترتیب امتحان می‌شود. شناسه‌ی پست = زمان انتشار (از روی snowflake شناسه‌ی توییت).
const UA = { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" };
const NITTERS = ["https://nitter.net", "https://nitter.poast.org", "https://nitter.privacyredirect.com"];
const snow = id => Number((BigInt(id) >> 22n) + 1288834974657n);
async function getX(name) {
  const nm = encodeURIComponent(name);
  if (C("RSS_X")) { // منبع شخصی (اختیاری)
    used++;
    const r = await fetch(C("RSS_X").split("{u}").join(nm), { headers: UA });
    if (!r.ok) throw new Error("rss " + r.status);
    return parseRss(await r.text(), name);
  }
  try { return await xSyndication(name, nm); } catch (e) { /* برو سراغ منبع بعدی */ }
  for (const base of NITTERS) {
    try {
      used++;
      const r = await fetch(`${base}/${nm}/rss`, { headers: UA });
      const xml = r.ok ? await r.text() : "";
      if (/<rss|<channel/.test(xml)) return parseRss(xml, name);
    } catch (e) { /* منبع بعدی */ }
  }
  throw new Error("دریافت پست‌های X ممکن نشد (حساب خصوصی/ناموجود است یا منبع رایگان موقتاً در دسترس نیست)");
}
async function xSyndication(name, nm) {
  used++;
  const r = await fetch(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${nm}`, { headers: UA });
  if (!r.ok) throw new Error("syndication " + r.status);
  const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("format");
  const entries = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries || [];
  const posts = []; let title = "";
  for (const en of entries) {
    const t = en.content && (en.content.tweet || en.content);
    if (en.type !== "tweet" || !t || !t.id_str) continue;
    const u = t.user || {};
    if (!title && u.name) title = `${u.name} (@${u.screen_name || name})`;
    let text = t.full_text || t.text || "";
    for (const x of (t.entities?.urls || [])) text = text.split(x.url).join(x.expanded_url || x.url);
    const media = t.extended_entities?.media || t.entities?.media || [];
    for (const x of media) text = text.split(x.url).join("");
    let photo, video;
    for (const x of media) {
      if (x.type === "photo" && !photo) photo = x.media_url_https;
      if ((x.type === "video" || x.type === "animated_gif") && !video) {
        const v = (x.video_info?.variants || []).filter(z => z.content_type === "video/mp4").sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        video = v.length ? (v.find(z => (z.bitrate || 0) <= 1300000) || v[v.length - 1]).url : undefined;
        if (!video && !photo) photo = x.media_url_https;
      }
    }
    posts.push({ id: snow(t.id_str), text: dec(text).trim(), photo, video, link: `https://x.com/${u.screen_name || name}/status/${t.id_str}` });
  }
  if (!posts.length) throw new Error("empty");
  return { title: title || "X @" + name, posts };
}
function parseRss(xml, name) {
  const cd = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const tag = (s, t) => { const m = s.match(new RegExp("<" + t + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + t + ">")); return m ? cd(m[1]).trim() : ""; };
  const html2text = h => dec(h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, hr, x) => /^[#@]|^https?:/.test(x.replace(/<[^>]+>/g, "")) ? x : x + " (" + hr + ")")
    .replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
  const parts = xml.split(/<item[\s>]/);
  const posts = [];
  for (const part of parts.slice(1)) {
    const link0 = dec(tag(part, "link")), sid = link0.match(/status\/(\d+)/);
    const id = sid ? snow(sid[1]) : Date.parse(tag(part, "pubDate"));
    if (!id) continue;
    let d = tag(part, "description") || tag(part, "title");
    if (!/<[a-z]/i.test(d)) d = dec(d);
    const img = (d.match(/<img[^>]+src="([^"]+)"/i) || [])[1], vid = (d.match(/<video[^>]*src="([^"]+)"/i) || [])[1];
    posts.push({ id, text: html2text(d), photo: img && dec(img), video: vid && dec(vid), link: sid ? "https://x.com/i/status/" + sid[1] : link0 });
  }
  return { title: dec(tag(parts[0], "title")) || "X @" + name, posts };
}

// ---------- ارسال پست به یک کاربر ----------
async function download(url, f) {
  if (blobs[url] !== undefined) return blobs[url];
  used++;
  try {
    const r = await fetch(url);
    if (!r.ok || +(r.headers.get("content-length") || 0) > C("MAX_MB") * 1048576) return (blobs[url] = null);
    const b = await r.arrayBuffer();
    return (blobs[url] = new File([b], { photo: "p.jpg", video: "v.mp4", audio: "a.ogg" }[f], { type: r.headers.get("content-type") || "" }));
  } catch (e) { return (blobs[url] = null); }
}
const fid = (m, f) => f === "photo" ? m.photo && m.photo.slice(-1)[0].file_id : m[f] && m[f].file_id;

async function sendPost(it, chat) {
  const p = it.p;
  const text = `${ico(it.c)} ${it.t}\n\n${p.text || ""}${p.file ? "\n\n📎 فایل ضمیمه فقط در تلگرام قابل دریافت است." : ""}\n\n🔗 مشاهده پست اصلی\n${p.link || `https://t.me/${it.c}/${p.id}`}`;
  const f = ["photo", "video", "audio"].find(x => p[x]);
  if (f) {
    const short = text.length <= 1000, cap = short ? text : `${ico(it.c)} ${it.t}`;
    const m = "send" + f[0].toUpperCase() + f.slice(1);
    let r = it.f && await bale(m, { chat_id: chat, [f]: it.f, caption: cap }); // استفاده مجدد از file_id
    if (!(r && r.ok) && !(r && r.error_code === 403)) {
      const file = await download(p[f], f);
      if (file) r = await bale(m, { chat_id: chat, [f]: file, caption: cap });
    }
    if (r && r.ok) { it.f = fid(r.result, f); return short ? r : sendText(chat, text); }
    if (r && r.error_code === 403) return r;
  }
  return sendText(chat, text); // اگر رسانه ارسال نشد، متن + لینک
}

// ---------- Cron: جمع‌آوری و ارسال ----------
// نکته‌ی اصلی: کانال‌های هر کاربر در uc:<id> جدا نگه‌داری می‌شوند.
// اگر چند کاربر یک کانال مشترک را اضافه کرده باشند، در یک اجرا فقط یک‌بار fetch می‌شود (برای صرفه‌جویی در سهمیه)،
// ولی وضعیت last/recent/err و روشن‌خاموش هرکدام کاملاً مستقل است.
async function collect(s, q) {
  const keys = await allChanKeys();
  const entries = []; // {uid, key, idx}
  const lists = {};   // key -> آرایه‌ی کانال‌های همان کاربر (برای ذخیره‌ی مجدد در پایان)
  for (const key of keys) {
    used++;
    const list = (await ENV.DATA.get(key, "json")) || [];
    lists[key] = list;
    list.forEach((c, idx) => { if (c.on) entries.push({ uid: key.slice(3), key, idx }); });
  }
  const min = Math.floor(Date.now() / 60000), off = entries.length ? min % entries.length : 0;
  const order = [...entries.slice(off), ...entries.slice(0, off)];
  const fetched = {}; // کش fetch در همین اجرا، به ازای نام کانال
  const getCached = async u => {
    if (!(u in fetched)) {
      try { fetched[u] = { ok: true, data: await getPosts(u) }; }
      catch (e) { fetched[u] = { ok: false, err: e }; }
    }
    return fetched[u];
  };
  for (const e of order) {
    if (used > Number(C("LIMIT")) / 2) break;
    const c = lists[e.key][e.idx];
    if (!c || !c.on) continue;
    const pe = c.err;
    c.checked = Date.now();
    try {
      const cr = await getCached(c.u);
      if (!cr.ok) throw cr.err;
      const r = cr.data, posts = r.posts.sort((a, b) => a.id - b.id);
      if (r.title) c.title = r.title;
      const max = posts.length ? posts[posts.length - 1].id : 0;
      const fresh = (c.last
        ? posts.filter(p => p.id > c.last && !c.recent.includes(p.id))
        : posts.slice(Math.max(0, posts.length - s.backfill))).slice(-Number(C("MAX_NEW")));
      if (fresh.length) {
        for (const p of fresh) q.push({ c: c.u, t: c.title, p, to: [e.uid], i: 0 });
        c.recent = [...c.recent, ...fresh.map(p => p.id)].slice(-50);
      }
      c.last = Math.max(c.last, max); c.err = "";
    } catch (err) { c.err = clean(err.message || err); }
    if (c.err && c.err !== pe) await log(`کاربر ${e.uid} / @${c.u}: ${c.err}`);
  }
  for (const key of Object.keys(lists)) await kvSet(key, lists[key]);
}

async function deliver(q) {
  let n = 0;
  while (q.length && used < Number(C("LIMIT")) - 4) {
    const it = q[0], chat = it.to[it.i];
    if (chat === undefined) { q.shift(); continue; }
    const r = await sendPost(it, chat), code = r && r.error_code;
    if (!(r && r.ok) && (code === 429 || code === 0) && (it.tries = (it.tries || 0) + 1) < 5) break; // خطای موقت: دقیقه بعد
    it.tries = 0;
    if (!(r && r.ok)) {
      if (code === 403 || /chat not found/i.test((r && r.description) || "")) await setActive(chat, false);
      else await log(`ارسال به ${chat}: ${r && r.description}`);
    }
    it.i++;
    if (++n % 10 === 0) { await kvSet("queue", q); await kvSet("lock", Date.now()); }
  }
  await kvSet("queue", q);
}

async function run(force) {
  used = 0; blobs = {};
  const s = await getSet();
  if (!s.on && !force) return "⏸ ارسال خودکار (کلی) خاموش است";
  if (Date.now() - await kvGet("lock", 0) < 120000) return "⏳ اجرای قبلی هنوز تمام نشده";
  const q = await kvGet("queue", []);
  await collect(s, q);
  if (q.length) {
    await kvSet("queue", q); // ابتدا ذخیره کانال‌ها (در collect)، سپس صف: ارسال تکراری ممنوع
    await kvSet("lock", Date.now());
    try { await deliver(q); } finally { await kvSet("lock", 0); }
  }
}

// ---------- منوی شخصی هر کاربر (کانال‌های خودش) ----------
const userMenu = ctx => show(ctx, "📋 منوی من\n\nکانال‌هایی که اضافه می‌کنید فقط برای خودتان ارسال می‌شود.", [
  [["📢 کانال‌های من", "ch"], ["➕ افزودن کانال", "add"]],
  [["🗑 حذف کانال", "del"], ["📋 جزئیات کانال‌هایم", "list"]],
]);
const parseCh = t => {
  t = t.trim();
  let x = t.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/@?([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i) || t.match(/^(?:x|tw|twitter):@?([A-Za-z0-9_]{1,15})$/i);
  if (x) return "x:" + x[1].toLowerCase();
  const m = t.match(/^(?:https?:\/\/)?(?:t\.me\/(?:s\/)?|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:\d+\/?)?(?:\?.*)?$/);
  return m && m[1].toLowerCase();
};

// ---------- پنل مدیریت کلی (فقط ADMIN_ID) ----------
const adminMenu = async ctx => {
  const s = await getSet();
  return show(ctx, `⚙️ پنل مدیریت کلی\n\nارسال خودکار (کلی): ${s.on ? "روشن" : "خاموش"}\nتعداد پست اولیه پیش‌فرض برای کانال جدید: ${s.backfill}`, [
    [["👥 کاربران", "a_usr"], ["📊 آمار کلی", "a_st"]],
    [["📝 لاگ خطاها", "a_log"]],
    [["🔄 اجرای دستی بررسی همه", "a_chk"]],
    [[s.on ? "⏸ خاموش کردن ارسال کلی" : "▶️ روشن کردن ارسال کلی", "a_on"]],
    [["🔢 تغییر تعداد پست اولیه پیش‌فرض", "a_bf"]],
  ]);
};

async function onCallback(q) {
  const id = q.from.id, ctx = { chat: id, mid: q.message && q.message.message_id };
  await bale("answerCallbackQuery", { callback_query_id: q.id });
  const dd = String(q.data), ci = dd.indexOf(":");
  let a = ci < 0 ? dd : dd.slice(0, ci), arg = ci < 0 ? undefined : dd.slice(ci + 1);

  // ---- اقدامات پنل مدیریت کلی: فقط ادمین ----
  if (a.startsWith("a_")) {
    if (!isAdmin(id)) return;
    if (a === "a_usr") {
      const us = (await allUsers()).sort((x, y) => y.joined - x.joined);
      const txt = us.slice(0, 15).map(u => `${u.active ? "🟢" : "🔴"} ${u.first_name || "-"} ${u.username ? "@" + u.username : ""} (${u.id})`).join("\n");
      return show(ctx, `👥 کاربران: ${us.length} (فعال: ${us.filter(u => u.active).length})\n\n${txt}`, ABACK);
    }
    if (a === "a_st") {
      const us = await allUsers(), qn = (await kvGet("queue", [])).length, keys = await allChanKeys();
      let total = 0, totalOn = 0, errs = 0, distinct = new Set();
      for (const key of keys) {
        used++;
        const list = (await ENV.DATA.get(key, "json")) || [];
        for (const c of list) { total++; if (c.on) totalOn++; if (c.err) errs++; distinct.add(c.u); }
      }
      return show(ctx, `📊 آمار کلی\n\n👥 کاربران: ${us.length} (فعال: ${us.filter(u => u.active).length})\n📢 اشتراک‌های کانال: ${total} (روشن: ${totalOn})\n🔗 کانال‌های یکتا: ${distinct.size}\n📨 در صف ارسال: ${qn}\n⚠️ اشتراک‌های دارای خطا: ${errs}`, ABACK);
    }
    if (a === "a_log") return show(ctx, "📝 آخرین خطاها (وقت تهران)\n\n" + ((await kvGet("logs", [])).slice(0, 15).join("\n") || "خطایی ثبت نشده."), ABACK);
    if (a === "a_chk") {
      await show(ctx, "⏳ در حال بررسی همه‌ی کاربران...", []);
      const r = await run(true), n = (await kvGet("queue", [])).length;
      return show(ctx, `${r || "✅ بررسی انجام شد"}\n📨 باقی‌مانده در صف ارسال: ${n}`, ABACK);
    }
    const s = await getSet();
    if (a === "a_on") { s.on = !s.on; await kvSet("settings", s); }
    if (a === "a_bf") { s.backfill = ({ 0: 1, 1: 3, 3: 5, 5: 0 })[s.backfill] ?? 1; await kvSet("settings", s); }
    return adminMenu(ctx);
  }
  if (a === "a_menu") { if (!isAdmin(id)) return; return adminMenu(ctx); }

  // ---- مدیریت کانال‌های شخصی: هر کاربر فقط مال خودش را می‌بیند/تغییر می‌دهد ----
  const list = await getChans(id);
  if (a === "t") { const c = list.find(c => c.u === arg); if (c) { c.on = !c.on; await setChans(id, list); } a = "ch"; }
  if (a === "d") { const i = list.findIndex(c => c.u === arg); if (i > -1) { list.splice(i, 1); await setChans(id, list); } a = "del"; }

  if (a === "ch") return show(ctx, "📢 کانال‌های من\n(برای فعال/غیرفعال کردن لمس کنید)" + (list.length ? "" : "\n\nهنوز کانالی اضافه نکرده‌اید."),
    list.map(c => [[(c.on ? "🟢 " : "⚪️ ") + lab(c.u), "t:" + c.u]]).concat(BACK));
  if (a === "add") {
    await kvSet("ustate:" + id, "add");
    return show(ctx, "➕ کانال تلگرام یا حساب X را بفرستید.\nهر چندتا خواستید یکجا بفرستید (هر کدام در یک خط یا با فاصله، حداکثر ۸ مورد در هر پیام):\n\n@durov\nhttps://t.me/channelname\nhttps://x.com/username\nx:username", BACK);
  }
  if (a === "del") return show(ctx, "🗑 حذف کانال\nکانال موردنظر را لمس کنید:", list.map(c => [["🗑 " + lab(c.u), "d:" + c.u]]).concat(BACK));
  if (a === "list") {
    const txt = list.map((c, i) => `${i + 1}. ${lab(c.u)}\n   عنوان: ${c.title}\n   آخرین پیام: ${c.last || "—"}\n   وضعیت: ${c.on ? "فعال" : "غیرفعال"}\n   آخرین بررسی: ${T(c.checked)}` + (c.err ? `\n   ⚠️ خطا: ${c.err}` : "")).join("\n\n");
    return show(ctx, "📋 جزئیات کانال‌های من\n\n" + (txt || "کانالی ثبت نشده."), BACK);
  }
  return userMenu(ctx);
}

async function onMessage(m) {
  if (!m.text || !m.from) return;
  const id = m.from.id, text = m.text.trim(), ctx = { chat: id };
  if (text.startsWith("/start") || text === "/stop") {
    const old = await ENV.DATA.get("u:" + id, "json");
    await putUser({ id, username: (m.from.username || "").slice(0, 32), first_name: (m.from.first_name || "").slice(0, 40), joined: (old && old.joined) || Date.now(), active: text !== "/stop" });
    if (text === "/stop") return bale("sendMessage", { chat_id: id, text: "⏹ دریافت پیام‌ها متوقف شد. برای فعال‌سازی دوباره: /start" });
    const rows = [[["📋 منوی من", "menu"]]];
    if (isAdmin(id)) rows.push([["⚙️ پنل مدیریت کلی", "a_menu"]]);
    return bale("sendMessage", { chat_id: id, text: WELCOME, reply_markup: kb(rows) });
  }
  if (text === "/menu") return userMenu(ctx);
  if (text === "/admin") { if (!isAdmin(id)) return; return adminMenu(ctx); }

  if (await kvGet("ustate:" + id, null) === "add") {
    const toks = [...new Set(text.split(/[\s,،؛;]+/).filter(Boolean))], found = toks.map(parseCh);
    if (!found.some(Boolean)) return bale("sendMessage", { chat_id: id, text: "❌ آدرس نامعتبر است. مثال:\n@channelname\nhttps://x.com/username\nx:username" });
    const list = await getChans(id), ok = [], dup = [], bad = [], rest = [];
    let tried = 0;
    for (const [i, u] of found.entries()) {
      if (!u) { bad.push(`${toks[i].slice(0, 40)} (آدرس نامعتبر)`); continue; }
      if (list.some(c => c.u === u)) { dup.push(lab(u)); continue; }
      if (list.length >= 50 || ++tried > 8) { rest.push(lab(u)); continue; }
      try {
        const r = await getPosts(u);
        list.push({ u, title: r.title || u, on: true, last: 0, recent: [], checked: 0, err: "", added: Date.now() });
        ok.push(`${lab(u)} — ${r.title || u}`);
      } catch (e) { bad.push(`${lab(u)} (${clean(e.message || e)})`); }
    }
    if (ok.length) { await setChans(id, list); await kvSet("ustate:" + id, null); }
    const out = [
      ok.length && `✅ اضافه شد (${ok.length}):\n${ok.join("\n")}\n\nپست‌های جدید از اجرای بعدی (حداکثر یک دقیقه) برای شما ارسال می‌شود.`,
      dup.length && `⚠️ قبلاً اضافه شده:\n${dup.join("\n")}`,
      bad.length && `❌ ناموفق:\n${bad.join("\n")}`,
      rest.length && `⏭ در این پیام جا نشد (سقف ۸ مورد در هر پیام / ۵۰ مورد برای هر کاربر):\n${rest.join("\n")}`,
    ].filter(Boolean).join("\n\n");
    return show(ctx, out, BACK);
  }
}

// ---------- Worker ----------
export default {
  async fetch(request, env, ctx) {
    ENV = env;
    const url = new URL(request.url), p = url.pathname.split("/"), sec = C("SECRET");
    if (!sec || sec.length < 12 || p[2] !== sec) return new Response("Not found", { status: 404 });
    if (p[1] === "webhook" && request.method === "POST") {
      const u = await request.json();
      ctx.waitUntil((u.callback_query ? onCallback(u.callback_query) : u.message ? onMessage(u.message) : 0).catch(e => log("update: " + (e.message || e))));
      return new Response("ok");
    }
    if (p[1] === "setup") { // یک‌بار در مرورگر باز کنید: ثبت webhook
      const r = await bale("setWebhook", { url: `${url.origin}/webhook/${sec}` });
      return new Response(JSON.stringify({ ok: r.ok, description: r.description }, null, 1));
    }
    if (p[1] === "cron") { // تست دستی Cron
      const r = await run(true);
      return new Response((r || "done") + "\nqueue: " + (await kvGet("queue", [])).length + "\nlogs:\n" + (await kvGet("logs", [])).slice(0, 10).join("\n"));
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ENV = env;
    ctx.waitUntil(run().catch(e => log("cron: " + (e.message || e))));
  },
};
