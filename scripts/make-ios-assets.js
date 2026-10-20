// iPhoneアプリのアイコン（1024px）と起動画面の画像を作る（実行：npm run ios:assets）
// App Store のアイコンは「透明部分なし」が条件なので、背景を塗りつぶしたRGB（アルファなし）のPNGで書き出す
// ロゴは icons/icon-512.png と同じ「Z」の形（3つの三角形）を、大きいサイズで描き直したもの
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');

const ASSETS = path.join(__dirname, '..', 'ios', 'App', 'App', 'Assets.xcassets');
const NAVY = '#2D3066', ORANGE = '#FF5A36', INK = '#10131A';
// icons/icon-512.png の中の四角（80〜432）を基準にした、ロゴの三角形の頂点
const LOGO = [
  [[80, 80], [432, 80], [256, 234]],
  [[256, 234], [229, 256], [282, 256]],
  [[282, 256], [432, 256], [80, 430]],
];

// 色の付いたピクセル列（RGBA）から、アルファなしのPNGを作る
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // フィルターなし
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = y * (width * 3 + 1) + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit・RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ブラウザのキャンバスで描く。as='pixels' ならピクセル（RGBA）、as='png' ならPNG（base64）で受け取る
async function draw(page, size, opts, as = 'pixels') {
  const result = await page.evaluate(({ size, opts, LOGO, as }) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = opts.bg; g.fillRect(0, 0, size, size);
    const { x0, y0, w, rounded } = opts.box; // ロゴの四角（512pxのときの80〜432）を置く場所
    const k = w / 352, map = ([x, y]) => [x0 + (x - 80) * k, y0 + (y - 80) * k];
    if (opts.box.fill) {
      g.fillStyle = opts.box.fill;
      g.beginPath(); g.roundRect(x0, y0, w, w, rounded || 0); g.fill();
    }
    g.fillStyle = opts.fg;
    for (const tri of LOGO) {
      g.beginPath(); tri.map(map).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
    }
    if (as === 'png') return c.toDataURL('image/png').split(',')[1];
    // 大きな配列は文字列（base64）にして受け渡す（数値の配列のままだと遅い）
    const bytes = g.getImageData(0, 0, size, size).data;
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, { size, opts, LOGO, as });
  return Buffer.from(result, 'base64');
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();

  // アプリアイコン：紺色を全面に（角丸はiPhoneが自動で付ける）。ロゴは少し内側に
  const icon = await draw(page, 1024, { bg: NAVY, fg: ORANGE, box: { x0: 152, y0: 152, w: 720 } });
  fs.writeFileSync(path.join(ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), encodePng(1024, 1024, icon));

  // 起動画面：アプリの背景色に、角丸の四角のロゴを真ん中に小さく（起動画面は透明部分の制限がないのでそのままPNGに）
  const SPLASH = 2732, LOGO_W = 520;
  const png = await draw(page, SPLASH, {
    bg: INK, fg: ORANGE, box: { x0: (SPLASH - LOGO_W) / 2, y0: (SPLASH - LOGO_W) / 2, w: LOGO_W, fill: NAVY, rounded: LOGO_W * 0.2 },
  }, 'png');
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    fs.writeFileSync(path.join(ASSETS, 'Splash.imageset', name), png);
  }
  await browser.close();
  console.log('アイコンと起動画面を書き出しました');
})();
