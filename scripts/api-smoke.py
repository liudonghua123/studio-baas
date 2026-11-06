#!/usr/bin/env python3
"""Studio BaaS 深度 API 巡检：按 Appwrite 语义逐项验证，记录偏差。

用法：pnpm dev 起服务后 `python3 scripts/api-smoke.py`；
退出码非 0 表示有断言失败，可直接接进 CI。
"""
import base64, hashlib, hmac, json, struct, urllib.request, urllib.error, urllib.parse, uuid, sys, time

BASE = 'http://localhost:5174'
results = []

def _raw_call(method, path, body=None, project='studio', act_as=None, key=None, raw=None, headers=None, ctype='application/json'):
    url = BASE + path
    data = None
    h = dict(headers or {})
    if project: h['x-project-id'] = project
    if act_as: h['x-studio-act-as'] = act_as
    if key: h['x-api-key'] = key
    if raw is not None:
        data = raw
        h.setdefault('content-type', ctype)
    elif body is not None:
        data = json.dumps(body).encode()
        h['content-type'] = 'application/json'
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            buf = r.read()
            try: js = json.loads(buf)
            except Exception: js = buf[:200].decode('utf-8', 'replace')
            return r.status, js, dict(r.headers)
    except urllib.error.HTTPError as e:
        buf = e.read()
        try: js = json.loads(buf)
        except Exception: js = buf[:200].decode('utf-8', 'replace')
        return e.code, js, dict(e.headers)
    except Exception as e:
        return 0, {'transport': str(e)}, {}

def call(method, path, body=None, project='studio', act_as=None, key=None, raw=None, headers=None, ctype='application/json'):
    """429 时自动等待重试：登录限流是 8 次/分，短时间内连跑两遍脚本必然撞上。

    限流本身是正确行为，不该让巡检变成 flaky。429 表示请求未被处理，
    重试不会产生副作用。
    """
    for attempt in range(4):
        s, js, hd = _raw_call(method, path, body, project, act_as, key, raw, headers, ctype)
        if s == 429 and attempt < 3:
            time.sleep(15)
            continue
        return s, js, hd
    return s, js, hd


