'use strict';

const { sleep, snap, gantryUrl } = require('./util');

/**
 * Open the Layout Manager for a given outline. Browser-mode only — in HTTP
 * mode there's no page to open, so this is a no-op (the caller should fetch
 * the layout JSON via layoutApi.fetchSavedLayout).
 *
 * Accepts either (page, ctx, outline) for legacy callers, or (ctx, outline)
 * — in which case it uses ctx.page when present.
 */
async function openLayout(pageOrCtx, ctxOrOutline, outline = 'default') {
  let page, ctx;
  if (pageOrCtx && typeof pageOrCtx.evaluate === 'function') {
    page = pageOrCtx;
    ctx = ctxOrOutline;
  } else {
    ctx = pageOrCtx;
    outline = ctxOrOutline || 'default';
    page = ctx?.page;
  }
  if (!page || (ctx && ctx.mode === 'http')) {
    // HTTP mode — nothing to navigate
    return;
  }
  await page.goto(gantryUrl(ctx, `configurations/${outline}/layout`), {
    waitUntil: 'networkidle2',
  });
  await page.waitForSelector('.lm-blocks, #lm-no-layout', { timeout: 20000 });
  await page.waitForFunction(
    () =>
      !!document.querySelector('[data-lm-id]') ||
      !!document.querySelector('#lm-no-layout'),
    { timeout: 5000 }
  ).catch(() => {});
  await sleep(400);
}

/**
 * Return true if this outline currently has no layout (the "No layout specified!" card).
 */
async function isEmpty(page) {
  return page.evaluate(() => !!document.querySelector('#lm-no-layout'));
}

/**
 * Click "Load" → preset to seed an empty outline.  Pass the preset name
 * (e.g. "default") or null for the first preset listed.
 */
async function loadPreset(page, presetName) {
  const sel = 'a[data-lm-switcher], button[data-lm-switcher]';
  const el = await page.$(sel);
  if (!el) throw new Error('Load button not found');
  await el.click();
  await page.waitForSelector('.g5-dialog, [role="dialog"], .modal', { timeout: 10000 });
  await sleep(400);

  if (presetName) {
    // Pick by visible text
    await page.evaluate((name) => {
      const items = Array.from(document.querySelectorAll('.g5-dialog a, [role="dialog"] a, .modal a'));
      const t = items.find((a) => (a.textContent || '').trim().toLowerCase() === name.toLowerCase());
      if (t) t.click();
    }, presetName);
  } else {
    // Click the first thumbnail
    await page.evaluate(() => {
      const t = document.querySelector('.g5-dialog a, [role="dialog"] a, .modal a');
      if (t) t.click();
    });
  }
  await sleep(800);
}

/**
 * List every block currently rendered in the layout.
 * Each block: { id, type, subtype, title, sectionId, inherited }
 *
 * Confirmed via live walkthrough: inherited blocks carry classes
 * `g-inheriting`, `g-inheriting-block`, `g-inheriting-attributes`. Their cogs
 * don't open editors — callers should either skip them or break inheritance
 * first.
 */
async function listParticles(page, opts = {}) {
  const { onlyEditable = false, includeBlocks = false } = opts;
  return page.evaluate((onlyEditable, includeBlocks) => {
    const out = [];
    document.querySelectorAll('[data-lm-id]').forEach((el) => {
      const type = el.getAttribute('data-lm-blocktype') || '';
      if (type === 'section' || type === 'container' || type === 'grid') return;
      // Skip wrapper blocks unless caller wants them — particles/system/spacer/position
      // are the addressable targets; "block" is just the column wrapper.
      if (type === 'block' && !includeBlocks) return;
      const inherited =
        el.classList.contains('g-inheriting') ||
        el.classList.contains('g-inheriting-block') ||
        el.classList.contains('g-inheriting-attributes');
      const disabled =
        el.classList.contains('g-disabled') ||
        el.classList.contains('disabled') ||
        el.querySelector('.disabled') !== null;
      if (onlyEditable && (inherited || disabled)) return;
      const id = el.getAttribute('data-lm-id') || '';
      const subtype =
        el.getAttribute('data-lm-blocksubtype') ||
        el.getAttribute('data-lm-subtype') ||
        '';
      const titleEl = el.querySelector('.title, .particle-title');
      const title = (titleEl?.textContent || el.getAttribute('data-title') || '').trim();
      const section = el.closest('section[id]');
      out.push({
        id,
        type,
        subtype,
        title,
        sectionId: section ? section.id : '',
        inherited,
        disabled,
      });
    });
    return out;
  }, onlyEditable, includeBlocks);
}

