'use strict';

const { sleep, snap, gantryUrl } = require('./util');

/**
 * Open the Gantry 5 Menu Editor. The Joomla menu alias is e.g. "mainmenu".
 */
async function openMenu(page, ctx, menu = 'mainmenu') {
  await page.goto(gantryUrl(ctx, `menu/${menu}`), { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-g5-menu-columns], .g5-mm-particles-picker', {
    timeout: 20000,
  });
  await sleep(400);
}

/**
 * List menu items in the open editor.
 *  Returns: [{ id, title, level, link, originalType, blocktype }]
 */
async function listMenuItems(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-mm-id][data-mm-level]').forEach((el) => {
      const id = el.getAttribute('data-mm-id');
      // Skip the picker stubs (__module, __particle, etc.)
      if (!id || id.startsWith('__')) return;
      const anchor = el.querySelector('a.menu-item');
      const link = anchor?.getAttribute('href') || '';
      // Title may live in .title, .menu-item-content, or just be the anchor's textContent
      let title = '';
      const tEl =
        el.querySelector('.menu-item-content .title') ||
        el.querySelector('.title') ||
        el.querySelector('.menu-item-content') ||
        anchor;
      if (tEl) {
        // Use direct text nodes / first non-icon span to avoid grabbing icon tooltips
        title = (tEl.textContent || '').replace(/\s+/g, ' ').trim();
      }
      out.push({
        id,
        title,
        level: Number(el.getAttribute('data-mm-level') || 0),
        link,
        originalType: el.getAttribute('data-mm-original-type') || '',
        blocktype: el.getAttribute('data-mm-blocktype') || '',
      });
    });
    return out;
  });
}

/**
 * Select a menu item — clicking its anchor causes Gantry to AJAX-load its
 * settings into the right pane.
 */
async function selectMenuItem(page, itemId) {
  const sel = `[data-mm-id="${itemId}"] a.menu-item`;
  const item = await page.$(sel);
  if (!item) throw new Error(`Menu item ${itemId} not found`);
  await item.click();
  await page
    .waitForResponse((r) => /view=menu\/.+\/.+/.test(r.url()), { timeout: 8000 })
    .catch(() => {});
  await sleep(500);
}

/**
 * Open a menu item's full edit dialog (config-cog → /menu/edit/<menu>/<id>).
 */
async function openMenuItemEditor(page, itemId) {
  const cog = await page.$(`[data-mm-id="${itemId}"] a.config-cog`);
  if (!cog) throw new Error(`Config cog not found for ${itemId}`);
  await cog.click();
  await page.waitForSelector('.g5-dialog, [role="dialog"], .modal', { timeout: 15000 });
  await sleep(400);
}

/**
 * Apply edits to whichever editor is currently open (right-pane or modal).
 * `edits` maps input `name` attribute -> value.
 */
async function applyEdits(page, edits = {}) {
  for (const [name, value] of Object.entries(edits)) {
    const sel = `[name="${name}"], [name="${name}[]"]`;
    const field = await page.$(sel);
    if (!field) {
      console.warn(`  [applyEdits] field "${name}" not found — skipping`);
      continue;
    }
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
    }
  }
  // Apply within dialog if present
  const apply = await page.$('button.button-apply, .button-save, [data-g-particle-apply]');
  if (apply) {
    await apply.click();
    await sleep(400);
  }
}

/**
 * Save the menu editor (top-level Save Menu button).
 */
async function saveMenu(page) {
  const btn = await page.$('[data-save="Menu"]');
  if (!btn) {
    await snap(page, 'menu-save-missing');
    throw new Error('Save Menu button not found.');
  }
  await btn.click();
  await page
    .waitForSelector('.g-notify, .alert-success, [data-g-notify]', { timeout: 8000 })
    .catch(() => {});
  await sleep(800);
}

/* ---------------- Page Settings (per-outline) ---------------- */
/**
 * Open page settings for an outline. URL is `view=configurations/<outline>/page`.
 */
async function openPageSettings(page, ctx, outline = 'default') {
  await page.goto(gantryUrl(ctx, `configurations/${outline}/page`), {
    waitUntil: 'networkidle2',
  });
  await page.waitForSelector('form, [data-save]', { timeout: 20000 });
  await sleep(400);
}

async function savePageSettings(page) {
  const btn = await page.$('[data-save="Page Settings"], [data-save*="Page"]');
  if (btn) {
    await btn.click();
    await sleep(800);
  }
}

/* ---------------- Assignments (only on non-default outlines) ---------------- */
async function openAssignments(page, ctx, outline) {
  if (outline === 'default') {
    throw new Error('The "default" outline has no assignments — pick a child outline.');
  }
  await page.goto(gantryUrl(ctx, `configurations/${outline}/assignments`), {
    waitUntil: 'networkidle2',
  });
  await page.waitForSelector('form, [data-save]', { timeout: 20000 });
  await sleep(400);
}

async function setAssignments(page, assignments = {}) {
  for (const [itemId, on] of Object.entries(assignments)) {
    const cb = await page.$(`input[type="checkbox"][name*="${itemId}"]`);
    if (!cb) {
      console.warn(`  [setAssignments] checkbox for "${itemId}" not found`);
      continue;
    }
    const checked = await page.evaluate((el) => el.checked, cb);
    if (Boolean(on) !== checked) await cb.click();
  }
  const btn = await page.$('[data-save*="Assignments"]');
  if (btn) {
    await btn.click();
    await sleep(800);
  }
}

module.exports = {
  openMenu,
  listMenuItems,
  selectMenuItem,
  openMenuItemEditor,
  applyEdits,
  saveMenu,
  openPageSettings,
  savePageSettings,
  openAssignments,
  setAssignments,
};
