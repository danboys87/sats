/**
 * Backtest — Self-Aware Trend System (SATS) 4H, simulasi MODE AUTO
 *
 * Meniru bot: BUY saat SATS flip bullish (entry di open candle berikutnya), exit saat flip bearish /
 * SL SATS / trailing / max hold, dengan batas max posisi dan budget tetap per trade.
 * Filter entry memakai filters.js (sama persis dengan screenerSATS.js live).
 *
 * Cara pakai:
 *   node backtestSATS.js                              # preset dari user-config.json, top 30 koin, 90 hari
 *   node backtestSATS.js --preset crypto --days 180 --top 50
 *   node backtestSATS.js --symbols BTCUSDT,ETHUSDT,SOLUSDT
 *   node backtestSATS.js --compare                    # bandingkan preset & filter
 *   node backtestSATS.js --demo --compare             # tes mesin dengan data acak (tanpa internet)
 *
 * Parameter:
 *   --preset default|crypto|swing|scalping|custom
 *   --atr N --mult N --er N --sl-mult N      override parameter preset
 *   --char-flip                              aktifkan char-flip (versi yang berfungsi)
 *
 * Filter BUY (override config; angka 0 = off):
 *   --min-tqi N     TQI minimal
 *   --ema N         close > EMA N di 4H
 *   --max-risk N    tolak bila jarak close→SL > N%
 *   --vol-min N     volume candle sinyal >= N x rata-rata 20 candle
 *   --rsi-max N     RSI 4H <= N
 *   --ext-max N     (close - EMA21) / ATR <= N
 *   --adx-min N     ADX 4H >= N
 *   --btc-filter ema|sats|off   hanya beli bila BTC bullish (ema = close BTC > EMA --btc-ema, default 126)
 *   --btc-ema N
 *
 * Exit / lainnya:
 *   --no-sl            tanpa stop loss (SL SATS dimatikan)
 *   --max-sl-pct N     batasi jarak SL maksimal N% dari entry (0 = tanpa batas)
 *   --trail-activate N aktifkan trailing di profit N% (0 = off)   --trail-pct N callback %
 *   --max-hold N       jam maksimal menahan posisi (0 = off)
 *   --no-sell-exit     jangan keluar saat flip bearish
 *   --compare-btc      bandingkan baseline vs beberapa definisi filter BTC (tanpa trailing) + kontrol acak
 *   --budget N --max-pos N --fee N --slip N --out DIR --refresh
 */

import fs   from 'fs';
import path from 'path';
import { config } from './config.js';
import { calcSATS, resolveSATSParams, satsBuyLevels } from './sats.js';
import { makeCtx, checkEntryFilters, btcRegimeMap, describeFilters } from './filters.js';

const PERIOD = 4 * 3600 * 1000;
const WARMUP = 250;
const BASE   = 'https://api.bitget.com';

// ───────────────────────────── CLI ─────────────────────────────
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const num = (name, def) => { const v = opt(name, undefined); return v === undefined || v === true ? def : parseFloat(v); };

const mg    = config.management ?? {};
const cfgS  = config.screening?.sats ?? {};
const cfgF  = cfgS.filters ?? {};

const advFromCli = {};
if (opt('atr',     undefined) !== undefined) advFromCli.atrLen   = num('atr');
if (opt('mult',    undefined) !== undefined) advFromCli.baseMult = num('mult');
if (opt('er',      undefined) !== undefined) advFromCli.erLen    = num('er');
if (opt('sl-mult', undefined) !== undefined) advFromCli.slMult   = num('sl-mult');
if (argv.includes('--char-flip'))            advFromCli.charFlip = true;

const BASE_SATS = {
  ...cfgS,
  preset:   String(opt('preset', cfgS.preset ?? 'default')),
  advanced: { ...(cfgS.advanced ?? {}), ...advFromCli },
};

