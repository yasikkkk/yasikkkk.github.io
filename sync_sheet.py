"""Читает расписание из Google-таблицы и превращает его в schedule.json.

Запуск вручную:  python sync_sheet.py
Используется ботом (автообновление) и GitHub Actions (автообновление сайта).
Сторонние библиотеки не нужны.
"""
import csv
import io
import json
import os
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

SHEET_ID = os.getenv("SHEET_ID", "18mg-xM7j4iezyXvbDl0u68TRNt4mxTZ54qLJhI3s5BA")
# Номера вкладок (gid) через запятую. Первая вкладка = 0. Если новые месяцы
# добавляют на другие вкладки, перечислите их: SHEET_GIDS=0,123456789
SHEET_GIDS = [g.strip() for g in os.getenv("SHEET_GIDS", "0").split(",") if g.strip()]

BASE = Path(__file__).parent
SCHEDULE_FILE = BASE / "schedule.json"
WEEKLY_FILE = BASE / "weekly.json"  # еженедельные правила, важнее таблицы

MONTHS = {"января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
          "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12}
DATE_RE = re.compile(r"^(\d{1,2})\s+([а-яё]+)$")
TIME_RE = re.compile(r"(\d{1,2})\s*[:;.]\s*(\d{2})\s*[-–—]\s*(\d{1,2})\s*[:;.]\s*(\d{2})")
TEACHER_RE = re.compile(r"^([А-ЯЁ][а-яё\-]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.)\s*(.*)$", re.S)
NOTE_RE = re.compile(r"^(зачет|зачёт|экзамен|ИЗ)\s+(.*)$", re.I | re.S)
ROOM_RE = re.compile(r"\d{1,4}[А-Яа-яA-Za-z]?|[А-ЯA-Z]-\d{1,3}")


def _date_cells(row):
    out = []
    for cell in row[:7]:
        m = DATE_RE.match(cell.strip().lower())
        out.append((int(m.group(1)), MONTHS[m.group(2)]) if m and m.group(2) in MONTHS else None)
    return out


def _guess_year(first_month, today):
    year = today.year
    if first_month - today.month > 6:
        year -= 1
    elif today.month - first_month > 6:
        year += 1
    return year


def _fmt_time(cell):
    found = TIME_RE.findall(cell)
    if not found:
        return None

    def hm(h, m):
        return f"{int(h):02d}:{m}"

    if "или" in cell.lower():
        return " или ".join(f"{hm(a, b)}–{hm(c, d)}" for a, b, c, d in found)
    return f"{hm(found[0][0], found[0][1])}–{hm(found[-1][2], found[-1][3])}"


def _parse_item(time_text, subject, room):
    text = " ".join(subject.split())
    if not text:
        return None
    m = TEACHER_RE.match(text)
    teacher, rest = (m.group(1), m.group(2)) if m else ("", text)
    note = ""
    n = NOTE_RE.match(rest)
    if n:
        note, rest = n.group(1), n.group(2)
        note = "ИЗ" if note.lower() == "из" else note.lower()
    if not rest:
        return None
    room = " ".join(room.split())
    if room and ROOM_RE.fullmatch(room):
        room = f"ауд. {room}"
    item = {"time": time_text, "title": rest}
    if teacher:
        item["teacher"] = teacher
    if room:
        item["place"] = room
    if note:
        item["note"] = note
    return item


def parse_rows(rows, today=None):
    """Разбирает строки таблицы. Структура: строка с датами, строка с днями недели,
    затем блоки по три строки: время / преподаватель и предмет / аудитория."""
    today = today or date.today()
    rows = [[c.strip() for c in r] + [""] * 8 for r in rows]
    heads = [i for i, r in enumerate(rows) if sum(d is not None for d in _date_cells(r)) >= 3]
    data, year, prev_month = {}, None, None

    for n, i in enumerate(heads):
        end = heads[n + 1] if n + 1 < len(heads) else len(rows)
        days = []
        for cell in _date_cells(rows[i]):
            if cell is None:
                days.append(None)
                continue
            day, month = cell
            if year is None:
                year = _guess_year(month, today)
            elif prev_month is not None and month < prev_month:
                year += 1
            prev_month = month
            try:
                days.append(date(year, month, day))
            except ValueError:
                days.append(None)

        week = {d: [] for d in days if d}
        k = i + 1
        while k < end:
            if any(TIME_RE.search(x) for x in rows[k][:7]):
                subj = rows[k + 1] if k + 1 < end else [""] * 8
                room = rows[k + 2] if k + 2 < end else [""] * 8
                for col, d in enumerate(days):
                    t = _fmt_time(rows[k][col])
                    if d and t:
                        item = _parse_item(t, subj[col], room[col])
                        if item:
                            week[d].append(item)
                k += 3
            else:
                k += 1

        if any(week.values()):  # недели без единого занятия считаем «ещё не добавленными»
            for d, items in week.items():
                data[d.isoformat()] = sorted(items, key=lambda x: x["time"])
    return data


def fetch_rows(gid):
    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={gid}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8-sig")
    if text.lstrip().startswith("<"):
        raise RuntimeError("таблица недоступна: включите доступ «Все, у кого есть ссылка»")
    return list(csv.reader(io.StringIO(text)))


def build_schedule():
    data = {}
    for gid in SHEET_GIDS:
        data.update(parse_rows(fetch_rows(gid)))
    if len(data) < 5:
        raise RuntimeError("в таблице не найдено расписание (изменилась структура?)")
    if WEEKLY_FILE.exists():
        weekly = json.loads(WEEKLY_FILE.read_text("utf-8"))
    elif SCHEDULE_FILE.exists():  # нет weekly.json: сохраняем правила из прежнего файла
        weekly = json.loads(SCHEDULE_FILE.read_text("utf-8")).get("_weekly", {})
    else:
        weekly = {}
    if weekly:
        data["_weekly"] = weekly
    return data


def update_file():
    """Скачивает таблицу и обновляет schedule.json. Возвращает (изменилось, дней, последняя дата).
    При любой ошибке бросает исключение, а прежний файл остаётся нетронутым."""
    data = build_schedule()
    new = json.dumps(data, ensure_ascii=False, indent=1)
    old = SCHEDULE_FILE.read_text("utf-8") if SCHEDULE_FILE.exists() else ""
    days = sorted(k for k in data if not k.startswith("_"))
    changed = new != old
    if changed:
        tmp = SCHEDULE_FILE.with_suffix(".tmp")
        tmp.write_text(new, "utf-8")
        tmp.replace(SCHEDULE_FILE)
    return changed, len(days), days[-1]


if __name__ == "__main__":
    try:
        changed, n, last = update_file()
        print(("Обновлено" if changed else "Без изменений") + f": {n} дней, последняя дата {last}")
    except Exception as e:
        print("Ошибка:", e)
        sys.exit(1)
