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

async function approveClaim(db, playerName, { admin = false, email = null } = {}) {
  const lp = LP.find(l => l.name === playerName);
  const params = [lp.id, admin];
  const emailFilter = email ? 'and u.email = $3' : '';
  if (email) params.push(email.toLowerCase());
  await db.query(`
    with pending as (
      select r.id, r.league_player_id, r.auth_user_id
        from public.profile_claim_requests r
        join auth.users u on u.id = r.auth_user_id
       where r.league_player_id = $1 and r.status = 'pending' ${emailFilter}
       order by r.created_at
       limit 1
    ),
    linked as (
      insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method, is_admin, admin_granted_at)
      select p.league_player_id, p.auth_user_id, 'claimed', $2, case when $2 then now() else null end
        from pending p
      returning auth_user_id
    )
    update public.profile_claim_requests r
       set status = 'approved', resolved_at = now()
      from linked l
     where r.auth_user_id = l.auth_user_id and r.status = 'pending'`, params);
}

async function setup({ migrate = true, origin, pathname } = {}) {
  const db = await pg.newDb();
  if (migrate) await pg.applyMigrations(db);
  const opts = {};
  if (origin) opts.origin = origin;
  if (pathname) opts.pathname = pathname;
  const b = makeBrowser(db, opts);
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

test('returning legacy golfer: confirms "is this you?", sends a request, and links only after admin approval', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  await b.clickMagicLink('g1@example.test');
  await acc.submitName('golfer 01');
  assert.equal(acc.state().step, 'confirm-claim');
  assert.match(b.els['account-content'].innerHTML, /We found a league profile named <strong>golfer 01<\/strong> with 1 past round\./);
  assert.match(b.els['account-content'].innerHTML, /An admin must approve/);
  await acc.claimProfile();
  assert.equal(acc.isLinked(), false);
  assert.equal(acc.state().step, 'pending-claim');
  assert.match(b.els['account-content'].innerHTML, /Request sent, waiting for admin approval/);
  assert.match(b.els['account-banner'].innerHTML, /waiting for admin approval/);
  assert.equal(b.store.get('gmg_league_player_id'), undefined);
  assert.equal(Number((await db.query(`select count(*) c from public.golfer_accounts`)).rows[0].c), 0);
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 12);

  await approveClaim(db, 'Golfer 01');
  await acc.refreshAccount();
  assert.equal(acc.isLinked(), true);
  assert.equal(acc.accountName(), 'Golfer 01');
  assert.equal(b.store.get('gmg_league_player_id'), LP[0].id);
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 12);
  assert.match(b.els['account-content'].innerHTML, /You.re signed in/);
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
  const { acc, b, db } = await setup();
  await acc.init();
  await b.clickMagicLink('first@example.test');
  await acc.submitName('Golfer 03'); await acc.claimProfile();
  await approveClaim(db, 'Golfer 03');
  await acc.refreshAccount();
  assert.equal(acc.isLinked(), true);
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
  assert.match(b.els['account-content'].innerHTML, /waiting for admin approval/);
  await approveClaim(db, 'Golfer 01', { admin: true });
  await acc.refreshAccount();
  assert.doesNotMatch(allHtml(acc, b), UUID);
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
  await approveClaim(db, 'Golfer 01', { admin: true });
  await acc.refreshAccount();
  const wrong = await b.ensureUser('wrong@example.test');
  await pg.rpc(db, wrong, 'claim_legacy_profile', ['Golfer 04']);
  await approveClaim(db, 'Golfer 04');
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

