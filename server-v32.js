'use strict';
// Online account and community API for the solo browser game.
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { promisify } = require('node:util');
const { readFileSync } = require('node:fs');
const tls = require('node:tls');
const scrypt = promisify(crypto.scrypt);
let connection = process.env.DATABASE_URL?.trim();
if (!connection) {
  console.error('DATABASE_URL is missing; add it in Render Environment.');
  process.exit(1);
}
let databaseUrl;
try {
  if (/^postgres(?:ql)?:\/\/[^:@/]+:\[YOUR-PASSWORD\]@/i.test(connection)) {
    const password = process.env.DATABASE_PASSWORD;
    if (!password) {
      console.error('DATABASE_PASSWORD is required when DATABASE_URL contains [YOUR-PASSWORD].');
      process.exit(1);
    }
    connection = connection.replace(/:\[YOUR-PASSWORD\]@/i, () =>
      ':' + encodeURIComponent(password) + '@');
  }
  databaseUrl = new URL(connection);
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname) {
    throw new Error('Invalid database URL');
  }
} catch {
  console.error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  process.exit(1);
}
let ssl = process.env.NODE_ENV !== 'production' &&
  process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: true };
const supabaseHost = /^(?:db\.[a-z0-9]+\.supabase\.co|aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com)$/.test(databaseUrl.hostname);
const explicitCertificate = ['sslrootcert', 'sslcert', 'sslkey'].some(key => databaseUrl.searchParams.has(key));
const sslMode = databaseUrl.searchParams.get('sslmode');
if (ssl && supabaseHost && !explicitCertificate &&
    [null, 'require', 'verify-ca', 'verify-full'].includes(sslMode)) {
  const ca = readFileSync(path.join(__dirname, 'certs', 'supabase-ca.crt'), 'utf8');
  const roots = tls.getCACertificates?.() || tls.rootCertificates;
  ssl = { rejectUnauthorized: true, ca: [...roots, ca] };
  // pg replaces the explicit ssl object whenever sslmode is in the URL.
  databaseUrl.searchParams.delete('sslmode');
}
const pool = new Pool({
  connectionString: databaseUrl.toString(),
  ssl,
  max: 5,
  connectionTimeoutMillis: 12000,
});
const app = express();
app.disable('x-powered-by');
app.use('/api/solo-save', express.json({ limit: '64kb' }));
app.use(express.json({ limit: '16kb' }));
app.get('/admin-online.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'client', 'admin-online.js')),
);
app.use(express.static(path.join(__dirname, 'public')));
const httpServer = http.createServer(app);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (
    req.method === 'POST' &&
    (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
  )
    return fail(res, 400, 'Expected a JSON object');
  next();
});
const now = () => Date.now(),
  id = () => crypto.randomUUID();
const clean = (v, max = 100) =>
  String(v ?? '')
    .trim()
    .slice(0, max);
const codeName = (s) => clean(s, 24).toUpperCase();
const allowedAssets = new Set([
  'gold',
  'tokens',
  'pass_xp',
  'pass_levels',
  'island',
  'skin',
  'pet',
  'trail',
]);
const validId = (value) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function validAsset(asset, item) {
  if (!allowedAssets.has(asset)) return false;
  if (asset === 'island') return /^[0-9]$/.test(item);
  if (['skin', 'pet', 'trail'].includes(asset))
    return typeof item === 'string' && /^[a-z0-9_-]{1,40}$/.test(item);
  return item === '';
}
function fail(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}
async function hashPassword(p, salt) {
  return (await scrypt(p, salt, 64)).toString('hex');
}
function safeCompare(a, b) {
  const x = Buffer.from(a || ''),
    y = Buffer.from(b || '');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function validateName(name) {
  return /^[a-zA-Z0-9_]{3,16}$/.test(name);
}
async function auth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!/^[a-f0-9]{64}$/.test(token)) return fail(res, 401, 'Log in first');
    const r = await pool.query(
      'SELECT u.id,u.username,u.role FROM island_clash.ic_sessions s JOIN island_clash.ic_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()',
      [tokenHash(token)],
    );
    if (!r.rowCount) return fail(res, 401, 'Session expired; log in again');
    req.user = r.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}
