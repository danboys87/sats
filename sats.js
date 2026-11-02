/**
 * Self-Aware Trend System (SATS) — port dari Pine Script v1.9.0 (WillyAlgoTrader)
 *
 * Fungsi murni (tanpa import) → dipakai screenerSATS.js dan backtestSATS.js.
 * Menghitung SELURUH seri per candle karena SATS stateful
 * (smoothing multiplier, ratchet band, arah tren, umur tren).
 *
 * Yang di-port (sama dengan Pine, source = close):
 *   ATR Wilder → Efficiency Ratio → TQI 4 faktor → pengali adaptif + asimetris + smoothing
 *   → band ratchet → flip tren (price flip) → SL berbasis pivot + k×ATR → TP kelipatan R
 * Tidak di-port (hanya tampilan di Pine): skor sinyal, dashboard, statistik R, MTF, auto-kalibrasi.
 *
 * Catatan char-flip: di Pine syaratnya `close < source`, padahal source = close → selalu false
 * (dead code). Default di sini OFF supaya hasil = TradingView. Bila charFlip:true dipakai versi
 * yang berfungsi: flip bila TQI runtuh DAN harga sudah di sisi berlawanan dari tengah range.
 */

export const SATS_PRESETS = {
  scalping: { atrLen: 10, baseMult: 1.5, erLen: 14, slMult: 1.0 },
  default:  { atrLen: 14, baseMult: 2.0, erLen: 20, slMult: 1.5 },   // = preset "Auto" Pine untuk TF 4H
  swing:    { atrLen: 21, baseMult: 2.5, erLen: 30, slMult: 2.0 },
  crypto:   { atrLen: 14, baseMult: 2.8, erLen: 20, slMult: 2.5 },   // "Crypto 24/7"
};

const DEFAULTS = {
  atrBaselineLen: 100,
  useAdaptive: true,  adaptStrength: 0.5,
  useTqi: true,       qualityStrength: 0.4, qualityCurve: 1.5, multSmooth: true,
  useAsym: true,      asymStrength: 0.5,
  useEffAtr: true,
  structLen: 20, momLen: 10, volLen: 20, pivotLen: 3,
  wEr: 0.35, wVol: 0.20, wStruct: 0.25, wMom: 0.20,
  charFlip: false, charFlipMinAge: 5, charFlipHigh: 0.55, charFlipLow: 0.25,
  warmup: 60,
};

const MULT_SMOOTH_ALPHA = 0.15;

const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const safeDiv = (a, b, fb = 0) => (b !== 0 && Number.isFinite(a) && Number.isFinite(b)) ? a / b : fb;
const mapClamp = (v, inLo, inHi, outLo, outHi) => {
  const t = clamp(safeDiv(v - inLo, inHi - inLo, 0), 0, 1);
  return outLo + t * (outHi - outLo);
};

/**
 * cfg = config.screening.sats
 *   preset   : 'default' | 'crypto' | 'swing' | 'scalping' | 'custom'
 *   custom   : { atrLen, baseMult, erLen, slMult }   (dipakai bila preset = 'custom')
 *   advanced : override parameter lain (qualityStrength, charFlip, dst.)
 */
export function resolveSATSParams(cfg = {}) {
  const preset = String(cfg.preset ?? 'default').toLowerCase();
  const base   = SATS_PRESETS[preset] ?? SATS_PRESETS.default;
  return {
    ...DEFAULTS,
    ...base,
    ...(preset === 'custom' ? (cfg.custom ?? {}) : {}),
    ...(cfg.advanced ?? {}),
    preset,
  };
}

/** Jumlah candle minimum agar baseline ATR & state band sudah matang */
export function satsMinCandles(P) {
  return P.atrLen + P.atrBaselineLen + 20;
}

