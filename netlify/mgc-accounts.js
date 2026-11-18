/* Money Game Central — golfer sign-in and permanent profile (Phase 2).
 *
 * Email magic-link sign-in (Supabase Auth), one-time profile creation, and requesting to link an
 * existing league profile (an admin must approve before the email is linked). Sign-in is OPTIONAL
 * for now: the existing register / team / scoring flows are untouched and keep working for golfers
 * who have not signed in. If the database functions are not installed yet, this file hides itself.
 * The permanent golfer id is fetched with current_golfer_id() after a link is approved, kept in
 * memory/localStorage for the app's own use, and is never shown on screen.
 */
(function (root) {
  'use strict';

  const state = {
    available: true,      // false when the database has no profile functions yet -> hide all sign-in UI
    session: null,        // supabase session (or null)
    account: null,        // { linked, name, is_admin } from my_golfer_profile()
    claim: null,          // { linked, status, name } from my_claim_status()
    step: 'signin',       // signin | check-email | name | suggest-name | confirm-claim | pending-claim | done
    email: '',
    name: '',
    typedName: '',        // what the golfer typed, kept when we offer a look-alike
    found: null,          // { rounds } for a claimable profile
    suggestions: null,    // [{ name, rounds }] from check_profile_name status 'suggest'
    busy: false,
    message: '',
    adminRows: null,
    pendingRequests: null,
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
    name_claimable: 'A league profile with that name already exists. Choose “Yes, that’s me” to request it.',
    not_found: 'We could not find a league profile with that name.',
    already_claimed: 'That profile is already linked to another sign-in. Ask the league admin to relink it.',
    already_linked: 'You already have a profile linked to this sign-in.',
    already_pending: 'You already have a profile request waiting for approval.',
    not_pending: 'That request has already been reviewed.',
    not_admin: 'Only league admins can do that.',
    not_linked: 'That profile is not linked to anyone.',
    last_admin: 'You cannot unlink the last admin.',
    user_not_found: 'No one has signed in with that email yet. They need to sign in once first.',
    user_already_linked: 'That email is already linked to another profile.'
  };
  function friendly(err) {
    const code = String((err && (err.error_code || err.code)) || '');
    const kind = String((err && err.error) || '');
    const msg = String((err && (err.message || err.error_description)) || err || '');
    const blob = [code, kind, msg].join(' ');
    for (const k of Object.keys(FRIENDLY)) if (new RegExp('\\b' + k + '\\b').test(msg) || code === k) return FRIENDLY[k];   // whole code only: 'not_found' must not match 'user_not_found'
    if (/rate limit|too many|over_email_send_rate_limit/i.test(blob)) return 'Too many sign-in emails were requested. Wait a few minutes and try again.';
    // Magic-link returns land with #error=access_denied&error_code=otp_expired (expired or already-used links).
    if (/otp_expired|access_denied/i.test(blob) || /link.{0,40}(expired|already been used|invalid)/i.test(msg))
      return 'That sign-in link has expired or has already been used. Request a new one.';
    if (/invalid|expired|otp/i.test(blob)) return 'That code or link did not work. Request a new one.';
    return 'Something went wrong. Please try again.';
  }

  function queryParams(raw) {
    try { return new URLSearchParams(String(raw || '').replace(/^[?#]/, '')); }
    catch (_) { return new URLSearchParams(); }
  }
  // Read otp_expired / access_denied (and similar) from the URL hash or query, then clear them so a refresh does not repeat the message.
  function consumeAuthRedirectError() {
    const loc = root.location || {};
    const params = queryParams(loc.hash);
    queryParams(loc.search).forEach((v, k) => { if (!params.has(k)) params.set(k, v); });
    const error = params.get('error') || '';
    const error_code = params.get('error_code') || params.get('errorCode') || '';
    const error_description = params.get('error_description') || params.get('errorDescription') || '';
    if (!error && !error_code) return false;
    state.message = friendly({ error, error_code, error_description, message: error_description || error_code || error });
    try {
      if (root.history && typeof root.history.replaceState === 'function') {
        root.history.replaceState(null, '', (loc.pathname || '/') + (loc.search || ''));
      }
      loc.hash = '';
    } catch (_) {}
    return true;
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
  async function applyAccountToDevice() {
    // Make the app's existing flows recognise this golfer. The id stays in localStorage only (never rendered).
    const a = state.account;
    if (!a || !a.linked) return;
    try {
      const id = await rpc('current_golfer_id');
      if (id) root.localStorage.setItem('gmg_league_player_id', String(id));
      if (typeof root.saveThisDevicePlayerName === 'function') root.saveThisDevicePlayerName(a.name);
      else root.localStorage.setItem('gmg_player_name', a.name);
      const input = root.document && root.document.getElementById('reg-name');
      if (input) { input.value = a.name; input.readOnly = true; }
    } catch (_) { /* never block the app */ }
  }

  async function loadClaimStatus() {
    try {
      state.claim = await rpc('my_claim_status');
    } catch (err) {
      if (isMissingFunction(err)) { state.claim = null; return; }
      throw err;
    }
  }

  function applyUnlinkedStep() {
    if (state.claim && state.claim.status === 'pending') {
      state.step = 'pending-claim';
      if (state.claim.name) state.name = state.claim.name;
    } else if (state.claim && state.claim.status === 'rejected') {
      if (state.step !== 'name' && state.step !== 'confirm-claim') {
        state.step = 'name';
        state.message = 'Your request to link ' + (state.claim.name || 'that profile') + ' was not approved. You can request again or use a different name.';
      }
    } else if (state.step === 'done' || state.step === 'signin' || state.step === 'check-email' || state.step === 'pending-claim') {
      state.step = 'name';
    }
  }

  async function refreshAccount() {
    if (!state.available) return null;
    if (!state.session) { state.account = null; state.claim = null; render(); return null; }
    try {
      state.account = await rpc('my_golfer_profile');
      if (state.account && state.account.linked) {
        state.claim = { status: 'linked', linked: true, name: state.account.name };
        state.step = 'done';
        await applyAccountToDevice();
      } else {
        await loadClaimStatus();
        applyUnlinkedStep();
      }
    } catch (err) {
      if (isMissingFunction(err)) state.available = false;
      else state.message = friendly(err);
    }
    render();
    return state.account;
  }

  async function init() {
    const hadRedirectError = consumeAuthRedirectError();
    if (state.started) {
      if (hadRedirectError) {
        if (!state.session && typeof root.showView === 'function') root.showView('view-account');
        render();
      }
      return;
    }
    state.started = true;
    if (!client() || !client().auth) { state.available = false; render(); return; }
    try {
      const { data } = await client().auth.getSession();
      state.session = (data && data.session) || null;
      client().auth.onAuthStateChange((event, session) => {
        const had = !!state.session;
        state.session = session || null;
        if (event === 'SIGNED_OUT') { state.account = null; state.claim = null; state.step = 'signin'; render(); return; }
        if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
          // Defer: supabase-js must not be re-entered from inside its own auth callback.
          setTimeout(async () => {
            await refreshAccount();
            const justReturned = root.localStorage.getItem(PENDING_KEY) === '1';
            // Linked returning golfers go straight in (step=done via refreshAccount) and stay on the current page.
            // Only unlinked golfers are taken to profile setup.
            if (!had && justReturned && state.available && state.account && !state.account.linked) open();
            if (justReturned && state.account) root.localStorage.removeItem(PENDING_KEY);
          }, 0);
        }
      });
      if (state.session) await refreshAccount(); else render();
      if (hadRedirectError && !state.session && typeof root.showView === 'function') root.showView('view-account');
      if (hadRedirectError) render();
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
      if (state.account && !state.account.linked && state.step !== 'pending-claim') state.step = 'name';
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
      else if (res.status === 'suggest' && Array.isArray(res.suggestions) && res.suggestions.length) {
        state.typedName = name;
        state.suggestions = res.suggestions.map(s => ({ name: s.name, rounds: Number(s.rounds || 0) }));
        state.step = 'suggest-name';
      }
      else if (res.status === 'claimable') { state.found = { rounds: Number(res.rounds || 0) }; state.step = 'confirm-claim'; }
      else if (res.status === 'pending') { state.found = { rounds: Number(res.rounds || 0) }; state.step = 'pending-claim'; }
      else if (res.status === 'yours') { await refreshAccount(); }
      else if (res.status === 'taken') state.message = FRIENDLY.name_taken;
      else state.message = FRIENDLY.invalid_name;
    } catch (err) { state.message = friendly(err); }
    state.busy = false; render();
  }

  async function createProfile(name) {
    state.account = await rpc('create_my_profile', { p_name: name });
    state.claim = { status: 'linked', linked: true, name: state.account && state.account.name };
    state.step = 'done';
    await applyAccountToDevice();
  }

  async function claimProfile() {
    state.busy = true; state.message = ''; render();
    try {
      const res = await rpc('claim_legacy_profile', { p_name: state.name });
      if (res && res.linked) {
        state.account = res;
        state.claim = { status: 'linked', linked: true, name: res.name };
        state.step = 'done';
        await applyAccountToDevice();
      } else {
        state.claim = res;
        state.step = 'pending-claim';
        if (res && res.name) state.name = res.name;
      }
    } catch (err) { state.message = friendly(err); state.step = 'name'; }
    state.busy = false; render();
  }

  function differentName() { state.step = 'name'; state.found = null; state.suggestions = null; state.message = ''; render(); }

  // "Did you mean …?" — picking a suggestion continues the existing claim-request flow.
  function acceptSuggestion(index) {
    const s = (state.suggestions || [])[Number(index)];
    if (!s || !s.name) return;
    state.name = s.name;
    state.found = { rounds: Number(s.rounds || 0) };
    state.suggestions = null;
    state.message = '';
    state.step = 'confirm-claim';
    render();
  }

  // "No, I'm new" — create the name the golfer actually typed, as today.
  async function createAnyway() {
    const name = normalizeName(state.typedName || state.name);
    if (!validName(name)) { state.message = FRIENDLY.invalid_name; return render(); }
    state.busy = true; state.message = ''; render();
    try { await createProfile(name); }
    catch (err) { state.message = friendly(err); }
    state.busy = false; render();
  }
  function back() { state.step = 'signin'; state.message = ''; render(); }

  async function signOut() {
    try {
      let mine = null;
      if (state.account && state.account.linked) {
        try { mine = await rpc('current_golfer_id'); } catch (_) {}
      }
      await client().auth.signOut();
      if (mine && root.localStorage.getItem('gmg_league_player_id') === String(mine)) root.localStorage.removeItem('gmg_league_player_id');
      const input = root.document && root.document.getElementById('reg-name');
      if (input) { input.readOnly = false; }
    } catch (_) { /* ignore */ }
    state.session = null; state.account = null; state.claim = null; state.step = 'signin'; state.message = '';
    render();
  }

  // ---- admin: pending requests, unlink / relink ------------------------------------------------------------
  async function loadAdminRows() {
    try {
      const [rows, pending] = await Promise.all([rpc('admin_list_profiles'), rpc('admin_list_claim_requests')]);
      state.adminRows = rows;
      state.pendingRequests = pending;
      state.message = '';
    } catch (err) {
      state.adminRows = null;
      state.pendingRequests = null;
      state.message = isMissingFunction(err) ? 'Profile tools are not installed yet.' : friendly(err);
    }
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
  async function adminApproveClaim(index) {
    const row = state.pendingRequests && state.pendingRequests[index]; if (!row) return;
    if (!root.confirm('Approve ' + row.name + ' for ' + (row.email || 'this sign-in') + '? This links their email to that league profile.')) return;
    try { await rpc('admin_approve_claim', { p_request_id: row.request_id }); await loadAdminRows(); }
    catch (err) { state.message = friendly(err); }
    render();
  }
  async function adminRejectClaim(index) {
    const row = state.pendingRequests && state.pendingRequests[index]; if (!row) return;
    if (!root.confirm('Reject the request to link ' + row.name + ' for ' + (row.email || 'this sign-in') + '?')) return;
    try { await rpc('admin_reject_claim', { p_request_id: row.request_id }); await loadAdminRows(); }
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
    } else if (state.step === 'pending-claim') {
      const nm = (state.claim && state.claim.name) || state.name;
      body = '<div class="dashboard-panel"><h3>Request sent, waiting for admin approval</h3><p>Your request to link the league profile <strong>' + esc(nm) + '</strong> has been sent. An admin will review it. Your history will be connected once it\u2019s approved.</p>' +
        '<button class="btn btn-back"' + dis + ' onclick="MGCAccounts.differentName()">Use a different name</button>' +
        '<button class="btn btn-back"' + dis + ' onclick="MGCAccounts.signOut()">Sign out</button></div>';
    } else if (state.step === 'suggest-name') {
      const suggestions = state.suggestions || [];
      const typed = state.typedName || state.name;
      const one = suggestions.length === 1 ? suggestions[0] : null;
      const heading = one ? ('Did you mean ' + esc(one.name) + '?') : 'Did you mean one of these?';
      const list = suggestions.map((s, i) =>
        '<div style="margin:10px 0;"><button class="btn btn-primary"' + dis + ' onclick="MGCAccounts.acceptSuggestion(' + i + ')">' +
        (one ? 'Yes, that\u2019s me' : ('Yes, I meant ' + esc(s.name))) + '</button>' +
        (s.rounds ? '<div><small>' + esc(s.rounds) + ' past round' + (s.rounds === 1 ? '' : 's') + '</small></div>' : '') +
        '</div>').join('');
      body = '<div class="dashboard-panel"><h3>' + heading + '</h3><p>A league profile already exists that looks like <strong>' + esc(typed) +
        '</strong>. If that\u2019s you, request it so your history stays together. An admin must approve the request before your email is linked.</p>' +
        list +
        '<button class="btn btn-back"' + dis + ' onclick="MGCAccounts.createAnyway()">No, I\u2019m new</button>' +
        '<button class="btn btn-back"' + dis + ' onclick="MGCAccounts.differentName()">Use a different name</button></div>';
    } else if (state.step === 'confirm-claim') {
      const r = state.found && state.found.rounds;
      body = '<div class="dashboard-panel"><h3>Is this you?</h3><p>We found a league profile named <strong>' + esc(state.name) + '</strong>' +
        (r ? ' with ' + esc(r) + ' past round' + (r === 1 ? '' : 's') : '') +
        '. Requesting it keeps your history. An admin must approve the request before your email is linked.</p>' +
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
    const pending = state.claim && state.claim.status === 'pending';
    const text = pending
      ? 'Your profile request is waiting for admin approval.'
      : (state.session ? 'Finish setting up your golfer profile.' : 'Sign in to create your permanent golfer profile.');
    const label = pending ? 'View status' : (state.session ? 'Continue' : 'Sign in');
    return '<div class="dashboard-panel" style="display:flex;gap:10px;align-items:center;justify-content:space-between;margin:10px 0;">' +
      '<span>' + esc(text) + '</span><button class="btn btn-primary" style="width:auto;margin:0;" onclick="MGCAccounts.open()">' + esc(label) + '</button></div>';
  }

  function adminHtml() {
    if (!state.available) return '<div class="award-empty">Profile tools are not installed yet.</div>';
    if (!(state.account && state.account.is_admin)) {
      return msgHtml() + '<div class="award-empty">Sign in with an admin account to manage golfer profiles.</div>';
    }
    if (!state.adminRows) return msgHtml() + '<div class="award-empty">Loading profiles...</div>';
    const pending = state.pendingRequests || [];
    const pendingBlock = '<div class="dashboard-panel" style="margin-bottom:12px;"><h3>Pending profile requests</h3>' +
      (pending.length
        ? pending.map((r, i) =>
          '<div class="avg-line" style="display:grid;grid-template-columns:1.2fr 1.6fr auto;gap:8px;align-items:center;">' +
          '<span><strong>' + esc(r.name) + '</strong><br><small>' + esc(r.rounds) + ' round' + (r.rounds === 1 ? '' : 's') + '</small></span>' +
          '<span>' + esc(r.email || 'Signed in') + '</span>' +
          '<span>' +
          '<button class="btn btn-primary" style="width:auto;margin:0 6px 0 0;" onclick="MGCAccounts.adminApproveClaim(' + i + ')">Approve</button>' +
          '<button class="btn btn-back" style="width:auto;margin:0;" onclick="MGCAccounts.adminRejectClaim(' + i + ')">Reject</button>' +
          '</span></div>').join('')
        : '<div class="award-empty">No pending profile requests.</div>') +
      '</div>';
    const rows = state.adminRows.map((r, i) =>
      '<div class="avg-line" style="display:grid;grid-template-columns:1.2fr 1.6fr auto;gap:8px;align-items:center;">' +
      '<span><strong>' + esc(r.name) + '</strong><br><small>' + esc(r.rounds) + ' round' + (r.rounds === 1 ? '' : 's') + (r.is_admin ? ' \u00b7 admin' : '') + '</small></span>' +
      '<span>' + (r.linked ? esc(r.email || 'Linked') : '<em>Not linked</em>') + '</span>' +
      '<span>' + (r.linked
        ? '<button class="btn btn-back" style="width:auto;margin:0;" onclick="MGCAccounts.adminUnlink(' + i + ')">Unlink</button>'
        : '<button class="btn btn-primary" style="width:auto;margin:0;" onclick="MGCAccounts.adminRelink(' + i + ')">Link to email</button>') + '</span></div>').join('');
    return msgHtml() + pendingBlock + '<div class="award-empty" style="margin-bottom:8px;">Unlinking never changes a golfer\u2019s profile or history. It only frees the profile to be claimed again.</div>' + rows;
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
    if (state.account && state.account.linked) state.step = 'done';
    else if (state.claim && state.claim.status === 'pending') state.step = 'pending-claim';
    else if (state.session && state.account && !state.account.linked) state.step = 'name';
    render();
    if (typeof root.showView === 'function') root.showView('view-account');
  }

  const api = {
    init, open, render, refreshAccount, sendLink, verifyCode, submitName, claimProfile, acceptSuggestion, createAnyway, differentName, back, signOut,
    renderAdminProfiles, adminUnlink, adminRelink, adminApproveClaim, adminRejectClaim,
    // exposed for tests / other modules
    state: () => state, accountName: () => (state.account && state.account.linked ? state.account.name : ''),
    isLinked: () => !!(state.account && state.account.linked), isAdmin: () => !!(state.account && state.account.is_admin),
    _html: { account: accountViewHtml, banner: bannerHtml, admin: adminHtml }, _util: { normalizeName, validName, validEmail, friendly, isMissingFunction, esc, consumeAuthRedirectError }
  };
  root.MGCAccounts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (root.addEventListener && root.document) {
    root.addEventListener('load', () => { init().catch(() => {}); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