function requireRole(role) {
  return (req, res, next) => {
    if (
      req.user.role === 'owner' ||
      (role === 'admin' && req.user.role === 'admin')
    )
      return next();
    return fail(res, 403, 'Admin permission required');
  };
}
async function newSession(user, client = pool) {
  const token = crypto.randomBytes(32).toString('hex');
  await client.query(
    "INSERT INTO island_clash.ic_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')",
    [tokenHash(token), user.id],
  );
  return {
    ok: true,
    token,
    user: { id: user.id, username: user.username, role: user.role },
  };
}
const loginAttempts = new Map();
setInterval(() => {
  for (const [key, entry] of loginAttempts)
    if (entry.until < now()) loginAttempts.delete(key);
}, 60000).unref();
if (process.env.TRUST_PROXY_HOPS === '1') app.set('trust proxy', 1);
function throttle(req, res, next) {
  const k = req.ip;
  const t = now(),
    a = loginAttempts.get(k) || { n: 0, until: t + 60000 };
  if (t > a.until) {
    a.n = 0;
    a.until = t + 60000;
  }
  a.n++;
  loginAttempts.set(k, a);
  if (a.n > 30) return fail(res, 429, 'Too many requests; try again later');
  next();
}
app.post('/api/signup', throttle, async (req, res, next) => {
  try {
    const username = clean(req.body.username, 30),
      password = req.body.password,
      key = username.toLowerCase();
    if (
      !validateName(username) ||
      typeof password !== 'string' ||
      password.length < 10 ||
      password.length > 128
    )
      return fail(
        res,
        400,
        'Username 3–16 letters/numbers/underscore; passcode at least 10 characters',
      );
    const isOwner = key === 'britbox';
    if (isOwner) {
      const setup = String(process.env.OWNER_SETUP_SECRET || '');
      if (
        setup.length < 16 ||
        typeof req.body.ownerSetupSecret !== 'string' ||
        !safeCompare(req.body.ownerSetupSecret, setup)
      )
        return fail(
          res,
          403,
          'BRITBOX registration requires the private owner setup secret',
        );
    }
    const salt = crypto.randomBytes(16).toString('hex'),
      hash = await hashPassword(password, salt),
      uid = id();
    const session = await transaction(async (client) => {
      const result = await client.query(
        'INSERT INTO island_clash.ic_users(id,username,username_key,pass_salt,pass_hash,role) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(username_key) DO NOTHING RETURNING id,username,role',
        [
          uid,
          isOwner ? 'BRITBOX' : username,
          key,
          salt,
          hash,
          isOwner ? 'owner' : 'player',
        ],
      );
      return result.rowCount ? newSession(result.rows[0], client) : null;
    });
    if (!session) return fail(res, 409, 'Username already registered');
    res.status(201).json(session);
  } catch (e) {
    next(e);
  }
});
app.post('/api/login', throttle, async (req, res, next) => {
  try {
    const username = clean(req.body.username, 30).toLowerCase(),
      password = req.body.password;
    if (
      !validateName(username) ||
      typeof password !== 'string' ||
      password.length > 128
    )
      return fail(res, 401, 'Incorrect name or passcode');
    const r = await pool.query(
      'SELECT id,username,role,pass_salt,pass_hash FROM island_clash.ic_users WHERE username_key=$1',
      [username],
    );
    const account = r.rows[0];
    const hash = await hashPassword(
      password,
      account?.pass_salt || 'invalid-username',
    );
    if (!account || !safeCompare(hash, account.pass_hash))
      return fail(res, 401, 'Incorrect name or passcode');
    res.json(await newSession(r.rows[0]));
  } catch (e) {
    next(e);
  }
});
app.post('/api/logout', auth, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM island_clash.ic_sessions WHERE token_hash=$1',
      [tokenHash((req.get('authorization') || '').slice(7))],
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.get('/api/me', auth, async (req, res, next) => {
  try {
    const inventory = await pool.query(
      'SELECT asset,item,qty::text FROM island_clash.ic_inventory WHERE user_id=$1',
      [req.user.id],
    );
    res.json({ ok: true, user: req.user, inventory: inventory.rows });
  } catch (e) {
    next(e);
  }
});
app.get('/api/notices', async (req, res, next) => {
  try {
    const r = await pool.query(
      'SELECT id,message,created_at FROM island_clash.ic_notices ORDER BY created_at DESC LIMIT 30',
    );
    res.json({ ok: true, notices: r.rows });
  } catch (e) {
    next(e);
  }
});
app.post(
  '/api/admin/notices',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const message = clean(req.body.message, 400);
      if (message.length < 3) return fail(res, 400, 'Announcement too short');
      const r = await pool.query(
        'INSERT INTO island_clash.ic_notices(id,author_id,message) VALUES($1,$2,$3) RETURNING id,message,created_at',
        [id(), req.user.id, message],
      );
      res.status(201).json({ ok: true, notice: r.rows[0] });
    } catch (e) {
      next(e);
    }
  },
);
app.get(
  '/api/admin/users',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const q = clean(req.query.q, 20).toLowerCase();
      if (!/^[a-z0-9_]*$/.test(q)) return fail(res, 400, 'Invalid search');
      const r = await pool.query(
        'SELECT id,username,role FROM island_clash.ic_users WHERE starts_with(username_key,$1) ORDER BY username LIMIT 30',
        [q],
      );
      res.json({ ok: true, users: r.rows });
    } catch (e) {
      next(e);
    }
  },
);
app.post(
  '/api/admin/role',
  auth,
  requireRole('owner'),
  async (req, res, next) => {
    const username = clean(req.body.username, 30).toLowerCase(),
      role = req.body.role;
    if (
      !validateName(username) ||
      !['player', 'admin'].includes(role) ||
      username === 'britbox'
    )
      return fail(res, 400, 'Invalid role change');
    try {
      const account = await transaction(async (client) => {
        const result = await client.query(
          `UPDATE island_clash.ic_users SET role=$1
    WHERE username_key=$2 AND role!='owner' RETURNING id,username,role`,
          [role, username],
        );
        if (!result.rowCount) return null;
        await client.query(
          'DELETE FROM island_clash.ic_admin_invitations WHERE user_id=$1',
          [result.rows[0].id],
        );
        const account = result.rows[0];
        return { username: account.username, role: account.role };
      });
      if (!account) return fail(res, 404, 'Account not found');
      res.json({ ok: true, account });
    } catch (error) {
      next(error);
    }
  },
);

