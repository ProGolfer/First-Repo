'use strict';
// Phase 2 — the browser side (netlify/mgc-accounts.js) running against the real database functions in PGlite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pg = require('./helpers/pg.cjs');
const { makeBrowser, loadAccounts } = require('./helpers/fake-client.cjs');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-league.json'), 'utf8'));
const LP = fixture.league_players;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const tick = () => new Promise(r => setTimeout(r, 30));

async function setup({ migrate = true } = {}) {
  const db = await pg.newDb();
  if (migrate) await pg.applyMigrations(db);
  const b = makeBrowser(db);
  const acc = loadAccounts(b);
  return { db, b, acc };
}
function allHtml(acc, b) {
  acc.render();
  return [b.els['account-content'].innerHTML, b.els['account-banner'].innerHTML, b.els['admin-profiles-content'].innerHTML].join('\n');
}

test('signed out: shows a Sign in banner and the email form; never blocks the app', async () => {
  const { acc, b } = await setup();
  await acc.init();
  assert.match(b.els['account-banner'].innerHTML, /Sign in to create your permanent golfer profile/);
  assert.match(b.els['account-content'].innerHTML, /Email me a sign-in link/);
  assert.equal(b.els['quick-nav-account'].style.display, '');
});

test('database functions not installed yet: the sign-in UI hides itself and nothing throws', async () => {
  const { acc, b } = await setup({ migrate: false });
  await b.loginAs('someone@example.test');
  await acc.init();
  assert.equal(acc.state().available, false);
  assert.equal(b.els['account-banner'].innerHTML, '');
  assert.equal(b.els['quick-nav-account'].style.display, 'none');
  assert.equal(b.els['admin-profiles-tab'].style.display, 'none');
  assert.equal(acc.isLinked(), false);
  assert.equal(b.store.get('gmg_league_player_id'), undefined);
});

test('magic link: validates the email, asks Supabase with the right redirect, then waits for the link or code', async () => {
  const { acc, b } = await setup();
  await acc.init();
  await acc.sendLink('not-an-email');
  assert.equal(b.calls.otp.length, 0);
  assert.match(b.els['account-content'].innerHTML, /valid email/);
  await acc.sendLink('  Pat@Example.test ');
  assert.equal(b.calls.otp.length, 1);
  assert.equal(b.calls.otp[0].email, 'Pat@Example.test');
  assert.equal(b.calls.otp[0].options.emailRedirectTo, 'https://golf-money-game-live.netlify.app/');
  assert.equal(b.calls.otp[0].options.shouldCreateUser, true);
  assert.equal(acc.state().step, 'check-email');
  assert.match(b.els['account-content'].innerHTML, /Check your email/);
  await acc.verifyCode('pat@example.test', '000000');
  assert.match(b.els['account-content'].innerHTML, /did not work/);
  await acc.verifyCode('pat@example.test', '123456');
  assert.equal(acc.state().step, 'name');
});

test('rate-limited email gives a friendly message', async () => {
  const { acc, b } = await setup();
  await acc.init();
  await acc.sendLink('ratelimit@example.test');
  assert.match(b.els['account-content'].innerHTML, /Too many sign-in emails/);
});

test('first time: sign in, enter a new name, profile is created once and the device is linked', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  await acc.sendLink('newgolfer@example.test');
  await b.clickMagicLink('newgolfer@example.test');
  assert.equal(acc.state().step, 'name');
  assert.ok(b.calls.shown.includes('view-account'), 'a freshly returned, unlinked golfer is taken to profile setup');
  await acc.submitName('  Nora   Newcomer ');
  assert.equal(acc.isLinked(), true);
  assert.equal(acc.accountName(), 'Nora Newcomer');
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 13);
  assert.equal(b.store.get('gmg_player_name'), 'Nora Newcomer');
  assert.ok(b.store.get('gmg_league_player_id'), 'the old flows get the id they expect');
  assert.equal(b.els['reg-name'].value, 'Nora Newcomer');
  assert.equal(b.els['reg-name'].readOnly, true, 'a signed-in golfer registers under their own profile (no accidental second profile)');
  assert.equal(b.els['account-banner'].innerHTML, '');
  assert.match(b.els['account-content'].innerHTML, /You.re signed in/);
  // sign out and back in: same profile, nothing duplicated
  await acc.signOut();
  assert.equal(b.els['reg-name'].readOnly, false);
  assert.equal(b.store.get('gmg_league_player_id'), undefined);
  await b.clickMagicLink('newgolfer@example.test');
  assert.equal(acc.accountName(), 'Nora Newcomer');
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 13);
});

test('returning legacy golfer: confirms "is this you?", links the old history, keeps the same id', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  await b.clickMagicLink('g1@example.test');
  await acc.submitName('golfer 01');
  assert.equal(acc.state().step, 'confirm-claim');
  assert.match(b.els['account-content'].innerHTML, /We found a league profile named <strong>golfer 01<\/strong> with 1 past round\./);
  await acc.claimProfile();
  assert.equal(acc.isLinked(), true);
  assert.equal(acc.accountName(), 'Golfer 01');
  assert.equal(b.store.get('gmg_league_player_id'), LP[0].id);
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 12);
});

