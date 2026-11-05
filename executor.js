/**
 * Executor
 * Eksekusi order beli/jual ke Bitget Spot API.
 *
 * v4.3: SL awal posisi = trailing stop UT Bot (candidate.slPrice) bila management.slMode = 'utbot'.
 * v4.3.1: presisi quantity per-symbol (quantityPrecision dari Bitget) + cek minimum order.
 *         Sebelumnya jual dibulatkan 2 desimal → BTC/ETH qty kecil jadi 0 dan gagal terjual.
 */
import { placeOrder, getOrder, getAssetBalance, getCurrentPrice, getSymbolInfo, floorQty } from './bitget.js';
import { config }    from './config.js';
import { log }       from './logger.js';
import { logTrade }  from './logger.js';
import { openPosition, closePosition as closePos, recordPartialSell } from './state.js';

// Dibaca saat dipanggil (bukan saat import) supaya DRY_RUN dari .env selalu terbaca
const isDryRun = () => process.env.DRY_RUN === 'true';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fallback HANYA untuk dry-run bila info symbol tidak tersedia
function fallbackDecimals(price) {
  if (price >= 10000) return 6;
  if (price >= 100)   return 4;
  return 2;
}

async function calcQuantity(symbol, budget) {
  const price = await getCurrentPrice(symbol);
  if (!price || price <= 0) throw new Error(`Harga tidak valid untuk ${symbol}`);

  const info     = await getSymbolInfo(symbol);
  const decimals = info ? info.quantityPrecision : fallbackDecimals(price);
  const { qty }  = floorQty(budget / price, decimals);
  return { price, qty };
}

/**
 * Hitung qty jual yang valid untuk order live.
 * Return { ok, qtyStr, qty } atau { ok:false, error }
 */
async function resolveSellQty(symbol, wantedQty, price) {
  const baseAsset = symbol.replace('USDT', '');
  const tokenBal  = await getAssetBalance(baseAsset);
  const available = parseFloat(tokenBal?.available || 0);

  const info = await getSymbolInfo(symbol);
  if (!info) {
    return { ok: false, error: `Presisi ${symbol} tidak tersedia (gagal ambil symbol info) — jual dibatalkan, coba lagi` };
  }

  const raw          = Math.min(wantedQty, available);
  const { qty, str } = floorQty(raw, info.quantityPrecision);

  if (qty <= 0) {
    return { ok: false, error: `Saldo ${baseAsset} tidak cukup: tersedia ${available}, presisi ${info.quantityPrecision} desimal` };
  }
  if (info.minTradeAmount > 0 && qty < info.minTradeAmount) {
    return { ok: false, error: `Qty ${str} di bawah minimum ${info.minTradeAmount} ${baseAsset}` };
  }
  if (info.minTradeUSDT > 0 && qty * price < info.minTradeUSDT) {
    return { ok: false, error: `Nilai order ${(qty * price).toFixed(2)} USDT di bawah minimum ${info.minTradeUSDT} USDT` };
  }
  return { ok: true, qty, qtyStr: str };
}

// ── SL dari UT Bot ───────────────────────────────────────────────────────────
function useUtbotSL() {
  return (config.management?.slMode ?? 'utbot') === 'utbot';
}

/**
 * Tentukan SL posisi. Mengembalikan null bila slMode bukan 'utbot' atau slPrice tidak ada
 * (manager lalu memakai fallback stopLossPct).
 * maxSlPct (opsional, 0 = nonaktif): batasi jarak SL maksimal dari entry.
 */
function resolveSL(entryPrice, slPrice) {
  if (!useUtbotSL() || !slPrice || slPrice <= 0 || slPrice >= entryPrice) return null;
  const cap = config.management?.maxSlPct ?? 0;
  if (cap > 0) return Math.max(slPrice, entryPrice * (1 - cap / 100));
  return slPrice;
}

