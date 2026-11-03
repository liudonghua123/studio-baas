import crypto from 'node:crypto';
import { db, now, uid } from '../db.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../secrets.js';
import {
  generateRecoveryCodes, generateSecret, hashRecoveryCode, normalizeRecoveryCode,
  otpauthUri, verifyTotp,
} from './totp.js';
import type { RegistrationResult } from './webauthn.js';

/**
 * 第二因素方法（TOTP / Passkey）与恢复码。
 *
 * 一条原则：**没被验证过的方法不能用来登录**。TOTP 添加时会先生成 secret，
 * 用户必须在 App 里看到同一个 6 位码才算绑定成功；Passkey 则要完成一次
 * 完整的注册仪式。这样「添加流程半途失败」不会留下一个谁也解不开的锁。
 */

export type MethodType = 'totp' | 'webauthn';

export interface MethodView {
  id: string;
  type: MethodType;
  name: string;
  verified: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  /** WebAuthn 才有：用来在界面上区分「这台设备」 */
  transports: string[];
  aaguid: string | null;
}

function rowToView(r: any): MethodView {
  let transports: string[] = [];
  try { transports = JSON.parse(r.transports || '[]'); } catch { /* ignore */ }
  return {
    id: r.id, type: r.type, name: r.name,
    verified: !!r.verifiedAt,
    createdAt: r.createdAt, lastUsedAt: r.lastUsedAt,
    transports, aaguid: r.aaguid,
  };
}

export function listMethods(userId: string, opts: { includePending?: boolean } = {}): MethodView[] {
  const rows = db.prepare(
    `SELECT * FROM mfaMethods WHERE userId=? ${opts.includePending ? '' : 'AND verifiedAt IS NOT NULL'}
     ORDER BY createdAt`,
  ).all(userId) as any[];
  return rows.map(rowToView);
}

export function getMethodRow(userId: string, id: string): any {
  return db.prepare('SELECT * FROM mfaMethods WHERE id=? AND userId=?').get(id, userId);
}

export function countVerified(userId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM mfaMethods WHERE userId=? AND verifiedAt IS NOT NULL').get(userId) as any).c;
}

export function countPasskeys(userId: string): number {
  return (db.prepare("SELECT COUNT(*) c FROM mfaMethods WHERE userId=? AND type='webauthn' AND verifiedAt IS NOT NULL").get(userId) as any).c;
}

/* -------------------------------------------------------------------- totp */

export interface TotpEnrollment {
  methodId: string;
  secret: string;
  uri: string;
}

/**
 * 生成一个待确认的 TOTP。secret 立刻加密入库，明文只在这一次响应里出现 ——
 * 用户关掉弹窗就只能删了重来，服务端也解不出第二次。
 */
export function beginTotp(userId: string, email: string, name?: string): TotpEnrollment {
  // 未确认的旧尝试直接清掉：它们永远用不上，留着只会让「添加」按钮越点越乱
  db.prepare("DELETE FROM mfaMethods WHERE userId=? AND type='totp' AND verifiedAt IS NULL").run(userId);

  const secret = generateSecret();
  const id = uid('mfa_');
  db.prepare(
    `INSERT INTO mfaMethods (id,userId,type,name,secret,counter,transports,createdAt)
     VALUES (?,?,?,?,?,0,'[]',?)`,
  ).run(id, userId, 'totp', name?.trim() || 'Authenticator app', encryptSecret(secret), now());

  return { methodId: id, secret, uri: otpauthUri(secret, email) };
}

export function confirmTotp(userId: string, methodId: string, code: string): { recoveryCodes: string[] } {
  const row = getMethodRow(userId, methodId);
  if (!row || row.type !== 'totp') throw new Error('TOTP enrollment not found');
  if (row.verifiedAt) throw new Error('This authenticator is already confirmed');

  const secret = decryptSecret(row.secret);
  if (!secret) throw new Error('Stored secret cannot be decrypted — remove this method and enroll again');

  const match = verifyTotp(secret, code);
  if (!match) throw new Error('That code is not valid. Check the clock on your phone and try again.');

  db.prepare('UPDATE mfaMethods SET verifiedAt=?, lastUsedAt=?, lastCounter=? WHERE id=?')
    .run(now(), now(), match.step, methodId);

  // 绑定成功才发恢复码：还没法登录的账号不需要救援通道
  return { recoveryCodes: issueRecoveryCodes(userId) };
}

