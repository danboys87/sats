/**
 * Pasang analisa berbasis aturan (tanpa AI) — SATU perintah dari root repo:
 *   node applyRuleAnalyst.js
 *
 * Prasyarat: ruleAnalyst.js dan sats.js sudah ada di root repo.
 * Mengubah: aiAnalyst.js, apiServer.js, dashboard.html
 *   - /analyze (dashboard) tidak lagi ditolak saat API key AI kosong → pakai analisa aturan
 *   - bila AI aktif tapi gagal (mis. kuota habis) → otomatis fallback ke analisa aturan
 * Atomik: bila ada satu yang tidak cocok → TIDAK ada file yang diubah. Cadangan: *.bak-rule
 */

import fs from 'fs';

const AI = 'aiAnalyst.js', API = 'apiServer.js', DASH = 'dashboard.html';
const edits = [];
const line = (file, match, to) => edits.push({ file, kind: 'line', match, to });
const sub  = (file, match, to) => edits.push({ file, kind: 'sub',  match, to });

// aiAnalyst.js
line(AI, "import { log } from './logger.js';", ['$LINE', "import { analyzeWithFallback } from './ruleAnalyst.js';"]);
line(AI, 'export async function analyzeOnDemand(symbol) {', 'async function analyzeWithAI(symbol) {');
line(AI, 'export async function analyzeCandidate(candidate) {', [
  'export const analyzeOnDemand = (symbol) => analyzeWithFallback(symbol, analyzeWithAI, isAIEnabled());',
  '',
  '$LINE',
]);

// apiServer.js — hapus penolakan saat AI nonaktif
line(API, 'AI tidak aktif. Set OPENROUTER_API_KEY', []);

// dashboard.html
sub(DASH, 'dan sentiment market terkini.', 'dan sentiment market terkini. Bila API key AI belum diisi, dipakai analisa berbasis aturan teknikal (tanpa berita/sentimen).');

// ── engine ──
for (const f of [AI, API, DASH, 'ruleAnalyst.js', 'sats.js']) {
  if (!fs.existsSync(f)) { console.error(`❌ ${f} tidak ditemukan. Jalankan dari root repo & pastikan ruleAnalyst.js + sats.js sudah ada.`); process.exit(1); }
}
const files = {};
for (const f of [AI, API, DASH]) files[f] = fs.readFileSync(f, 'utf8');

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
for (const f of [AI, API, DASH]) {
  if (!fs.existsSync(f + '.bak-rule')) fs.copyFileSync(f, f + '.bak-rule');
  fs.writeFileSync(f, files[f]);
}
console.log(`✅ ${edits.length} perubahan diterapkan ke ${AI}, ${API}, ${DASH} (cadangan: *.bak-rule). Restart bot.`);
