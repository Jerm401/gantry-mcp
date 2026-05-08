'use strict';

const { sleep, snap, gantryUrl } = require('./util');

/**
 * Page Settings — works in both browser mode (dialog flow) and HTTP mode
 * (parse the form, POST the merged state).
 *
 * Captured save endpoint:
 *   POST  view=configurations/<outline>/page&format=json
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: every `page[*]` field as form-encoded key=value
 */

/* ------------------- shared helpers ------------------- */

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Parse every page[*] form field out of the page settings HTML.
 * Handles input (incl. checkbox/radio), select (with selected option), textarea.
 */
function parsePageFormFields(html) {
  const fields = [];

  // <input ...>
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname="(page\[[^"]*)"/) || [])[1];
    if (!name) continue;
    const type = ((tag.match(/\btype="([^"]*)"/) || [, 'text'])[1] || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if (!/\bchecked\b/.test(tag)) continue;
    }
    let value = (tag.match(/\bvalue="([^"]*)"/) || [])[1] || '';
    fields.push({ name, type, value: decodeHtmlEntities(value) });
  }

  // <textarea ...>content</textarea>
  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname="(page\[[^"]*)"/) || [])[1];
    if (!name) continue;
    fields.push({ name, type: 'textarea', value: decodeHtmlEntities(m[2]) });
  }

  // <select ...><option ... selected ...></select>
  const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname="(page\[[^"]*)"/) || [])[1];
    if (!name) continue;
    const inner = m[2];
    const selOpt = inner.match(/<option\b[^>]*\bselected\b[^>]*>/i);
    let value = '';
    if (selOpt) {
      value = (selOpt[0].match(/\bvalue="([^"]*)"/) || [])[1] || '';
    }
    fields.push({ name, type: 'select-one', value: decodeHtmlEntities(value) });
  }

  return fields;
}

/** Build URL for the page settings GET (HTML) or save (with format=json). */
function pageUrl(ctx, outline, asJson = false) {
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/page')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '');
  return asJson ? url + '&format=json' : url;
}

/* ------------------- ctx-aware operations ------------------- */

/**
 * Detect mode/page from a (legacy) page-first or (new) ctx-first first arg.
 * Returns { ctx, page }; page may be null in HTTP mode.
 */
function _norm(arg1, arg2) {
  if (arg1 && typeof arg1.evaluate === 'function') {
    return { page: arg1, ctx: arg2 };
  }
  if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    return { page: arg1.page, ctx: arg1 };
  }
  // (undefined-page, ctx) — common in HTTP-mode CLI calls
  return { page: arg1 || null, ctx: arg2 };
}

/**
 * Open the page settings view. In browser mode this navigates Chromium; in
 * HTTP mode it fetches and caches the form HTML on ctx for later use by
 * listPage / savePage.
 */
async function openPage(arg1, arg2, outline = 'default') {
  const { page, ctx } = _norm(arg1, arg2);
  if (page && ctx?.mode !== 'http') {
    await page.goto(gantryUrl(ctx, `configurations/${outline}/page`), {
      waitUntil: 'networkidle2',
    });
    await page.waitForSelector('input[name^="page["], [data-save="Page Settings"]', {
      timeout: 20000,
    });
    await sleep(400);
    return;
  }
  // HTTP mode
  if (!ctx) throw new Error('openPage: no ctx');
  const res = await ctx.fetch(pageUrl(ctx, outline), { method: 'GET' });
  if (res.status >= 400) {
    throw new Error(`Page Settings GET ${res.status}: ${res.body.slice(0, 200)}`);
  }
  ctx._pageHtml = res.body;
  ctx._pageOutline = outline;
  ctx._pageEdits = ctx._pageEdits || {};
}

/**
 * Return every Page Settings field as { name, value, type }.
 * In HTTP mode parses the cached HTML; in browser mode reads the live DOM.
 */
async function listPage(arg1, optsOrArg2) {
  const { page, ctx } = _norm(arg1, optsOrArg2 && (optsOrArg2.mode || optsOrArg2.fetch) ? optsOrArg2 : null);
  // optsOrArg2 may be the opts bag in legacy form
  const opts =
    optsOrArg2 && !(optsOrArg2.mode || optsOrArg2.fetch) ? optsOrArg2 : (arguments[2] || {});
  const all = !!opts.all;

  if (page && ctx?.mode !== 'http') {
    const fields = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll(
          'input[name^="page["], select[name^="page["], textarea[name^="page["]'
        )
      ).map((el) => ({
        name: el.getAttribute('name'),
        value: el.value || '',
        type: el.type || el.tagName.toLowerCase(),
      }));
    });
    return fields.filter((f) => all || !f.name.endsWith('[_json]'));
  }
  // HTTP mode
  if (!ctx?._pageHtml) {
    throw new Error('listPage(ctx): call openPage first');
  }
  return parsePageFormFields(ctx._pageHtml).filter((f) => all || !f.name.endsWith('[_json]'));
}

