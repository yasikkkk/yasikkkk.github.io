#!/usr/bin/env python3
"""Применяет новые возможности к worker/index.js.

Запуск из корня репозитория:   python tools/apply_patch.py
Скрипт ничего не меняет, если хоть одно место для правки не найдено ровно один раз.
Перед изменением создаётся копия worker/index.js.bak.
"""
import re, sys, shutil, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
target = root / "worker" / "index.js"
block_file = pathlib.Path(__file__).resolve().parent / "new_features.js"

src = target.read_text(encoding="utf-8").replace("\r\n", "\n")
block = block_file.read_text(encoding="utf-8")

if "НОВЫЕ ВОЗМОЖНОСТИ (добавлено скриптом" in src:
    sys.exit("Патч уже применён к этому файлу. Ничего не делаю.")

Q = '"'
edits = [
    # (что найти, на что заменить)
    ("async function webSearch(env, q) {",
     "async function webSearchRaw(env, q) {"),
    ("+ memBlock(mem) + taskBlock(tasks, tz);",
     "+ memBlock(memSelect(mem, (msgs[msgs.length - 1] || {}).content || " + Q + Q + ")) + taskBlock(tasks, tz);"),
    ('  if (!m || !m.chat || m.chat.type !== "private" || typeof m.text !== "string") return ok();',
     '  if (isVoiceMsg(m)) { const vj = tgVoice(env, m); if (ctx && ctx.waitUntil) ctx.waitUntil(vj); else await vj; return ok(); }\n'
     '  if (!m || !m.chat || m.chat.type !== "private" || typeof m.text !== "string") return ok();'),
    ('    if (lk && data.startsWith("c:")) { await tgSettingsCb(env, cq, chat, lk, data); return; }',
     '    if (lk && data.startsWith("f:")) { await tgFeedbackCb(env, cq, chat, lk, data); return; }\n'
     '    if (lk && data.startsWith("c:")) { await tgSettingsCb(env, cq, chat, lk, data); return; }'),
    ('    if (b.action === "eval") return await runEval(env, b, json);',
     '    if (b.action === "feedback") return await feedbackList(env, b, json);\n'
     '    if (b.action === "eval") return await runEval(env, b, json);'),
    ('    if (new URL(req.url).pathname === "/admin") return adminApi(req, env, json);',
     '    if (new URL(req.url).pathname === "/mcp") return mcpApi(req, env);                       // MCP-сервер: ключ MCP_TOKEN\n'
     '    if (new URL(req.url).pathname === "/admin") return adminApi(req, env, json);'),
    ('    if (body.mode === "tg") return tgApi(env, body, json, uid);',
     '    if (body.mode === "tg") return tgApi(env, body, json, uid);\n'
     '    if (body.mode === "feedback") return feedbackApi(env, body, json, uid);'),
    ('    if (body.mode === "vision") {',
     '    if (body.mode === "vision") {\n'
     '      if (!(await takeQuota(env, uid, 1))) return json({ error: "user_quota", detail: quotaMsg }, 429);'),
    ('    if (body.mode === "image") {',
     '    if (body.mode === "image") {\n'
     '      if (!(await takeQuota(env, uid, 3))) return json({ error: "user_quota", detail: quotaMsg }, 429);'),
    ('    if (body.mode === "agent" && !files.length) {',
     '    if (body.mode === "agent" && !files.length) {\n'
     '      if (!(await takeQuota(env, uid, 1))) return json({ error: "user_quota", detail: quotaMsg }, 429);'),
    ('    // Чат — до 1800 токенов (с файлами до 2000), один раздел большого документа — до 3000',
     '    if (!(await takeQuota(env, uid, doc ? 3 : 1))) return json({ error: "user_quota", detail: quotaMsg }, 429);\n'
     '    // Чат — до 1800 токенов (с файлами до 2000), один раздел большого документа — до 3000'),
]

bad = [a for a, _ in edits if src.count(a) != 1]
old_chat = list(re.finditer(r"async function tgChat\(env, chat, lk, text\) \{\n[\s\S]*?\n\}\n", src))
if len(old_chat) != 1 or "agentCore" not in old_chat[0].group(0) or len(old_chat[0].group(0)) > 5000:
    bad.append("функция tgChat (не удалось надёжно найти её границы)")
if bad:
    print("Не нашёл (или нашёл больше одного раза) следующие места. Файл НЕ изменён:")
    for b in bad:
        print("  -", b[:100])
    print("Скорее всего, worker/index.js изменился после того, как я его видел. Пришлите мне актуальный файл.")
    sys.exit(1)

shutil.copy(target, target.with_suffix(".js.bak"))
for a, b in edits:
    src = src.replace(a, b)
src = src.replace(old_chat[0].group(0), "// (прежняя tgChat заменена версией с лимитами и кнопками оценки, см. конец файла)\n")
src = src.rstrip("\n") + "\n" + block
target.write_text(src, encoding="utf-8")
print("Готово: изменено", len(edits) + 1, "мест, блок новых функций добавлен в конец. Копия: worker/index.js.bak")
