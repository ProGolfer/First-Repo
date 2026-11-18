'use strict';
// Phase 2 — database tests on PGlite (Postgres in Node). Fake data only; nothing here can reach production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pg = require('./helpers/pg.cjs');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-league.json'), 'utf8'));
const LP = fixture.league_players;            // 12 fake golfers, "Golfer 01".."Golfer 12"
const GH = fixture.game_history;              // the 8 legacy rounds, fake ids, real value patterns
const byName = n => LP.find(l => l.name === n);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function migrated() { const db = await pg.newDb(); await pg.applyMigrations(db); return db; }
const count = async (db, t) => Number((await db.query(`select count(*)::int c from public.${t}`)).rows[0].c);

test('fixture is the shape of production: 12 golfers, 8 history rows, every row linked', async () => {
  const db = await pg.newDb();
  assert.equal(await count(db, 'league_players'), 12);
  assert.equal(await count(db, 'game_history'), 8);
  assert.ok(GH.every(r => r.league_player_id));
});

test('ALL 8 game_history rows and 12 league_players are byte-identical after the migrations', async () => {
  const db = await pg.newDb();
  const before = await pg.legacyFingerprint(db);
  await pg.applyMigrations(db);
  const after = await pg.legacyFingerprint(db);
  assert.equal(after.sha, before.sha);
  assert.equal(after.gh.length, 8);
  assert.equal(after.lp.length, 12);
  // row by row, value by value, against the original fixture
  for (const orig of GH) {
    const now = after.gh.find(r => String(r.id) === String(orig.id));
    assert.ok(now, `history row ${orig.id} still exists`);
    assert.equal(now.league_player_id, orig.league_player_id, `row ${orig.id} still points at the same golfer`);
    for (const k of Object.keys(orig)) {
      if (orig[k] === null) { assert.equal(now[k], null, `${orig.id}.${k}`); continue; }
      if (['created_at', 'finalized_at'].includes(k)) { assert.equal(new Date(now[k]).toISOString(), new Date(orig[k]).toISOString(), `${orig.id}.${k}`); continue; }
      if (typeof orig[k] === 'number') { assert.equal(Number(now[k]), orig[k], `${orig.id}.${k}`); continue; }
      if (k === 'game_date' || k === 'date') { assert.equal(String(now[k] instanceof Date ? now[k].toISOString().slice(0, 10) : now[k]).slice(0, 10), String(orig[k]).slice(0, 10), `${orig.id}.${k}`); continue; }
      assert.equal(now[k], orig[k], `${orig.id}.${k}`);
    }
  }
  for (const orig of LP) {
    const now = after.lp.find(r => r.id === orig.id);
    assert.ok(now);
    assert.equal(now.name, orig.name);
    assert.equal(now.normalized_name, orig.normalized_name);
    assert.equal(now.active, orig.active);
  }
});

test('re-running the migrations is harmless', async () => {
  const db = await pg.newDb();
  await pg.applyMigrations(db);
  const a = await pg.legacyFingerprint(db);
  await pg.applyMigrations(db);
  assert.equal((await pg.legacyFingerprint(db)).sha, a.sha);
});

test('ALL 12 legacy golfers can claim their own profile; history stays attached to the right person', async () => {
  const db = await migrated();
  const before = await pg.legacyFingerprint(db);
  const claimed = [];
  for (const lp of LP) {
    const u = await pg.newUser(db, `${lp.normalized_name.replace(/ /g, '')}@example.test`);
    const p = await pg.rpc(db, u, 'claim_legacy_profile', [lp.name.toUpperCase() + '  ']);   // sloppy case and spaces
    assert.equal(p.linked, true);
    assert.equal(p.league_player_id, lp.id, 'linked to the existing profile, not a new one');
    claimed.push(u);
  }
  assert.equal(await count(db, 'league_players'), 12, 'no duplicate profiles were created');
  assert.equal(await count(db, 'golfer_accounts'), 12);
  const after = await pg.legacyFingerprint(db);
  assert.equal(after.sha, before.sha, 'legacy tables identical after all claims');
  // every history row still resolves to the golfer who owns it, and that golfer's sign-in sees it
  for (const r of GH) {
    const owner = await db.query(`select lp.name, ga.auth_user_id from public.game_history h
       join public.league_players lp on lp.id = h.league_player_id join public.golfer_accounts ga on ga.league_player_id = lp.id where h.id = $1`, [r.id]);
    assert.equal(owner.rows.length, 1);
    assert.equal(owner.rows[0].name, LP.find(l => l.id === r.league_player_id).name);
  }
});

