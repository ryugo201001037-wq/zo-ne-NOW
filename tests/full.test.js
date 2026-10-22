// ゾーンNOW 全機能チェック（実行：npm test）
const { ASSETS: A, OUT, ORIGIN, APP_URL, startServer, launchBrowser, createChecker } = require('./helpers');
const { check, state, report } = createChecker();

(async () => {
  const server = await startServer();
  const browser = await launchBrowser(['--autoplay-policy=no-user-gesture-required']);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  // 見本動画（外部のサーバー）は環境によって読めないので、テスト用の短い動画を返す
  const sampleVideo = require('fs').readFileSync(A + 'sample.webm');
  // 本物の配信サーバーと同じく、部分読み込み（Range）に答える（答えないと動画の途中へ移動できない）
  await context.route('**/*.mp4', route => {
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    if (!m) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes' }, body: sampleVideo });
    const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), sampleVideo.length - 1) : sampleVideo.length - 1;
    return route.fulfill({ status: 206, contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${sampleVideo.length}` }, body: sampleVideo.subarray(start, end + 1) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|404|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript(() => { window.confirm = () => false; });
  await page.clock.install({ time: new Date(2026, 9, 15, 19, 0, 0) });

  const active = () => page.$eval('.screen.active', el => el.id);
  const toast = async () => (await page.textContent('#toast').catch(() => '')) || '';
  const shown = sel => page.$eval(sel, el => getComputedStyle(el).display !== 'none').catch(() => false);
  const nav = async n => { await page.click(`.screen.active [data-nav="${n}"]`); await page.waitForTimeout(120); };
  const scrollFeed = async i => { await page.evaluate(i => { const f = document.getElementById('feed'); f.scrollTop = i * f.clientHeight; }, i); await page.waitForTimeout(220); };
  const evalq = (fn, arg) => page.evaluate(fn, arg);

  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  // ===== A. 初回設定 =====
  state.section = '初回設定';
  check('初回は設定画面が出る', (await active()) === 'onboarding-screen');
  await page.click('#onboarding-submit');
  check('名前が空だとエラー', (await toast()).includes('アカウント名'));
  await page.fill('#onboarding-name', 'テスト太郎');
  await page.click('#onboarding-submit');
  check('学年未選択だとエラー', (await toast()).includes('学年'));
  await page.click('#onboarding-grade-chips .chip[data-id="other"]');
  await page.click('#onboarding-submit');
  check('その他で未入力だとエラー', (await toast()).includes('その他'));
  await page.click('#onboarding-grade-chips .chip[data-id="junior2"]');
  await page.click('#onboarding-submit');
  await page.waitForTimeout(300);
  check('完了するとホームへ', (await active()) === 'home-screen');

  // ===== B. ホーム（フィード） =====
  state.section = 'ホーム';
  const ids = await evalq(() => [...document.querySelectorAll('#feed .short-slide')].map(s => s.dataset.id));
  check('動画が並ぶ', ids.length >= 10, ids.length);
  check('同じ動画が連続しない', !ids.some((id, i) => i && ids[i - 1] === id));
  check('通知ベルはホームに無い', (await page.$$('#feed-topbar button')).length === 1);
  const unitInBadges = await evalq(() => [...document.querySelectorAll('#feed .short-slide')].some(sl => {
    const v = VIDEOS.find(x => x.id === sl.dataset.id);
    return v.unit && [...sl.querySelectorAll('.short-top .badge')].some(b => b.textContent === v.unit);
  }));
  check('単元はホームに出ない', !unitInBadges);
  const s0 = '#feed .short-slide:first-child';
  const id0 = await page.$eval(s0, el => el.dataset.id);
  const cnt = role => page.textContent(`${s0} [data-role="${role}"] .action-count`);
  check('作り物の数字が出ていない（最初は全部0）', (await cnt('like')) === '0' && (await cnt('comment')) === '0' && (await cnt('bookmark')) === '0', [await cnt('like'), await cnt('comment'), await cnt('bookmark')]);
  await page.click(`${s0} [data-role="like"]`);
  check('いいねで1になり色が変わる', (await cnt('like')) === '1' && await page.$eval(`${s0} [data-role="like"]`, b => b.classList.contains('active')));
  check('いいねが保存される', (await evalq(() => localStorage.getItem('zonenow_likes'))).includes(id0));
  const dupSynced = await evalq(id => [...document.querySelectorAll('.short-slide')].filter(s => s.dataset.id === id).every(s => s.querySelector('[data-role="like"] .action-count').textContent === '1'), id0);
  check('同じ動画の他のスライドにも反映', dupSynced);
  await page.click(`${s0} [data-role="like"]`);
  check('もう一度押すと0に戻る', (await cnt('like')) === '0');
  await page.click(`${s0} [data-role="like"]`);
  await page.click(`${s0} [data-role="bookmark"]`);
  check('保存で1になりトースト', (await cnt('bookmark')) === '1' && (await toast()).includes('保存しました'));

  // コメント
  await page.click(`${s0} [data-role="comment"]`);
  check('コメント欄が開く', await shown('#comment-sheet'));
  check('最初は「まだコメントはありません」', await shown('#comment-empty') && (await page.textContent('#comment-sheet-title')) === 'コメント 0件');
  await page.click('#comment-send');
  check('空のコメントは送れない', (await toast()).includes('入力'));
  await page.fill('#comment-input', 'わかりやすい！<b>太字</b>');
  await page.click('#comment-send');
  await page.fill('#comment-input', '2つめのコメント');
  await page.press('#comment-input', 'Enter');
  check('コメントが投稿される', (await page.$$('.comment-row')).length === 2 && (await page.textContent('#comment-sheet-title')) === 'コメント 2件');
  check('名前と「たった今」が出る', (await page.textContent('.comment-row .comment-meta')).includes('テスト太郎') && (await page.textContent('.comment-row .comment-meta')).includes('たった今'));
  check('コメントのタグは文字として表示', (await page.textContent('.comment-row .comment-text')).includes('<b>') && !(await page.$('.comment-text b')));
  check('動画のコメント数が実数に', (await cnt('comment')) === '2');
  await page.screenshot({ path: OUT + 'ft-comments.png' });
  await page.click('.comment-row:last-child [data-delete-comment]');
  await page.click('#confirm-ok');
  check('自分のコメントを削除できる', (await page.$$('.comment-row')).length === 1 && (await cnt('comment')) === '1');
  // 名前を変えたあとでも、前に書いたコメントを消せる（前は名前で見分けていたので消せなかった）
  const nameBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('zonenow_profile')).name);
  await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('zonenow_profile')); p.name = '別の名前'; localStorage.setItem('zonenow_profile', JSON.stringify(p)); });
  await page.click('#comment-sheet-close');
  await page.click(`${s0} [data-role="comment"]`);
  check('名前を変えたあとでも、自分のコメントを削除できる', (await page.$$('.comment-row [data-delete-comment]')).length === 1);
  await page.evaluate(n => { const p = JSON.parse(localStorage.getItem('zonenow_profile')); p.name = n; localStorage.setItem('zonenow_profile', JSON.stringify(p)); }, nameBefore);
  await page.click('#comment-sheet-close');
  check('コメント欄を閉じられる', !(await shown('#comment-sheet')));

  // シェア
  await evalq(() => { window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; });
  await page.click(`${s0} [data-role="share"]`);
  check('シェアの選択肢が開く', await shown('#share-sheet') && (await page.$$('.share-option')).length >= 3);
  await page.click('[data-share="copy"]');
  await page.waitForTimeout(150);
  const copied = await evalq(() => navigator.clipboard.readText().catch(() => ''));
  check('リンクをコピーできる', (await toast()).includes('コピー') && copied.endsWith(`?v=${id0}`), copied);
  await page.click(`${s0} [data-role="share"]`);
  await page.click('[data-share="line"]');
  await page.click(`${s0} [data-role="share"]`);
  await page.click('[data-share="x"]');
  const opened = await evalq(() => window.__opened);
  check('LINEで送る', opened.some(u => u.startsWith('https://line.me/R/share?text=') && decodeURIComponent(u).includes(`?v=${id0}`)), opened[0]);
  check('Xでポスト', opened.some(u => u.startsWith('https://twitter.com/intent/tweet') && decodeURIComponent(u).includes(`?v=${id0}`)), opened[1]);
  await page.screenshot({ path: OUT + 'ft-share.png' });

  // 一時停止（2回目のタップ＝ダブルタップを待つので、少しあとで止まる）
  await page.mouse.click(160, 420);
  await page.waitForTimeout(350);
  check('画面タップで一時停止', await page.$eval(s0, el => el.classList.contains('is-paused')));
  await page.waitForTimeout(250); // 一時停止マークが出きるまで
  await page.screenshot({ path: OUT + 'ft-paused.png' });
  check('一時停止マークが出る', await page.$eval(`${s0} .pause-indicator`, el => getComputedStyle(el).opacity === '1'));
  await page.mouse.click(160, 420);
  await page.waitForTimeout(350);
  check('もう一度タップで再生', !(await page.$eval(s0, el => el.classList.contains('is-paused'))));

  // ダブルタップでいいね（一時停止にはならない。もう一度ダブルタップしても取り消さない）
  await page.click(`${s0} [data-role="like"]`); // いったん取り消す
  check('ダブルタップ前はいいねなし', (await cnt('like')) === '0');
  await page.mouse.dblclick(160, 420);
  check('ダブルタップでハートが出る', !!(await page.$(`${s0} .tap-heart`)));
  await page.waitForTimeout(350);
  check('ダブルタップでいいね', (await cnt('like')) === '1' && (await evalq(() => localStorage.getItem('zonenow_likes'))).includes(id0));
  check('ダブルタップでは一時停止しない', !(await page.$eval(s0, el => el.classList.contains('is-paused'))));
  await page.mouse.dblclick(160, 420);
  await page.waitForTimeout(350);
  check('もう一度ダブルタップしても取り消さない', (await cnt('like')) === '1');
  await page.waitForTimeout(500);
  check('ハートは消える', !(await page.$(`${s0} .tap-heart`)));

  // シークバー：ドラッグで好きな位置へ。ドラッグ中は時間を大きく出し、離すと再生に戻る（一時停止にはならない）
  check('動画にシークバーがある', !!(await page.$(`${s0} .seek-bar`)));
  await page.waitForFunction(s => document.querySelector(`${s} video`).duration > 0, s0);
  const bar = await page.$eval(`${s0} .seek-track`, el => { const r = el.getBoundingClientRect(); return { x: r.left, w: r.width, y: r.top + r.height / 2 }; });
  await page.mouse.move(bar.x + bar.w * 0.2, bar.y);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.w * 0.8, bar.y, { steps: 4 });
  const dragging = await page.$eval(s0, el => ({ seeking: el.classList.contains('is-seeking'), t: el.querySelector('video').currentTime, d: el.querySelector('video').duration, label: el.querySelector('.seek-time').textContent, time: getComputedStyle(el.querySelector('.seek-time')).opacity, rail: getComputedStyle(el.querySelector('.action-rail')).pointerEvents }));
  check('ドラッグ中はシーク中の表示', dragging.seeking && dragging.rail === 'none', JSON.stringify(dragging));
  check('ドラッグした位置に動く', Math.abs(dragging.t / dragging.d - 0.8) < 0.05, `${dragging.t} / ${dragging.d}`);
  check('ドラッグ中は時間が出る', /\d:\d\d \/ \d:\d\d/.test(dragging.label), dragging.label);
  await page.mouse.up();
  const afterSeek = await page.$eval(s0, el => ({ seeking: el.classList.contains('is-seeking'), paused: el.classList.contains('is-paused') }));
  check('離すと再生に戻る（一時停止にならない）', !afterSeek.seeking && !afterSeek.paused, JSON.stringify(afterSeek));

  // 再生速度：押すたびに 1x → 1.25x → 1.5x → 2x → 1x。端末に覚える
  const speedSel = `${s0} [data-role="speed"]`;
  check('再生速度ボタンは1xから', (await page.textContent(speedSel)) === '1x');
  await page.click(speedSel);
  const sp = await page.$eval(s0, el => ({ label: el.querySelector('[data-role="speed"]').textContent, rate: el.querySelector('video').playbackRate, saved: localStorage.getItem('zonenow_playback_rate') }));
  check('再生速度を変えられる', sp.label === '1.25x' && sp.rate === 1.25 && sp.saved === '1.25', JSON.stringify(sp));
  check('速度を変えても一時停止にならない', !(await page.$eval(s0, el => el.classList.contains('is-paused'))));
  for (let i = 0; i < 3; i++) await page.click(speedSel);
  check('一周すると1xに戻る', (await page.textContent(speedSel)) === '1x' && (await page.$eval(`${s0} video`, v => v.playbackRate)) === 1);

  // パソコンのキーボード：スペースで一時停止／再生、→で5秒進める
  await page.keyboard.press(' ');
  check('スペースで一時停止', await page.$eval(s0, el => el.classList.contains('is-paused')));
  // テスト動画は約1.8秒でループするので、止めたまま確かめる
  await page.$eval(`${s0} video`, v => { v.currentTime = 0; });
  await page.keyboard.press('ArrowRight');
  check('→で先に進む', (await page.$eval(`${s0} video`, v => v.currentTime)) > 1);
  await page.keyboard.press('ArrowLeft');
  check('←で戻る', (await page.$eval(`${s0} video`, v => v.currentTime)) === 0);
  await page.keyboard.press(' ');
  check('もう一度スペースで再生', !(await page.$eval(s0, el => el.classList.contains('is-paused'))));

  const creator = await page.$eval(`${s0} [data-role="follow"]`, b => b.dataset.followKey).catch(() => null);
  if (creator) {
    await page.click(`${s0} [data-role="follow"]`);
    check('フォローでトースト', (await toast()).includes('フォローしました'));
    check('フォローが保存される', (await evalq(() => localStorage.getItem('zonenow_following'))).includes(creator));
  }
  const muteSel = `${s0} [data-role="mute"]`;
  if (await page.$(muteSel)) {
    const before = await page.innerHTML(muteSel);
    await page.click(muteSel);
    check('ミュートボタンで表示が変わる', (await page.innerHTML(muteSel)) !== before);
    await page.click(muteSel);
  }

  // ===== C. 勉強の催促 =====
  state.section = '勉強の催促';
  for (let i = 1; i <= 14; i++) await scrollFeed(i);
  check('14本目まではまだ出ない', !(await shown('#study-nudge')));
  const media = await evalq(() => {
    const slides = [...document.querySelectorAll('#feed .short-slide')];
    const i = slides.indexOf(currentSlide);
    const hasSrc = s => { const v = s.querySelector('video'); return !!(v && v.getAttribute('src')); };
    const loaded = slides.filter(s => { const v = s.querySelector('video'); return v && v.dataset.loaded; }).length;
    return { i, loaded, nearOk: [i - 1, i, i + 1, i + 2].every(k => !slides[k] || !slides[k].querySelector('video') || hasSrc(slides[k])), farReleased: slides.slice(0, Math.max(0, i - 2)).every(s => !hasSrc(s)) };
  });
  check('次の動画を先読みしている', media.nearOk, JSON.stringify(media));
  check('離れた動画は読み込みを手放す（何本見ても4本まで）', media.loaded <= 4 && media.farReleased, JSON.stringify(media));
  await scrollFeed(3);
  check('戻ると読み込み直して再生する', await evalq(() => { const v = currentSlide.querySelector('video'); return currentSlide === document.querySelectorAll('#feed .short-slide')[3] && currentSlide.classList.contains('is-active') && (!v || !!v.getAttribute('src')); }));
  await scrollFeed(14);
  check('フィードが無限に続く', (await page.$$('#feed .short-slide')).length > ids.length);
  await scrollFeed(15);
  const nudgeTitle = await page.textContent('#nudge-title');
  check('15本見たら催促が出る', await shown('#study-nudge'));
  check('言葉がリストから出る', await evalq(t => STUDY_NUDGE_MESSAGES.some(m => m.title === t), nudgeTitle), nudgeTitle);
  await page.click('#nudge-continue');
  check('「あと少し見る」で閉じる', !(await shown('#study-nudge')));
  for (let i = 16; i <= 30; i++) await scrollFeed(i);
  check('30本目で2回目が出る', await shown('#study-nudge'));
  await page.click('#nudge-start');
  await page.waitForTimeout(200);
  check('「タイマー」で記録画面へ', (await active()) === 'record-screen');
  check('タイマーが動き出す', (await page.textContent('#timer-toggle')) === '一時停止');
  await page.click('#timer-discard'); await page.click('#confirm-ok');

  // ===== D. 検索 =====
  state.section = '検索';
  await nav('home');
  await page.click('#search-open-btn');
  check('検索画面が開く', (await active()) === 'search-screen');
  await page.click('#kind-chips .chip[data-id="trivia"]');
  check('種類で絞れる', (await page.textContent('#result-count')) === '6件の動画', await page.textContent('#result-count'));
  await page.click('#kind-chips .chip[data-id="all"]');
  await page.click('#grade-chips .chip[data-id="junior2"]');
  const gradesShown = await page.$$eval('.result-card .badge', bs => [...new Set(bs.map(b => b.textContent))]);
  check('学年で絞ると全学年向けも含む', gradesShown.includes('全学年') && gradesShown.includes('中学2年') && gradesShown.length === 2, gradesShown);
  await page.click('#subject-chips .chip[data-id="math"]');
  const units = await page.$$eval('#unit-chips .chip', cs => cs.map(c => c.textContent));
  check('教科を選ぶと単元が出る', units.includes('連立方程式'), units);
  await page.click('#unit-chips .chip[data-id="連立方程式"]');
  check('単元で絞れる', (await page.textContent('#result-count')) === '1件の動画');
  await page.click('#grade-chips .chip[data-id="high3"]');
  check('該当なしの表示', await shown('#empty-state'));
  await page.click('#grade-chips .chip[data-id="all"]');
  await page.click('#subject-chips .chip[data-id="all"]');
  await page.click('.result-card[data-id="tr4"]');
  await page.waitForTimeout(300);
  check('選んだ動画がホームの先頭に来る', (await active()) === 'home-screen' && (await page.$eval('#feed .short-slide', s => s.dataset.id)) === 'tr4');

  // ===== E. 投稿 =====
  state.section = '投稿';
  await nav('create');
  await page.click('#post-next');
  check('ファイル未選択はエラー', (await toast()).includes('選択'));
  await page.setInputFiles('#post-file-input', [A + 'p1.png', A + 'sample.webm']);
  check('動画と写真の混在はエラー', (await toast()).includes('別々'));
  await page.setInputFiles('#post-file-input', Array.from({ length: 11 }, (_, i) => A + `many${i + 1}.png`));
  check('11枚以上はエラー', (await toast()).includes('10枚'));
  // 大きいファイルはブラウザの中で作って選ばせる（テスト用の巨大ファイルをリポジトリに置かないため）
  // 中身は空で「大きさ」だけ偽装したファイルを選ばせる（巨大なデータを実際に作らないため）
  const pickBig = (name, type, mb) => evalq(([name, type, mb]) => {
    const file = new File([''], name, { type });
    Object.defineProperty(file, 'size', { value: mb * 1024 * 1024 + 1 });
    const input = document.getElementById('post-file-input');
    Object.defineProperty(input, 'files', { configurable: true, get: () => [file] });
    input.dispatchEvent(new Event('change'));
    delete input.files;
  }, [name, type, mb]);
  await pickBig('big.mp4', 'video/mp4', 600);
  check('600MBを超える動画はエラー', (await toast()).includes('600MBまで') && !(await shown('#post-preview-video')));
  await pickBig('big.png', 'image/png', 10);
  check('10MBを超える写真はエラー', (await toast()).includes('10MBまで'));
  await page.setInputFiles('#post-file-input', A + 'sample.webm');
  await evalq(() => { Object.defineProperty(postPreviewVideo, 'duration', { configurable: true, get: () => 200 }); postPreviewVideo.dispatchEvent(new Event('loadedmetadata')); });
  check('3分を超える動画はエラー', (await toast()).includes('3分まで') && !(await shown('#post-preview-video')));
  await evalq(() => { delete postPreviewVideo.duration; });
  check('選ぶ前に上限が書いてある', (await page.textContent('.post-upload-hint')).includes('動画は3分まで'));
  await page.setInputFiles('#post-file-input', A + 'broken.mp4');
  await page.waitForTimeout(500);
  check('壊れた動画は読み込めないと伝える', (await toast()).includes('読み込めません') && !(await shown('#post-preview-video')), await toast());
  await page.setInputFiles('#post-file-input', A + 'sample.webm');
  await page.waitForTimeout(500);
  check('動画を選べる', await shown('#post-preview-video') && await evalq(() => postVideoReady));
  await page.setInputFiles('#post-file-input', [A + 'p1.png', A + 'p2.png', A + 'p3.png']);
  check('写真3枚を選べる', (await page.$$('#post-preview-images img')).length === 3 && (await page.textContent('#post-preview-count')) === '3枚');
  await page.click('#post-next');
  check('タイトル未入力はエラー', (await toast()).includes('タイトル'));
  await page.fill('#post-title', 'ゾーンNOWテスト投稿');
  await page.click('#post-next');
  check('ターゲット未選択はエラー', (await toast()).includes('ターゲット'));
  await page.click('#post-grade-chips .chip[data-id="junior2"]');
  const kindChips = await page.$$eval('#post-kind-chips .chip', cs => cs.map(c => c.textContent));
  check('種類に「その他」がある', kindChips.includes('その他'), kindChips);
  await page.click('#post-kind-chips .chip[data-id="other"]');
  check('種類その他で入力欄が出る', await shown('#post-kind-chips-other'));
  await page.click('#post-next');
  check('種類その他が空だとエラー', (await toast()).includes('種類の「その他」'));
  await page.fill('#post-kind-chips-other', '体験談');
  await page.click('#post-subject-chips .chip[data-id="other"]');
  await page.click('#post-next');
  check('教科その他が空だとエラー', (await toast()).includes('その他'));
  await page.fill('#post-subject-chips-other', '情報');
  await page.fill('#post-unit', 'プログラミング');
  check('#入力欄は最初は閉じている', !(await shown('#post-tag-row')));
  await page.click('#post-tag-open');
  check('#ボタンで入力欄が開く', await shown('#post-tag-row'));
  await page.fill('#post-tag-input', '#勉強垢 ＃情報 プログラミング');
  await page.click('#post-tag-add');
  await page.fill('#post-tag-input', 'テスト対策'); await page.press('#post-tag-input', 'Enter');
  await page.fill('#post-tag-input', '勉強垢'); await page.press('#post-tag-input', 'Enter');
  await page.fill('#post-tag-input', '受験 夜型');
  await page.click('#post-tag-add');
  const tags = await page.$$eval('.tag-chip', e => e.map(x => x.firstChild.textContent));
  check('タグは5個まで・重複なし', tags.length === 5 && new Set(tags).size === 5, tags.join(' '));
  check('#ボタンに個数が出る', (await page.textContent('#post-tag-label')) === 'ハッシュタグ 5/5');
  await page.click('.tag-chip:last-child [data-remove-tag]');
  check('タグを消せる', (await page.$$('.tag-chip')).length === 4);
  await page.click('#post-music-open');
  check('楽曲シートが開く', await shown('#music-sheet'));
  check('楽曲が並ぶ', (await page.$$('.music-row')).length === 5);
  await page.click('[data-preview="night"]');
  check('試聴で音が流れる', (await evalq(() => music.track && music.track.id)) === 'night');
  await page.click('.music-pick[data-pick="focus"]');
  check('選ぶとシートが閉じて試聴が止まる', !(await shown('#music-sheet')) && !(await evalq(() => music.track)));
  check('ボタンに曲名が出る', (await page.textContent('#post-music-label')) === 'Focus Lo-fi');
  check('ボタン名が「次へ」', (await page.textContent('#post-next')) === '次へ');
  await page.click('#post-next');
  await page.waitForTimeout(300);
  check('プレビュー画面へ', (await active()) === 'preview-screen');
  const pv = '#preview-stage .short-slide';
  check('プレビューに写真3枚の横スライド', (await page.$$(`${pv} .photo-page`)).length === 3);
  check('プレビューにタグ', (await page.textContent(`${pv} .caption-hashtags`)).includes('#勉強垢'));
  check('プレビューに種類(体験談)', (await page.textContent(`${pv} .short-top`)).includes('体験談'));
  check('プレビューに楽曲名', (await page.textContent(`${pv} .caption-music`)).includes('Focus Lo-fi'));
  check('プレビューで楽曲が流れる', (await evalq(() => music.track && music.track.id)) === 'focus');
  check('プレビューに単元は出ない', !(await page.textContent(pv)).includes('プログラミング') || (await page.textContent(`${pv} .short-top`)).indexOf('プログラミング') < 0);
  await page.screenshot({ path: OUT + 'ft-preview.png' });
  await page.click('#preview-back');
  await page.waitForTimeout(150);
  check('戻ると入力が残っている', (await active()) === 'create-screen' && (await page.inputValue('#post-title')) === 'ゾーンNOWテスト投稿');
  check('戻ると楽曲が止まる', !(await evalq(() => music.track)));
  await page.click('#post-next');
  await page.waitForTimeout(150);
  const countBefore = await evalq(() => VIDEOS.length);
  await page.click('#preview-post');
  check('「本当に投稿しますか？」が出る', (await page.textContent('#confirm-message')) === '本当に投稿しますか？');
  await page.click('#confirm-cancel');
  check('キャンセルなら投稿されない', (await evalq(() => VIDEOS.length)) === countBefore && (await active()) === 'preview-screen');
  await page.click('#preview-post');
  await page.click('#confirm-ok');
  await page.waitForTimeout(400);
  const first = '#feed .short-slide:first-child';
  check('投稿するとホームの先頭に出る', (await active()) === 'home-screen' && (await page.$eval(first, s => s.dataset.id)).startsWith('u'));
  check('自分の投稿でも楽曲が流れる', (await evalq(() => music.track && music.track.id)) === 'focus');
  await page.waitForTimeout(1500);
  await page.mouse.click(160, 420);
  await page.waitForTimeout(350); // ダブルタップかどうかを待ってから止まる
  const w1 = await page.$eval(`${first} .zone-meter-fill`, e => parseFloat(e.style.width));
  await page.waitForTimeout(1200);
  const w2 = await page.$eval(`${first} .zone-meter-fill`, e => parseFloat(e.style.width));
  check('一時停止でZoneメーターが止まる', w1 > 0 && w1 === w2, `${w1} → ${w2}`);
  check('一時停止で楽曲が止まる', !(await evalq(() => music.track)));
  await page.mouse.click(160, 420);
  await page.waitForTimeout(350);
  check('再生で楽曲が戻る', (await evalq(() => music.track && music.track.id)) === 'focus');
  await page.$eval(`${first} .photo-track`, t => t.scrollTo({ left: t.clientWidth * 2, behavior: 'instant' }));
  await page.waitForTimeout(150);
  check('横スライドで3枚目へ', (await page.textContent(`${first} .photo-count`)) === '3/3');
  check('投稿フォームがリセットされる', await evalq(() => !document.getElementById('post-title').value && !postMusicId && !postHashtags.length));
  await page.click('#search-open-btn');
  await page.click('#subject-chips .chip[data-id="other"]');
  check('投稿した単元で検索できる', (await page.$$eval('#unit-chips .chip', cs => cs.map(c => c.textContent))).includes('プログラミング'));
  await page.click('#search-back');

  // ===== F. 記録 =====
  state.section = '記録';
  await nav('record');
  const timerChips = await page.$$eval('#timer-subject-chips .chip', cs => cs.map(c => c.textContent));
  check('タイマーに「指定なし」が無い', !timerChips.includes('指定なし'), timerChips);
  await page.click('#timer-toggle');
  await page.clock.fastForward('00:30');
  await page.click('#timer-finish');
  check('1分未満は記録しない', (await toast()).includes('1分未満'));
  await page.clock.fastForward('25:00');
  await page.click('#timer-finish');
  check('教科なしでは記録しない', (await toast()).includes('教科を選択'));
  await page.click('#timer-discard');
  check('破棄で確認ダイアログ', await shown('#confirm-dialog'));
  await page.click('#confirm-cancel');
  check('キャンセルなら残る', (await page.textContent('#timer-display')) !== '00:00:00');
  await page.click('#timer-toggle'); // 一時停止
  check('一時停止できる', (await page.textContent('#timer-toggle')) === '再開');
  await page.click('#timer-toggle'); // 再開
  await page.click('#timer-subject-chips .chip[data-id="other"]');
  await page.fill('#timer-subject-chips-other', '情報');
  await page.click('#timer-finish');
  check('その他(情報)で記録できる', (await toast()).includes('を記録しました'), await toast());
  check('記録後タイマーが0に戻る', (await page.textContent('#timer-display')) === '00:00:00');
  await page.click('#manual-add');
  check('手入力：教科なしはエラー', (await toast()).includes('教科'));
  await page.click('#manual-subject-chips .chip[data-id="math"]');
  await page.fill('#manual-minutes', '0'); await page.click('#manual-add');
  check('手入力：0分はエラー', (await toast()).includes('1以上の整数'));
  await page.fill('#manual-minutes', '30'); await page.fill('#manual-date', '2026-10-20'); await page.click('#manual-add');
  check('手入力：未来日はエラー', (await toast()).includes('今日以前'));
  await page.fill('#manual-date', '2026-10-15'); await page.click('#manual-add');
  await page.fill('#manual-minutes', '45'); await page.fill('#manual-date', '2026-10-13'); await page.click('#manual-add');
  await page.fill('#manual-minutes', '60'); await page.fill('#manual-date', '2026-09-20'); await page.click('#manual-add');
  const todayBars = await page.$$eval('#today-bars .record-bar-row .label', e => e.map(x => x.textContent));
  check('下には今日の分だけ出る', todayBars.join(',') === '数学,情報', todayBars);
  check('今日の合計', (await page.textContent('#study-today')) === '55分', await page.textContent('#study-today'));
  check('直近7日の合計', (await page.textContent('#study-week')) === '1時間40分', await page.textContent('#study-week'));
  check('累計', (await page.textContent('#study-total')) === '2時間40分', await page.textContent('#study-total'));
  await page.click('#today-list .study-row-delete');
  await page.click('#confirm-ok');
  check('今日の記録を削除できる', (await page.$$('#today-list .study-row')).length === 1);

  // ===== G. これまでの記録 =====
  state.section = 'カレンダー';
  await page.click('#history-open');
  await page.waitForTimeout(150);
  check('カレンダー画面が開く', (await active()) === 'history-screen' && (await page.textContent('#cal-title')) === '2026年10月');
  check('来月へは進めない', await page.$eval('#cal-next', b => b.disabled));
  check('未来の日は押せない', await page.$eval('.cal-day[data-date="2026-10-16"]', b => b.disabled));
  check('勉強した日に色が付く', await page.$eval('.cal-day[data-date="2026-10-13"]', b => /lv[1-4]/.test(b.className)));
  await page.click('.cal-day[data-date="2026-10-13"]');
  check('日付を押すとその日の教科別', (await page.textContent('#history-day-total')) === '45分' && (await page.textContent('#history-bars')).includes('数学'));
  await page.click('#cal-prev');
  await page.click('.cal-day[data-date="2026-09-20"]');
  check('前の月も見られる', (await page.textContent('#cal-title')) === '2026年9月' && (await page.textContent('#history-day-total')) === '1時間');
  await page.click('#history-list .study-row-delete'); await page.click('#confirm-ok');
  check('カレンダーから削除できる', await shown('#history-empty'));
  await page.click('#record-reset'); await page.click('#confirm-ok');
  check('すべて削除できる', (await evalq(() => JSON.parse(localStorage.getItem('zonenow_study_log') || '[]').length)) === 0);
  await page.click('#history-back');

  // ===== H. プロフィール =====
  state.section = 'プロフィール';
  await nav('profile');
  check('名前と学年', (await page.textContent('#profile-name')) === 'テスト太郎' && (await page.textContent('#profile-grade')) === '中学2年');
  check('フォロー中の数', (await page.textContent('#profile-following-count')) === (creator ? '1' : '0'));
  await page.setInputFiles('#profile-avatar-input', A + 'p3.png');
  await page.waitForTimeout(300);
  check('アイコンを変えられる', !!(await page.$('#profile-avatar img')));
  check('投稿タブに自分の投稿', (await page.textContent('#profile-posts-count')) === '1' && (await page.$$('#profile-grid .card-wrap')).length === 1);
  check('投稿カードに種類が出る', (await page.textContent('#profile-grid .result-meta')).includes('体験談'));
  await page.screenshot({ path: OUT + 'ft-profile-posts.png' });
  await page.click('.profile-tab[data-profile-tab="saved"]');
  const savedIds = await page.$$eval('#profile-grid .result-card', cs => cs.map(c => c.dataset.id));
  check('保存タブに保存した動画', savedIds.length === 1 && savedIds[0] === id0 && (await page.textContent('#profile-saved-count')) === '1', savedIds);
  await page.click('#profile-grid .result-card');
  await page.waitForTimeout(200);
  check('保存した動画をタップで再生', (await active()) === 'home-screen' && (await page.$eval('#feed .short-slide', s => s.dataset.id)) === id0);
  await nav('profile');
  await page.click('#profile-edit');
  await page.click('#onboarding-grade-chips .chip[data-id="other"]');
  await page.fill('#onboarding-grade-chips-other', '浪人生');
  await page.click('#onboarding-submit');
  await page.waitForTimeout(150);
  check('編集して保存できる', (await active()) === 'profile-screen' && (await page.textContent('#profile-grade')) === '浪人生');
  await page.click('[data-people-tab="following"]');
  check('フォロー中の一覧が開く', (await active()) === 'people-screen' && (await page.$$('.people-row')).length === (creator ? 1 : 0));
  if (creator) {
    await page.click('#people-list .people-action'); await page.click('#confirm-ok');
    check('一覧からフォロー解除', (await page.$$('.people-row')).length === 0);
  }
  await page.click('.people-tab[data-tab="followers"]');
  check('フォロワータブ', (await page.textContent('#people-empty-title')).includes('フォロワー'));
  await page.click('.people-tab[data-tab="friends"]');
  check('友達タブ', (await page.textContent('#people-empty-title')).includes('友達'));
  await page.click('#people-back');
  await page.click('#profile-bell');
  check('通知画面が開く', (await active()) === 'notifications-screen');
  await page.click('#notifications-back');
  check('通知から戻れる', (await active()) === 'profile-screen');

  // ===== I. AIタブ =====
  state.section = 'その他画面';
  await nav('ai');
  check('AIタブ（あいさつ表示）', (await page.$$('#ai-messages .ai-msg.coach')).length >= 1);

  // ===== J. 再読み込み後も残るもの =====
  state.section = '保存';
  await nav('record');
  await page.click('#timer-subject-chips .chip[data-id="english"]');
  await page.click('#timer-toggle');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
  check('再読み込みで初回設定は出ない', (await active()) === 'home-screen');
  await nav('record');
  check('タイマーは動き続ける', (await page.textContent('#timer-toggle')) === '一時停止');
  check('タイマーの教科も残る', (await page.textContent('#timer-subject-chips .chip.active')) === '英語');
  await page.clock.fastForward('20:00:00');
  await page.waitForTimeout(200);
  check('長時間でもタイマーは止まらない（上限なし）', (await page.textContent('#timer-toggle')) === '一時停止' && (await page.textContent('#timer-display')).startsWith('20:'));
  await page.click('#timer-finish');
  check('長時間でもそのまま記録できる', (await toast()).includes('20時間'), await toast());
  await nav('profile');
  check('プロフィールとアイコンが残る', (await page.textContent('#profile-grade')) === '浪人生' && !!(await page.$('#profile-avatar img')));
  await page.waitForTimeout(300);
  check('自分の投稿がリロード後も残る', (await evalq(() => VIDEOS.filter(v => v.own).length)) === 1 && (await page.textContent('#profile-posts-count')) === '1');
  await page.click('.profile-tab[data-profile-tab="posts"]');
  check('残った投稿の写真が表示できる', await evalq(() => { const v = VIDEOS.find(x => x.own); return v.images.length === 3 && v.images.every(u => u.startsWith('blob:')); }));
  await page.click('#profile-grid [data-delete-post]');
  check('削除の確認が出る', (await page.textContent('#confirm-message')).includes('削除'));
  await page.click('#confirm-ok');
  await page.waitForTimeout(200);
  check('投稿を削除できる', (await page.textContent('#profile-posts-count')) === '0' && (await shown('#profile-grid-empty')));
  check('削除した投稿はフィードからも消える', await evalq(() => ![...document.querySelectorAll('#feed .short-slide')].some(s => s.dataset.id.startsWith('u'))));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
  check('削除はリロード後もそのまま', (await evalq(() => VIDEOS.filter(v => v.own).length)) === 0);
  await nav('profile');
  check('いいね・保存・コメントがリロード後も残る', await evalq(id => JSON.parse(localStorage.getItem('zonenow_likes')).includes(id) && JSON.parse(localStorage.getItem('zonenow_saves')).includes(id) && JSON.parse(localStorage.getItem('zonenow_comments'))[id].length === 1, id0));
  check('Service Workerが動いている', await evalq(async () => !!(await navigator.serviceWorker.getRegistration())));

  // ===== K. アプリが裏に回ったとき =====
  state.section = 'バックグラウンド';
  await nav('home');
  await page.waitForTimeout(200);
  await evalq(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  check('裏に回ると再生が止まる', await evalq(() => !music.track && (!currentSlide || !currentSlide.classList.contains('is-active'))));
  await evalq(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  check('戻ると再開する', await evalq(() => !!currentSlide && currentSlide.classList.contains('is-active')));

  state.section = '共有リンク';
  await page.goto(APP_URL + '?v=tr2', { waitUntil: 'load' });
  await page.waitForTimeout(400);
  check('共有リンクから開くとその動画が先頭', (await page.$eval('#feed .short-slide', s => s.dataset.id)) === 'tr2');

  state.section = 'エラー';
  check('JavaScriptのエラーが出ていない', errors.length === 0, errors.join(' / '));

  report();
  await browser.close();
  server.close();
})();
