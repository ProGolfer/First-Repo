'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '../..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const read = f => fs.readFileSync(f, 'utf8');

async function newDb({ fixture = true } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(read(path.join(__dirname, 'auth-shim.sql')));
  await db.exec(read(path.join(__dirname, 'legacy-schema.sql')));
  if (fixture) await loadLegacyFixture(db);
  return db;
}

const q = v => (v === null || v === undefined ? null : v);
async function insertRow(db, table, row) {
  const cols = Object.keys(row);
  await db.query(`insert into public.${table} (${cols.map(c => `"${c}"`).join(',')}) overriding system value values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    cols.map(c => q(row[c])));
}

async function loadLegacyFixture(db) {
  const fx = JSON.parse(read(path.join(__dirname, '../fixtures/legacy-league.json')));
  for (const r of fx.league_players) await insertRow(db, 'league_players', r);
  for (const r of fx.game_history) await insertRow(db, 'game_history', r);
  return fx;
}

function migrationFiles(upTo) {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    .filter(f => !f.includes('add_players_auth_user_id'))   // already applied live; players.auth_user_id lives in legacy-schema
    .filter(f => !upTo || f <= upTo);
}
async function applyMigrations(db, upTo) {
  for (const f of migrationFiles(upTo)) await db.exec(read(path.join(MIGRATIONS_DIR, f)));
}

// Run SQL as a given role/user inside one transaction, like PostgREST does for a request.
//   who = null -> anon;  who = {id, email} -> authenticated;  who = 'service' -> postgres superuser (no role switch)
async function run(db, who, sql, params = []) {
  return db.transaction(async tx => {
    if (who !== 'service') {
      const role = who ? 'authenticated' : 'anon';
      await tx.query(`set local role ${role}`);
      if (who) {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
          [who.id, JSON.stringify({ sub: who.id, email: who.email, role: 'authenticated', is_anonymous: !!who.anonymous })]);
      }
    }
    const res = await tx.query(sql, params);
    return res.rows;
  });
}
async function rpc(db, who, fn, args = []) {
  const ph = args.map((_, i) => `$${i + 1}`).join(',');
  const rows = await run(db, who, `select public.${fn}(${ph}) as r`, args);
  return rows[0].r;
}
async function rpcErr(db, who, fn, args = []) {
  try { await rpc(db, who, fn, args); } catch (e) { return String(e.message); }
  return null;
}
async function newUser(db, email) {
  const id = crypto.randomUUID();
  await db.query('insert into auth.users (id, email) values ($1,$2)', [id, email]);
  return { id, email };
}
// A stable fingerprint of the legacy tables, to prove nothing moved.
async function legacyFingerprint(db) {
  const gh = (await db.query('select * from public.game_history order by id')).rows;
  const lp = (await db.query('select * from public.league_players order by normalized_name')).rows;
  const canon = JSON.stringify({ gh, lp }, (k, v) => (v instanceof Date ? v.toISOString() : v));
  return { gh, lp, sha: crypto.createHash('sha256').update(canon).digest('hex') };
}

module.exports = { newDb, applyMigrations, migrationFiles, run, rpc, rpcErr, newUser, legacyFingerprint, loadLegacyFixture, ROOT };