// Penjaga harga basi: bandingkan harga sekarang dengan close candle sinyal
function checkStaleEntry(candidate, currentPrice) {
  const maxDev = config.trading?.maxEntryDeviationPct ?? 0;
  const ref    = candidate.close ?? candidate.lastPrice;
  if (!(maxDev > 0) || !(ref > 0) || candidate.strategy === 'manual') return null;
  const dev = (currentPrice - ref) / ref * 100;
  if (Math.abs(dev) <= maxDev) return null;
  const age = candidate.candleTs ? Math.round((Date.now() - (candidate.candleTs + 4 * 3600000)) / 60000) : null;
  return 'Harga basi: sekarang ' + currentPrice + ' vs close sinyal ' + ref + ' (' + (dev >= 0 ? '+' : '') + dev.toFixed(1) + '%, batas ±' + maxDev + '%)' +
         (age != null ? ' — sinyal ' + age + ' menit lalu' : '') + ' — beli dibatalkan';
}

export async function executeBuy(candidate) {
  const { symbol, score, signals, slPrice, tp1Price } = candidate;
  const budget = candidate.budget || config.trading.budgetPerTrade;
  const dryRun = isDryRun();

  try {
    log('executor', `Mencoba beli ${symbol} | budget=${budget} USDT`);

    const { price: currentPrice, qty } = await calcQuantity(symbol, budget);

    if (qty <= 0) {
      log('executor_error', `Quantity tidak valid untuk ${symbol}`);
      return { success: false, error: 'Quantity <= 0' };
    }

    // Harga menyimpang jauh dari close sinyal → setup sudah basi, jangan beli
    const stale = checkStaleEntry(candidate, currentPrice);
    if (stale) {
      log('executor_warn', symbol + ': ' + stale);
      return { success: false, error: stale };
    }

    // Harga sudah turun di bawah SL UT Bot sejak sinyal → setup batal, jangan beli
    if (useUtbotSL() && slPrice && currentPrice <= slPrice) {
      const msg = `Harga ${currentPrice} sudah di bawah SL UT Bot ${slPrice.toFixed(6)} — beli dibatalkan`;
      log('executor_error', `${symbol}: ${msg}`);
      return { success: false, error: msg };
    }

    if (dryRun) {
      const sl = resolveSL(currentPrice, slPrice);
      log('executor', `[DRY RUN] BUY ${symbol} qty=${qty} @ ${currentPrice} | SL=${sl ? sl.toFixed(6) : 'fallback'}`);
      openPosition({
        symbol,
        entryPrice: currentPrice,
        quantity:   qty,
        orderId:    `dryrun_${Date.now()}`,
        budget,
        score,
        signals,
        slPrice:    sl,
        tp1Price:   tp1Price ?? null,
      });
      logTrade({ side: 'buy', symbol, qty, price: currentPrice, reason: 'dry-run' });
      return { success: true, entryPrice: currentPrice, quantity: qty, orderId: 'dry-run', slPrice: sl };
    }

    const usdtBalance = await getAssetBalance('USDT');
    const available   = parseFloat(usdtBalance?.available || 0);
    const needed      = budget + config.trading.gasReserve;

    if (available < needed) {
      log('executor_error', `Saldo USDT tidak cukup: ${available} < ${needed}`);
      return { success: false, error: 'Saldo tidak cukup' };
    }

    const order = await placeOrder({
      symbol,
      side:      'buy',
      orderType: 'market',
      size:      budget,          // market buy: size = jumlah USDT
      quoteMode: true,
    });

    const orderId = order?.orderId;
    if (!orderId) throw new Error('Tidak ada orderId dari API');

    await sleep(1500);
    const orderDetail = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || orderDetail.fillPrice || currentPrice) : currentPrice;
    const fillQty     = orderDetail ? parseFloat(orderDetail.baseVolume || orderDetail.fillSize || qty) : qty;
    const sl          = resolveSL(fillPrice, slPrice);

    openPosition({
      symbol,
      entryPrice: fillPrice,
      quantity:   fillQty,
      orderId,
      budget,
      score,
      signals,
      slPrice:    sl,
      tp1Price:   tp1Price ?? null,
    });

    logTrade({ side: 'buy', symbol, qty: fillQty, price: fillPrice, reason: 'screening' });
    log('executor', `✅ BUY ${symbol} | qty=${fillQty} @ ${fillPrice} | SL=${sl ? sl.toFixed(6) : 'fallback'} | orderId=${orderId}`);

    return { success: true, entryPrice: fillPrice, quantity: fillQty, orderId, slPrice: sl };

  } catch (err) {
    log('executor_error', `Beli ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export async function executeSell(symbol, { quantity, reason, position }) {
  try {
    log('executor', `Mencoba jual ${symbol} | qty=${quantity} | reason=${reason}`);

    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error(`Tidak bisa ambil harga ${symbol}`);

    if (isDryRun()) {
      log('executor', `[DRY RUN] SELL ${symbol} qty=${quantity} @ ${currentPrice}`);
      const closed = closePos(symbol, { exitPrice: currentPrice, reason });
      if (closed) {
        logTrade({ side: 'sell', symbol, qty: quantity, price: currentPrice, reason });
      }
      return {
        success: true,
        exitPrice: currentPrice,
        pnlPct:   closed?.pnlPct,
        pnlUsdt:  closed?.pnlUsdt,
      };
    }

    const sq = await resolveSellQty(symbol, quantity, currentPrice);
    if (!sq.ok) {
      log('executor_error', `${symbol}: ${sq.error}`);
      return { success: false, error: sq.error };
    }

    const order = await placeOrder({
      symbol,
      side:      'sell',
      orderType: 'market',
      size:      sq.qtyStr,
    });

    const orderId = order?.orderId;
    await sleep(1500);
    const orderDetail = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || orderDetail.fillPrice || currentPrice) : currentPrice;

    const closed = closePos(symbol, { exitPrice: fillPrice, reason });
    logTrade({ side: 'sell', symbol, qty: sq.qty, price: fillPrice, reason });

    log('executor', `✅ SELL ${symbol} | qty=${sq.qtyStr} @ ${fillPrice} | reason=${reason}`);

    return {
      success:   true,
      exitPrice: fillPrice,
      pnlPct:    closed?.pnlPct,
      pnlUsdt:   closed?.pnlUsdt,
    };

  } catch (err) {
    log('executor_error', `Jual ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export async function executePartialSell(symbol, { sellPct, reason, position }) {
  try {
    const wanted = position.quantity * (sellPct / 100);
    if (!(wanted > 0)) return { success: false, error: 'Partial qty terlalu kecil' };

    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error('Harga tidak valid');

    if (isDryRun()) {
      const info = await getSymbolInfo(symbol);
      const { qty: sellQty } = floorQty(wanted, info ? info.quantityPrecision : fallbackDecimals(currentPrice));
      if (sellQty <= 0) return { success: false, error: 'Partial qty terlalu kecil' };
      log('executor', `[DRY RUN] Partial sell ${symbol}: ${sellPct}% (${sellQty}) @ ${currentPrice} | reason=${reason}`);
      recordPartialSell(symbol, { sellQty, price: currentPrice, reason });
      logTrade({ side: 'sell', symbol, qty: sellQty, price: currentPrice, reason: `partial-${reason}` });
      return { success: true, exitPrice: currentPrice, qty: sellQty };
    }

    const sq = await resolveSellQty(symbol, wanted, currentPrice);
    if (!sq.ok) {
      log('executor_error', `Partial ${symbol}: ${sq.error}`);
      return { success: false, error: sq.error };
    }

    log('executor', `Partial sell ${symbol}: ${sellPct}% (${sq.qtyStr}) @ ${currentPrice} | reason=${reason}`);

    const order = await placeOrder({
      symbol,
      side:      'sell',
      orderType: 'market',
      size:      sq.qtyStr,
    });

    await sleep(1500);
    const orderDetail = await getOrder(order?.orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || currentPrice) : currentPrice;

    recordPartialSell(symbol, { sellQty: sq.qty, price: fillPrice, reason });
    logTrade({ side: 'sell', symbol, qty: sq.qty, price: fillPrice, reason: `partial-${reason}` });

    return { success: true, exitPrice: fillPrice, qty: sq.qty };

  } catch (err) {
    log('executor_error', `Partial sell ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}
