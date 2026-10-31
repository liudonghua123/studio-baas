import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now, uid, UPLOAD_DIR } from './db.js';
import { nextRun } from './cron.js';

/* --------------------------------------------------------------- helpers */

const svgArt = (a: string, b: string, label: string, shape: 'orb' | 'wave' | 'grid' | 'ring', i: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
  <radialGradient id="r" cx="30%" cy="25%" r="80%"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <filter id="blur"><feGaussianBlur stdDeviation="28"/></filter>
</defs>
<rect width="800" height="800" fill="url(#g)"/>
<g filter="url(#blur)" opacity=".55">
  <circle cx="620" cy="180" r="180" fill="#ffffff" opacity=".35"/>
  <circle cx="180" cy="650" r="200" fill="#000000" opacity=".18"/>
</g>
${shape === 'orb' ? `<circle cx="400" cy="380" r="200" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2"/><circle cx="400" cy="380" r="120" fill="rgba(255,255,255,.22)"/>` : ''}
${shape === 'wave' ? `<path d="M-40 470 C 160 330, 300 610, 470 470 S 720 330, 860 470" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="3"/><path d="M-40 540 C 160 400, 300 680, 470 540 S 720 400, 860 540" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="2"/>` : ''}
${shape === 'grid' ? `<g stroke="rgba(255,255,255,.22)">${Array.from({ length: 7 }, (_, k) => `<line x1="${90 + k * 100}" y1="120" x2="${90 + k * 100}" y2="680"/>`).join('')}${Array.from({ length: 7 }, (_, k) => `<line x1="90" y1="${120 + k * 90}" x2="710" y2="${120 + k * 90}"/>`).join('')}</g><rect x="300" y="280" width="200" height="200" rx="36" fill="rgba(255,255,255,.22)"/>` : ''}
${shape === 'ring' ? `<g fill="none" stroke="rgba(255,255,255,.5)"><circle cx="400" cy="400" r="230" stroke-width="1.5"/><circle cx="400" cy="400" r="170" stroke-width="1.5"/><circle cx="400" cy="400" r="110" stroke-width="1.5"/></g><circle cx="400" cy="400" r="60" fill="rgba(255,255,255,.5)"/>` : ''}
<text x="60" y="720" font-family="ui-sans-serif,Inter,system-ui" font-size="34" font-weight="700" fill="rgba(255,255,255,.92)" letter-spacing="-1">${label}</text>
<text x="60" y="756" font-family="ui-monospace,monospace" font-size="18" fill="rgba(255,255,255,.65)">AURORA / ${String(i).padStart(2, '0')}</text>
</svg>`;

/* ------------------------------------------------------------ seed flags */

export function seed() {
  const project = db.prepare('SELECT * FROM projects LIMIT 1').get() as any;
  if (project) return false;

  db.prepare(`INSERT INTO projects (id,name,key,region,plan,status,color,description,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'studio', 'Aurora Commerce', 'aurora-commerce', 'fra', 'pro', 'active', '#fd366e',
    'Storefront, catalog and checkout services for the Aurora retail brand.', now(), now(),
  );
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('ai_model', 'deepseek-chat');

  /* --------------------------------------------------------- collections */
  const cols = [
    { id: 'col_products', name: 'Products', key: 'products', icon: 'package', color: '#6C5CE7' },
    { id: 'col_orders', name: 'Orders', key: 'orders', icon: 'shopping-bag', color: '#FD366E' },
    { id: 'col_customers', name: 'Customers', key: 'customers', icon: 'users', color: '#00B894' },
    { id: 'col_posts', name: 'Posts', key: 'posts', icon: 'file-text', color: '#0984E3' },
  ];
  for (const c of cols) {
    db.prepare('INSERT INTO collections (id,name,key,icon,color,documentSecurity,enabled,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(c.id, c.name, c.key, c.icon, c.color, 0, 1, now(), now());
  }

  const attr = (col: string, key: string, type: string, required = 0, extra: Partial<{ size: number; elements: string[]; array: boolean }> = {}) => {
    db.prepare('INSERT INTO attributes (id,collectionId,key,type,required,array,size,defaultVal,elements,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid('attr_'), col, key, type, required, extra.array ? 1 : 0, extra.size ?? null, null,
        JSON.stringify(extra.elements ?? []), now());
  };

  attr('col_products', 'name', 'string', 1, { size: 128 });
  attr('col_products', 'sku', 'string', 1, { size: 32 });
  attr('col_products', 'price', 'float', 1);
  attr('col_products', 'stock', 'integer', 1);
  attr('col_products', 'category', 'enum', 1, { elements: ['Apparel', 'Accessories', 'Home', 'Audio'] });
  attr('col_products', 'status', 'enum', 1, { elements: ['active', 'draft', 'archived'] });
  attr('col_products', 'description', 'text');
  attr('col_products', 'image', 'string');

  attr('col_orders', 'customer', 'string', 1);
  attr('col_orders', 'email', 'email', 1);
  attr('col_orders', 'total', 'float', 1);
  attr('col_orders', 'items', 'integer', 1);
  attr('col_orders', 'status', 'enum', 1, { elements: ['pending', 'paid', 'shipped', 'refunded'] });
  attr('col_orders', 'notes', 'text');

  attr('col_customers', 'name', 'string', 1);
  attr('col_customers', 'email', 'email', 1);
  attr('col_customers', 'tier', 'enum', 1, { elements: ['free', 'plus', 'pro'] });
  attr('col_customers', 'country', 'string');
  attr('col_customers', 'ltv', 'float');
  attr('col_customers', 'joined', 'datetime');

  attr('col_posts', 'title', 'string', 1);
  attr('col_posts', 'slug', 'string', 1);
  attr('col_posts', 'author', 'string', 1);
  attr('col_posts', 'status', 'enum', 1, { elements: ['published', 'draft'] });
  attr('col_posts', 'views', 'integer');
  attr('col_posts', 'excerpt', 'text');

  /* -------------------------------------------------------------- buckets */
  db.prepare('INSERT INTO buckets (id,name,maxFileSize,allowedExtensions,compression,encryption,imageTransform,createdAt) VALUES (?,?,?,?,?,?,?,?)')
    .run('bkt_media', 'Product media', 10485760, JSON.stringify(['png', 'jpg', 'jpeg', 'svg', 'webp']), 'gzip', 1, 1, now());
  db.prepare('INSERT INTO buckets (id,name,maxFileSize,allowedExtensions,compression,encryption,imageTransform,createdAt) VALUES (?,?,?,?,?,?,?,?)')
    .run('bkt_docs', 'Documents', 5242880, JSON.stringify(['pdf', 'md', 'txt']), 'none', 1, 0, now());

  /* ---------------------------------------------------------------- files */
  const arts: [string, string, string, 'orb' | 'wave' | 'grid' | 'ring'][] = [
    ['#FDCB6E', '#E17055', 'Sunset Hoodie', 'wave'],
    ['#6C5CE7', '#00CEC9', 'Nebula Lamp', 'orb'],
    ['#FD366E', '#6C5CE7', 'Pulse Speaker', 'ring'],
    ['#00B894', '#0984E3', 'Tidal Bottle', 'grid'],
    ['#E17055', '#FDCB6E', 'Clay Mug Set', 'orb'],
    ['#0984E3', '#6C5CE7', 'Aurora Tote', 'wave'],
  ];
  const fileIds: string[] = [];
  arts.forEach(([a, b, label, shape], i) => {
    const id = 'file_art' + (i + 1);
    const svg = svgArt(a, b, label, shape, i + 1);
    const p = path.join(UPLOAD_DIR, id + '.svg');
    fs.writeFileSync(p, svg);
    db.prepare('INSERT INTO files (id,bucketId,name,mimeType,size,path,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'bkt_media', label.toLowerCase().replace(/\s+/g, '-') + '.svg', 'image/svg+xml', svg.length, p,
        new Date(Date.now() - (i + 1) * 3600_000).toISOString());
    fileIds.push(id);
  });

  /* ------------------------------------------------------------ documents */
  const products = [
    ['Aurora Hoodie', 'AUR-HD-001', 148, 42, 'Apparel', 'active', 'Heavyweight organic cotton hoodie with tonal embroidery.'],
    ['Nebula Desk Lamp', 'AUR-LP-002', 219, 18, 'Home', 'active', 'Dimmable ambient lamp with a hand-blown glass orb.'],
    ['Pulse Speaker', 'AUR-SP-003', 329, 7, 'Audio', 'active', '360° sound with a machined aluminium body.'],
    ['Tidal Bottle', 'AUR-BT-004', 54, 120, 'Accessories', 'active', 'Vacuum insulated bottle, 24h cold / 12h hot.'],
    ['Clay Mug Set', 'AUR-MG-005', 72, 34, 'Home', 'active', 'Set of two stoneware mugs with reactive glaze.'],
    ['Aurora Tote', 'AUR-TT-006', 96, 61, 'Accessories', 'active', 'Waxed canvas tote with leather handles.'],
    ['Studio Cap', 'AUR-CP-007', 42, 0, 'Apparel', 'archived', 'Six-panel cap with a woven tonal label.'],
    ['Drift Runner', 'AUR-SH-008', 186, 22, 'Apparel', 'active', 'Everyday trainer with a recycled knit upper.'],
    ['Orbit Stand', 'AUR-ST-009', 88, 15, 'Accessories', 'draft', 'Magnetic stand for phone and tablet.'],
    ['Halo Charger', 'AUR-CH-010', 129, 48, 'Audio', 'active', '15W wireless charging pad with braided cable.'],
    ['Lumen Diffuser', 'AUR-DF-011', 114, 9, 'Home', 'active', 'Ultrasonic diffuser with a 6-hour reservoir.'],
    ['Echo Cable', 'AUR-CB-012', 28, 210, 'Accessories', 'active', 'USB-C to USB-C, 100W, 2m braided.'],
  ];
  const insDoc = db.prepare('INSERT INTO documents (id,collectionId,data,permissions,createdAt,updatedAt) VALUES (?,?,?,?,?,?)');
  products.forEach((p, i) => {
    const t = new Date(Date.now() - (products.length - i) * 86400_000 * 2).toISOString();
    insDoc.run(uid('doc_'), 'col_products', JSON.stringify({
      name: p[0], sku: p[1], price: p[2], stock: p[3], category: p[4], status: p[5],
      description: p[6], image: fileIds[i % fileIds.length],
    }), JSON.stringify(['read("any")', 'update("users")', 'delete("users")']), t, t);
  });

  const orders = [
    ['Mia Fischer', 'mia@northwind.io', 476, 3, 'paid', 'Express shipping'],
    ['Lukas Brandt', 'lukas@fieldkit.co', 219, 1, 'shipped', ''],
    ['Ava Laurent', 'ava@studioform.fr', 96, 1, 'paid', 'Gift wrap'],
    ['Noah Weber', 'noah@weber.dev', 858, 4, 'pending', 'Invoice to company'],
    ['Sofia Rossi', 'sofia@atelier.it', 54, 1, 'refunded', 'Damaged in transit'],
    ['Elias Novak', 'elias@nova.cz', 329, 1, 'paid', ''],
    ['Emma Jensen', 'emma@fjord.dk', 300, 2, 'shipped', 'Leave at reception'],
    ['Jonas Meyer', 'jonas@meyer.de', 186, 1, 'paid', ''],
  ];
  orders.forEach((o, i) => {
    const t = new Date(Date.now() - i * 36 * 3600_000).toISOString();
    insDoc.run(uid('doc_'), 'col_orders', JSON.stringify({
      customer: o[0], email: o[1], total: o[2], items: o[3], status: o[4], notes: o[5],
    }), JSON.stringify(['read("users")', 'update("users")', 'delete("users")']), t, t);
  });

  const customers = [
    ['Mia Fischer', 'mia@northwind.io', 'pro', 'Germany', 4820],
    ['Lukas Brandt', 'lukas@fieldkit.co', 'plus', 'Austria', 1260],
    ['Ava Laurent', 'ava@studioform.fr', 'plus', 'France', 2140],
    ['Noah Weber', 'noah@weber.dev', 'free', 'Germany', 380],
    ['Sofia Rossi', 'sofia@atelier.it', 'pro', 'Italy', 6310],
    ['Elias Novak', 'elias@nova.cz', 'free', 'Czechia', 129],
  ];
  customers.forEach((c, i) => {
    const t = new Date(Date.now() - (i + 2) * 86400_000 * 30).toISOString();
    insDoc.run(uid('doc_'), 'col_customers', JSON.stringify({
      name: c[0], email: c[1], tier: c[2], country: c[3], ltv: c[4], joined: t.slice(0, 10),
    }), JSON.stringify(['read("users")', 'update("users")', 'delete("users")']), t, t);
  });

  const posts = [
    ['Designing for calm interfaces', 'designing-for-calm', 'Ava Laurent', 'published', 2841],
    ['Behind the Aurora Hoodie', 'behind-the-hoodie', 'Mia Fischer', 'published', 1912],
    ['The 2026 material report', 'material-report-2026', 'Noah Weber', 'draft', 0],
  ];
  posts.forEach((p, i) => {
    const t = new Date(Date.now() - (i + 1) * 86400_000 * 5).toISOString();
    insDoc.run(uid('doc_'), 'col_posts', JSON.stringify({
      title: p[0], slug: p[1], author: p[2], status: p[3], views: p[4],
      excerpt: 'Notes from the studio on building products that feel quiet, useful and enduring.',
    }), JSON.stringify(['read("any")', 'update("users")', 'delete("users")']), t, t);
  });

  /* ------------------------------------------------------------- functions */
  const fnOrder = `export default async ({ req, res, log, error, databases, env }) => {
  const body = req.body || {};
  log('Received order webhook', body);

  if (!body.email || !Array.isArray(body.items) || body.items.length === 0) {
    error('Invalid payload: email and items[] are required');
    return res.json({ ok: false, message: 'email and items[] are required' });
  }

  const subtotal = body.items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1), 0);
  const tier = body.tier || 'free';
  const discountRate = tier === 'pro' ? 0.15 : tier === 'plus' ? 0.08 : 0;
  const total = Math.round(subtotal * (1 - discountRate) * 100) / 100;

  const doc = databases.createDocument('orders', {
    customer: body.customer || 'Guest',
    email: body.email,
    total,
    items: body.items.length,
    status: 'pending',
    notes: discountRate > 0 ? 'Applied ' + discountRate * 100 + '% ' + tier + ' discount' : '',
  });

  log('Order created:', doc.id, 'total:', total);

  return res.json({
    ok: true,
    orderId: doc.id,
    subtotal,
    discountRate,
    total,
    currency: env.CURRENCY || 'EUR',
    processedAt: new Date().toISOString(),
  });
};`;

  const fnStats = `export default async ({ res, log, databases }) => {
  const products = databases.listDocuments('products', { limit: 100 });
  const orders = databases.listDocuments('orders', { limit: 100 });

  const revenue = orders.documents.reduce((sum, o) => sum + Number(o.data.total || 0), 0);
  const lowStock = products.documents
    .filter((p) => Number(p.data.stock) < 10)
    .map((p) => ({ name: p.data.name, stock: p.data.stock }));

  const byCategory = products.documents.reduce((acc, p) => {
    acc[p.data.category] = (acc[p.data.category] || 0) + 1;
    return acc;
  }, {});

  log('Aggregated', products.total, 'products and', orders.total, 'orders');

  return res.json({
    revenue: Math.round(revenue * 100) / 100,
    orders: orders.total,
    products: products.total,
    lowStock,
    byCategory,
  });
};`;

  const fnHealth = `import { randomUUID } from 'node:crypto';

export default async ({ req, res, log, env }) => {
  const started = Date.now();
  const id = randomUUID();

  log('Health probe', id);
  log('Region:', env.REGION || 'fra');

  return res.json({
    id,
    status: 'healthy',
    region: env.REGION || 'fra',
    runtime: 'node-22',
    uptimeMs: Date.now() - started,
    requestId: req.headers['x-request-id'] || null,
  });
};`;

  const fns: [string, string, string, string, Record<string, string>, string][] = [
    ['Order webhook', 'fn_order', fnOrder, '0 */6 * * *', { CURRENCY: 'EUR', REGION: 'fra' }, 'Validates incoming orders, applies tier discounts and writes them to the Orders collection.'],
    ['Store analytics', 'fn_stats', fnStats, '', { REGION: 'fra' }, 'Aggregates revenue, order volume and low-stock products across collections.'],
    ['Health probe', 'fn_health', fnHealth, '*/15 * * * *', { REGION: 'fra', LOG_LEVEL: 'info' }, 'Lightweight uptime probe used by the status page.'],
  ];
  for (const [name, id, code, schedule, env, description] of fns) {
    const t = new Date(Date.now() - Math.random() * 5 * 86400_000).toISOString();
    db.prepare(`INSERT INTO functions (id,name,runtime,entrypoint,code,schedule,timeout,env,enabled,executeAccess,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, name, 'node-22', 'src/main.js', code, schedule, 15, JSON.stringify(env), 1, 'any', t, t,
    );
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING')
      .run('fn_desc_' + id, description);
  }

  /* ---------------------------------------------------------------- sites */
  const siteFiles = siteSeed();
  const t0 = new Date(Date.now() - 12 * 86400_000).toISOString();
  db.prepare(`INSERT INTO sites (id,name,framework,domain,entrypoint,buildCommand,files,status,buildLogs,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'site_aurora', 'aurora-storefront', 'static', 'aurora.studio.app', 'index.html', 'vite build',
    JSON.stringify(siteFiles), 'ready',
    JSON.stringify(['✓ 4 files uploaded', '✓ Build completed in 1.24s', '✓ Live at aurora.studio.app']), t0, now(),
  );

  const t1 = new Date(Date.now() - 6 * 86400_000).toISOString();
  db.prepare(`INSERT INTO sites (id,name,framework,domain,entrypoint,buildCommand,files,status,buildLogs,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'site_docs', 'product-docs', 'static', 'docs.studio.app', 'index.html', 'vite build',
    JSON.stringify([{ path: 'index.html', content: '<!doctype html><html><head><meta charset="utf-8"><title>Docs</title><style>body{font-family:ui-sans-serif,system-ui;background:#0b0b0f;color:#e7e7ee;padding:64px;max-width:760px;margin:auto}h1{font-size:44px;letter-spacing:-.03em}code{background:#1b1b24;padding:2px 6px;border-radius:6px}</style></head><body><h1>Product API</h1><p>Query your collections over REST with <code>/v1/databases/collections/:id/documents</code>.</p><p>Tip: open the Sites editor and change this page live.</p></body></html>' }]),
    'ready', JSON.stringify(['✓ Deployed']), t1, t1,
  );

  /* ---------------------------------------------------------------- users */
  const usersData = [
    ['Mia Fischer', 'mia@northwind.io', 'active', 1, ['vip', 'beta']],
    ['Lukas Brandt', 'lukas@fieldkit.co', 'active', 1, ['beta']],
    ['Ava Laurent', 'ava@studioform.fr', 'active', 1, ['design']],
    ['Noah Weber', 'noah@weber.dev', 'unverified', 0, []],
    ['Sofia Rossi', 'sofia@atelier.it', 'active', 1, ['vip']],
    ['Elias Novak', 'elias@nova.cz', 'blocked', 1, []],
  ];
  usersData.forEach((u, i) => {
    const t = new Date(Date.now() - (i + 1) * 12 * 86400_000).toISOString();
    db.prepare('INSERT INTO users (id,name,email,passwordHash,status,emailVerified,labels,prefs,createdAt,lastLoginAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid('usr_'), u[0] as string, u[1] as string,
        crypto.scryptSync('aurora-demo', 'studio-salt', 32).toString('hex'),
        u[2] as string, u[3] as number, JSON.stringify(u[4]), JSON.stringify({ theme: 'dark' }), t,
        new Date(Date.now() - i * 3600_000 * 6).toISOString());
  });

  /* ------------------------------------------------------------- messages */
  const msgs = [
    ['email', 'mia@northwind.io', 'Your order shipped', 'Order #1042 is on its way.'],
    ['push', 'lukas@fieldkit.co', 'Back in stock', 'The Nebula Desk Lamp is available again.'],
    ['sms', '+4915112345678', '', 'Your verification code is 481923.'],
  ];
  msgs.forEach((m, i) => {
    db.prepare('INSERT INTO messages (id,channel,recipient,subject,body,status,createdAt) VALUES (?,?,?,?,?,?,?)').run(
      uid('msg_'), m[0], m[1], m[2], m[3], i === 2 ? 'delivered' : 'sent',
      new Date(Date.now() - i * 5 * 3600_000).toISOString(),
    );
  });

  /* -------------------------------------------------------------- api keys */
  db.prepare('INSERT INTO apiKeys (id,name,scopes,secret,lastUsedAt,createdAt) VALUES (?,?,?,?,?,?)').run(
    'key_web', 'Storefront (web)', JSON.stringify(['databases.read', 'databases.write', 'storage.read']),
    'standard_' + crypto.randomBytes(12).toString('hex'),
    new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 20 * 86400_000).toISOString(),
  );

  /* ------------------------------------------------------- historical logs */
  const paths = [
    ['GET', '/v1/databases/collections/products/documents', 'databases', 200],
    ['POST', '/v1/databases/collections/orders/documents', 'databases', 201],
    ['GET', '/v1/storage/buckets/bkt_media/files', 'storage', 200],
    ['POST', '/v1/functions/fn_order/executions', 'functions', 200],
    ['GET', '/v1/users', 'auth', 200],
    ['POST', '/v1/account/sessions', 'auth', 201],
    ['GET', '/v1/sites/site_aurora', 'sites', 200],
    ['POST', '/v1/messaging/messages', 'messaging', 201],
    ['GET', '/v1/databases/collections/posts/documents', 'databases', 200],
    ['POST', '/v1/functions/fn_stats/executions', 'functions', 200],
  ];
  const insertLog = db.prepare('INSERT INTO logs (id,method,path,status,duration,service,ip,createdAt) VALUES (?,?,?,?,?,?,?,?)');
  for (let d = 13; d >= 0; d--) {
    const dayBase = 420 + Math.round(Math.sin(d / 2) * 120) + (13 - d) * 18;
    const count = d === 0 ? Math.round(dayBase * 0.55) : dayBase;
    for (let k = 0; k < count; k++) {
      const p = paths[Math.floor(Math.random() * paths.length)];
      const err = Math.random() < 0.012;
      const ts = new Date(Date.now() - d * 86400_000 + Math.floor(Math.random() * 20 * 3600_000)).toISOString();
      insertLog.run(uid('log_'), p[0], p[1], err ? (Math.random() < 0.5 ? 500 : 404) : p[3],
        Math.round(8 + Math.random() * 90), p[2], '10.0.' + Math.floor(Math.random() * 255) + '.' + Math.floor(Math.random() * 255), ts);
    }
  }

  /* ---------------------------------------------------------- executions */
  const execIns = db.prepare('INSERT INTO executions (id,functionId,status,triggerType,duration,logs,response,errors,createdAt) VALUES (?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 18; i++) {
    const fnId = ['fn_order', 'fn_stats', 'fn_health'][i % 3];
    const failed = i === 7;
    execIns.run(uid('exec_'), fnId, failed ? 'failed' : 'completed', i % 3 === 0 ? 'schedule' : 'manual',
      Math.round(30 + Math.random() * 220),
      JSON.stringify(failed ? ['Function invoked', 'ERROR upstream timeout'] : ['Function invoked', 'Completed successfully']),
      JSON.stringify(failed ? null : { ok: true }), failed ? JSON.stringify(['upstream timeout']) : JSON.stringify([]),
      new Date(Date.now() - i * 3 * 3600_000).toISOString());
  }

  return true;
}

/* ------------------------------------------------------------ site content */

function siteSeed() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Aurora — Everyday objects, quietly extraordinary</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="grain"></div>
  <header class="nav">
    <a class="brand" href="#"><span class="dot"></span> aurora</a>
    <nav>
      <a href="#shop">Shop</a>
      <a href="#story">Story</a>
      <a href="#news">Journal</a>
    </nav>
    <button class="cart" id="cart">Bag <span id="count">0</span></button>
  </header>

  <section class="hero">
    <p class="eyebrow">Collection 04 — Winter light</p>
    <h1>Everyday objects,<br /><em>quietly</em> extraordinary.</h1>
    <p class="lede">A small studio in Berlin making considered pieces for the home and the body. Built to be used, not admired from a shelf.</p>
    <div class="cta">
      <a class="btn primary" href="#shop">Explore the collection</a>
      <a class="btn ghost" href="#story">Our story →</a>
    </div>
    <div class="meta">
      <span>Free EU shipping</span><span>·</span><span>30-day returns</span><span>·</span><span>Made in small batches</span>
    </div>
  </section>

  <section id="shop" class="shop">
    <div class="section-head">
      <h2>Selected pieces</h2>
      <p>Six objects, one idea: less, but better.</p>
    </div>
    <div class="grid" id="grid"></div>
  </section>

  <section id="story" class="story">
    <div>
      <p class="eyebrow">The studio</p>
      <h2>We design for the<br />second glance.</h2>
    </div>
    <p>Everything begins with a material question. How does it age? How does it feel at 7am? We prototype slowly, produce in small runs, and keep every object repairable.</p>
  </section>

  <footer>
    <div class="brand"><span class="dot"></span> aurora</div>
    <p>© 2026 Aurora Studio — Berlin</p>
    <p class="tiny">Deployed with Appwrite Sites</p>
  </footer>

  <script src="app.js"></script>
</body>
</html>`;

  const css = `:root {
  --bg: #0a0a0c;
  --ink: #f4f2ee;
  --muted: #a0a0ab;
  --line: rgba(255,255,255,.12);
  --accent: #d8ff6b;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.grain { position: fixed; inset: 0; pointer-events: none; opacity: .22; z-index: 9;
  background-image: radial-gradient(rgba(255,255,255,.08) 1px, transparent 0);
  background-size: 3px 3px; }
.nav { display: flex; align-items: center; justify-content: space-between;
  padding: 26px 48px; border-bottom: 1px solid var(--line); position: sticky; top: 0;
  backdrop-filter: blur(18px); background: rgba(10,10,12,.72); z-index: 10; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -.02em;
  font-size: 20px; color: var(--ink); text-decoration: none; }
.dot { width: 12px; height: 12px; border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, #fff, var(--accent) 55%, #6b8f00);
  box-shadow: 0 0 18px rgba(216,255,107,.55); }
nav { display: flex; gap: 32px; }
nav a { color: var(--muted); text-decoration: none; font-size: 14px; transition: color .2s; }
nav a:hover { color: var(--ink); }
.cart { background: transparent; border: 1px solid var(--line); color: var(--ink);
  padding: 9px 16px; border-radius: 999px; font: inherit; font-size: 13px; cursor: pointer;
  transition: border-color .2s, background .2s; }
.cart:hover { border-color: var(--accent); }
.cart span { background: var(--accent); color: #0a0a0c; border-radius: 999px;
  padding: 1px 7px; margin-left: 6px; font-weight: 700; font-size: 11px; }
.hero { padding: 120px 48px 90px; max-width: 1100px; }
.eyebrow { text-transform: uppercase; letter-spacing: .18em; font-size: 11px;
  color: var(--accent); margin: 0 0 26px; }
h1 { font-size: clamp(46px, 7.2vw, 92px); line-height: .98; letter-spacing: -.045em;
  margin: 0 0 30px; font-weight: 600; }
h1 em { font-family: "Instrument Serif", Georgia, serif; font-style: italic; color: var(--accent); }
.lede { max-width: 520px; color: var(--muted); font-size: 17px; line-height: 1.65; margin: 0 0 38px; }
.cta { display: flex; gap: 14px; flex-wrap: wrap; }
.btn { text-decoration: none; padding: 14px 26px; border-radius: 999px; font-size: 14px;
  transition: transform .2s, background .2s, color .2s; display: inline-block; }
.btn.primary { background: var(--accent); color: #0a0a0c; font-weight: 600; }
.btn.primary:hover { transform: translateY(-2px); }
.btn.ghost { color: var(--ink); border: 1px solid var(--line); }
.btn.ghost:hover { background: rgba(255,255,255,.06); }
.meta { display: flex; gap: 12px; color: #6f6f7b; font-size: 12px; margin-top: 46px; }
.shop { padding: 40px 48px 100px; border-top: 1px solid var(--line); }
.section-head { display: flex; justify-content: space-between; align-items: baseline;
  gap: 20px; margin-bottom: 34px; flex-wrap: wrap; }
.section-head h2 { font-size: 30px; letter-spacing: -.03em; margin: 0; font-weight: 600; }
.section-head p { color: var(--muted); margin: 0; font-size: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 18px; }
.card { border: 1px solid var(--line); border-radius: 18px; overflow: hidden;
  background: #101014; transition: transform .25s, border-color .25s; cursor: pointer; }
.card:hover { transform: translateY(-4px); border-color: rgba(216,255,107,.45); }
.thumb { aspect-ratio: 1; background-size: cover; background-position: center; }
.card-body { padding: 16px 18px 20px; }
.card-body h3 { margin: 0 0 6px; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
.card-body p { margin: 0; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
.price { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
.price b { font-weight: 600; font-size: 15px; }
.add { background: rgba(255,255,255,.06); border: 0; color: var(--ink); border-radius: 999px;
  padding: 7px 13px; font-size: 12px; cursor: pointer; }
.add:hover { background: var(--accent); color: #0a0a0c; }
.story { display: grid; grid-template-columns: 1fr 1fr; gap: 60px; padding: 100px 48px;
  border-top: 1px solid var(--line); background: linear-gradient(180deg, #0a0a0c, #0e0e12); }
.story h2 { font-size: clamp(30px, 4vw, 52px); line-height: 1.02; letter-spacing: -.04em; margin: 0; }
.story p { color: var(--muted); line-height: 1.8; font-size: 16px; margin: 0; align-self: end; }
footer { display: flex; justify-content: space-between; align-items: center; gap: 20px;
  padding: 40px 48px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px;
  flex-wrap: wrap; }
footer .tiny { color: #55555f; }
@media (max-width: 760px) {
  .nav, .hero, .shop, .story, footer { padding-left: 22px; padding-right: 22px; }
  nav { display: none; }
  .story { grid-template-columns: 1fr; gap: 24px; }
}`;

  const js = `const products = [
  { name: "Aurora Hoodie", cat: "Apparel", price: 148, img: "linear-gradient(135deg,#FDCB6E,#E17055)" },
  { name: "Nebula Lamp", cat: "Home", price: 219, img: "linear-gradient(135deg,#6C5CE7,#00CEC9)" },
  { name: "Pulse Speaker", cat: "Audio", price: 329, img: "linear-gradient(135deg,#FD366E,#6C5CE7)" },
  { name: "Tidal Bottle", cat: "Accessories", price: 54, img: "linear-gradient(135deg,#00B894,#0984E3)" },
  { name: "Clay Mug Set", cat: "Home", price: 72, img: "linear-gradient(135deg,#E17055,#FDCB6E)" },
  { name: "Aurora Tote", cat: "Accessories", price: 96, img: "linear-gradient(135deg,#0984E3,#6C5CE7)" }
];

const grid = document.getElementById("grid");
const countEl = document.getElementById("count");
let count = 0;

products.forEach(function (p) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML =
    '<div class="thumb" style="background:' + p.img + '"></div>' +
    '<div class="card-body">' +
      '<h3>' + p.name + '</h3>' +
      '<p>' + p.cat + '</p>' +
      '<div class="price"><b>€' + p.price + '</b><button class="add">Add</button></div>' +
    '</div>';
  card.querySelector(".add").addEventListener("click", function (e) {
    e.stopPropagation();
    count += 1;
    countEl.textContent = String(count);
    countEl.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.5)" }, { transform: "scale(1)" }],
      { duration: 320, easing: "ease-out" }
    );
  });
  grid.appendChild(card);
});
`;
  return [
    { path: 'index.html', content: html },
    { path: 'styles.css', content: css },
    { path: 'app.js', content: js },
  ];
}

/* ------------------------------------------------- 第二个项目（多项目演示） */

/**
 * 演示"项目隔离"：Nebula Analytics 拥有自己的集合、函数、站点与桶，
 * 与 Aurora Commerce 的数据互不可见。老库也能安全补种（幂等）。
 */
export function seedDemoProject() {
  // 老库补全展示字段（幂等）
  db.prepare(`UPDATE projects SET description=? WHERE id='studio' AND (description IS NULL OR description='')`).run(
    'Storefront, catalog and checkout services for the Aurora retail brand.',
  );
  if (db.prepare('SELECT 1 FROM projects WHERE id=?').get('prj_nebula')) return false;
  const t = now();
  db.prepare(`INSERT INTO projects (id,name,key,region,plan,status,color,description,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'prj_nebula', 'Nebula Analytics', 'nebula-analytics', 'ams', 'pro', 'active', '#6C5CE7',
    'Event pipeline and internal dashboards for the Nebula product team.', t, t,
  );

  const insCol = db.prepare(`INSERT INTO collections (id,name,key,icon,color,documentSecurity,enabled,createdAt,updatedAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insCol.run('col_neb_events', 'Events', 'events', 'activity', '#6C5CE7', 0, 1, t, t, 'prj_nebula');
  insCol.run('col_neb_dashboards', 'Dashboards', 'dashboards', 'layout-dashboard', '#00B894', 0, 1, t, t, 'prj_nebula');

  const insAttr = db.prepare(`INSERT INTO attributes (id,collectionId,key,type,required,array,size,defaultVal,elements,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insAttr.run(uid('attr_'), 'col_neb_events', 'name', 'string', 1, 0, 64, null, '[]', t);
  insAttr.run(uid('attr_'), 'col_neb_events', 'source', 'enum', 1, 0, null, null, JSON.stringify(['web', 'ios', 'android', 'api']), t);
  insAttr.run(uid('attr_'), 'col_neb_events', 'count', 'integer', 1, 0, null, null, '[]', t);
  insAttr.run(uid('attr_'), 'col_neb_dashboards', 'title', 'string', 1, 0, 96, null, '[]', t);
  insAttr.run(uid('attr_'), 'col_neb_dashboards', 'public', 'boolean', 0, 0, null, null, '[]', t);

  const insDoc = db.prepare('INSERT INTO documents (id,collectionId,data,permissions,createdAt,updatedAt) VALUES (?,?,?,?,?,?)');
  const perms = JSON.stringify(['read("any")']);
  for (const [name, source, count] of [
    ['dashboard_view', 'web', 1284], ['checkout_start', 'web', 312], ['app_open', 'ios', 903],
    ['app_open', 'android', 771], ['api_sync', 'api', 96],
  ] as const) {
    insDoc.run(uid('doc_'), 'col_neb_events', JSON.stringify({ name, source, count }), perms, t, t);
  }
  for (const [title, isPublic] of [['Weekly active users', 1], ['Funnel — checkout', 1], ['Revenue by plan', 0]] as const) {
    insDoc.run(uid('doc_'), 'col_neb_dashboards', JSON.stringify({ title, public: !!isPublic }), perms, t, t);
  }

  db.prepare(`INSERT INTO buckets (id,name,maxFileSize,allowedExtensions,compression,encryption,imageTransform,createdAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'bkt_nebula', 'exports', 8 * 1024 * 1024, JSON.stringify(['csv', 'json', 'png']), 'gzip', 0, 0, t, 'prj_nebula',
  );

  const rollupCode = `export default async ({ req, res, log, databases }) => {
  const events = databases.listDocuments('events', { limit: 100 });
  const total = events.documents.reduce((s, d) => s + Number(d.data.count || 0), 0);
  log('rollup over', events.total, 'events, total count', total);
  return res.json({ ok: true, events: events.total, total, window: '24h' });
};`;
  db.prepare(`INSERT INTO functions (id,name,runtime,entrypoint,code,schedule,timeout,env,enabled,executeAccess,createdAt,updatedAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'fn_neb_rollup', 'Nightly rollup', 'node-22', 'src/main.js', rollupCode, '0 2 * * *', 20,
    JSON.stringify({ WINDOW: '24h' }), 1, 'any', t, t, 'prj_nebula',
  );

  const siteFiles = [
    { path: 'index.html', content: `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" /><title>Nebula Docs</title>
<link rel="stylesheet" href="./styles.css" /></head><body>
<header><span class="dot"></span><b>Nebula</b><nav><a href="#events">Events API</a><a href="#sdks">SDKs</a></nav></header>
<main><p class="eyebrow">DOCUMENTATION</p><h1>Ship analytics<br /><em>in an afternoon.</em></h1>
<p class="lede">Nebula collects product events, rolls them up hourly and exposes them through a typed query API.</p>
<pre><code>curl -X POST https://api.nebula.dev/v1/events \\
  -H "x-api-key: $NEBULA_KEY" \\
  -d '{"name":"app_open","source":"ios"}'</code></pre>
<h2 id="events">Events API</h2><table><tr><th>Field</th><th>Type</th></tr><tr><td>name</td><td>string</td></tr><tr><td>source</td><td>web | ios | android | api</td></tr><tr><td>count</td><td>integer</td></tr></table>
</main></body></html>` },
    { path: 'styles.css', content: `:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0a0a10;color:#e9e9f2;font:15px/1.7 ui-sans-serif,system-ui}
header{display:flex;align-items:center;gap:10px;padding:18px 40px;border-bottom:1px solid #1e1e2a}
.dot{width:9px;height:9px;border-radius:50%;background:#6C5CE7;box-shadow:0 0 12px #6C5CE7}
nav{margin-left:auto;display:flex;gap:18px}nav a{color:#8f8fa8;text-decoration:none;font-size:13px}
main{max-width:760px;margin:0 auto;padding:64px 24px 96px}
.eyebrow{letter-spacing:.22em;font-size:11px;color:#6C5CE7}
h1{font-size:48px;line-height:1.08;letter-spacing:-.03em;margin:8px 0 18px}h1 em{font-family:Georgia,serif;color:#a99bff}
.lede{color:#9b9bb4;max-width:52ch}
pre{background:#12121c;border:1px solid #1e1e2a;border-radius:10px;padding:16px;overflow:auto}
code{font:12.5px/1.6 ui-monospace,monospace;color:#c8c2ff}
h2{margin-top:44px;font-size:22px}table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border-bottom:1px solid #1e1e2a;padding:8px 10px;text-align:left}th{color:#8f8fa8;font-weight:500}` },
  ];
  db.prepare(`INSERT INTO sites (id,name,framework,domain,entrypoint,buildCommand,files,status,buildLogs,createdAt,updatedAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'site_neb_docs', 'nebula-docs', 'static', 'docs.nebula.dev', 'index.html', 'npm run build',
    JSON.stringify(siteFiles), 'ready', JSON.stringify(['✓ Build started', '✓ 2 files processed', '✓ Deployed to edge']), t, t, 'prj_nebula',
  );

  return true;
}

/* ------------------------------------------------------------ 团队成员 */

/** 幂等地补齐演示用的项目成员与角色（owner / admin / developer / viewer） */
export function seedMembers() {
  const hash = (pw: string) => crypto.scryptSync(pw, 'studio-salt', 32).toString('hex');
  const ensureUser = (name: string, email: string) => {
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email) as any;
    if (existing) return existing.id as string;
    const id = uid('usr_');
    db.prepare(`INSERT INTO users (id,name,email,passwordHash,status,emailVerified,labels,prefs,createdAt,lastLoginAt)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, name, email, hash('aurora-demo'), 'active', 1, '["team"]', '{"theme":"dark"}', now(), now(),
    );
    return id;
  };

  const rows: [string, string, string, string][] = [
    ['studio', 'Alex Fisher', 'alex@aurora.io', 'owner'],
    ['studio', 'Mia Fischer', 'mia@northwind.io', 'admin'],
    ['studio', 'Lukas Brandt', 'lukas@fieldkit.co', 'developer'],
    ['studio', 'Ava Laurent', 'ava@studioform.fr', 'viewer'],
    ['prj_nebula', 'Noah Weber', 'noah@weber.dev', 'owner'],
    ['prj_nebula', 'Sofia Rossi', 'sofia@atelier.it', 'developer'],
    ['prj_nebula', 'Alex Fisher', 'alex@aurora.io', 'viewer'],
  ];
  for (const [projectId, name, email, role] of rows) {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) continue;
    const userId = ensureUser(name, email);
    if (db.prepare('SELECT 1 FROM members WHERE projectId=? AND userId=?').get(projectId, userId)) continue;
    db.prepare('INSERT INTO members (id,projectId,userId,role,createdAt) VALUES (?,?,?,?,?)').run(
      uid('mem_'), projectId, userId, role, now(),
    );
  }
  return true;
}

/* ---------------------------------------------------------- 定时调度 */

/** 幂等地给演示函数挂上调度（每 5 分钟 / 每天 02:00） */
export function seedSchedules() {
  const t = now();
  const rows: [string, string, string][] = [
    ['fn_health', '*/5 * * * *', 'UTC'],
    ['fn_stats', '0 2 * * *', 'Europe/Berlin'],
    ['fn_neb_rollup', '0 2 * * *', 'UTC'],
  ];
  for (const [functionId, cron, tz] of rows) {
    const fn = db.prepare('SELECT id FROM functions WHERE id=?').get(functionId) as any;
    if (!fn) continue;
    if (db.prepare('SELECT 1 FROM schedules WHERE functionId=?').get(functionId)) continue;
    const projectId = (db.prepare('SELECT projectId FROM functions WHERE id=?').get(functionId) as any).projectId;
    let next = '';
    try { next = nextRun(cron, new Date(), tz).toISOString(); } catch { continue; }
    db.prepare(`INSERT INTO schedules (id,projectId,functionId,cron,timezone,enabled,nextRunAt,lastRunAt,lastStatus,createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(uid('sch_'), projectId, functionId, cron, tz, 1, next, null, null, t);
  }
  return true;
}

/** 演示用 GitHub 连接：让 fn_stats 绑定到一个仓库，并写入两条部署记录 */
export function seedGit() {
  const target = db.prepare('SELECT * FROM functions WHERE id=?').get('fn_stats') as any;
  if (!target) return false;
  if (db.prepare('SELECT 1 FROM gitIntegrations WHERE functionId=?').get('fn_stats')) return true;

  const t = now();
  const sha = 'b7e41c9';
  db.prepare(`INSERT INTO gitIntegrations
    (id,projectId,functionId,provider,repo,branch,rootDir,path,token,autoDeploy,webhookSecret,
     lastSyncAt,lastSha,lastMessage,lastAuthor,lastStatus,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    uid('git_'), target.projectId, 'fn_stats', 'github', 'studio-baas/demo-functions', 'main',
    'functions/store-stats', 'functions/store-stats/src/main.js', null, 1,
    'demo-webhook-secret-2f9a4c', t, sha,
    'feat: report per-collection counts', 'Mia Fischer', 'deployed',
    new Date(Date.now() - 86_400_000 * 3).toISOString(), t,
  );

  const deploys: [string, string, string, string, string, number][] = [
    ['b7e41c9', 'feat: report per-collection counts', 'Mia Fischer', 'webhook', 'deployed', 86_400_000 * 3],
    ['4d02a71', 'chore: bump runtime to node-22', 'Alex Fisher', 'manual', 'deployed', 86_400_000 * 9],
  ];
  for (const [s, message, author, source, status, ago] of deploys) {
    db.prepare(`INSERT INTO gitDeploys (id,projectId,functionId,sha,message,author,source,status,files,duration,createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid('dep_'), target.projectId, 'fn_stats', s, message, author, source, status, 1,
      480 + Math.round(Math.random() * 260), new Date(Date.now() - ago).toISOString(),
    );
  }
  return true;
}
