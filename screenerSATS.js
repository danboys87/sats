/**
 * Screener — Self-Aware Trend System (SATS) 4H
 *
 * Mendeteksi flip tren SATS di candle 4H yang sudah closed.
 *
 * BUY  : tren flip ke bullish  (+ lolos filter di filters.js, semua bisa di-enable/disable via config)
 * SELL : tren flip ke bearish  (dipakai untuk exit posisi yang sudah open, tidak difilter)
 *
 * Parameter dari user-config.json → screening.sats (preset default / crypto / swing / custom).
 * SL awal = SL versi SATS (pivot low - k×ATR), dikirim lewat candidate.slPrice.
 * Score kandidat = TQI × 100 → BUY dengan kualitas tren tertinggi diproses lebih dulu.
 */

import { getCandles }  from './bitget.js';
import { calcSATS, resolveSATSParams, satsBuyLevels, satsMinCandles } from './sats.js';
import { makeCtx, checkEntryFilters, liveBtcRegime, describeFilters } from './filters.js';
import { config }      from './config.js';
import { log }         from './logger.js';
import { hasPosition, getOpenSymbols } from './state.js';
import { filterCryptoOnly }            from './symbolFilter.js';

const TF        = '4H';
const API_TF    = '4h';
const PERIOD_MS = 4 * 3600 * 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _sentSignals = new Map();
const signalKey = (symbol, signal, ts) => `${symbol}_${signal}_${TF}_${ts}`;

async function scanSymbol4H(symbol, S, _retry = 0) {
  const MAX_RETRY = 2;
  const { P, filters, candleLimit, tpR } = S;

  try {
    const raw = await getCandles(symbol, API_TF, candleLimit);
    if (!Array.isArray(raw) || raw.length < satsMinCandles(P)) return null;

    const now         = Date.now();
    const periodStart = now - (now % PERIOD_MS);
    const closed = raw
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    if (closed.length < satsMinCandles(P)) return null;

    const highs   = closed.map(c => parseFloat(c[2]));
    const lows    = closed.map(c => parseFloat(c[3]));
    const closes  = closed.map(c => parseFloat(c[4]));
    const volumes = closed.map(c => parseFloat(c[5]));
    const last    = closed.length - 1;
    const lastTs  = parseInt(closed[last][0]);

    const res = calcSATS(highs, lows, closes, volumes, P);
    if (last < P.warmup) return null;

    const signal = res.flipUp[last] ? 'BUY' : res.flipDown[last] ? 'SELL' : null;
    if (!signal) return null;

    // ── BUY: level SL/TP + filter ──
    let lv = null;
    if (signal === 'BUY') {
      lv = satsBuyLevels(res, last, tpR);
      if (!(lv.risk > 0)) return null;
      const ctx    = makeCtx({ highs, lows, closes, volumes, atr: res.rawAtr });
      const reject = checkEntryFilters(ctx, last, { tqi: res.tqi[last], riskPct: lv.riskPct }, filters, S.regime);
      if (reject) {
        log('sats', `  ⛔ ${symbol} BUY ditolak filter: ${reject}`);
        return null;
      }
    }

    // Dedupe per sinyal (SELL untuk posisi terbuka tidak di-dedupe → harus selalu bisa memicu exit)
    const key = signalKey(symbol, signal, lastTs);
    if (_sentSignals.has(key) && !(signal === 'SELL' && hasPosition(symbol))) return null;
    _sentSignals.set(key, Date.now());
    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _sentSignals.entries()) if (ts < cutoff) _sentSignals.delete(k);

    const tqi    = res.tqi[last];
    const er     = res.er[last];
    const band   = res.stLine[last];
    const slPrice = lv ? lv.sl : null;

    return {
      symbol,
      signal,
      close:        closes[last],
      trailingStop: band,
      prevStop:     res.stLine[last - 1],
      atr:          res.atr[last],
      candleTs:     lastTs,
      lastPrice:    closes[last],
      slPrice,
      tp1Price:     lv ? lv.tp[0] : null,
      tp2Price:     lv ? lv.tp[1] : null,
      tp3Price:     lv ? lv.tp[2] : null,
      riskPct:      lv ? lv.riskPct : null,
      tqi, er,
      preset:       P.preset,
      timeframe:    TF,
      strategy:     'sats',
      triggered:    true,
      signals: {
        satsSignal: {
          bullish: signal === 'BUY',
          label: `SATS ${signal} [4H/${P.preset}] — TQI ${tqi.toFixed(2)} ER ${er.toFixed(2)} | band ${band.toFixed(6)}` +
                 (lv ? ` | SL ${lv.sl.toFixed(6)} (risiko ${lv.riskPct.toFixed(1)}%)` : ''),
        },
      },
      zones: signal === 'BUY' ? [{
        type:        'SATS',
        entryPct:    100,
        priceTop:    closes[last] * 1.005,
        priceBottom: lv.sl,
        label:       `SATS BUY zone ${lv.sl.toFixed(6)} - ${(closes[last] * 1.005).toFixed(6)}`,
      }] : [],
      matchCount: 1,
      score: Math.round(tqi * 100),
    };

  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.message?.includes('exceeded');
    if (isTimeout && _retry < MAX_RETRY) {
      const waitMs = 3000 * (_retry + 1);
      log('sats', `  ⏳ ${symbol} [4H] timeout — retry ${_retry + 1}/${MAX_RETRY} dalam ${waitMs / 1000}s`);
      await sleep(waitMs);
      return scanSymbol4H(symbol, S, _retry + 1);
    }
    if (isTimeout) log('sats', `  ⚠ ${symbol} [4H] timeout setelah ${MAX_RETRY + 1}x — skip`);
    else           log('sats_error', `Scan ${symbol} [4H]: ${err.message}`);
    return null;
  }
}