// Filter: default dari user-config.json, bisa di-override lewat CLI
function buildF() {
  const F   = JSON.parse(JSON.stringify(cfgF));
  const has = n => opt(n, undefined) !== undefined;
  if (has('min-tqi'))  F.minTqi    = num('min-tqi');
  if (has('ema'))      F.ema       = { enabled: num('ema') > 0,      period: num('ema') };
  if (has('max-risk')) F.maxRisk   = { enabled: num('max-risk') > 0, maxPct: num('max-risk') };
  if (has('vol-min'))  F.volume    = { ...(F.volume ?? {}),    enabled: num('vol-min') > 0, minRatio: num('vol-min') };
  if (has('rsi-max'))  F.rsi       = { ...(F.rsi ?? {}),       enabled: num('rsi-max') > 0, max: num('rsi-max') };
  if (has('ext-max'))  F.extension = { ...(F.extension ?? {}), enabled: num('ext-max') > 0, maxAtr: num('ext-max') };
  if (has('adx-min'))  F.adx       = { ...(F.adx ?? {}),       enabled: num('adx-min') > 0, min: num('adx-min') };
  if (has('btc-filter')) {
    const v = String(opt('btc-filter'));
    F.btcRegime = { enabled: v !== 'off', mode: v === 'sats' ? 'sats' : 'ema', period: num('btc-ema', F.btcRegime?.period ?? 126) };
  }
  return F;
}

const BASE_PARAMS = {
  budget:        num('budget', config.trading?.budgetPerTrade ?? 100),
  maxPos:        num('max-pos', config.trading?.maxOpenPositions ?? 5),
  F:             buildF(),
  slMode:        argv.includes('--no-sl') ? 'none' : 'sats',
  maxSlPct:      num('max-sl-pct', mg.maxSlPct ?? 0),
  tpR:           cfgS.tpR ?? [1, 2, 3],
  trailActivate: num('trail-activate', mg.trailingStop?.activateAtProfitPct ?? 10),
  trailPct:      num('trail-pct', mg.trailingStop?.trailPct ?? 2),
  beBufPct:      1,                                   // SL saat trailing aktif = entry +1% (sama dengan manager.js)
  maxHoldH:      num('max-hold', mg.maxHoldHours ?? 0),
  exitOnSell:    !argv.includes('--no-sell-exit') && mg.exitOnUTBotSell !== false,
  feePct:        num('fee', config.trading?.feePct ?? 0.1),
  slipPct:       num('slip', 0.05),
};
const DAYS    = num('days', 90);
const TOP_N   = num('top', 30);
const OUT_DIR = String(opt('out', './backtest_out'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────────── DATA ─────────────────────────────
async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
      const j = await res.json();
      if (j.code && j.code !== '00000') throw new Error(`${j.code}: ${j.msg}`);
      return j;
    } catch (e) { lastErr = e; await sleep(800 * (i + 1)); }
  }
  throw lastErr;
}

