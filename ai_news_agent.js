#!/usr/bin/env node
/**
 * ai_news_agent.js — автономный агент мониторинга новостей об ИИ.
 *
 * Что делает:
 *   1. Забирает RSS-ленты технологических изданий (TechCrunch, VentureBeat, Habr, The Verge,
 *      MIT Technology Review, arXiv cs.AI) через встроенный модуль https/http.
 *   2. Парсит RSS 2.0 и Atom без внешних зависимостей.
 *   3. Оставляет новости за последние 24 часа, отсеивает спам/рекламу, дедуплицирует,
 *      ранжирует по ключевым словам и свежести, берёт top-N.
 *   4. Формирует выжимку (заголовок, суть, источник, ссылка) и отправляет в Telegram-бот.
 *
 * Запуск:
 *   node ai_news_agent.js                # отправка в Telegram (нужны реальные токен и chat_id)
 *   node ai_news_agent.js --dry-run      # только предпросмотр, без отправки
 *   node ai_news_agent.js --json         # вывести отобранные новости в JSON
 *   node ai_news_agent.js --test         # отправить одно тестовое сообщение
 *   node ai_news_agent.js --hours=12 --limit=5
 *
 * Зависимостей нет: только стандартная библиотека Node.js (>=18).
 */

'use strict';

const https = require('https');
const http = require('http');
const tls = require('tls');
const { URL } = require('url');

/* ================================ КОНФИГ ================================ */

// Вставьте сюда реальные значения (или задайте переменные окружения —
// так безопаснее: токен не попадёт в исходники и историю git).
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'СЮДА_ВСТАВЬ_ТОКЕН_ОТ_BOTFATHER';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'СЮДА_ВСТАВЬ_СВОЙ_CHAT_ID';
// Базу API можно подменить (например, для локального mock-сервера в тестах).
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

// Твиттер-агрегаторы (CryptoPanic / Coinness / Nitter / RSSHub).
// На 2026-10-18 публичных фидов нет: CryptoPanic RSS → 410 Gone, API без auth_token → 403,
// Coinness RSS отсутствует (SPA), Nitter/RSSHub → ECONNRESET/403/503.
// Как только появится рабочий URL — добавьте его сюда в том же формате.
const TWITTER_FEEDS = [
  // { name: 'CryptoPanic Airdrop', url: 'https://cryptopanic.com/api/v1/posts/?auth_token=XXX&filter=hot', category: 'crypto', boost: 20, activityFeed: true, maxPerFeed: 3 },
];