/**
 * @param {Array}  tickers  hasil getAllTickers()
 * @param {object} opts     { mode: 'all'|'buy_only'|'sell_only', maxSignals }
 */
export async function runSATSScreener(tickers, opts = {}) {
  const sCfg        = config.screening?.sats ?? {};
  const P           = resolveSATSParams(sCfg);
  const minVol      = sCfg.minVolume24h ?? config.screening?.minVolume24h ?? 5_000_000;
  const maxSignals  = opts.maxSignals ?? sCfg.maxSignalsPerRun ?? 10;
  const quoteAsset  = config.trading.quoteAsset || 'USDT';
  const mode        = opts.mode ?? 'all';
  const filters     = sCfg.filters ?? {};
  const S = {
    P, filters,
    candleLimit: Math.max(sCfg.candleLimit ?? 300, satsMinCandles(P) + 20),
    tpR:         sCfg.tpR ?? [1, 2, 3],
    regime:      null,
  };

  const fDesc = describeFilters(filters);

  // Rezim BTC dihitung sekali per scan (cache per candle 4H)
  if (filters.btcRegime?.enabled && mode !== 'sell_only') {
    S.regime = await liveBtcRegime(getCandles, filters.btcRegime);
    log('sats', `  BTC rezim: ${S.regime?.bullish == null ? 'TIDAK TERSEDIA → BUY diblokir' : S.regime.bullish ? 'bullish' : 'TIDAK bullish → BUY diblokir'}`);
  }

  log('sats', `══ SATS Screener (4H | preset=${P.preset} ATR${P.atrLen} x${P.baseMult} SL${P.slMult}xATR | mode=${mode} | filter BUY: ${fDesc}) ══`);

  const cryptoTickers = await filterCryptoOnly(Array.isArray(tickers) ? tickers : []);

  const filtered = cryptoTickers
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))                        return false;
      if (config.blacklist?.includes(t.symbol))                  return false;
      if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVol)  return false;
      return true;
    })
    .sort((a, b) => parseFloat(b.usdtVol || 0) - parseFloat(a.usdtVol || 0));

  // Posisi terbuka SELALU di-scan lebih dulu (walau volume di bawah filter)
  const openSyms  = getOpenSymbols();
  const openSet   = new Set(openSyms);
  const openCoins = openSyms.map(s => cryptoTickers.find(t => t.symbol === s) ?? { symbol: s });
  const scanList  = [...openCoins, ...filtered.filter(t => !openSet.has(t.symbol))];

  log('sats', `Scanning ${scanList.length} koin (4H) — ${openCoins.length} posisi terbuka diprioritaskan...`);

  const signals = [];
  let timeouts = 0;
  const MAX_CONSEC_TIMEOUT = 3;

  for (let i = 0; i < scanList.length; i++) {
    const coin    = scanList[i];
    const before  = Date.now();
    const result  = await scanSymbol4H(coin.symbol, S);
    const elapsed = Date.now() - before;

    if (elapsed > 20000) {
      timeouts++;
      if (timeouts >= MAX_CONSEC_TIMEOUT) {
        log('sats', `  ⚠ ${timeouts} timeout berturut-turut — jeda 10s`);
        await sleep(10000);
        timeouts = 0;
      }
    } else timeouts = 0;

    if (result) {
      if (mode === 'buy_only'  && result.signal !== 'BUY')  { await sleep(100); continue; }
      if (mode === 'sell_only' && result.signal !== 'SELL') { await sleep(100); continue; }

      result.hasPosition = hasPosition(result.symbol);
      result.vol24h      = parseFloat(coin.usdtVol || coin.quoteVolume || 0);
      result.change24h   = parseFloat(coin.change24h || 0);
      signals.push(result);

      log('sats', `  ${result.signal === 'BUY' ? '🟢' : '🔴'} ${result.signal} [4H]: ${result.symbol} @ ${result.close} | TQI=${result.tqi.toFixed(2)} band=${result.trailingStop.toFixed(6)}` +
                  (result.slPrice ? ` SL=${result.slPrice.toFixed(6)} (${result.riskPct.toFixed(1)}%)` : ''));

      const buyCount = signals.filter(x => x.signal === 'BUY' && !x.hasPosition).length;
      if (buyCount >= maxSignals && i >= openCoins.length - 1) {
        log('sats', `  Max ${maxSignals} sinyal tercapai, berhenti`);
        break;
      }
    }

    if (i % 10 === 9)        await sleep(1500);
    else if (i % 5 === 4)    await sleep(800);
    else if (elapsed > 8000) await sleep(800);
    else                     await sleep(300);
  }

  const buySignals  = signals.filter(s => s.signal === 'BUY').sort((a, b) => b.score - a.score);
  const sellSignals = signals.filter(s => s.signal === 'SELL').sort((a, b) => (b.hasPosition ? 1 : 0) - (a.hasPosition ? 1 : 0));

  log('sats', `SATS selesai → ${buySignals.length} BUY, ${sellSignals.length} SELL signal`);
  return [...buySignals, ...sellSignals];
}
