const levels = ['debug', 'info', 'warn', 'error'];

function ts() {
  return new Date().toISOString();
}

export function createLogger(level = 'info') {
  const min = Math.max(0, levels.indexOf(level));
  function log(l, msg, extra) {
    if (levels.indexOf(l) < min) return;
    const line = `[${ts()}] [${l.toUpperCase()}] ${msg}`;
    if (extra !== undefined) {
      console[l === 'error' ? 'error' : 'log'](line, extra);
    } else {
      console[l === 'error' ? 'error' : 'log'](line);
    }
  }
  return {
    debug: (m, e) => log('debug', m, e),
    info: (m, e) => log('info', m, e),
    warn: (m, e) => log('warn', m, e),
    error: (m, e) => log('error', m, e),
  };
}
