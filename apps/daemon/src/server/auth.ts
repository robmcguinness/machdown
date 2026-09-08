import type { DaemonConfig, PairedExtension } from '#config.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Unambiguous alphabet: no O/0, I/1, so a code can be read off a terminal. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUP = 4;
const CODE_GROUPS = 2;
const CODE_TTL_MS = 10 * 60 * 1000;

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Compares two same-length hex digests without leaking position via timing. */
const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};

const randomCode = (): string => {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g += 1) {
    const bytes = randomBytes(CODE_GROUP);
    let group = '';
    for (const byte of bytes) {
      group += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join('-');
};

export type PairingCode = {
  code: string;
  expiresAt: number;
};

/**
 * Holds the one short-lived pairing code the daemon will accept.
 *
 * Only one code is live at a time: issuing a new one invalidates the old,
 * which keeps the window for a guess as small as possible.
 */
export const createPairingCodes = () => {
  let active: PairingCode | null = null;

  const issue = (): PairingCode => {
    active = { code: randomCode(), expiresAt: Date.now() + CODE_TTL_MS };
    return active;
  };

  const consume = (candidate: string): boolean => {
    if (!active) {
      return false;
    }
    if (Date.now() > active.expiresAt) {
      active = null;
      return false;
    }
    // Normalize formatting before comparing, but compare in constant time.
    const normalized = candidate.trim().toUpperCase().replaceAll(/\s+/g, '');
    if (!safeEqual(normalized, active.code)) {
      return false;
    }

    // Single use: a code that has paired one extension pairs no others.
    active = null;
    return true;
  };

  return { consume, issue, peek: () => active };
};

export type PairingCodes = ReturnType<typeof createPairingCodes>;

export const mintToken = (): string => randomBytes(32).toString('base64url');

export const pairExtension = (
  config: DaemonConfig,
  input: { extensionId: string; label?: string; token: string },
): PairedExtension => {
  const record: PairedExtension = {
    extensionId: input.extensionId,
    label: input.label,
    pairedAt: new Date().toISOString(),
    tokenHash: hashToken(input.token),
  };

  // Re-pairing an extension replaces its previous token rather than
  // accumulating stale credentials.
  config.extensions = [
    ...config.extensions.filter((entry) => entry.extensionId !== input.extensionId),
    record,
  ];

  return record;
};

/** Extracts a bearer token from an Authorization header. */
export const readBearer = (header: string | undefined): string | null => {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
};

export const verifyToken = (config: DaemonConfig, token: string): PairedExtension | null => {
  const candidate = hashToken(token);
  for (const entry of config.extensions) {
    if (safeEqual(candidate, entry.tokenHash)) {
      return entry;
    }
  }
  return null;
};
