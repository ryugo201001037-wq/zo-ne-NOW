// さくらのAI Engine（さくらインターネット）につなぐ部分。
// OpenAI と同じ形の Chat Completions API（https://api.ai.sakura.ad.jp/v1/chat/completions）を、
// stream:true で呼んで、できた分から少しずつ受け取る（SSE：1行ずつ「data: {...}」が届く）
// ・APIキーはサーバーの秘密の設定（SAKURA_API_KEY）にだけ置き、アプリには渡さない

export const SAKURA_BASE_URL = 'https://api.ai.sakura.ad.jp/v1';
export const SAKURA_DEFAULT_MODEL = 'gpt-oss-120b';

// parseAskBody が作った会話（Claudeの形）を、OpenAI の形に直す。写真は data URL で渡す
export function toOpenAIMessages(system, turns) {
  const messages = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (typeof t.content === 'string') { messages.push({ role: t.role, content: t.content }); continue; }
    messages.push({
      role: t.role,
      content: t.content.map(part => part.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } }
        : { type: 'text', text: part.text }),
    });
  }
  return messages;
}

// さくらに問い合わせる。返事が始まる前の失敗は { error } で返す（アプリへの返し方は handler が決める）
export async function startSakura({ env, system, turns, hasImage, maxTokens, signal, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${env.SAKURA_BASE_URL || SAKURA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SAKURA_API_KEY}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: env.SAKURA_MODEL || SAKURA_DEFAULT_MODEL, messages: toOpenAIMessages(system, turns), stream: true, max_tokens: maxTokens }),
      signal,
    });
  } catch (err) {
    console.error('sakura fetch failed', err && err.message);
    return { error: 'upstream_error' };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('sakura error', res.status, detail.slice(0, 300));
    if (res.status === 429) return { error: 'busy' };
    // 写真を付けたときだけ断られた＝このモデルは写真を読めない。アプリは写真ボタンを隠して、文字で聞くよう案内する
    if (hasImage && res.status >= 400 && res.status < 500) return { error: 'images_unavailable' };
    return { error: 'upstream_error' };
  }
  return { body: res.body };
}

// SSE を読んで、本文の続き（delta）を onText に渡す。終わったら { truncated, refused } を返す
// （gpt-oss などの「考えている途中」は delta.reasoning_content / reasoning に入るので、生徒には見せない）
export async function readSakuraStream(body, onText) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finish = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const text = choice.delta && choice.delta.content;
      if (text) await onText(text);
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return { truncated: finish === 'length', refused: finish === 'content_filter' };
}