/**
 * Drag a block (by id) into a target container (section/grid/block by id).
 *
 * Gantry uses jQuery-UI sortable. Reliable triggering needs:
 *   1. Real native mouse events (puppeteer's page.mouse — which is what we use).
 *   2. A small "wiggle" right after mousedown to satisfy sortable's distance threshold.
 *   3. A slow, multi-step move toward the target so sortable's `over` handler fires
 *      on each intermediate container.
 *   4. A pause near the target before mouseup so the drop indicator settles.
 *
 * Drag-drop happens entirely client-side; the server only sees the final layout
 * when saveLayout() POSTs `view=configurations/<outline>/layout&format=json`.
 */
async function moveParticle(page, particleId, targetContainerId) {
  const src = await page.$(`[data-lm-id="${particleId}"]`);
  const dst = await page.$(`[data-lm-id="${targetContainerId}"]`);
  if (!src) throw new Error(`Particle ${particleId} not found`);
  if (!dst) {
    throw new Error(
      `Target container "${targetContainerId}" not found. ` +
        'Use a stable section id (e.g. "navigation", "expanded", "footer", "extension") ' +
        'or a particle id from `layout list`. Grid/block ids are randomized per page load.'
    );
  }

  // Refuse inherited or disabled blocks — drag won't take
  const flags = await page.evaluate(
    (el) => ({
      inherited:
        el.classList.contains('g-inheriting') ||
        el.classList.contains('g-inheriting-block'),
      disabled:
        el.classList.contains('g-disabled') ||
        el.classList.contains('disabled'),
    }),
    src
  );
  if (flags.inherited) {
    throw new Error(
      `Particle ${particleId} is inheriting from base; break inheritance before moving.`
    );
  }
  if (flags.disabled) {
    throw new Error(
      `Particle ${particleId} is disabled; enable it first or pick a different particle.`
    );
  }

  await src.scrollIntoView();
  await sleep(150);
  const srcBox = await src.boundingBox();
  const dstBox = await dst.boundingBox();
  if (!srcBox || !dstBox) throw new Error('Could not measure source/target geometry');

  const sx = srcBox.x + srcBox.width / 2;
  const sy = srcBox.y + srcBox.height / 2;
  const dx = dstBox.x + dstBox.width / 2;
  const dy = dstBox.y + dstBox.height / 2;

  await page.mouse.move(sx, sy);
  await sleep(80);
  await page.mouse.down();
  // Initial wiggle to clear sortable distance threshold
  await page.mouse.move(sx + 6, sy + 6);
  await sleep(40);
  await page.mouse.move(sx, sy);
  await sleep(40);
  // Slow incremental traversal toward the target
  const steps = 32;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      sx + ((dx - sx) * i) / steps,
      sy + ((dy - sy) * i) / steps
    );
    await sleep(25);
  }
  // Settle on the drop zone
  await page.mouse.move(dx, dy);
  await sleep(350);
  await page.mouse.up();
  await sleep(500);
}

/**
 * Drag a fresh particle from the picker sidebar into a target container.
 * Same drag mechanics as moveParticle.
 *
 *   pickerKey:     data-lm-blocktype  (position | particle | spacer | system)
 *   pickerSubtype: data-lm-subtype    (e.g. "branding", "module", "content")
 */
