'use strict';

const { sleep, gantryUrl } = require('./util');

/**
 * Open the Outlines list (URL: view=configurations).
 * Browser mode: navigates the page. HTTP mode: caches the page HTML on ctx
 * for listOutlines/deleteOutline to parse.
 *
 * Accepts either (page, ctx) [legacy browser] or (ctx) [HTTP / new].
 */
async function openOutlines(arg1, arg2) {
  let page, ctx;
  if (arg1 && typeof arg1.evaluate === 'function') {
    // (page, ctx)
    page = arg1;
    ctx = arg2;
  } else if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    // (ctx)
    ctx = arg1;
    page = ctx?.page;
  } else {
    // (undefined-page, ctx) — HTTP mode legacy callers
    ctx = arg2;
    page = ctx?.page;
  }
  const url = gantryUrl(ctx, 'configurations');
  if (page && ctx?.mode !== 'http') {
    await page.goto(url, { waitUntil: 'networkidle2' });
    await page.waitForSelector('div[id^="outline-"], [data-g5-outline-create]', {
      timeout: 20000,
    });
    await sleep(400);
    return;
  }
  // HTTP mode: fetch and stash the HTML
  const res = await ctx.fetch(url, { method: 'GET' });
  if (res.status >= 400) {
    throw new Error(`Outlines page returned ${res.status}`);
  }
  ctx._outlinesHtml = res.body;
}

/**
 * Parse outline cards out of the configurations-page HTML.
 * Used in HTTP mode and as a helper from the browser-mode evaluate.
 */
