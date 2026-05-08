'use strict';

const puppeteer = require('puppeteer');
const path = require('path');
const { normalizeSite, resolveCreds, waitForAny, sleep, snap } = require('./util');

/**
 * Launch puppeteer with sane defaults.
 */
async function launch(opts = {}) {
  const headless = opts.headless ?? false; // visible by default per user preference
  const slowMo = Number(opts.slowMo ?? process.env.GANTRY_SLOWMO ?? 0);
  const userDataDir =
    opts.userDataDir ||
    process.env.GANTRY_USER_DATA_DIR ||
    path.resolve(process.cwd(), '.puppeteer-profile');

  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    slowMo,
    defaultViewport: null, // use real window size when headful
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--start-maximized',
    ],
  });
  return browser;
}

/**
 * Log in to /administrator if we aren't already.
 */
async function login(page, site, creds) {
  const base = normalizeSite(site);
  await page.goto(`${base}/administrator/`, { waitUntil: 'domcontentloaded' });

  // If we land on a dashboard page, we're already logged in.
  const isDashboard = await page.$('a[href*="task=logout"], a[href*="option=com_login&task=logout"], #header .header-title');
  if (isDashboard) {
    return;
  }

  // Joomla 4/5 login form selectors
  const userSel = await waitForAny(page, [
    'input[name="username"]',
    '#mod-login-username',
    '#username',
  ]);
  const passSel = await waitForAny(page, [
    'input[name="passwd"]',
    'input[name="password"]',
    '#mod-login-password',
    '#password',
  ]);

  await page.click(userSel, { clickCount: 3 });
  await page.type(userSel, creds.user, { delay: 15 });
  await page.click(passSel, { clickCount: 3 });
  await page.type(passSel, creds.pass, { delay: 15 });

  const submitSel = await waitForAny(page, [
    'button[type="submit"]',
    'button.btn-primary',
    'input[type="submit"]',
  ]);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    page.click(submitSel),
  ]);

  // Verify
  const ok = await page.$('a[href*="task=logout"], a[href*="option=com_login&task=logout"], #header .header-title');
  if (!ok) {
    await snap(page, 'login-failed');
    throw new Error('Login appears to have failed — check credentials. Screenshot saved in ./screenshots/');
  }
}

/**
 * Open the Gantry 5 Themes page and click "Configure" on the named theme so its
 * key/nonce is generated. This MUST happen before editing layouts/menus, otherwise
 * Gantry's AJAX endpoints reject requests.
 *
 * Accepts the theme name as either a display name ("studius", "Studius") or the
 * on-disk directory name ("rt_studius"). Returns the resolved directory name so
 * later URL builders use the right value.
 */
async function openThemeAndCaptureKey(page, site, themeName) {
  const base = normalizeSite(site);
  const requested = (themeName || process.env.GANTRY_THEME || 'studius').toLowerCase();

  await page.goto(`${base}/administrator/index.php?option=com_gantry5&view=themes`, {
    waitUntil: 'networkidle2',
  });

  // Joomla 5 / Gantry 5.6+ renders each theme as `.theme.card`. The title is
  // in `.theme-id`, with `.theme-info` showing "(v1.1.0 / rt_studius)". The
  // Configure link is `.theme-name a.button-primary` and its href already
  // contains theme=<dirname> plus an editor nonce.
  const result = await page.evaluate((name) => {
    const cards = Array.from(document.querySelectorAll('.theme.card, .theme-card, .theme'));
    for (const card of cards) {
      const txt = (card.textContent || '').toLowerCase();
      const matches =
        txt.includes(name) ||
        txt.includes('rt_' + name) ||
        txt.includes(name.replace(/^rt_/, ''));
      if (!matches) continue;

      const configure =
        card.querySelector('a.button-primary') ||
        card.querySelector('a.button.button-primary') ||
        Array.from(card.querySelectorAll('a, button')).find((b) =>
          /^\s*configure\s*$/i.test(b.textContent || '')
        );
      if (!configure) continue;

      configure.scrollIntoView({ block: 'center' });
      const href = configure.getAttribute('href') || '';
      configure.click();
      return { ok: true, href };
    }
    return { ok: false };
  }, requested);

  if (!result.ok) {
    await snap(page, 'theme-not-found');
    throw new Error(
      `Could not find the "${requested}" theme on the Gantry 5 Themes page. ` +
        'Screenshot saved in ./screenshots/. Confirm the theme is installed.'
    );
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await sleep(600);

  // Resolve the on-disk theme directory + the Joomla CSRF token from the post-
  // Configure URL. Gantry encodes the token as `&<32-hex>=1`. Carrying it on
  // every later URL avoids 404s on some SPA endpoints.
  const info = await page.evaluate(() => {
    const themeMatch = location.href.match(/[?&]theme=([^&#]+)/);
    const tokenMatch = location.href.match(/[?&]([a-f0-9]{32})=1/);
    return {
      theme: themeMatch ? decodeURIComponent(themeMatch[1]) : null,
      token: tokenMatch ? tokenMatch[1] : null,
    };
  });

  const theme = info.theme || (requested.startsWith('rt_') ? requested : 'rt_' + requested);
  const token = info.token; // may be null on older Gantry — callers should handle
  return { theme, token, base };
}

/**
 * Browser-mode start: launch Chromium, log in, click Configure, mint token.
 * Returns ctx with the same shape as the HTTP-mode ctx, plus { browser, page }.
 */
async function startBrowser({ site, headless, user, pass, themeName } = {}) {
  if (!site) throw new Error('site is required');
  const creds = resolveCreds(site, { user, pass });
  const browser = await launch({ headless });
  const [page] = await browser.pages();
  await login(page, site, creds);
  const info = await openThemeAndCaptureKey(page, site, themeName);

  /**
   * Unified fetch helper — proxies through page.evaluate so cookies work.
   * Returns { status, body, headers, finalUrl } for parity with the HTTP ctx.
   */
  async function ctxFetch(url, opts = {}) {
    const result = await page.evaluate(
      async (url, opts) => {
        const r = await fetch(url, {
          method: opts.method || 'GET',
          credentials: 'same-origin',
          headers: opts.headers || undefined,
          body: opts.body,
          redirect: 'follow',
        });
        return { status: r.status, body: await r.text(), finalUrl: r.url };
      },
      url,
      opts
    );
    return result;
  }

  return {
    mode: 'browser',
    browser,
    page,
    base: info.base,
    theme: info.theme,
    token: info.token,
    fetch: ctxFetch,
    async close() {
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Top-level dispatcher. mode = 'http' (default) | 'browser'.
 * The HTTP path has no Chromium dependency; the browser path adds rendered-DOM
 * features like dialog edits and traffic capture.
 */
async function start({ mode = 'http', site, headless, user, pass, themeName } = {}) {
  if (mode === 'browser') {
    return startBrowser({ site, headless, user, pass, themeName });
  }
  // Default: HTTP
  const { startHttp } = require('./session-http');
  return startHttp({ site, user, pass, themeName });
}

module.exports = { launch, login, openThemeAndCaptureKey, start, startBrowser };
