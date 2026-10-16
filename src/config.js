import 'dotenv/config';

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '3020')),
  publicUrl: env('PUBLIC_URL').replace(/\/$/, ''),
  appId: env('IG_APP_ID'),
  appSecret: env('IG_APP_SECRET'),
  verifyToken: env('VERIFY_TOKEN'),
  adminKey: env('ADMIN_KEY'),
  graphVersion: env('GRAPH_VERSION', 'v23.0'),
  signatureEnforce: env('SIGNATURE_ENFORCE') === '1',
  smokeTest: env('SMOKE_TEST') === '1',
  dryRun: env('DRY_RUN') === '1',
  sessionSecret: env('SESSION_SECRET'),
  panelUsers: env('PANEL_USERS').split(',').map((u) => u.trim()).filter(Boolean),
  devLogin: env('DEV_LOGIN') === '1', // só para teste local
  dataDir: env('DATA_DIR', new URL('../data', import.meta.url).pathname),
};

export const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
];

export const WEBHOOK_FIELDS = [
  'comments',
  'live_comments',
  'messages',
  'messaging_postbacks',
  'messaging_seen',
  'message_reactions',
];