const CONFIG = {
  windowHours: 24,          // глубина выборки новостей
  activityWindowHours: 48,  // аирдропы/тестнеты живут дольше — берём за 2 дня
  localWindowHours: 168,    // локальные новости редкие — берём за 7 дней
  dealsWindowHours: 336,    // акции и скидки — за 14 дней
  maxItems: 20,             // сколько новостей попадёт в дайджест
  maxPerFeed: 3,            // не более N новостей из одной ленты (баланс источников)
  requestTimeoutMs: 20000,  // таймаут одного HTTP-запроса
  telegramChunkLimit: 3900, // Telegram ограничивает сообщение 4096 символами
  feeds: [
    // --- ИИ ---
    { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', category: 'ai' },
    { name: 'Wired AI', url: 'https://www.wired.com/feed/tag/ai/latest/rss', category: 'ai' },
    { name: 'Habr AI', url: 'https://habr.com/ru/rss/hub/artificial_intelligence/all/?fl=ru', category: 'ai' },

    // --- Крипта и Web3 ---
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', category: 'crypto' },
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'crypto', optional: true },
    { name: 'ForkLog', url: 'https://forklog.com/feed', category: 'crypto' },
    { name: 'ForkLog Аирдропы', url: 'https://forklog.com/tag/airdrop/feed', category: 'crypto' },
    { name: 'Habr Крипта', url: 'https://habr.com/ru/rss/hubs/cryptocurrency/?fl=ru', category: 'crypto' },
    { name: 'Decrypt', url: 'https://decrypt.co/feed', category: 'crypto' },

    // --- Узкопрофильные GameFi / Airdrop-радары (наивысший приоритет) ---
    // DappRadar, CryptoRank, DropsTab и CryptoPanic публичных RSS не отдают
    // (404/410/403 — проверено), поэтому используются доступные агрегаторы.
    { name: 'EGamers.io', url: 'https://egamers.io/feed/', category: 'crypto', boost: 15, activityFeed: true, maxPerFeed: 2 },
    { name: 'AirdropAlert', url: 'https://airdropalert.com/feed/', category: 'crypto', boost: 12, maxPerFeed: 2 },

    ...TWITTER_FEEDS,

    // --- Гик-инструменты: open source, лайфхаки, инди-софт ---
    { name: 'GitHub Trending', url: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml', category: 'geek' },
    { name: 'Hacker News', url: 'https://hnrss.org/newest?q=AI&points=50', category: 'geek', maxPerFeed: 3 },
    { name: 'Product Hunt', url: 'https://www.producthunt.com/feed', category: 'geek', maxPerFeed: 3 },
    { name: 'Habr Open Source', url: 'https://habr.com/ru/rss/hubs/open_source/?fl=ru', category: 'geek' },
    { name: 'Habr DIY', url: 'https://habr.com/ru/rss/hubs/diy/?fl=ru', category: 'geek' },
    { name: 'Habr Лайфхаки', url: 'https://habr.com/ru/rss/hubs/lifehacks/?fl=ru', category: 'geek' },

    // --- Локальные новости: Лениногорск и Татнефть ---
    { name: 'Татар-информ', url: 'https://tatar-inform.ru/rss', category: 'local', maxPerFeed: 4 },
    { name: 'Bing: Лениногорск', url: 'https://www.bing.com/news/search?q=%D0%9B%D0%B5%D0%BD%D0%B8%D0%BD%D0%BE%D0%B3%D0%BE%D1%80%D1%81%D0%BA&format=rss', category: 'local', maxPerFeed: 3 },
    { name: 'Bing: Татнефть', url: 'https://www.bing.com/news/search?q=%D0%A2%D0%B0%D1%82%D0%BD%D0%B5%D1%84%D1%82%D1%8C&format=rss', category: 'local', maxPerFeed: 3 },
    { name: 'Лениногорск (портал)', url: 'https://leninogorsk.tatarstan.ru/rss', category: 'local', optional: true, maxPerFeed: 3 },

    // --- Скидки и акции ритейла ---
    { name: 'New Retail', url: 'https://new-retail.ru/rss/', category: 'deals', maxPerFeed: 3 },
    { name: 'Sostav', url: 'https://www.sostav.ru/rss/', category: 'deals', maxPerFeed: 2 },
    { name: 'Bing: Распродажа', url: 'https://www.bing.com/news/search?q=%D1%80%D0%B0%D1%81%D0%BF%D1%80%D0%BE%D0%B4%D0%B0%D0%B6%D0%B0&format=rss', category: 'deals', maxPerFeed: 2 },
    { name: 'Bing: Скидки', url: 'https://www.bing.com/news/search?q=%D1%81%D0%BA%D0%B8%D0%B4%D0%BA%D0%B8&format=rss', category: 'deals', maxPerFeed: 2 },
    { name: 'Bing: Промокоды', url: 'https://www.bing.com/news/search?q=%D0%BF%D1%80%D0%BE%D0%BC%D0%BE%D0%BA%D0%BE%D0%B4%D1%8B&format=rss', category: 'deals', maxPerFeed: 2 },
    { name: 'Bing: Акции магазинов', url: 'https://www.bing.com/news/search?q=%D0%B0%D0%BA%D1%86%D0%B8%D0%B8+%D0%BC%D0%B0%D0%B3%D0%B0%D0%B7%D0%B8%D0%BD&format=rss', category: 'deals', maxPerFeed: 2 },
    { name: 'Bing: Пятёрочка', url: 'https://www.bing.com/news/search?q=%D0%9F%D1%8F%D1%82%D1%91%D1%80%D0%BE%D1%87%D0%BA%D0%B0+%D1%81%D0%BA%D0%B8%D0%B4%D0%BA%D0%B8&format=rss', category: 'deals', maxPerFeed: 2, optional: true },
    { name: 'Bing: Магнит', url: 'https://www.bing.com/news/search?q=%D0%9C%D0%B0%D0%B3%D0%BD%D0%B8%D1%82+%D0%B0%D0%BA%D1%86%D0%B8%D0%B8&format=rss', category: 'deals', maxPerFeed: 2, optional: true },
  ],
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Safari/537.36 AINewsAgent/1.0';

// Хосты, которые по умолчанию идут через прокси (если задан HTTPS_PROXY, но не задан PROXY_HOSTS).
const DEFAULT_PROXY_HOSTS = 'api.telegram.org';

// Настройки перевода на русский.
const TRANSLATE = {
  enabled: true,
  target: 'ru',
  cache: new Map(),
  concurrency: 4,
};

/* ================================= УТИЛИТЫ ================================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(...args);
}

function isPlaceholder(value) {
  return !value || /ВСТАВЬ|PASTE|YOUR_|CHANGE_ME/i.test(value);
}

function looksLikeToken(token) {
  // Реальный токен BotFather: "<123456789>:<AA...>" длиной ~46 символов.
  return /^\d{6,}:[A-Za-z0-9_-]{25,}$/.test(token);
}

/** Прокси из окружения: HTTPS_PROXY=http://127.0.0.1:10809 (так работает Happ/Xray). */
function getProxy() {
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:') return null; // поддерживаем только HTTP CONNECT-прокси
    return { host: u.hostname, port: Number(u.port) || 8080 };
  } catch {
    return null;
  }
}

/** Нужно ли гнать этот хост через прокси: PROXY_HOSTS=api.telegram.org или NO_PROXY=... */
function shouldProxy(hostname) {
  const host = hostname.toLowerCase();
  const matches = (list) =>
    list
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .some((h) => host === h || host.endsWith(`.${h}`));

  const only = process.env.PROXY_HOSTS || process.env.proxy_hosts;
  if (only) return matches(only);
  const skip = process.env.NO_PROXY || process.env.no_proxy;
  if (skip && matches(skip)) return false;
  return matches(DEFAULT_PROXY_HOSTS);
}

function baseHeaders(extra) {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    ...(extra || {}),
  };
}

