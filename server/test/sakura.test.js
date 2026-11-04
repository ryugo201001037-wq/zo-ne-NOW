// さくらのAI Engine につなぐ部分のテスト。本物のAPIは呼ばず、OpenAIと同じ形で返事をするローカルサーバーで確かめる。実行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../src/handler.js';

const ORIGIN = 'https://zonenow.example';
const DEVICE = 'test-device-0123456789';

function memoryKv() {
  const map = new Map();
  return { map, get: async k => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); } };
}

// にせのさくら：reply(req本文) が返す { status, chunks, finish, body } のとおりに答える。届いた内容を received に残す
async function fakeSakura(reply, handlerOptions = {}) {
  const state = { received: [], closedEarly: false };
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', async () => {
      const body = JSON.parse(data);
      state.received.push({ path: req.url, auth: req.headers.authorization, body });
      const r = reply(body);
      if (r.status && r.status !== 200) { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(r.body || '{"error":"x"}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.on('close', () => { if (!res.writableEnded) state.closedEarly = true; });
      for (const c of r.chunks) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: c, finish_reason: null }] })}\n\n`);
        await new Promise(r2 => setTimeout(r2, r.delay || 1));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: r.finish || 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, r));
  const env = {
    ALLOWED_ORIGINS: ORIGIN, DAILY_LIMIT: '3', USAGE: memoryKv(),
    AI_PROVIDER: 'sakura', SAKURA_API_KEY: 'sakura-test-key', SAKURA_BASE_URL: `http://localhost:${server.address().port}/v1`,
  };
  const waits = [];
  const handle = createHandler(handlerOptions);
  return { state, env, waits, close: () => server.close(), call: req => handle(req, env, { waitUntil: p => waits.push(p) }) };
}

function ask(body) {
  return new Request('https://ai.example/api/ask', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'X-Device-Id': DEVICE, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const question = (text = 'x+2=5を解いて', extra = {}) => ({ messages: [{ role: 'user', content: text }], gradeLabel: '中学1年', studySummary: '', ...extra });
async function readEvents(res) {
  return (await res.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const used = env => [...env.USAGE.map.values()].map(Number).reduce((a, b) => a + b, 0);
const quiet = async fn => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

test('さくら：解説を少しずつ返し、考え中の内容は見せない', async () => {
  const s = await fakeSakura(() => ({ chunks: [{ reasoning_content: '（考え中）' }, { content: 'ポイント：' }, { content: '答え：x=3' }] }));
  try {
    const res = await s.call(ask(question()));
    assert.equal(res.headers.get('X-Remaining'), '2');
    const events = await readEvents(res);
    assert.equal(events.filter(x => x.type === 'delta').map(x => x.text).join(''), 'ポイント：答え：x=3');
    assert.deepEqual(events.at(-1), { type: 'done', truncated: false });
    const r = s.state.received[0];
    assert.equal(r.path, '/v1/chat/completions');
    assert.equal(r.auth, 'Bearer sakura-test-key');
    assert.equal(r.body.model, 'gpt-oss-120b');
    assert.equal(r.body.stream, true);
    assert.equal(r.body.messages[0].role, 'system');
    assert.match(r.body.messages[0].content, /中学1年/);
    assert.deepEqual(r.body.messages[1], { role: 'user', content: 'x+2=5を解いて' });
    assert.equal(used(s.env), 1, '1回と数える');
  } finally { s.close(); }
});

test('さくら：写真は data URL にして今回の質問に付ける', async () => {
  const s = await fakeSakura(() => ({ chunks: [{ content: 'OK' }] }));
  try {
    const body = question('この問題', { image: { mediaType: 'image/jpeg', data: 'aGVsbG8=' } });
    body.messages = [{ role: 'user', content: '前の質問' }, { role: 'assistant', content: '前の答え' }, { role: 'user', content: 'この問題' }];
    await readEvents(await s.call(ask(body)));
    const msgs = s.state.received[0].body.messages;
    assert.equal(s.state.received[0].body.model, 'preview/Kimi-K2.6', '写真付きの質問は、画像を読めるモデルに送る');
    assert.equal(msgs[1].content, '前の質問', '前の質問には付けない');
    assert.deepEqual(msgs[3].content, [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } },
      { type: 'text', text: 'この問題' },
    ]);
  } finally { s.close(); }
});

test('さくら：画像を読めるモデルは設定で変えられる', async () => {
  const s = await fakeSakura(() => ({ chunks: [{ content: 'OK' }] }));
  try {
    s.env.SAKURA_VISION_MODEL = 'preview/Qwen3-VL-30B-A3B-Instruct';
    await readEvents(await s.call(ask(question('この問題', { image: { mediaType: 'image/jpeg', data: 'aGVsbG8=' } }))));
    await readEvents(await s.call(ask(question('続きを教えて'))));
    assert.equal(s.state.received[0].body.model, 'preview/Qwen3-VL-30B-A3B-Instruct');
    assert.equal(s.state.received[1].body.model, 'gpt-oss-120b', '文字だけの質問は gpt-oss のまま');
  } finally { s.close(); }
});

test('さくら：写真を断られたら images_unavailable（回数は数えない）', async () => {
  const s = await fakeSakura(body => (Array.isArray(body.messages.at(-1).content) ? { status: 400, body: '{"error":"image not supported"}' } : { chunks: [{ content: 'OK' }] }));
  try {
    const res = await quiet(() => s.call(ask(question('この問題', { image: { mediaType: 'image/png', data: 'aGVsbG8=' } }))));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'images_unavailable' });
    assert.equal(used(s.env), 0);
  } finally { s.close(); }
});

