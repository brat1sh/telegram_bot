#!/usr/bin/env python3
"""Мониторинг публичного Telegram-канала @cek_info на упоминания очереди 1.2.

Скрипт читает публичную веб-версию канала (https://t.me/s/cek_info),
находит посты с ID больше сохранённого в last_seen_id.txt, проверяет их
на ключевые слова очереди и на экстренные отключения по своему городу,
а при совпадении отправляет уведомление в личные сообщения через
Telegram Bot API (метод sendMessage).

Требуемые переменные окружения:
    BOT_TOKEN — токен бота от @BotFather
    CHAT_ID   — ID получателей через запятую: личный ID и/или ID канала
"""

from __future__ import annotations

import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# --- Настройки -------------------------------------------------------------

CHANNEL = "cek_info"
WEB_URL = f"https://t.me/s/{CHANNEL}"
POST_URL_TEMPLATE = f"https://t.me/{CHANNEL}/{{post_id}}"

LAST_SEEN_FILE = Path("last_seen_id.txt")

# Ключевые слова очереди. Сравнение идёт без учёта регистра,
# как простая подстрока в тексте поста.
KEYWORDS = (
    "1.2 черга",
    "1,2 черга",
    "1.2",
    "1,2",
    "1-2",
    "1–2",
)

# Экстренные отключения касаются всего города, а не отдельной очереди,
# поэтому у них своё правило: слово «екстрен» И упоминание своего города.
# Канал пишет такие посты по разным городам, иначе придут чужие.
EMERGENCY_KEYWORDS = ("екстрен", "экстрен", "аварійн", "аварийн")
CITY_NAME = "Жовті Води"
CITY_PATTERNS = (
    r"жовт\w*\s+вод\w*",   # ЖОВТІ ВОДИ, у Жовтих Водах, мешканцям Жовтих Вод...
    r"желт\w*\s+вод\w*",   # ЖЕЛТЫЕ ВОДЫ (русское написание)
)

# Признаки того, что отключение объявлено на всю область, а не на город.
REGION_PATTERNS = (
    r"всій\s+області",
    r"всієї\s+області",
    r"по\s+всій\s+області",
    r"в\s+межах\s+області",
    r"дніпропетровськ\w*\s+област",
)

# Как в тексте выглядит упоминание любого города: «м. ДНІПРО», «для міста ...».
ANY_CITY_PATTERN = re.compile(
    r"(?:м\.|міст[оаі]|город[ае]?)\s*[А-ЯІЇЄҐA-Z]", re.IGNORECASE
)

# Заголовок каждого сообщения собирается из текста поста:
#   «Графік на 17 ЛИСТОПАДА», «Зміни в черзі 1.2 на 17 ЛИСТОПАДА»,
#   «Екстрені відключення — Жовті Води».
QUEUE_NAME = "1.2"
HEADER_ICON = "⚡️"
HEADER_SCHEDULE = "Графік"
HEADER_CHANGES = f"Зміни в черзі {QUEUE_NAME}"
HEADER_SCHEDULE_CANCELLED = "Скасування графіка"
HEADER_EMERGENCY = "Екстрені відключення"
HEADER_EMERGENCY_CANCELLED = "Скасування екстрених відключень"

# Первые символы поста описывают суть объявления, дальше идёт сам график.
HEADLINE_CHARS = 250

# Основы слов, означающих отмену: «скасування», «скасовуються», «скасовано».
CANCELLED_STEMS = ("скасуван", "скасов")

# Именно слово «зміни»/«змін», а не «змінюватися» в конце поста.
CHANGES_PATTERN = re.compile(r"\bзмін(?:и|ах|ами|ам|ою)?\b")

MONTHS_GENITIVE = (
    "січня",
    "лютого",
    "березня",
    "квітня",
    "травня",
    "червня",
    "липня",
    "серпня",
    "вересня",
    "жовтня",
    "листопада",
    "грудня",
)
DATE_PATTERN = re.compile(
    r"(\d{1,2})\s+(" + "|".join(MONTHS_GENITIVE) + r")", re.IGNORECASE
)

