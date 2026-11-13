const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');

function load(hostname = 'abc123--golf-money-game-live.netlify.app') {
  const inits = [];
  const context = vm.createContext({
    URL, URLSearchParams,
    Sentry: { init(options) { inits.push(options); } },
    location: { hostname, href: 'https://' + hostname + '/' },
    window: null
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../netlify/mgc-sentry.js'), 'utf8'), context);
  return { context, inits, run: source => vm.runInContext(source, context) };
}

test('Sentry init is present with PII off, no replay, and no tracing sample', () => {
  const { inits } = load();
  assert.equal(inits.length, 1);
  const options = inits[0];
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.release, 'money-game-central@2.7.6');
  assert.equal(options.environment, 'test');
  assert.equal(options.replaysSessionSampleRate, undefined);
  assert.ok(options.dsn && options.dsn.startsWith('https://'));
});

test('Netlify draft previews use the test environment; the live host is production', () => {
  const { run } = load('golf-money-game-live.netlify.app');
  assert.equal(run("mgcSentryEnvironment('6af5c0d1--golf-money-game-live.netlify.app')"), 'test');
  assert.equal(run("mgcSentryEnvironment('localhost')"), 'test');
  assert.equal(run("mgcSentryEnvironment('golf-money-game-live.netlify.app')"), 'production');
});

test('beforeSend strips tokens and never keeps request bodies or password values', () => {
  const { run } = load();
  const cleaned = run(`JSON.stringify(mgcScrubSentryEvent({request:{url:'https://golf-money-game-live.netlify.app/#access_token=SECRET',query_string:'password=noshouldsee',data:{password:'noshouldsee','admin-password':'noshouldsee'},cookies:'admin-password=noshouldsee'}}))`);
  assert.ok(!cleaned.includes('SECRET'));
  assert.ok(!cleaned.includes('noshouldsee'));
  const event = JSON.parse(cleaned);
  assert.ok(!event.request.url.includes('access_token='));
  assert.equal(event.request.data, '[filtered]');
  assert.equal(event.request.cookies, '[filtered]');
});

test('breadcrumbs drop the admin password field and strip input values', () => {
  const { run } = load();
  assert.equal(run("mgcScrubSentryBreadcrumb({category:'ui.input',data:{id:'admin-password',value:'super-secret'}})"), null);
  const kept = JSON.parse(run("JSON.stringify(mgcScrubSentryBreadcrumb({category:'ui.input',data:{id:'player-name',value:'Gabe'}}))"));
  assert.ok(!Object.prototype.hasOwnProperty.call(kept.data, 'value'));
  assert.ok(!JSON.stringify(kept).includes('Gabe'));
});