test('"No, use a different name" goes back and nothing is linked', async () => {
  const { acc, b } = await setup();
  await acc.init();
  await b.clickMagicLink('g@example.test');
  await acc.submitName('Golfer 02');
  acc.differentName();
  assert.equal(acc.state().step, 'name');
  assert.equal(acc.isLinked(), false);
});

test('duplicate: a second sign-in cannot take a name that is already linked', async () => {
  const { acc, b } = await setup();
  await acc.init();
  await b.clickMagicLink('first@example.test');
  await acc.submitName('Golfer 03'); await acc.claimProfile();
  await acc.signOut();
  await b.clickMagicLink('second@example.test');
  await acc.submitName('golfer 03');
  assert.equal(acc.isLinked(), false);
  assert.match(b.els['account-content'].innerHTML, /already linked to another sign-in/);
});

test('bad names are stopped before they reach the database', async () => {
  const { acc, b } = await setup();
  await acc.init();
  await b.clickMagicLink('x@example.test');
  await acc.submitName('<img src=x onerror=alert(1)>');
  assert.equal(acc.isLinked(), false);
  assert.match(b.els['account-content'].innerHTML, /2–40 letters or numbers/);
  assert.doesNotMatch(b.els['account-content'].innerHTML, /<img/);
});

test('the permanent id is NEVER shown: no screen contains a uuid, before or after sign-in, for golfers or admins', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  assert.doesNotMatch(allHtml(acc, b), UUID);
  await b.clickMagicLink('g1@example.test');
  assert.doesNotMatch(allHtml(acc, b), UUID);
  await acc.submitName('Golfer 01');
  assert.doesNotMatch(allHtml(acc, b), UUID);
  await acc.claimProfile();
  assert.doesNotMatch(allHtml(acc, b), UUID);
  // make this user an admin (the by-hand seed) and open the admin list
  await db.query(`update public.golfer_accounts set is_admin = true`);
  await acc.refreshAccount();
  await acc.renderAdminProfiles();
  const admin = b.els['admin-profiles-content'].innerHTML;
  assert.match(admin, /Golfer 01/);
  assert.match(admin, /g1@example\.test/);
  assert.doesNotMatch(allHtml(acc, b), UUID);
  assert.equal((admin.match(/>Unlink<|>Link to email</g) || []).length, 12);
});

test('admin panel: non-admins see no profile data; admins can unlink and relink, history untouched', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  await b.clickMagicLink('admin@example.test');
  await acc.submitName('Golfer 01'); await acc.claimProfile();
  await acc.renderAdminProfiles();
  assert.match(b.els['admin-profiles-content'].innerHTML, /Sign in with an admin account/);
  assert.doesNotMatch(b.els['admin-profiles-content'].innerHTML, /Golfer 02/);
  await db.query(`update public.golfer_accounts set is_admin = true`);
  await acc.refreshAccount();
  const wrong = await b.ensureUser('wrong@example.test');
  await pg.rpc(db, wrong, 'claim_legacy_profile', ['Golfer 04']);
  const before = await pg.legacyFingerprint(db);
  await acc.renderAdminProfiles();
  const rows = acc.state().adminRows;
  const i = rows.findIndex(r => r.name === 'Golfer 04');
  await acc.adminUnlink(i);
  assert.equal(acc.state().adminRows[i].linked, false);
  b.win._promptValue = 'right@example.test';
  await b.ensureUser('right@example.test');
  await acc.adminRelink(i);
  assert.equal(acc.state().adminRows[i].email, 'right@example.test');
  assert.equal((await pg.legacyFingerprint(db)).sha, before.sha);
  // relinking to an unknown email explains itself
  const j = acc.state().adminRows.findIndex(r => r.name === 'Golfer 09');
  b.win._promptValue = 'nobody@example.test';
  await acc.adminRelink(j);
  assert.match(b.els['admin-profiles-content'].innerHTML, /signed in with that email yet/);
});

test('name and email are HTML-escaped wherever they are shown', async () => {
  const { acc, b } = await setup();
  await acc.init();
  await acc.sendLink('a"><b>@example.test');   // fails validation; and even typed text is escaped on re-render
  assert.doesNotMatch(b.els['account-content'].innerHTML, /<b>/);
  assert.equal(acc._util.esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#039;&amp;');
});

test('index.html wiring: every element the module fills exists, the script loads after the app, scoring code untouched', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../netlify/index.html'), 'utf8');
  for (const id of ['account-banner', 'account-content', 'view-account', 'admin-profiles', 'admin-profiles-content', 'admin-profiles-tab', 'quick-nav-account', 'reg-name'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  const tag = html.indexOf('<script src="mgc-accounts.js"></script>');
  assert.ok(tag > html.lastIndexOf('const SUPABASE_URL'), 'module is loaded after the main app script');
  assert.ok(tag < html.indexOf('</body>'));
  assert.match(html, /MGCAccounts\.isLinked\(\)\) \? MGCAccounts\.accountName\(\)/);
  assert.match(html, /showView\('view-home'\)/);
  // the module file ships alongside index.html
  assert.ok(fs.existsSync(path.join(__dirname, '../netlify/mgc-accounts.js')));
});
