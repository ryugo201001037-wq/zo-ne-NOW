// AIコーチのテスト（実行：npm test）
// ・AIなし ・AIあり（プレビューの sample 機能を模擬） ・AIサーバー（server/ の本物のコードを、にせのClaudeで動かす）
const { ASSETS, OUT, ORIGIN, APP_URL, startServer, launchBrowser, createChecker } = require('./helpers');
const { check, state, report } = createChecker();

async function setup(browser, withAi, aiServerUrl = null) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(([withAi, aiServerUrl]) => {
    window.confirm = () => false;
    if (aiServerUrl) window.ZONENOW_CONFIG = Object.assign(window.ZONENOW_CONFIG || {}, { aiServerUrl });
    localStorage.setItem('zonenow_profile', JSON.stringify({ name: 'テスト花子', grade: 'junior2', createdAt: 1 }));
    const day = n => { const d = new Date(); const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    if (!localStorage.getItem('zonenow_study_log')) {
      localStorage.setItem('zonenow_study_log', JSON.stringify([
        { id: 'a', subject: 'math', seconds: 3600, date: day(0), source: 'manual', createdAt: 1 },
        { id: 'b', subject: 'math', seconds: 1800, date: day(1), source: 'manual', createdAt: 2 },
        { id: 'c', subject: 'english', seconds: 1500, date: day(2), source: 'manual', createdAt: 3 },
        { id: 'd', subject: 'japanese', seconds: 600, date: day(9), source: 'manual', createdAt: 4 },
      ]));
    }
    if (withAi) {
      // プレビュー(claude.ai)の sample 機能の代わり。受け取った内容を記録し、少しずつ返す
      window.__aiCalls = [];
      window.__aiMode = 'ok';
      const sample = (input, opts = {}) => new Promise((resolve, reject) => {
        window.__aiCalls.push({ input, opts: { cache: opts.cache, images: opts.images ? opts.images.map(b => b.type + ':' + b.size) : null } });
        if (window.__aiMode === 'not_granted') { setTimeout(() => reject({ code: 'not_granted', message: 'x' }), 50); return; }
        const answer = 'いい質問だね。\n考え方：まず式を整理しよう。\nヒント：両辺に同じ数をかけてみて。';
        let i = 0;
        const timer = setInterval(() => {
          if (opts.signal && opts.signal.aborted) { clearInterval(timer); reject({ code: 'cancelled', message: 'x', text: answer.slice(0, i) }); return; }
          i = Math.min(answer.length, i + 6);
          opts.onText && opts.onText({ text: answer.slice(0, i), delta: '' });
          if (i >= answer.length) { clearInterval(timer); resolve({ text: answer, truncated: false, modelTierApplied: 'default' }); }
        }, window.__aiSlow ? 300 : 20);
      });
      sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png'] } });
      window.claude = { use: async name => (name === 'sample' ? sample : null) };
    }
  }, [withAi, aiServerUrl]);
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return { context, page, errors };
}

// server/ の本物の処理を、にせのClaudeにつないでローカルで動かす（APIの料金はかからない）
async function startAiServer() {
  const http = require('http');
  const { createHandler } = await import('../server/src/handler.js');
  const ai = { requests: [], calls: [], nextStop: 'end_turn' };
  const client = {
    messages: {
      stream(params) {
        ai.calls.push(params);
        const stop = ai.nextStop; ai.nextStop = 'end_turn';
        const listeners = [];
        const final = new Promise(resolve => setTimeout(async () => {
          for (const c of ['ポイント：', '移項する。', '答え：x=3']) { listeners.forEach(fn => fn(c)); await new Promise(r => setTimeout(r, 20)); }
          resolve({ stop_reason: stop, content: [] });
        }, 20));
        return { on(name, fn) { if (name === 'text') listeners.push(fn); return this; }, finalMessage: () => final, abort() {} };
      },
    },
  };
  const store = new Map();
  const env = { ALLOWED_ORIGINS: ORIGIN, DAILY_LIMIT: '3', USAGE: { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } } };
  const handle = createHandler({ makeClient: () => client });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && body.length) ai.requests.push({ deviceId: req.headers['x-device-id'], body: JSON.parse(body.toString()) });
    const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? body : undefined });
    const response = await handle(request, env, { waitUntil() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const c of response.body) res.write(c);
    res.end();
  });
  await new Promise(r => server.listen(0, r));
  ai.url = `http://localhost:${server.address().port}`;
  ai.close = () => { server.closeAllConnections(); server.close(); };
  return ai;
}

