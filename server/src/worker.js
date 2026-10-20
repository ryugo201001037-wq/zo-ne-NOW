// Cloudflare Workers の入口
import { createHandler } from './handler.js';

export default { fetch: createHandler() };
