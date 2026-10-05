
// =====================================================================
// НОВЫЕ ВОЗМОЖНОСТИ (добавлено скриптом tools/apply_patch.py)
//  1. Голосовые сообщения в Telegram (Whisper)
//  2. MCP-сервер: POST /mcp (задачи, память, расписание, курсы, калькулятор)
//  3. Кнопки 👍/👎 под ответами бота + API для сайта + просмотр в /admin
//  4. «Умная» память: в запрос идут только релевантные факты
//  5. Дневной лимит запросов на пользователя
//  6. Кэш результатов веб-поиска (D1)
// Новые секреты и переменные (все необязательные):
//   MCP_TOKEN (секрет) + MCP_EMAIL (почта вашего аккаунта на сайте) или MCP_UID, MCP_TZ (минуты, по умолчанию 180)
//   USER_DAILY_LIMIT (число, по умолчанию 30 «единиц» в сутки на пользователя)
// =====================================================================

// ---------- 5. лимит на пользователя ----------
let usageReady = false;
async function takeQuota(env, uid, cost) {
  if (!env.DB || !uid) return true;
  const limit = parseInt(env.USER_DAILY_LIMIT) || 30;
  try {
    if (!usageReady) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, day))").run();
      usageReady = true;
    }
    const day = new Date().toISOString().slice(0, 10);
    const r = await env.DB.prepare("INSERT INTO usage (uid, day, n) VALUES (?, ?, ?) ON CONFLICT(uid, day) DO UPDATE SET n = n + excluded.n RETURNING n")
      .bind(uid, day, cost).first();
    if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM usage WHERE day < ?").bind(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).run();
    return !r || r.n <= limit;
  } catch (e) { return true; }                       // база недоступна: не блокируем пользователя
}
const quotaMsg = "Дневной лимит запросов исчерпан. Он обновится завтра.";

// ---------- 6. кэш веб-поиска ----------
const SC_TTL = 3 * 3600 * 1000;                      // 3 часа: новости быстро устаревают
let scReady = false;
async function scTable(env) {
  if (scReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS search_cache (q TEXT PRIMARY KEY, t INTEGER NOT NULL, data TEXT NOT NULL)").run();
  scReady = true;
}
const scKey = (q) => String(q).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
async function searchCacheGet(env, q) {
  if (!env.DB) return null;
  try {
    await scTable(env);
    const r = await env.DB.prepare("SELECT data FROM search_cache WHERE q = ? AND t > ?").bind(scKey(q), Date.now() - SC_TTL).first();
    return r ? JSON.parse(r.data) : null;
  } catch (e) { return null; }
}
async function searchCacheSet(env, q, list) {
  if (!env.DB) return;
  try {
    await scTable(env);
    await env.DB.prepare("INSERT OR REPLACE INTO search_cache (q, t, data) VALUES (?, ?, ?)").bind(scKey(q), Date.now(), JSON.stringify(list)).run();
    if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM search_cache WHERE t < ?").bind(Date.now() - 24 * 3600 * 1000).run();
  } catch (e) { /* кэш не должен ломать поиск */ }
}
// старая функция переименована в webSearchRaw, эта оборачивает её кэшем
async function webSearch(env, q) {
  const hit = await searchCacheGet(env, q);
  if (hit) return hit;
  const list = await webSearchRaw(env, q);
  if (list && list.length) await searchCacheSet(env, q, list);
  return list;
}

// ---------- 4. умная память ----------
// Если фактов немного, отдаём все. Иначе: до 6 фактов, пересекающихся по словам с вопросом, и 3 самых свежих.
function memSelect(list, query) {
  if (!list || list.length <= 10) return list || [];
  if (/помн|памят|обо мне|забуд|запомн|remember|forget|memory/i.test(String(query))) return list;
  const stem = (w) => w.slice(0, 5);
  const words = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).map(stem);
  const q = new Set(words(query));
  const hit = list
    .map((m, i) => { let s = 0; for (const w of new Set(words(m.fact))) if (q.has(w)) s++; return { m, s, i }; })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.i - a.i)
    .slice(0, 6)
    .map((x) => x.m);
  const out = new Map();
  for (const m of [...hit, ...list.slice(-3)]) out.set(m.id, m);   // list идёт от старых к новым
  return [...out.values()].sort((a, b) => a.id - b.id);
}