HTTP_TIMEOUT = 30          # секунд на запрос к t.me
TELEGRAM_TIMEOUT = 30      # секунд на запрос к Telegram API
HTTP_ATTEMPTS = 3          # попыток загрузки страницы канала
TELEGRAM_ATTEMPTS = 3      # попыток отправки сообщения
RETRY_DELAY = 5            # базовая пауза между попытками, секунд

# Лимит Telegram — 4096 символов на сообщение, оставляем запас.
MAX_MESSAGE_LEN = 4000

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "uk,ru;q=0.9,en;q=0.8",
}


@dataclass
class Post:
    post_id: int
    text: str

    @property
    def url(self) -> str:
        return POST_URL_TEMPLATE.format(post_id=self.post_id)


@dataclass
class Match:
    """Почему пост признан важным.

    kind: "queue" | "emergency_city" | "emergency_region".
    """

    kind: str
    reason: str


# --- Вспомогательные функции ----------------------------------------------


def log(message: str) -> None:
    print(message, flush=True)


def mask(text: str, token: str) -> str:
    """Заменяет токен бота в строке на заглушку.

    requests включает URL запроса в текст некоторых исключений,
    а URL Telegram API содержит токен — его нельзя показывать.
    """
    if token and token in text:
        return text.replace(token, "<BOT_TOKEN>")
    return text


def redact(text: str) -> str:
    """То же самое, но берёт токен из переменной окружения."""
    return mask(text, os.environ.get("BOT_TOKEN", ""))


def read_last_seen() -> int | None:
    """Возвращает сохранённый ID последнего обработанного поста.

    None означает «первый запуск» (или повреждённый файл состояния).
    """
    try:
        raw = LAST_SEEN_FILE.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except OSError as exc:
        log(f"ПРЕДУПРЕЖДЕНИЕ: не удалось прочитать {LAST_SEEN_FILE}: {exc}")
        return None

    if not raw:
        return None

    try:
        return int(raw)
    except ValueError:
        log(
            f"ПРЕДУПРЕЖДЕНИЕ: в {LAST_SEEN_FILE} не число ({raw!r}), "
            "считаю это первым запуском."
        )
        return None


def save_last_seen(post_id: int) -> None:
    """Сохраняет ID атомарно: сначала во временный файл, потом замена."""
    tmp = LAST_SEEN_FILE.with_suffix(".tmp")
    tmp.write_text(f"{post_id}\n", encoding="utf-8")
    tmp.replace(LAST_SEEN_FILE)


def fetch_html(url: str) -> str:
    """Загружает страницу канала с несколькими попытками."""
    last_error = "неизвестная ошибка"

    for attempt in range(1, HTTP_ATTEMPTS + 1):
        try:
            response = requests.get(url, headers=HEADERS, timeout=HTTP_TIMEOUT)
            if response.status_code == 200:
                # t.me отдаёт UTF-8; requests иначе может выбрать latin-1.
                if "charset" not in response.headers.get("Content-Type", "").lower():
                    response.encoding = "utf-8"
                return response.text
            last_error = f"HTTP {response.status_code}"
        except requests.RequestException as exc:
            last_error = f"{type(exc).__name__}: {exc}"

        if attempt < HTTP_ATTEMPTS:
            time.sleep(RETRY_DELAY * attempt)

    raise RuntimeError(f"не удалось загрузить {url} ({last_error})")


def extract_text(node) -> str:
    """Достаёт текст поста, сохраняя пустые строки между абзацами."""
    for br in node.find_all("br"):
        br.replace_with("\n")

    lines: list[str] = []
    for raw in node.get_text().splitlines():
        line = raw.strip()
        if not line:
            if lines and lines[-1]:
                lines.append("")
        else:
            lines.append(line)

    while lines and not lines[-1]:
        lines.pop()

    return "\n".join(lines)


def parse_posts(html: str) -> list[Post]:
    """Возвращает все видимые посты страницы, отсортированные по ID."""
    soup = BeautifulSoup(html, "html.parser")
    posts: dict[int, Post] = {}

    for block in soup.select("div.tgme_widget_message[data-post]"):
        # data-post выглядит как "cek_info/12345"
        data_post = (block.get("data-post") or "").strip()
        parts = data_post.split("/")
        if len(parts) != 2 or not parts[1].isdigit():
            continue

        post_id = int(parts[1])
        if post_id in posts:
            continue

        text_node = block.select_one(".tgme_widget_message_text")
        posts[post_id] = Post(
            post_id=post_id,
            text=extract_text(text_node) if text_node else "",
        )

    return sorted(posts.values(), key=lambda post: post.post_id)


