/**
 * Penjaga harga basi — batalkan pembelian bila harga sekarang menyimpang terlalu jauh
 * dari close candle sinyal (mis. scan manual di tengah candle, atau approval yang telat).
 *
 * Jalankan SEKALI dari root repo:   node patchStaleGuard.js
 * Lalu RESTART bot dan Ctrl+F5 di browser.
 *
 * Mengubah:
 *   executor.js       → pengecekan sebelum order (dry run & live)
 *   user-config.json  → trading.maxEntryDeviationPct = 3  (0 = nonaktif)
 *   dashboard.html    → field "Maks Selisih Harga vs Sinyal (%)" di halaman Config
 *
 * Berlaku untuk kandidat dari screener (punya close sinyal). Beli manual (/buy, tombol Buy)
 * tidak kena aturan ini. Atomik: bila ada satu yang tidak cocok → tidak ada file yang berubah.
 * Cadangan: *.bak-stale
 */

import fs from 'fs';

const E = 'executor.js', D = 'dashboard.html', C = 'user-config.json';
const edits = [];
const line = (file, match, to) => edits.push({ file, kind: 'line', match, to });

// ═════════════ executor.js ═════════════
line(E, 'export async function executeBuy(candidate) {', [
  '// Penjaga harga basi: bandingkan harga sekarang dengan close candle sinyal',
  'function checkStaleEntry(candidate, currentPrice) {',
  '  const maxDev = config.trading?.maxEntryDeviationPct ?? 0;',
  '  const ref    = candidate.close ?? candidate.lastPrice;',
  "  if (!(maxDev > 0) || !(ref > 0) || candidate.strategy === 'manual') return null;",
  '  const dev = (currentPrice - ref) / ref * 100;',
  '  if (Math.abs(dev) <= maxDev) return null;',
  '  const age = candidate.candleTs ? Math.round((Date.now() - (candidate.candleTs + 4 * 3600000)) / 60000) : null;',
  "  return 'Harga basi: sekarang ' + currentPrice + ' vs close sinyal ' + ref + ' (' + (dev >= 0 ? '+' : '') + dev.toFixed(1) + '%, batas ±' + maxDev + '%)' +",
  "         (age != null ? ' — sinyal ' + age + ' menit lalu' : '') + ' — beli dibatalkan';",
  '}',
  '',
  '$LINE',
]);

line(E, 'Harga sudah turun di bawah SL UT Bot sejak sinyal', [
  '// Harga menyimpang jauh dari close sinyal → setup sudah basi, jangan beli',
  'const stale = checkStaleEntry(candidate, currentPrice);',
  'if (stale) {',
  "  log('executor_warn', symbol + ': ' + stale);",
  '  return { success: false, error: stale };',
  '}',
  '',
  '$LINE',
]);

// ═════════════ dashboard.html ═════════════
line(D, 'id="cfg-timeout"', [
  '$LINE',
  `<div class="field"><label>Maks Selisih Harga vs Sinyal (%) (0 = off)</label><input id="cfg-stale" type="number" step="0.5" min="0" value="\${trade.maxEntryDeviationPct ?? 3}"></div>`,
]);
line(D, "getElementById('cfg-timeout')", [
  '$LINE',
  "maxEntryDeviationPct: parseFloat(document.getElementById('cfg-stale').value) || 0,",
]);

// ═════════════ ENGINE ═════════════
const files = {};
for (const f of [E, D, C]) {
  if (!fs.existsSync(f)) { console.error(`❌ ${f} tidak ditemukan. Jalankan dari root repo.`); process.exit(1); }
  files[f] = fs.readFileSync(f, 'utf8');
}
const errors = [];
if (files[E].includes('checkStaleEntry') || files[D].includes('cfg-stale')) {
  console.error('❌ Dibatalkan, TIDAK ada file yang diubah:\n  patch ini sudah pernah diterapkan (executor.js / dashboard.html sudah berisi penjaga harga basi).');
  process.exit(1);
}
edits.forEach((e, n) => {
  const txt = files[e.file];
  const eol = txt.includes('\r\n') ? '\r\n' : '\n';
  const lines = txt.split(eol);
  const hits = lines.reduce((a, l, i) => (l.includes(e.match) ? [...a, i] : a), []);
  if (hits.length !== 1) { errors.push(`#${n + 1} ${e.file}: baris "${e.match.slice(0, 50)}" ditemukan ${hits.length}x (harus 1x)`); return; }
  const i = hits[0], indent = lines[i].match(/^\s*/)[0];
  const out = (Array.isArray(e.to) ? e.to : [e.to]).map(t => (t === '$LINE' ? lines[i] : (t === '' ? '' : indent + t)));
  lines.splice(i, 1, ...out);
  files[e.file] = lines.join(eol);
});

let newConfig = null;
try {
  const cfg = JSON.parse(files[C]);
  cfg.trading = cfg.trading ?? {};
  if (cfg.trading.maxEntryDeviationPct === undefined) cfg.trading.maxEntryDeviationPct = 3;
  newConfig = JSON.stringify(cfg, null, 2) + '\n';
} catch (e) { errors.push(`${C}: ${e.message}`); }

if (errors.length) {
  console.error('❌ Dibatalkan, TIDAK ada file yang diubah:\n  ' + errors.join('\n  '));
  console.error('\nKemungkinan sudah pernah di-patch, atau file berbeda dari versi yang saya baca.');
  process.exit(1);
}
files[C] = newConfig;
for (const f of [E, D, C]) {
  if (!fs.existsSync(f + '.bak-stale')) fs.copyFileSync(f, f + '.bak-stale');
  fs.writeFileSync(f, files[f]);
}
console.log(`✅ Penjaga harga basi terpasang (batas default ±3%). Cadangan: *.bak-stale. Restart bot, lalu Ctrl+F5 di browser.`);
