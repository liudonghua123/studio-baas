#!/usr/bin/env python3
"""Studio BaaS 深度 API 巡检：按 Appwrite 语义逐项验证，记录偏差。

用法：pnpm dev 起服务后 `python3 scripts/api-smoke.py`；
退出码非 0 表示有断言失败，可直接接进 CI。
"""
import json, urllib.request, urllib.error, urllib.parse, uuid, sys, time

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
call('POST', '/v1/users', {'email': email, 'name': 'Deep Member', 'password': 'Passw0rd!'})
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

    big = b'x' * (6 * 1024 * 1024)
    s, fb, _ = call('POST', f'/v1/storage/buckets/{bid}/files', raw=big, ctype='application/octet-stream',
                    headers={'x-filename': 'big.bin', 'content-type': 'application/octet-stream'})
    check('storage', 'bucket max size enforced', s in (400, 413), f'{s} {str(fb)[:120]}')
    if s in (200, 201):
        note('storage', 'maxFileSize not enforced', f'bucket says 5MB, accepted 6MB (status {s})')

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

# ------------------------------------------------------------------ cleanup
for path in [f'/v1/functions/{fnid}' if fnid else None,
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