test('admin can approve or reject a pending request from the profile list', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  await b.clickMagicLink('admin@example.test');
  await acc.submitName('League Admin');
  await db.query(`update public.golfer_accounts set is_admin = true`);
  await acc.refreshAccount();
  const claimant = await b.ensureUser('waiter@example.test');
  await pg.rpc(db, claimant, 'claim_legacy_profile', ['Golfer 05']);
  const other = await b.ensureUser('nope@example.test');
  await pg.rpc(db, other, 'claim_legacy_profile', ['Golfer 06']);
  await acc.renderAdminProfiles();
  const adminHtml = b.els['admin-profiles-content'].innerHTML;
  assert.match(adminHtml, /Pending profile requests/);
  assert.match(adminHtml, /Golfer 05/);
  assert.match(adminHtml, /Golfer 06/);
  assert.match(adminHtml, /waiter@example\.test/);
  assert.match(adminHtml, />Approve</);
  assert.match(adminHtml, />Reject</);
  assert.doesNotMatch(adminHtml, UUID);
  const pending = acc.state().pendingRequests;
  const i05 = pending.findIndex(r => r.name === 'Golfer 05');
  const i06 = pending.findIndex(r => r.name === 'Golfer 06');
  await acc.adminApproveClaim(i05);
  assert.equal((await pg.rpc(db, claimant, 'my_golfer_profile')).linked, true);
  assert.equal((await pg.rpc(db, claimant, 'my_golfer_profile')).name, 'Golfer 05');
  // indices may have shifted after the approve; reload and reject the remaining request
  const i06b = acc.state().pendingRequests.findIndex(r => r.name === 'Golfer 06');
  await acc.adminRejectClaim(i06b);
  assert.equal((await pg.rpc(db, other, 'my_golfer_profile')).linked, false);
  assert.equal((await pg.rpc(db, other, 'my_claim_status')).status, 'rejected');
  assert.doesNotMatch(allHtml(acc, b), UUID);
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


test('expired magic link in the URL hash shows a friendly message and stays on sign-in', async () => {
  const { acc, b } = await setup();
  b.landFromAuthRedirect('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await acc.init();
  assert.match(b.els['account-content'].innerHTML, /expired or has already been used/);
  assert.ok(b.calls.shown.includes('view-account'), 'the golfer is taken to sign-in so they can request a new link');
  assert.equal(acc.isLinked(), false);
  assert.equal(b.win.location.hash, '', 'the error is cleared from the URL so a refresh does not keep showing it');
  assert.equal(acc.state().step, 'signin');
});

test('an already-used (reused) magic link shows the same friendly expired/used message', async () => {
  const { acc, b } = await setup();
  await acc.init();
  await acc.sendLink('reuse@example.test');
  await b.clickMagicLink('reuse@example.test');
  await acc.submitName('Reuse Golfer');
  assert.equal(acc.isLinked(), true);
  await acc.signOut();
  // A second click of the same one-time link comes back as otp_expired / access_denied.
  b.landFromAuthRedirect('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await acc.init();
  assert.match(b.els['account-content'].innerHTML, /expired or has already been used/);
  assert.equal(acc.isLinked(), false);
  assert.equal(acc.state().session, null);
  assert.equal(b.win.location.hash, '');
});

test('invalid emails are rejected in the browser and never sent to Supabase', async () => {
  const { acc, b } = await setup();
  await acc.init();
  for (const bad of ['', 'not-an-email', 'foo@', '@bar.com', 'a b@c.d', 'plainaddress']) {
    b.calls.otp.length = 0;
    await acc.sendLink(bad);
    assert.equal(b.calls.otp.length, 0, bad);
    assert.match(b.els['account-content'].innerHTML, /valid email/);
  }
});

test('returning user signs straight into the same profile with no duplicate and no name form', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  await acc.sendLink('returning@example.test');
  await b.clickMagicLink('returning@example.test');
  await acc.submitName('Returning Golfer');
  assert.equal(acc.isLinked(), true);
  const afterCreate = Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c);
  assert.equal(afterCreate, 13);
  const shownAfterCreate = b.calls.shown.length;
  await acc.signOut();
  await acc.sendLink('returning@example.test');
  await b.clickMagicLink('returning@example.test');
  assert.equal(acc.isLinked(), true);
  assert.equal(acc.accountName(), 'Returning Golfer');
  assert.equal(acc.state().step, 'done');
  assert.match(b.els['account-content'].innerHTML, /You.re signed in/);
  assert.doesNotMatch(b.els['account-content'].innerHTML, /Set up your golfer profile/);
  assert.equal(b.els['account-banner'].innerHTML, '');
  assert.equal(b.calls.shown.slice(shownAfterCreate).includes('view-account'), false, 'a linked returning golfer is not sent through setup again');
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 13);
  assert.equal(Number((await db.query(`select count(*) c from public.golfer_accounts`)).rows[0].c), 1);
});

test('a new golfer creates one permanent profile and a second try at the same normalized name does not duplicate it', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  await acc.sendLink('casey@example.test');
  await b.clickMagicLink('casey@example.test');
  await acc.submitName('  Casey Unique ');
  assert.equal(acc.isLinked(), true);
  assert.equal(acc.accountName(), 'Casey Unique');
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 13);
  await acc.signOut();
  await b.clickMagicLink('othercasey@example.test');
  await acc.submitName('casey   unique');
  assert.equal(acc.isLinked(), false);
  assert.match(b.els['account-content'].innerHTML, /already linked to another sign-in/);
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 13);
  assert.equal(Number((await db.query(`select count(*) c from public.golfer_accounts`)).rows[0].c), 1);
});

test('claiming an existing name stays pending until an admin approves; no duplicate golfer row', async () => {
  const { acc, b, db } = await setup();
  await acc.init();
  await acc.sendLink('legacy@example.test');
  await b.clickMagicLink('legacy@example.test');
  await acc.submitName('Golfer 08');
  await acc.claimProfile();
  assert.equal(acc.state().step, 'pending-claim');
  assert.equal(acc.isLinked(), false);
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 12);
  assert.equal(Number((await db.query(`select count(*) c from public.golfer_accounts`)).rows[0].c), 0);
  assert.equal(Number((await db.query(`select count(*) c from public.profile_claim_requests where status = 'pending'`)).rows[0].c), 1);
  // sign out and back in: the request is still pending, nothing was created or auto-approved
  await acc.signOut();
  await b.clickMagicLink('legacy@example.test');
  assert.equal(acc.state().step, 'pending-claim');
  assert.equal(acc.isLinked(), false);
  assert.match(b.els['account-content'].innerHTML, /waiting for admin approval/);
  assert.equal(Number((await db.query(`select count(*) c from public.league_players`)).rows[0].c), 12);
  assert.equal(Number((await db.query(`select count(*) c from public.golfer_accounts`)).rows[0].c), 0);
});

test('a Netlify preview sends the magic-link redirect back to its own origin and path', async () => {
  const { acc, b } = await setup({
    origin: 'https://deploy-preview-12--golf-money-game-live.netlify.app',
    pathname: '/app/'
  });
  await acc.init();
  await acc.sendLink('preview@example.test');
  assert.equal(b.calls.otp.length, 1);
  assert.equal(b.calls.otp[0].options.emailRedirectTo, 'https://deploy-preview-12--golf-money-game-live.netlify.app/app/');
  assert.equal(b.calls.otp[0].options.shouldCreateUser, true);
});