test('creating a new profile: one time only, no duplicates, no admin approval needed', async () => {
  const db = await migrated();
  const u = await pg.newUser(db, 'new@example.test');
  assert.deepEqual(await pg.rpc(db, u, 'my_golfer_profile'), { linked: false });
  const p = await pg.rpc(db, u, 'create_my_profile', ['  Pat   Newgolfer ']);
  assert.equal(p.linked, true);
  assert.equal(p.name, 'Pat Newgolfer');
  assert.equal(p.is_admin, false);
  assert.equal(await count(db, 'league_players'), 13);
  const lp = (await db.query(`select * from public.league_players where id = $1`, [p.league_player_id])).rows[0];
  assert.equal(lp.normalized_name, 'pat newgolfer');
  assert.equal(lp.active, true);
  // asking again never creates a second profile
  const again = await pg.rpc(db, u, 'create_my_profile', ['Someone Else']);
  assert.equal(again.league_player_id, p.league_player_id);
  assert.equal(await count(db, 'league_players'), 13);
  // signing back in later returns the same profile
  assert.deepEqual(await pg.rpc(db, u, 'my_golfer_profile'), p);
});

test('duplicate names are blocked (case, spacing) and a legacy name must be claimed, not recreated', async () => {
  const db = await migrated();
  const a = await pg.newUser(db, 'a@example.test');
  const b = await pg.newUser(db, 'b@example.test');
  await pg.rpc(db, a, 'create_my_profile', ['Sam Sample']);
  assert.match(await pg.rpcErr(db, b, 'create_my_profile', ['sam   SAMPLE']), /name_taken/);
  assert.match(await pg.rpcErr(db, b, 'claim_legacy_profile', ['Sam Sample']), /already_claimed/);
  assert.match(await pg.rpcErr(db, b, 'create_my_profile', ['Golfer 05']), /name_claimable/);
  assert.match(await pg.rpcErr(db, b, 'claim_legacy_profile', ['Nobody Here']), /not_found/);
  assert.match(await pg.rpcErr(db, b, 'create_my_profile', ['x']), /invalid_name/);
  assert.match(await pg.rpcErr(db, b, 'create_my_profile', ["<script>alert(1)</script>"]), /invalid_name/);
  assert.match(await pg.rpcErr(db, b, 'create_my_profile', ['a'.repeat(41)]), /invalid_name/);
  assert.equal(await count(db, 'league_players'), 13);
  // two people racing for the same new name: exactly one wins
  const c = await pg.newUser(db, 'c@example.test');
  const d = await pg.newUser(db, 'd@example.test');
  const results = await Promise.allSettled([pg.rpc(db, c, 'create_my_profile', ['Race Runner']), pg.rpc(db, d, 'create_my_profile', ['race runner'])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await db.query(`select count(*)::int c from public.league_players where normalized_name = 'race runner'`)).rows[0].c, 1);
});

test('one sign-in cannot claim a second profile; an inactive profile cannot be claimed', async () => {
  const db = await migrated();
  const u = await pg.newUser(db, 'u@example.test');
  await pg.rpc(db, u, 'claim_legacy_profile', ['Golfer 01']);
  assert.match(await pg.rpcErr(db, u, 'claim_legacy_profile', ['Golfer 02']), /already_linked/);
  assert.equal((await pg.rpc(db, u, 'claim_legacy_profile', ['golfer 01'])).name, 'Golfer 01');   // same one again is fine
  await db.query(`update public.league_players set active = false where name = 'Golfer 07'`);
  const v = await pg.newUser(db, 'v@example.test');
  assert.match(await pg.rpcErr(db, v, 'claim_legacy_profile', ['Golfer 07']), /not_found/);
});

