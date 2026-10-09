import {readFile, stat} from 'node:fs/promises';

export async function readPrivateCredential(file, pattern) {
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`Credential must be an owner-only regular file: ${file}`);
  }
  const value = (await readFile(file, 'utf8')).trim();
  if (!pattern.test(value)) throw new Error(`Unexpected credential format: ${file}`);
  return value;
}

export async function modelToken() {
  return readPrivateCredential('/data/model-token', /^github_pat_[A-Za-z0-9_]+$/);
}

export async function botToken() {
  return readPrivateCredential('/data/bot-token', /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/);
}

export function redact(text, secrets = []) {
  let value = String(text);
  for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[REDACTED]');
  return value.replace(/github_pat_[A-Za-z0-9_]+|\b\d{5,20}:[A-Za-z0-9_-]{20,100}/g, '[REDACTED]');
}