def find_match(text: str) -> Match | None:
    """Решает, нужно ли отправлять этот пост, и почему.

    1. Упоминание очереди 1.2 — отправляем всегда.
    2. Экстренное отключение: свой город, вся область или пост без города.
    3. Экстренное отключение по чужому городу — пропускаем.
    """
    haystack = text.casefold()

    for keyword in KEYWORDS:
        if keyword.casefold() in haystack:
            return Match(kind="queue", reason=f"очередь «{keyword}»")

    if not any(word in haystack for word in EMERGENCY_KEYWORDS):
        return None

    if any(re.search(pattern, haystack) for pattern in CITY_PATTERNS):
        return Match(
            kind="emergency_city",
            reason=f"экстренное отключение, {CITY_NAME}",
        )

    if any(re.search(pattern, haystack) for pattern in REGION_PATTERNS):
        return Match(
            kind="emergency_region",
            reason="экстренное отключение по всей области",
        )

    # Город в тексте не назван вообще — значит, объявление общее.
    if not ANY_CITY_PATTERN.search(text):
        return Match(
            kind="emergency_region",
            reason="экстренное отключение без указания города (общее)",
        )

    # Экстренное отключение по чужому городу — не наше дело.
    return None


def extract_date(text: str) -> str | None:
    """Достаёт дату из поста: «17 ЛИСТОПАДА» или None."""
    match = DATE_PATTERN.search(text[:HEADLINE_CHARS]) or DATE_PATTERN.search(text)
    if match is None:
        return None
    return f"{match.group(1)} {match.group(2).upper()}"


def build_header(post: Post, match: Match) -> str:
    """Собирает короткую шапку сообщения: тип события + дата."""
    headline = post.text[:HEADLINE_CHARS].casefold()
    cancelled = any(stem in headline for stem in CANCELLED_STEMS)

    if match.kind == "queue":
        if cancelled:
            header = HEADER_SCHEDULE_CANCELLED
        elif CHANGES_PATTERN.search(headline):
            header = HEADER_CHANGES
        else:
            header = HEADER_SCHEDULE

        date = extract_date(post.text)
        return f"{HEADER_ICON} {header} на {date}" if date else f"{HEADER_ICON} {header}"

    header = HEADER_EMERGENCY_CANCELLED if cancelled else HEADER_EMERGENCY

    scope = CITY_NAME if match.kind == "emergency_city" else "вся область"
    return f"{HEADER_ICON} {header} — {scope}"


def build_message(post: Post, title: str = "") -> str:
    """Формирует текст уведомления: заголовок (если задан), текст поста, ссылка."""
    body = post.text or ""
    message = "\n\n".join(part for part in (title, body, post.url) if part)

    if len(message) <= MAX_MESSAGE_LEN:
        return message

    # Обрезаем только в крайнем случае: Telegram не примет длиннее 4096.
    tail = f"\n\n{post.url}"
    head = f"{title}\n\n" if title else ""
    keep = MAX_MESSAGE_LEN - len(head) - len(tail) - len("\n…")
    trimmed = body[: max(keep, 0)].rstrip()
    return f"{head}{trimmed}\n…{tail}"


def send_telegram(token: str, chat_id: str, text: str) -> tuple[bool, str | None]:
    """Отправляет сообщение в Telegram. Возвращает (успех, текст ошибки)."""
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": "true",
    }
    last_error = "неизвестная ошибка"

    for attempt in range(1, TELEGRAM_ATTEMPTS + 1):
        retry_after = 0
        try:
            response = requests.post(
                url, json=payload, timeout=TELEGRAM_TIMEOUT
            )
        except requests.RequestException as exc:
            last_error = mask(
                f"сетевая ошибка: {type(exc).__name__}: {exc}", token
            )
        else:
            body: dict = {}
            try:
                parsed = response.json()
                if isinstance(parsed, dict):
                    body = parsed
            except ValueError:
                body = {}

            if response.ok and body.get("ok"):
                return True, None

            description = body.get("description") or response.reason or "нет описания"
            last_error = f"Telegram API, HTTP {response.status_code}: {description}"

            if isinstance(body.get("parameters"), dict):
                try:
                    retry_after = int(body["parameters"].get("retry_after", 0))
                except (TypeError, ValueError):
                    retry_after = 0

            # Ошибки, которые бессмысленно повторять: неверный токен,
            # заблокированный бот, неверный chat_id, битый запрос.
            if response.status_code in (400, 401, 403, 404) and not retry_after:
                return False, last_error

        if attempt < TELEGRAM_ATTEMPTS:
            time.sleep(retry_after or RETRY_DELAY * attempt)

    return False, last_error


