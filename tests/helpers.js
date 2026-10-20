// テスト共通：アプリを配る小さなサーバー、ブラウザの起動、結果の表示
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(__dirname, 'assets') + path.sep;
const OUT = path.join(__dirname, 'output') + path.sep; // スクリーンショット（git管理外）
const PORT = Number(process.env.PORT) || 8139;
const ORIGIN = `http://localhost:${PORT}`;
const APP_URL = `${ORIGIN}/index.html`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.mp4': 'video/mp4' };

// リポジトリ直下のファイルだけを返す静的サーバー（キャッシュなし）
function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
    const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => resolve(server));
  });
}

// テストのページは、本物のSupabaseにつながない（つなぐと、テストのたびに本番にアカウントができてしまう）
// サーバーを使うテストは、ページ側で window.ZONENOW_CONFIG を上書きする
const NO_CLOUD = () => { window.ZONENOW_CONFIG = Object.assign({ supabaseUrl: '', supabaseAnonKey: '' }, window.ZONENOW_CONFIG); };

// CHROMIUM_PATH を指定すると、そのブラウザで動かす（Playwright付属のものが無い環境向け）
async function launchBrowser(extraArgs = []) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', ...extraArgs],
  });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(NO_CLOUD);
    return context;
  };
  browser.newPage = async (...args) => {
    const context = await browser.newContext(...args);
    const page = await context.newPage();
    page.close = (orig => async (...a) => { await orig.apply(page, a); await context.close(); })(page.close);
    return page;
  };
  return browser;
}

function createChecker() {
  const results = [];
  const state = { section: '' };
  const check = (name, cond, detail = '') => results.push({ ok: !!cond, name: `[${state.section}] ${name}`, detail: String(detail) });
  // 結果を表示し、1つでも失敗があれば終了コード1にする
  const report = () => {
    const failed = results.filter(r => !r.ok);
    results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${!r.ok && r.detail ? '  →  ' + r.detail : ''}`));
    console.log(`\n${results.length - failed.length}/${results.length} PASS`);
    process.exitCode = failed.length ? 1 : 0;
  };
  return { check, state, report };
}

fs.mkdirSync(OUT, { recursive: true });

module.exports = { ASSETS, OUT, ORIGIN, APP_URL, startServer, launchBrowser, createChecker };
