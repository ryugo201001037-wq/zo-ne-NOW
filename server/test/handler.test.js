// AIサーバーのテスト（本物のAPIは呼ばず、にせのClaudeで確かめる）。実行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createHandler } from '../src/handler.js';

const ORIGIN = 'https://zonenow.example';
const DEVICE = 'test-device-0123456789';
const env = () => ({ ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8139`, DAILY_LIMIT: '3', MODEL: 'claude-haiku-5-5', USAGE: memoryKv() });

function memoryKv() {
  const map = new Map();
  return { map, get: async k => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); } };
}

// にせのClaude：決めた文字を少しずつ返す。呼ばれた内容を calls に残す
function fakeClient({ chunks = ['ポイント：', '移項する。', '答え：x=3'], stopReason = 'end_turn', error = null } = {}) {
  const calls = [];
  const client = {
    calls,
    aborted: false,
    messages: {
      stream(params) {
        calls.push(params);
        const listeners = [];
        let rejectFinal;
        const final = new Promise((resolve, reject) => {
          rejectFinal = reject;
          setTimeout(async () => {
            if (error) { reject(error); return; }
            for (const c of chunks) {
              if (client.aborted) { reject(new Anthropic.APIUserAbortError()); return; }
              listeners.forEach(fn => fn(c));
              await new Promise(r => setTimeout(r, 5));
            }
            resolve({ stop_reason: stopReason, content: [] });
          }, 5);
        });
        return {
          on(name, fn) { if (name === 'text') listeners.push(fn); return this; },
          finalMessage: () => final,
          abort() { client.aborted = true; },
        };
      },
    },
  };
  return client;
}

function ask(body, { origin = ORIGIN, device = DEVICE, method = 'POST', path = '/api/ask' } = {}) {
  return new Request(`https://ai.example${path}`, {
    method,
    headers: { Origin: origin, 'X-Device-Id': device, 'Content-Type': 'application/json' },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}
const question = (text = 'x+2=5を解いて', extra = {}) => ({ messages: [{ role: 'user', content: text }], gradeLabel: '中学1年', studySummary: '直近7日間：2時間', ...extra });

async function readEvents(res) {
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function setup(clientOptions, extra = {}) {
  const client = fakeClient(clientOptions);
  const e = env();
  const waits = [];
  const handle = createHandler({ makeClient: () => client, ...extra });
  return { client, e, waits, call: req => handle(req, e, { waitUntil: p => waits.push(p) }) };
}

test('許可していないサイトからは呼べない', async () => {
  const { call } = setup();
  const res = await call(ask(question(), { origin: 'https://evil.example' }));
  assert.equal(res.status, 403);
});

test('事前確認（OPTIONS）に答える', async () => {
  const { call } = setup();
  const res = await call(ask(null, { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-Device-Id/);
});

test('おかしな送り方は受け付けない', async () => {
  const { call, client } = setup();
  assert.equal((await call(ask(question(), { path: '/other' }))).status, 404);
  assert.equal((await call(ask(null, { method: 'GET' }))).status, 405);
  assert.equal((await call(ask(question(), { device: 'short' }))).status, 400);
  assert.equal((await call(ask('{壊れたJSON'))).status, 400);
  assert.equal((await call(ask({ messages: [] }))).status, 400);
  assert.equal((await call(ask({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }))).status, 400, '最後はユーザーの質問');
  assert.equal((await call(ask({ messages: [{ role: 'system', content: 'a' }] }))).status, 400, 'system役は送れない');
  assert.equal((await call(ask(question('a'.repeat(4001))))).status, 400, '長すぎる質問');
  assert.equal((await call(ask(question('写真', { image: { mediaType: 'image/svg+xml', data: 'AAAA' } })))).status, 400, '画像の種類');
  assert.equal((await call(ask(question('写真', { image: { mediaType: 'image/jpeg', data: '<script>' } })))).status, 400, 'base64以外');
  assert.equal(client.calls.length, 0, 'おかしな送り方ではAIを呼ばない（料金がかからない）');
});

test('解説を少しずつ返し、残り回数を伝える', async () => {
  const { call, client } = setup();
  const res = await call(ask(question()));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Remaining'), '2');
  const events = await readEvents(res);
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'ポイント：移項する。答え：x=3');
  assert.deepEqual(events.at(-1), { type: 'done', truncated: false });
  const params = client.calls[0];
  assert.equal(params.model, 'claude-haiku-5-5');
  assert.match(params.system, /わからない問題をわかりやすく解説/);
  assert.match(params.system, /中学1年/);
  assert.match(params.system, /直近7日間：2時間/);
  assert.equal(params.messages.at(-1).content, 'x+2=5を解いて');
});

test('写真は今回の質問に付けてAIに渡す', async () => {
  const { call, client } = setup();
  const body = question('この問題', { image: { mediaType: 'image/jpeg', data: 'aGVsbG8=' } });
  body.messages = [{ role: 'user', content: '前の質問' }, { role: 'assistant', content: '前の答え' }, { role: 'user', content: 'この問題' }];
  await readEvents(await call(ask(body)));
  const msgs = client.calls[0].messages;
  assert.equal(msgs[0].content, '前の質問', '前の質問には付けない');
  assert.deepEqual(msgs[2].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } });
  assert.deepEqual(msgs[2].content[1], { type: 'text', text: 'この問題' });
});

test('1日の上限を超えると断り、次の日（日本時間）にはまた使える', async () => {
  let now = Date.UTC(2026, 9, 17, 14, 0); // 日本時間 23:00
  const { call, client } = setup({}, { now: () => now });
  for (let i = 0; i < 3; i++) await readEvents(await call(ask(question())));
  const res = await call(ask(question()));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'daily_limit', limit: 3 });
  assert.equal(client.calls.length, 3, '上限を超えた分はAIを呼ばない');
  const other = await call(ask(question(), { device: 'another-device-0123456789' }));
  assert.equal(other.status, 200, '別の端末は別に数える');
  await readEvents(other);
  now += 2 * 3600 * 1000; // 日本時間 翌日1:00
  const next = await call(ask(question()));
  assert.equal(next.status, 200);
  await readEvents(next);
});