(async () => {
  const server = await startServer();
  const browser = await launchBrowser();

  // ========== AIなし ==========
  state.section = 'AIなし';
  {
    const { page, errors } = await setup(browser, false);
    const active = () => page.$eval('.screen.active', el => el.id);
    await page.click('.screen.active [data-nav="ai"]');
    await page.waitForTimeout(200);
    check('AIタブが開く', (await active()) === 'ai-screen');
    check('状態表示が「オフ」', (await page.textContent('#ai-status')).includes('オフ'));
    check('あいさつに名前', (await page.textContent('#ai-messages')).includes('テスト花子さん'));
    check('AIオフでは写真ボタンを出さない', await page.$eval('#ai-photo', b => b.hidden));
    await page.click('[data-ai-suggest="今日の勉強プランを作って"]');
    const planText = await page.textContent('#ai-messages');
    const firstSubj = await page.$eval('.ai-plan [data-ai-action]', b => b.dataset.subject);
    check('プランが出る（60分＝2コマ）', (await page.$$('.ai-plan-row')).length === 2);
    check('今週0分の教科が優先される', ['science', 'social', 'japanese'].includes(firstSubj), firstSubj);
    check('数学（今週多い）は1コマ目にならない', firstSubj !== 'math');
    await page.click('.ai-plan .chip[data-plan-minutes="120"]');
    check('時間を変えると作り直す（120分＝4コマ）', (await page.$$('.ai-plan-row')).length === 4);
    await page.screenshot({ path: OUT + 'ai-plan.png' });
    await page.click('.ai-plan [data-ai-action]');
    await page.waitForTimeout(200);
    check('プランからタイマー開始', (await active()) === 'record-screen' && (await page.textContent('#timer-toggle')) === '一時停止' && (await page.textContent('#timer-subject-chips .chip.active')) === '国語', await page.textContent('#timer-subject-chips .chip.active'));
    await page.click('#timer-discard'); await page.click('#confirm-ok');
    await page.click('.screen.active [data-nav="ai"]');
    await page.click('[data-ai-suggest="1週間の勉強を振り返って"]');
    const review = await page.$eval('.ai-msg.coach:last-child .ai-bubble', e => e.textContent);
    check('振り返り：直近7日の合計', review.includes('直近7日間の勉強時間：1時間55分'), review.split('\n')[0]);
    check('振り返り：前の週との比較', review.includes('前の7日間より +1時間45分'));
    check('振り返り：連続日数', review.includes('3日連続'));
    check('振り返り：多い教科', review.includes('数学（1時間30分）'));
    await page.screenshot({ path: OUT + 'ai-review.png' });
    await page.fill('#ai-input', '二次方程式の解き方を教えて');
    await page.press('#ai-input', 'Enter');
    const last = await page.$eval('.ai-msg.coach:last-child .ai-bubble', e => e.textContent);
    check('AIが無いときは正直に伝える（作り話をしない）', last.includes('問題の解説はAIが答えるんだけど、この環境ではまだ使えない'));
    await page.click('[data-ai-suggest="やる気が出ない…"]');
    check('やる気相談はアプリ内の言葉＋5分タイマー', !!(await page.$('.ai-msg.coach:last-child [data-ai-action="start-timer"]')));
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
    await page.click('.screen.active [data-nav="ai"]');
    check('会話がリロード後も残る', (await page.$$('.ai-msg.user')).length === 4);
    await page.click('#ai-clear'); await page.click('#confirm-ok');
    check('会話をリセットできる', (await page.$$('.ai-msg')).length === 1);
    check('エラーなし', errors.length === 0, errors.join(' / '));
  }

  // ========== AIあり（模擬） ==========
  state.section = 'AIあり';
  {
    const { page, errors } = await setup(browser, true);
    await page.click('.screen.active [data-nav="ai"]');
    await page.waitForTimeout(300);
    check('状態表示が「オン」', (await page.textContent('#ai-status')).includes('オン'));
    await page.fill('#ai-input', '一次方程式がわからない');
    await page.click('#ai-send');
    await page.waitForTimeout(600);
    const reply = await page.$eval('.ai-msg.coach:last-child .ai-bubble', e => e.textContent);
    check('AIの答えが表示される', reply.includes('ヒント：両辺に同じ数'), reply);
    const call = await page.evaluate(() => window.__aiCalls[0]);
    const first = call.input[0].content;
    check('最初に指示とルールを渡す', first.includes('ゾーンNOW') && first.includes('わからない問題をわかりやすく解説') && first.includes('ポイント（何を使う問題か）→ 解き方') && first.includes('問題：'));
    check('学年を渡す', first.includes('中学2年'));
    check('学習記録を渡す', first.includes('直近7日間：1時間55分') && first.includes('数学 1時間30分'));
    check('最後が今の質問', call.input[call.input.length - 1].content === '一次方程式がわからない' && call.input[call.input.length - 1].role === 'user');
    check('チャットはキャッシュしない', call.opts.cache === false);
    await page.fill('#ai-input', 'もう少し詳しく'); await page.click('#ai-send');
    await page.waitForTimeout(600);
    const call2 = await page.evaluate(() => window.__aiCalls[1].input.map(t => t.role));
    check('前の会話も渡す（文脈）', call2.join(',') === 'user,user,assistant,user', call2);
    check('解説の後は「続き」のチップが出る', (await page.textContent('#ai-suggestions')).includes('もっとくわしく') && (await page.textContent('#ai-suggestions')).includes('似た問題を出して'));
    await page.fill('#ai-input', 'この問題、何から手をつければいい？'); await page.click('#ai-send');
    await page.waitForTimeout(600);
    check('問題の質問を「勉強プラン」と取り違えない', !(await page.$('.ai-msg.coach:last-child .ai-plan')) && (await page.evaluate(() => window.__aiCalls.length)) === 3);
    // 写真で質問
    check('写真ボタンが出る', !(await page.$eval('#ai-photo', b => b.hidden)));
    await page.setInputFiles('#ai-photo-input', ASSETS + 'p1.png');
    await page.waitForTimeout(300);
    check('選んだ写真のプレビュー', !(await page.$eval('#ai-attach', el => el.hidden)));
    await page.click('#ai-send');
    await page.waitForTimeout(700);
    const pc = await page.evaluate(() => window.__aiCalls[window.__aiCalls.length - 1]);
    check('写真がAIに届く（JPEG）', pc.opts.images && pc.opts.images.length === 1 && pc.opts.images[0].startsWith('image/jpeg'), JSON.stringify(pc.opts.images));
    check('文字なしでも「解説して」と送る', pc.input[pc.input.length - 1].content.startsWith('この問題がわからない。解説して'));
    check('送った写真が会話に表示', !!(await page.$('.ai-msg.user:last-of-type .ai-bubble-img')) || (await page.$$('.ai-bubble-img')).length === 1);
    check('送信後はプレビューが消える', await page.$eval('#ai-attach', el => el.hidden));
    await page.screenshot({ path: OUT + 'ai-photo.png' });
    await page.click('[data-ai-suggest^="もっとくわしく"]');
    await page.waitForTimeout(700);
    const fc = await page.evaluate(() => window.__aiCalls[window.__aiCalls.length - 1]);
    check('続きの質問では写真を再送しない（料金の節約）', fc.opts.images === null);
    check('続きの質問でも写真つきだったことは伝わる', fc.input.some(t => t.content.includes('（写真つき）')));
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
    await page.click('.screen.active [data-nav="ai"]');
    check('写真の縮小版はリロード後も残る', (await page.$$('.ai-bubble-img')).length === 1);
    await page.screenshot({ path: OUT + 'ai-chat.png' });
    // 停止
    await page.evaluate(() => { window.__aiSlow = true; });
    await page.fill('#ai-input', '長い説明をして'); await page.click('#ai-send');
    await page.waitForTimeout(700);
    check('回答中は「停止」ボタン', (await page.textContent('#ai-send')) === '停止');
    await page.click('#ai-send');
    await page.waitForTimeout(400);
    check('停止できる（途中までは残る）', (await page.$eval('.ai-msg.coach:last-child .ai-bubble', e => e.textContent)).includes('（停止しました）'));
    check('停止後は「送信」に戻る', (await page.textContent('#ai-send')) === '送信');
    // プランはAIを使わない
    const before = await page.evaluate(() => window.__aiCalls.length);
    await page.click('[data-ai-suggest="今日の勉強プランを作って"]');
    check('プランはAIの利用枠を使わない', (await page.evaluate(() => window.__aiCalls.length)) === before);
    // 許可されなかった場合
    await page.evaluate(() => { window.__aiMode = 'not_granted'; window.__aiSlow = false; });
    await page.fill('#ai-input', '質問'); await page.click('#ai-send');
    await page.waitForTimeout(400);
    check('許可されないとオフに切り替え・説明', (await page.textContent('#ai-status')).includes('オフ') && (await page.$eval('.ai-msg.coach:last-child .ai-bubble', e => e.textContent)).includes('許可されていない'));
    check('エラーなし', errors.length === 0, errors.join(' / '));
  }

  // ========== AIサーバー（本番の形） ==========
  state.section = 'AIサーバー';
  {
    const ai = await startAiServer();
    const { page, errors } = await setup(browser, false, ai.url);
    const status = () => page.textContent('#ai-status');
    const lastCoach = () => page.$eval('.ai-msg.coach:last-child .ai-bubble', e => e.textContent);
    await page.click('.screen.active [data-nav="ai"]');
    await page.waitForTimeout(200);
    check('サーバーがあればAIはオン', (await status()).includes('オン'));
    check('写真ボタンが出る', !(await page.$eval('#ai-photo', b => b.hidden)));
    await page.fill('#ai-input', 'x+2=5を解いて');
    await page.click('#ai-send');
    await page.waitForFunction(() => !document.querySelector('.ai-msg.coach:last-child .ai-bubble.thinking') && document.getElementById('ai-send').textContent === '送信');
    check('サーバーの解説が表示される', (await lastCoach()) === 'ポイント：移項する。答え：x=3', await lastCoach());
    const req = ai.requests[0];
    check('学年と学習記録を送る', req.body.gradeLabel === '中学2年' && req.body.studySummary.includes('直近7日間：1時間55分'), JSON.stringify(req.body).slice(0, 200));
    check('指示はアプリから送らない（サーバーが持つ）', !JSON.stringify(req.body).includes('AIコーチです') && ai.calls[0].system.includes('AIコーチです'));
    check('端末IDを送る', /^[A-Za-z0-9-]{16,64}$/.test(req.deviceId), req.deviceId);
    check('残り回数を表示', (await status()).includes('今日あと2回'), await status());
    check('解説の後は続きのチップ', (await page.textContent('#ai-suggestions')).includes('もっとくわしく'));
    await page.setInputFiles('#ai-photo-input', ASSETS + 'p1.png');
    await page.waitForTimeout(300);
    await page.click('#ai-send');
    await page.waitForFunction(() => document.getElementById('ai-send').textContent === '送信' && !document.querySelector('.ai-bubble.thinking'));
    const img = ai.calls[1].messages.at(-1).content;
    check('写真がサーバー経由でAIに届く', Array.isArray(img) && img[0].type === 'image' && img[0].source.media_type === 'image/jpeg' && img[0].source.data.length > 100, JSON.stringify(img).slice(0, 120));
    check('前の会話も送る', ai.calls[1].messages.length === 3 && ai.calls[1].messages[1].role === 'assistant');
    ai.nextStop = 'refusal';
    await page.fill('#ai-input', '危ない質問'); await page.click('#ai-send');
    await page.waitForFunction(() => document.getElementById('ai-send').textContent === '送信' && !document.querySelector('.ai-bubble.thinking'));
    check('断られたら途中の文は消して説明', (await lastCoach()).startsWith('ごめんね、その内容には答えられない'), await lastCoach());
    check('上限まで使うと「使い切り」と表示', (await status()).includes('使い切りました'), await status());
    await page.fill('#ai-input', 'もう1問'); await page.click('#ai-send');
    await page.waitForFunction(() => document.getElementById('ai-send').textContent === '送信' && !document.querySelector('.ai-bubble.thinking'));
    check('上限を超えると「また明日」', (await lastCoach()).includes('今日の質問はここまで（1日3回）'), await lastCoach());
    check('上限を超えた分はAIを呼ばない', ai.calls.length === 3);
    ai.close();
    await page.waitForTimeout(100);
    await page.fill('#ai-input', 'つながる？'); await page.click('#ai-send');
    await page.waitForFunction(() => document.getElementById('ai-send').textContent === '送信' && !document.querySelector('.ai-bubble.thinking'));
    check('サーバーに届かないときは「もう一度」', (await lastCoach()).includes('うまくつながらなかった'), await lastCoach());
    await page.screenshot({ path: OUT + 'ai-server.png' });
    check('エラーなし', errors.length === 0, errors.join(' / '));
  }

  report();
  await browser.close();
  server.close();
})();
