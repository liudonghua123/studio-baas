import crypto from 'node:crypto';

/**
 * API Key 只以 SHA-256 摘要入库：数据库泄漏不等于权限泄漏。
 * 明文仅在创建响应里返回一次，之后只能看到预览（前 12 位 + 后 4 位）。
 * 密钥本体有 192 bit 随机量，不需要慢哈希（scrypt）——反查成本已经不可行。
 */
export function hashApiKey(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function newApiKeySecret(): string {
  return 'standard_' + crypto.randomBytes(24).toString('hex');
}

export function previewApiKey(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 18) return secret.slice(0, 4) + '••••';
  return `${secret.slice(0, 12)}••••${secret.slice(-4)}`;
}