/**
 * Apply edits. In browser mode this types into form fields immediately; in
 * HTTP mode it accumulates edits on ctx, to be flushed by savePage.
 */
async function editPage(arg1, edits = {}) {
  const { page, ctx } = _norm(arg1, null);
  if (page && ctx?.mode !== 'http') {
    return _editPageInBrowser(page, edits);
  }
  // HTTP mode — defer to savePage
  if (!ctx) throw new Error('editPage: no ctx');
  ctx._pageEdits = { ...(ctx._pageEdits || {}), ...edits };
}

async function _editPageInBrowser(page, edits) {
  for (const [name, value] of Object.entries(edits)) {
    const sel = `[name="${name}"]`;
    const field = await page.$(sel);
    if (!field) {
      console.warn(`  [editPage] field "${name}" not found — skipping`);
      continue;
    }
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return;
      let p = el.parentElement;
      while (p) {
        if (p.classList && p.classList.contains('g-collapse')) p.classList.remove('g-collapse');
        p = p.parentElement;
      }
    }, sel);
    const tag = await (await field.getProperty('tagName')).jsonValue();
    const type = await page.evaluate((el) => el.type || '', field);
    if (type === 'checkbox' || type === 'radio') {
      const checked = await page.evaluate((el) => el.checked, field);
      if (Boolean(value) !== checked) await field.click();
    } else if (tag === 'SELECT') {
      await page.select(sel, String(value));
    } else if (tag === 'TEXTAREA') {
      await page.evaluate(
        (s, v) => {
          const el = document.querySelector(s);
          if (!el) return;
          el.focus();
          el.value = String(v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        sel,
        value
      );
    } else {
      await field.click({ clickCount: 3 });
      await field.type(String(value), { delay: 10 });
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, sel);
    }
  }
}

/**
 * Save Page Settings. In browser mode clicks the Save button; in HTTP mode
 * fetches the current form, merges accumulated edits, POSTs the result.
 */
async function savePage(arg1) {
  const { page, ctx } = _norm(arg1, null);
  if (page && ctx?.mode !== 'http') {
    const btn = await page.$('[data-save="Page Settings"]');
    if (!btn) {
      await snap(page, 'page-save-missing');
      throw new Error('Save Page Settings button not found.');
    }
    await btn.click();
    await page.waitForSelector('.g-notify, .alert-success', { timeout: 8000 }).catch(() => {});
    await sleep(800);
    return;
  }
  // HTTP mode
  if (!ctx) throw new Error('savePage: no ctx');
  const outline = ctx._pageOutline;
  const edits = ctx._pageEdits || {};
  const html = ctx._pageHtml || (await ctx.fetch(pageUrl(ctx, outline), { method: 'GET' })).body;
  const current = parsePageFormFields(html);

  // Build a flat name→value map of every field on the form, then override
  const map = {};
  for (const f of current) {
    map[f.name] = f.value;
  }
  Object.assign(map, edits);

  // Form-encode in a stable order — start with existing field order (matches what Gantry's UI sends),
  // then append any keys present only in edits (rare).
  const seen = new Set();
  const parts = [];
  for (const f of current) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    parts.push(`${encodeURIComponent(f.name)}=${encodeURIComponent(map[f.name] ?? '')}`);
  }
  for (const k of Object.keys(edits)) {
    if (!seen.has(k)) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(edits[k] ?? '')}`);
    }
  }
  const body = parts.join('&');

  const res = await ctx.fetch(pageUrl(ctx, outline, true), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  });
  if (res.status >= 400) {
    throw new Error(`Save Page Settings ${res.status}: ${res.body.slice(0, 300)}`);
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  if (parsed && parsed.success === false) {
    throw new Error(`Save reported failure: ${parsed.message || res.body.slice(0, 300)}`);
  }
  // Clear staged edits after a successful save
  ctx._pageEdits = {};
  return parsed || res;
}

module.exports = { openPage, listPage, editPage, savePage, parsePageFormFields };