test('check_profile_name tells the app what to offer', async () => {
  const db = await migrated();
  const u = await pg.newUser(db, 'u@example.test');
  assert.deepEqual(await pg.rpc(db, u, 'check_profile_name', ['Brand New']), { status: 'available' });
  assert.deepEqual(await pg.rpc(db, u, 'check_profile_name', ['golfer 01']), { status: 'claimable', rounds: 1 });
  assert.deepEqual(await pg.rpc(db, u, 'check_profile_name', ['?']), { status: 'invalid' });
  await pg.rpc(db, u, 'claim_legacy_profile', ['Golfer 01']);
  assert.deepEqual(await pg.rpc(db, u, 'check_profile_name', ['Golfer 01']), { status: 'yours' });
  const w = await pg.newUser(db, 'w@example.test');
  assert.deepEqual(await pg.rpc(db, w, 'check_profile_name', ['Golfer 01']), { status: 'taken' });
});

test('SECURITY: signed-out visitors can call none of the profile functions', async () => {
  const db = await migrated();
  for (const [fn, args] of [['my_golfer_profile', []], ['check_profile_name', ['x']], ['create_my_profile', ['Hacker']], ['claim_legacy_profile', ['Golfer 01']],
    ['admin_list_profiles', []], ['admin_unlink_profile', [LP[0].id]], ['admin_relink_profile', [LP[0].id, 'x@y.z']], ['is_golfer_admin', []]]) {
    assert.match(await pg.rpcErr(db, null, fn, args), /permission denied/, fn);
  }
  assert.match(await pg.rpcErr(db, { id: '00000000-0000-0000-0000-000000000009', email: 'anon@x', anonymous: true }, 'create_my_profile', ['Anon Person']), /not_signed_in/);
});

test('SECURITY: nobody can grant themselves admin or forge a link through the tables', async () => {
  const db = await migrated();
  const u = await pg.newUser(db, 'u@example.test');
  const p = await pg.rpc(db, u, 'create_my_profile', ['Mallory']);
  const attempts = [
    [u, `update public.golfer_accounts set is_admin = true where league_player_id = $1`, [p.league_player_id]],
    [u, `insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method, is_admin) values ($1, $2, 'claimed', true)`, [LP[0].id, u.id]],
    [u, `delete from public.golfer_accounts where league_player_id = $1`, [p.league_player_id]],
    [u, `select * from public.profile_claim_log`, []],
    [null, `select * from public.golfer_accounts`, []],
    [null, `insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method) values ($1, $2, 'claimed')`, [LP[0].id, u.id]],
    [u, `select public._require_signed_in()`, []]
  ];
  for (const [who, sql, params] of attempts) await assert.rejects(pg.run(db, who, sql, params), /permission denied/, sql);
  assert.equal(await pg.rpc(db, u, 'is_golfer_admin'), false);
  // RLS: a golfer only ever sees their own account row
  const other = await pg.newUser(db, 'o@example.test');
  await pg.rpc(db, other, 'claim_legacy_profile', ['Golfer 02']);
  const seen = await pg.run(db, u, `select league_player_id from public.golfer_accounts`);
  assert.deepEqual(seen.map(r => r.league_player_id), [p.league_player_id]);
});

