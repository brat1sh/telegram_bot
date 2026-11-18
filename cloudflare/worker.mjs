/**
 * Мониторинг канала @cek_info для очереди 1.2 (Cloudflare Worker + Durable Object).
 *
 * Почему Durable Object, а не KV: KV согласуется с задержкой до 60 секунд,
 * поэтому следующий запуск мог прочитать старое состояние и отправить тот же
 * пост повторно. Durable Object даёт строгую согласованность, а его запросы
 * выполняются последовательно — гонок между запусками тоже нет.
 *
 * Режимы (GET ?mode=...):
 *   check  — обычная проверка (по умолчанию)
 *   dry    — только показать, что было бы отправлено, без отправки и записи
 *   status — состояние и журнал последних отправок
 *   reset  — сбросить состояние (следующий запуск запомнит последний пост)
 */

const CHANNEL = 'cek_info';
const PAGE_URL = 'https://t.me/s/' + CHANNEL;
const MARKER = 'data-post="' + CHANNEL + '/';

const ICON = '⚡️';
const QUEUE_NAME = '1.2';
const HEADER_SCHEDULE = 'Графік';
const HEADER_CHANGES = 'Зміни в черзі ' + QUEUE_NAME;
const HEADER_SCHEDULE_CANCELLED = 'Скасування графіка';
const HEADER_EMERGENCY = 'Екстрені відключення';
const HEADER_EMERGENCY_CANCELLED = 'Скасування екстрених відключень';

// Очередь ищется так, чтобы не ловить посторонние числа:
// «1.2» / «1,2» — но не «1.25»; дефисные варианты — только рядом со словом «черга».
const QUEUE_RES = [
  /1[.,]2\s*черг/u,
  /черг\p{L}*\s*1[.,]2/u,
  /1[.,]2(?![\d])/u,
  /1[-–]2\s*черг/u,
  /черг\p{L}*\s*1[-–]2/u,
];

// Экстренное отключение — это объявление, а не любое упоминание слов.
// Ловим только формулировки вида «застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ»
// или «скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ», чтобы не реагировать на посты
// вроде «алгоритм дій під час екстрених відключень».
const EMERGENCY_ACTION_RES = [
  /(застосов|введен|впровадж|запровадж|скасуван|скасов|скасован|діють|тривають|почина|припин)\p{L}*[^.!?\n]{0,50}(екстрен|аварійн)\p{L}*\s+(відключен|обмежен|вимкнен)/u,
  /(екстрен|аварійн)\p{L}*\s+(відключен|обмежен|вимкнен)\p{L}*[^.!?\n]{0,50}(застосов|введен|впровадж|запровадж|скасуван|скасов|скасован|діють|тривають|почина|припин)/u,
];
const EMERGENCY_PHRASE_RE = /(екстрен|аварійн)\p{L}*\s+(відключен|обмежен|вимкнен)/u;
const EMERGENCY_HEADLINE_CHARS = 15;
const CITY_NAME = 'Жовті Води';
const CITY_RE = /жовт\p{L}*\s+вод\p{L}*|желт\p{L}*\s+вод\p{L}*/u;
const REGION_RES = [
  /всій\s+області/u,
  /всієї\s+області/u,
  /по\s+всій\s+області/u,
  /в\s+межах\s+області/u,
  /дніпропетровськ\p{L}*\s+област/u,
];
const ANY_CITY_RE = /(?:м\.|міст[оаі]|город[ае]?)\s*[А-ЯІЇЄҐA-Z]/i;
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const DATE_RE = new RegExp('(\\d{1,2})\\s+(' + MONTHS.join('|') + ')', 'i');
const HEADLINE_CHARS = 250;
const CANCEL_STEMS = ['скасуван', 'скасов'];
const CHANGES_RE = /змін(?:и|ах|ами|ам)/u;
const MAX_LEN = 4000;
const LOG_LIMIT = 20;

export class Checker {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') || 'check';

    if (mode === 'status') {
      const lastSeen = (await this.storage.get('last_seen')) || 0;
      const log = (await this.storage.get('sent_log')) || [];
      return Response.json({ ok: true, last_seen: lastSeen, sent_log: log });
    }

    if (mode === 'reset') {
      await this.storage.delete('last_seen');
      return Response.json({ ok: true, reset: true });
    }

    if (mode === 'selftest') {
      return Response.json({ ok: true, results: selftest() });
    }

    const result = await this.check(mode);
    return Response.json(result);
  }

  async check(mode) {
    const res = await fetch(PAGE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'uk,ru;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };

    const html = await res.text();
    const positions = findPositions(html);
    if (!positions.length) return { ok: false, error: 'посты не найдены' };

    const newest = positions[positions.length - 1].id;
    const stored = Number((await this.storage.get('last_seen')) || 0);

    if (!stored && mode !== 'dry') {
      await this.storage.put('last_seen', newest);
      return { ok: true, first_run: true, newest };
    }

    const fresh = positions.filter((p) => p.id > stored);
    if (!fresh.length) return { ok: true, newest, last_seen: stored, new_posts: 0 };

    const sent = [];
    const failed = [];

    for (const pos of fresh) {
      const post = { id: pos.id, text: extractText(html, pos.start, pos.end) };
      const kind = findMatch(post.text);
      if (!kind) continue;

      const header = buildHeader(post.text, kind);
      const text = buildMessage(post, header);

      if (mode === 'dry') {
        sent.push({ id: post.id, header, preview: text.slice(0, 120) });
        continue;
      }

      const ok = await sendTelegram(this.env, text);
      if (!ok) {
        failed.push(post.id);
        continue;
      }

      sent.push({ id: post.id, header });
      const log = (await this.storage.get('sent_log')) || [];
      log.push({ id: post.id, at: new Date().toISOString(), header });
      await this.storage.put('sent_log', log.slice(-LOG_LIMIT));
    }

    if (mode !== 'dry') {
      let target = newest;
      if (failed.length) target = Math.min(...failed) - 1;
      if (target > stored) await this.storage.put('last_seen', target);
    }

    return { ok: true, newest, last_seen: stored, new_posts: fresh.length, sent, failed };
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, 'check'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') || 'status';
    return run(env, mode);
  },
};