async function addParticle(page, pickerKey, pickerSubtype, targetContainerId, opts = {}) {
  const { verbose = false } = opts;
  const log = (...a) => verbose && console.log('  [addParticle]', ...a);

  const sel = `.g5-lm-particles-picker [data-lm-blocktype="${pickerKey}"][data-lm-subtype="${pickerSubtype}"]`;
  const src = await page.$(sel);
  if (!src) throw new Error(`Picker item ${pickerKey}/${pickerSubtype} not found`);
  const dst = await page.$(`[data-lm-id="${targetContainerId}"]`);
  if (!dst) {
    throw new Error(
      `Target container "${targetContainerId}" not found. ` +
        'Use a section id (e.g. "navigation", "expanded", "footer"). ' +
        'Grid/block ids change on every page load.'
    );
  }

  // Snapshot child count of target so we can verify the drop took
  const beforeCount = await page.evaluate(
    (id) => document.querySelectorAll(`[data-lm-id="${id}"] [data-lm-id]`).length,
    targetContainerId
  );
  log('beforeCount =', beforeCount);

  // Scroll target into view (picker is sticky on the left, always visible)
  await dst.scrollIntoView();
  await sleep(200);

  const sBox = await src.boundingBox();
  const dBox = await dst.boundingBox();
  if (!sBox || !dBox) throw new Error('Could not measure picker/target geometry');
  const sx = sBox.x + sBox.width / 2;
  const sy = sBox.y + sBox.height / 2;
  const dx = dBox.x + dBox.width / 2;
  const dy = dBox.y + dBox.height / 2;
  log(`source=(${sx},${sy}) target=(${dx},${dy})`);

  await page.mouse.move(sx, sy);
  await sleep(80);
  await page.mouse.down();
  // Larger initial wiggle: jQuery-UI sortable's distance threshold is 1px
  // but Gantry sets it higher. Move 12px in each direction to be sure.
  await page.mouse.move(sx + 12, sy);
  await sleep(40);
  await page.mouse.move(sx + 12, sy + 12);
  await sleep(40);
  // Slow incremental traversal toward the target — many small steps
  const steps = 50;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      sx + ((dx - sx) * i) / steps,
      sy + ((dy - sy) * i) / steps
    );
    await sleep(30);
  }
  // Hover on the drop target a bit longer so the over indicator settles
  await page.mouse.move(dx, dy);
  await sleep(600);
  await page.mouse.up();
  await sleep(800);

  const afterCount = await page.evaluate(
    (id) => document.querySelectorAll(`[data-lm-id="${id}"] [data-lm-id]`).length,
    targetContainerId
  );
  log('afterCount =', afterCount);

  if (afterCount <= beforeCount) {
    throw new Error(
      `Drag-drop did not register — target "${targetContainerId}" has the same number of children before and after. ` +
        'Run with --keep-open to watch the browser; common causes: target offscreen, picker filtered, jQuery-UI sortable handle mismatch.'
    );
  }
}

/**
 * Drag a block onto the trash zone (#trash) to delete it.
 * Note the trash element only becomes visible while a drag is in progress —
 * Gantry pops it in via JS when mousedown fires on a sortable handle.
 */
async function removeParticle(page, particleId) {
  const src = await page.$(`[data-lm-id="${particleId}"]`);
  if (!src) throw new Error(`Particle ${particleId} not found`);

  await src.scrollIntoView();
  await sleep(150);
  const sBox = await src.boundingBox();
  const sx = sBox.x + sBox.width / 2;
  const sy = sBox.y + sBox.height / 2;

  await page.mouse.move(sx, sy);
  await sleep(80);
  await page.mouse.down();
  await page.mouse.move(sx + 6, sy + 6);
  await sleep(40);

  // Trash zone appears AFTER mousedown
  const trash = await page.waitForSelector('#trash, [data-lm-eraseblock]', { timeout: 4000 });
  const tBox = await trash.boundingBox();
  if (!tBox) throw new Error('Trash zone not measurable');
  const tx = tBox.x + tBox.width / 2;
  const ty = tBox.y + tBox.height / 2;

  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + ((tx - sx) * i) / steps, sy + ((ty - sy) * i) / steps);
    await sleep(25);
  }
  await page.mouse.move(tx, ty);
  await sleep(350);
  await page.mouse.up();
  await sleep(500);
}

/**
 * Open a particle's settings dialog and apply edits.
 *
 * Confirmed flow (Joomla 5 / Gantry 5.6+):
 *  1. Click the .fa-cog inside the particle block. Gantry dispatches a POST to
 *     `view=configurations/<outline>/layout/particle/<id>&format=json` and
 *     mounts the response into `.g5-dialog`.
 *  2. Form inputs are named `particles[<particleType>][<field>]` — keys can be
 *     deeply nested (e.g. `particles[contentarray][article][limit][total]`).
 *  3. Three buttons close the dialog:
 *      - "Apply"          → particle settings update client-side state only
 *      - "Apply and Save" → applies AND saves the whole layout (recommended)
 *      - "Cancel"         → discards changes
 *
 * `edits` maps each input's `name` attribute to its desired value.
 * `mode`  controls which button is clicked at the end:
 *           "applyAndSave" (default) — clicks Apply and Save
 *           "apply"                  — clicks Apply (caller must saveLayout())
 *           "cancel"                 — discards (debug)
 */