function parseOutlinesFromHtml(html) {
  const out = [];
  // Match each outline card by its `<div id="outline-...">` opener
  const cardRe =
    /<li[^>]*\bclass="[^"]*\bcard\b[^"]*"[^>]*>[\s\S]*?<div\s+id="outline-([^"]+)"[\s\S]*?<\/li>/g;
  let m;
  while ((m = cardRe.exec(html))) {
    const id = m[1];
    const card = m[0];
    // Title — prefer the editable .title span, fall back to first h4 span
    let title = '';
    const titleMatch =
      card.match(/<span[^>]*data-title-editable[^>]*>([^<]+)<\/span>/) ||
      card.match(/<h4>[\s\S]*?<span[^>]*>([^<]+)<\/span>/);
    if (titleMatch) title = titleMatch[1].replace(/&amp;/g, '&').trim();
    const isDefault = /outline-is-default/.test(card) || id === 'default';
    const layoutHref =
      ((card.match(/<a[^>]*\bclass="[^"]*\bbutton-primary\b[^"]*"[^>]*\bhref="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
    const duplicateHref =
      ((card.match(/<a[^>]*data-g5-outline-duplicate[^>]*\bhref="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
    const deleteHref =
      ((card.match(/data-g-config-href-confirm="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
    out.push({ id, title, isDefault, layoutHref, duplicateHref, deleteHref });
  }
  return out;
}

/**
 * List configured outlines. Dual-mode.
 *   listOutlines(page)              — legacy browser
 *   listOutlines(ctx)               — new (HTTP or browser via ctx.fetch)
 *
 * Returns: [{ id, title, isDefault, layoutHref, duplicateHref, deleteHref? }]
 */
async function listOutlines(arg1, arg2) {
  // Normalise: callers may pass (page) or (ctx) or (undefined, ctx)
  if (!arg1 && arg2) arg1 = arg2;
  if (arg1 && typeof arg1.evaluate === 'function') {
    // Browser path — parse via the live DOM
    return arg1.evaluate(() => {
      const out = [];
      document.querySelectorAll('div[id^="outline-"]').forEach((card) => {
        const id = card.id.replace(/^outline-/, '');
        const titleEl =
          card.querySelector('h4 .title, h4 span[data-title-editable]') ||
          card.querySelector('h4 span');
        const title = (titleEl?.textContent || '').trim();
        const isDefault =
          card.parentElement?.classList?.contains('outline-is-default') ||
          id === 'default';
        const editLink =
          card.querySelector('.outline-actions a.button-primary')?.getAttribute('href') || '';
        const dupeLink =
          card.querySelector('.outline-actions a[data-g5-outline-duplicate]')?.getAttribute('href') || '';
        const delLink =
          card.querySelector('a[data-g-config-href-confirm]')?.getAttribute('href') ||
          card.querySelector('button[data-g-config-href-confirm]')?.getAttribute('data-g-config-href-confirm') || '';
        out.push({
          id, title, isDefault,
          layoutHref: editLink,
          duplicateHref: dupeLink,
          deleteHref: delLink,
        });
      });
      return out;
    });
  }
  // HTTP path — parse the cached HTML stashed by openOutlines
  const ctx = arg1;
  const html = ctx?._outlinesHtml;
  if (!html) throw new Error('listOutlines(ctx): call openOutlines(ctx) first.');
  return parseOutlinesFromHtml(html);
}

/**
 * Click the "Create New Outline" button (the FAB-style button with
 * data-g5-outline-create). Returns once the new-outline dialog is open.
 */
async function createOutline(page) {
  const btn = await page.$('[data-g5-outline-create]');
  if (!btn) throw new Error('Create-outline button not found');
  await btn.click();
  await page.waitForSelector('.g5-dialog, [role="dialog"], .modal', { timeout: 10000 });
  await sleep(400);
}

/**
 * Build a /configurations/<id>/<action> URL.
 */
function configurationUrl(ctx, id, action, asJson = false) {
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + id + '/' + action)}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '');
  return asJson ? url + '&format=json' : url;
}

/**
 * Duplicate an outline. Works in both HTTP and browser modes.
 *
 *   duplicateOutline(ctx, sourceId, { title?, inherit? })   — HTTP / new
 *   duplicateOutline(page, sourceId, { title?, inherit? })  — legacy browser
 *
 * HTTP path POSTs directly to view=configurations/<id>/duplicate/new with
 * form-encoded body { title, from=outline, outline=<sourceId>, inherit=1|"" }.
 *
 * Returns { newOutlineId? } when the server response includes the new id;
 * otherwise just true on success.
 */
async function duplicateOutline(arg1, id, opts = {}) {
  // Detect calling form
  if (arg1 && typeof arg1.evaluate === 'function') {
    return _duplicateOutlineBrowser(arg1, id, opts);
  }
  if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    return _duplicateOutlineHttp(arg1, id, opts);
  }
  throw new Error('duplicateOutline: first arg must be a Page or ctx');
}

async function _duplicateOutlineHttp(ctx, id, opts) {
  const url = configurationUrl(ctx, id, 'duplicate/new', true);
  const body =
    `title=${encodeURIComponent(opts.title || '')}` +
    `&from=outline` +
    `&outline=${encodeURIComponent(id)}` +
    (opts.inherit === false ? '' : `&inherit=1`);
  const res = await ctx.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  });
  if (res.status >= 400) {
    throw new Error(`Duplicate ${res.status}: ${res.body.slice(0, 300)}`);
  }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  if (parsed && parsed.success === false) {
    throw new Error(`Duplicate failed: ${parsed.message || res.body.slice(0, 300)}`);
  }
  // Gantry usually returns { code, success, ... } — surface the new id if present
  return parsed || { ok: true };
}

async function _duplicateOutlineBrowser(page, id, opts) {
  const sel = `#outline-${id} a[data-g5-outline-duplicate]`;
  const btn = await page.$(sel);
  if (!btn) throw new Error(`Duplicate button not found for outline ${id}`);
  await btn.click();

  await page.waitForSelector('[data-g-outline-create-confirm]', { timeout: 10000 });
  await sleep(300);

  if (opts.title) {
    const input = await page.$('input[name="title"]');
    if (input) {
      await input.click({ clickCount: 3 });
      await input.type(String(opts.title), { delay: 10 });
    }
  }
  if (opts.inherit === false) {
    const cb = await page.$('input[name="inherit"]');
    if (cb) {
      const checked = await page.evaluate((el) => el.checked, cb);
      if (checked) await cb.click();
    }
  }
  const confirm = await page.$('[data-g-outline-create-confirm]');
  await Promise.all([
    page
      .waitForResponse((r) => /duplicate\/new/.test(r.url()), { timeout: 15000 })
      .catch(() => {}),
    confirm.click(),
  ]);
  await page
    .waitForFunction(
      () => !document.querySelector('[data-g-outline-create-confirm]'),
      { timeout: 10000 }
    )
    .catch(() => {});
  await sleep(800);
}

/**
 * Particle Defaults / Site Settings (URL: view=configurations/<outline>/settings).
 */
async function openParticleDefaults(page, ctx, outline = 'default') {
  await page.goto(gantryUrl(ctx, `configurations/${outline}/settings`), {
    waitUntil: 'networkidle2',
  });
  await page.waitForSelector('form, [data-save]', { timeout: 20000 });
  await sleep(400);
}

/**
 * Delete an outline. Dual-mode.
 *   deleteOutline(ctx, id)         — HTTP / new
 *   deleteOutline(page, ctx, id)   — legacy browser (reads URL from DOM)
 *
 * The base/default outlines can't be deleted; the server enforces this.
 */
async function deleteOutline(arg1, arg2, arg3) {
  if (arg1 && typeof arg1.evaluate === 'function') {
    // (page, ctx, id)
    return _deleteOutlineBrowser(arg1, arg2, arg3);
  }
  if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    // (ctx, id)
    return _deleteOutlineHttp(arg1, arg2);
  }
  throw new Error('deleteOutline: first arg must be a Page or ctx');
}

async function _deleteOutlineHttp(ctx, id) {
  if (!id || id === 'default') {
    throw new Error(`Cannot delete outline "${id}" (system outline / no delete URL).`);
  }
  const url = configurationUrl(ctx, id, 'delete/confirm', true);
  const res = await ctx.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: '',
  });
  if (res.status >= 400) {
    throw new Error(`Delete ${res.status}: ${res.body.slice(0, 300)}`);
  }
  try {
    const j = JSON.parse(res.body);
    if (j && j.success === false) throw new Error(`Delete failed: ${j.message || res.body.slice(0, 300)}`);
  } catch (e) {
    if (/^Delete failed/.test(e.message)) throw e;
    // Non-JSON response is OK
  }
  return id;
}

