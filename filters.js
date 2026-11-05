/**
 * Filters — filter entry BUY (fungsi murni, dipakai screenerSATS.js DAN backtestSATS.js)
 *
 * Satu sumber logika → hasil backtest = perilaku bot live.
 * Semua filter punya saklar `enabled`. Filter yang tidak ada di config dianggap OFF.
 *
 * Config (user-config.json → screening.sats.filters):
 *   minTqi    : 0.5                              (0 = off)
 *   ema       : { enabled, period }              close > EMA(period) 4H
 *   maxRisk   : { enabled, maxPct }              jarak close→SL <= maxPct%
 *   volume    : { enabled, minRatio, period }    vol candle sinyal / SMA(vol, period) >= minRatio
 *   rsi       : { enabled, max, period }         RSI 4H <= max (hindari beli di area panas)
 *   extension : { enabled, emaPeriod, maxAtr }   (close - EMA) / ATR <= maxAtr (hindari mengejar harga)
 *   adx       : { enabled, min, period }         ADX 4H >= min (hindari pasar sideways)
 *   btcRegime : { enabled, mode, period }        mode 'ema' = BTC close > EMA(period) | 'sats' = tren SATS BTC bullish
 */

import { calcEMASeries, calcADXSeries } from './indicators.js';
import { calcSATS, resolveSATSParams }  from './sats.js';

// ───────────────────────── seri indikator ─────────────────────────

/** RSI Wilder per candle (algoritma sama dengan calcRSI di indicators.js) */
export function calcRSISeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** Rasio volume candle i terhadap rata-rata `period` candle SEBELUMNYA (candle i tidak ikut) */
export function calcVolRatioSeries(vols, period = 20) {
  const out = new Array(vols.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vols.length; i++) {
    if (i >= period) {
      const avg = sum / period;
      out[i] = avg > 0 ? vols[i] / avg : null;
      sum -= vols[i - period];
    }
    sum += vols[i];
  }
  return out;
}

// ───────────────────────── konteks (cache per koin) ─────────────────────────

/**
 * @param {object} d  { highs, lows, closes, volumes, atr }   atr = array ATR per candle (res.rawAtr dari calcSATS)
 */
export function makeCtx(d) {
  return { ...d, cache: new Map() };
}

function memo(ctx, key, fn) {
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key);
}

// ───────────────────────── pengecekan utama ─────────────────────────

const num = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * Return string alasan penolakan, atau null bila lolos.
 * @param ctx     hasil makeCtx()
 * @param i       index candle sinyal
 * @param sig     { tqi, riskPct }
 * @param F       config filters
 * @param regime  { bullish: boolean|null } status BTC pada candle sinyal (null = tidak tersedia)
 */
export function checkEntryFilters(ctx, i, sig, F = {}, regime = null) {
  const close = ctx.closes[i];

  if (F.minTqi > 0 && sig.tqi < F.minTqi)
    return `TQI ${sig.tqi.toFixed(2)} < ${F.minTqi}`;

  if (F.maxRisk?.enabled && sig.riskPct > num(F.maxRisk.maxPct, 10))
    return `risiko ${sig.riskPct.toFixed(1)}% > ${num(F.maxRisk.maxPct, 10)}%`;

  if (F.ema?.enabled) {
    const p = num(F.ema.period, 50);
    const e = memo(ctx, `ema${p}`, () => calcEMASeries(ctx.closes, p))[i];
    if (e == null)  return `data kurang untuk EMA${p}`;
    if (close <= e) return `close ${close} <= EMA${p} ${e.toFixed(6)}`;
  }

  if (F.volume?.enabled) {
    const p = num(F.volume.period, 20), min = num(F.volume.minRatio, 1.3);
    const r = memo(ctx, `vol${p}`, () => calcVolRatioSeries(ctx.volumes, p))[i];
    if (r == null) return `data kurang untuk volume SMA${p}`;
    if (r < min)   return `volume ${r.toFixed(2)}x < ${min}x`;
  }

  if (F.rsi?.enabled) {
    const p = num(F.rsi.period, 14), max = num(F.rsi.max, 75);
    const r = memo(ctx, `rsi${p}`, () => calcRSISeries(ctx.closes, p))[i];
    if (r == null) return `data kurang untuk RSI${p}`;
    if (r > max)   return `RSI ${r.toFixed(0)} > ${max}`;
  }

  if (F.extension?.enabled) {
    const p = num(F.extension.emaPeriod, 21), max = num(F.extension.maxAtr, 3.5);
    const e = memo(ctx, `ema${p}`, () => calcEMASeries(ctx.closes, p))[i];
    const a = ctx.atr?.[i];
    if (e == null || !(a > 0)) return `data kurang untuk extension`;
    const ext = (close - e) / a;
    if (ext > max) return `extension ${ext.toFixed(1)} ATR dari EMA${p} > ${max}`;
  }

  if (F.adx?.enabled) {
    const p = num(F.adx.period, 14), min = num(F.adx.min, 20);
    const s = memo(ctx, `adx${p}`, () => calcADXSeries(ctx.highs, ctx.lows, ctx.closes, p));
    const a = s.adx[i];
    if (a == null) return `data kurang untuk ADX${p}`;
    if (a < min)   return `ADX ${a.toFixed(0)} < ${min}`;
  }

  if (F.btcRegime?.enabled) {
    if (regime == null || regime.bullish == null) return 'BTC: data rezim tidak tersedia (fail-closed)';
    if (!regime.bullish) return `BTC tidak bullish (${F.btcRegime.mode ?? 'ema'}${F.btcRegime.mode === 'sats' ? '' : ' ' + num(F.btcRegime.period, 126)})`;
  }

  return null;
}