async function editParticle(page, particleId, edits = {}, mode = 'applyAndSave') {
  const block = await page.$(`[data-lm-id="${particleId}"]`);
  if (!block) throw new Error(`Particle ${particleId} not found`);

  // Refuse to edit inherited particles — their cog is a no-op
  const inherited = await page.evaluate(
    (el) =>
      el.classList.contains('g-inheriting') ||
      el.classList.contains('g-inheriting-block'),
    block
  );
  if (inherited) {
    throw new Error(
      `Particle ${particleId} is inheriting from the base outline; break inheritance before editing.`
    );
  }

  // Real native clicks via puppeteer go through fine; synthetic browsers needed
  // dispatched events. Stick with the puppeteer click — it's a real input.
  await block.scrollIntoView();
  const cog = await block.$('.fa-cog');
  if (!cog) throw new Error(`No settings cog on particle ${particleId}`);
  await cog.click();

  await page.waitForSelector('.g5-dialog', { timeout: 15000 });
  // Wait for the form to mount inside the dialog
  await page.waitForFunction(
    () => !!document.querySelector('.g5-dialog input[name^="particles["]'),
    { timeout: 8000 }
  ).catch(() => {});
  await sleep(300);

  for (const [name, value] of Object.entries(edits)) {
    const sel = `.g5-dialog [name="${name}"], .g5-dialog [name="${name}[]"]`;
    const field = await page.$(sel);
    if (!field) {
      console.warn(`  [editParticle] field "${name}" not found in dialog`);
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

  const labelMap = {
    applyAndSave: 'apply and save',
    apply: 'apply',
    cancel: 'cancel',
  };
  const target = labelMap[mode] || labelMap.applyAndSave;
  const clicked = await page.evaluate((label) => {
    const dlg = document.querySelector('.g5-dialog');
    if (!dlg) return false;
    const btn = [...dlg.querySelectorAll('button')].find(
      (b) => b.textContent.trim().toLowerCase() === label
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, target);
  if (!clicked) throw new Error(`Dialog button "${target}" not found`);

  // Wait for the dialog to close
  await page
    .waitForFunction(() => !document.querySelector('.g5-dialog'), { timeout: 10000 })
    .catch(() => {});
  await sleep(400);
}

/**
 * Click the "Save Layout" button. Gantry POSTs an AJAX payload — we wait for
 * the success toast or a brief settle.
 */
async function saveLayout(page) {
  const sel = '[data-save="Layout"], .button-save[data-save]';
  const btn = await page.$(sel);
  if (!btn) {
    await snap(page, 'save-button-missing');
    throw new Error('Save Layout button not found — screenshot saved.');
  }
  await btn.click();
  await page
    .waitForSelector('.g-notify, .alert-success, [data-g-notify]', { timeout: 8000 })
    .catch(() => {});
  await sleep(800);
}

/**
 * Enumerate every item in the picker sidebar — the menu of available block
 * types you can add to the layout. Each row gives:
 *   { label, blocktype, subtype, group, disabled }
 *
 * `disabled` is true if Gantry has flagged the item unusable for this site
 * (some particles depend on plugins that aren't installed).
 */
async function listAvailableParticles(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.g5-lm-particles-picker li[data-lm-blocktype]').forEach((li) => {
      const blocktype = li.getAttribute('data-lm-blocktype') || '';
      const subtype = li.getAttribute('data-lm-subtype') || '';
      const label = (li.querySelector('.particle-title')?.textContent || '').trim();
      // Find the closest preceding text node (the group label "Positions" / "Particles")
      let group = '';
      let p = li.closest('ul');
      while (p && p.previousSibling) {
        p = p.previousSibling;
        if (p.nodeType === 3 || (p.textContent || '').trim()) {
          group = (p.textContent || '').trim();
          if (group) break;
        }
      }
      const disabled =
        li.classList.contains('disabled') ||
        li.classList.contains('g-disabled') ||
        li.getAttribute('data-lm-disabled') !== null;
      out.push({ label, blocktype, subtype, group, disabled });
    });
    return out;
  });
}