async function grant(client, userId, asset, item, quantity) {
  await client.query(
    'INSERT INTO island_clash.ic_inventory(user_id,asset,item,qty) VALUES($1,$2,$3,GREATEST(0,$4::bigint)) ON CONFLICT(user_id,asset,item) DO UPDATE SET qty=GREATEST(0,ic_inventory.qty + $4::bigint)',
    [userId, asset, item, quantity],
  );
}
app.post(
  '/api/admin/gift',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    let client;
    try {
      client = await pool.connect();
      const username = clean(req.body.username, 16).toLowerCase(),
        asset = clean(req.body.asset, 20),
        item = clean(req.body.item, 40),
        qty = Number(req.body.qty);
      if (
        !validAsset(asset, item) ||
        !Number.isSafeInteger(qty) ||
        qty < -1000000 ||
        qty > 1000000 ||
        qty === 0
      )
        return fail(res, 400, 'Invalid gift');
      if (['skin', 'pet', 'trail'].includes(asset) && !item)
        return fail(res, 400, 'Item name required');
      await client.query('BEGIN');
      const r = await client.query(
        'SELECT id FROM island_clash.ic_users WHERE username_key=$1',
        [username],
      );
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return fail(res, 404, 'Player not found');
      }
      await grant(client, r.rows[0].id, asset, item, qty);
      await client.query('COMMIT');
      res.json({ ok: true, message: 'Gift saved online for ' + username });
    } catch (e) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(e);
    } finally {
      client?.release();
    }
  },
);
app.post(
  '/api/admin/codes',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const code = codeName(req.body.code),
        asset = clean(req.body.asset, 20),
        item = clean(req.body.item, 40),
        qty = Number(req.body.qty),
        maxUses = Number(req.body.maxUses),
        hours = Number(req.body.hours);
      if (
        !/^[A-Z0-9_-]{4,24}$/.test(code) ||
        !validAsset(asset, item) ||
        !Number.isSafeInteger(qty) ||
        qty < 1 ||
        qty > 1000000 ||
        !Number.isSafeInteger(maxUses) ||
        maxUses < 1 ||
        maxUses > 10000 ||
        !Number.isFinite(hours) ||
        hours < 0.25 ||
        hours > 8760
      )
        return fail(res, 400, 'Invalid code configuration');
      await pool.query(
        "INSERT INTO island_clash.ic_codes(code,asset,item,qty,max_uses,expires_at,created_by) VALUES($1,$2,$3,$4,$5,NOW()+($6::double precision * INTERVAL '1 hour'),$7)",
        [code, asset, item, qty, maxUses, hours, req.user.id],
      );
      res.status(201).json({ ok: true, code });
    } catch (e) {
      if (e.code === '23505') return fail(res, 409, 'Code exists');
      next(e);
    }
  },
);
app.delete(
  '/api/admin/codes/:code',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      await pool.query(
        'UPDATE island_clash.ic_codes SET disabled=true WHERE code=$1',
        [codeName(req.params.code)],
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
app.post('/api/redeem', auth, async (req, res, next) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const code = codeName(req.body.code);
    const r = await client.query(
      'SELECT * FROM island_clash.ic_codes WHERE code=$1 AND NOT disabled AND expires_at>clock_timestamp() FOR UPDATE',
      [code],
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Code invalid or expired');
    }
    const c = r.rows[0],
      uses = await client.query(
        'SELECT count(*)::int AS n FROM island_clash.ic_code_uses WHERE code=$1',
        [code],
      );
    if (uses.rows[0].n >= c.max_uses) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Code fully redeemed');
    }
    const u = await client.query(
      'INSERT INTO island_clash.ic_code_uses(code,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING code',
      [code, req.user.id],
    );
    if (!u.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Already redeemed');
    }
    await grant(client, req.user.id, c.asset, c.item, Number(c.qty));
    await client.query('COMMIT');
    res.json({
      ok: true,
      reward: { asset: c.asset, item: c.item, qty: Number(c.qty) },
    });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client?.release();
  }
});
app.post('/api/reports', auth, async (req, res, next) => {
  try {
    const kind = clean(req.body.kind, 30),
      message = clean(req.body.message, 700);
    if (
      !['bug', 'contact', 'admin_application'].includes(kind) ||
      message.length < 5
    )
      return fail(res, 400, 'Invalid report');
    await pool.query(
      'INSERT INTO island_clash.ic_reports(id,user_id,kind,message) VALUES($1,$2,$3,$4)',
      [id(), req.user.id, kind, message],
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.get(
  '/api/admin/reports',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const r = await pool.query(
        'SELECT r.id,r.kind,r.message,r.status,r.created_at,u.username FROM island_clash.ic_reports r JOIN island_clash.ic_users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 100',
      );
      res.json({ ok: true, reports: r.rows });
    } catch (e) {
      next(e);
    }
  },
);
app.post(
  '/api/admin/reports/:id/status',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const status = req.body.status;
      if (!validId(req.params.id)) return fail(res, 400, 'Invalid report ID');
      if (!['open', 'resolved'].includes(status))
        return fail(res, 400, 'Invalid status');
      await pool.query(
        'UPDATE island_clash.ic_reports SET status=$1 WHERE id=$2',
        [status, req.params.id],
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
app.get('/api/state', async (req, res, next) => {
  try {
    const [settings, vault] = await Promise.all([
      pool.query(
        "SELECT key,value FROM island_clash.ic_state WHERE key IN('event','shutdown')",
      ),
      pool.query(
        'SELECT asset,item,qty,expires_at FROM island_clash.ic_vault WHERE closed_at IS NULL AND expires_at>NOW()',
      ),
    ]);
    res.json({
      ok: true,
      state: {
        ...Object.fromEntries(settings.rows.map((x) => [x.key, x.value])),
        vault: vault.rows[0] || null,
      },
    });
  } catch (e) {
    next(e);
  }
});
app.post(
  '/api/admin/state',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const key = clean(req.body.key, 20),
        value = req.body.value;
      if (
        !['event', 'shutdown'].includes(key) ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof value.active !== 'boolean'
      )
        return fail(res, 400, 'Invalid global setting');
      if (
        key === 'event' &&
        value.active &&
        (!['gold', 'rain', 'wind', 'truce'].includes(value.event) ||
          !validId(value.id))
      )
        return fail(res, 400, 'Invalid event');
      if (
        typeof value.message !== 'string' ||
        value.message.length > 200 ||
        JSON.stringify(value).length > 600
      )
        return fail(res, 400, 'Setting too large');
      await pool.query(
        'INSERT INTO island_clash.ic_state(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',
        [key, JSON.stringify(value)],
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
app.get(
  '/api/admin/codes',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const { rows } =
        await pool.query(`SELECT c.code,c.asset,c.item,c.qty,c.expires_at,c.max_uses,
   (SELECT count(*)::int FROM island_clash.ic_code_uses u WHERE u.code=c.code) AS uses
   FROM island_clash.ic_codes c WHERE NOT c.disabled ORDER BY c.expires_at DESC LIMIT 100`);
      res.json({ ok: true, codes: rows });
    } catch (error) {
      next(error);
    }
  },
);

app.delete(
  '/api/admin/notices/:id',
  auth,
  requireRole('admin'),
  async (req, res, next) => {
    if (!validId(req.params.id)) return fail(res, 400, 'Invalid notice ID');
    try {
      const result = await pool.query(
        'DELETE FROM island_clash.ic_notices WHERE id=$1',
        [req.params.id],
      );
      if (!result.rowCount) return fail(res, 404, 'Notice not found');
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

app.post(
  '/api/admin/vault',
  auth,
  requireRole('owner'),
  async (req, res, next) => {
    const { asset, item = '', qty, hours } = req.body || {};
    if (
      !['gold', 'tokens', 'skin', 'pet', 'trail'].includes(asset) ||
      !validAsset(asset, item) ||
      !Number.isSafeInteger(qty) ||
      qty < 1 ||
      qty > 1000000 ||
      !Number.isFinite(hours) ||
      hours < 0.25 ||
      hours > 8760
    ) {
      return fail(res, 400, 'Invalid vault prize');
    }
    const code = crypto.randomBytes(12).toString('hex').toUpperCase();
    try {
      await transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(320032)');
        await client.query(
          'UPDATE island_clash.ic_vault SET closed_at=NOW() WHERE closed_at IS NULL',
        );
        await client.query(
          `INSERT INTO island_clash.ic_vault(code_hash,asset,item,qty,expires_at)
     VALUES($1,$2,$3,$4,NOW()+($5::double precision * INTERVAL '1 hour'))`,
          [tokenHash(code), asset, item, qty, hours],
        );
      });
      res.status(201).json({ ok: true, code });
    } catch (error) {
      next(error);
    }
  },
);

app.post('/api/vault/claim', auth, async (req, res, next) => {
  const code = codeName(req.body?.code);
  if (!/^[A-F0-9]{24}$/.test(code)) return fail(res, 400, 'Invalid vault code');
  try {
    const reward = await transaction(async (client) => {
      const result = await client.query(
        `UPDATE island_clash.ic_vault SET closed_at=NOW(),claimed_by=$1
    WHERE code_hash=$2 AND closed_at IS NULL AND expires_at>clock_timestamp()
    RETURNING asset,item,qty`,
        [req.user.id, tokenHash(code)],
      );
      if (!result.rowCount) return null;
      const { asset, item, qty } = result.rows[0];
      await grant(client, req.user.id, asset, item, Number(qty));
      return { asset, item, qty: Number(qty) };
    });
    if (!reward)
      return fail(res, 409, 'Vault code invalid, expired, or already claimed');
    res.json({ ok: true, reward });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/admin/invitations',
  auth,
  requireRole('owner'),
  async (req, res, next) => {
    const username = clean(req.body.username, 30).toLowerCase();
    if (!validateName(username) || username === 'britbox')
      return fail(res, 400, 'Choose a player account');
    const code = crypto.randomBytes(12).toString('hex').toUpperCase();
    try {
      const created = await transaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id,role FROM island_clash.ic_users
    WHERE username_key=$1 FOR UPDATE`,
          [username],
        );
        if (rows[0]?.role !== 'player') return false;
        await client.query(
          `INSERT INTO island_clash.ic_admin_invitations(user_id,code_hash,expires_at)
    VALUES($1,$2,NOW()+INTERVAL '24 hours') ON CONFLICT(user_id) DO UPDATE
    SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at`,
          [rows[0].id, tokenHash(code)],
        );
        return true;
      });
      if (!created) return fail(res, 404, 'Player account not found');
      res.status(201).json({ ok: true, code });
    } catch (error) {
      next(error);
    }
  },
);

app.post('/api/admin-invitations/accept', auth, async (req, res, next) => {
  const code = codeName(req.body.code);
  if (!/^[A-F0-9]{24}$/.test(code))
    return fail(res, 400, 'Invalid invitation code');
  try {
    const accepted = await transaction(async (client) => {
      const { rows } = await client.query(
        'SELECT role FROM island_clash.ic_users WHERE id=$1 FOR UPDATE',
        [req.user.id],
      );
      if (rows[0]?.role !== 'player') return false;
      const result = await client.query(
        `DELETE FROM island_clash.ic_admin_invitations
    WHERE user_id=$1 AND code_hash=$2 AND expires_at>clock_timestamp()`,
        [req.user.id, tokenHash(code)],
      );
      if (!result.rowCount) return false;
      await client.query(
        "UPDATE island_clash.ic_users SET role='admin' WHERE id=$1",
        [req.user.id],
      );
      return true;
    });
    if (!accepted)
      return fail(res, 404, 'Invitation invalid, expired, or already used');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

function validSoloSave(save) {
  if (!save || typeof save !== 'object' || Array.isArray(save)) return false;
  const { account, inventory, grants } = save;
  if (
    ![account, inventory, grants].every(
      (value) => value && typeof value === 'object' && !Array.isArray(value),
    )
  )
    return false;
  const safeNumber = (value) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER;
  const stringList = (value) =>
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length <= 64);
  const upgrades = (value) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (stats) =>
        stats &&
        typeof stats === 'object' &&
        !Array.isArray(stats) &&
        Object.values(stats).every(safeNumber),
    );
  return (
    ['bank'].every((key) => safeNumber(inventory[key])) &&
    ['ownedSkins', 'ownedPets', 'ownedTrails'].every((key) =>
      stringList(inventory[key]),
    ) &&
    ['skin', 'pet', 'trail'].every(
      (key) =>
        typeof inventory[key] === 'string' && inventory[key].length <= 40,
    ) &&
    ['skinUpgrades', 'petUpgrades'].every((key) => upgrades(inventory[key])) &&
    ['basicTokens', 'battleXP', 'chestsOpened', 'playtimeSec', 'wins'].every(
      (key) => safeNumber(account[key]),
    ) &&
    ['currentIsland', 'unlocked'].every(
      (key) =>
        Number.isInteger(account[key]) &&
        account[key] >= 0 &&
        account[key] < 10,
    ) &&
    ['passClaimedFree', 'passClaimedPro', 'islandWins', 'islandKos'].every(
      (key) => Array.isArray(account[key]) && account[key].every(safeNumber),
    ) &&
    ['achievementTags', 'codes'].every((key) => stringList(account[key])) &&
    Array.isArray(account.personalChestCodes) &&
    account.personalChestCodes.every(
      (entry) =>
        entry &&
        typeof entry.code === 'string' &&
        entry.code.length <= 24 &&
        safeNumber(entry.reward) &&
        typeof entry.used === 'boolean',
    ) &&
    Object.values(grants).every(safeNumber)
  );
}

app.get('/api/solo-save', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT revision,data FROM island_clash.ic_solo_saves WHERE user_id=$1',
      [req.user.id],
    );
    res.json({ ok: true, save: rows[0] || null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/solo-save', auth, async (req, res, next) => {
  const { revision, data } = req.body;
  if (
    !Number.isInteger(revision) ||
    revision < 0 ||
    revision >= 2147483647 ||
    !validSoloSave(data)
  ) {
    return fail(res, 400, 'Invalid solo save');
  }
  try {
    const result =
      revision === 0
        ? await pool.query(
            `INSERT INTO island_clash.ic_solo_saves(user_id,revision,data) VALUES($1,1,$2)
      ON CONFLICT(user_id) DO NOTHING RETURNING revision`,
            [req.user.id, data],
          )
        : await pool.query(
            `UPDATE island_clash.ic_solo_saves SET revision=revision+1,data=$3,updated_at=NOW()
      WHERE user_id=$1 AND revision=$2 RETURNING revision`,
            [req.user.id, revision, data],
          );
    if (!result.rowCount)
      return fail(
        res,
        409,
        'Another session saved first. Log in again to load the latest save.',
      );
    res.json({ ok: true, revision: result.rows[0].revision });
  } catch (error) {
    next(error);
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1 FROM island_clash.ic_users LIMIT 0');
    res.json({
      ok: true,
      database: 'connected',
      mode: 'solo-with-global-admin-api',
    });
  } catch (e) {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});
app.use((err, req, res, next) => {
  if (err.status === 400 || err.status === 413)
    return fail(res, err.status, 'Invalid request body');
  console.error(
    'API error:',
    req.method,
    req.route?.path || '(router)',
    err.code || err.name,
  );
  if (!res.headersSent) fail(res, 500, 'Server error; check Render logs');
});
pool
  .query('SELECT 1 FROM island_clash.ic_users LIMIT 0')
  .then(() =>
    httpServer.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () =>
      console.log('Island Clash v32 online admin API ready'),
    ),
  )
  .catch((e) => {
    console.error('Database setup failed:', e.code || e.name);
    process.exit(1);
  });