test('ADMIN: list, unlink a wrong claim, relink to the right person; history never moves', async () => {
  const db = await migrated();
  const gabe = await pg.newUser(db, 'admin@example.test');
  await pg.rpc(db, gabe, 'claim_legacy_profile', ['Golfer 01']);
  assert.match(await pg.rpcErr(db, gabe, 'admin_list_profiles'), /not_admin/);
  // the one-time seed (run by hand after the claim), with the fake name swapped in
  const seed = fs.readFileSync(path.join(pg.ROOT, 'supabase/seed/admin-gabe-after-claim.sql'), 'utf8').replaceAll("'gabe'", "'golfer 01'");
  const seeded = await db.query(seed);
  assert.equal(seeded.rows.length, 1);
  assert.equal((await pg.rpc(db, gabe, 'my_golfer_profile')).is_admin, true);

  const wrong = await pg.newUser(db, 'wrong@example.test');   // someone claimed "Golfer 04" by mistake
  await pg.rpc(db, wrong, 'claim_legacy_profile', ['Golfer 04']);
  const right = await pg.newUser(db, 'right@example.test');
  await pg.rpc(db, right, 'create_my_profile', ['Right Person']);   // has a different profile of their own

  const list = await pg.rpc(db, gabe, 'admin_list_profiles');
  assert.equal(list.length, 13);
  assert.equal(list.find(r => r.name === 'Golfer 04').email, 'wrong@example.test');
  assert.equal(list.find(r => r.name === 'Golfer 05').linked, false);
  assert.equal(list.find(r => r.name === 'Golfer 01').rounds, 1);

  const before = await pg.legacyFingerprint(db);
  assert.match(await pg.rpcErr(db, wrong, 'admin_unlink_profile', [byName('Golfer 04').id]), /not_admin/);
  await pg.rpc(db, gabe, 'admin_unlink_profile', [byName('Golfer 04').id]);
  assert.match(await pg.rpcErr(db, gabe, 'admin_unlink_profile', [byName('Golfer 04').id]), /not_linked/);
  assert.equal((await pg.rpc(db, wrong, 'my_golfer_profile')).linked, false);
  assert.match(await pg.rpcErr(db, gabe, 'admin_relink_profile', [byName('Golfer 04').id, 'nobody@example.test']), /user_not_found/);
  assert.match(await pg.rpcErr(db, gabe, 'admin_relink_profile', [byName('Golfer 04').id, 'right@example.test']), /user_already_linked/);
  await pg.rpc(db, gabe, 'admin_unlink_profile', [(await pg.rpc(db, right, 'my_golfer_profile')).league_player_id]);
  await pg.rpc(db, gabe, 'admin_relink_profile', [byName('Golfer 04').id, 'RIGHT@example.test']);
  assert.equal((await pg.rpc(db, right, 'my_golfer_profile')).league_player_id, byName('Golfer 04').id);
  assert.match(await pg.rpcErr(db, gabe, 'admin_relink_profile', [byName('Golfer 04').id, 'wrong@example.test']), /already_linked/);
  assert.equal((await pg.legacyFingerprint(db)).sha, before.sha, 'unlink/relink never touches league_players or game_history');

  // the last admin cannot lock everyone out
  assert.match(await pg.rpcErr(db, gabe, 'admin_unlink_profile', [byName('Golfer 01').id]), /last_admin/);
  const log = (await db.query(`select action from public.profile_claim_log order by id`)).rows.map(r => r.action);
  assert.deepEqual(log, ['claim', 'claim', 'create', 'unlink', 'unlink', 'relink']);
});

test('history protection: a golfer with rounds or a sign-in link cannot be deleted; others can', async () => {
  const db = await migrated();
  await pg.run(db, null, `delete from public.league_players where id = $1`, [LP[0].id]);   // RLS already hides this from visitors: 0 rows
  assert.equal(await count(db, 'league_players'), 12);
  await assert.rejects(pg.run(db, 'service', `delete from public.league_players where id = $1`, [LP[0].id]), /cannot be deleted/);
  await assert.rejects(pg.run(db, 'service', `truncate public.league_players`));
  await assert.rejects(pg.run(db, null, `truncate public.league_players`));
  // linked but no rounds
  const u = await pg.newUser(db, 'u@example.test');
  const p = await pg.rpc(db, u, 'create_my_profile', ['Linked Newbie']);
  await assert.rejects(pg.run(db, 'service', `delete from public.league_players where id = $1`, [p.league_player_id]), /cannot be deleted/);
  // a plain unused row (like a test player) can still be removed, as today
  await db.query(`insert into public.league_players (name, normalized_name) values ('Throwaway', 'throwaway')`);
  await pg.run(db, 'service', `delete from public.league_players where normalized_name = 'throwaway'`);
  assert.equal(await count(db, 'league_players'), 13);
  assert.equal(await count(db, 'game_history'), 8);
});