/**
 * Open a particle's settings dialog and return every form field it exposes:
 *   [{ name, type, value, options? }, ...]
 *
 * Doesn't save anything — closes the dialog (Cancel) on the way out.
 */
async function inspectParticleFields(page, particleId) {
  const block = await page.$(`[data-lm-id="${particleId}"]`);
  if (!block) throw new Error(`Particle ${particleId} not found`);

  const inherited = await page.evaluate(
    (el) => el.classList.contains('g-inheriting') || el.classList.contains('g-inheriting-block'),
    block
  );
  if (inherited) {
    throw new Error(`Particle ${particleId} is inherited — break inheritance to inspect.`);
  }

  await block.scrollIntoView();
  const cog = await block.$('.fa-cog');
  if (!cog) throw new Error(`No settings cog on particle ${particleId}`);
  await cog.click();
  await page.waitForSelector('.g5-dialog', { timeout: 15000 });
  await page.waitForFunction(
    () => !!document.querySelector('.g5-dialog input[name^="particles["]'),
    { timeout: 8000 }
  ).catch(() => {});
  await sleep(300);

  const fields = await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll('.g5-dialog input, .g5-dialog select, .g5-dialog textarea')
    )
      .filter((el) => el.name)
      .map((el) => {
        const out = {
          name: el.name,
          type: el.type || el.tagName.toLowerCase(),
          value: el.value || '',
        };
        if (el.tagName === 'SELECT') {
          out.options = Array.from(el.options).map((o) => ({
            value: o.value,
            label: (o.textContent || '').trim(),
          }));
        }
        return out;
      });
  });

  // Close dialog without saving
  await page.evaluate(() => {
    const dlg = document.querySelector('.g5-dialog');
    if (!dlg) return;
    const cancel = [...dlg.querySelectorAll('button')].find(
      (b) => b.textContent.trim().toLowerCase() === 'cancel'
    );
    if (cancel) cancel.click();
  });
  await sleep(300);
  return fields;
}

/**
 * Return only stable, section-level drop targets. Use these as the `--to`
 * argument for `layout add` / `layout move`.
 *
 * Section ids are stable across page loads (e.g. "navigation", "expanded",
 * "footer"). Grid and block ids are regenerated each render.
 */
async function listSections(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-lm-blocktype="section"], [data-lm-blocktype="container"], [data-lm-blocktype="offcanvas"]').forEach((el) => {
      const id = el.getAttribute('data-lm-id') || '';
      if (!id || /^(grid|block|atom)-/.test(id)) return;
      const type = el.getAttribute('data-lm-blocktype') || '';
      const titleEl = el.querySelector(':scope > .g-grid > .g-block .title, :scope > .title');
      out.push({
        id,
        type,
        title: (titleEl?.textContent || id).trim(),
      });
    });
    return out;
  });
}

/**
 * Return every container in the current layout — sections, grids, and blocks —
 * with parent-child relationships. Useful for picking drop targets.
 *
 *   { id, type, parent, children: [...ids] }
 */
async function dumpLayoutTree(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll('[data-lm-id]');
    const map = new Map();
    all.forEach((el) => {
      const id = el.getAttribute('data-lm-id');
      const type = el.getAttribute('data-lm-blocktype') || '';
      map.set(id, { id, type, parent: null, children: [] });
    });
    all.forEach((el) => {
      const id = el.getAttribute('data-lm-id');
      const ancestor = el.parentElement?.closest('[data-lm-id]');
      if (ancestor) {
        const pid = ancestor.getAttribute('data-lm-id');
        if (map.has(pid)) {
          map.get(id).parent = pid;
          map.get(pid).children.push(id);
        }
      }
    });
    return Array.from(map.values());
  });
}

module.exports = {
  openLayout,
  isEmpty,
  loadPreset,
  listParticles,
  listAvailableParticles,
  inspectParticleFields,
  listSections,
  dumpLayoutTree,
  moveParticle,
  addParticle,
  removeParticle,
  editParticle,
  saveLayout,
};
