import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Shared secret generator/retriever for JWT and OAuth HMAC signing.
 * Ensures backend services share the exact same cryptographic secret.
 */
export function getOrGenerateJwtSecret(): string {
  const envSecret = process.env.JWT_SECRET;
  if (envSecret && !envSecret.includes('catppuccin-jellyfin-spotify-secret-key')) {
    return envSecret;
  }
  const secretFile = path.join(process.cwd(), 'data', '.jwt_secret');
  try {
    if (fs.existsSync(secretFile)) {
      try { fs.chmodSync(secretFile, 0o600); } catch (_) {}
      const saved = fs.readFileSync(secretFile, 'utf-8').trim();
      if (saved.length >= 32) return saved;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, generated, { encoding: 'utf-8', mode: 0o600 });
    return generated;
  } catch (_) {
    return envSecret || crypto.randomBytes(32).toString('hex');
  }
}