// ───────────────────────── rezim BTC ─────────────────────────

/**
 * Peta waktu-open-candle → true bila BTC bullish pada candle yang SUDAH TUTUP itu.
 * @param btc  array { t, h, l, c, v }
 * @param cfg  { mode: 'ema'|'sats', period }
 */
export function btcRegimeMap(btc, cfg = {}) {
  const m = new Map();
  if ((cfg.mode ?? 'ema') === 'sats') {
    const P   = resolveSATSParams({ preset: 'default' });      // tetap, tidak ikut preset koin
    const res = calcSATS(btc.map(x => x.h), btc.map(x => x.l), btc.map(x => x.c), btc.map(x => x.v), P);
    btc.forEach((x, i) => m.set(x.t, i >= P.warmup && res.trend[i] === 1));
  } else {
    const e = calcEMASeries(btc.map(x => x.c), num(cfg.period, 126));
    btc.forEach((x, i) => m.set(x.t, e[i] != null && x.c > e[i]));
  }
  return m;
}

// Cache live: dihitung ulang hanya saat ada candle 4H baru
let _btcCache = null;

/**
 * Rezim BTC untuk screener live.
 * @param getCandles  fungsi (symbol, granularity, limit) → raw candle Bitget (inject dari bitget.js)
 * @returns {{bullish: boolean|null, ts: number|null}}
 */
export async function liveBtcRegime(getCandles, cfg = {}, periodMs = 4 * 3600 * 1000) {
  const periodStart = Date.now() - (Date.now() % periodMs);
  if (_btcCache && _btcCache.periodStart === periodStart && _btcCache.key === JSON.stringify(cfg)) return _btcCache.value;

  let value = { bullish: null, ts: null };
  try {
    const raw = await getCandles('BTCUSDT', '4h', 400);
    const btc = (Array.isArray(raw) ? raw : [])
      .filter(r => parseInt(r[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(r => ({ t: parseInt(r[0]), h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    if (btc.length >= 220) {
      const m = btcRegimeMap(btc, cfg);
      const last = btc[btc.length - 1].t;
      value = { bullish: m.get(last) ?? null, ts: last };
    }
  } catch { /* fail-closed: bullish tetap null */ }

  _btcCache = { periodStart, key: JSON.stringify(cfg), value };
  return value;
}

/** Ringkasan filter aktif untuk log */
export function describeFilters(F = {}) {
  return [
    F.minTqi > 0                ? `TQI>=${F.minTqi}` : null,
    F.ema?.enabled              ? `close>EMA${F.ema.period ?? 50}` : null,
    F.maxRisk?.enabled          ? `risiko<=${F.maxRisk.maxPct ?? 10}%` : null,
    F.volume?.enabled           ? `vol>=${F.volume.minRatio ?? 1.3}x` : null,
    F.rsi?.enabled              ? `RSI<=${F.rsi.max ?? 75}` : null,
    F.extension?.enabled        ? `ext<=${F.extension.maxAtr ?? 3.5}ATR` : null,
    F.adx?.enabled              ? `ADX>=${F.adx.min ?? 20}` : null,
    F.btcRegime?.enabled        ? `BTC(${F.btcRegime.mode ?? 'ema'}${(F.btcRegime.mode ?? 'ema') === 'ema' ? F.btcRegime.period ?? 126 : ''})` : null,
  ].filter(Boolean).join(' + ') || 'tanpa filter';
}
