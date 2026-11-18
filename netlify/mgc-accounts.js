/* Money Game Central — golfer sign-in and permanent profile (Phase 2).
 *
 * Email magic-link sign-in (Supabase Auth), one-time profile creation, and linking an existing league profile.
 * Sign-in is OPTIONAL for now: the existing register / team / scoring flows are untouched and keep working for
 * golfers who have not signed in. If the database functions are not installed yet, this file hides itself.
 * The permanent golfer id is kept in memory/localStorage for the app's own use and is never shown on screen.
 */
(function (root) {
  'use strict';

  const state = {
    available: true,      // false when the database has no profile functions yet -> hide all sign-in UI
    session: null,        // supabase session (or null)
    account: null,        // { linked, league_player_id, name, is_admin } from my_golfer_profile()
    step: 'signin',       // signin | check-email | name | confirm-claim | done
    email: '',
    name: '',
    found: null,          // { rounds } for a claimable profile
    busy: false,
    message: '',
    adminRows: null,
    started: false
  };

  const PENDING_KEY = 'mgc_signin_pending';

  // ---- small helpers -------------------------------------------------------------------------------------
  const esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  function normalizeName(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function validName(s) {
    const n = normalizeName(s);
    return n.length >= 2 && n.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9 .'\-]*$/.test(n);
  }
  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()); }

  const FRIENDLY = {
    not_signed_in: 'Please sign in first.',
    invalid_name: 'Please use 2–40 letters or numbers for your name.',
    name_taken: 'That name is already linked to another sign-in. Ask the league admin to relink it.',
    name_claimable: 'A league profile with that name already exists. Choose “Yes, that’s me” to link it.',
    not_found: 'We could not find a league profile with that name.',
    already_claimed: 'That profile is already linked to another sign-in. Ask the league admin to relink it.',
    already_linked: 'You already have a profile linked to this sign-in.',
    not_admin: 'Only league admins can do that.',
    not_linked: 'That profile is not linked to anyone.',
    last_admin: 'You cannot unlink the last admin.',
    user_not_found: 'No one has signed in with that email yet. They need to sign in once first.',
    user_already_linked: 'That email is already linked to another profile.'
  };
  function friendly(err) {
    const msg = String((err && (err.message || err.error_description)) || err || '');
    for (const k of Object.keys(FRIENDLY)) if (new RegExp('\\b' + k + '\\b').test(msg)) return FRIENDLY[k];   // whole code only: 'not_found' must not match 'user_not_found'
    if (/rate limit|too many|over_email_send_rate_limit/i.test(msg)) return 'Too many sign-in emails were requested. Wait a few minutes and try again.';
    if (/invalid|expired|otp/i.test(msg)) return 'That code or link did not work. Request a new one.';
    return 'Something went wrong. Please try again.';
  }
  function isMissingFunction(err) {
    const msg = String((err && err.message) || '');
    return !!err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function|schema cache/i.test(msg));
  }

  function client() { return root.supabaseClient; }
  async function rpc(name, args) {
    const { data, error } = await client().rpc(name, args || {});
    if (error) throw error;
    return data;
  }

  // ---- account state -------------------------------------------------------------------------------------
  function applyAccountToDevice() {
    // Make the app's existing flows recognise this golfer. The id stays in localStorage only (never rendered).
    const a = state.account;
    if (!a || !a.linked) return;
    try {
      root.localStorage.setItem('gmg_league_player_id', String(a.league_player_id));
      if (typeof root.saveThisDevicePlayerName === 'function') root.saveThisDevicePlayerName(a.name);
      else root.localStorage.setItem('gmg_player_name', a.name);
      const input = root.document && root.document.getElementById('reg-name');
      if (input) { input.value = a.name; input.readOnly = true; }
    } catch (_) { /* never block the app */ }
  }

  async function refreshAccount() {
    if (!state.available) return null;
    if (!state.session) { state.account = null; render(); return null; }
    try {
      state.account = await rpc('my_golfer_profile');
      if (state.account && state.account.linked) { state.step = 'done'; applyAccountToDevice(); }
      else if (state.step === 'done' || state.step === 'signin' || state.step === 'check-email') state.step = 'name';
    } catch (err) {
      if (isMissingFunction(err)) state.available = false;
      else state.message = friendly(err);
    }
    render();
    return state.account;
  }

  async function init() {
    if (state.started) return;
    state.started = true;
    if (!client() || !client().auth) { state.available = false; render(); return; }
    try {
      const { data } = await client().auth.getSession();
      state.session = (data && data.session) || null;
      client().auth.onAuthStateChange((event, session) => {
        const had = !!state.session;
        state.session = session || null;
        if (event === 'SIGNED_OUT') { state.account = null; state.step = 'signin'; render(); return; }
        if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
          // Defer: supabase-js must not be re-entered from inside its own auth callback.
          setTimeout(async () => {
            await refreshAccount();
            const justReturned = root.localStorage.getItem(PENDING_KEY) === '1';
            if (!had && justReturned && state.available && state.account && !state.account.linked) open();
            if (justReturned && state.account) root.localStorage.removeItem(PENDING_KEY);
          }, 0);
        }
      });
      if (state.session) await refreshAccount(); else render();
    } catch (err) {
      state.message = friendly(err);
      render();
    }
  }

  // ---- actions ---------------------------------------------------------------------------------------------
  async function sendLink(email) {
    email = String(email || '').trim();
    if (!validEmail(email)) { state.message = 'Enter a valid email address.'; return render(); }
    state.busy = true; state.message = ''; render();
    try {
      const redirect = root.location.origin + root.location.pathname;
      const { error } = await client().auth.signInWithOtp({ email, options: { emailRedirectTo: redirect, shouldCreateUser: true } });
      if (error) throw error;
      root.localStorage.setItem(PENDING_KEY, '1');
      state.email = email; state.step = 'check-email';
    } catch (err) { state.message = friendly(err); }
    state.busy = false; render();
  }

  async function verifyCode(email, token) {
    token = String(token || '').replace(/\s+/g, '');
    if (!/^\d{6,10}$/.test(token)) { state.message = 'Enter the numeric code from the email.'; return render(); }
    state.busy = true; state.message = ''; render();
    try {
      const { data, error } = await client().auth.verifyOtp({ email: email || state.email, token, type: 'email' });
      if (error) throw error;
      state.session = (data && data.session) || state.session;
      await refreshAccount();
      if (state.account && !state.account.linked) state.step = 'name';
    } catch (err) { state.message = friendly(err); }
    state.busy = false; render();
  }

  async function submitName(name) {
    name = normalizeName(name);
    if (!validName(name)) { state.message = FRIENDLY.invalid_name; return render(); }
    state.busy = true; state.message = ''; state.name = name; render();
    try {
      const res = await rpc('check_profile_name', { p_name: name });
      if (res.status === 'available') { await createProfile(name); }
      else if (res.status === 'claimable') { state.found = { rounds: Number(res.rounds || 0) }; state.step = 'confirm-claim'; }
      else if (res.status === 'yours') { await refreshAccount(); }
      else if (res.status === 'taken') state.message = FRIENDLY.name_taken;
      else state.message = FRIENDLY.invalid_name;
    } catch (err) { state.message = friendly(err); }
    state.busy = false; render();
  }

  async function createProfile(name) {
    state.account = await rpc('create_my_profile', { p_name: name });
    state.step = 'done'; applyAccountToDevice();
  }

  async function claimProfile() {
    state.busy = true; state.message = ''; render();
    try {
      state.account = await rpc('claim_legacy_profile', { p_name: state.name });
      state.step = 'done'; applyAccountToDevice();
    } catch (err) { state.message = friendly(err); state.step = 'name'; }
    state.busy = false; render();
  }

  function differentName() { state.step = 'name'; state.found = null; state.message = ''; render(); }
  function back() { state.step = 'signin'; state.message = ''; render(); }

  async function signOut() {
    try {
      const mine = state.account && state.account.league_player_id;
      await client().auth.signOut();
      if (mine && root.localStorage.getItem('gmg_league_player_id') === String(mine)) root.localStorage.removeItem('gmg_league_player_id');
      const input = root.document && root.document.getElementById('reg-name');
      if (input) { input.readOnly = false; }
    } catch (_) { /* ignore */ }
    state.session = null; state.account = null; state.step = 'signin'; state.message = '';
    render();
  }

  // ---- admin: unlink / relink ---------------------------------------------------------------------------------
  async function loadAdminRows() {
    try { state.adminRows = await rpc('admin_list_profiles'); state.message = ''; }
    catch (err) { state.adminRows = null; state.message = isMissingFunction(err) ? 'Profile tools are not installed yet.' : friendly(err); }
  }
  async function renderAdminProfiles() { await loadAdminRows(); render(); }
  async function adminUnlink(index) {
    const row = state.adminRows && state.adminRows[index]; if (!row) return;
    if (!root.confirm('Unlink ' + row.name + ' from their sign-in? Their profile and history stay exactly as they are.')) return;
    try { await rpc('admin_unlink_profile', { p_league_player_id: row.league_player_id }); await loadAdminRows(); }
    catch (err) { state.message = friendly(err); }
    render();
  }
  async function adminRelink(index) {
    const row = state.adminRows && state.adminRows[index]; if (!row) return;
    const email = root.prompt('Email address of the person who should own the profile "' + row.name + '":');
    if (!email) return;
    try { await rpc('admin_relink_profile', { p_league_player_id: row.league_player_id, p_email: email }); await loadAdminRows(); }
    catch (err) { state.message = friendly(err); }
    render();
  }

  // ---- views (HTML strings; the golfer id is never included) -------------------------------------------------
  function msgHtml() { return state.message ? '<div class="award-empty" role="alert" style="color:#ffb86b;margin:10px 0;">' + esc(state.message) + '</div>' : ''; }

  function accountViewHtml() {
    const dis = state.busy ? ' disabled' : '';
    let body = '';
    if (!state.available) {
      body = '<p>Sign-in is not available yet.</p>';
    } else if (state.step === 'done' && state.account && state.account.linked) {
      body = '<div class="dashboard-panel"><h3>You\u2019re signed in</h3><p>Your league profile: <strong>' + esc(state.account.name) + '</strong></p>' +
        '<button class="btn btn-back" onclick="MGCAccounts.signOut()">Sign out</button></div>';
    } else if (state.step === 'confirm-claim') {
      const r = state.found && state.found.rounds;
      body = '<div class="dashboard-panel"><h3>Is this you?</h3><p>We found a league profile named <strong>' + esc(state.name) + '</strong>' +
        (r ? ' with ' + esc(r) + ' past round' + (r === 1 ? '' : 's') : '') + '. Linking it keeps your history.</p>' +
        '<button class="btn btn-primary"' + dis + ' onclick="MGCAccounts.claimProfile()">Yes, that\u2019s me</button>' +
        '<button class="btn btn-back"' + dis + ' onclick="MGCAccounts.differentName()">No, use a different name</button></div>';
    } else if (state.step === 'name') {
      body = '<div class="dashboard-panel"><h3>Set up your golfer profile</h3><p>Enter your name the way the league knows you. You only do this once.</p>' +
        '<div class="form-group"><label>Your Name</label><input type="text" id="account-name" value="' + esc(state.name) + '" placeholder="Enter your name" autocomplete="off" autocapitalize="words" spellcheck="false"></div>' +
        '<button class="btn btn-primary"' + dis + ' onclick="MGCAccounts.submitName(document.getElementById(\'account-name\').value)">Continue</button>' +
        '<button class="btn btn-back"' + dis + ' onclick="MGCAccounts.signOut()">Sign out</button></div>';
    } else if (state.step === 'check-email') {
      body = '<div class="dashboard-panel"><h3>Check your email</h3><p>We sent a sign-in link to <strong>' + esc(state.email) + '</strong>. Open it on this device. ' +
        'If the link opens somewhere else, type the code from the email instead.</p>' +
        '<div class="form-group"><label>Code from the email (optional)</label><input type="text" id="account-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></div>' +
        '<button class="btn btn-primary"' + dis + ' onclick="MGCAccounts.verifyCode(MGCAccounts.state().email, document.getElementById(\'account-code\').value)">Sign in with code</button>' +
        '<button class="btn btn-back"' + dis + ' onclick="MGCAccounts.back()">Use a different email</button></div>';
    } else {
      body = '<div class="dashboard-panel"><h3>Sign in</h3><p>Sign in with your email to create or link your permanent golfer profile. No password needed.</p>' +
        '<div class="form-group"><label>Email</label><input type="email" id="account-email" value="' + esc(state.email) + '" placeholder="you@example.com" autocomplete="email" autocapitalize="none" spellcheck="false"></div>' +
        '<button class="btn btn-primary"' + dis + ' onclick="MGCAccounts.sendLink(document.getElementById(\'account-email\').value)">Email me a sign-in link</button></div>';
    }
    return '<div class="header"><div class="header-logo"><div class="logo-mark">\u26F3</div><h1>MY <span>ACCOUNT</span></h1></div></div>' +
      msgHtml() + body + '<button class="btn btn-back" onclick="showView(\'view-home\')">\u2190 Back</button>';
  }

  function bannerHtml() {
    if (!state.available) return '';
    if (state.account && state.account.linked) return '';
    const text = state.session ? 'Finish setting up your golfer profile.' : 'Sign in to create your permanent golfer profile.';
    const label = state.session ? 'Continue' : 'Sign in';
    return '<div class="dashboard-panel" style="display:flex;gap:10px;align-items:center;justify-content:space-between;margin:10px 0;">' +
      '<span>' + esc(text) + '</span><button class="btn btn-primary" style="width:auto;margin:0;" onclick="MGCAccounts.open()">' + esc(label) + '</button></div>';
  }

  function adminHtml() {
    if (!state.available) return '<div class="award-empty">Profile tools are not installed yet.</div>';
    if (!(state.account && state.account.is_admin)) {
      return msgHtml() + '<div class="award-empty">Sign in with an admin account to manage golfer profiles.</div>';
    }
    if (!state.adminRows) return msgHtml() + '<div class="award-empty">Loading profiles...</div>';
    const rows = state.adminRows.map((r, i) =>
      '<div class="avg-line" style="display:grid;grid-template-columns:1.2fr 1.6fr auto;gap:8px;align-items:center;">' +
      '<span><strong>' + esc(r.name) + '</strong><br><small>' + esc(r.rounds) + ' round' + (r.rounds === 1 ? '' : 's') + (r.is_admin ? ' \u00b7 admin' : '') + '</small></span>' +
      '<span>' + (r.linked ? esc(r.email || 'Linked') : '<em>Not linked</em>') + '</span>' +
      '<span>' + (r.linked
        ? '<button class="btn btn-back" style="width:auto;margin:0;" onclick="MGCAccounts.adminUnlink(' + i + ')">Unlink</button>'
        : '<button class="btn btn-primary" style="width:auto;margin:0;" onclick="MGCAccounts.adminRelink(' + i + ')">Link to email</button>') + '</span></div>').join('');
    return msgHtml() + '<div class="award-empty" style="margin-bottom:8px;">Unlinking never changes a golfer\u2019s profile or history. It only frees the profile to be claimed again.</div>' + rows;
  }

  function render() {
    const d = root.document; if (!d) return;
    const set = (id, html) => { const el = d.getElementById(id); if (el) el.innerHTML = html; };
    set('account-content', accountViewHtml());
    set('account-banner', bannerHtml());
    set('admin-profiles-content', adminHtml());
    const nav = d.getElementById('quick-nav-account'); if (nav) nav.style.display = state.available ? '' : 'none';
    const tab = d.getElementById('admin-profiles-tab'); if (tab) tab.style.display = state.available ? '' : 'none';
  }

  function open() {
    if (state.session && state.account && !state.account.linked) state.step = 'name';
    else if (state.account && state.account.linked) state.step = 'done';
    render();
    if (typeof root.showView === 'function') root.showView('view-account');
  }

  const api = {
    init, open, render, refreshAccount, sendLink, verifyCode, submitName, claimProfile, differentName, back, signOut,
    renderAdminProfiles, adminUnlink, adminRelink,
    // exposed for tests / other modules
    state: () => state, accountName: () => (state.account && state.account.linked ? state.account.name : ''),
    isLinked: () => !!(state.account && state.account.linked), isAdmin: () => !!(state.account && state.account.is_admin),
    _html: { account: accountViewHtml, banner: bannerHtml, admin: adminHtml }, _util: { normalizeName, validName, validEmail, friendly, isMissingFunction, esc }
  };
  root.MGCAccounts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (root.addEventListener && root.document) {
    root.addEventListener('load', () => { init().catch(() => {}); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
