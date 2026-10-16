const out = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

export const log = {
  info: (msg, extra = {}) => out('info', msg, extra),
  warn: (msg, extra = {}) => out('warn', msg, extra),
  error: (msg, extra = {}) => out('error', msg, extra),
};
