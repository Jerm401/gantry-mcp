'use strict';

/**
 * Lightweight HTTP client with a cookie jar, just enough to drive Joomla +
 * Gantry 5 admin endpoints without a browser. Uses Node's built-in fetch
 * (Node 18+).
 *
 * Why not tough-cookie / axios / etc.? We only need a tiny subset of cookie
 * behaviour: read Set-Cookie response headers, send Cookie request headers
 * scoped to the host. Manual implementation keeps the dep set minimal.
 */

const { URL } = require('url');

class CookieJar {
  constructor() {
    /** Map<host, Map<name, {value, path, expires?}>> */
    this.byHost = new Map();
  }

  /** Parse Set-Cookie headers from a response and store them. */
  ingestResponse(url, response) {
    const host = new URL(url).host;
    const bucket = this.byHost.get(host) || new Map();
    // Node's fetch headers expose Set-Cookie via getSetCookie() (Node 19.7+)
    const list =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
    // Fallback for older Node versions: split the joined header
    if (!list.length) {
      const raw = response.headers.get('set-cookie');
      if (raw) {
        // crude split — works for typical Joomla/Gantry cookies
        list.push(...raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/));
      }
    }
    for (const line of list) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // Recognise a few attributes; ignore the rest (we don't enforce expiry/secure)
      const meta = {};
      for (const a of attrs) {
        const [k, v] = a.split('=').map((s) => s.toLowerCase());
        if (k === 'path') meta.path = v;
        if (k === 'expires') meta.expires = v;
        if (k === 'max-age') meta.maxAge = v;
      }
      // Treat MaxAge=0 / Expires=epoch as deletion
      if (meta.maxAge === '0' || /1970/.test(meta.expires || '')) {
        bucket.delete(name);
      } else {
        bucket.set(name, { value, ...meta });
      }
    }
    this.byHost.set(host, bucket);
  }

  /** Build a Cookie header for the given URL. */
  cookieHeader(url) {
    const host = new URL(url).host;
    const bucket = this.byHost.get(host);
    if (!bucket || !bucket.size) return '';
    return [...bucket.entries()].map(([n, c]) => `${n}=${c.value}`).join('; ');
  }
}

/**
 * `fetch` wrapper that:
 *  - injects the Cookie header from the jar
 *  - reads Set-Cookie from the response and updates the jar
 *  - follows redirects manually so cookies set by the redirect are kept
 *  - exposes { status, body, headers, finalUrl } in the return
 */
async function jarFetch(url, options = {}, jar, opts = {}) {
  const { maxRedirects = 5 } = opts;
  let currentUrl = url;
  let currentOptions = { ...options, redirect: 'manual' };
  let response;

  for (let i = 0; i <= maxRedirects; i++) {
    const cookieHeader = jar.cookieHeader(currentUrl);
    const headers = new Headers(currentOptions.headers || {});
    if (cookieHeader) headers.set('cookie', cookieHeader);
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'gantry-cli/1.0 (Joomla Gantry5 automation)');
    }

    response = await fetch(currentUrl, { ...currentOptions, headers });
    jar.ingestResponse(currentUrl, response);

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, currentUrl).toString();
      // Drain the body to release the connection
      await response.arrayBuffer().catch(() => {});
      currentUrl = next;
      // After a redirect, switch to GET unless 307/308
      if (response.status !== 307 && response.status !== 308) {
        currentOptions = { ...currentOptions, method: 'GET', body: undefined };
      }
      continue;
    }
    break;
  }

  const body = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body,
    finalUrl: currentUrl,
  };
}

/**
 * Parse the FIRST <form> matching `formSelector` (just a string to look for in
 * the form tag, e.g. 'task=login' or 'class="form-validate"') and return:
 *   { action, method, fields: { name -> value } }
 *
 * Hidden inputs are included; password fields get an empty value.
 */
function parseForm(html, formMatcher) {
  // Find an opening <form ... > tag matching the matcher, then capture up to </form>
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let match;
  while ((match = formRe.exec(html))) {
    const tag = html.slice(match.index, match.index + match[0].indexOf('>') + 1);
    if (typeof formMatcher === 'function' ? !formMatcher(tag) : !tag.includes(formMatcher)) {
      continue;
    }
    const action = (tag.match(/\baction="([^"]*)"/) || [, ''])[1];
    const method = (tag.match(/\bmethod="([^"]*)"/) || [, 'POST'])[1].toUpperCase();
    const inner = match[1];
    const fields = {};
    const inputRe = /<input\b[^>]*>/gi;
    let inp;
    while ((inp = inputRe.exec(inner))) {
      const t = inp[0];
      const name = (t.match(/\bname="([^"]*)"/) || [])[1];
      if (!name) continue;
      const value = (t.match(/\bvalue="([^"]*)"/) || [])[1] || '';
      fields[name] = value;
    }
    return { action, method, fields };
  }
  return null;
}

/** URL-encode a flat object of {key:value} as application/x-www-form-urlencoded. */
function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`)
    .join('&');
}

module.exports = { CookieJar, jarFetch, parseForm, formEncode };
