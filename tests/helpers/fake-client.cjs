'use strict';
// A fake supabase-js client for the browser code: rpc() runs against PGlite as the signed-in user (so real
// permissions apply), and auth.* records calls and simulates the email link / code.
const pg = require('./pg.cjs');

function makeBrowser(db, { origin = 'https://golf-money-game-live.netlify.app', pathname = '/' } = {}) {
  const store = new Map();
  const els = {};
  const el = id => (els[id] ||= { id, innerHTML: '', style: {}, value: '', readOnly: false });
  for (const id of ['account-content', 'account-banner', 'admin-profiles-content', 'quick-nav-account', 'admin-profiles-tab', 'reg-name']) el(id);
  const calls = { otp: [], verify: [], signOut: 0, shown: [] };
  let session = null, listener = null;
  const users = new Map();   // email -> user (the "auth server")

  const sessionFor = u => ({ access_token: 't-' + u.id, user: { id: u.id, email: u.email } });
  async function ensureUser(email) {
    let u = users.get(email.toLowerCase());
    if (!u) { u = await pg.newUser(db, email.toLowerCase()); users.set(email.toLowerCase(), u); }
    return u;
  }
  const argSql = args => Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ');

  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: cb => { listener = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithOtp: async opts => { calls.otp.push(opts); return { error: opts.email.includes('ratelimit') ? { message: 'email rate limit exceeded' } : null }; },
      verifyOtp: async opts => {
        calls.verify.push(opts);
        if (opts.token !== '123456') return { data: {}, error: { message: 'Token has expired or is invalid' } };
        const u = await ensureUser(opts.email); session = sessionFor(u);
        return { data: { session }, error: null };
      },
      signOut: async () => { calls.signOut++; session = null; if (listener) listener('SIGNED_OUT', null); return { error: null }; }
    },
    rpc: async (name, args = {}) => {
      if (!session) return { data: null, error: { message: 'permission denied for function ' + name, code: '42501' } };
      try {
        const who = { id: session.user.id, email: session.user.email };
        const rows = await pg.run(db, who, `select public.${name}(${argSql(args)}) as r`, Object.values(args));
        return { data: rows[0].r, error: null };
      } catch (e) {
        const missing = /does not exist/.test(e.message);
        return { data: null, error: { message: missing ? 'Could not find the function public.' + name + ' in the schema cache' : e.message, code: missing ? 'PGRST202' : 'P0001' } };
      }
    }
  };

  // simulate clicking the emailed magic link in this browser
  async function clickMagicLink(email) {
    const u = await ensureUser(email); session = sessionFor(u);
    if (listener) listener('SIGNED_IN', session);
    await new Promise(r => setTimeout(r, 20));
  }
  async function loginAs(email) { const u = await ensureUser(email); session = sessionFor(u); return u; }

  const win = {
    supabaseClient: client,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    document: { getElementById: id => els[id] || null },
    location: { origin, pathname },
    showView: v => calls.shown.push(v),
    confirm: () => true, prompt: () => win._promptValue,
    setTimeout, console
  };
  return { win, client, els, store, calls, clickMagicLink, loginAs, ensureUser };
}

// Load the REAL netlify/mgc-accounts.js into a fresh sandbox bound to this fake browser.
function loadAccounts(browser) {
  const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
  const ctx = vm.createContext({ ...browser.win });
  ctx.window = ctx; // the module checks `window`
  ctx.addEventListener = undefined;   // do not auto-start; tests call init() themselves
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../netlify/mgc-accounts.js'), 'utf8'), ctx, { filename: 'mgc-accounts.js' });
  return ctx.MGCAccounts;
}

module.exports = { makeBrowser, loadAccounts };
