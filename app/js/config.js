// Where the Smart Spend API lives. Local development talks to `wrangler dev`.
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
export const API_BASE = LOCAL ? 'http://127.0.0.1:8787' : 'https://smart-spend-api.smart-spend-api.workers.dev';
