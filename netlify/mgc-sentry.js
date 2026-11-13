// Sentry error monitoring for Money Game Central. DSN is a public client key.
// This file is init and scrubbing only — it does not change scoring.
const MGC_SENTRY_DSN = 'https://12415e401610f40b9400fab338fb8760@o4512424565211136.ingest.us.sentry.io/4512424583626752';
const MGC_SENTRY_RELEASE = 'money-game-central@2.7.6';
const SENTRY_SENSITIVE = /access_token|refresh_token|id_token|client_secret|authorization|password|passwd|secret|api[_-]?key|service_role/i;
const SENTRY_SENSITIVE_PARAM = /^(access_token|refresh_token|id_token|token|code|password|passwd|secret|client_secret|api[_-]?key)$/i;

function mgcSentryEnvironment(hostname) {
  const host = String(hostname || (typeof location !== 'undefined' ? location.hostname : '') || '');
  if (!host || host === 'localhost' || host === '127.0.0.1' || host.includes('--')) return 'test';
  return 'production';
}

function mgcScrubUrl(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    const url = new URL(value, 'https://example.invalid');
    if (SENTRY_SENSITIVE.test(url.hash)) url.hash = '';
    [...url.searchParams.keys()].forEach(key => {
      const param = url.searchParams.get(key) || '';
      if (SENTRY_SENSITIVE_PARAM.test(key) || SENTRY_SENSITIVE.test(key) || SENTRY_SENSITIVE.test(param)) url.searchParams.delete(key);
    });
    return url.toString();
  } catch {
    return value.replace(/[?#&]?(?:access_token|refresh_token|id_token|password|code)=[^&#"'\s]*/gi, '');
  }
}

function mgcScrubSentryEvent(event) {
  if (!event) return event;
  if (event.request) {
    if (event.request.url) event.request.url = mgcScrubUrl(event.request.url);
    if (typeof event.request.query_string === 'string' && SENTRY_SENSITIVE.test(event.request.query_string)) {
      event.request.query_string = '[filtered]';
    }
    if (event.request.headers) {
      Object.keys(event.request.headers).forEach(key => {
        if (SENTRY_SENSITIVE.test(key)) event.request.headers[key] = '[filtered]';
      });
    }
    // Never send form bodies or cookies — admin password and other inputs must not leave the browser.
    if (event.request.data != null) event.request.data = '[filtered]';
    if (event.request.cookies != null) event.request.cookies = '[filtered]';
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(mgcScrubSentryBreadcrumb).filter(Boolean);
  }
  return event;
}

function mgcScrubSentryBreadcrumb(breadcrumb) {
  if (!breadcrumb) return breadcrumb;
  if (breadcrumb.data && Object.prototype.hasOwnProperty.call(breadcrumb.data, 'value')) delete breadcrumb.data.value;
  if (breadcrumb.data) {
    ['url', 'to', 'from', 'input'].forEach(key => {
      if (typeof breadcrumb.data[key] === 'string') breadcrumb.data[key] = mgcScrubUrl(breadcrumb.data[key]);
    });
  }
  if (typeof breadcrumb.message === 'string' && /https?:|#access_token|access_token=/i.test(breadcrumb.message)) {
    breadcrumb.message = mgcScrubUrl(breadcrumb.message);
  }
  const field = `${breadcrumb.data?.id || ''} ${breadcrumb.data?.name || ''} ${breadcrumb.message || ''}`;
  if (/password|passwd|admin-password/i.test(field)) return null;
  return breadcrumb;
}

function mgcSentryOptions() {
  return {
    dsn: MGC_SENTRY_DSN,
    environment: mgcSentryEnvironment(),
    release: MGC_SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: mgcScrubSentryEvent,
    beforeBreadcrumb: mgcScrubSentryBreadcrumb
  };
}

function initMgcSentry() {
  if (typeof Sentry === 'undefined' || typeof Sentry.init !== 'function') return false;
  const options = mgcSentryOptions();
  Sentry.init(options);
  return options;
}

function mgcTriggerSentryTestError() {
  const error = new Error('Money Game Central Sentry test event — safe to resolve');
  if (typeof Sentry !== 'undefined' && typeof Sentry.captureException === 'function') Sentry.captureException(error);
  else throw error;
  return error.message;
}

initMgcSentry();