// ---------- 3. обратная связь 👍/👎 ----------
let fbReady = false;
async function fbTable(env) {
  if (fbReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, src TEXT, uid TEXT NOT NULL, q TEXT, a TEXT, rating INTEGER)").run();
  fbReady = true;
}
async function fbAdd(env, src, uid, q, a, rating) {
  await fbTable(env);
  const r = await env.DB.prepare("INSERT INTO feedback (t, src, uid, q, a, rating) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(Date.now(), src, uid, String(q || "").slice(0, 500), String(a || "").slice(0, 800), rating).run();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM feedback WHERE t < ?").bind(Date.now() - 90 * 86400000).run();
  return r.meta && r.meta.last_row_id;
}
// сайт: {mode:"feedback", q, a, rating: 1|0}
async function feedbackApi(env, body, json, uid) {
  if (!uid) return json({ error: "login" }, 403);
  if (!env.DB) return json({ error: "no db" }, 501);
  const rating = body.rating === 1 || body.rating === true ? 1 : body.rating === 0 || body.rating === false ? 0 : null;
  if (rating === null) return json({ error: "bad rating" }, 400);
  try { await fbAdd(env, "web", uid, body.q, body.a, rating); return json({ ok: true }); }
  catch (e) { return json({ error: "db", detail: errText(e) }, 502); }
}
// /admin: {"action":"feedback","only_bad":true,"limit":30}
async function feedbackList(env, b, json) {
  await fbTable(env);
  const lim = Math.min(Math.max(parseInt(b.limit) || 30, 1), 100);
  const r = await env.DB.prepare("SELECT id, t, src, q, a, rating FROM feedback " + (b.only_bad ? "WHERE rating = 0 " : "") + "ORDER BY id DESC LIMIT ?").bind(lim).all();
  const s = await env.DB.prepare("SELECT SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS up, SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) AS down FROM feedback").first();
  return json({ up: (s && s.up) | 0, down: (s && s.down) | 0, items: (r.results || []).map((x) => ({ ...x, time: new Date(x.t).toISOString() })) });
}
// нажатие кнопки в Telegram: f:ID:1 или f:ID:0
async function tgFeedbackCb(env, cq, chat, lk, data) {
  const m = cq.message;
  const p = /^f:(\d{1,12}):([01])$/.exec(data);
  if (!p) { await tgCall(env, "answerCallbackQuery", { callback_query_id: cq.id }); return; }
  await fbTable(env);
  await env.DB.prepare("UPDATE feedback SET rating = ? WHERE id = ? AND uid = ?").bind(+p[2], +p[1], lk.uid).run();
  await tgCall(env, "answerCallbackQuery", { callback_query_id: cq.id, text: p[2] === "1" ? "Спасибо! 👍" : "Понял, разберём 👎" });
  await tgCall(env, "editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } });
}

// ---------- обычный чат с агентом в Telegram (замена старой tgChat: лимит + кнопки оценки) ----------
async function tgChat(env, chat, lk, text) {
  try {
    if (!(await takeQuota(env, lk.uid, 1))) { await tgSend(env, chat, quotaMsg, { reply_markup: MAIN_KB }); return; }
    fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendChatAction", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, action: "typing" }),
    }).catch(() => {});
    await tgHistTable(env);
    const h = await env.DB.prepare("SELECT role, content FROM tg_hist WHERE chat_id = ? AND t > ? ORDER BY id DESC LIMIT 8")
      .bind(chat, Date.now() - 6 * 3600 * 1000).all();
    const hist = (h.results || []).reverse().map((x) => ({ role: x.role, content: x.content }));
    const msgs = [...hist, { role: "user", content: text }];
    const sctx = await scheduleContext(env, lk.uid, lk.tz).catch(() => "");
    const r = await agentCore(env, msgs, sctx, lk.uid, lk.tz, null, { src: "tg" });
    const answer = tgPlain(r.text);
    await env.DB.prepare("INSERT INTO tg_hist (chat_id, role, content, t) VALUES (?, 'user', ?, ?)").bind(chat, text.slice(0, 1000), Date.now()).run();
    await env.DB.prepare("INSERT INTO tg_hist (chat_id, role, content, t) VALUES (?, 'assistant', ?, ?)").bind(chat, answer.slice(0, 1500), Date.now()).run();
    await env.DB.prepare("DELETE FROM tg_hist WHERE chat_id = ? AND id NOT IN (SELECT id FROM tg_hist WHERE chat_id = ? ORDER BY id DESC LIMIT 16)").bind(chat, chat).run();
    let extra = { reply_markup: MAIN_KB };
    try {
      const fid = await fbAdd(env, "tg", lk.uid, text, answer, null);
      if (fid) extra = { reply_markup: { inline_keyboard: [[{ text: "👍", callback_data: "f:" + fid + ":1" }, { text: "👎", callback_data: "f:" + fid + ":0" }]] } };
    } catch (e) { /* без кнопок оценки ответ всё равно уйдёт */ }
    await tgSend(env, chat, answer, extra);
  } catch (e) {
    await tgSend(env, chat, isQuota(e)
      ? "Дневной лимит ИИ исчерпан. Попробуй позже."
      : "Не получилось ответить. Попробуй ещё раз.");
  }
}