export function calcSATS(highs, lows, closes, volumes, P) {
  const n = closes.length;
  const out = {
    n, params: P, highs, lows, closes,
    trend:     new Array(n).fill(1),
    stLine:    new Array(n).fill(null),
    lowerBand: new Array(n).fill(null),
    upperBand: new Array(n).fill(null),
    tqi:       new Array(n).fill(0.5),
    er:        new Array(n).fill(0),
    atr:       new Array(n).fill(0),      // ATR efektif (efficiency-weighted) = atrValue di Pine
    rawAtr:    new Array(n).fill(0),
    volRatio:  new Array(n).fill(1),
    flipUp:    new Array(n).fill(false),
    flipDown:  new Array(n).fill(false),
    lastPivotLow:  new Array(n).fill(null),
    lastPivotHigh: new Array(n).fill(null),
  };
  if (n < 2) return out;

  // ── ATR Wilder (RMA, seed SMA) — sama dengan ta.atr Pine ───────────────────
  const rawAtr = new Array(n).fill(null);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const tr = i === 0
      ? highs[0] - lows[0]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    if (i < P.atrLen - 1)        { acc += tr; }
    else if (i === P.atrLen - 1) { acc += tr; rawAtr[i] = acc / P.atrLen; }
    else                         { rawAtr[i] = (rawAtr[i - 1] * (P.atrLen - 1) + tr) / P.atrLen; }
  }

  const wSum = P.wEr + P.wVol + P.wStruct + P.wMom;
  const wDen = wSum > 0 ? wSum : 1;
  const firstAtr = P.atrLen - 1;

  let lowerBand = null, upperBand = null;
  let trend = 1, trendStart = 0;
  let actSm = null, pasSm = null;
  let lastPL = null, lastPH = null;

  for (let i = 0; i < n; i++) {
    const rA = rawAtr[i] ?? 0;

    // baseline ATR (SMA 100 dari ATR) → rasio volatilitas
    let baseline = rA;
    if (i >= firstAtr + P.atrBaselineLen - 1) {
      let s = 0;
      for (let k = i - P.atrBaselineLen + 1; k <= i; k++) s += rawAtr[k];
      baseline = s / P.atrBaselineLen;
    }
    const volRatio = safeDiv(rA, baseline, 1);

    // Efficiency Ratio
    let er = 0;
    if (i >= P.erLen) {
      let v = 0;
      for (let k = i - P.erLen + 1; k <= i; k++) v += Math.abs(closes[k] - closes[k - 1]);
      er = safeDiv(Math.abs(closes[i] - closes[i - P.erLen]), v, 0);
    }
    const atrValue = P.useEffAtr ? rA * (0.5 + 0.5 * er) : rA;

    // ── TQI ────────────────────────────────────────────────────────────────
    const tqiEr = clamp(er, 0, 1);

    const hasVol = Number.isFinite(volumes?.[i]) && volumes[i] > 0;
    let volZ = 0;
    if (hasVol && i >= P.volLen - 1) {
      let m = 0;
      for (let k = i - P.volLen + 1; k <= i; k++) m += volumes[k];
      m /= P.volLen;
      let sq = 0;
      for (let k = i - P.volLen + 1; k <= i; k++) sq += (volumes[k] - m) ** 2;
      volZ = safeDiv(volumes[i] - m, Math.sqrt(sq / P.volLen), 0);
    }
    const tqiVol = hasVol ? mapClamp(volZ, -1, 2, 0, 1) : mapClamp(volRatio, 0.6, 1.8, 0, 1);

    let pricePos = 0.5, tqiStruct = 0;
    if (i >= P.structLen - 1) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - P.structLen + 1; k <= i; k++) { if (highs[k] > hi) hi = highs[k]; if (lows[k] < lo) lo = lows[k]; }
      pricePos  = safeDiv(closes[i] - lo, hi - lo, 0.5);
      tqiStruct = clamp(Math.abs(pricePos - 0.5) * 2, 0, 1);
    }

    let tqiMom = 0;
    if (i >= P.momLen) {
      const wc = closes[i] - closes[i - P.momLen];
      let aligned = 0;
      for (let k = 0; k < P.momLen; k++) {
        const bc = closes[i - k] - closes[i - k - 1];
        if ((wc > 0 && bc > 0) || (wc < 0 && bc < 0)) aligned++;
      }
      tqiMom = aligned / P.momLen;
    }

    const tqiRaw = P.useTqi
      ? (tqiEr * P.wEr + tqiVol * P.wVol + tqiStruct * P.wStruct + tqiMom * P.wMom) / wDen
      : 0.5;
    const tqi = clamp(tqiRaw, 0, 1);

    // ── Pengali adaptif ────────────────────────────────────────────────────
    const legacy   = P.useAdaptive ? (1 + P.adaptStrength * (0.5 - er)) : 1;
    const qDev     = P.useTqi ? Math.pow(1 - tqi, P.qualityCurve) : 0.5;
    const tqiMult  = 1 - P.qualityStrength + P.qualityStrength * (0.6 + 0.8 * qDev);
    const symMult  = P.baseMult * legacy * tqiMult;

    let actRaw = symMult, pasRaw = symMult;
    if (P.useTqi && P.useAsym) {
      actRaw = symMult * (1 - P.asymStrength * tqi * 0.3);
      pasRaw = symMult * (1 + P.asymStrength * tqi * 0.4);
    }
    actSm = actSm === null ? actRaw : (P.multSmooth ? actSm * (1 - MULT_SMOOTH_ALPHA) + actRaw * MULT_SMOOTH_ALPHA : actRaw);
    pasSm = pasSm === null ? pasRaw : (P.multSmooth ? pasSm * (1 - MULT_SMOOTH_ALPHA) + pasRaw * MULT_SMOOTH_ALPHA : pasRaw);

    // ── Band ratchet ───────────────────────────────────────────────────────
    const prevTrend = trend;
    const lowerMult = prevTrend === 1 ? actSm : pasSm;
    const upperMult = prevTrend === 1 ? pasSm : actSm;
    const src = closes[i];
    const lowerRaw = src - lowerMult * atrValue;
    const upperRaw = src + upperMult * atrValue;

    const prevLower = lowerBand, prevUpper = upperBand;
    lowerBand = prevLower === null ? lowerRaw : (closes[i - 1] > prevLower ? Math.max(lowerRaw, prevLower) : lowerRaw);
    upperBand = prevUpper === null ? upperRaw : (closes[i - 1] < prevUpper ? Math.min(upperRaw, prevUpper) : upperRaw);

    // ── Flip tren ──────────────────────────────────────────────────────────
    const priceFlipUp   = prevTrend === -1 && prevUpper !== null && closes[i] > prevUpper;
    const priceFlipDown = prevTrend ===  1 && prevLower !== null && closes[i] < prevLower;

    let cfUp = false, cfDown = false;
    if (P.charFlip && P.useTqi && i > 0) {
      const prevTqi = out.tqi[i - 1];
      const age     = i - trendStart;
      if (prevTqi > P.charFlipHigh && tqi < P.charFlipLow && age >= P.charFlipMinAge) {
        if (prevTrend ===  1 && pricePos < 0.5) cfDown = true;
        if (prevTrend === -1 && pricePos > 0.5) cfUp   = true;
      }
    }

    if (i > 0) {
      if (priceFlipUp || cfUp)         trend =  1;
      else if (priceFlipDown || cfDown) trend = -1;
    }
    if (trend !== prevTrend) trendStart = i;

    // ── Pivot (dikonfirmasi pivotLen bar setelahnya) ────────────────────────
    const pl = P.pivotLen;
    if (i >= 2 * pl) {
      const c = i - pl;
      let isLow = true, isHigh = true;
      for (let k = i - 2 * pl; k <= i; k++) {
        if (k === c) continue;
        if (lows[k]  < lows[c])  isLow  = false;
        if (highs[k] > highs[c]) isHigh = false;
      }
      if (isLow)  lastPL = lows[c];
      if (isHigh) lastPH = highs[c];
    }

    out.trend[i]     = trend;
    out.lowerBand[i] = lowerBand;
    out.upperBand[i] = upperBand;
    out.stLine[i]    = trend === 1 ? lowerBand : upperBand;
    out.tqi[i]       = tqi;
    out.er[i]        = er;
    out.atr[i]       = atrValue;
    out.rawAtr[i]    = rA;
    out.volRatio[i]  = volRatio;
    out.flipUp[i]    = i > 0 && trend ===  1 && prevTrend === -1;
    out.flipDown[i]  = i > 0 && trend === -1 && prevTrend ===  1;
    out.lastPivotLow[i]  = lastPL;
    out.lastPivotHigh[i] = lastPH;
  }
  return out;
}

/**
 * Level trade untuk sinyal BUY di candle i (sama dengan blok confirmedBuy di Pine).
 *   SL = min(pivotLow - k×ATR, entry - k×ATR)   (k = slMult, ATR = ATR efektif)
 *   TP = entry + risk × R   (R default 1/2/3)
 */
export function satsBuyLevels(res, i, tpR = [1, 2, 3]) {
  const P     = res.params;
  const entry = res.closes[i];
  const atr   = res.atr[i];
  const base  = res.lastPivotLow[i] ?? res.lows[i];
  const sl    = Math.min(base - P.slMult * atr, entry - P.slMult * atr);
  const risk  = entry - sl;
  return {
    entry, sl, risk,
    riskPct: entry > 0 ? (risk / entry) * 100 : 0,
    tp: tpR.map(r => entry + risk * r),
  };
}
