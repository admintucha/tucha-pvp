"use strict";
// =====================================================
// TUCHA GAMES — PvP-сервер (рулетка-джекпот в реальном времени)
// Запускается на Render. Баланс игроков остаётся в твоей Google Таблице:
// сервер ходит в Apps Script через «мост» (действия pvp_*), защищённый секретом.
//
// Переменные окружения (Render → Environment):
//   BOT_TOKEN        — токен Telegram-бота (тот же, что в Script Properties)
//   APPS_SCRIPT_URL  — адрес твоего веб-приложения Apps Script (…/exec)
//   PVP_SECRET       — длинный случайный пароль; такой же в Script Properties
// =====================================================
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const SCRIPT_URL = process.env.APPS_SCRIPT_URL || "";
const PVP_SECRET = process.env.PVP_SECRET || "";
if (!BOT_TOKEN || !SCRIPT_URL || !PVP_SECRET) {
  console.error("Не заданы переменные окружения: BOT_TOKEN, APPS_SCRIPT_URL, PVP_SECRET");
  process.exit(1);
}

// ---------- НАСТРОЙКИ ИГРЫ ----------
const FEE_PCT = 8;                                        // комиссия, % от банка
const MIN_CENTS = 10;                                     // мин. ставка $0.10
const MAX_CENTS = 10000;                                  // макс. суммарно на игрока за раунд $100
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 30000; // обратный отсчёт после входа 2-го игрока
const SPIN_MS = Number(process.env.SPIN_MS) || 7000;      // длительность вращения колеса
const RESULT_MS = Number(process.env.RESULT_MS) || 6000;  // показ победителя до нового раунда
const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#14b8a6", "#f97316", "#84cc16", "#06b6d4"];

// ---------- СТИКЕРЫ И ОГОНЁК-МНОЖИТЕЛЬ ----------
const FLAME_EVERY_MS = Number(process.env.FLAME_EVERY_MS) || 5 * 60000; // раз в 5 минут
const FLAME_TTL_MS = 3000;                                              // огонёк висит 3 секунды
const BONUS_CAP_CENTS = Math.round((Number(process.env.BONUS_CAP) || 50) * 100); // макс. доплата казино за раунд, $
const EMOTES = new Set(["fire", "heart", "like", "dislike", "sad", "laugh", "wow", "money", "luck"]);
// Чаще всего 1.1–1.4, редко x2, иногда x3, очень редко x4–x5 (веса в сумме 100)
const BOOSTS = [[1.1, 34], [1.2, 22], [1.3, 18], [1.4, 12], [1.5, 6], [2, 5], [3, 2.2], [4, 0.6], [5, 0.2]];
function rollBoost() {
  let r = crypto.randomInt(0, 100000) / 1000;
  for (const b of BOOSTS) { r -= b[1]; if (r < 0) return b[0]; }
  return BOOSTS[0][0];
}
let lastFlameAt = Date.now();
let flame = null;           // {id, claimed:Set} — активный огонёк

const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeName = s => String(s || "Игрок").replace(/[<>&"']/g, "").slice(0, 20) || "Игрок";

// ---------- МОСТ К APPS SCRIPT ----------
async function bridge(action, payload, tries, retryAll) {
  tries = tries || 1;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(SCRIPT_URL, {
        method: "POST",
        headers: {"Content-Type": "text/plain;charset=utf-8"},
        body: JSON.stringify(Object.assign({}, payload, {action: action, secret: PVP_SECRET})),
        redirect: "follow",
        signal: AbortSignal.timeout(25000)
      });
      const d = await res.json();
      if (!d || d.status !== "success") {
        const e = new Error((d && d.message) || "Ошибка сервера баланса");
        e.business = true;
        throw e;
      }
      return d;
    } catch (e) {
      last = e;
      if (e.business && !retryAll) throw e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

// ---------- ПРОВЕРКА TELEGRAM ----------
function verifyInitData(initData) {
  const params = new URLSearchParams(String(initData || ""));
  const hash = params.get("hash");
  if (!hash) throw new Error("Открой игру через Telegram.");
  params.delete("hash");
  const check = Array.from(params.entries()).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; })
    .map(function (kv) { return kv[0] + "=" + kv[1]; }).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Подпись Telegram не прошла.");
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) throw new Error("Данные Telegram устарели. Перезапусти игру.");
  let user = {};
  try { user = JSON.parse(params.get("user") || "{}"); } catch (e) { throw new Error("Не удалось прочитать игрока."); }
  if (!user.id) throw new Error("Нет ID игрока.");
  return {id: String(user.id), name: safeName(user.username || user.first_name)};
}

