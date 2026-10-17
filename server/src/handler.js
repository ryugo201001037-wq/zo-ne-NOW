// ゾーンNOW AIサーバーの本体（Cloudflare Workers）
// アプリから問題（文字・写真）を受け取り、Claude に解説させて、できた分から少しずつ返す。
// ・APIキーはサーバーの秘密の設定（ANTHROPIC_API_KEY）にだけ置き、アプリには渡さない
// ・使いすぎ防止に、端末ごとに1日の質問回数を数える（日本時間の0時にリセット）
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './prompt.js';

const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_DAILY_LIMIT = 20;
const MAX_TOKENS = 8000;            // 考える分＋解説の分。解説そのものは400字程度を指示している
const MAX_BODY_BYTES = 7 * 1024 * 1024;
const MAX_TURNS = 12;               // アプリが送ってくる直近の会話の数
const MAX_TURN_CHARS = 4000;
const MAX_IMAGE_BASE64 = 6 * 1024 * 1024; // 写真（base64）。アプリ側で1600pxのJPEGに縮小して送ってくる
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const DEVICE_ID = /^[A-Za-z0-9-]{16,64}$/;
const COUNT_TTL_SECONDS = 2 * 24 * 3600;

// 日本時間の日付（回数のリセット単位）
function jstDateKey(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

// アプリから届いた内容を確かめて、AIに渡す形に整える。おかしければ null
export function parseAskBody(body) {
  if (!body || typeof body !== 'object') return null;
  const { messages, image, gradeLabel = '', studySummary = '' } = body;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_TURNS) return null;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > MAX_TURN_CHARS) return null;
  }
  if (messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') return null;
  if (typeof gradeLabel !== 'string' || gradeLabel.length > 20) return null;
  if (typeof studySummary !== 'string' || studySummary.length > 600) return null;
  if (image !== undefined && image !== null) {
    if (typeof image !== 'object' || !IMAGE_TYPES.includes(image.mediaType)) return null;
    if (typeof image.data !== 'string' || !image.data || image.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(image.data)) return null;
  }

  const turns = messages.map(m => ({ role: m.role, content: m.content }));
  if (image) {
    // 写真は最後の質問（今回の質問）にだけ付ける
    const last = turns[turns.length - 1];
    last.content = [
      { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
      { type: 'text', text: last.content },
    ];
  }
  return { turns, gradeLabel: gradeLabel.trim(), studySummary: studySummary.trim() };
}

// makeClient はテストで差し替えるための引数
export function createHandler({ makeClient = env => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), now = () => Date.now() } = {}) {
  return async function handle(request, env, ctx) {
    // ---- どのサイトから呼べるか（CORS）：自分のアプリのURLだけ許可 ----
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) return json(403, { error: 'forbidden_origin' }, {});
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id',
      'Access-Control-Expose-Headers': 'X-Remaining',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== '/api/ask') return json(404, { error: 'not_found' }, cors);
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, cors);

    // ---- 中身のチェック ----
    const deviceId = request.headers.get('X-Device-Id') || '';
    if (!DEVICE_ID.test(deviceId)) return json(400, { error: 'bad_request' }, cors);
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) return json(413, { error: 'too_large' }, cors);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' }, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { error: 'bad_request' }, cors); }
    const ask = parseAskBody(body);
    if (!ask) return json(400, { error: 'bad_request' }, cors);

    // ---- 1日の回数制限（端末ごと） ----
    // ※ 端末IDはアプリが作るので、ブラウザのデータを消せばリセットできてしまう。
    //   ログイン機能ができたらアカウントごとに数える。最終的な歯止めはAnthropic側の利用額の上限
    const limit = Number(env.DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
    const countKey = `count:${jstDateKey(now())}:${deviceId}`;
    const used = Number(await env.USAGE.get(countKey)) || 0;
    if (used >= limit) return json(429, { error: 'daily_limit', limit }, { ...cors, 'X-Remaining': '0' });
    await env.USAGE.put(countKey, String(used + 1), { expirationTtl: COUNT_TTL_SECONDS });
    const remaining = limit - used - 1;

    // ---- AIに聞いて、できた分から返す（1行に1つのJSON） ----
    const client = makeClient(env);
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = event => writer.write(encoder.encode(JSON.stringify(event) + '\n'));

    const stream = client.messages.stream({
      model: env.MODEL || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'medium' },
      system: buildSystemPrompt(ask),
      messages: ask.turns,
    });
    // アプリ側が接続を切ったら（停止ボタンなど）、AIへの問い合わせも止めて料金を節約する
    stream.on('text', delta => { send({ type: 'delta', text: delta }).catch(() => stream.abort()); });

    const finish = (async () => {
      try {
        const message = await stream.finalMessage();
        if (message.stop_reason === 'refusal') await send({ type: 'error', code: 'refused' });
        else await send({ type: 'done', truncated: message.stop_reason === 'max_tokens' });
      } catch (err) {
        const code = err instanceof Anthropic.RateLimitError ? 'busy'
          : err instanceof Anthropic.APIUserAbortError ? 'cancelled'
          : 'upstream_error';
        if (code === 'upstream_error') console.error('anthropic error', err && err.status, err && err.message);
        await send({ type: 'error', code }).catch(() => {});
      } finally {
        await writer.close().catch(() => {});
      }
    })();

    // 回答を最後まで送り切るまで、Workerを止めないようにする
    if (ctx) ctx.waitUntil(finish);
    return new Response(readable, {
      headers: { ...cors, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Remaining': String(remaining) },
    });
  };
}