test('M7: player_profiles now belongs to the permanent golfer, not the nightly roster', async () => {
  const db = await migrated();
  await pg.run(db, null, `insert into public.player_profiles (player_id, nickname) values ($1, 'Ace')`, [LP[0].id]);   // works
  await assert.rejects(pg.run(db, null, `insert into public.player_profiles (player_id) values (gen_random_uuid())`), /violates foreign key/);
  // wiping the daily roster no longer touches profiles
  await db.query(`insert into public.players (name, league_player_id) values ('Golfer 01', $1)`, [LP[0].id]);
  await pg.run(db, null, `delete from public.players where id is not null`);
  assert.equal(await count(db, 'player_profiles'), 1);
  const fk = (await db.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'player_profiles_player_id_fkey'`)).rows[0].d;
  assert.match(fk, /REFERENCES league_players\(id\)/);
});

test('M7 on a database that already has profile rows: existing rows are untouched', async () => {
  const db = await pg.newDb();
  await db.query(`insert into public.players (id, name) values ('11111111-1111-1111-1111-111111111111', 'Old Roster')`);
  await db.query(`insert into public.player_profiles (player_id, nickname) values ('11111111-1111-1111-1111-111111111111', 'keep me')`);
  await pg.applyMigrations(db);
  assert.equal((await db.query(`select nickname from public.player_profiles`)).rows[0].nickname, 'keep me');
});

test('EXISTING FLOWS still work for golfers who have not signed in (old tables stay open)', async () => {
  const db = await migrated();
  // the app's ensurePermanentLeaguePlayer(): select *, insert {name, normalized_name}, select by id
  const all = await pg.run(db, null, `select * from public.league_players`);
  assert.equal(all.length, 12);
  await pg.run(db, null, `insert into public.league_players (name, normalized_name) values ('Walk Up', 'walk up')`);
  const got = await pg.run(db, null, `select id, name, normalized_name from public.league_players where normalized_name = 'walk up'`);
  assert.equal(got.length, 1);
  // the daily roster and history behave as before
  await pg.run(db, null, `insert into public.players (name, league_player_id, status) values ('Walk Up', $1, 'pending')`, [got[0].id]);
  await pg.run(db, null, `update public.players set status = 'approved' where name = 'Walk Up'`);
  assert.equal((await pg.run(db, null, `select * from public.game_history`)).length, 8);
  // the new tables are invisible and untouchable to them
  await assert.rejects(pg.run(db, null, `select * from public.golfer_accounts`), /permission denied/);
});

test('the read-only live check query is stable across the migrations (same SQL Gabe can run on production before and after)', async () => {
  const db = await pg.newDb();
  const sql = fs.readFileSync(path.join(pg.ROOT, 'supabase/checks/legacy-mapping-check.sql'), 'utf8');
  const before = (await db.query(sql)).rows[0];
  assert.equal(Number(before.league_players), 12);
  assert.equal(Number(before.game_history_rows), 8);
  assert.equal(Number(before.history_rows_unlinked), 0);
  await pg.applyMigrations(db);
  for (const lp of LP) { const u = await pg.newUser(db, `${lp.normalized_name.replace(/ /g, '')}@example.test`); await pg.rpc(db, u, 'claim_legacy_profile', [lp.name]); }
  assert.deepEqual((await db.query(sql)).rows[0], before);
});
