'use strict';

/**
 * Pure-HTTP login + Configure-click flow. No Puppeteer required.
 *
 * Returns a `ctx` compatible with the rest of the codebase:
 *   { mode: 'http', base, theme, token, jar, fetch(url, opts), close() }
 *
 * `ctx.fetch` is a wrapper around jarFetch that auto-injects cookies and
 * returns { status, body, headers, finalUrl }.
 */

const { CookieJar, jarFetch, parseForm, formEncode } = require('./http');
const { normalizeSite, resolveCreds } = require('./util');

/**
 * Step 1: GET the admin login page and parse the login form.
 * Joomla's login page lives at /administrator/ when not authenticated.
 */
async function fetchLoginForm(base, jar) {
  const url = `${base}/administrator/`;
  const res = await jarFetch(url, { method: 'GET' }, jar);
  if (res.status >= 400) {
    throw new Error(`Could not load login page (${res.status})`);
  }
  // The Joomla 4/5 login form has fields: username, passwd, plus hidden
  // inputs including the random CSRF token (32-hex name with value=1).
  const form = parseForm(res.body, (tag) => /class="[^"]*form-(validate|login)/.test(tag) || /id="form-login"/.test(tag));
  if (!form) {
    // Fallback: any form containing input named "username"
    const fallback = parseForm(res.body, (tag) => true);
    if (!fallback) throw new Error('No login form found on /administrator/');
    return { form: fallback, finalUrl: res.finalUrl };
  }
  return { form, finalUrl: res.finalUrl };
}

/**
 * Step 2: POST credentials and verify login.
 */
async function postLogin(base, form, creds, jar, finalUrl) {
  const action = form.action || '/administrator/index.php';
  const url = new URL(action, finalUrl).toString();

  // Merge submitted creds with the form's hidden inputs (CSRF token, task, etc.)
  const payload = {
    ...form.fields,
    username: creds.user,
    // Joomla sometimes uses 'passwd' (Joomla 4) or 'password' (Joomla 5)
    passwd: creds.pass,
    password: creds.pass,
  };

  const res = await jarFetch(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formEncode(payload),
    },
    jar
  );

  if (res.status >= 400) {
    throw new Error(`Login POST returned ${res.status}`);
  }
  // After redirects, we should be on the dashboard. Check for the admin chrome.
  const ok =
    /option=com_login&amp;task=logout|task=logout|user-menu|administrator-logo|com_cpanel/i.test(
      res.body
    );
  if (!ok) {
    throw new Error('Login appears to have failed (no logout link in response)');
  }
  return res;
}

/**
 * Step 3: GET the themes page and find the Configure URL for the chosen theme.
 * The Configure button's href looks like:
 *   /administrator/index.php?option=com_gantry5&view=configurations/default/layout&theme=rt_studius&<TOKEN>=1
 *
 * Returns { configureUrl, theme, token }.
 */
async function findConfigureUrl(base, themeName, jar) {
  const themesUrl = `${base}/administrator/index.php?option=com_gantry5&view=themes`;
  const res = await jarFetch(themesUrl, { method: 'GET' }, jar);
  if (res.status >= 400) {
    throw new Error(`Could not load Gantry themes page (${res.status})`);
  }
  const requested = (themeName || 'studius').toLowerCase();

  // Find the .theme.card whose text mentions the requested theme
  // (matches "studius", "rt_studius", "Studius", etc.)
  const cardRe = /<div\b[^>]*class="[^"]*\btheme\b[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi;
  let match;
  while ((match = cardRe.exec(res.body))) {
    const card = match[0];
    const lower = card.toLowerCase();
    if (
      !lower.includes(requested) &&
      !lower.includes('rt_' + requested) &&
      !lower.includes(requested.replace(/^rt_/, ''))
    ) {
      continue;
    }
    // Configure URL is the href on the .button-primary <a>
    const aMatch = card.match(/<a[^>]*\bclass="[^"]*\bbutton-primary\b[^"]*"[^>]*\bhref="([^"]+)"/);
    if (!aMatch) continue;
    const href = aMatch[1].replace(/&amp;/g, '&');
    const configureUrl = href.startsWith('http') ? href : `${base}${href}`;
    const theme = (configureUrl.match(/[?&]theme=([^&#]+)/) || [])[1] || 'rt_' + requested;
    const token = (configureUrl.match(/[?&]([a-f0-9]{32})=1/) || [])[1] || null;
    return { configureUrl, theme, token };
  }
  throw new Error(`Could not find the "${requested}" theme on the Gantry themes page.`);
}

/**
 * Top-level: log in via HTTP, click Configure, return a fully-formed ctx.
 */
async function startHttp({ site, user, pass, themeName } = {}) {
  if (!site) throw new Error('site is required');
  const base = normalizeSite(site);
  const creds = resolveCreds(site, { user, pass });
  const jar = new CookieJar();

  // 1. GET login form, POST creds
  const { form, finalUrl } = await fetchLoginForm(base, jar);
  await postLogin(base, form, creds, jar, finalUrl);

  // 2. Find Configure URL for the theme
  const { configureUrl, theme, token } = await findConfigureUrl(base, themeName, jar);

  // 3. GET the Configure URL — this is what the UI does to mint editor state
  await jarFetch(configureUrl, { method: 'GET' }, jar);

  /** Convenience: ctx.fetch hides the cookie jar from callers. */
  async function ctxFetch(url, opts = {}) {
    return jarFetch(url, opts, jar);
  }

  return {
    mode: 'http',
    base,
    theme,
    token,
    jar,
    fetch: ctxFetch,
    async close() {
      // No-op for HTTP — kept for parity with the browser ctx interface
    },
  };
}

module.exports = { startHttp, fetchLoginForm, postLogin, findConfigureUrl };