async function fetchHistory(symbol, days) {
  const need     = Math.ceil(days * 6) + WARMUP + 5;
  const cacheDir = path.join(OUT_DIR, 'cache');
  // "_h" = versi endpoint history-candles (cache lama yang terpotong ~1000 candle tidak ikut terpakai)
  const cacheKey = path.join(cacheDir, `${symbol}_4h_${days}d_w${WARMUP}_h_${new Date().toISOString().slice(0, 10)}.json`);
  if (!argv.includes('--refresh') && fs.existsSync(cacheKey)) {
    try { return JSON.parse(fs.readFileSync(cacheKey, 'utf8')); } catch {}
  }

  // history-candles: maks 200 candle per request, telusuri mundur lewat endTime
  const rows = new Map();
  let end = Date.now(), prevOldest = Infinity;
  while (rows.size < need) {
    const j = await getJson(`${BASE}/api/v2/spot/market/history-candles?symbol=${symbol}&granularity=4h&endTime=${end}&limit=200`);
    const data = j.data;
    if (!Array.isArray(data) || !data.length) break;       // data koin habis (koin baru listing)
    let oldest = Infinity;
    for (const r of data) { const ts = parseInt(r[0]); rows.set(ts, r); if (ts < oldest) oldest = ts; }
    if (oldest >= prevOldest) break;                       // tidak ada kemajuan → API mengabaikan endTime
    prevOldest = oldest;
    end = oldest - 1;
    await sleep(120);
  }

  const periodStart = Date.now() - (Date.now() % PERIOD);
  const candles = [...rows.values()]
    .map(r => ({ t: parseInt(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
    .filter(x => x.t < periodStart && x.o > 0)
    .sort((a, b) => a.t - b.t);

  // Peringatan bila data kurang dari yang diminta (koin baru listing, atau API membatasi)
  const days_got = Math.max(0, (candles.length - WARMUP) / 6);
  if (days_got < days * 0.9) console.log(`\n  ⚠ ${symbol}: data hanya ~${Math.floor(days_got)} hari (diminta ${days})`);

  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheKey, JSON.stringify(candles)); } catch {}
  return candles;
}

async function pickSymbols() {
  const listed = opt('symbols', undefined);
  if (listed && listed !== true) return String(listed).toUpperCase().split(',').map(s => s.trim()).filter(Boolean);

  const minVol = cfgS.minVolume24h ?? 1_000_000;
  const j = await getJson(`${BASE}/api/v2/spot/market/tickers`);
  let crypto = null;
  try {
    const s = await getJson(`${BASE}/api/v2/spot/public/symbols`);
    crypto = new Set(s.data.filter(x => x.areaSymbol === 'no').map(x => x.symbol));
  } catch {}
  return j.data
    .filter(t => t.symbol.endsWith('USDT'))
    .filter(t => !(config.blacklist ?? []).includes(t.symbol))
    .filter(t => !crypto || crypto.has(t.symbol))
    .filter(t => parseFloat(t.usdtVol || t.quoteVolume || 0) >= minVol)
    .sort((a, b) => parseFloat(b.usdtVol || 0) - parseFloat(a.usdtVol || 0))
    .slice(0, TOP_N)
    .map(t => t.symbol);
}

// Data acak untuk menguji mesin tanpa internet (BUKAN data pasar)
function demoHistory(n = 8, days = 200) {
  let seed = 12345;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const end = Date.now() - (Date.now() % PERIOD);
  const out = {};
  for (let k = 0; k < n; k++) {
    let p = 1 + rnd() * 50, drift = 0;
    const total = days * 6 + WARMUP + 5, arr = [];
    for (let i = 0; i < total; i++) {
      if (i % 60 === 0) drift = (rnd() - 0.48) * 0.004;
      const o = p, ret = drift + gauss() * 0.012;
      const c = o * (1 + ret);
      const h = Math.max(o, c) * (1 + Math.abs(gauss()) * 0.004);
      const l = Math.min(o, c) * (1 - Math.abs(gauss()) * 0.004);
      arr.push({ t: end - (total - i) * PERIOD, o, h, l, c, v: 500 + rnd() * 1000 });
      p = c;
    }
    out[`DEMO${k + 1}USDT`] = arr;
  }
  return out;
}

// ───────────────────────────── SERI SATS ─────────────────────────────
function buildSeries(raw, satsCfg) {
  const P = resolveSATSParams(satsCfg);
  const S = new Map();
  for (const [sym, c] of raw) {
    const res = calcSATS(c.map(x => x.h), c.map(x => x.l), c.map(x => x.c), c.map(x => x.v), P);
    S.set(sym, { c, idx: new Map(c.map((x, i) => [x.t, i])), res });
  }
  return { S, P };
}

function mulberry(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ───────────────────────────── SIMULASI ─────────────────────────────
function simulate(P, S, order, tStart) {
  const times = [...new Set(order.flatMap(s => S.get(s).c.filter(x => x.t >= tStart).map(x => x.t)))].sort((a, b) => a - b);
  const slip = P.slipPct / 100, fee = P.feePct / 100;
  const open = new Map(), trades = [], eq = [];
  let realized = 0, btcSkipped = 0;

  const finish = (pos, rawPrice, t, reason) => {
    const px       = rawPrice * (1 - slip);
    const entryVal = pos.entry * pos.qty, exitVal = px * pos.qty;
    const pnl      = exitVal - entryVal - (entryVal + exitVal) * fee;
    trades.push({
      symbol: pos.sym, entryT: pos.t0, exitT: t, entry: pos.entry, exit: px, pnl,
      pnlPct: pnl / entryVal * 100, reason, holdH: (t - pos.t0) / 3600000,
    });
    realized += pnl;
    open.delete(pos.sym);
  };

  // Urutan konservatif: harga turun dulu (SL), baru naik (TP/trailing).
  const manage = (pos, c, T) => {
    const be = pos.entry * (1 + P.beBufPct / 100);

    let stop = pos.sl;
    if (pos.trailing) stop = Math.max(be, pos.peak * (1 - P.trailPct / 100));
    if (stop != null) {
      const why = pos.trailing ? (stop === be ? 'break_even_sl' : 'trailing_stop') : 'stop_loss';
      if (c.o <= stop) return finish(pos, c.o, T, why);
      if (c.l <= stop) return finish(pos, stop, T, why);
    }

    if (P.trailActivate > 0 && !pos.trailing && c.h >= pos.entry * (1 + P.trailActivate / 100)) pos.trailing = true;
    if (pos.trailing) pos.peak = Math.max(pos.peak, c.h);

    if (pos.trailing) {
      const lvl = Math.max(be, pos.peak * (1 - P.trailPct / 100));
      if (c.c <= lvl) return finish(pos, lvl, T, lvl === be ? 'break_even_sl' : 'trailing_stop');
    }

    if (P.maxHoldH > 0 && (c.t + PERIOD - pos.t0) / 3600000 >= P.maxHoldH) return finish(pos, c.c, T, 'max_hold_time');
    pos.last = c.c;
  };

  for (const T of times) {
    // A1. flip bearish di candle sebelumnya → keluar di open candle ini
    for (const sym of order) {
      const s = S.get(sym), j = s.idx.get(T);
      if (j === undefined || j === 0 || s.c[j - 1].t !== T - PERIOD) continue;
      if (P.exitOnSell && s.res.flipDown[j - 1] && open.has(sym)) finish(open.get(sym), s.c[j].o, T, 'sats_sell');
    }
    // A2. flip bullish di candle sebelumnya → masuk di open candle ini
    for (const sym of order) {
      if (open.size >= P.maxPos) break;
      const s = S.get(sym), j = s.idx.get(T);
      if (j === undefined || j === 0 || s.c[j - 1].t !== T - PERIOD) continue;
      const i = j - 1;
      if (!s.res.flipUp[i] || open.has(sym) || i < s.res.params.warmup) continue;
      const lv = satsBuyLevels(s.res, i, P.tpR);
      if (!(lv.risk > 0)) continue;

      // Filter entry (filters.js — identik dengan screener live)
      s.ctx ??= makeCtx({
        highs: s.c.map(x => x.h), lows: s.c.map(x => x.l), closes: s.c.map(x => x.c),
        volumes: s.c.map(x => x.v), atr: s.res.rawAtr,
      });
      const regime = P.btcMap ? { bullish: P.btcMap.get(T - PERIOD) ?? null } : null;
      const why = checkEntryFilters(s.ctx, i, { tqi: s.res.tqi[i], riskPct: lv.riskPct }, P.F, regime);
      if (why) { if (why.startsWith('BTC')) btcSkipped++; continue; }

      if (P.randSkip > 0 && P.rng() < P.randSkip) { btcSkipped++; continue; }  // kontrol: lewati sinyal secara acak

      const entry = s.c[j].o * (1 + slip);
      let sl = null;
      if (P.slMode === 'sats') {
        sl = lv.sl;
        if (entry <= sl) continue;                                   // harga sudah di bawah SL → bot batal beli
        if (P.maxSlPct > 0) sl = Math.max(sl, entry * (1 - P.maxSlPct / 100));
      }
      open.set(sym, { sym, entry, qty: P.budget / entry, t0: T, sl, peak: entry, trailing: false, last: entry });
    }
    // B. manajemen posisi di dalam candle ini
    for (const [sym, pos] of [...open]) {
      const s = S.get(sym), j = s.idx.get(T);
      if (j !== undefined) manage(pos, s.c[j], T);
    }
    // C. equity mark-to-market
    let unreal = 0;
    for (const pos of open.values()) unreal += (pos.last - pos.entry) * pos.qty - pos.entry * pos.qty * fee;
    eq.push({ t: T, v: realized + unreal });
  }

  const tEnd = times[times.length - 1];
  for (const pos of [...open.values()]) finish(pos, pos.last, tEnd, 'end_of_test');
  return { trades, eq, btcSkipped };
}

// ───────────────────────────── METRIK ─────────────────────────────
function metrics(P, { trades, eq, btcSkipped = 0 }) {
  const done   = trades.filter(t => t.reason !== 'end_of_test');
  const wins   = done.filter(t => t.pnl > 0), losses = done.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let peak = 0, maxDD = 0;
  for (const p of eq) { peak = Math.max(peak, p.v); maxDD = Math.max(maxDD, peak - p.v); }

  const byReason = {}, bySymbol = {}, byMonth = {};
  for (const t of trades) {
    (byReason[t.reason] ??= { n: 0, pnl: 0, w: 0 });
    byReason[t.reason].n++; byReason[t.reason].pnl += t.pnl; if (t.pnl > 0) byReason[t.reason].w++;
    (bySymbol[t.symbol] ??= { n: 0, pnl: 0 }); bySymbol[t.symbol].n++; bySymbol[t.symbol].pnl += t.pnl;
    const m = new Date(t.exitT).toISOString().slice(0, 7);
    byMonth[m] = (byMonth[m] ?? 0) + t.pnl;
  }

  return {
    trades: trades.length, closedTrades: done.length, wins: wins.length,
    winRate: done.length ? wins.length / done.length * 100 : 0,
    totalPnl: total,
    returnPct: total / (P.budget * P.maxPos) * 100,
    profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0),
    avgWin:  wins.length ? gp / wins.length : 0,
    avgLoss: losses.length ? -gl / losses.length : 0,
    expectancy: done.length ? done.reduce((s, t) => s + t.pnl, 0) / done.length : 0,
    avgHoldH: trades.length ? trades.reduce((s, t) => s + t.holdH, 0) / trades.length : 0,
    maxDD, maxDDPct: maxDD / (P.budget * P.maxPos) * 100,
    byReason, bySymbol, byMonth, btcSkipped,
  };
}

// ───────────────────────────── LAPORAN ─────────────────────────────
const f2  = n => (n >= 0 ? '+' : '') + n.toFixed(2);
const pad = (s, n) => String(s).padEnd(n);

function printReport(label, P, SP, m, extra = {}) {
  console.log('\n' + '═'.repeat(68));
  console.log(`  ${label}`);
  console.log('═'.repeat(68));
  console.log(`  SATS   : preset ${SP.preset} | ATR ${SP.atrLen} | mult ${SP.baseMult} | SL ${SP.slMult}xATR | ER ${SP.erLen} | char-flip ${SP.charFlip ? 'on' : 'off'}`);
  console.log(`  Filter : ${describeFilters(P.F)}`);
  console.log(`  BTC    : ${P.btcMap ? `beli hanya saat BTC bullish (${P.F.btcRegime.mode})` : 'filter rezim BTC off'}`);
  console.log(`  Aturan : SL ${P.slMode === 'sats' ? 'SATS (pivot - k×ATR)' : 'tanpa SL'} | Trailing ${P.trailActivate > 0 ? `@${P.trailActivate}% cb ${P.trailPct}%` : 'off'} | SELL-exit ${P.exitOnSell ? 'on' : 'off'} | MaxHold ${P.maxHoldH > 0 ? P.maxHoldH + 'h' : 'off'}`);
  console.log(`  Modal  : ${P.budget} USDT/trade x maks ${P.maxPos} posisi (basis ${P.budget * P.maxPos} USDT) | fee ${P.feePct}%/sisi | slip ${P.slipPct}%`);
  console.log('─'.repeat(68));
  console.log(`  Trade           : ${m.trades} (${m.closedTrades} selesai)  | Win rate ${m.winRate.toFixed(1)}%${P.btcMap ? `  | sinyal BUY dilewati filter BTC: ${m.btcSkipped}` : ''}`);
  console.log(`  Total PnL       : ${f2(m.totalPnl)} USDT  (${f2(m.returnPct)}% dari basis modal)`);
  console.log(`  Profit factor   : ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}`);
  console.log(`  Avg win / loss  : ${f2(m.avgWin)} / ${f2(m.avgLoss)} USDT   | Expectancy ${f2(m.expectancy)}/trade`);
  console.log(`  Max drawdown    : -${m.maxDD.toFixed(2)} USDT (${m.maxDDPct.toFixed(1)}% dari basis modal)`);
  console.log(`  Rata2 hold      : ${m.avgHoldH.toFixed(1)} jam`);
  if (extra.buyHold != null) console.log(`  Pembanding      : buy&hold rata-rata koin ${f2(extra.buyHold)}% (periode sama)`);

  console.log('\n  Alasan exit:');
  for (const [r, v] of Object.entries(m.byReason).sort((a, b) => b[1].n - a[1].n))
    console.log(`    ${pad(r, 15)} ${String(v.n).padStart(4)}x  win ${String(Math.round(v.w / v.n * 100)).padStart(3)}%  PnL ${f2(v.pnl)}`);

  const syms = Object.entries(m.bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
  if (syms.length > 1) {
    console.log('\n  Koin terbaik : ' + syms.slice(0, 3).map(([s, v]) => `${s} ${f2(v.pnl)}`).join(' | '));
    console.log('  Koin terburuk: ' + syms.slice(-3).reverse().map(([s, v]) => `${s} ${f2(v.pnl)}`).join(' | '));
  }
  const months = Object.entries(m.byMonth).sort();
  if (months.length) console.log('\n  PnL per bulan: ' + months.map(([k, v]) => `${k} ${f2(v)}`).join(' | '));
}

function writeFiles(P, res, m) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const head = 'symbol,entry_time,exit_time,entry,exit,pnl_usdt,pnl_pct,reason,hold_hours';
    const rows = res.trades.sort((a, b) => a.exitT - b.exitT).map(t =>
      [t.symbol, new Date(t.entryT).toISOString(), new Date(t.exitT).toISOString(), t.entry, t.exit, t.pnl.toFixed(4), t.pnlPct.toFixed(3), t.reason, t.holdH.toFixed(1)].join(','));
    fs.writeFileSync(path.join(OUT_DIR, 'backtest-sats-trades.csv'), [head, ...rows].join('\n'));
    const { btcMap, rng, ...Pout } = P;
    fs.writeFileSync(path.join(OUT_DIR, 'backtest-sats-result.json'), JSON.stringify({ params: Pout, sats: BASE_SATS, metrics: m, equity: res.eq }, null, 2));
    console.log(`\n  📁 Detail: ${OUT_DIR}/backtest-sats-trades.csv , backtest-sats-result.json`);
  } catch (e) { console.log(`  (gagal tulis file: ${e.message})`); }
}

// ───────────────────────────── MAIN ─────────────────────────────
async function main() {
  console.log(`\n🧪 Backtest SATS 4H — mode auto | preset=${BASE_SATS.preset} | ${DAYS} hari`);

  const raw = new Map();
  if (argv.includes('--demo')) {
    console.log('⚠ MODE DEMO: data acak, hasil TIDAK mencerminkan pasar. Hanya untuk tes mesin.');
    for (const [s, c] of Object.entries(demoHistory(8, DAYS))) raw.set(s, c);
  } else {
    const symbols = await pickSymbols();
    console.log(`Mengambil data ${symbols.length} koin (cache: ${OUT_DIR}/cache)...`);
    let i = 0;
    for (const s of symbols) {
      i++;
      try {
        const c = await fetchHistory(s, DAYS);
        if (c.length >= WARMUP / 2 + 50) { raw.set(s, c); process.stdout.write(`\r  ${i}/${symbols.length} ${s}        `); }
      } catch (e) { console.log(`\n  ⚠ ${s} dilewati: ${e.message}`); }
    }
    console.log('');
  }
  if (!raw.size) { console.log('❌ Tidak ada data candle. Cek koneksi / daftar symbol.'); process.exit(1); }

  const tStart = Date.now() - DAYS * 86400000;
  const order  = [...raw.keys()];
  const bh = order.map(s => raw.get(s).filter(x => x.t >= tStart)).filter(a => a.length > 1)
                  .map(a => (a[a.length - 1].c / a[0].o - 1) * 100);
  const buyHold = bh.length ? bh.reduce((a, b) => a + b, 0) / bh.length : null;

  // ── data BTC untuk filter rezim ──
  let btcData = null;
  if (BASE_PARAMS.F.btcRegime?.enabled || argv.includes('--compare-btc')) {
    btcData = argv.includes('--demo') ? raw.get('DEMO1USDT') : await fetchHistory('BTCUSDT', DAYS).catch(() => null);
    if (!btcData || btcData.length < WARMUP) { console.log('❌ Data BTCUSDT tidak tersedia untuk filter rezim.'); process.exit(1); }
  }

  if (argv.includes('--compare-btc')) {
    // Semua skenario: tanpa trailing, tanpa filter lain → satu-satunya beda adalah filter BTC.
    const NOF = { F: {}, trailActivate: 0 };
    const regs = {
      sats:   btcRegimeMap(btcData, { mode: 'sats' }),
      ema126: btcRegimeMap(btcData, { mode: 'ema', period: 126 }),
      ema50:  btcRegimeMap(btcData, { mode: 'ema', period: 50 }),
    };
    const bullPct = m => { let n = 0, t = 0; for (const [ts, v] of m) if (ts >= tStart) { t++; if (v) n++; } return t ? n / t * 100 : 0; };
    console.log(`\n  Porsi waktu BTC "bullish" di periode uji → SATS 4H: ${bullPct(regs.sats).toFixed(0)}% | > EMA126: ${bullPct(regs.ema126).toFixed(0)}% | > EMA50: ${bullPct(regs.ema50).toFixed(0)}%`);
    const sc = [
      { name: 'L. Baseline (tanpa filter BTC)',            map: null },
      { name: 'M. BTC: tren SATS 4H bullish',              map: regs.sats },
      { name: 'N. BTC: close > EMA126 4H (≈EMA21 1D)',     map: regs.ema126 },
      { name: 'O. BTC: close > EMA50 4H',                  map: regs.ema50 },
    ];
    const { S } = buildSeries(raw, BASE_SATS);
    console.log('\n' + '═'.repeat(112));
    console.log(`  ${pad('Skenario', 44)}${pad('Trade', 7)}${pad('Win%', 7)}${pad('PnL USDT', 11)}${pad('PF', 7)}${pad('MaxDD', 10)}${pad('Hold(j)', 9)}Dilewati`);
    console.log('═'.repeat(112));
    const monthly = [];
    for (const x of sc) {
      const P = { ...BASE_PARAMS, ...NOF, F: x.map ? { btcRegime: { enabled: true, mode: 'ema' } } : {}, btcMap: x.map };
      const m = metrics(P, simulate(P, S, order, tStart));
      console.log(`  ${pad(x.name, 44)}${pad(m.trades, 7)}${pad(m.winRate.toFixed(0) + '%', 7)}${pad(f2(m.totalPnl), 11)}${pad(Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', 7)}${pad('-' + m.maxDD.toFixed(1), 10)}${pad(m.avgHoldH.toFixed(0), 9)}${x.map ? m.btcSkipped : '-'}`);
      monthly.push([x.name.slice(0, 1), m.byMonth]);
    }
    // ── Kontrol: buang sinyal secara ACAK dalam jumlah yang sama dengan filter M ──
    // Menjawab: apakah filter BTC punya informasi, atau hanya mengurangi jumlah trade?
    {
      const PM = { ...BASE_PARAMS, ...NOF, F: { btcRegime: { enabled: true, mode: 'sats' } }, btcMap: regs.sats };
      const mM = metrics(PM, simulate(PM, S, order, tStart));
      const frac = mM.btcSkipped / Math.max(1, mM.btcSkipped + mM.trades);
      const R = [];
      for (let k = 0; k < 20; k++) {
        const P = { ...BASE_PARAMS, ...NOF, randSkip: frac, rng: mulberry(1000 + k) };
        R.push(metrics(P, simulate(P, S, order, tStart)));
      }
      const avg = f => R.reduce((a, m) => a + f(m), 0) / R.length;
      const pf = avg(m => Number.isFinite(m.profitFactor) ? m.profitFactor : 0);
      const pnls = R.map(m => m.totalPnl).sort((a, b) => a - b);
      console.log(`  ${pad(`R. Kontrol: lewati ${(frac * 100).toFixed(0)}% acak (rata2 20x)`, 44)}${pad(avg(m => m.trades).toFixed(0), 7)}${pad(avg(m => m.winRate).toFixed(0) + '%', 7)}${pad(f2(avg(m => m.totalPnl)), 11)}${pad(pf.toFixed(2), 7)}${pad('-' + avg(m => m.maxDD).toFixed(1), 10)}${pad(avg(m => m.avgHoldH).toFixed(0), 9)}-`);
      console.log(`      rentang PnL 20 pengacakan: ${f2(pnls[0])} s/d ${f2(pnls[pnls.length - 1])} (median ${f2(pnls[Math.floor(pnls.length / 2)])})`);
    }

    console.log('\n  PnL per bulan (USDT):');
    for (const [k, bm] of monthly) console.log(`    ${k}: ` + Object.entries(bm).sort().map(([mo, v]) => `${mo} ${f2(v)}`).join(' | '));
    console.log('\n  Dilewati = sinyal BUY valid yang dibuang karena BTC tidak bullish. Filter hanya memengaruhi BUY; exit tidak berubah.');
    console.log('  Cara baca: filter BTC baru berguna bila PnL & MaxDD-nya LEBIH BAIK dari rentang kontrol acak (baris R), bukan sekadar lebih sedikit trade.');
  } else if (argv.includes('--compare')) {
    // Semua skenario mulai dari TANPA filter (baseline), lalu ditambah satu variabel per baris.
    const NOF = { F: {} };
    const scenarios = [
      { name: 'A. Default (ATR14 x2.0, SL 1.5xATR)',        s: { preset: 'default' }, o: { ...NOF } },
      { name: 'B. Crypto 24/7 (ATR14 x2.8, SL 2.5xATR)',    s: { preset: 'crypto'  }, o: { ...NOF } },
      { name: 'C. Swing (ATR21 x2.5, SL 2.0xATR, ER30)',    s: { preset: 'swing'   }, o: { ...NOF } },
      { name: 'D. Default + TQI >= 0.5',                    s: { preset: 'default' }, o: { F: { minTqi: 0.5 } } },
      { name: 'E. Default + close > EMA50 4H',              s: { preset: 'default' }, o: { F: { ema: { enabled: true, period: 50 } } } },
      { name: 'F. Default + risiko SL <= 8%',               s: { preset: 'default' }, o: { F: { maxRisk: { enabled: true, maxPct: 8 } } } },
      { name: 'G. Default + char-flip aktif',               s: { preset: 'default', advanced: { charFlip: true } }, o: { ...NOF } },
      { name: 'H. Default tanpa trailing',                  s: { preset: 'default' }, o: { ...NOF, trailActivate: 0 } },
      { name: 'I. Default murni SATS (tanpa SL/trail/hold)', s: { preset: 'default' }, o: { ...NOF, slMode: 'none', trailActivate: 0, maxHoldH: 0 } },
      { name: 'J. Crypto + TQI >= 0.5',                     s: { preset: 'crypto'  }, o: { F: { minTqi: 0.5 } } },
      { name: 'K. Crypto + close > EMA50 4H',               s: { preset: 'crypto'  }, o: { F: { ema: { enabled: true, period: 50 } } } },
      // ── filter baru (tahap 1) ──
      { name: 'L. Default + volume >= 1.3x',                s: { preset: 'default' }, o: { F: { volume: { enabled: true, minRatio: 1.3 } } } },
      { name: 'M. Default + RSI <= 75',                     s: { preset: 'default' }, o: { F: { rsi: { enabled: true, max: 75 } } } },
      { name: 'N. Default + extension <= 3.5 ATR',          s: { preset: 'default' }, o: { F: { extension: { enabled: true, maxAtr: 3.5 } } } },
      { name: 'O. Default + ADX >= 20',                     s: { preset: 'default' }, o: { F: { adx: { enabled: true, min: 20 } } } },
    ];
    const cache = new Map();
    console.log('\n' + '═'.repeat(108));
    console.log(`  ${pad('Skenario', 52)}${pad('Trade', 7)}${pad('Win%', 7)}${pad('PnL USDT', 11)}${pad('PF', 7)}${pad('MaxDD', 10)}Hold(j)`);
    console.log('═'.repeat(108));
    for (const sc of scenarios) {
      const key = JSON.stringify(sc.s);
      if (!cache.has(key)) cache.set(key, buildSeries(raw, { ...BASE_SATS, preset: sc.s.preset, advanced: { ...(sc.s.advanced ?? {}) } }));
      const { S } = cache.get(key);
      const P = { ...BASE_PARAMS, ...sc.o };
      const m = metrics(P, simulate(P, S, order, tStart));
      console.log(`  ${pad(sc.name, 52)}${pad(m.trades, 7)}${pad(m.winRate.toFixed(0) + '%', 7)}${pad(f2(m.totalPnl), 11)}${pad(Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', 7)}${pad('-' + m.maxDD.toFixed(1), 10)}${m.avgHoldH.toFixed(0)}`);
    }
    if (buyHold != null) console.log(`\n  Pembanding buy&hold rata-rata koin: ${f2(buyHold)}%`);
    console.log('  Catatan: aturan exit mengikuti user-config.json. Detail satu skenario: jalankan tanpa --compare (mis. --preset crypto --min-tqi 0.5).');
  } else {
    const { S, P: SP } = buildSeries(raw, BASE_SATS);
    const P = { ...BASE_PARAMS };
    if (P.F.btcRegime?.enabled) P.btcMap = btcRegimeMap(btcData, P.F.btcRegime);
    const res = simulate(P, S, order, tStart);
    const m = metrics(P, res);
    printReport('HASIL BACKTEST SATS', P, SP, m, { buyHold });
    writeFiles(P, res, m);
  }

  console.log(`
  ⚠ Batasan: (1) koin dipilih dari volume HARI INI → bias survivorship/look-ahead; (2) entry di open candle
    berikutnya, SL diasumsikan terkena di level (urutan konservatif: SL dulu), fill nyata bisa lebih buruk;
    (3) filter AI TIDAK ikut (tidak ada data historis tanpa look-ahead); (4) hasil masa lalu bukan jaminan.\n`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
