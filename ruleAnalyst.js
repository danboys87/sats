/**
 * Rule Analyst — analisa on-demand TANPA AI (fallback untuk aiAnalyst.js)
 *
 * Dipakai bila API key AI belum diisi, atau panggilan AI gagal (mis. kuota habis).
 * Format keluaran SAMA dengan analisa AI, jadi dashboard & Telegram menampilkannya apa adanya.
 *
 * Data  : candle 1D / 4H / 1H dari Bitget (tanpa AI, tanpa web)
 * Dasar : band & TQI SATS 4H (preset dari config.screening.sats), EMA9/21 per timeframe,
 *         RSI 4H, rasio volume 4H, resistance/support terdekat, R:R dari SL SATS
 *
 * Verdict:
 *   SKIP    : ada syarat gugur (tren SATS 4H bearish, tren 1D bearish, RSI > 80, harga di bawah SL, R:R < 1)
 *   BUY_NOW : tidak ada syarat gugur / peringatan DAN skor gabungan >= 60
 *   WAIT    : selain itu (ada peringatan, mis. RSI panas, volume lemah, tren sudah lama berjalan)
 *
 * TIDAK mencakup: berita, sentimen, token unlock, jadwal makro (butuh web/AI) → ditandai di laporan.
 */

import { getCandles, getCurrentPrice } from './bitget.js';
import { calcEMA, calcRSI }            from './indicators.js';
import { calcSATS, resolveSATSParams, satsMinCandles } from './sats.js';
import { config } from './config.js';
import { log }    from './logger.js';

const PERIOD_MS  = { '1day': 86400000, '4h': 14400000, '1h': 3600000 };
const FRESH_BARS = 6;          // flip SATS ≤ 6 candle 4H (≈ 24 jam) dianggap masih segar
const MIN_SCORE  = 60;         // skor minimum untuk BUY_NOW

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  return n.toFixed(a >= 100 ? 2 : a >= 1 ? 4 : 6);
}

async function loadTF(symbol, gran, limit) {
  const raw = await getCandles(symbol, gran, limit);
  if (!Array.isArray(raw)) return null;
  const now = Date.now();
  const periodStart = now - (now % PERIOD_MS[gran]);
  const rows = raw
    .filter(r => parseInt(r[0]) < periodStart)                 // hanya candle yang sudah closed
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  return {
    h: rows.map(r => parseFloat(r[2])),
    l: rows.map(r => parseFloat(r[3])),
    c: rows.map(r => parseFloat(r[4])),
    v: rows.map(r => parseFloat(r[5])),
  };
}

function emaTrend(tf, price) {
  const e9  = calcEMA(tf.c, 9);
  const e21 = calcEMA(tf.c, 21);
  if (e9 == null || e21 == null) return { label: 'NEUTRAL', e9, e21 };
  const label = price > e21 && e9 > e21 ? 'BULLISH' : (price < e21 && e9 < e21 ? 'BEARISH' : 'NEUTRAL');
  return { label, e9, e21 };
}

