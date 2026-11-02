#!/usr/bin/env node
/**
 * 测试用的 LDAP 目录（参考实现，不是被测代码）。
 *
 * 这是唯一一个需要外部依赖的测试夹具：用 ldapjs 起一个**独立实现**的服务端，
 * 才能证明我们手写的 BER 编解码不是「自己跟自己对上」。
 *
 *   mkdir -p /tmp/ldapref && cd /tmp/ldapref && npm i ldapjs
 *   NODE_PATH=/tmp/ldapref/node_modules node scripts/fixtures/ldap-server.mjs
 *   LDAP_TEST_URL=ldap://127.0.0.1:1389 node scripts/sso-e2e.mjs
 */
import ldap from 'ldapjs';

const PORT = Number(process.env.LDAP_PORT || 1389);
const BASE = 'ou=people,dc=example,dc=org';
const ADMIN_DN = 'cn=admin,dc=example,dc=org';
const ADMIN_PW = 'admin-secret';

const PEOPLE = {
  alice: { password: 'alice-pass', cn: 'Alice Chen', mail: 'alice@corp.example' },
  bob: { password: 'bob-pass', cn: 'Bob Stone', mail: 'bob@corp.example' },
  carol: { password: 'carol-pass', cn: 'Carol Diaz', mail: 'carol@corp.example' },
};

const dnOf = (uid) => `uid=${uid},${BASE}`;

const server = ldap.createServer();

server.bind(ADMIN_DN, (req, res, next) => {
  if (req.credentials !== ADMIN_PW) return next(new ldap.InvalidCredentialsError());
  res.end();
  return next();
});

// 每个用户一条 bind 路由：密码错误返回 49，DN 不存在返回 32
for (const [uid, p] of Object.entries(PEOPLE)) {
  server.bind(dnOf(uid), (req, res, next) => {
    // 空密码 = 匿名绑定，按 RFC 4513 必须拒绝成 unauthenticated
    if (!req.credentials) return next(new ldap.UnwillingToPerformError({ message: 'empty password' }));
    if (req.credentials !== p.password) return next(new ldap.InvalidCredentialsError());
    res.end();
    return next();
  });
}

server.search(BASE, (req, res, next) => {
  for (const [uid, p] of Object.entries(PEOPLE)) {
    const attrs = { objectClass: ['inetOrgPerson'], uid, cn: p.cn, mail: p.mail, sn: p.cn.split(' ')[1] || '' };
    if (req.filter.matches(attrs)) res.send({ dn: dnOf(uid), attributes: attrs });
  }
  res.end();
  return next();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LDAP reference server on ldap://127.0.0.1:${PORT} base=${BASE}`);
});