# --- Основная логика -------------------------------------------------------


def parse_chat_ids(raw: str) -> list[str]:
    """Разбирает список получателей: «123456789,-1001234567890».

    Один человек, канал или несколько адресов через запятую.
    """
    ids = [part.strip() for part in raw.split(",")]
    return [chat_id for chat_id in ids if chat_id]


def main() -> int:
    token = (os.environ.get("BOT_TOKEN") or "").strip()
    chat_ids = parse_chat_ids(os.environ.get("CHAT_ID") or "")

    if not token or not chat_ids:
        log("ОШИБКА: не заданы переменные окружения BOT_TOKEN и/или CHAT_ID.")
        log("Задайте их в GitHub: Settings -> Secrets and variables -> Actions.")
        log("В CHAT_ID можно перечислить нескольких получателей через запятую.")
        return 1

    try:
        html = fetch_html(WEB_URL)
    except RuntimeError as exc:
        log(f"ОШИБКА: {redact(str(exc))}")
        return 1

    posts = parse_posts(html)
    if not posts:
        log(
            "ОШИБКА: на странице не найдено ни одного поста. "
            "Возможно, изменилась вёрстка t.me/s/ или канал недоступен."
        )
        return 1

    newest_id = posts[-1].post_id
    last_seen = read_last_seen()

    if last_seen is None:
        save_last_seen(newest_id)
        log(
            f"Первый запуск: запоминаю самый новый пост {newest_id}. "
            "Старые посты не отправляются."
        )
        return 0

    new_posts = [post for post in posts if post.post_id > last_seen]
    if not new_posts:
        log(f"Новых постов нет (последний обработанный ID: {last_seen}).")
        return 0

    log(
        f"Новых постов: {len(new_posts)} "
        f"(ID {new_posts[0].post_id}..{new_posts[-1].post_id})."
    )

    sent = 0
    failed_ids: list[int] = []

    for post in new_posts:
        match = find_match(post.text)
        if match is None:
            continue

        header = build_header(post, match)
        message = build_message(post, header)

        errors: list[str] = []
        for index, chat_id in enumerate(chat_ids, start=1):
            ok, error = send_telegram(token, chat_id, message)
            if not ok:
                errors.append(f"получатель {index}: {redact(str(error))}")

        if not errors:
            sent += 1
            log(
                f"Уведомление отправлено: пост {post.post_id} "
                f"({match.reason}), получателей: {len(chat_ids)}."
            )
        else:
            failed_ids.append(post.post_id)
            log(
                f"ОШИБКА отправки по посту {post.post_id}: "
                + "; ".join(errors)
            )

    log(f"Отправлено уведомлений: {sent}.")

    # Обычно last_seen_id уходит на самый новый найденный пост — даже если
    # совпадений не было. Если же отправка не удалась, состояние не
    # продвигается за неудачный пост, чтобы уведомление не потерялось.
    target_id = newest_id
    if failed_ids:
        target_id = min(failed_ids) - 1
        log(
            "Часть уведомлений не доставлена: last_seen_id не продвигается "
            "за них, повторная попытка будет при следующем запуске."
        )

    if target_id > last_seen:
        save_last_seen(target_id)
        log(f"last_seen_id обновлён: {last_seen} -> {target_id}.")
    else:
        log(f"last_seen_id оставлен без изменений: {last_seen}.")

    return 1 if failed_ids else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("Прервано пользователем.")
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001 — нужен читаемый вывод вместо traceback
        log(f"НЕОЖИДАННАЯ ОШИБКА: {type(exc).__name__}: {redact(str(exc))}")
        sys.exit(1)
