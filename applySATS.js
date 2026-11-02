/**
 * Terapkan SATS ke bot — SATU perintah, dari root repo:   node applySATS.js
 *
 * Mengubah: index.js, apiServer.js, dashboard.html, user-config.json
 *   (screenerSATS.js, sats.js, backtestSATS.js hanya perlu diletakkan di root repo)
 *
 * - Semua perubahan dicek dulu; bila ada satu saja yang tidak cocok → TIDAK ada file yang diubah.
 * - File asli dicadangkan ke *.bak.
 * - Menjalankan ulang setelah berhasil akan gagal (sudah ter-patch) — itu normal.
 * - Migrasi config: blok screening.utbot dihapus, diganti screening.sats (nilai interval/volume
 *   lama dibawa, filter dimulai OFF, preset "default").
 */

import fs from 'fs';

const D = 'dashboard.html';
const A = 'apiServer.js';
const I = 'index.js';
const edits = [];
const line = (file, match, to) => edits.push({ file, kind: 'line', match, to });
const sub  = (file, match, to) => edits.push({ file, kind: 'sub',  match, to });

// ═════════════════════════════ apiServer.js ═════════════════════════════
line(A, "import { getEffectiveSL } from './manager.js';", [
  '$LINE',
  "import { resolveSATSParams } from './sats.js';",
]);

line(A, 'p.candidate.strategy,', [
  '$LINE',
  'tqi:         p.candidate.tqi,',
  'riskPct:     p.candidate.riskPct,',
  'preset:      p.candidate.preset,',
]);

line(A, 'utbotKeyValue:', [
  'satsPreset:        resolveSATSParams(config.screening?.sats ?? {}).preset,',
  'satsBaseMult:      resolveSATSParams(config.screening?.sats ?? {}).baseMult,',
  'satsSlMult:        resolveSATSParams(config.screening?.sats ?? {}).slMult,',
]);
line(A, 'utbotAtrPeriod:',   'satsAtrLen:        resolveSATSParams(config.screening?.sats ?? {}).atrLen,');
line(A, 'utbotIntervalMin:', 'satsIntervalMin:  config.screening?.sats?.checkIntervalMin,');

sub(A, 'UTBot 4H screening dimulai', 'SATS 4H screening dimulai');

// ═════════════════════════════ dashboard.html ═════════════════════════════
// ── Halaman Screening ──
sub(D, '⊙ UT Bot Alert — 4H', '⊙ Self-Aware Trend System — 4H');
sub(D, 'UT Bot Alert — Timeframe 4H</div>', 'Self-Aware Trend System — Timeframe 4H</div>');
sub(D, 'ATR Trailing Stop crossover pada candle 4 jam.<br>', 'Band SuperTrend adaptif (berbasis kualitas tren / TQI) pada candle 4 jam.<br>');
sub(D, '(close cross di atas trailing stop) untuk entry,', '(tren flip bullish) untuk entry,');
sub(D, '(close cross di bawah trailing stop) untuk exit posisi terbuka.', '(tren flip bearish) untuk exit posisi terbuka.');
sub(D, 'id="utbotParams">Key: — | ATR: — | Interval: —', 'id="satsParams">Preset: — | ATR: — | Interval: —');
sub(D, '▶ Jalankan UTBot 4H Scan', '▶ Jalankan SATS 4H Scan');
sub(D, 'UTBot 4H scanning dimulai', 'SATS 4H scanning dimulai');
sub(D, 'UTBot 4H scanning berjalan', 'SATS 4H scanning berjalan');

// ── Stat cards ──
line(D, 'const utbotParamsEl', "const satsParamsEl = document.getElementById('satsParams');");
line(D, 'utbotParamsEl.textContent',
  "if (satsParamsEl) satsParamsEl.textContent = 'Preset: ' + (cfg.satsPreset ?? '—') + ' | ATR ' + (cfg.satsAtrLen ?? '—') + ' ×' + (cfg.satsBaseMult ?? '—') + ' | SL ' + (cfg.satsSlMult ?? '—') + '×ATR | Interval: tiap ' + (cfg.satsIntervalMin ?? '—') + ' menit';");
line(D, "el('st-tpsl').textContent", "el('st-tpsl').textContent      = 'SATS / +' + (cfg.trailActivatePct ?? '—') + '%';");

// ── Posisi & pending ──
sub(D, 'font-size:10px">UTBot 4H</span>', 'font-size:10px">SATS 4H</span>');
line(D, '📡 UTBot 4H</span>', [
  `<span class="badge gray">📡 SATS 4H\${p.preset ? ' · ' + p.preset : ''}</span>`,
  `\${p.tqi != null ? '<span class="badge blue">TQI ' + Number(p.tqi).toFixed(2) + '</span>' : ''}`,
  `\${p.riskPct != null ? '<span class="badge yellow">risiko SL ' + Number(p.riskPct).toFixed(1) + '%</span>' : ''}`,
]);