// ---------- 1. голосовые сообщения ----------
const WHISPER_MODELS = ["@cf/openai/whisper-large-v3-turbo", "@cf/openai/whisper"];
async function transcribe(env, buf) {
  let lastErr = "";
  for (const model of WHISPER_MODELS) {
    try {
      // turbo принимает base64-строку, обычный whisper принимает массив байтов
      const input = model.includes("turbo") ? { audio: bytesB64(buf) } : { audio: Array.from(new Uint8Array(buf)) };
      const out = await env.AI.run(model, input);
      const t = String((out && (out.text || out.response)) || "").trim();
      if (t) return t;
      lastErr = model + ": empty";
    } catch (e) {
      if (isQuota(e)) throw e;
      lastErr = model + ": " + errText(e);
    }
  }
  throw new Error(lastErr || "transcribe failed");
}
async function tgVoice(env, m) {
  const chat = String(m.chat.id);
  const say = (t) => tgSend(env, chat, t, { reply_markup: MAIN_KB });
  try {
    await tgTables(env);
    const lk = await env.DB.prepare("SELECT uid, tz FROM tg_links WHERE chat_id = ?").bind(chat).first();
    if (!lk) { await say("Сначала подключите Telegram на сайте: «Задачи» → «Подключить Telegram»."); return; }
    const v = m.voice || m.audio;
    if ((v.duration || 0) > 90) { await say("Голосовое длиннее 90 секунд. Запиши покороче."); return; }
    if ((v.file_size || 0) > 5000000) { await say("Файл слишком большой."); return; }
    if (!(await takeQuota(env, lk.uid, 1))) { await say(quotaMsg); return; }
    fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendChatAction", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, action: "typing" }),
    }).catch(() => {});
    const gf = await (await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/getFile?file_id=" + encodeURIComponent(v.file_id), { signal: AbortSignal.timeout(10000) })).json();
    const path = gf && gf.ok && gf.result && gf.result.file_path;
    if (!path) { await say("Не удалось получить голосовое от Telegram."); return; }
    const fr = await fetch("https://api.telegram.org/file/bot" + env.TG_BOT_TOKEN + "/" + path, { signal: AbortSignal.timeout(15000) });
    if (!fr.ok) { await say("Не удалось скачать голосовое."); return; }
    const text = await transcribe(env, await fr.arrayBuffer());
    if (!text) { await say("Не удалось разобрать речь. Скажи чётче или напиши текстом."); return; }
    await tgSend(env, chat, "🎤 Распознано: " + text.slice(0, 500));
    await tgChat(env, chat, lk, text.slice(0, 1000));
  } catch (e) {
    await say(isQuota(e) ? "Дневной лимит ИИ исчерпан. Попробуй позже." : "Не получилось обработать голосовое. Напиши текстом.");
  }
}

