/**
 * Ganti SEMUA tulisan "UT Bot / UTBot" yang tampil di terminal & notifikasi dari index.js → SATS.
 *
 * Jalankan SEKALI dari root repo:   node patchLabelsSATS.js
 *
 * Hanya teks yang tampil (banner, log, status, pesan error). Nama fungsi / key internal
 * (doUTBotScreener, exitOnUTBotSell, reason "utbot_sell") sengaja TIDAK diubah.
 * Atomik: bila ada satu yang tidak cocok → tidak ada file yang berubah. Cadangan: index.js.bak-labels
 */

import fs from 'fs';

const F = 'index.js';
if (!fs.existsSync(F)) { console.error(`❌ ${F} tidak ditemukan. Jalankan dari root repo.`); process.exit(1); }
let txt = fs.readFileSync(F, 'utf8');

// [teks lama, teks baru, jumlah kemunculan yang diharapkan]
const edits = [
  // banner & status
  ['UT Bot 4H + AI Ranking  ║',                 'SATS 4H + AI Ranking     ║', 1],  // lebar kotak = 50 (sejajar dengan garis ═)
  ['STATUS BOT v4.2 — UTBot 4H + AI',           'STATUS BOT v4.2 — SATS 4H + AI', 1],
  ['[UTBot 4H] ${p.symbol}',                    '[SATS 4H] ${p.symbol}', 1],
  ['utbot / screen— UTBot 4H screening',        'utbot / screen— SATS 4H screening', 1],

  // startup & cron
  ['ON (ikuti UT Bot SELL)',                    'ON (ikuti flip SATS bearish)', 1],
  ['UTBot 4H   : setiap',                       'SATS 4H    : setiap', 1],
  ['UTBot 4H  : ${cronUtbot}',                  'SATS 4H   : ${cronUtbot}', 2],
  ['UTBot masih berjalan, skip',                'SATS masih berjalan, skip', 1],
  ['UTBot error:',                              'SATS error:', 2],

  // kategori log [UTBOT] → [SATS]
  ["log('utbot',",                              "log('sats',", -1],               // -1 = minimal 1, semua diganti

  // pesan
  ['Tidak ada sinyal UTBot saat ini',           'Tidak ada sinyal SATS saat ini', 1],
  ['mengikuti UT Bot SELL @',                   'mengikuti flip SATS bearish @', 1],
  ['Exit UT Bot SELL ${sig.symbol}',            'Exit SATS SELL ${sig.symbol}', 1],
  ["strategy: 'UT Bot 4H',",                    "strategy: 'SATS 4H',", 1],
  ['📡 UT Bot: ${eligible.length}',             '📡 SATS: ${eligible.length}', 1],
];

const errors = [];
let total = 0;
for (const [from, to, expect] of edits) {
  const count = txt.split(from).length - 1;
  const ok = expect === -1 ? count >= 1 : count === expect;
  if (!ok) { errors.push(`"${from}" ditemukan ${count}x (diharapkan ${expect === -1 ? '≥1' : expect}x)`); continue; }
  txt = txt.split(from).join(to);
  total += count;
}

if (errors.length) {
  console.error('❌ Dibatalkan, TIDAK ada file yang diubah:\n  ' + errors.join('\n  '));
  console.error('\nKemungkinan sudah pernah di-patch, atau index.js berbeda dari versi yang saya baca.');
  process.exit(1);
}

if (!fs.existsSync(F + '.bak-labels')) fs.copyFileSync(F, F + '.bak-labels');
fs.writeFileSync(F, txt);
console.log(`✅ ${total} teks diganti di ${F} (cadangan: ${F}.bak-labels). Restart bot.`);