// ── Laporan PnL & AI ──
sub(D, "'UT Bot Sell'", "'SATS Flip Sell'");
sub(D, 'mengevaluasi UTBot signal', 'mengevaluasi sinyal SATS');
sub(D, '📡 UT Bot Signal', '📡 Level Sinyal (SL / TP)');
sub(D, 'SL (Trail): <span', 'SL: <span');

// ── Halaman Config: baca ──
line(D, 'const utbot', [
  'const sats = cfg.screening?.sats || {}, satsCustom = sats.custom || {}, satsF = sats.filters || {};',
  `const presetOpt = p => '<option value="' + p + '"' + ((sats.preset || 'default') === p ? ' selected' : '') + '>' + p + '</option>';`,
]);
line(D, 'id="cfg-vol"', []);
line(D, 'id="cfg-utbot-key"', []);
line(D, 'id="cfg-utbot-atr"', []);
line(D, 'id="cfg-utbot-interval"', []);
line(D, 'cfg-section">🧠 AI Filter', [
  '<div class="cfg-section">📡 Self-Aware Trend System (4H)</div>',
  `<div class="field"><label>Preset</label><select id="cfg-sats-preset">\${['default','crypto','swing','scalping','custom'].map(presetOpt).join('')}</select></div>`,
  `<div class="field"><label>Interval Scan (menit)</label><input id="cfg-sats-interval" type="number" value="\${sats.checkIntervalMin||240}"></div>`,
  `<div class="field"><label>Min Volume 24h (USD)</label><input id="cfg-vol" type="number" value="\${sats.minVolume24h||3000000}"></div>`,
  `<div class="field"><label>Maks Sinyal BUY / Scan</label><input id="cfg-sats-max" type="number" value="\${sats.maxSignalsPerRun||5}"></div>`,
  `<div class="field"><label>Custom: ATR Length</label><input id="cfg-sats-atr" type="number" value="\${satsCustom.atrLen ?? 14}"></div>`,
  `<div class="field"><label>Custom: Base Mult (×ATR)</label><input id="cfg-sats-mult" type="number" step="0.1" value="\${satsCustom.baseMult ?? 2}"></div>`,
  `<div class="field"><label>Custom: ER Length</label><input id="cfg-sats-er" type="number" value="\${satsCustom.erLen ?? 20}"></div>`,
  `<div class="field"><label>Custom: SL Mult (×ATR)</label><input id="cfg-sats-slmult" type="number" step="0.1" value="\${satsCustom.slMult ?? 1.5}"></div>`,
  `<div class="field"><label>Filter: Min TQI (0 = off)</label><input id="cfg-sats-mintqi" type="number" step="0.05" min="0" max="1" value="\${satsF.minTqi ?? 0}"></div>`,
  `<div class="field"><label>Filter: Close &gt; EMA (4H)</label><select id="cfg-sats-ema-on"><option value="false" \${satsF.ema?.enabled ? '' : 'selected'}>Nonaktif</option><option value="true" \${satsF.ema?.enabled ? 'selected' : ''}>Aktif</option></select></div>`,
  `<div class="field"><label>EMA Period</label><input id="cfg-sats-ema-period" type="number" value="\${satsF.ema?.period ?? 50}"></div>`,
  `<div class="field"><label>Filter: Batas Risiko SL</label><select id="cfg-sats-risk-on"><option value="false" \${satsF.maxRisk?.enabled ? '' : 'selected'}>Nonaktif</option><option value="true" \${satsF.maxRisk?.enabled ? 'selected' : ''}>Aktif</option></select></div>`,
  `<div class="field"><label>Maks Risiko SL (%)</label><input id="cfg-sats-risk-pct" type="number" step="0.5" value="\${satsF.maxRisk?.maxPct ?? 10}"></div>`,
  '<div style="grid-column:1/-1;font-size:11px;color:var(--muted);line-height:1.6">Field "Custom" hanya dipakai bila preset = custom. Preset/filter berlaku di scan berikutnya; perubahan interval scan butuh restart bot.</div>',
  '$LINE',
]);

// ── Halaman Config: simpan ──
line(D, 'utbot: {', 'sats: {');
line(D, "getElementById('cfg-utbot-key')", [
  "preset:           document.getElementById('cfg-sats-preset').value,",
  'custom: {',
  "  atrLen:   parseInt(document.getElementById('cfg-sats-atr').value),",
  "  baseMult: parseFloat(document.getElementById('cfg-sats-mult').value),",
  "  erLen:    parseInt(document.getElementById('cfg-sats-er').value),",
  "  slMult:   parseFloat(document.getElementById('cfg-sats-slmult').value),",
  '},',
  "maxSignalsPerRun: parseInt(document.getElementById('cfg-sats-max').value) || 5,",
  'filters: {',
  "  minTqi:  parseFloat(document.getElementById('cfg-sats-mintqi').value) || 0,",
  "  ema:     { enabled: document.getElementById('cfg-sats-ema-on').value === 'true', period: parseInt(document.getElementById('cfg-sats-ema-period').value) || 50 },",
  "  maxRisk: { enabled: document.getElementById('cfg-sats-risk-on').value === 'true', maxPct: parseFloat(document.getElementById('cfg-sats-risk-pct').value) || 10 },",
  '},',
]);
line(D, "getElementById('cfg-utbot-atr')", []);
line(D, "getElementById('cfg-utbot-interval')", "checkIntervalMin: parseInt(document.getElementById('cfg-sats-interval').value),");

