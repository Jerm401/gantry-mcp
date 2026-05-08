'use strict';

const { sleep, snap, gantryUrl } = require('./util');

/**
 * Theme Styles — works in both browser mode (dialog flow) and HTTP mode
 * (parse the form, POST the merged state).
 *
 * Save endpoint: POST view=configurations/<outline>/styles&format=json
 * Body: every styles[*] field as form-encoded key=value, same as page settings.
 *
 * Real selectors:
 *   - inputs are `input[name="styles[<group>][<key>]"]`
 *   - save is `[data-save="Styles"]`
 *   - color pickers: `.g-colorpicker` (text inputs storing hex codes)
 *   - font pickers: `[data-g5-fontpicker]` (button that opens a dialog)
 *   - file pickers: `[data-g5-filepicker]` (button that opens a dialog)
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

/** Parse every styles[*] form field out of the styles page HTML. */
function parseStylesFormFields(html) {
  const fields = [];

  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname="(styles\[[^"]*)"/) || [])[1];
    if (!name) continue;
    const type = ((tag.match(/\btype="([^"]*)"/) || [, 'text'])[1] || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if (!/\bchecked\b/.test(tag)) continue;
    }
    const value = (tag.match(/\bvalue="([^"]*)"/) || [])[1] || '';
    fields.push({ name, type, value: decodeHtmlEntities(value) });
  }

  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname="(styles\[[^"]*)"/) || [])[1];
    if (!name) continue;
    fields.push({ name, type: 'textarea', value: decodeHtmlEntities(m[2]) });
  }

  const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selRe.exec(html))) {
    const tag = m[1];
    const name = (tag.match(/\bname="(styles\[[^"]*)"/) || [])[1];
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

function stylesUrl(ctx, outline, asJson = false) {
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/styles')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '');
  return asJson ? url + '&format=json' : url;
}

function _norm(arg1, arg2) {
  if (arg1 && typeof arg1.evaluate === 'function') {
    return { page: arg1, ctx: arg2 };
  }
  if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    return { page: arg1.page, ctx: arg1 };
  }
  return { page: arg1 || null, ctx: arg2 };
}

/* ------------------- ctx-aware operations ------------------- */

async function openStyles(arg1, arg2, outline = 'default') {
  const { page, ctx } = _norm(arg1, arg2);
  if (page && ctx?.mode !== 'http') {
    await page.goto(gantryUrl(ctx, `configurations/${outline}/styles`), {
      waitUntil: 'networkidle2',
    });
    await page.waitForSelector('input[name^="styles["], [data-save="Styles"]', {
      timeout: 20000,
    });
    await sleep(500);
    return;
  }
  if (!ctx) throw new Error('openStyles: no ctx');
  const res = await ctx.fetch(stylesUrl(ctx, outline), { method: 'GET' });
  if (res.status >= 400) {
    throw new Error(`Styles GET ${res.status}: ${res.body.slice(0, 200)}`);
  }
  ctx._stylesHtml = res.body;
  ctx._stylesOutline = outline;
  ctx._stylesEdits = ctx._stylesEdits || {};
}

async function listStyles(arg1, arg2) {
  const { page, ctx } = _norm(arg1, arg2 && (arg2.mode || arg2.fetch) ? arg2 : null);
  if (page && ctx?.mode !== 'http') {
    return page.evaluate(() => {
      return Array.from(
        document.querySelectorAll(
          'input[name^="styles["], select[name^="styles["], textarea[name^="styles["]'
        )
      ).map((el) => ({
        name: el.getAttribute('name'),
        value: el.value || '',
        type: el.type || el.tagName.toLowerCase(),
      }));
    });
  }
  // HTTP mode
  if (!ctx?._stylesHtml) {
    throw new Error('listStyles(ctx): call openStyles first');
  }
  return parseStylesFormFields(ctx._stylesHtml);
}

async function editStyles(arg1, edits = {}) {
  const { page, ctx } = _norm(arg1, null);
  if (page && ctx?.mode !== 'http') {
    return _editStylesInBrowser(page, edits);
  }
  if (!ctx) throw new Error('editStyles: no ctx');
  ctx._stylesEdits = { ...(ctx._stylesEdits || {}), ...edits };
}

async function _editStylesInBrowser(page, edits) {
  for (const [name, value] of Object.entries(edits)) {
    const sel = `[name="${name}"]`;
    const field = await page.$(sel);
    if (!field) {
      console.warn(`  [editStyles] field "${name}" not found`);
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

async function saveStyles(arg1) {
  const { page, ctx } = _norm(arg1, null);
  if (page && ctx?.mode !== 'http') {
    const btn = await page.$('[data-save="Styles"]');
    if (!btn) {
      await snap(page, 'styles-save-missing');
      throw new Error('Save Styles button not found.');
    }
    await btn.click();
    await page.waitForSelector('.g-notify, .alert-success', { timeout: 8000 }).catch(() => {});
    await sleep(800);
    return;
  }
  if (!ctx) throw new Error('saveStyles: no ctx');
  const outline = ctx._stylesOutline;
  const edits = ctx._stylesEdits || {};
  const html = ctx._stylesHtml || (await ctx.fetch(stylesUrl(ctx, outline), { method: 'GET' })).body;
  const current = parseStylesFormFields(html);

  const map = {};
  for (const f of current) map[f.name] = f.value;
  Object.assign(map, edits);

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

  const res = await ctx.fetch(stylesUrl(ctx, outline, true), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  });
  if (res.status >= 400) {
    throw new Error(`Save Styles ${res.status}: ${res.body.slice(0, 300)}`);
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  if (parsed && parsed.success === false) {
    throw new Error(`Save reported failure: ${parsed.message || res.body.slice(0, 300)}`);
  }
  ctx._stylesEdits = {};
  return parsed || res;
}

module.exports = { openStyles, listStyles, editStyles, saveStyles, parseStylesFormFields };