// ---------- СОСТОЯНИЕ РАУНДА ----------
let ready = false;          // true после возврата «зависших» ставок при запуске
let history = [];           // последние победители
let round = newRound();
const failedSettles = [];   // выплаты, которые не прошли — повторяем

function newRound() {
  return {id: crypto.randomUUID(), phase: "waiting", endsAt: 0, spinEndsAt: 0, bets: [], pending: 0, pendingBy: new Map(), boosts: new Map(), result: null};
}
function aggregate(r) {
  const map = new Map();
  r.bets.forEach(function (b) {
    let p = map.get(b.userid);
    if (!p) { p = {userid: b.userid, name: b.name, cents: 0, color: COLORS[map.size % COLORS.length]}; map.set(b.userid, p); }
    p.cents += b.cents;
  });
  return Array.from(map.values());
}
function userCents(r, uid) {
  return r.bets.reduce(function (s, b) { return b.userid === uid ? s + b.cents : s; }, 0) + (r.pendingBy.get(uid) || 0);
}
function publicState() {
  const ps = aggregate(round), total = ps.reduce(function (s, p) { return s + p.cents; }, 0);
  return {type: "state", history: history, round: {
    id: round.id, phase: round.phase, endsAt: round.endsAt, spinEndsAt: round.spinEndsAt, now: Date.now(),
    players: ps.map(function (p) { return {userid: p.userid, name: p.name, amount: p.cents / 100, color: p.color, boost: round.boosts.get(p.userid) || 0}; }),
    total: total / 100, min: MIN_CENTS / 100, max: MAX_CENTS / 100, fee: FEE_PCT, result: round.result}};
}

// ---------- РАССЫЛКА ----------
const server = http.createServer(function (req, res) { res.writeHead(200, {"Content-Type": "text/plain"}); res.end("tucha pvp ok"); });
const wss = new WebSocketServer({server: server, maxPayload: 4096});

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcastState() {
  const data = JSON.stringify(publicState());
  wss.clients.forEach(function (c) { if (c.user && c.readyState === 1) c.send(data); });
}
function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach(function (c) { if (c.user && c.readyState === 1) c.send(data); });
}
function notifyBalances(map) {
  if (!map) return;
  wss.clients.forEach(function (c) {
    if (c.user && map[c.user.id] !== undefined) send(c, {type: "balance", balance: map[c.user.id]});
  });
}

// ---------- СТАВКИ ----------
async function handleBet(ws, m) {
  const u = ws.user, r = round;
  if (!ready) return send(ws, {type: "error", message: "Сервер запускается, подожди 10 секунд."});
  if (r.phase !== "waiting" && r.phase !== "countdown") return send(ws, {type: "error", message: "Ставки закрыты. Дождись следующего раунда."});
  const cents = Math.round(Number(m.amount) * 100);
  if (!Number.isInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS) return send(ws, {type: "error", message: "Ставка от $0.10 до $100."});
  if (userCents(r, u.id) + cents > MAX_CENTS) return send(ws, {type: "error", message: "Максимум $100 на раунд."});
  if (ws.betting) return;
  ws.betting = true;
  r.pending++;
  r.pendingBy.set(u.id, (r.pendingBy.get(u.id) || 0) + cents);
  try {
    const betId = crypto.randomUUID();
    const d = await bridge("pvp_bet", {userid: u.id, round_id: r.id, bet_id: betId, amount: cents / 100});
    r.bets.push({betId: betId, userid: u.id, name: u.name, cents: cents});
    send(ws, {type: "balance", balance: d.balance});
    send(ws, {type: "bet_ok"});
    if (r.phase === "waiting" && aggregate(r).length >= 2) startCountdown(r);
    broadcastState();
  } catch (e) {
    send(ws, {type: "error", message: String(e.message || "Не удалось поставить")});
  } finally {
    r.pending--;
    r.pendingBy.set(u.id, (r.pendingBy.get(u.id) || 0) - cents);
    ws.betting = false;
  }
}