// ---------- 2. MCP-сервер ----------
// Протокол: JSON-RPC 2.0 поверх HTTP POST (Streamable HTTP, без сессий и без потока).
// Доступ: секрет MCP_TOKEN. Передаётся заголовком Authorization: Bearer ... или в адресе ?key=...
// Инструменты работают от имени ОДНОГО аккаунта: MCP_EMAIL (почта на сайте) или MCP_UID.
const MCP_TOOLS = new Set(["get_schedule", "exchange_rate", "calculator", "add_task", "list_tasks", "complete_task", "delete_task", "remember", "forget"]);
const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
async function mcpUid(env) {
  if (env.MCP_UID) return String(env.MCP_UID);
  if (env.MCP_EMAIL && env.DB) {
    try {
      const r = await env.DB.prepare("SELECT sub FROM users WHERE lower(email) = ? LIMIT 1").bind(String(env.MCP_EMAIL).trim().toLowerCase()).first();
      if (r) return String(r.sub);
    } catch (e) {}
  }
  return "";
}
async function mcpHandle(env, msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: (msg && msg.id) === undefined ? null : msg.id, error: { code: -32600, message: "invalid request" } };
  }
  if (msg.id === undefined || msg.id === null) return null;          // уведомление: ответа нет
  const id = msg.id;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const p = msg.params || {};
  if (msg.method === "initialize") {
    return ok({
      protocolVersion: MCP_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : MCP_VERSIONS[1],
      capabilities: { tools: {} },
      serverInfo: { name: "yasik-ai", version: "1.0.0" },
      instructions: "Личные задачи, напоминания, память, расписание и курсы валют пользователя YASIK.",
    });
  }
  if (msg.method === "ping") return ok({});
  if (msg.method === "tools/list") {
    return ok({ tools: AGENT_TOOLS.filter((t) => MCP_TOOLS.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
  }
  if (msg.method === "tools/call") {
    if (!MCP_TOOLS.has(p.name)) return fail(-32602, "unknown tool: " + String(p.name).slice(0, 50));
    const tz = clampTz(env.MCP_TZ === undefined ? 180 : env.MCP_TZ);
    const uid = await mcpUid(env);
    const args = p.arguments && typeof p.arguments === "object" ? p.arguments : {};
    const ctx = p.name === "get_schedule" ? await scheduleContext(env, uid, tz).catch(() => "") : "";
    const res = String(await runTool(env, p.name, args, ctx, uid, tz));
    return ok({ content: [{ type: "text", text: res.slice(0, 8000) }], isError: toolFailed(res) });
  }
  return fail(-32601, "method not found");
}
async function mcpApi(req, env) {
  const out = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
  const key = env.MCP_TOKEN || "";
  if (!key) return out({ error: "mcp off" }, 503);
  const given = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || new URL(req.url).searchParams.get("key") || "";
  if (!safeEq(given, key)) return out({ error: "forbidden" }, 401);
  let body;
  try { body = await req.json(); } catch (e) { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  const batch = Array.isArray(body);
  const res = [];
  for (const msg of (batch ? body.slice(0, 20) : [body])) {
    const r = await mcpHandle(env, msg);
    if (r) res.push(r);
  }
  if (!res.length) return new Response(null, { status: 202 });
  return out(batch ? res : res[0]);
}

// ---------- 1. голос: путь вебхука вызывает эту функцию с проверкой типа сообщения ----------
const isVoiceMsg = (m) => !!(m && m.chat && m.chat.type === "private" && (m.voice || m.audio));