def totp(secret_b32, at=None, digits=6, period=30):
    """独立实现，用来给被测服务端算码。"""
    key = base64.b32decode(secret_b32 + '=' * ((8 - len(secret_b32) % 8) % 8))
    counter = int((at if at is not None else time.time()) // period)
    mac = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return str((struct.unpack('>I', mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)).zfill(digits)


def check(area, name, ok, detail=''):
    results.append({'area': area, 'name': name, 'ok': bool(ok), 'detail': str(detail)[:260]})
    print(('PASS ' if ok else 'FAIL ') + f'[{area}] {name}' + ('' if ok else f'  → {str(detail)[:260]}'))

def note(area, name, detail):
    results.append({'area': area, 'name': name, 'ok': True, 'detail': 'WARN: ' + str(detail)[:260], 'warn': True})
    print(f'WARN [{area}] {name}  → {str(detail)[:260]}')

TAG = uuid.uuid4().hex[:6]

# ---------------------------------------------------------------- 1 projects
s, p, _ = call('POST', '/v1/projects', {'name': f'Deep Test {TAG}', 'key': f'deep-{TAG}'})
check('projects', 'create project', s == 201, f'{s} {p}')
pid = p['id'] if s == 201 else None

s2, p2, _ = call('POST', '/v1/projects', {'name': 'Dup', 'key': f'deep-{TAG}'})
check('projects', 'duplicate key rejected', s2 in (400, 409), f'{s2} {p2}')

s3, p3, _ = call('POST', '/v1/projects', {'name': '   '})
check('projects', 'blank name rejected', s3 in (400, 422), f'{s3} {p3}')

s4, p4, _ = call('POST', '/v1/projects', {'name': 'X', 'key': 'Bad Key!'})
check('projects', 'unsafe key is slugified', s4 in (400, 422) or (isinstance(p4, dict) and p4.get('key') == 'bad-key'), f'{s4} {p4}')

if pid:
    s, b, _ = call('GET', '/v1/storage/buckets', project=pid)
    check('projects', 'new project gets media bucket', s == 200 and len(b.get('buckets', [])) >= 1, f'{s} {b}')
    s, m, _ = call('GET', '/v1/metrics', project=pid)
    check('projects', 'new project metrics zeroed', s == 200 and m.get('documents') == 0, f'{s} {m.get("documents")}')

# ---------------------------------------------------------------- 2 members
s, me_, _ = call('GET', '/v1/auth/me')
check('members', 'me exposes role + permissions', s == 200 and me_.get('role') in ('owner', 'admin', 'developer', 'viewer') and isinstance(me_.get('permissions'), list), f'{s} {me_}')

s, mem, _ = call('GET', '/v1/members')
check('members', 'member list includes caller', s == 200 and (mem.get('me') or {}).get('role') == 'owner', f'{s} {str(mem)[:160]}')

email = f'deep-{TAG}@example.com'
s, mu, _ = call('POST', '/v1/users', {'email': email, 'name': 'Deep Member', 'password': 'Passw0rd!'})
muid = mu.get('id') if s == 201 else None
s, m1, _ = call('POST', '/v1/members', {'email': email, 'role': 'developer'})
check('members', 'invite member', s == 201, f'{s} {m1}')
mid = m1.get('id') if s == 201 else None

s, m2, _ = call('POST', '/v1/members', {'email': email, 'role': 'viewer'})
check('members', 'duplicate invite rejected', s in (400, 409), f'{s} {m2}')

s, m3, _ = call('POST', '/v1/members', {'email': f'x-{TAG}@example.com', 'role': 'superuser'})
check('members', 'invalid role rejected', s == 400, f'{s} {m3}')

s, m4, _ = call('POST', '/v1/members', {'email': 'not-an-email', 'role': 'viewer'})
check('members', 'invalid email rejected', s == 400, f'{s} {m4}')

if mid:
    s, u1, _ = call('PATCH', f'/v1/members/{mid}', {'role': 'admin'})
    check('members', 'promote member to admin', s == 200 and u1.get('role') == 'admin', f'{s} {u1}')
    # 最后一个 owner 不能被降级
    s, owners, _ = call('GET', '/v1/members')
    own = [x for x in owners.get('members', []) if x.get('role') == 'owner']
    if len(own) == 1 and own[0].get('id'):
        s, r, _ = call('PATCH', f"/v1/members/{own[0]['id']}", {'role': 'viewer'})
        check('members', 'last owner cannot be demoted', s == 400, f'{s} {r}')

# ------------------------------------------------------------------- 3 rbac
s, r, _ = call('POST', '/v1/databases/collections', {'name': 'RBAC probe'}, act_as='viewer')
check('rbac', 'viewer cannot write', s == 403 and r.get('required') == 'databases.write', f'{s} {r}')

s, r, _ = call('GET', '/v1/databases/collections', act_as='viewer')
check('rbac', 'viewer can read', s == 200, f'{s}')

s, r, _ = call('POST', '/v1/members', {'email': f'dev-{TAG}@example.com', 'role': 'viewer'}, act_as='developer')
check('rbac', 'developer cannot manage members', s == 403, f'{s} {r}')

s, r, _ = call('DELETE', f'/v1/projects/{pid}' if pid else '/v1/projects/studio', act_as='admin')
check('rbac', 'admin cannot delete project', s == 403, f'{s} {r}')

# -------------------------------------------------------------- 4 databases
s, col, _ = call('POST', '/v1/databases/collections', {'name': f'Orders {TAG}', 'key': f'orders_{TAG}'})
check('databases', 'create collection', s == 201, f'{s} {col}')
cid = col.get('id') if s == 201 else None

s, col2, _ = call('POST', '/v1/databases/collections', {'name': 'dup', 'key': f'orders_{TAG}'})
check('databases', 'duplicate collection key rejected', s in (400, 409), f'{s} {col2}')

if cid:
    s, a1, _ = call('POST', f'/v1/databases/collections/{cid}/attributes', {'key': 'title', 'type': 'string', 'required': True, 'size': 128})
    check('databases', 'add required string attribute', s == 201, f'{s} {a1}')
    s, a2, _ = call('POST', f'/v1/databases/collections/{cid}/attributes', {'key': 'qty', 'type': 'integer'})
    check('databases', 'add integer attribute', s == 201, f'{s} {a2}')
    s, a3, _ = call('POST', f'/v1/databases/collections/{cid}/attributes', {'key': 'stage', 'type': 'enum', 'elements': ['new', 'paid']})
    check('databases', 'add enum attribute', s == 201, f'{s} {a3}')
    s, a4, _ = call('POST', f'/v1/databases/collections/{cid}/attributes', {'key': 'bad key', 'type': 'string'})
    check('databases', 'invalid attribute key rejected', s == 400, f'{s} {a4}')
    s, a5, _ = call('POST', f'/v1/databases/collections/{cid}/attributes', {'key': 'weird', 'type': 'geopoint'})
    check('databases', 'unknown attribute type rejected', s == 400, f'{s} {a5}')
    s, a6, _ = call('POST', f'/v1/databases/collections/{cid}/attributes', {'key': 'title', 'type': 'string'})
    check('databases', 'duplicate attribute key rejected', s == 400, f'{s} {a6}')

    s, d1, _ = call('POST', f'/v1/databases/collections/{cid}/documents', {'title': 'first', 'qty': 3, 'stage': 'new'})
    check('databases', 'create document', s == 201, f'{s} {d1}')
    did = d1.get('id') if s == 201 else None

    s, d2, _ = call('POST', f'/v1/databases/collections/{cid}/documents', {'qty': 1})
    check('databases', 'missing required attribute rejected', s == 400, f'{s} {d2}')

    s, d3, _ = call('POST', f'/v1/databases/collections/{cid}/documents', {'title': 'x', 'qty': 'not-a-number'})
    check('databases', 'wrong attribute type rejected', s == 400, f'{s} {d3}')

    s, d4, _ = call('POST', f'/v1/databases/collections/{cid}/documents', {'title': 'x', 'stage': 'refunded'})
    check('databases', 'enum outside elements rejected', s == 400, f'{s} {d4}')

    s, d5, _ = call('POST', f'/v1/databases/collections/{cid}/documents', {'title': 'x', 'unknownField': 1})
    check('databases', 'unknown attribute pruned or rejected', s in (201, 400), f'{s} {d5}')
    if s == 201 and 'unknownField' in (d5.get('data') or {}):
        note('databases', 'unknown attribute silently stored', 'Appwrite rejects unknown attributes; here it is persisted as-is')

    s, d7, _ = call('POST', f'/v1/databases/collections/{cid}/documents', {'documentId': f'doc_{TAG}', 'title': 'explicit id', 'qty': 1})
    check('databases', 'client supplied document id honoured', s in (200, 201) and d7.get('id') == f'doc_{TAG}', f'{s} {d7}')

    s, lst, _ = call('GET', f'/v1/databases/collections/{cid}/documents')
    check('databases', 'list documents', s == 200 and lst.get('total', 0) >= 2, f'{s} {lst.get("total")}')

    s, lim, _ = call('GET', f'/v1/databases/collections/{cid}/documents?limit=1')
    check('databases', 'limit honoured', s == 200 and len(lim.get('documents', [])) == 1, f'{s} {lim.get("total")} {len(lim.get("documents", []))}')
    s, off, _ = call('GET', f'/v1/databases/collections/{cid}/documents?limit=1&offset=1')
    same = (lim.get('documents') or [{}])[0].get('id') == (off.get('documents') or [{}])[0].get('id') if s == 200 else True
    check('databases', 'offset paginates', s == 200 and not same, f'{s} limit={lim.get("total")} off={off.get("total")}')

    if did:
        s, up, _ = call('PATCH', f'/v1/databases/collections/{cid}/documents/{did}', {'qty': 9})
        check('databases', 'partial update merges', s == 200 and up.get('data', {}).get('title') == 'first' and up.get('data', {}).get('qty') == 9, f'{s} {up}')

        s, bad, _ = call('PATCH', f'/v1/databases/collections/{cid}/documents/{did}', {'qty': 'NaN'})
        check('databases', 'update validates types', s == 400, f'{s} {bad}')

    s, nf, _ = call('GET', f'/v1/databases/collections/{cid}/documents/doc_missing_{TAG}')
    check('databases', 'missing document 404', s == 404, f'{s} {nf}')

# ---------------------------------------------------------------- 5 storage
s, bk, _ = call('POST', '/v1/storage/buckets', {'name': f'Deep {TAG}', 'fileSecurity': False, 'maxFileSize': 5 * 1024 * 1024})
check('storage', 'create bucket', s == 201, f'{s} {bk}')
bid = bk.get('id') if s == 201 else None

if bid:
    payload = b'hello deep test\n'
    boundary = '----deepboundary'
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="note-{TAG}.txt"\r\n'
            f'Content-Type: text/plain\r\n\r\n').encode() + payload + f'\r\n--{boundary}--\r\n'.encode()
    s, f1, _ = call('POST', f'/v1/storage/buckets/{bid}/files', raw=body,
                    ctype=f'multipart/form-data; boundary={boundary}')
    check('storage', 'upload file (multipart)', s in (200, 201), f'{s} {f1}')
    fid = f1.get('id') if isinstance(f1, dict) else None

    if fid:
        s, body, hdrs = call('GET', f'/v1/storage/files/{fid}/view')
        got = body if isinstance(body, str) else json.dumps(body)
        check('storage', 'download returns bytes', s == 200 and 'hello deep test' in got, f'{s} {str(body)[:80]}')
        s, head, h = call('GET', f'/v1/storage/files/{fid}/view')
        check('storage', 'download sets content-type', 'text/plain' in str(h.get('Content-Type', h.get('content-type', ''))).lower(), f'{h.get("Content-Type") or h.get("content-type")}')
        s, fdel, _ = call('DELETE', f'/v1/storage/files/{fid}')
        check('storage', 'delete file', s in (200, 204), f'{s} {fdel}')
        s, again, _ = call('GET', f'/v1/storage/files/{fid}/view')
        check('storage', 'deleted file 404', s == 404, f'{s}')

    # 必须是真 multipart：早先这里发的是 octet-stream，multer 解析不出文件，
    # 断言实际测的是「没有文件」而不是「文件过大」，一直误报到 CI 才发现。
    big = b'x' * (6 * 1024 * 1024)
    bnd = '----deepbig'
    bigbody = (f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n'
               f'Content-Type: application/octet-stream\r\n\r\n').encode() + big + f'\r\n--{bnd}--\r\n'.encode()
    s, fb, _ = call('POST', f'/v1/storage/buckets/{bid}/files', raw=bigbody,
                    ctype=f'multipart/form-data; boundary={bnd}')
    check('storage', 'bucket max size enforced', s == 413, f'{s} {str(fb)[:160]}')
    s2, fl, _ = call('GET', f'/v1/storage/buckets/{bid}/files')
    check('storage', 'oversized upload is not stored',
          s2 == 200 and not any(f['name'] == 'big.bin' for f in fl.get('files', [])),
          f'{[f["name"] for f in fl.get("files", [])]}')

# -------------------------------------------------------------- 6 functions
s, fn, _ = call('POST', '/v1/functions', {'name': f'Deep fn {TAG}', 'runtime': 'node-22', 'entrypoint': 'src/main.js'})
check('functions', 'create function', s == 201, f'{s} {fn}')
fnid = fn.get('id') if s == 201 else None

if fnid:
    code = "export default async ({ req, res, log }) => { log('hi'); return res.json({ echo: req.body, path: req.path }); };"
    s, sv, _ = call('PATCH', f'/v1/functions/{fnid}', {'code': code, 'timeout': 5})
    check('functions', 'save code', s == 200, f'{s} {str(sv)[:120]}')

    s, ex, _ = call('POST', f'/v1/functions/{fnid}/executions', {'a': 1})
    check('functions', 'execute with payload', s in (200, 201) and ex.get('status') == 'completed' and (ex.get('response') or {}).get('echo', {}).get('a') == 1, f'{s} {str(ex)[:200]}')

    bad = "export default async () => { throw new Error('boom'); };"
    call('PATCH', f'/v1/functions/{fnid}', {'code': bad})
    s, ex2, _ = call('POST', f'/v1/functions/{fnid}/executions', {})
    check('functions', 'runtime error captured', s in (200, 201) and ex2.get('status') == 'failed', f'{s} {str(ex2)[:200]}')

    loop = "export default async () => { while (true) {} };"
    call('PATCH', f'/v1/functions/{fnid}', {'code': loop, 'timeout': 1})
    t0 = time.time()
    s, ex3, _ = call('POST', f'/v1/functions/{fnid}/executions', {})
    dt = time.time() - t0
    check('functions', 'infinite loop times out', dt < 12 and ex3.get('status') == 'failed', f'{s} {dt:.1f}s {str(ex3)[:160]}')

    call('PATCH', f'/v1/functions/{fnid}', {'code': code, 'timeout': 15})
    s, exl, _ = call('GET', f'/v1/functions/{fnid}/executions')
    check('functions', 'execution history', s == 200 and exl.get('total', 0) >= 3, f'{s} {exl.get("total")}')

    s, env, _ = call('PATCH', f'/v1/functions/{fnid}', {'variables': [{'key': 'TOKEN', 'value': 's3cret'}]})
    check('functions', 'env vars saved', s == 200, f'{s} {str(env)[:120]}')
    probe = "export default async ({ env, res }) => res.json({ has: !!env.TOKEN, value: env.TOKEN });"
    call('PATCH', f'/v1/functions/{fnid}', {'code': probe})
    s, ex4, _ = call('POST', f'/v1/functions/{fnid}/executions', {})
    check('functions', 'env var available at runtime', s in (200, 201) and (ex4.get('response') or {}).get('has') is True, f'{s} {str(ex4.get("response"))[:120]}')

# ------------------------------------------------------------------ 7 sites
s, st, _ = call('POST', '/v1/sites', {'name': f'Deep site {TAG}'})
check('sites', 'create site', s == 201, f'{s} {st}')
sid = st.get('id') if s == 201 else None

if sid:
    s, fl, _ = call('GET', f'/v1/sites/{sid}')
    files = (fl.get('files') if isinstance(fl, dict) else None) or []
    check('sites', 'scaffold has index.html', any(f.get('path') == 'index.html' for f in files), f'{s} {[f.get("path") for f in files]}')

    s, wr, _ = call('PATCH', f'/v1/sites/{sid}', {'files': [{'path': 'index.html', 'content': '<h1>deep</h1>'}]})
    check('sites', 'write site file', s == 200, f'{s} {str(wr)[:120]}')

    s, pv, _ = call('GET', f'/v1/sites/{sid}/preview/index.html')
    check('sites', 'preview serves edited file', s == 200 and 'deep' in (pv if isinstance(pv, str) else json.dumps(pv)), f'{s} {str(pv)[:80]}')

    s, dep, _ = call('POST', f'/v1/sites/{sid}/deployments', {})
    check('sites', 'deployment created', s in (200, 201), f'{s} {str(dep)[:140]}')

    s, nf, _ = call('GET', f'/v1/sites/{sid}/preview/nope.html')
    check('sites', 'unknown preview path 404', s == 404, f'{s}')

# ------------------------------------------------------------------ 8 users
uemail = f'user-{TAG}@example.com'
s, usr, _ = call('POST', '/v1/users', {'email': uemail, 'name': 'Deep User', 'password': 'Passw0rd!'})
check('auth', 'create user', s == 201, f'{s} {usr}')
uid_ = usr.get('id') if s == 201 else None
if uid_:
    check('auth', 'password never returned', 'password' not in json.dumps(usr).lower() or 'hash' in json.dumps(usr).lower(), f'{usr}')
    s, dup, _ = call('POST', '/v1/users', {'email': uemail, 'name': 'Dup', 'password': 'Passw0rd!'})
    check('auth', 'duplicate email rejected', s in (400, 409), f'{s} {dup}')
    s, login, _ = call('POST', '/v1/account/sessions', {'email': uemail, 'password': 'Passw0rd!'})
    check('auth', 'login with right password', s in (200, 201), f'{s} {str(login)[:120]}')
    s, bad_login, _ = call('POST', '/v1/account/sessions', {'email': uemail, 'password': 'wrong'})
    check('auth', 'login with wrong password rejected', s in (400, 401), f'{s} {bad_login}')

# -------------------------------------------------------------- 9 api keys
s, k, _ = call('POST', '/v1/api-keys', {'name': f'deep {TAG}', 'scopes': ['databases.read']})
check('apiKeys', 'create scoped key', s == 201 and k.get('secret'), f'{s} {k}')
if s == 201:
    sec = k['secret']
    s, r, _ = call('GET', '/v1/databases/collections', key=sec)
    check('apiKeys', 'key can use granted scope', s == 200, f'{s}')
    s, r, _ = call('POST', '/v1/databases/collections', {'name': 'nope'}, key=sec)
    check('apiKeys', 'key blocked outside scope', s == 403, f'{s} {r}')
    s, r, _ = call('GET', '/v1/api-keys', key=sec)
    check('apiKeys', 'key blocked from key management', s == 403, f'{s} {r}')
    call('DELETE', f"/v1/api-keys/{k['id']}")
    s, r, _ = call('GET', '/v1/databases/collections', key=sec)
    check('apiKeys', 'deleted key rejected', s == 401, f'{s} {r}')

# ------------------------------------------------------- 10 project isolation
if cid:
    s, r, _ = call('GET', f'/v1/databases/collections/{cid}', project='prj_nebula')
    check('isolation', 'collection invisible in other project', s == 404, f'{s} {r}')
    s, r, _ = call('GET', f'/v1/databases/collections/{cid}/documents', project='prj_nebula')
    check('isolation', 'documents invisible in other project', s == 404, f'{s} {r}')

# --------------------------------------------------------------- 11 error shape
s, r, _ = call('GET', '/v1/databases/collections/does-not-exist')
shape_ok = isinstance(r, dict) and ('error' in r or 'code' in r)
check('api', 'error payload is structured', shape_ok, f'{s} {r}')
s, r, _ = call('GET', '/v1/nope')
check('api', 'unknown route returns json 404', s == 404 and isinstance(r, dict), f'{s} {str(r)[:80]}')

# ------------------------------------------------- 12 async loop isolation
if fnid:
    async_loop = "export default async () => { await null; while (true) {} };"
    call('PATCH', f'/v1/functions/{fnid}', {'code': async_loop, 'timeout': 2})
    import threading
    health = {}

    def probe():
        time.sleep(0.8)          # 让函数先进入死循环
        s, _, _ = call('GET', '/v1/health')
        health['status'] = s

    th = threading.Thread(target=probe)
    t0 = time.time()
    th.start()
    s, ex5, _ = call('POST', f'/v1/functions/{fnid}/executions', {})
    th.join()
    dt = time.time() - t0
    check('isolation', 'async dead loop is terminated',
          ex5.get('status') == 'failed' and dt < 8, f'{dt:.1f}s {str(ex5.get("errors"))[:120]}')
    check('isolation', 'server stays responsive during the loop',
          health.get('status') == 200, f'health={health}')

# ------------------------------------------------- 12b multi-language runtimes
s, rts, _ = call('GET', '/v1/runtimes')
rt_list = rts.get('runtimes', []) if isinstance(rts, dict) else []
node_rt = next((r for r in rt_list if r['id'] == 'node-22'), None)
py_rt = next((r for r in rt_list if r['id'] == 'python-3'), None)
check('runtimes', 'runtime registry lists both languages', s == 200 and bool(node_rt) and bool(py_rt), f'{s} {[r["id"] for r in rt_list]}')
check('runtimes', 'python is available on this host', bool(py_rt) and py_rt['availability']['available'] is True,
      str(py_rt.get('availability') if py_rt else None))

pyfnid = None
if py_rt and py_rt['availability']['available']:
    py_code = ("def handler(ctx):\n"
               "    docs = ctx.databases.list_documents('products', {'limit': 2})\n"
               "    ctx.log('py', ctx.req.method)\n"
               "    return ctx.res.json({'total': docs['total'], 'env': ctx.env.get('PY_FLAG')})\n")
    s, pf, _ = call('POST', '/v1/functions', {'name': f'Py fn {TAG}', 'runtime': 'python-3',
                                              'entrypoint': 'main.py', 'code': py_code,
                                              'env': {'PY_FLAG': 'on'}})
    check('runtimes', 'create python function', s == 201 and pf.get('entrypoint') == 'main.py', f'{s} {str(pf)[:120]}')
    pyfnid = pf.get('id') if s == 201 else None

if pyfnid:
    s, pex, _ = call('POST', f'/v1/functions/{pyfnid}/executions', {})
    body = pex.get('response') or {}
    check('runtimes', 'python function executes against real data',
          s in (200, 201) and pex.get('status') == 'completed' and body.get('total', 0) > 0 and body.get('env') == 'on',
          f'{s} {str(pex)[:200]}')
    check('runtimes', 'python logs and runtime are recorded',
          pex.get('runtime') == 'python-3' and any(str(l).startswith('py POST') for l in pex.get('logs', [])),
          f'{pex.get("runtime")} {str(pex.get("logs"))[:120]}')

    call('PATCH', f'/v1/functions/{pyfnid}', {'code': 'def handler(ctx):\n    raise ValueError("smoke")\n'})
    s, perr, _ = call('POST', f'/v1/functions/{pyfnid}/executions', {})
    check('runtimes', 'python exceptions are reported cleanly',
          perr.get('status') == 'failed' and any('ValueError' in str(e) for e in perr.get('errors', [])),
          str(perr.get('errors'))[:120])

s, badrt, _ = call('POST', '/v1/functions', {'name': f'Cobol {TAG}', 'runtime': 'cobol-85'})
check('runtimes', 'unknown runtime is a 400', s == 400, f'{s} {str(badrt)[:100]}')

s, legacy, _ = call('POST', '/v1/functions', {'name': f'Legacy {TAG}', 'runtime': 'node-18'})
check('runtimes', 'legacy node-18 is normalised', s == 201 and legacy.get('runtime') == 'node-22', f'{s} {legacy.get("runtime")}')
legacy_id = legacy.get('id') if s == 201 else None

# ------------------------------------------------------ 13 document permissions
s, pc, _ = call('POST', '/v1/databases/collections', {'name': f'Perm {TAG}', 'documentSecurity': True})
check('docperm', 'create secured collection', s == 201 and pc.get('documentSecurity') is True, f'{s} {str(pc)[:120]}')
if s == 201:
    pcid = pc['id']
    call('POST', f'/v1/databases/collections/{pcid}/attributes', {'key': 'title', 'type': 'string', 'required': True})
    s, d1, _ = call('POST', f'/v1/databases/collections/{pcid}/documents',
                    {'data': {'title': 'public'}, 'permissions': ['read("any")', 'update("users")']})
    s, d2, _ = call('POST', f'/v1/databases/collections/{pcid}/documents',
                    {'data': {'title': 'private'}, 'permissions': ['read("user:usr_nobody")']})
    s, d3, _ = call('POST', f'/v1/databases/collections/{pcid}/documents',
                    {'data': {'title': 'team'}, 'permissions': ['read("team:studio/viewer")', 'write("team:studio/owner")']})

    s, r, _ = call('GET', f'/v1/databases/collections/{pcid}/documents', act_as='viewer')
    titles = sorted(x['data']['title'] for x in r.get('documents', []))
    check('docperm', 'read rules filter the list', s == 200 and titles == ['public', 'team'], f'{titles}')
    s, r, _ = call('GET', f'/v1/databases/collections/{pcid}/documents', act_as='developer')
    check('docperm', 'role outside the rule sees less', [x['data']['title'] for x in r.get('documents', [])] == ['public'],
          f'{[x["data"]["title"] for x in r.get("documents", [])]}')
    s, r, _ = call('GET', f'/v1/databases/collections/{pcid}/documents/{d2["id"]}', act_as='viewer')
    check('docperm', 'no read permission hides the document (404)', s == 404, f'{s} {r}')
    s, r, _ = call('PATCH', f'/v1/databases/collections/{pcid}/documents/{d2["id"]}',
                   {'data': {'title': 'hacked'}}, act_as='viewer')
    check('docperm', 'update without rule is 403', s == 403 and r.get('code') == 'forbidden', f'{s} {r}')
    s, r, _ = call('DELETE', f'/v1/databases/collections/{pcid}/documents/{d3["id"]}', act_as='viewer')
    check('docperm', 'delete without rule is 403', s == 403, f'{s} {r}')
    s, r, _ = call('PATCH', f'/v1/databases/collections/{pcid}/documents/{d3["id"]}',
                   {'data': {'title': 'renamed'}}, act_as='owner')
    check('docperm', 'write("team:.../owner") grants update', s == 200, f'{s} {str(r)[:120]}')
    s, r, _ = call('POST', f'/v1/databases/collections/{pcid}/documents',
                   {'data': {'title': 'x'}, 'permissions': ['read(any)']})
    check('docperm', 'malformed rule rejected', s == 400, f'{s} {r}')
    # 关闭开关后回到项目级 RBAC
    call('PATCH', f'/v1/databases/collections/{pcid}', {'documentSecurity': False})
    s, r, _ = call('GET', f'/v1/databases/collections/{pcid}/documents', act_as='developer')
    check('docperm', 'turning security off restores project-wide reads', r.get('total') == 3, f'{r.get("total")}')
    call('DELETE', f'/v1/databases/collections/{pcid}')

# --------------------------------------------------------- 14 api key hashing
s, k2, _ = call('POST', '/v1/api-keys', {'name': f'hash {TAG}', 'scopes': ['databases.read']})
check('apiKeys', 'plaintext returned exactly once', s == 201 and str(k2.get('secret', '')).startswith('standard_'), f'{s} {str(k2)[:120]}')
if s == 201:
    s, kl, _ = call('GET', '/v1/api-keys')
    item = next((x for x in kl.get('keys', []) if x['id'] == k2['id']), {})
    check('apiKeys', 'list never exposes the secret', 'secret' not in item and 'secretHash' not in item, f'{item}')
    check('apiKeys', 'list shows a preview instead',
          item.get('preview', '').startswith(k2['secret'][:12]) and k2['secret'] not in item.get('preview', ''),
          f'{item.get("preview")}')
    call('DELETE', f"/v1/api-keys/{k2['id']}")

# ------------------------------------------------- 15 act-as cannot escalate
if pid and uid_:
    call('POST', '/v1/members', {'userId': uid_, 'role': 'viewer'}, project=pid)
    s, lg2, _ = call('POST', '/v1/account/sessions', {'email': uemail, 'password': 'Passw0rd!'})
    sess = lg2.get('secret') if isinstance(lg2, dict) else None
    if sess:
        s, r, _ = call('GET', '/v1/auth/me', project=pid, headers={'x-studio-session': sess, 'x-studio-act-as': 'owner'})
        check('rbac', 'session cannot self-promote via act-as', r.get('role') == 'viewer', f'{r.get("role")}')
        s, r, _ = call('POST', '/v1/databases/collections', {'name': 'Escalate'}, project=pid,
                       headers={'x-studio-session': sess, 'x-studio-act-as': 'owner'})
        check('rbac', 'act-as cannot grant a write the session lacks', s == 403, f'{s} {r}')
        s, r, _ = call('GET', '/v1/auth/me', act_as='viewer')
        check('rbac', 'credential-less demo mode still honours act-as', r.get('role') == 'viewer', f'{r.get("role")}')

        # 退出登录必须让服务端那一行失效，而不是只把票据从浏览器删掉
        s, r, _ = call('DELETE', '/v1/account/sessions', headers={'x-studio-session': sess})
        check('auth', 'sign-out revokes the session server-side', s == 200, f'{s} {r}')
        # /me 仍然 200，但身份被标成 invalid（前端据此提示“会话过期”）；真正的拦截在 guard 上
        s, r, _ = call('GET', '/v1/auth/me', headers={'x-studio-session': sess})
        check('auth', 'revoked session resolves to an invalid principal',
              s == 200 and (r.get('principal') or {}).get('invalid') is True, f'{s} {r}')
        s, r, _ = call('GET', '/v1/databases/collections', headers={'x-studio-session': sess})
        check('auth', 'revoked session cannot reach guarded routes', s == 401, f'{s} {r}')

# --------------------------------------------------------- 16 function versions
if fnid:
    s, vl0, _ = call('GET', f'/v1/functions/{fnid}/versions')
    base = len(vl0.get('versions', []))
    check('versions', 'a saved function always has a baseline snapshot', base >= 1, f'{base}')

    s, cur, _ = call('GET', f'/v1/functions/{fnid}')
    before = cur.get('code', '')
    v2code = "export default async ({ res }) => res.json({ v: 2 });"
    call('PATCH', f'/v1/functions/{fnid}', {'code': v2code})
    s, vl1, _ = call('GET', f'/v1/functions/{fnid}/versions')
    check('versions', 'saving code appends an immutable version',
          len(vl1.get('versions', [])) == base + 1 and vl1['versions'][0]['label'] == 'save',
          f'{len(vl1.get("versions", []))} vs {base}')

    old = next((v for v in vl1.get('versions', []) if v.get('code', '').strip() == before.strip()), None)
    check('versions', 'the previous code is retrievable', old is not None, 'no matching version')
    if old:
        s, rs, _ = call('POST', f'/v1/functions/{fnid}/versions/{old["id"]}/restore')
        check('versions', 'restore writes the old code back', s == 200 and rs.get('code', '').strip() == before.strip(),
              f'{s} {str(rs)[:120]}')
        s, vl2, _ = call('GET', f'/v1/functions/{fnid}/versions')
        check('versions', 'restore is recorded as a new version',
              len(vl2.get('versions', [])) == base + 2 and 'restored' in (vl2['versions'][0].get('label') or ''),
              f'{len(vl2.get("versions", []))} {vl2["versions"][0].get("label")}')

# ------------------------------------------------------------------ 17 indexes
s, ic, _ = call('POST', '/v1/databases/collections', {'name': f'Idx {TAG}'})
check('indexes', 'create collection for index tests', s == 201, f'{s} {ic}')
if s == 201:
    icid = ic['id']
    for k, t in [('status', 'string'), ('total', 'float'), ('code', 'string')]:
        call('POST', f'/v1/databases/collections/{icid}/attributes', {'key': k, 'type': t})

    def plan(*qs):
        qs_ = urllib.parse.urlencode([('queries[]', q) for q in qs])
        return call('GET', f'/v1/databases/collections/{icid}/query-plan?{qs_}')

    def add_doc(data):
        return call('POST', f'/v1/databases/collections/{icid}/documents', {'data': data})

    s, p0, _ = plan('equal("status","paid")')
    check('indexes', 'without an index the plan is a collection scan',
          s == 200 and p0.get('narrowed') is False and p0.get('tempBTree') is True,
          f'{s} {p0.get("terms")} tempB={p0.get("tempBTree")}')

    s, ix, _ = call('POST', f'/v1/databases/collections/{icid}/indexes',
                    {'key': 'status_total', 'type': 'key', 'attributes': ['status', 'total'], 'orders': ['ASC', 'DESC']})
    check('indexes', 'create a composite key index',
          s == 201 and ix.get('status') == 'available', f'{s} {str(ix)[:150]}')

    s, p1, _ = plan('equal("status","paid")')
    check('indexes', 'the index turns the scan into an index lookup',
          p1.get('narrowed') is True and p1.get('index') == 'ix_' + icid + '_status_total',
          f'{p1.get("index")} {p1.get("terms")}')

    # 默认按 createdAt 排序，复合索引 (status,total) 帮不上忙 → 仍需临时 B 树；
    # 换成 orderDesc("total") 后排序也能由索引满足，这是复合索引真正的价值。
    s, p1b, _ = plan('equal("status","paid")', 'orderDesc("total")')
    check('indexes', 'the composite index also satisfies the sort',
          p1b.get('narrowed') is True and p1b.get('tempBTree') is False,
          f'{p1b.get("terms")} tempB={p1b.get("tempBTree")}')

    s, p2, _ = plan('greaterThan("total",10)')
    check('indexes', 'a non-leftmost column cannot use the index alone',
          p2.get('narrowed') is False, f'{p2.get("terms")}')

    s, uq, _ = call('POST', f'/v1/databases/collections/{icid}/indexes',
                    {'key': 'uniq_code', 'type': 'unique', 'attributes': ['code']})
    check('indexes', 'create a unique index', s == 201 and uq.get('status') == 'available', f'{s} {str(uq)[:150]}')

    add_doc({'code': 'A-1'})
    s, dup, _ = add_doc({'code': 'A-1'})
    check('indexes', 'unique index rejects the duplicate with a readable error',
          s == 400 and 'requires unique values' in str(dup.get('error', '')), f'{s} {dup}')

    s, bad, _ = call('POST', f'/v1/databases/collections/{icid}/indexes',
                     {'key': 'ghost', 'type': 'key', 'attributes': ['nope']})
    check('indexes', 'indexing an undefined attribute is rejected', s == 400, f'{s} {bad}')

    s, attrs, _ = call('GET', f'/v1/databases/collections/{icid}')
    code_attr = next((a for a in attrs.get('attributes', []) if a['key'] == 'code'), None)
    if code_attr:
        s, r, _ = call('DELETE', f'/v1/databases/collections/{icid}/attributes/{code_attr["id"]}')
        check('indexes', 'dropping an indexed attribute is refused', s == 400 and 'delete the index first' in str(r.get('error', '')), f'{s} {r}')

    s, lst, _ = call('GET', f'/v1/databases/collections/{icid}/indexes')
    check('indexes', 'list reports both indexes', s == 200 and len(lst.get('indexes', [])) == 2, f'{len(lst.get("indexes", []))}')

    sid = next((i['id'] for i in lst.get('indexes', []) if i['key'] == 'status_total'), None)
    if sid:
        call('DELETE', f'/v1/databases/collections/{icid}/indexes/{sid}')
        s, p3, _ = plan('equal("status","paid")')
        check('indexes', 'dropping the index restores the scan', p3.get('narrowed') is False, f'{p3.get("terms")}')

    call('DELETE', f'/v1/databases/collections/{icid}')
    s, gone, _ = call('GET', f'/v1/databases/collections/{icid}/indexes')
    check('indexes', 'deleting the collection takes its indexes with it', s == 404, f'{s} {gone}')

# ----------------------------------------------------- 12 batch & webhooks
s, bc, _ = call('POST', '/v1/databases/collections', {'name': f'Bulk {TAG}', 'key': f'bulk-{TAG}'})
bcid = bc.get('id') if s == 201 else None
check('bulk', 'collection for batch insert', bool(bcid), f'{s} {bc}')
if bcid:
    call('POST', f'/v1/databases/collections/{bcid}/attributes', {'key': 'name', 'type': 'string', 'required': True})
    call('POST', f'/v1/databases/collections/{bcid}/attributes', {'key': 'n', 'type': 'integer'})
    s, r, _ = call('POST', f'/v1/databases/collections/{bcid}/documents/bulk',
                   {'documents': [{'name': 'a', 'n': 1}, {'name': 'b', 'n': 2}, {'name': 'c', 'n': 3}]})
    check('bulk', 'three documents in one call', s == 201 and r.get('total') == 3, f'{s} {r}')

    s, r, _ = call('GET', f'/v1/databases/collections/{bcid}/documents')
    check('bulk', 'all rows are visible afterwards', r.get('total') == 3, f'{r.get("total")}')

    # one bad row must reject the whole batch — a partial import is worse than none
    s, r, _ = call('POST', f'/v1/databases/collections/{bcid}/documents/bulk',
                   {'documents': [{'name': 'ok', 'n': 4}, {'n': 5}]})
    check('bulk', 'invalid row rejects the batch', s == 400 and 'documents[1]' in str(r.get('error', '')), f'{s} {r}')

    s, r, _ = call('GET', f'/v1/databases/collections/{bcid}/documents')
    check('bulk', 'rejected batch wrote nothing', r.get('total') == 3, f'{r.get("total")}')

    s, r, _ = call('POST', f'/v1/databases/collections/{bcid}/documents/bulk', {'documents': []})
    check('bulk', 'empty batch is a 400', s == 400, f'{s} {r}')

# ---- a real receiver, so delivery + signature are verified end to end
import threading, http.server
_hits = []
class _Receiver(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(n)
        try: parsed = json.loads(body)
        except Exception: parsed = None
        _hits.append({'event': self.headers.get('x-studio-event'), 'sig': self.headers.get('x-studio-signature'), 'body': parsed, 'raw': body.decode('utf-8', 'replace')})
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass

_srv = http.server.HTTPServer(('127.0.0.1', 5211), _Receiver)
threading.Thread(target=_srv.serve_forever, daemon=True).start()

s, hook, _ = call('POST', '/v1/webhooks', {'url': 'http://127.0.0.1:5211/hook', 'events': ['document.*'], 'description': 'smoke'})
hid = hook.get('id') if s == 201 else None
secret = hook.get('secret') if s == 201 else ''
check('webhooks', 'create returns a one-time secret', s == 201 and len(str(secret)) >= 32, f'{s} {str(secret)[:12]}')

if hid:
    s, lst, _ = call('GET', '/v1/webhooks')
    row = next((w for w in lst.get('webhooks', []) if w['id'] == hid), {})
    check('webhooks', 'list never exposes the secret', s == 200 and 'secret' not in row, f'{row}')

    if bcid:
        _hits.clear()
        call('POST', f'/v1/databases/collections/{bcid}/documents', {'name': 'hooked', 'n': 9})
        time.sleep(1.2)
        check('webhooks', 'document.create reaches the endpoint', any(h['event'] == 'document.create' for h in _hits), f'{len(_hits)} hits')

        hit = next((h for h in _hits if h['event'] == 'document.create'), None)
        if hit:
            import hmac, hashlib
            ts, sig = (hit['sig'] or '').split(',') if hit['sig'] else ('', '')
            expect = hmac.new(secret.encode(), f"{ts[2:]}.{hit['raw']}".encode(), hashlib.sha256).hexdigest()
            check('webhooks', 'HMAC signature verifies', hmac.compare_digest(expect, sig[3:]), f'{hit["sig"]}')

    s, d, _ = call('POST', f'/v1/webhooks/{hid}/test')
    check('webhooks', 'test delivery succeeds', s == 200 and (d.get('delivery') or {}).get('status') == 200, f'{s} {d}')

    s, d, _ = call('GET', f'/v1/webhooks/{hid}/deliveries')
    check('webhooks', 'delivery log records attempts', s == 200 and len(d.get('deliveries', [])) >= 1, f'{len(d.get("deliveries", []))}')

    s, r, _ = call('PATCH', f'/v1/webhooks/{hid}', {'enabled': False})
    check('webhooks', 'disable a subscription', s == 200 and r.get('enabled') is False, f'{s} {r}')

    s, r, _ = call('DELETE', f'/v1/webhooks/{hid}')
    check('webhooks', 'delete removes it', s == 200 and r.get('ok') is True, f'{s} {r}')

# --------------------------------------------------------------- 13 ai agent
s, st, _ = call('GET', '/v1/ai/status')
check('ai', 'status reports a provider and mode', s == 200 and st.get('providerId') and st.get('mode') in ('live', 'demo'), f'{s} {st.get("providerId")} {st.get("mode")}')
check('ai', 'tools carry a danger flag', any(t.get('dangerous') is True for t in st.get('tools', []))
      and any(t.get('dangerous') is False for t in st.get('tools', [])), f'{len(st.get("tools", []))} tools')

s, sess, _ = call('POST', '/v1/ai/sessions', {})
sid_ai = sess.get('id') if s == 201 else None
check('ai', 'create a conversation', bool(sid_ai) and sess.get('title') == 'New conversation', f'{s} {sess}')

if sid_ai:
    s, r, _ = call('POST', '/v1/ai/chat', {'messages': [{'role': 'user', 'content': '列出所有集合'}], 'sessionId': sid_ai})
    check('ai', 'a turn runs tools and answers', s == 200 and r.get('text') and r.get('traces'), f'{s} {str(r)[:120]}')

    s, sid_data, _ = call('GET', f'/v1/ai/sessions/{sid_ai}')
    msgs = sid_data.get('messages', [])
    check('ai', 'user + assistant turns are persisted', len(msgs) == 2 and sid_data['session']['title'] != 'New conversation',
          f'{len(msgs)} msgs, title={sid_data["session"]["title"]!r}')
    check('ai', 'tool trace survives the round trip', bool(msgs and msgs[-1].get('traces')), f'{msgs[-1].get("traces") if msgs else None}')

    s, r, _ = call('PATCH', f'/v1/ai/sessions/{sid_ai}', {'title': 'Renamed thread'})
    check('ai', 'rename a conversation', s == 200 and r.get('title') == 'Renamed thread', f'{s} {r}')

    s, r, _ = call('DELETE', f'/v1/ai/sessions/{sid_ai}')
    check('ai', 'delete a conversation', s == 200 and r.get('ok') is True, f'{s} {r}')

    s, r, _ = call('GET', f'/v1/ai/sessions/{sid_ai}')
    check('ai', 'deleted conversation is gone', s == 404, f'{s} {r}')

# RBAC must hold for the agent too: the tool list is filtered, and an
# out-of-role write is refused before it reaches the store.
s, vst, _ = call('GET', '/v1/ai/status', act_as='viewer')
vnames = [t['name'] for t in vst.get('tools', [])]
check('ai', 'viewer tool list excludes writes', s == 200 and 'delete_collection' not in vnames and 'list_collections' in vnames,
      f'{s} {len(vnames)} tools')

s, vr, _ = call('POST', '/v1/ai/chat', {'messages': [{'role': 'user', 'content': '删除 Notes 集合'}]}, act_as='viewer')
check('ai', 'viewer cannot delete through the agent',
      s == 200 and ('缺少权限' in str(vr.get('text', '')) or 'Missing permission' in str(vr.get('text', ''))),
      str(vr.get('text', ''))[:140])


# ------------------------------------------------------------ 14 sso / idp
# 登录流程本身由 scripts/sso-e2e.mjs 对着真实 IdP 跑；这里只钉住接口契约与权限边界。
s, r, _ = call('POST', '/v1/auth/sso/config', {'type': 'oidc', 'name': 'smoke'})
check('sso', 'missing fields name the field', s == 400 and 'clientId' in str(r.get('error', '')), f'{s} {r}')

s, idp, _ = call('POST', '/v1/auth/sso/config', {
    'type': 'oidc', 'name': 'smoke-oidc', 'defaultRole': 'viewer',
    # discovery 关掉 + 写死端点：这样 /start 不需要真的联网，断言保持确定性
    'config': {
        'issuer': 'https://idp.example.test', 'clientId': 'studio', 'clientSecret': 'smoke-secret-4571',
        'discovery': False,
        'authorizeUrl': 'https://idp.example.test/authorize',
        'tokenUrl': 'https://idp.example.test/token',
        'jwksUri': 'https://idp.example.test/jwks',
    },
})
idp_id = idp.get('id') if s == 201 else None
check('sso', 'create an OIDC provider', s == 201 and idp_id, f'{s} {idp}')
check('sso', 'client secret is masked, never echoed',
      'smoke-secret-4571' not in json.dumps(idp) and idp.get('secrets', {}).get('clientSecret', {}).get('set') is True,
      json.dumps(idp.get('secrets')))

if idp_id:
    s, lst, _ = call('GET', '/v1/auth/sso/config')
    row = next((p for p in lst.get('providers', []) if p['id'] == idp_id), {})
    check('sso', 'config list omits the secret', s == 200 and 'smoke-secret-4571' not in json.dumps(lst), f'{s}')

    s, pub, _ = call('GET', '/v1/auth/sso/providers')
    entry = next((p for p in pub.get('providers', []) if p['id'] == idp_id), {})
    check('sso', 'login page sees name and type only',
          entry.get('name') == 'smoke-oidc' and set(entry.keys()) == {'id', 'type', 'name'}, f'{entry}')

    s, r, _ = call('GET', '/v1/auth/sso/config', act_as='developer')
    check('sso', 'developer cannot read identity providers', s == 403, f'{s} {r}')

    s, r, _ = call('PATCH', f'/v1/auth/sso/config/{idp_id}', {'enabled': False})
    check('sso', 'disable a provider', s == 200 and r.get('enabled') is False, f'{s}')

    s, pub2, _ = call('GET', '/v1/auth/sso/providers')
    check('sso', 'disabled provider leaves the login page',
          not any(p['id'] == idp_id for p in pub2.get('providers', [])), f'{pub2}')

    s, r, _ = call('POST', f'/v1/auth/sso/{idp_id}/start', {})
    check('sso', 'disabled provider cannot start a login', s == 404, f'{s} {r}')

    s, r, _ = call('PATCH', f'/v1/auth/sso/config/{idp_id}', {'enabled': True, 'name': 'smoke-renamed'})
    check('sso', 'rename and re-enable', s == 200 and r.get('name') == 'smoke-renamed', f'{s}')

    s, r, _ = call('POST', f'/v1/auth/sso/{idp_id}/start', {})
    check('sso', 'start returns a state and an authorize URL',
          s == 200 and len(str(r.get('state', ''))) > 20 and str(r.get('url', '')).startswith('https://idp.example.test'),
          f'{s} {str(r.get("url"))[:80]}')

    s, r, _ = call('POST', '/v1/auth/sso/config', {
        'type': 'ldap', 'name': 'smoke-ldap',
        'config': {'url': 'ldap://127.0.0.1:1', 'baseDn': 'dc=x', 'userFilter': 'uid={{username}}'},
    })
    check('sso', 'userFilter must be a full filter', s == 400 and 'userFilter' in str(r.get('error', '')), f'{s} {r}')

    s, r, _ = call('POST', '/v1/auth/sso/config', {'type': 'saml', 'name': 'nope'})
    check('sso', 'unknown provider type is refused', s == 400, f'{s} {r}')

    s, r, _ = call('DELETE', f'/v1/auth/sso/config/{idp_id}')
    check('sso', 'delete a provider', s == 200 and r.get('ok') is True, f'{s}')


# -------------------------------------------------------------- 15 mfa / 2fa
# 完整流程（含 Passkey 与强制注册）由 scripts/mfa-e2e.mjs / passkey-e2e.mjs 覆盖；
# 这里只钉住接口契约与权限边界。
s, r, _ = call('GET', '/v1/auth/mfa')
before_methods = len(r.get('methods') or []) if s == 200 else -1
check('mfa', 'status is readable', s == 200 and 'recoveryCodesLeft' in r, f'{s} {r}')

s, r, _ = call('POST', '/v1/auth/mfa/totp/begin', {'name': 'smoke'})
secret = r.get('secret') if s == 201 else None
mfa_mid = r.get('methodId') if s == 201 else None
check('mfa', 'totp enrollment returns a secret and an otpauth URI',
      s == 201 and bool(secret) and str(r.get('uri', '')).startswith('otpauth://totp/'), f'{s} {str(r)[:120]}')

s, r, _ = call('POST', '/v1/auth/mfa/totp/confirm', {'methodId': mfa_mid, 'code': '000000'})
check('mfa', 'a wrong code cannot confirm enrollment', s == 400, f'{s}')

s, r, _ = call('POST', '/v1/auth/mfa/totp/confirm', {'methodId': mfa_mid, 'code': totp(secret) if secret else '000000'})
codes = (r.get('recoveryCodes') or []) if s == 200 else []
check('mfa', 'confirmation issues ten recovery codes', s == 200 and len(codes) == 10, f'{s} {str(r)[:120]}')

s, r, _ = call('GET', '/v1/auth/mfa')
check('mfa', 'the method is now verified',
      s == 200 and len(r.get('methods') or []) == before_methods + 1, f'{s} {r.get("verifiedMethods")}')

s, r, _ = call('PUT', '/v1/auth/mfa/policies', {'policies': []}, act_as='developer')
check('mfa', 'a developer cannot change the policy', s == 403, f'{s}')

s, r, _ = call('GET', '/v1/auth/mfa/policies', act_as='viewer')
check('mfa', 'a viewer cannot read the policy', s == 403, f'{s}')

s, r, _ = call('PUT', '/v1/auth/mfa/policies', {'policies': [{'scope': 'role', 'target': 'wizard', 'mode': 'required'}]})
check('mfa', 'an unknown role is refused', s == 400, f'{s} {str(r)[:100]}')

s, r, _ = call('PUT', '/v1/auth/mfa/policies', {'policies': [
    {'scope': 'role', 'target': 'owner', 'mode': 'required'},
    {'scope': 'role', 'target': 'owner', 'mode': 'exempt'},
]})
check('mfa', 'duplicate rules are refused', s == 400, f'{s} {str(r)[:100]}')

s, r, _ = call('PUT', '/v1/auth/mfa/policies', {'policies': [{'scope': 'role', 'target': 'owner', 'mode': 'required'}]})
check('mfa', 'a valid policy is saved', s == 200 and len(r.get('policies') or []) == 1, f'{s}')

s, r, _ = call('POST', '/v1/account/sessions', {'email': 'alex@aurora.io', 'password': 'aurora-demo'})
challenge = r.get('challenge') if isinstance(r, dict) else None
check('mfa', 'sign-in now returns a challenge, not a session',
      s == 201 and r.get('mfaRequired') is True and bool(challenge) and 'secret' not in r, f'{s} {str(r)[:120]}')

s, r, _ = call('POST', '/v1/auth/mfa/verify', {'challenge': challenge, 'code': '000000'})
check('mfa', 'a wrong code is rejected', s == 401, f'{s}')

# 绑定那一步已经用掉了当前步长，这里用下一窗口（服务端允许 ±1 的时钟漂移）
next_code = totp(secret, time.time() + 30) if secret else '000000'
s, r, _ = call('POST', '/v1/auth/mfa/verify', {'challenge': challenge, 'code': next_code})
check('mfa', 'a valid code yields a multi-factor session',
      s == 200 and r.get('assurance') == 'multi' and bool(r.get('secret')), f'{s} {str(r)[:120]}')

s2, r2, _ = call('POST', '/v1/account/sessions', {'email': 'alex@aurora.io', 'password': 'aurora-demo'})
s, r, _ = call('POST', '/v1/auth/mfa/verify', {'challenge': r2.get('challenge') if isinstance(r2, dict) else None, 'code': next_code})
check('mfa', 'the same code cannot be used twice', s == 401, f'{s}')

s, r, _ = call('POST', '/v1/auth/mfa/verify', {'challenge': 'not-a-real-challenge', 'code': '123456'})
check('mfa', 'an unknown challenge is refused', s in (401, 410), f'{s}')

s, r, _ = call('GET', '/v1/auth/mfa/challenge/not-a-real-challenge')
check('mfa', 'an unknown challenge lookup is 410', s == 410, f'{s}')

s, r, _ = call('PUT', '/v1/auth/mfa/policies', {'policies': []})
if mfa_mid:
    call('DELETE', f'/v1/auth/mfa/methods/{mfa_mid}')

_srv.shutdown()

# ------------------------------------------------------------------ cleanup
# Users are global (not project-scoped), so they do not disappear with the project.
for path in [f'/v1/users/{uid_}' if uid_ else None,
             f'/v1/users/{muid}' if muid else None,
             f'/v1/databases/collections/{bcid}' if bcid else None,
             f'/v1/functions/{fnid}' if fnid else None,
             f'/v1/functions/{pyfnid}' if pyfnid else None,
             f'/v1/functions/{legacy_id}' if legacy_id else None,
             f'/v1/sites/{sid}' if sid else None,
             f'/v1/storage/buckets/{bid}' if bid else None,
             f'/v1/databases/collections/{cid}' if cid else None,
             f'/v1/projects/{pid}' if pid else None]:
    if path: call('DELETE', path)

fails = [r for r in results if not r['ok']]
warns = [r for r in results if r.get('warn')]
print(f"\n=== {len(results)} checks · {len(fails)} failed · {len(warns)} warnings ===")
json.dump(results, open('/tmp/api-smoke-result.json', 'w'), ensure_ascii=False, indent=1)
sys.exit(1 if fails else 0)
