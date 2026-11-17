/**
 * Мониторинг канала @cek_info для очереди 1.2 (Cloudflare Worker).
 *
 * Проверяет публичную страницу https://t.me/s/cek_info раз в минуту,
 * находит новые посты, фильтрует по очереди 1.2 и по экстренным
 * отключениям своего города, отправляет в Telegram.
 *
 * Секреты и настройки приходят из биндингов:
 *   BOT_TOKEN (secret), CHAT_ID (plain), STATE (KV namespace).
 */

const CHANNEL = 'cek_info';
const PAGE_URL = 'https://t.me/s/' + CHANNEL;
const MARKER = 'data-post="' + CHANNEL + '/';
const STATE_KEY = 'last_seen';

const ICON = '⚡️';
const QUEUE_NAME = '1.2';
const HEADER_SCHEDULE = 'Графік';
const HEADER_CHANGES = 'Зміни в черзі ' + QUEUE_NAME;
const HEADER_SCHEDULE_CANCELLED = 'Скасування графіка';
const HEADER_EMERGENCY = 'Екстрені відключення';
const HEADER_EMERGENCY_CANCELLED = 'Скасування екстрених відключень';

const KEYWORDS = ['1.2 черга', '1,2 черга', '1.2', '1,2', '1-2', '1–2'];
const EMERGENCY_WORDS = ['екстрен', 'экстрен', 'аварійн', 'аварийн'];
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

export default {
  async scheduled(controller, env, ctx) {
    const result = await check(env);
    console.log(JSON.stringify(result));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') || 'check';
    const result = await check(env, mode);
    return Response.json(result);
  },
};

async function check(env, mode = 'check') {
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
  const stored = Number((await env.STATE.get(STATE_KEY)) || 0);

  if (!stored && mode !== 'dry') {
    await env.STATE.put(STATE_KEY, String(newest));
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

    const ok = await sendTelegram(env, text);
    if (ok) sent.push({ id: post.id, header });
    else failed.push(post.id);
  }

  if (mode !== 'dry') {
    let target = newest;
    if (failed.length) target = Math.min(...failed) - 1;
    if (target > stored) await env.STATE.put(STATE_KEY, String(target));
  }

  return {
    ok: true,
    newest,
    last_seen: stored,
    new_posts: fresh.length,
    sent,
    failed,
  };
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
  if (found.length) found[found.length - 1].end = Math.min(html.length, found[found.length - 1].start + 20000);
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

  for (const keyword of KEYWORDS) {
    if (low.includes(keyword.toLowerCase())) return 'queue';
  }

  if (!EMERGENCY_WORDS.some((w) => low.includes(w))) return null;
  if (CITY_RE.test(low)) return 'emergency_city';
  if (REGION_RES.some((re) => re.test(low))) return 'emergency_region';
  if (!ANY_CITY_RE.test(text)) return 'emergency_region';
  return null;
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
  console.log('telegram_error', res.status, body.slice(0, 300).replace(env.BOT_TOKEN, '<BOT_TOKEN>'));
  return false;
}