test('さくら：混んでいるときは busy、その他の失敗は upstream_error（回数は数えない）', async () => {
  const busy = await fakeSakura(() => ({ status: 429 }));
  const broken = await fakeSakura(() => ({ status: 500 }));
  try {
    const r1 = await quiet(() => busy.call(ask(question())));
    assert.equal(r1.status, 503);
    assert.deepEqual(await r1.json(), { error: 'busy' });
    const r2 = await quiet(() => broken.call(ask(question())));
    assert.equal(r2.status, 502);
    assert.deepEqual(await r2.json(), { error: 'upstream_error' });
    assert.equal(used(busy.env) + used(broken.env), 0);
  } finally { busy.close(); broken.close(); }
});

// にせのClaude（さくらが使えないときの代わり）：決めた文字を返す。呼ばれた内容を calls に残す
function fakeClaude(chunks = ['Claudeが答えます']) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(params);
        const listeners = [];
        const final = (async () => {
          await new Promise(r => setTimeout(r, 5));
          for (const c of chunks) listeners.forEach(fn => fn(c));
          return { stop_reason: 'end_turn', content: [] };
        })();
        return { on(name, fn) { if (name === 'text') listeners.push(fn); return this; }, finalMessage: () => final, abort() {} };
      },
    },
  };
}

test('さくら：使えないときは、Claudeのキーがあれば Claude で答える（回数は1回だけ数える）', async () => {
  const claude = fakeClaude();
  const s = await fakeSakura(() => ({ status: 429 }), { makeClient: () => claude });
  try {
    s.env.ANTHROPIC_API_KEY = 'sk-test';
    const events = await quiet(async () => readEvents(await s.call(ask(question('この問題', { image: { mediaType: 'image/jpeg', data: 'aGVsbG8=' } })))));
    assert.equal(events.filter(x => x.type === 'delta').map(x => x.text).join(''), 'Claudeが答えます');
    assert.deepEqual(events.at(-1), { type: 'done', truncated: false });
    assert.equal(claude.calls.length, 1);
    assert.equal(claude.calls[0].messages.at(-1).content[0].type, 'image', '写真も Claude に渡す');
    assert.equal(used(s.env), 1);
  } finally { s.close(); }
});

test('さくら：アプリから直近20件までの会話を受け取れる（会話の流れを覚えておく）', async () => {
  const s = await fakeSakura(() => ({ chunks: [{ content: 'OK' }] }));
  try {
    const body = question();
    body.messages = Array.from({ length: 19 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `会話${i}` }));
    const res = await s.call(ask(body));
    assert.equal(res.status, 200);
    await readEvents(res);
    assert.equal(s.state.received[0].body.messages.length, 20, 'システムの指示＋会話19件');
    body.messages = Array.from({ length: 21 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `会話${i}` }));
    assert.equal((await s.call(ask(body))).status, 400, '21件以上は受け付けない');
  } finally { s.close(); }
});

test('さくら：長くて途中で切れたら truncated、内容で止められたら refused', async () => {
  const long = await fakeSakura(() => ({ chunks: [{ content: 'とちゅう' }], finish: 'length' }));
  const filtered = await fakeSakura(() => ({ chunks: [], finish: 'content_filter' }));
  try {
    assert.deepEqual((await readEvents(await long.call(ask(question())))).at(-1), { type: 'done', truncated: true });
    assert.deepEqual((await readEvents(await filtered.call(ask(question())))).at(-1), { type: 'error', code: 'refused' });
  } finally { long.close(); filtered.close(); }
});

test('さくら：アプリが受け取りをやめたら、さくらへの問い合わせも止める', async () => {
  const s = await fakeSakura(() => ({ chunks: Array.from({ length: 200 }, (_, i) => ({ content: `${i}` })), delay: 5 }));
  try {
    const res = await s.call(ask(question()));
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.all(s.waits);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(s.state.closedEarly, true);
  } finally { s.close(); }
});