async function run(env, mode) {
  const id = env.CHECKER.idFromName('cek');
  const stub = env.CHECKER.get(id);
  try {
    return await stub.fetch('https://do/run?mode=' + encodeURIComponent(mode));
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

function findPositions(html) {
  const found = [];
  let from = 0;
  while (true) {
    const at = html.indexOf(MARKER, from);
    if (at === -1) break;
    const rest = html.slice(at + MARKER.length, at + MARKER.length + 12);
    const m = rest.match(/^(\d+)/);
    from = at + MARKER.length;
    if (!m) continue;
    const id = Number(m[1]);
    if (found.some((p) => p.id === id)) continue;
    found.push({ id, start: at });
  }
  found.sort((a, b) => a.id - b.id);
  for (let i = 0; i < found.length - 1; i++) found[i].end = found[i + 1].start;
  if (found.length) {
    const last = found[found.length - 1];
    last.end = Math.min(html.length, last.start + 20000);
  }
  return found;
}

function extractText(html, start, end) {
  const chunk = html.slice(start, end);
  const m = chunk.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return '';
  let s = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  s = unescapeHtml(s);
  return s.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length)
    .join('\n')
    .trim();
}

function unescapeHtml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function findMatch(text) {
  const low = text.toLowerCase();

  if (QUEUE_RES.some((re) => re.test(low))) return 'queue';

  if (!isEmergencyAnnouncement(low)) return null;
  if (CITY_RE.test(low)) return 'emergency_city';
  if (REGION_RES.some((re) => re.test(low))) return 'emergency_region';
  if (!ANY_CITY_RE.test(text)) return 'emergency_region';
  return null;
}

function isEmergencyAnnouncement(low) {
  // Либо рядом с фразой стоит действие, либо фраза открывает пост.
  if (EMERGENCY_ACTION_RES.some((re) => re.test(low))) return true;
  const idx = low.search(EMERGENCY_PHRASE_RE);
  return idx !== -1 && idx < EMERGENCY_HEADLINE_CHARS;
}

// Проверка фильтров на типовых формулировках (?mode=selftest).
const SELFTEST_CASES = [
  ['🔹 Черга 1.2\n08:00-12:00', 'queue'],
  ['1.2\n00:00-01:00', 'queue'],
  ['Шановні споживачі м. ДНІПРО! Застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ!', null],
  ['Шановні мешканці м. ЖОВТІ ВОДИ! Застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ!', 'emergency_city'],
  ['м. Жовті Води: скасовуються ЕКСТРЕНІ відключення', 'emergency_city'],
  ['Шановні споживачі! Застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ!', 'emergency_region'],
  ['Алгоритм дій. Можливі блекаути, екстрені відключення та аварійні ситуації.', null],
  ['Увага! Екстрені відключення!', 'emergency_region'],
  ['Протягом 1-2 годин подачу відновлять.', null],
  ['черга 2.1 і 3.2', null],
  ['Планові роботи у м. ЖОВТІ ВОДИ на 16 листопада', null],
];

function selftest() {
  return SELFTEST_CASES.map(([text, expected]) => {
    const got = findMatch(text);
    return { text: text.split('\n')[0].slice(0, 60), expected, got, ok: got === expected };
  });
}

function buildHeader(postText, kind) {
  const headline = postText.slice(0, HEADLINE_CHARS).toLowerCase();
  const cancelled = CANCEL_STEMS.some((stem) => headline.includes(stem));

  if (kind === 'queue') {
    let header = HEADER_SCHEDULE;
    if (cancelled) header = HEADER_SCHEDULE_CANCELLED;
    else if (CHANGES_RE.test(headline)) header = HEADER_CHANGES;

    const m = DATE_RE.exec(postText.slice(0, HEADLINE_CHARS)) || DATE_RE.exec(postText);
    return m ? `${ICON} ${header} на ${m[1]} ${m[2].toUpperCase()}` : `${ICON} ${header}`;
  }

  const base = cancelled ? HEADER_EMERGENCY_CANCELLED : HEADER_EMERGENCY;
  const scope = kind === 'emergency_city' ? CITY_NAME : 'вся область';
  return `${ICON} ${base} — ${scope}`;
}

function buildMessage(post, header) {
  const url = `https://t.me/${CHANNEL}/${post.id}`;
  const text = `${header}\n\n${post.text}\n\n${url}`;
  if (text.length <= MAX_LEN) return text;

  const tail = `\n\n${url}`;
  const head = `${header}\n\n`;
  const keep = MAX_LEN - head.length - tail.length - 2;
  return `${head}${post.text.slice(0, Math.max(keep, 0)).trim()}\n…${tail}`;
}

async function sendTelegram(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (res.ok) return true;

  const body = await res.text();
  console.log('telegram_error', res.status, body.slice(0, 300));
  return false;
}
