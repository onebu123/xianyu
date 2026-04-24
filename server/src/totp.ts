import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

function base32Encode(buffer: Buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(value: string) {
  const normalized = value.toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let current = 0;
  const bytes: number[] = [];

  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error('MFA 密钥格式无效。');
    }
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function normalizeCode(value: string) {
  return value.replace(/\s+/g, '').trim();
}

function generateCounterBuffer(counter: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  return buffer;
}

function generateHotp(secret: string, counter: number) {
  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key).update(generateCounterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function buildTotpOtpAuthUrl(input: {
  issuer: string;
  accountName: string;
  secret: string;
}) {
  const issuer = encodeURIComponent(input.issuer);
  const accountName = encodeURIComponent(input.accountName);
  const secret = encodeURIComponent(input.secret);
  return `otpauth://totp/${issuer}:${accountName}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

export function verifyTotpCode(input: {
  secret: string;
  code: string;
  window?: number;
  now?: number;
}) {
  const code = normalizeCode(input.code);
  if (!/^\d{6}$/.test(code)) {
    return false;
  }

  const now = input.now ?? Date.now();
  const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  const window = Math.max(input.window ?? 1, 0);

  for (let offset = -window; offset <= window; offset += 1) {
    const expected = generateHotp(input.secret, counter + offset);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return true;
    }
  }

  return false;
}
