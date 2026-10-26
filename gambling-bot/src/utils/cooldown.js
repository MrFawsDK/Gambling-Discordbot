// Short in-memory anti-spam cooldowns. Long cooldowns (daily/work) live in the database
// so they survive restarts.
const expiries = new Map();

export function checkCooldown(key, durationMs, now = Date.now()) {
  const expiresAt = expiries.get(key);
  if (expiresAt && expiresAt > now) return expiresAt;

  expiries.set(key, now + durationMs);
  return null;
}

// Keep the map from growing forever on a busy server.
setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of expiries) {
    if (expiresAt <= now) expiries.delete(key);
  }
}, 60_000).unref();
