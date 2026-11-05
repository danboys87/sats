/**
 * Bitget REST API Client
 * Docs: https://www.bitget.com/api-doc/spot/intro
 *
 * v4.3.1: tambah getSymbolInfo() + floorQty() — presisi quantity per-symbol
 *         dari /api/v2/spot/public/symbols (menggantikan pembulatan hardcode 2 desimal).
 */
import crypto from 'crypto';
import axios  from 'axios';
import { log } from './logger.js';

const BASE_URL = 'https://api.bitget.com';

function sign(timestamp, method, requestPath, body, secretKey) {
  const msg = timestamp + method.toUpperCase() + requestPath + (body || '');
  return crypto.createHmac('sha256', secretKey).update(msg).digest('base64');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(method, path, params = {}, body = null, auth = true, _retry = 0) {
  const timestamp   = Date.now().toString();
  let requestPath   = path;

  if (method === 'GET' && Object.keys(params).length > 0) {
    requestPath = `${path}?${new URLSearchParams(params)}`;
  }

  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'locale': 'en-US' };

  if (auth) {
    headers['ACCESS-KEY']        = process.env.BITGET_API_KEY;
    headers['ACCESS-SIGN']       = sign(timestamp, method, requestPath, bodyStr, process.env.BITGET_SECRET_KEY);
    headers['ACCESS-TIMESTAMP']  = timestamp;
    headers['ACCESS-PASSPHRASE'] = process.env.BITGET_PASSPHRASE;
  }

  const isCandle  = path.includes('candles');
  const timeout   = isCandle ? 20000 : 15000;

  try {
    const res  = await axios({ method, url: BASE_URL + requestPath, headers, data: body || undefined, timeout });
    const data = res.data;
    if (data.code !== '00000' && data.code !== 0) throw new Error(`Bitget API ${data.code}: ${data.msg}`);
    return data.data;
  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    const is5xx     = err.response?.status >= 500;
    const maxRetry  = isCandle ? 3 : 2;

    if ((isTimeout || is5xx) && _retry < maxRetry) {
      const waitMs = (isCandle ? 2000 : 1000) * (_retry + 1);
      log('bitget_warn', `${isTimeout ? 'Timeout' : `HTTP ${err.response?.status}`} ${path} — retry ${_retry + 1}/${maxRetry} dalam ${waitMs / 1000}s`);
      await sleep(waitMs);
      return request(method, path, params, body, auth, _retry + 1);
    }

    if (err.response) throw new Error(`Bitget HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    throw err;
  }
}

export async function getAllTickers() {
  return request('GET', '/api/v2/spot/market/tickers', {}, null, false);
}

export async function getTicker(symbol) {
  return request('GET', '/api/v2/spot/market/tickers', { symbol }, null, false);
}

export async function getCandles(symbol, granularity = '1H', limit = 100) {
  return request('GET', '/api/v2/spot/market/candles', { symbol, granularity, limit: String(limit) }, null, false);
}

export async function getAccountAssets() {
  return request('GET', '/api/v2/spot/account/assets');
}

export async function getAssetBalance(coin) {
  const assets = await getAccountAssets();
  return Array.isArray(assets) ? (assets.find(a => a.coin === coin) || null) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYMBOL INFO (presisi & minimum order) — cache 6 jam
// ─────────────────────────────────────────────────────────────────────────────
const SYMBOL_CACHE_TTL = 6 * 60 * 60 * 1000;
let _symInfo     = new Map();
let _symInfoAt   = 0;
let _symInfoPromise = null;

async function refreshSymbolInfo() {
  const rows = await request('GET', '/api/v2/spot/public/symbols', {}, null, false);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('symbols kosong');
  const m = new Map();
  for (const s of rows) {
    m.set(s.symbol, {
      quantityPrecision: parseInt(s.quantityPrecision),
      pricePrecision:    parseInt(s.pricePrecision),
      minTradeAmount:    parseFloat(s.minTradeAmount) || 0,   // minimum qty (base coin)
      minTradeUSDT:      parseFloat(s.minTradeUSDT)   || 0,   // minimum nilai order (USDT)
    });
  }
  _symInfo   = m;
  _symInfoAt = Date.now();
  log('bitget', `Symbol info dimuat: ${m.size} pair`);
}

/**
 * @returns {Promise<null | {quantityPrecision, pricePrecision, minTradeAmount, minTradeUSDT}>}
 * null bila info tidak tersedia (jangan menebak presisi untuk order live).
 */
export async function getSymbolInfo(symbol) {
  const stale = Date.now() - _symInfoAt > SYMBOL_CACHE_TTL;
  if (_symInfo.size === 0 || stale) {
    if (!_symInfoPromise) {
      _symInfoPromise = refreshSymbolInfo()
        .catch(err => log('bitget_warn', `Gagal muat symbol info: ${err.message}`))
        .finally(() => { _symInfoPromise = null; });
    }
    await _symInfoPromise;
  }
  const info = _symInfo.get(symbol);
  return (info && Number.isFinite(info.quantityPrecision)) ? info : null;
}

/**
 * Bulatkan quantity KE BAWAH sesuai presisi.
 * Return { qty: Number, str: String } — kirim `str` ke API (hindari notasi eksponen, mis. 1e-7).
 */
export function floorQty(qty, precision) {
  const p = Math.max(0, Math.min(12, precision | 0));
  const m = Math.pow(10, p);
  const v = Math.floor(qty * m + 1e-9) / m;     // 1e-9: koreksi error floating point (0.29*100 = 28.999…)
  return { qty: v, str: v.toFixed(p) };
}

export async function placeOrder({ symbol, side, orderType, size, quoteMode = false }) {
  const body = {
    symbol,
    side,
    orderType,
    force:     'gtc',
    clientOid: `bot_${Date.now()}`,
    size:      String(size),     // market buy: size = jumlah USDT | selain itu: jumlah coin
  };

  return request('POST', '/api/v2/spot/trade/place-order', {}, body);
}

export async function getOrder(orderId, symbol) {
  return request('GET', '/api/v2/spot/trade/orderInfo', { orderId, symbol });
}

export async function getCurrentPrice(symbol) {
  const tickers = await getTicker(symbol);
  const t = Array.isArray(tickers) ? tickers[0] : tickers;
  return t ? parseFloat(t.lastPr || t.last) : null;
}

export async function testConnection() {
  try {
    const assets = await getAccountAssets();
    return { ok: true, assets: assets?.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