async function _deleteOutlineBrowser(page, ctx, id) {
  const info = await page.evaluate((id) => {
    const card = document.getElementById('outline-' + id);
    if (!card) return { error: `Card #outline-${id} not found in DOM` };
    const btn = card.querySelector('button[data-g-config="delete"], button[data-g-config-href-confirm]');
    if (!btn) return { error: `No delete button on outline ${id} (system outlines can't be deleted)` };
    return {
      url: btn.getAttribute('data-g-config-href-confirm'),
      method: (btn.getAttribute('data-g-config-method') || 'POST').toUpperCase(),
    };
  }, id);
  if (info.error) throw new Error(info.error);
  if (!info.url) throw new Error(`Delete URL missing on outline ${id}`);

  const fullUrl = info.url.startsWith('http') ? info.url : `${ctx.base}${info.url}`;
  const result = await page.evaluate(
    async (url, method) => {
      const r = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: '',
      });
      return { status: r.status, text: (await r.text()).slice(0, 400) };
    },
    fullUrl,
    info.method
  );
  if (result.status >= 400) {
    throw new Error(`Delete returned ${result.status}: ${result.text}`);
  }
  try {
    const json = JSON.parse(result.text);
    if (json && json.success === false) throw new Error(json.error || 'delete failed');
  } catch {}
  return id;
}

module.exports = {
  openOutlines,
  listOutlines,
  createOutline,
  duplicateOutline,
  deleteOutline,
  openParticleDefaults,
};