/* ----------------------------------------------------------------- webauthn */

export function savePasskey(userId: string, name: string, reg: RegistrationResult): MethodView {
  const dupe = db.prepare('SELECT 1 FROM mfaMethods WHERE credentialId=?').get(reg.credentialId);
  if (dupe) throw new Error('This passkey is already registered');

  const id = uid('mfa_');
  db.prepare(
    `INSERT INTO mfaMethods (id,userId,type,name,credentialId,publicKey,algorithm,counter,transports,aaguid,verifiedAt,lastUsedAt,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, userId, 'webauthn', name.trim() || 'Passkey',
    reg.credentialId, reg.publicKey, reg.algorithm, reg.counter,
    JSON.stringify(reg.transports), reg.aaguid, now(), now(), now(),
  );
  return rowToView(getMethodRow(userId, id));
}

export function passkeyRows(userId: string): any[] {
  return db.prepare("SELECT * FROM mfaMethods WHERE userId=? AND type='webauthn' AND verifiedAt IS NOT NULL").all(userId) as any[];
}

export function updateCounter(methodId: string, counter: number) {
  db.prepare('UPDATE mfaMethods SET counter=?, lastUsedAt=? WHERE id=?').run(counter, now(), methodId);
}

/* ------------------------------------------------------------------ manage */

export function renameMethod(userId: string, id: string, name: string): MethodView {
  const row = getMethodRow(userId, id);
  if (!row) throw new Error('Method not found');
  const clean = String(name || '').trim().slice(0, 64);
  if (!clean) throw new Error('Name cannot be empty');
  db.prepare('UPDATE mfaMethods SET name=? WHERE id=?').run(clean, id);
  return rowToView(getMethodRow(userId, id));
}

export function deleteMethod(userId: string, id: string): boolean {
  const row = getMethodRow(userId, id);
  if (!row) return false;
  db.prepare('DELETE FROM mfaMethods WHERE id=?').run(id);
  return true;
}

/** 账号被删除时清干净；不清的话 user 表回收了 id，新用户会继承旧密钥 */
export function purgeUser(userId: string) {
  db.prepare('DELETE FROM mfaMethods WHERE userId=?').run(userId);
  db.prepare('DELETE FROM mfaRecoveryCodes WHERE userId=?').run(userId);
  db.prepare('DELETE FROM mfaChallenges WHERE userId=?').run(userId);
}

/* ------------------------------------------------------------ recovery codes */

export function issueRecoveryCodes(userId: string): string[] {
  const codes = generateRecoveryCodes(10);
  db.transaction(() => {
    db.prepare('DELETE FROM mfaRecoveryCodes WHERE userId=?').run(userId);
    const ins = db.prepare('INSERT INTO mfaRecoveryCodes (id,userId,codeHash,createdAt) VALUES (?,?,?,?)');
    for (const c of codes) ins.run(uid('rc_'), userId, hashRecoveryCode(c), now());
  })();
  return codes;
}

export function recoveryCodesLeft(userId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM mfaRecoveryCodes WHERE userId=? AND usedAt IS NULL').get(userId) as any).c;
}

function consumeRecoveryCode(userId: string, code: string): boolean {
  const hash = hashRecoveryCode(normalizeRecoveryCode(code));
  const row = db.prepare('SELECT id FROM mfaRecoveryCodes WHERE userId=? AND codeHash=? AND usedAt IS NULL')
    .get(userId, hash) as any;
  if (!row) return false;
  db.prepare('UPDATE mfaRecoveryCodes SET usedAt=? WHERE id=?').run(now(), row.id);
  return true;
}

/* ------------------------------------------------------------------- verify */

export interface SecondFactorInput {
  method?: string;      // 'totp' | 'recovery'，省略时自动判断：6 位数字按 TOTP，其余按恢复码
  code: string;
}

export interface SecondFactorResult {
  kind: 'totp' | 'recovery';
  methodId?: string;
}

/**
 * 校验 TOTP 或恢复码。Passkey 不在这里 —— 它要走 challenge/response，
 * 由路由层单独处理。
 */
export function verifyCode(userId: string, input: SecondFactorInput): SecondFactorResult {
  const code = String(input.code || '').trim();
  if (!code) throw new Error('Enter the 6-digit code from your authenticator');

  const wantsRecovery = input.method === 'recovery' || (!/^\d{6}$/.test(code.replace(/[\s-]/g, '')) && input.method !== 'totp');
  if (wantsRecovery) {
    if (!consumeRecoveryCode(userId, code)) throw new Error('That recovery code is not valid, or has already been used');
    return { kind: 'recovery' };
  }

  const rows = db.prepare("SELECT * FROM mfaMethods WHERE userId=? AND type='totp' AND verifiedAt IS NOT NULL").all(userId) as any[];
  for (const row of rows) {
    const secret = isEncrypted(row.secret) ? decryptSecret(row.secret) : row.secret;
    if (!secret) continue;
    const match = verifyTotp(secret, code, { lastStep: row.lastCounter ?? null });
    if (match) {
      db.prepare('UPDATE mfaMethods SET lastCounter=?, lastUsedAt=? WHERE id=?').run(match.step, now(), row.id);
      return { kind: 'totp', methodId: row.id };
    }
  }
  throw new Error('That code is not valid, or has already been used');
}

/** 给界面用：登录挑战里列出这个账号能用的方式，不含任何密钥材料 */
export function availableMethods(userId: string) {
  const methods = listMethods(userId);
  return {
    totp: methods.some((m) => m.type === 'totp'),
    passkeys: methods.filter((m) => m.type === 'webauthn').map((m) => ({
      id: m.id, name: m.name, transports: m.transports,
    })),
    recoveryCodesLeft: recoveryCodesLeft(userId),
    enrolled: methods.length > 0,
  };
}

/* --------------------------------------------------------------- challenges */

export function createChallenge(input: {
  userId: string;
  projectId: string;
  kind: 'login' | 'register' | 'assert';
  data?: Record<string, unknown>;
  ttlMs?: number;
}): string {
  // 顺手清理过期行；挑战表只会因为「开了页面又关掉」堆积
  db.prepare('DELETE FROM mfaChallenges WHERE expiresAt < ?').run(now());
  const id = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 5 * 60_000)).toISOString();
  db.prepare(
    'INSERT INTO mfaChallenges (id,userId,projectId,kind,purpose,data,attempts,createdAt,expiresAt) VALUES (?,?,?,?,?,?,0,?,?)',
  ).run(id, input.userId, input.projectId, input.kind, input.kind, JSON.stringify(input.data || {}), now(), expiresAt);
  return id;
}

export function getChallenge(id: string, kind?: string): any {
  const row = db.prepare('SELECT * FROM mfaChallenges WHERE id=?').get(String(id || '')) as any;
  if (!row) return null;
  if (kind && row.kind !== kind) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.prepare('DELETE FROM mfaChallenges WHERE id=?').run(row.id);
    return null;
  }
  return row;
}

export function challengeData(row: any): Record<string, any> {
  try { return JSON.parse(row.data || '{}'); } catch { return {}; }
}

export function updateChallengeData(id: string, data: Record<string, unknown>) {
  db.prepare('UPDATE mfaChallenges SET data=? WHERE id=?').run(JSON.stringify(data), id);
}

/** 一次失败：计次，超过上限就作废，避免在线暴力猜 6 位码 */
export function failChallenge(id: string, maxAttempts = 5): { attempts: number; gone: boolean } {
  const row = getChallenge(id);
  if (!row) return { attempts: maxAttempts, gone: true };
  const attempts = (row.attempts || 0) + 1;
  if (attempts >= maxAttempts) {
    db.prepare('DELETE FROM mfaChallenges WHERE id=?').run(id);
    return { attempts, gone: true };
  }
  db.prepare('UPDATE mfaChallenges SET attempts=? WHERE id=?').run(attempts, id);
  return { attempts, gone: false };
}

export function consumeChallenge(id: string) {
  db.prepare('DELETE FROM mfaChallenges WHERE id=?').run(id);
}