// ═════════════════════════════ index.js ═════════════════════════════
line(I, "from './screenerUTBot.js'", "import { runSATSScreener } from './screenerSATS.js';");
sub(I, 'runUTBotScreener(tickers)', 'runSATSScreener(tickers)');
sub(I, 'Menjalankan UT Bot Alert Screener (4H)', 'Menjalankan SATS Screener (4H)');
sub(I, 'config.screening?.utbot?.checkIntervalMin', 'config.screening?.sats?.checkIntervalMin');
sub(I, 'config.screening?.utbot?.offsetMin', 'config.screening?.sats?.offsetMin');
sub(I, 'cfg.screening?.utbot?.checkIntervalMin', 'cfg.screening?.sats?.checkIntervalMin');
line(I, 'UTBot key', "log('startup', `  SATS preset  : ${cfg.screening?.sats?.preset ?? 'default'}`);");
line(I, 'UTBot ATR', []);

// ═════════════════════════════ ENGINE ═════════════════════════════
const files = {};
for (const f of [D, A, I]) {
  if (!fs.existsSync(f)) { console.error(`❌ ${f} tidak ditemukan. Jalankan dari root repo.`); process.exit(1); }
  files[f] = fs.readFileSync(f, 'utf8');
}

const errors = [];
edits.forEach((e, n) => {
  let txt = files[e.file];
  if (e.kind === 'sub') {
    const count = txt.split(e.match).length - 1;
    if (count !== 1) { errors.push(`#${n + 1} ${e.file}: "${e.match.slice(0, 50)}" ditemukan ${count}x (harus 1x)`); return; }
    files[e.file] = txt.replace(e.match, () => e.to);
  } else {
    const eol   = txt.includes('\r\n') ? '\r\n' : '\n';
    const lines = txt.split(eol);
    const hits  = lines.reduce((a, l, i) => (l.includes(e.match) ? [...a, i] : a), []);
    if (hits.length !== 1) { errors.push(`#${n + 1} ${e.file}: baris "${e.match.slice(0, 50)}" ditemukan ${hits.length}x (harus 1x)`); return; }
    const i = hits[0], indent = lines[i].match(/^\s*/)[0];
    const out = (Array.isArray(e.to) ? e.to : [e.to]).map(t => (t === '$LINE' ? lines[i] : indent + t));
    lines.splice(i, 1, ...out);
    files[e.file] = lines.join(eol);
  }
});


// ── Migrasi user-config.json ──
const C = 'user-config.json';
let newConfig = null;
if (!fs.existsSync(C)) {
  errors.push(`${C} tidak ditemukan`);
} else {
  try {
    const cfg = JSON.parse(fs.readFileSync(C, 'utf8'));
    const old = cfg.screening?.utbot ?? {};
    if (cfg.screening?.sats) {
      errors.push(`${C}: screening.sats sudah ada (sudah termigrasi?)`);
    } else {
      cfg.screening = cfg.screening ?? {};
      cfg.screening.sats = {
        enabled: true,
        preset: 'default',
        checkIntervalMin: old.checkIntervalMin ?? 240,
        offsetMin: old.offsetMin ?? 1,
        minVolume24h: old.minVolume24h ?? cfg.screening.minVolume24h ?? 3000000,
        maxSignalsPerRun: old.maxSignalsPerRun ?? 5,
        candleLimit: 300,
        tpR: [1, 2, 3],
        custom: { atrLen: 14, baseMult: 2.0, erLen: 20, slMult: 1.5 },
        advanced: {},
        filters: { minTqi: 0, ema: { enabled: false, period: 50 }, maxRisk: { enabled: false, maxPct: 10 } },
      };
      delete cfg.screening.utbot;
      newConfig = JSON.stringify(cfg, null, 2) + '\n';
    }
  } catch (e) { errors.push(`${C}: ${e.message}`); }
}

if (errors.length) {
  console.error('❌ Patch dibatalkan, TIDAK ada file yang diubah:\n  ' + errors.join('\n  '));
  console.error('\nKemungkinan file sudah pernah di-patch atau berbeda dari versi yang saya baca.');
  process.exit(1);
}

for (const f of [D, A, I]) {
  if (!fs.existsSync(f + '.bak')) fs.copyFileSync(f, f + '.bak');
  fs.writeFileSync(f, files[f]);
}
if (!fs.existsSync(C + '.bak')) fs.copyFileSync(C, C + '.bak');
fs.writeFileSync(C, newConfig);
console.log(`✅ ${edits.length} perubahan + migrasi config diterapkan ke ${I}, ${A}, ${D}, ${C} (cadangan: *.bak).`);
console.log('   Restart bot lalu refresh dashboard.');