function handleEmote(ws, m) { // стикер видят все, кроме отправителя (у него он уже показан)
  if (!EMOTES.has(m.id)) return;
  const data = JSON.stringify({type: "emote", userid: ws.user.id, id: m.id});
  wss.clients.forEach(function (c) { if (c !== ws && c.user && c.readyState === 1) c.send(data); });
}
function handleFlameClaim(ws, m) {
  const u = ws.user, f = flame;
  if (!f || f.id !== m.id || round.phase !== "countdown") return send(ws, {type: "info", message: "Огонёк уже погас"});
  if (!aggregate(round).some(function (p) { return p.userid === u.id; })) return send(ws, {type: "info", message: "Сначала сделай ставку, потом лови огонёк!"});
  if (f.claimed.has(u.id)) return;
  f.claimed.add(u.id);
  const mult = rollBoost();
  round.boosts.set(u.id, mult);
  send(ws, {type: "flame_result", mult: mult});
  broadcastState();
}

function startCountdown(r) {
  r.phase = "countdown";
  r.endsAt = Date.now() + COUNTDOWN_MS;
  if (Date.now() - lastFlameAt >= FLAME_EVERY_MS) { // пора: огонёк появится в этом раунде
    lastFlameAt = Date.now();
    setTimeout(function () {
      if (round !== r || r.phase !== "countdown") return;
      flame = {id: crypto.randomUUID(), claimed: new Set()};
      const f = flame;
      broadcast({type: "flame", id: f.id, x: 12 + crypto.randomInt(0, 76), y: 15 + crypto.randomInt(0, 70), ttl: FLAME_TTL_MS});
      setTimeout(function () { if (flame === f) flame = null; }, FLAME_TTL_MS + 500);
    }, 4000 + crypto.randomInt(0, 8000));
  }
  setTimeout(function () { finishRound(r).catch(function (e) { console.error("finishRound", e); }); }, COUNTDOWN_MS);
}

function nextRound() {
  flame = null;
  round = newRound();
  broadcastState();
}

async function settle(payload) {
  try {
    const d = await bridge("pvp_settle", payload, 6, true);
    notifyBalances(d.balances);
    return true;
  } catch (e) {
    console.error("settle failed, в очередь повтора:", e.message);
    failedSettles.push(payload);
    return false;
  }
}

