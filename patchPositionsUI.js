/**
 * Patch halaman "Open Positions — Detail" (dashboard):
 *   - kolom Qty dihapus
 *   - modal/budget tampil di samping symbol
 *   - SL menampilkan harga + persen jarak dari entry
 *   - kolom TP baru (harga + persen)
 *
 * Jalankan SEKALI dari root repo:   node patchPositionsUI.js
 * Lalu RESTART bot (apiServer.js berubah) dan refresh browser (Ctrl+F5).
 * Atomik: bila ada satu yang tidak cocok → tidak ada file yang berubah. Cadangan: *.bak-pos
 */

import fs from 'fs';

const D = 'dashboard.html', A = 'apiServer.js';
const edits = [];
const line = (file, match, to) => edits.push({ file, kind: 'line', match, to });
const sub  = (file, match, to) => edits.push({ file, kind: 'sub',  match, to });

// ═════════════ apiServer.js — kirim harga TP ═════════════
line(A, 'async function handle(req, res) {', [
  'function tpFields(pos) {',
  '  const m = config.management ?? {};',
  '  const fixedTP = m.useFixedTP === true;                     // TP tetap hanya aktif bila useFixedTP = true',
  '  const own = pos.tp1Price > 0 ? pos.tp1Price : null;        // TP1 dari screener (1R dari SL SATS)',
  '  const tpPrice = fixedTP ? (own ?? pos.entryPrice * (1 + (m.takeProfitPct ?? 10) / 100)) : own;',
  '  return { tpPrice, tpActive: fixedTP };',
  '}',
  '',
  '$LINE',
]);
sub(A, 'effectiveSL: getEffectiveSL(pos, config.management) };', 'effectiveSL: getEffectiveSL(pos, config.management), ...tpFields(pos) };');

// ═════════════ dashboard.html ═════════════
// header tabel: Qty dihapus, TP ditambah (jumlah kolom tetap 10)
sub(D, '<th>Qty</th><th>SL</th>', '<th>SL</th><th>TP</th>');

// helper tampilan
line(D, 'function posRowFull(sym, p) {', [
  'function budgetOf(p) {',
  '  const b = Number(p.budget ?? (p.entryPrice * p.quantity));',
  "  return b.toFixed(2).replace(/\\.00$/, '');",
  '}',
  'function pctFrom(entry, price) { return (price - entry) / entry * 100; }',
  'function slInfo(p) {',
  '  const sl = Number(p.effectiveSL ?? p.slPrice);',
  "  if (!Number.isFinite(sl) || sl <= 0) return '—';",
  '  const pc = pctFrom(p.entryPrice, sl);',
  `  return sl.toFixed(6) + '<br><span style="font-size:10px">' + (pc >= 0 ? '+' : '') + pc.toFixed(2) + '%</span>';`,
  '}',
  'function tpInfo(p) {',
  '  const tp = Number(p.tpPrice);',
  `  if (!Number.isFinite(tp) || tp <= 0) return '<span style="color:var(--muted)">—</span>';`,
  '  const pc = pctFrom(p.entryPrice, tp);',
  "  const col = p.tpActive ? 'var(--green)' : 'var(--muted)';",
  `  const tip = p.tpActive ? 'TP tetap aktif' : 'TP tidak aktif (useFixedTP=false): exit lewat flip SATS / trailing / SL';`,
  `  return '<span title="' + tip + '" style="color:' + col + '">' + tp.toFixed(6) + '<br><span style="font-size:10px">' + (pc >= 0 ? '+' : '') + pc.toFixed(2) + '%' + (p.tpActive ? '' : ' · info') + '</span></span>';`,
  '}',
  '',
  '$LINE',
]);

// symbol + budget
line(D, '<td class="c-title"><b>${sym}</b></td>',
  `<td class="c-title"><b>\${sym}</b> <span style="color:var(--muted);font-size:11px;font-weight:400">· \${budgetOf(p)} USDT</span></td>`);

// Qty dihapus
line(D, 'data-label="Qty"', []);

// SL (+%) dan TP
line(D, 'data-label="SL"', [
  `<td data-label="SL" style="color:var(--red)">\${slInfo(p)}</td>`,
  `<td data-label="TP">\${tpInfo(p)}</td>`,
]);

// ═════════════ ENGINE ═════════════
const files = {};
for (const f of [D, A]) {
  if (!fs.existsSync(f)) { console.error(`❌ ${f} tidak ditemukan. Jalankan dari root repo.`); process.exit(1); }
  files[f] = fs.readFileSync(f, 'utf8');
}
const errors = [];
edits.forEach((e, n) => {
  const txt = files[e.file];
  if (e.kind === 'sub') {
    const count = txt.split(e.match).length - 1;
    if (count !== 1) { errors.push(`#${n + 1} ${e.file}: "${e.match.slice(0, 50)}" ditemukan ${count}x (harus 1x)`); return; }
    files[e.file] = txt.replace(e.match, () => e.to);
  } else {
    const eol = txt.includes('\r\n') ? '\r\n' : '\n';
    const lines = txt.split(eol);
    const hits = lines.reduce((a, l, i) => (l.includes(e.match) ? [...a, i] : a), []);
    if (hits.length !== 1) { errors.push(`#${n + 1} ${e.file}: baris "${e.match.slice(0, 50)}" ditemukan ${hits.length}x (harus 1x)`); return; }
    const i = hits[0], indent = lines[i].match(/^\s*/)[0];
    const out = (Array.isArray(e.to) ? e.to : [e.to]).map(t => (t === '$LINE' ? lines[i] : (t === '' ? '' : indent + t)));
    lines.splice(i, 1, ...out);
    files[e.file] = lines.join(eol);
  }
});
if (errors.length) {
  console.error('❌ Dibatalkan, TIDAK ada file yang diubah:\n  ' + errors.join('\n  '));
  console.error('\nKemungkinan sudah pernah di-patch, atau file berbeda dari versi yang saya baca.');
  process.exit(1);
}
for (const f of [D, A]) {
  if (!fs.existsSync(f + '.bak-pos')) fs.copyFileSync(f, f + '.bak-pos');
  fs.writeFileSync(f, files[f]);
}
console.log(`✅ ${edits.length} perubahan diterapkan ke ${D} dan ${A} (cadangan: *.bak-pos). Restart bot, lalu Ctrl+F5 di browser.`);
