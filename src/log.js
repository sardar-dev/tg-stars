// Simple JSON logger. Yahan kabhi API key / mnemonic / secret log nahi karna.
const write = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

export const log = {
  info: (m, e) => write("info", m, e),
  warn: (m, e) => write("warn", m, e),
  error: (m, e) => write("error", m, e),
};