async function finishRound(r) {
  r.phase = "locking";
  broadcastState();
  const t0 = Date.now();
  while (r.pending > 0 && Date.now() - t0 < 30000) await sleep(100);

  const ps = aggregate(r);
  if (ps.length < 2) { // некому играть — возвращаем ставки
    await settle({round_id: r.id, winner: "", payout: 0, bet_ids: []});
    broadcast({type: "info", message: "Недостаточно игроков — ставки возвращены."});
    return nextRound();
  }

  const totalCents = ps.reduce(function (s, p) { return s + p.cents; }, 0);
  const ticket = crypto.randomInt(0, totalCents);
  let acc = 0, winner = ps[ps.length - 1];
  for (let i = 0; i < ps.length; i++) { acc += ps[i].cents; if (ticket < acc) { winner = ps[i]; break; } }
  const baseCents = Math.floor(totalCents * (100 - FEE_PCT) / 100);
  const mult = r.boosts.get(winner.userid) || 1;                       // множитель огонька победителя
  const bonusCents = mult > 1 ? Math.min(BONUS_CAP_CENTS, Math.round(baseCents * (mult - 1))) : 0; // доплату платит казино
  const payoutCents = baseCents + bonusCents;
  const fraction = (ticket + crypto.randomInt(0, 1000) / 1000) / totalCents; // позиция на колесе, 0..1 по часовой от верха

  r.result = {winner: {userid: winner.userid, name: winner.name}, fraction: fraction, payout: payoutCents / 100, total: totalCents / 100, boost: mult > 1 ? mult : 0};
  r.phase = "spin";
  r.spinEndsAt = Date.now() + SPIN_MS;
  broadcastState();

  const settleP = settle({round_id: r.id, winner: winner.userid, payout: payoutCents / 100, bonus: bonusCents / 100, bet_ids: r.bets.map(function (b) { return b.betId; })});
  await Promise.all([sleep(SPIN_MS), settleP]);

  history.unshift({name: winner.name, payout: payoutCents / 100, total: totalCents / 100});
  history = history.slice(0, 10);
  r.phase = "result";
  broadcastState();
  await sleep(RESULT_MS);
  nextRound();
}

// повтор невыплаченных расчётов
setInterval(async function () {
  const list = failedSettles.splice(0, failedSettles.length);
  for (const p of list) await settle(p);
}, 30000);

// ---------- ПОДКЛЮЧЕНИЯ ----------
wss.on("connection", function (ws) {
  if (wss.clients.size > 1500) return ws.close();
  ws.isAlive = true; ws.user = null; ws.msgCount = 0; ws.betting = false; ws.authing = false;
  const authTimer = setTimeout(function () { if (!ws.user) ws.close(); }, 10000);
  ws.on("pong", function () { ws.isAlive = true; });
  ws.on("close", function () { clearTimeout(authTimer); });
  ws.on("error", function () {});

  ws.on("message", async function (raw) {
    if (++ws.msgCount > 30) return ws.close(); // защита от спама
    let m;
    try { m = JSON.parse(String(raw)); } catch (e) { return; }
    try {
      if (m.type === "auth") {
        if (ws.user || ws.authing) return;
        ws.authing = true;
        try {
          const u = verifyInitData(m.initData);
          const d = await bridge("pvp_balance", {userid: u.id});
          ws.user = u;
          send(ws, {type: "balance", balance: d.balance});
          send(ws, {type: "ready"});
          send(ws, publicState());
        } catch (e) {
          send(ws, {type: "error", message: String(e.message || "Ошибка входа")});
          ws.close();
        }
        return;
      }
      if (!ws.user) return;
      if (m.type === "bet") await handleBet(ws, m);
      else if (m.type === "emote") handleEmote(ws, m);
      else if (m.type === "flame_claim") handleFlameClaim(ws, m);
    } catch (e) { console.error("message error", e); }
  });
});

setInterval(function () { wss.clients.forEach(function (c) { c.msgCount = 0; }); }, 1000);
setInterval(function () { // убираем «мёртвые» соединения и держим связь живой
  wss.clients.forEach(function (c) {
    if (!c.isAlive) return c.terminate();
    c.isAlive = false; c.ping();
  });
}, 25000);

// ---------- ЗАПУСК ----------
// При старте возвращаем игрокам ставки раундов, которые оборвались из-за перезапуска сервера.
async function recoverLoop() {
  for (;;) {
    try {
      const d = await bridge("pvp_recover", {}, 3, true);
      console.log("pvp_recover: возвращено ставок:", d.refunded || 0);
      ready = true;
      broadcastState();
      return;
    } catch (e) {
      console.error("pvp_recover не удался, повтор через 10 с:", e.message);
      await sleep(10000);
    }
  }
}
process.on("unhandledRejection", function (e) { console.error("unhandledRejection", e); });
server.listen(PORT, function () { console.log("PvP-сервер слушает порт", PORT); recoverLoop(); });