export async function ruleBasedAnalysis(symbolIn) {
  const symbol = String(symbolIn).toUpperCase();
  log('ai_analyst', `📐 Analisa berbasis aturan (tanpa AI): ${symbol}`);

  const sCfg = config.screening?.sats ?? {};
  const P    = resolveSATSParams(sCfg);
  const tpR  = sCfg.tpR ?? [1, 2, 3];

  const [d1, h4, h1, live] = await Promise.all([
    loadTF(symbol, '1day', 62),
    loadTF(symbol, '4h',   Math.max(300, satsMinCandles(P) + 20)),
    loadTF(symbol, '1h',   100),
    getCurrentPrice(symbol).catch(() => null),
  ]);

  if (!d1 || !h4 || !h1 || d1.c.length < 22 || h1.c.length < 22 || h4.c.length < satsMinCandles(P)) {
    log('ai_analyst_error', `  ❌ Data candle ${symbol} tidak cukup untuk analisa aturan`);
    return null;
  }

  const last  = h4.c.length - 1;
  const price = live ?? h4.c[last];

  // ── SATS 4H ────────────────────────────────────────────────────────────────
  const res   = calcSATS(h4.h, h4.l, h4.c, h4.v, P);
  const trend = res.trend[last];
  const tqi   = res.tqi[last];
  const er    = res.er[last];
  const band  = res.stLine[last];
  let age = 0;
  for (let i = last; i >= 0 && res.trend[i] === trend; i--) age++;     // umur tren (candle 4H)

  // SL versi SATS (pivot low - k×ATR), dihitung dari harga sekarang
  const base = res.lastPivotLow[last] ?? h4.l[last];
  const sl   = Math.min(base - P.slMult * res.atr[last], price - P.slMult * res.atr[last]);
  const risk = price - sl;
  const riskPct = price > 0 ? (risk / price) * 100 : 0;

  // ── Tren per timeframe ─────────────────────────────────────────────────────
  const tD = emaTrend(d1, price);
  const tH = emaTrend(h1, price);
  const h4Label = trend === 1 ? (tqi < 0.25 ? 'NEUTRAL' : 'BULLISH') : 'BEARISH';
  const aligned = tD.label === 'BULLISH' && h4Label === 'BULLISH' && tH.label === 'BULLISH';

  // ── Momentum ───────────────────────────────────────────────────────────────
  const rsi = calcRSI(h4.c, 14) ?? 50;
  const avgVol10 = h4.v.slice(last - 10, last).reduce((s, v) => s + v, 0) / 10;
  const volRatio = avgVol10 > 0 ? h4.v[last] / avgVol10 : 0;
  const chg24    = last >= 6 && h4.c[last - 6] > 0 ? (h4.c[last] / h4.c[last - 6] - 1) * 100 : 0;
  const high20_4h = Math.max(...h4.h.slice(-20));
  const high20_1d = Math.max(...d1.h.slice(-20));

  // ── Level kunci ────────────────────────────────────────────────────────────
  const resCands = [high20_4h, high20_1d].filter(x => x > price * 1.003);
  const breakout = resCands.length === 0;
  const resistance1 = breakout ? price + 2 * risk : Math.min(...resCands);
  const rr = risk > 0 ? (resistance1 - price) / risk : 0;

  const e21_4h = calcEMA(h4.c, 21);
  const supCands = [e21_4h, trend === 1 ? band : null, Math.min(...h4.l.slice(-10))]
    .filter(x => x != null && x < price * 0.999);
  const support1 = supCands.length ? Math.max(...supCands) : sl;

  // ── Syarat gugur (SKIP) & peringatan (WAIT) ────────────────────────────────
  const skip = [], wait = [];
  if (trend === -1)        skip.push(`tren SATS 4H bearish (harga di bawah band ${fmt(band)})`);
  if (tD.label === 'BEARISH') skip.push('tren harian bearish (harga < EMA21 1D dan EMA9 < EMA21)');
  if (rsi > 80)            skip.push(`RSI 4H ${rsi.toFixed(0)} sangat overbought`);
  if (!(risk > 0))         skip.push(`harga sudah di bawah SL SATS ${fmt(sl)}`);
  else if (rr < 1)         skip.push(`R:R 1:${rr.toFixed(1)} terlalu kecil (resistance ${fmt(resistance1)} terlalu dekat)`);

  if (!skip.length) {
    if (tqi < 0.35)        wait.push(`kualitas tren rendah (TQI ${tqi.toFixed(2)} < 0.35)`);
    if (tD.label === 'NEUTRAL') wait.push('tren harian belum jelas');
    if (tH.label === 'BEARISH') wait.push('1H masih bearish (koreksi jangka pendek)');
    if (rsi > 72)          wait.push(`RSI 4H ${rsi.toFixed(0)} sudah panas`);
    if (volRatio < 1)      wait.push(`volume 4H ${volRatio.toFixed(2)}x di bawah rata-rata (belum ada konfirmasi)`);
    if (riskPct > 12)      wait.push(`jarak SL ${riskPct.toFixed(1)}% terlalu lebar`);
    if (rr < 1.5)          wait.push(`R:R hanya 1:${rr.toFixed(1)}`);
    if (age > FRESH_BARS)  wait.push(`tren SATS sudah berjalan ${age} candle (~${age * 4} jam), entry sekarang terlambat`);
  }

  // ── Skor gabungan (maks 100) ───────────────────────────────────────────────
  let score = tqi * 25;
  score += h4Label === 'BULLISH' ? 15 : 0;
  score += tD.label === 'BULLISH' ? 15 : (tD.label === 'NEUTRAL' ? 7 : 0);
  score += tH.label === 'BULLISH' ? 5  : (tH.label === 'NEUTRAL' ? 2 : 0);
  score += volRatio >= 1.5 ? 15 : (volRatio >= 1 ? 8 : 0);
  score += (rsi >= 45 && rsi <= 65) ? 10 : (rsi > 65 && rsi <= 72) ? 6 : (rsi > 72 && rsi <= 78) ? 2 : (rsi < 45 ? 4 : 0);
  score += rr >= 2 ? 10 : (rr >= 1.5 ? 6 : (rr >= 1 ? 3 : 0));
  score += age <= FRESH_BARS && trend === 1 ? 5 : 0;
  score = Math.round(clamp(score, 0, 100));

  if (!skip.length && !wait.length && score < MIN_SCORE) wait.push(`skor gabungan ${score} < ${MIN_SCORE}`);

  const verdict = skip.length ? 'SKIP' : (wait.length ? 'WAIT' : 'BUY_NOW');
  const confidence = verdict === 'SKIP' ? Math.min(score, 35) : (verdict === 'WAIT' ? Math.min(score, 69) : score);

  // ── Teks ───────────────────────────────────────────────────────────────────
  const tp = tpR.map(r => price + risk * r);
  const pullback = `Tunggu pullback ke area ${fmt(support1)} (band SATS / EMA21 4H) dan konfirmasi candle 4H.`;
  const caveat = 'Berita, sentimen, token unlock, dan jadwal makro TIDAK dicek (mode tanpa AI) — periksa manual sebelum entry.';

  let recommendation;
  if (verdict === 'BUY_NOW') {
    recommendation = `Setup valid: tren SATS 4H bullish baru ${age} candle, TQI ${tqi.toFixed(2)}. Entry sekitar ${fmt(price)}, SL ${fmt(sl)} (risiko ${riskPct.toFixed(1)}%), TP1 ${fmt(resistance1)} (R:R 1:${rr.toFixed(1)}); target lanjutan ${tpR.map((r, i) => `${r}R=${fmt(tp[i])}`).join(', ')}. Setup batal bila close 4H di bawah ${fmt(sl)}. ${caveat}`;
  } else if (verdict === 'WAIT') {
    recommendation = `Belum ideal: ${wait.join('; ')}. ${pullback} Referensi SL ${fmt(sl)}, TP1 ${fmt(resistance1)}. Batal bila close 4H di bawah ${fmt(sl)}. ${caveat}`;
  } else {
    recommendation = `Hindari sekarang: ${skip.join('; ')}. ${caveat}`;
  }

  const rsiStatus = `RSI 4H=${rsi.toFixed(0)} — ${rsi > 80 ? 'sangat overbought' : rsi > 72 ? 'panas, ruang terbatas' : rsi >= 45 ? 'ruang masih ada' : 'lemah'}`;
  const pumpOrBreakout =
      volRatio >= 1.5 && price >= high20_4h * 0.995 ? 'breakout dengan dukungan volume'
    : chg24 > 15 && volRatio < 1                    ? 'naik tajam tanpa dukungan volume (waspada pump)'
    : trend === 1                                   ? 'tren naik berjalan, belum ada lonjakan khusus'
    : 'belum jelas';

  const analysis = {
    mode: 'rule-based',
    verdict,
    confidence,
    summary: `[Mode tanpa AI — aturan teknikal] Harga ${fmt(price)}. SATS 4H ${trend === 1 ? 'bullish' : 'bearish'} ` +
             `(TQI ${tqi.toFixed(2)}, ER ${er.toFixed(2)}, umur ${age} candle), 1D ${tD.label}, 1H ${tH.label}. Skor ${score}/100.`,
    momentum: {
      volumeRatio: `${volRatio.toFixed(2)}x rata-rata 10 candle (4H)`,
      rsiStatus,
      pumpOrBreakout,
    },
    utbotSignal: {                       // nama key dipertahankan agar dashboard/Telegram tetap kompatibel
      slLevel:    fmt(sl),
      entryIdeal: verdict === 'BUY_NOW' ? `${fmt(price)} (sekitar harga sekarang)` : (verdict === 'WAIT' ? `pullback ke ${fmt(support1)}` : '-'),
      tp1Level:   `${fmt(resistance1)}${breakout ? ' (proyeksi 2R, harga di area breakout)' : ''}`,
      rrRatio:    `1:${rr.toFixed(1)}`,
      riskPct:    `${riskPct.toFixed(1)}%`,
    },
    trendAlignment: {
      daily: tD.label,
      h4:    h4Label,
      h1:    tH.label,
      aligned,
      note:  aligned ? 'Ketiga timeframe searah bullish.' : `1D ${tD.label}, 4H ${h4Label}, 1H ${tH.label} — belum semuanya searah.`,
    },
    sentiment: {
      overall:   'NEUTRAL',
      catalysts: 'Tidak tersedia (mode tanpa AI)',
      risks:     'Berita, token unlock, dan jadwal makro tidak dicek — periksa manual',
    },
    keyLevels: {
      currentPrice:  fmt(price),
      resistance1:   fmt(resistance1),
      support1:      fmt(support1),
      criticalLevel: `${fmt(tD.e21)} (EMA21 1D)`,
    },
    recommendation,
  };

  log('ai_analyst', `  ✅ Analisa aturan selesai: ${verdict} (${confidence}%) | SATS ${trend === 1 ? 'bull' : 'bear'} TQI=${tqi.toFixed(2)} RSI=${rsi.toFixed(0)} R:R=1:${rr.toFixed(1)}`);
  return analysis;
}

/**
 * Pembungkus untuk analyzeOnDemand di aiAnalyst.js:
 *   AI aktif  → coba AI dulu; bila gagal/kosong → fallback aturan
 *   AI mati   → langsung analisa aturan
 */
export async function analyzeWithFallback(symbol, aiFn, aiEnabled) {
  let analysis = null;
  if (aiEnabled) {
    analysis = await aiFn(symbol);
    if (!analysis) log('ai_analyst', `  ↪ AI gagal untuk ${symbol} — fallback ke analisa berbasis aturan`);
  } else {
    log('ai_analyst', '⚠ AI tidak aktif — memakai analisa berbasis aturan (tanpa AI)');
  }
  if (analysis) return analysis;
  try {
    return await ruleBasedAnalysis(symbol);
  } catch (err) {
    log('ai_analyst_error', `ruleBasedAnalysis ${symbol}: ${err.message}`);
    return null;
  }
}