/** HTTPS через HTTP-прокси: CONNECT-туннель + TLS поверх него. */
function httpsViaProxy(u, method, headers, body, proxy, redirects) {
  return new Promise((resolve, reject) => {
    const port = Number(u.port) || 443;
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${u.hostname}:${port}`,
      headers: { Host: `${u.hostname}:${port}`, 'Proxy-Connection': 'keep-alive' },
      timeout: CONFIG.requestTimeoutMs,
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`прокси ответил CONNECT ${res.statusCode}`));
      }
      const tlsSocket = tls.connect({ socket, servername: u.hostname }, () => {
        tlsSocket.setTimeout(CONFIG.requestTimeoutMs, () =>
          tlsSocket.destroy(new Error(`таймаут ${CONFIG.requestTimeoutMs} мс`))
        );
        // Пишем HTTP-запрос вручную поверх TLS-туннеля и разбираем ответ.
        const head = [
          `${method} ${u.pathname}${u.search} HTTP/1.1`,
          `Host: ${u.hostname}`,
          'Connection: close',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ].join('\r\n');

        tlsSocket.write(head + (body || ''));

        const chunks = [];
        tlsSocket.on('data', (c) => chunks.push(c));
        tlsSocket.on('end', () => {
          try {
            const parsed = parseRawResponse(Buffer.concat(chunks));
            if ([301, 302, 303, 307, 308].includes(parsed.status) && parsed.headers.location && redirects < 3) {
              const next = new URL(parsed.headers.location, u).toString();
              return request(next, { method, body }, redirects + 1).then(resolve, reject);
            }
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
        tlsSocket.on('error', reject);
      });
      tlsSocket.on('error', reject);
    });

    connectReq.on('error', reject);
    connectReq.on('timeout', () => connectReq.destroy(new Error('таймаут прокси')));
    connectReq.end();
  });
}

/** Минимальный разбор сырого HTTP/1.1-ответа (chunked поддерживается). */
function parseRawResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('прокси вернул некорректный ответ');
  const head = buf.subarray(0, sep).toString('utf8');
  let body = buf.subarray(sep + 4);
  const lines = head.split('\r\n');
  const status = Number((lines[0].match(/HTTP\/1\.[01] (\d{3})/) || [])[1]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (/chunked/i.test(headers['transfer-encoding'] || '')) {
    const parts = [];
    let pos = 0;
    while (pos < body.length) {
      const nl = body.indexOf('\r\n', pos);
      if (nl < 0) break;
      const size = parseInt(body.subarray(pos, nl).toString('utf8').split(';')[0], 16);
      if (!size) break;
      parts.push(body.subarray(nl + 2, nl + 2 + size));
      pos = nl + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  }
  return { status, headers, body: body.toString('utf8') };
}

/** HTTP(S)-запрос с редиректами и таймаутом. Возвращает { status, headers, body }. */
function request(urlStr, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new Error(`Некорректный URL: ${urlStr}`));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new Error(`Неподдерживаемый протокол: ${u.protocol}`));
    }
    const method = opts.method || 'GET';
    const body = opts.body || null;
    const headers = baseHeaders(opts.headers);

    const proxy = getProxy();
    if (proxy && u.protocol === 'https:' && shouldProxy(u.hostname)) {
      return httpsViaProxy(u, method, headers, body, proxy, redirects).then(resolve, reject);
    }

    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
          res.resume(); // дочитываем и отпускаем сокет
          const next = new URL(res.headers.location, u).toString();
          return request(next, { method, headers: opts.headers, body }, redirects + 1).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );

    req.setTimeout(CONFIG.requestTimeoutMs, () => req.destroy(new Error(`таймаут ${CONFIG.requestTimeoutMs} мс`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ============================== РАЗБОР RSS/ATOM ============================= */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

function stripHtml(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Снимает CDATA, HTML и лишние сущности; возвращает чистый текст. */
function cleanText(s) {
  if (!s) return '';
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = decodeEntities(t); // &lt;p&gt; → <p>, иначе stripHtml их не увидит
  t = stripHtml(t);
  t = decodeEntities(t);
  return t.replace(/\s+/g, ' ').trim();
}

function tagContent(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Bing отдаёт ссылки через редирект apiclick — достаём реальный URL источника. */
function normalizeLink(link) {
  try {
    const u = new URL(link);
    if (/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname.includes('/news/apiclick')) {
      const target = u.searchParams.get('url');
      if (target && /^https?:/i.test(target)) return target;
    }
    return link;
  } catch {
    return link;
  }
}

/** Парсер RSS 2.0 и Atom. Возвращает массив нормализованных новостей. */
function parseFeed(xml, sourceName) {
  const items = [];
  const blocks = [];

  let m;
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  while ((m = itemRe.exec(xml))) blocks.push(m[1]);

  if (blocks.length === 0) {
    const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((m = entryRe.exec(xml))) blocks.push(m[1]);
  }

  for (const block of blocks) {
    const title = cleanText(tagContent(block, 'title'));
    if (!title) continue;

    let link = cleanText(tagContent(block, 'link'));
    if (!link) {
      const lm = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      if (lm) link = lm[1];
    }
    if (!link) continue;
    link = normalizeLink(link);

    const dateRaw =
      tagContent(block, 'pubDate') ||
      tagContent(block, 'published') ||
      tagContent(block, 'updated') ||
      tagContent(block, 'dc:date');

    const descRaw =
      tagContent(block, 'description') ||
      tagContent(block, 'summary') ||
      tagContent(block, 'content:encoded') ||
      tagContent(block, 'content');

    items.push({
      title,
      link,
      source: sourceName,
      publishedAt: parseDate(dateRaw),
      summary: cleanSummary(cleanText(descRaw)),
    });
  }
  return items;
}

/* ================================ АНАЛИЗ ================================ */

// Мусорные/рекламные паттерны — такие новости отбрасываем.
const SPAM_RE =
  /(casino|казино|ставк[аи]|промокод|giveaway|подписывайтесь|реклама на сайте|заработок в интернете|forex|бинарн\w* опцион|took the trade|take profit|stop loss|signals? group|entry price|how to buy|как купить)/i;

// Ключевые слова и их вес: чем важнее тема, тем выше вклад в рейтинг.
const KEYWORDS = [
  [/\b(openai|chatgpt|gpt-?[45]|o[13])\b/i, 4],
  [/\b(anthropic|claude|gemini|deepmind|llama|mistral|qwen|deepseek|grok)\b/i, 4],
  [/(\bllm\b|large language model|нейросет|искусственн\w* интеллект|генеративн\w*)/i, 4],
  [/\b(machine learning|нейронн\w*|deep learning)\b/i, 2],
  [/\b(nvidia|gpu|tpu|чип\w*|дата-?центр\w*)\b/i, 2],
  [/\b(agent|агент\w*|robotics|робот\w*|autonomous|автономн\w*)\b/i, 2],
  [/\b(funding|инвестиц\w*|раунд|ipo|acquisition|покупк\w*|сделк\w*)\b/i, 2],
  [/\b(regulation|регулир\w*|закон\w*|policy|safety|безопасн\w*)\b/i, 2],
  [/\b(research|исследован\w*|paper|benchmark|бенчмарк|прорыв|breakthrough)\b/i, 1],

  // --- Крипта и Web3 ---
  [/\b(airdrop|аирдроп\w*|эйрдроп\w*)\b/i, 6],
  [/\b(testnet|тестнет\w*|test net)\b/i, 6],
  [/\b(retrodrop|ретродроп\w*|retro drop)\b/i, 6],
  [/\b(gamefi|play-to-earn|play to earn|p2e|crypto game|криптоигр\w*|игров\w* токен\w*)\b/i, 5],
  [/\b(nft|нфт)\b/i, 3],
  [/\b(blockchain|блокчейн\w*|web3|веб3)\b/i, 3],
  [/\b(defi|стейкинг|staking|mainnet|мейннет|presale|launchpad|листинг|listing)\b/i, 3],
  [/\b(token|токен\w*)\b/i, 2],
  [/\b(bitcoin|биткоин\w*|ethereum|эфириум\w*|solana|binance|toncoin|toncoin)\b/i, 2],
  [/\b(hack|взлом\w*|exploit|etf|halving|халвинг\w*|hard fork|форк)\b/i, 2],

  // --- Твиттер-маркеры активностей (X-посты, репосты в RSS) ---
  // ВАЖНО: \b в JS не работает с кириллицей, поэтому русские варианты — без границ слова.
  [/(thread|тред)/i, 2],
  [/(giveaway|гивэвэй)/i, 4],
  [/(whitelist|вайтлист|\bwl\b)/i, 4],
  [/(mint|минт)/i, 4],
  [/(ton\s*game|ton\s*игр)/i, 5],

  // --- Гик-инструменты и инди-софт ---
  [/(open[- ]?source|опенсорс)/i, 4],
  [/(github|гитхаб|репозитори|\brepository\b)/i, 4],
  [/(local\s*ai|локальн\w*\s+ии)/i, 5],
  [/(своими руками|\bdiy\b|сделай сам)/i, 4],
  [/(скрипт|\bscript)/i, 3],
  [/(плагин|\bplugin)/i, 3],
  [/(расширени|\bextension)/i, 3],
  [/(утилит|инструмент|\btool)/i, 3],
  [/(бесплатн|\bfree\b)/i, 2],
  [/(аналог|\balternative\b)/i, 3],
  [/(self[- ]?hosted|селфхост|show hn)/i, 3],
  [/(лайфхак|\blifehack)/i, 3],

  // --- Локальные новости: Лениногорск и Татнефть (высший приоритет, +10) ---
  [/(лениногорск|leninogorsk)/i, 10],
  [/(татнефть|tatneft)/i, 10],
  [/(лениногорскнефть)/i, 10],
  [/(нгду)/i, 10],
  [/(татарстан)/i, 10],

  // --- Скидки и акции ритейла (+8) ---
  [/(пятёрочк|пятерочк)/i, 8],
  [/(магнит)/i, 8],
  [/(красное\s*&?\s*белое|к&б|\bкб\b)/i, 8],
  [/(бристоль)/i, 8],
  [/(скидк)/i, 8],
  [/(акци)/i, 8],
  [/(распродаж)/i, 8],
  [/(выгодн\w*\s+цен)/i, 8],
  [/(каталог\s+товаров)/i, 8],
];

function cleanSummary(text) {
  return text
    .replace(/The post .{0,200}? appeared first on .{0,100}?\.?$/i, '')
    .replace(/Читать далее[\s\S]*$/i, '')
    .replace(/Continue reading[\s\S]*$/i, '')
    .replace(/\s*(Article URL|Comments URL|Points|# Comments)\s*:[\s\S]*$/i, '')
    .replace(/\[…\]|\[&hellip;\]/g, '')
    .trim();
}

function summarize(text, max = 240) {
  const t = cleanSummary(text || '');
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[.,;:!?\s]+$/, '') + '…';
}

// Активности, ради которых добавлена крипто-лента: аирдропы, тестнеты, GameFi.
const ACTIVITY_RE =
  /(airdrop|аирдроп|эйрдроп|эирдроп|testnet|тестнет|retrodrop|ретродроп|gamefi|play-to-earn|p2e|криптоигр|presale|launchpad|\bthread\b|тред|giveaway|гивэвэй|whitelist|вайтлист|\bwl\b|ton\s*game)/i;

// Гео-маркеры локальных новостей (Лениногорск / Татнефть).
// «Татарстан» остаётся в скоринге, но сам по себе в локальную секцию не пропускает.
const LOCAL_RE =
  /(лениногорск|leninogorsk|татнефть|tatneft|лениногорскнефть|нгду)/i;

// Маркеры скидок и акций ритейла.
const DEALS_RE =
  /(пятёрочк|пятерочк|магнит|красное\s*&?\s*белое|к&б|кб|бристоль|скидк|акци|распродаж|выгодн\w*\s+цен|каталог\s+товаров|промо)/i;

// Для раздела скидок нужен именно признак промо (а не «акции» = ценные бумаги).
const DEALS_PROMO_RE =
  /(скидк|распродаж|промо|выгодн\w*\s+цен|каталог\s+товаров|спецпредложен|дисконт|акци\w*\s+(на|в|со|от|в\s+магазин))/i;

// Фондовые новости про «акции Магнита» в скидки не пускаем.
const STOCKS_RE =
  /(фондов|бирж|котиров|дивиденд|капитализац|техническ\w*\s+анализ|сопротивлени|\bmgnt\b|инвестор|мосбирж|обвалил|подскочил)/i;

// Признак того, что новость действительно про крипту (фильтр офтопа из общих лент).
const CRYPTO_MARKER_RE =
  /(crypto|крипт|bitcoin|биткоин|\bbtc\b|ethereum|эфир\w*|\beth\b|blockchain|блокчейн|\btoken\b|токен|nft|defi|web3|stablecoin|стейблкоин|airdrop|аирдроп|testnet|тестнет|retrodrop|ретродроп|gamefi|play-to-earn|p2e|mining|майнинг|wallet|кошел\w*|exchange|бирж\w*|binance|solana|toncoin|ledger|halving|халвинг|\betf\b|\bdao\b|metaverse|метавселен)/i;

function scoreItem(item, now) {
  const text = `${item.title} ${item.summary}`;
  if (SPAM_RE.test(text)) return -Infinity;
  if (item.title.length < 15) return -Infinity;
  // В крипто-раздел не пускаем новости, где нет ни одного крипто-признака.
  if (item.category === 'crypto' && !CRYPTO_MARKER_RE.test(text)) return -Infinity;
  // В локальный раздел — только новости про Лениногорск/Татнефть/Татарстан.
  if (item.category === 'local' && !LOCAL_RE.test(text)) return -Infinity;
  // В раздел скидок — только материалы про акции и торговые сети.
  if (item.category === 'deals') {
    if (!DEALS_RE.test(text)) return -Infinity;
    if (STOCKS_RE.test(text)) return -Infinity;
    if (!DEALS_PROMO_RE.test(text)) return -Infinity;
    // Скидки Беларуси/Казахстана/Украины для читателя из Татарстана нерелевантны.
    if (/(беларус|минск|казахстан|украин|киев)/i.test(text)) return -Infinity;
  }

  let score = 0;
  // Приоритет узкопрофильных источников: EGamers — всегда, AirdropAlert — только для активностей.
  if (item.activityFeed || ACTIVITY_RE.test(text)) score += item.boost || 0;
  if (ACTIVITY_RE.test(text)) score += 8; // аирдропы/тестнеты/GameFi — в приоритет
  for (const [re, weight] of KEYWORDS) {
    if (re.test(item.title)) score += weight * 2;
    else if (re.test(item.summary)) score += weight;
  }

  if (item.publishedAt) {
    const ageHours = (now - item.publishedAt.getTime()) / 36e5;
    if (ageHours < -2) score -= 3; // дата из будущего — подозрительно
    score += Math.max(0, 5 - Math.max(0, ageHours) / 5); // бонус за свежесть
  } else {
    score -= 2; // без даты — ниже в выдаче
  }

  if (item.summary.length > 80) score += 1;
  return score;
}

function inWindow(item, now, hours) {
  if (!item.publishedAt) return true;
  const text = `${item.title} ${item.summary}`;
  let limit = ACTIVITY_RE.test(text) ? CONFIG.activityWindowHours : hours;
  if (item.category === 'local') limit = CONFIG.localWindowHours;
  if (item.category === 'deals') limit = CONFIG.dealsWindowHours;
  const age = now - item.publishedAt.getTime();
  return age <= limit * 36e5 && age >= -2 * 36e5;
}

function dedupeKey(item) {
  try {
    const u = new URL(item.link);
    // Убираем трекинговые параметры, но оставляем значимые (например, url= у Bing).
    const params = [...u.searchParams.entries()]
      .filter(([key]) => !/^(utm_|ref|aid|tid|c|mkt|ocid|yclid)/i.test(key))
      .sort()
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}${params ? `?${params}` : ''}`.toLowerCase();
  } catch {
    return item.title.toLowerCase();
  }
}

/* =============================== ПЕРЕВОД =============================== */

const CYRILLIC_RE = /[А-Яа-яЁё]/g;

/** Текст уже на русском? Тогда переводить не нужно. */
function hasCyrillic(text) {
  const letters = text.match(/[A-Za-zА-Яа-яЁё]/g) || [];
  if (letters.length < 3) return false;
  const cyrillic = (text.match(CYRILLIC_RE) || []).length;
  return cyrillic / letters.length > 0.5;
}

/** Бесплатный эндпоинт Google (клиент Chrome): без ключа и регистрации. */
async function translateViaClients5(text) {
  const url =
    'https://clients5.google.com/translate_a/t?client=dict-chrome-ex' +
    `&sl=auto&tl=${TRANSLATE.target}&q=${encodeURIComponent(text)}`;
  const res = await request(url);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const data = JSON.parse(res.body);
  if (Array.isArray(data)) {
    if (Array.isArray(data[0])) return data.map((part) => part[0]).join(' ').trim();
    if (typeof data[0] === 'string') return data[0];
  }
  throw new Error('неожиданный формат ответа Google');
}

/** Резервный бесплатный сервис MyMemory (лимит ~500 символов на запрос). */
async function translateViaMyMemory(text) {
  const url =
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
    `&langpair=en%7C${TRANSLATE.target}`;
  const res = await request(url);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const data = JSON.parse(res.body);
  const translated = data && data.responseData && data.responseData.translatedText;
  if (!translated || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(translated)) throw new Error('нет перевода');
  return decodeEntities(translated);
}

/** Перевод строки на русский с кэшем и фолбэком; при неудаче возвращает оригинал. */
async function translateText(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (hasCyrillic(source)) return source;
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return source; // owner/repo — не переводим

  const key = source.slice(0, 400);
  if (TRANSLATE.cache.has(key)) return TRANSLATE.cache.get(key);

  // MyMemory не принимает длинные строки — подрезаем до 450 символов.
  const input = source.length > 450 ? `${source.slice(0, 450)}…` : source;
  let result = null;
  for (const translate of [translateViaClients5, translateViaMyMemory]) {
    try {
      const out = await translate(input);
      if (out && out.trim()) {
        result = out.trim();
        break;
      }
    } catch {
      /* пробуем следующий сервис */
    }
  }

  if (!result) result = source; // перевод не удался — оставляем оригинал
  TRANSLATE.cache.set(key, result);
  await sleep(80); // мягко ограничиваем частоту запросов
  return result;
}

/** Параллельная обработка массива с ограничением concurrency. */
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Отбор с квотами по категориям: в дайджесте должны быть и ИИ, и крипта. */
function selectBalanced(items, limit, quotas) {
  const chosen = [];
  const leftovers = [];
  for (const [category, quota] of Object.entries(quotas)) {
    const list = items.filter((item) => item.category === category);
    chosen.push(...list.slice(0, quota));
    leftovers.push(...list.slice(quota));
  }
  const remaining = limit - chosen.length;
  if (remaining > 0) {
    leftovers.sort((a, b) => b.score - a.score);
    chosen.push(...leftovers.slice(0, remaining));
  }
  return chosen.slice(0, limit);
}

/* =============================== ФОРМАТ ================================ */

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeAgo(date, now) {
  const minutes = Math.round((now - date.getTime()) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatItem(item, index, now) {
  const meta = item.publishedAt
    ? `${escapeHtml(item.source)} · ${timeAgo(item.publishedAt, now)}`
    : escapeHtml(item.source);
  return [
    `${index + 1}. <b>${escapeHtml(item.title)}</b>`,
    meta,
    escapeHtml(summarize(item.summary)),
    `🔗 ${escapeHtml(item.link)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatDigest(items, now) {
  const aiItems = items.filter((item) => item.category === 'ai');
  const geekItems = items.filter((item) => item.category === 'geek');
  const activityItems = items.filter((item) => item.category === 'crypto' && item.activity);
  const cryptoItems = items.filter((item) => item.category === 'crypto' && !item.activity);
  const localItems = items.filter((item) => item.category === 'local');
  const dealsItems = items.filter((item) => item.category === 'deals');

  const head = [
    '🧠 <b>AI &amp; Crypto Digest</b>',
    `${fmtDate(new Date(now))} · новости ${CONFIG.windowHours} ч · активности ${CONFIG.activityWindowHours} ч · локальные ${CONFIG.localWindowHours / 24} дн · скидки ${CONFIG.dealsWindowHours / 24} дн`,
    `Новостей: ${items.length} · ИИ: ${aiItems.length} · Гик: ${geekItems.length} · Крипта: ${activityItems.length + cryptoItems.length} · Локальные: ${localItems.length} · Скидки: ${dealsItems.length}`,
  ].join('\n');

  const sections = [];
  if (aiItems.length) {
    sections.push(
      '🤖 <b>ИИ и технологии</b>\n\n' + aiItems.map((item, i) => formatItem(item, i, now)).join('\n\n')
    );
  }
  if (geekItems.length) {
    sections.push(
      '🛠 <b>ИИ-инструменты и лайфхаки</b>\n\n' + geekItems.map((item, i) => formatItem(item, i, now)).join('\n\n')
    );
  }
  if (activityItems.length) {
    sections.push(
      '🎁 <b>Активности: аирдропы, тестнеты, GameFi</b>\n\n' +
        activityItems.map((item, i) => formatItem(item, i, now)).join('\n\n')
    );
  }
  if (cryptoItems.length) {
    sections.push(
      '🪙 <b>Крипта и Web3</b>\n\n' + cryptoItems.map((item, i) => formatItem(item, i, now)).join('\n\n')
    );
  }
  if (localItems.length) {
    sections.push(
      '📍 <b>Локальные новости (Лениногорск и Татнефть)</b>\n\n' +
        localItems.map((item, i) => formatItem(item, i, now)).join('\n\n')
    );
  }
  if (dealsItems.length) {
    sections.push(
      '🛒 <b>Выгодные акции и скидки (Пятёрочка, Магнит, К&Б, Бристоль)</b>\n\n' +
        dealsItems.map((item, i) => formatItem(item, i, now)).join('\n\n')
    );
  }

  return `${head}\n\n${sections.join('\n\n')}`;
}

/** Режет текст на части, не превышающие лимит Telegram (по границам абзацев). */
function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/* =============================== TELEGRAM =============================== */

async function telegramApi(method, payload) {
  const body = JSON.stringify(payload);
  const res = await request(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`Telegram вернул не-JSON (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  }
  if (!json.ok) {
    throw new Error(`Telegram API HTTP ${res.status}: ${json.description || res.body.slice(0, 200)}`);
  }
  return json.result;
}

async function sendToTelegram(text) {
  try {
    const chunks = chunkText(text, CONFIG.telegramChunkLimit);
    for (let i = 0; i < chunks.length; i++) {
      const result = await telegramApi('sendMessage', {
        chat_id: TELEGRAM_CHAT_ID,
        text: chunks[i],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      log(`  ✓ сообщение ${i + 1}/${chunks.length} отправлено (message_id=${result.message_id})`);
      if (i < chunks.length - 1) await sleep(700); // мягко соблюдаем rate limit
    }
  } catch (e) {
    const code = e.code || '';
    if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(code) || /timeout|таймаут/i.test(e.message)) {
      throw new Error(`${e.message} — api.telegram.org недоступен из этой сети. Включите VPN/прокси и повторите.`);
    }
    throw e;
  }
}

/* ================================ СБОР ================================= */

async function collectFeed(feed) {
  const started = Date.now();
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await request(feed.url);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const items = parseFeed(res.body, feed.name).map((item) => ({
        ...item,
        category: feed.category,
        boost: feed.boost || 0,
        activityFeed: !!feed.activityFeed,
        feedCap: feed.maxPerFeed || CONFIG.maxPerFeed,
      }));
      log(`  • ${feed.name}: ${items.length} записей (${Date.now() - started} мс)`);
      return items;
    } catch (e) {
      lastError = e;
      if (attempt === 1) await sleep(800); // одна повторная попытка для нестабильных лент
    }
  }
  if (feed.optional) {
    log(`  ⚠ ${feed.name}: ${lastError.message} (опциональный источник, пропущен)`);
    return [];
  }
  throw lastError;
}

/* ================================ CLI ================================= */

function parseArgs(argv) {
  const args = { dryRun: false, json: false, test: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--test') args.test = true;
    else if (arg === '--no-translate') args.noTranslate = true;
    else if (arg.startsWith('--hours=')) args.hours = Number(arg.split('=')[1]);
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.split('=')[1]);
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`ai_news_agent.js — дайджест AI-новостей в Telegram

  node ai_news_agent.js                отправить дайджест
  node ai_news_agent.js --dry-run      предпросмотр без отправки
  node ai_news_agent.js --json         вывести отобранные новости в JSON
  node ai_news_agent.js --test         отправить тестовое сообщение
  node ai_news_agent.js --hours=12     окно в часах (по умолчанию 24)
  node ai_news_agent.js --limit=5      сколько новостей в дайджесте (по умолчанию 8)
  node ai_news_agent.js --no-translate отключить перевод на русский

Переменные окружения: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (перекрывают константы в коде),
TELEGRAM_API_BASE (по умолчанию https://api.telegram.org — можно подменить для тестов).`);
}

/* ================================ MAIN ================================ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.noTranslate) TRANSLATE.enabled = false;

  const now = Date.now();
  const hours = Number.isFinite(args.hours) && args.hours > 0 ? args.hours : CONFIG.windowHours;
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : CONFIG.maxItems;

  const tokenReady = !isPlaceholder(TELEGRAM_BOT_TOKEN) && looksLikeToken(TELEGRAM_BOT_TOKEN);
  const chatReady = !isPlaceholder(TELEGRAM_CHAT_ID);
  const dryRun = args.dryRun || !tokenReady || !chatReady;

  log(`AI News Agent — ${new Date(now).toLocaleString('ru-RU')}`);
  log(`Окно: ${hours} ч · источников: ${CONFIG.feeds.length}${dryRun ? ' · режим: DRY RUN' : ''}`);
  log('');

  // ---- 1. Сбор ----
  const settled = await Promise.allSettled(CONFIG.feeds.map(collectFeed));
  const raw = [];
  const failures = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') raw.push(...result.value);
    else failures.push(`${CONFIG.feeds[i].name}: ${result.reason.message}`);
  });
  if (failures.length) {
    log('\nНедоступные источники:');
    failures.forEach((f) => log(`  ✗ ${f}`));
  }
  if (raw.length === 0) {
    throw new Error('Не удалось получить ни одной новости ни из одного источника.');
  }

  // ---- 2. Анализ ----
  const seen = new Set();
  const picked = raw
    .filter((item) => inWindow(item, now, hours))
    .map((item) => ({ ...item, score: scoreItem(item, now) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      const key = dedupeKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Ограничение «не больше N с одной ленты», чтобы дайджест не был однобоким.
  const perFeed = new Map();
  const balanced = picked.filter((item) => {
    const count = perFeed.get(item.source) || 0;
    const cap = item.feedCap || CONFIG.maxPerFeed;
    if (count >= cap) return false;
    perFeed.set(item.source, count + 1);
    return true;
  });

  const countCat = (cat) => balanced.filter((item) => item.category === cat).length;
  log(`  кандидаты: ИИ ${countCat('ai')} · крипта ${countCat('crypto')} · гик ${countCat('geek')} · локальные ${countCat('local')} · скидки ${countCat('deals')}`);

  // Квоты: ИИ 20%, крипта 25%, гик 15%, локальные 20%, скидки 20%.
  const aiQuota = Math.max(1, Math.round(limit * 0.2));
  const cryptoQuota = Math.max(1, Math.round(limit * 0.25));
  const geekQuota = Math.max(1, Math.round(limit * 0.15));
  const localQuota = Math.max(1, Math.round(limit * 0.2));
  const dealsQuota = Math.max(1, limit - aiQuota - cryptoQuota - geekQuota - localQuota);
  const finalItems = selectBalanced(balanced, limit, {
    ai: aiQuota,
    crypto: cryptoQuota,
    geek: geekQuota,
    local: localQuota,
    deals: dealsQuota,
  });

  // Помечаем крипто-активности (аирдропы/тестнеты/GameFi) для отдельной секции.
  finalItems.forEach((item) => {
    item.activity =
      item.category === 'crypto' &&
      (item.activityFeed || ACTIVITY_RE.test(`${item.title} ${item.summary}`));
  });

  log(`\nПосле фильтрации: ${finalItems.length} новостей (сырых: ${raw.length}, в окне: ${picked.length})`);  if (finalItems.length === 0) {
    log('Нет подходящих новостей за указанный период.');
    return;
  }

  // ---- 2.5. Перевод на русский ----
  if (TRANSLATE.enabled) {
    const startedTranslate = Date.now();
    log(`Перевод на русский: ${finalItems.length} новостей...`);
    await mapLimit(finalItems, TRANSLATE.concurrency, async (item) => {
      const [title, summary] = await Promise.all([translateText(item.title), translateText(item.summary)]);
      item.title = title;
      item.summary = summary;
    });
    log(`  ✓ перевод готов (${Date.now() - startedTranslate} мс)`);
  }

  if (args.json) {
    console.log(JSON.stringify(finalItems, null, 2));
    return;
  }

  // ---- 3. Отправка ----
  const digest = formatDigest(finalItems, now);

  if (args.test) {
    const text = `✅ <b>AI News Agent</b> на связи.\nИсточников: ${CONFIG.feeds.length}, новостей в окне: ${finalItems.length}.`;
    if (dryRun) {
      log('\n--- ТЕСТОВОЕ СООБЩЕНИЕ (предпросмотр) ---\n');
      log(text);
      log('\n--- КОНЕЦ ---');
      await showTelegramReachability();
      return;
    }
    await sendToTelegram(text);
    log('Тестовое сообщение отправлено.');
    return;
  }

  if (dryRun) {
    log('\n--- ПРЕДПРОСМОТР СООБЩЕНИЯ ---\n');
    log(digest);
    log('\n--- КОНЕЦ ---');
    log('\n[!] Отправка пропущена: задайте реальные TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.');
    await showTelegramReachability();
    return;
  }

  log('\nОтправка в Telegram...');
  await sendToTelegram(digest);
  log('Готово.');
}

/** Проверяет, что api.telegram.org вообще доступен из этой среды (не отправляет данные в чат). */
async function showTelegramReachability() {
  try {
    const res = await request('https://api.telegram.org/bot123456:FAKE/getMe');
    log(`\n[проверка] api.telegram.org доступен: HTTP ${res.status} (ожидаемо 404 для фиктивного токена).`);
  } catch (e) {
    log(`\n[проверка] api.telegram.org недоступен: ${e.code || e.message || 'ошибка сети'}.`);
    log('           Если это Россия/корпоративная сеть — включите VPN: Telegram API часто блокируется провайдером.');
  }
}

main().catch((err) => {
  console.error('\nОшибка:', err.message);
  process.exit(1);
});
