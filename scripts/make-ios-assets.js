// iPhoneアプリの起動画面の画像を作る（実行：npm run ios:assets）
// アプリのアイコン（1024px・透明部分なしのRGB PNG）は ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png に置いてあり、
// これを元に、起動画面（アプリの背景色の真ん中に、角を丸めたアイコンを小さく）を作る
// ※ アイコンを変えるときは、そのファイルを差し替えてから実行する（ウェブ版のアイコンは icons/ の 180・192・512px）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ASSETS = path.join(__dirname, '..', 'ios', 'App', 'App', 'Assets.xcassets');
const INK = '#10131A';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  const iconPath = path.join(ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png');
  const iconUrl = 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64');

  // 起動画面：アプリの背景色に、角を丸めたアイコンを真ん中に小さく（起動画面は透明部分の制限がないのでそのままPNGに）
  const SPLASH = 2732, LOGO_W = 520;
  const png = await page.evaluate(async ({ iconUrl, SPLASH, LOGO_W, INK }) => {
    const img = new Image(); img.src = iconUrl; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = SPLASH;
    const g = c.getContext('2d');
    g.fillStyle = INK; g.fillRect(0, 0, SPLASH, SPLASH);
    const x = (SPLASH - LOGO_W) / 2;
    g.save(); g.beginPath(); g.roundRect(x, x, LOGO_W, LOGO_W, LOGO_W * 0.22); g.clip();
    g.drawImage(img, x, x, LOGO_W, LOGO_W); g.restore();
    return c.toDataURL('image/png').split(',')[1];
  }, { iconUrl, SPLASH, LOGO_W, INK });
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    fs.writeFileSync(path.join(ASSETS, 'Splash.imageset', name), Buffer.from(png, 'base64'));
  }
  await browser.close();
  console.log('起動画面を書き出しました');
})();
