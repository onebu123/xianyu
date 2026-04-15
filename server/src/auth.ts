import crypto from 'node:crypto';

/**
 * 密码哈希方案：scrypt + 随机盐
 * 格式: scrypt:<salt_hex>:<hash_hex>
 * 旧格式 (sha256): 64 位十六进制字符串，用于向后兼容自动迁移
 */

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16384; // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELIZATION = 1; // p

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  }).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/**
 * 检测是否为旧格式 (sha256) 哈希
 */
function isLegacySha256Hash(stored: string): boolean {
  return !stored.startsWith('scrypt:') && /^[0-9a-f]{64}$/i.test(stored);
}

/**
 * 使用旧 sha256 方案验证密码（用于兼容迁移）
 */
function verifyLegacySha256(password: string, stored: string): boolean {
  const legacy = crypto.createHash('sha256').update(`goofish-demo:${password}`).digest('hex');
  return legacy === stored;
}

/**
 * 验证密码是否匹配
 * 同时支持新格式 (scrypt) 和旧格式 (sha256)
 */
export function comparePassword(password: string, hashedPassword: string): boolean {
  // 旧格式向后兼容
  if (isLegacySha256Hash(hashedPassword)) {
    return verifyLegacySha256(password, hashedPassword);
  }

  // 新格式: scrypt:<salt>:<hash>
  const parts = hashedPassword.split(':');
  if (parts[0] !== 'scrypt' || parts.length !== 3) {
    return false;
  }

  const salt = parts[1];
  const storedHash = parts[2];
  const computedHash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  }).toString('hex');

  // 使用 timingSafeEqual 防止时序攻击
  return crypto.timingSafeEqual(
    Buffer.from(storedHash, 'hex'),
    Buffer.from(computedHash, 'hex'),
  );
}

/**
 * 检查已存储的哈希是否需要迁移到新格式
 */
export function needsPasswordRehash(hashedPassword: string): boolean {
  return isLegacySha256Hash(hashedPassword);
}

function normalizeCipherKey(secret: string) {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(value: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', normalizeCipherKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(value: string, secret: string): string {
  const [ivPart, tagPart, encryptedPart] = value.split('.');
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error('敏感配置密文格式无效。');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    normalizeCipherKey(secret),
    Buffer.from(ivPart, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function maskSecret(value: string) {
  if (!value) {
    return '未配置';
  }

  if (value.length <= 6) {
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
  }

  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}
