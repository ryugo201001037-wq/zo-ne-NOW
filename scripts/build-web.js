// アプリに入れるファイルを www/ にまとめる（Capacitor は www/ の中身をiPhoneアプリに入れる）
// 実行：npm run build:web
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');
const FILES = ['index.html', 'manifest.json', 'sw.js', 'icons', 'vendor'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
for (const name of FILES) {
  fs.cpSync(path.join(ROOT, name), path.join(OUT, name), { recursive: true });
}
console.log(`www/ にコピーしました：${FILES.join(', ')}`);