test('AIが答えを断ったときは refused を返す', async () => {
  const { call } = setup({ chunks: ['途中まで'], stopReason: 'refusal' });
  const events = await readEvents(await call(ask(question())));
  assert.deepEqual(events.at(-1), { type: 'error', code: 'refused' });
});

test('長くて途中で切れたときは truncated を返す', async () => {
  const { call } = setup({ stopReason: 'max_tokens' });
  const events = await readEvents(await call(ask(question())));
  assert.deepEqual(events.at(-1), { type: 'done', truncated: true });
});

test('Anthropic側が混んでいるときは busy、その他の失敗は upstream_error', async () => {
  const busy = setup({ error: new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers()) });
  assert.deepEqual((await readEvents(await busy.call(ask(question())))).at(-1), { type: 'error', code: 'busy' });
  const broken = setup({ error: new Anthropic.InternalServerError(500, undefined, 'oops', new Headers()) });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual((await readEvents(await broken.call(ask(question())))).at(-1), { type: 'error', code: 'upstream_error' });
  } finally {
    console.error = originalError;
  }
});

test('アプリが受け取りをやめたら、AIへの問い合わせも止める', async () => {
  const { call, client, waits } = setup({ chunks: Array.from({ length: 50 }, (_, i) => `${i}`) });
  const res = await call(ask(question()));
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.all(waits);
  assert.equal(client.aborted, true);
});

// 本物のSDKを、APIのふりをするローカルサーバーにつないで、返事の流れ（SSE）を正しく読めるか確かめる
test('本物のSDKで、APIからの返事を少しずつ読める', async () => {
  const http = await import('node:http');
  let received;
  const sse = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ポイント：' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '答え：x=3' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      received = { path: req.url, key: req.headers['x-api-key'], body: JSON.parse(data) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [event, payload] of sse) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    });
  });
  await new Promise(r => server.listen(0, r));
  try {
    const e = env();
    e.ANTHROPIC_API_KEY = 'sk-test';
    const handle = createHandler({ makeClient: x => new Anthropic({ apiKey: x.ANTHROPIC_API_KEY, baseURL: `http://localhost:${server.address().port}`, maxRetries: 0 }) });
    const events = await readEvents(await handle(ask(question()), e, { waitUntil() {} }));
    assert.equal(events.filter(x => x.type === 'delta').map(x => x.text).join(''), 'ポイント：答え：x=3');
    assert.deepEqual(events.at(-1), { type: 'done', truncated: false });
    assert.equal(received.path, '/v1/messages');
    assert.equal(received.key, 'sk-test');
    assert.equal(received.body.stream, true);
    assert.equal(received.body.model, 'claude-haiku-5-5');
  } finally {
    server.close();
  }
});
