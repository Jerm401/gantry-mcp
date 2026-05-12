'use strict';

/**
 * JSON-based Layout API.
 *
 * Bypasses Gantry's drag/drop UI entirely — modifies the in-memory layout
 * structure via `window.G5.lm.builder.serialize()` / `setStructure(json)`,
 * then triggers Save Layout. Way more reliable than synthesized mouse drags
 * through CDP.
 *
 * The serialized structure is an array of nodes:
 *   { id, type, subtype, title, attributes, inherit, children: [...] }
 *
 * Types observed: container | section | offcanvas | grid | block | particle | system | spacer | position
 */

const { sleep, snap } = require('./util');
const backup = require('./backup');

/**
 * Random id like "branding-7421". Keeps Gantry's existing id convention.
 */
function freshId(prefix) {
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

/* ============================================================
 *  Pure helpers — operate on a structure JSON, no Page needed
 * ============================================================ */

/**
 * Walk the tree and call cb(node, parent, index, depth) for each node.
 * Stops if cb returns true.
 */
function walk(structure, cb, parent = null, depth = 0) {
  if (!Array.isArray(structure)) return false;
  for (let i = 0; i < structure.length; i++) {
    const node = structure[i];
    if (cb(node, parent, i, depth)) return true;
    if (Array.isArray(node.children)) {
      if (walk(node.children, cb, node, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Find a node by id (or matching predicate). Returns { node, parent, index } or null.
 */
function findNode(structure, idOrFn) {
  let result = null;
  const matcher =
    typeof idOrFn === 'function' ? idOrFn : (n) => n.id === idOrFn;
  walk(structure, (node, parent, index) => {
    if (matcher(node)) {
      result = { node, parent, index };
      return true;
    }
    return false;
  });
  return result;
}

/**
 * Remove a node by id; returns the removed node (or null).
 */
function removeNode(structure, id) {
  const found = findNode(structure, id);
  if (!found) return null;
  const siblings = found.parent ? found.parent.children : structure;
  siblings.splice(found.index, 1);
  return found.node;
}

/**
 * Build a fresh layout node ready to drop into a block.
 *
 * Gantry layout nodes come in four block-types (the `type` field):
 *   - "particle"  → an actual Gantry particle. id is `<subtype>-NNNN`
 *                   Examples: blockcontent, customhtml, logo, menu, video, search, ...
 *   - "position"  → a Joomla module placeholder.  id is `position-<subtype>-NNNN`
 *                   subtype="module" (Module Instance) or "position" (Module Position)
 *   - "spacer"    → blank visual spacer. id is `spacer-NNNN`. subtype="spacer".
 *   - "system"    → Joomla content (Page Content, System Messages).
 *                   id is `system-<subtype>-NNNN`.
 *                   subtype="content" (Page Content) or "messages" (System Messages)
 *
 *   `title`: display title (optional)
 *   `attrs`: attribute object — fields in the settings dialog
 */
function makeParticleNode(blocktype, subtype, title = '', attrs = {}) {
  // Pick the id prefix matching what Gantry's picker would produce
  let idPrefix;
  if (blocktype === 'particle') idPrefix = subtype;
  else if (blocktype === 'spacer') idPrefix = 'spacer';
  else idPrefix = `${blocktype}-${subtype}`; // position-module, system-content, ...

  return {
    id: freshId(idPrefix),
    type: blocktype,
    subtype,
    title: title || subtype.charAt(0).toUpperCase() + subtype.slice(1),
    attributes: blocktype === 'particle' ? { enabled: 1, ...attrs } : { ...attrs },
    inherit: {},
    children: [],
  };
}

function makeBlockNode(particle, sizePct = 100, blockClass = '') {
  return {
    id: freshId('block'),
    type: 'block',
    subtype: false,
    title: 'Untitled',
    attributes: blockClass ? { size: sizePct, class: blockClass } : { size: sizePct },
    inherit: {},
    children: [particle],
  };
}

function makeGridNode(blocks) {
  return {
    id: freshId('grid'),
    type: 'grid',
    subtype: false,
    title: 'Untitled',
    attributes: {},
    inherit: {},
    children: Array.isArray(blocks) ? blocks : [blocks],
  };
}

/**
 * Add a new node (particle / position / spacer / system) to a section.
 *
 *   addParticleToSection(structure, "expanded", "particle", "blockcontent", { title: "My Block" })
 *   addParticleToSection(structure, "expanded", "spacer",   "spacer")
 *   addParticleToSection(structure, "expanded", "system",   "content")        // Page Content
 *   addParticleToSection(structure, "expanded", "system",   "messages")       // System Messages
 *   addParticleToSection(structure, "navigation","position","module")         // Module Instance
 *
 * mode = "newGrid" (default): drops a new full-width grid below existing.
 * mode = "firstGrid": appends as a sibling block in the first grid (auto-resize).
 *
 * Returns the new node (so the caller can read its id).
 */
function addParticleToSection(structure, sectionId, blocktype, subtype, opts = {}) {
  const { title, attrs, mode = 'newGrid' } = opts;
  const target = findNode(structure, sectionId);
  if (!target) throw new Error(`Section "${sectionId}" not found in layout`);
  if (!['section', 'container', 'offcanvas'].includes(target.node.type)) {
    throw new Error(
      `Target "${sectionId}" is a ${target.node.type}; can only append into section/container/offcanvas.`
    );
  }
  const node = makeParticleNode(blocktype, subtype, title, attrs);
  if (mode === 'newGrid') {
    const block = makeBlockNode(node, 100);
    const grid = makeGridNode(block);
    target.node.children.push(grid);
  } else if (mode === 'firstGrid') {
    // Append as a new sibling block in the first grid (auto-resize-on-render)
    const grid = (target.node.children || []).find((c) => c.type === 'grid');
    if (!grid) {
      const block = makeBlockNode(node, 100);
      target.node.children.push(makeGridNode(block));
    } else {
      const blocks = grid.children || (grid.children = []);
      const newSize = Number((100 / (blocks.length + 1)).toFixed(2));
      blocks.forEach((b) => {
        if (b.attributes) b.attributes.size = newSize;
      });
      blocks.push(makeBlockNode(node, newSize));
    }
  }
  return node;
}

/**
 * Parse a Gantry form-field name into a path array.
 *   "particles[contentarray][article][limit][total]"
 *     -> ["particles", "contentarray", "article", "limit", "total"]
 */
function parseFieldName(name) {
  return name.replace(/\]/g, '').split(/\[/);
}

/** Set a deep path (array of keys) on `obj` to `value`, creating intermediate objects. */
function setDeep(obj, pathKeys, value) {
  let cur = obj;
  for (let i = 0; i < pathKeys.length - 1; i++) {
    const k = pathKeys[i];
    if (cur[k] == null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[pathKeys[pathKeys.length - 1]] = value;
}

/**
 * Apply a flat map of Gantry-style form-field edits to a particle node, by
 * routing each key into the right JSON location:
 *
 *   particles[<subtype>][a][b]  → particle.attributes.a.b
 *   block[a][b]                 → wrapping-block.attributes.a.b
 *   inherit[a][b]               → particle.inherit.a.b
 *
 *   editParticleFromForm(structure, "contentarray-6583", {
 *     "particles[contentarray][title]": "New",
 *     "block[size]": 50,
 *     "inherit[mode]": "clone",
 *   })
 */
function editParticleFromForm(structure, particleId, edits) {
  const found = findNode(structure, particleId);
  if (!found) throw new Error(`Particle "${particleId}" not found`);
  const blockEntry = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(found.node)
  );
  for (const [name, value] of Object.entries(edits)) {
    const tokens = parseFieldName(name);
    const top = tokens[0];
    if (top === 'particles') {
      // tokens[1] is the subtype name; the rest is the path inside attributes.
      if (!found.node.attributes) found.node.attributes = {};
      setDeep(found.node.attributes, tokens.slice(2), value);
    } else if (top === 'block') {
      if (!blockEntry) throw new Error(`No wrapping block found for ${particleId}`);
      if (!blockEntry.node.attributes) blockEntry.node.attributes = {};
      setDeep(blockEntry.node.attributes, tokens.slice(1), value);
    } else if (top === 'inherit') {
      if (!found.node.inherit) found.node.inherit = {};
      setDeep(found.node.inherit, tokens.slice(1), value);
    } else {
      // unrecognised top-level: store as direct property on the node
      setDeep(found.node, tokens, value);
    }
  }
  return found.node;
}

/**
 * Add a new node as a sibling block in the same grid as an existing particle.
 * Auto-resizes existing siblings to share the row equally, unless --size is
 * passed (in which case the new block takes that width and existing blocks
 * share the remainder proportionally).
 *
 *   addParticleNextTo(structure, "contentarray-6583", "particle", "custom",
 *                     { title: "Side", size: 25 })
 *
 * Returns the new node.
 */
function addParticleNextTo(structure, siblingId, blocktype, subtype, opts = {}) {
  const { title, attrs, size } = opts;
  const found = findNode(structure, siblingId);
  if (!found) throw new Error(`Sibling "${siblingId}" not found in layout`);

  // Walk up to the wrapping block, then to its grid
  const block = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(found.node)
  );
  if (!block || block.node.type !== 'block') {
    throw new Error(`Could not find block wrapping "${siblingId}"`);
  }
  const grid = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(block.node)
  );
  if (!grid || grid.node.type !== 'grid') {
    throw new Error(`Could not find grid wrapping "${siblingId}"`);
  }

  const node = makeParticleNode(blocktype, subtype, title, attrs);
  const blocks = grid.node.children;

  if (typeof size === 'number') {
    // Caller specified a width for the new block; rescale others to fit.
    const remaining = 100 - size;
    const oldTotal = blocks.reduce((sum, b) => sum + (Number(b.attributes?.size) || 0), 0) || 100;
    blocks.forEach((b) => {
      if (b.attributes) {
        const cur = Number(b.attributes.size) || 0;
        b.attributes.size = Number(((cur / oldTotal) * remaining).toFixed(2));
      }
    });
    blocks.push(makeBlockNode(node, Number(size.toFixed(2))));
  } else {
    // Equal split among existing siblings + new block
    const newSize = Number((100 / (blocks.length + 1)).toFixed(2));
    blocks.forEach((b) => {
      if (b.attributes) b.attributes.size = newSize;
    });
    blocks.push(makeBlockNode(node, newSize));
  }
  return node;
}

/**
 * Move a particle (by id) into a target section. The particle keeps its block
 * wrapper. The target section receives a new full-width grid containing the
 * particle's block.
 */
function moveParticleToSection(structure, particleId, targetSectionId) {
  const found = findNode(structure, particleId);
  if (!found) throw new Error(`Particle "${particleId}" not found`);
  if (found.node.type !== 'particle' && found.node.type !== 'system' && found.node.type !== 'position' && found.node.type !== 'spacer') {
    throw new Error(`"${particleId}" is type ${found.node.type}; only particles/system/position/spacer can be moved`);
  }
  const target = findNode(structure, targetSectionId);
  if (!target) throw new Error(`Target section "${targetSectionId}" not found`);

  // Find the block wrapping this particle
  const blockEntry = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(found.node)
  );
  if (!blockEntry) throw new Error('Could not locate block wrapping the particle');
  const block = blockEntry.node;

  // Find the grid wrapping that block, and remove the block from it
  const gridEntry = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(block)
  );
  if (!gridEntry) throw new Error('Could not locate grid wrapping the block');
  const idx = gridEntry.node.children.indexOf(block);
  gridEntry.node.children.splice(idx, 1);
  // If the grid is now empty, remove it from its parent
  if (gridEntry.node.children.length === 0) {
    const sec = gridEntry.parent;
    if (sec) sec.children.splice(sec.children.indexOf(gridEntry.node), 1);
  } else {
    // Re-balance sibling block sizes
    const remaining = gridEntry.node.children;
    const newSize = Number((100 / remaining.length).toFixed(2));
    remaining.forEach((b) => {
      if (b.attributes) b.attributes.size = newSize;
    });
  }
  // Drop into a new full-width grid in the target
  block.attributes.size = 100;
  target.node.children.push(makeGridNode(block));
  return found.node;
}

/**
 * Move a particle (by id) so it sits next to another particle (in the same
 * grid). Equal-splits sizes by default.
 */
function moveParticleNextTo(structure, particleId, siblingId) {
  const movingFound = findNode(structure, particleId);
  if (!movingFound) throw new Error(`Particle "${particleId}" not found`);
  const sibFound = findNode(structure, siblingId);
  if (!sibFound) throw new Error(`Sibling "${siblingId}" not found`);

  // Identify wrappers
  const movingBlock = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(movingFound.node)
  );
  const movingGrid = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(movingBlock.node)
  );
  const sibBlock = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(sibFound.node)
  );
  const targetGrid = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(sibBlock.node)
  );

  if (movingGrid.node === targetGrid.node) {
    // Already in same grid — no-op (but rebalance just in case)
    const blocks = targetGrid.node.children;
    const newSize = Number((100 / blocks.length).toFixed(2));
    blocks.forEach((b) => {
      if (b.attributes) b.attributes.size = newSize;
    });
    return movingFound.node;
  }

  // Remove the block from its current grid
  const idx = movingGrid.node.children.indexOf(movingBlock.node);
  movingGrid.node.children.splice(idx, 1);
  if (movingGrid.node.children.length === 0) {
    const sec = movingGrid.parent;
    if (sec) sec.children.splice(sec.children.indexOf(movingGrid.node), 1);
  } else {
    const remaining = movingGrid.node.children;
    const newSize = Number((100 / remaining.length).toFixed(2));
    remaining.forEach((b) => {
      if (b.attributes) b.attributes.size = newSize;
    });
  }

  // Insert into the target grid right after the sibling
  const sibIdx = targetGrid.node.children.indexOf(sibBlock.node);
  targetGrid.node.children.splice(sibIdx + 1, 0, movingBlock.node);
  const after = targetGrid.node.children;
  const newSize = Number((100 / after.length).toFixed(2));
  after.forEach((b) => {
    if (b.attributes) b.attributes.size = newSize;
  });
  return movingFound.node;
}

/* ============================================================
 *  Section-level ops (inherit / clone / attribute edits)
 * ============================================================ */

/**
 * Patch a section's `attributes` object (class, boxed, variations, extras…).
 *   editSectionAttrs(structure, "expanded", { class: "my-cls", boxed: "1" })
 */
function editSectionAttrs(structure, sectionId, attrs) {
  const found = findNode(structure, sectionId);
  if (!found) throw new Error(`Section "${sectionId}" not found`);
  if (!found.node.attributes) found.node.attributes = {};
  Object.assign(found.node.attributes, attrs);
  return found.node;
}

/**
 * Add/remove CSS classes on a section's `attributes.class` string.
 *   addSectionClasses(structure, "expanded", ["sticky", "narrow"])
 *   addSectionClasses(structure, "expanded", [], ["narrow"])  // remove
 */
function addSectionClasses(structure, sectionId, add = [], remove = []) {
  const found = findNode(structure, sectionId);
  if (!found) throw new Error(`Section "${sectionId}" not found`);
  if (!found.node.attributes) found.node.attributes = {};
  const current = String(found.node.attributes.class || '').split(/\s+/).filter(Boolean);
  const set = new Set(current);
  add.forEach((c) => set.add(c));
  remove.forEach((c) => set.delete(c));
  found.node.attributes.class = [...set].join(' ');
  return found.node;
}

/**
 * Mark a node as inheriting from a parent outline.
 *   setNodeInherit(structure, "expanded", { outline: "default", include: ["children","attributes"] })
 *
 * `include` controls what to inherit (Gantry uses values like
 * "children", "attributes", "block").
 */
function setNodeInherit(structure, nodeId, inherit) {
  const found = findNode(structure, nodeId);
  if (!found) throw new Error(`Node "${nodeId}" not found`);
  found.node.inherit = { ...(inherit || {}) };
  return found.node;
}

/**
 * Break inheritance on a node — empties the `inherit` field. The node's
 * existing children stay (so the local copy continues with whatever's there).
 */
function clearNodeInherit(structure, nodeId) {
  const found = findNode(structure, nodeId);
  if (!found) throw new Error(`Node "${nodeId}" not found`);
  found.node.inherit = {};
  return found.node;
}

/**
 * Wipe the entire layout structure.
 *   mode = "full"              → empty array (will fall back to base outline)
 *   mode = "keep-inheritance"  → keep top-level sections that are inheriting,
 *                                 strip their non-inherited children
 */
function clearLayout(structure, mode = 'full') {
  if (mode === 'full') {
    structure.length = 0;
    return structure;
  }
  if (mode === 'keep-inheritance') {
    // Walk top-level: keep nodes that have a non-empty inherit; recursively strip
    // children from the rest.
    const stripChildren = (n) => {
      if (!Array.isArray(n.children)) return;
      n.children = n.children.filter((child) => {
        if (child.inherit && Object.keys(child.inherit).length) {
          stripChildren(child);
          return true;
        }
        return false;
      });
    };
    structure.forEach(stripChildren);
    return structure;
  }
  throw new Error(`Unknown clear mode: ${mode}`);
}

/* ============================================================
 *  Page-bound helpers — call into Gantry's lm.builder API
 * ============================================================ */

/**
 * Serialize the current layout. Two paths:
 *   - browser ctx: read from window.G5.lm.builder (in-memory state, may include
 *     unsaved client-side edits)
 *   - http ctx: GET the layout page HTML and parse `data-lm-root`
 *
 * Either way returns the same JSON-array-of-nodes shape.
 */
async function serializeLayout(ctxOrPage) {
  // Back-compat: callers pass the Page directly when running in browser mode
  if (ctxOrPage && typeof ctxOrPage.evaluate === 'function') {
    return ctxOrPage.evaluate(() => window.G5.lm.builder.serialize());
  }
  const ctx = ctxOrPage;
  if (ctx && ctx.mode === 'browser' && ctx.page) {
    return ctx.page.evaluate(() => window.G5.lm.builder.serialize());
  }
  // HTTP path — needs ctx + outline; signature reroutes through fetchSavedLayout
  throw new Error('serializeLayout(ctx) without a page requires HTTP ctx — use fetchSavedLayout(ctx, outline) instead.');
}

/**
 * Mode-aware: read the current layout structure for an outline. In browser
 * mode this returns the live in-memory state (which may include unsaved
 * client-side edits); in HTTP mode it returns the saved-on-disk layout.
 */
async function getLayoutStructure(ctx, outline) {
  if (ctx?.mode === 'browser' && ctx.page) {
    return ctx.page.evaluate(() => window.G5.lm.builder.serialize());
  }
  return fetchSavedLayout(ctx, outline);
}

/**
 * Pure walker: list every particle/system/spacer/position node in a structure.
 * Returns the same shape as the legacy DOM-based listParticles.
 */
function listParticlesIn(structure, opts = {}) {
  const { onlyEditable = false, includeBlocks = false } = opts;
  const out = [];
  function visit(nodes, parentSection) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const type = node.type || '';
      const isSection = ['section', 'container', 'offcanvas'].includes(type);
      const newParent = isSection ? node.id : parentSection;
      const skipType = ['section', 'container', 'offcanvas', 'grid'].includes(type);
      if (!skipType && (type !== 'block' || includeBlocks)) {
        const inherited = !!(node.inherit && Object.keys(node.inherit).length);
        const disabled = node.attributes?.enabled === 0 || node.attributes?.enabled === '0';
        if (!onlyEditable || (!inherited && !disabled)) {
          out.push({
            id: node.id,
            type,
            subtype: node.subtype || '',
            title: node.title || '',
            sectionId: parentSection,
            inherited,
            disabled,
          });
        }
      }
      visit(node.children, newParent);
    }
  }
  visit(structure, '');
  return out;
}

/** Pure walker: list every section/container/offcanvas (stable drop targets). */
function listSectionsIn(structure) {
  const out = [];
  walk(structure, (n) => {
    const t = n.type || '';
    if (['section', 'container', 'offcanvas'].includes(t)) {
      out.push({ id: n.id, type: t, title: n.title || n.id });
    }
    return false;
  });
  return out;
}

/** Pure walker: full nested tree as flat parent/children list (same as dumpLayoutTree). */
function dumpTreeIn(structure) {
  const out = [];
  function visit(nodes, parent) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      out.push({
        id: node.id,
        type: node.type || '',
        parent,
        children: (node.children || []).map((c) => c.id),
      });
      visit(node.children, node.id);
    }
  }
  visit(structure, null);
  return out;
}

/**
 * HTTP-mode equivalent of serializeLayout: fetch the saved layout JSON for an
 * outline by parsing the lm-blocks `data-lm-root` attribute from the page HTML.
 */
async function fetchSavedLayout(ctx, outline) {
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '');
  const res = await ctx.fetch(url, { method: 'GET' });
  if (res.status >= 400) throw new Error(`Layout fetch ${res.status}: ${res.body.slice(0, 200)}`);
  // The data-lm-root attribute holds the layout JSON (HTML-escaped)
  const m = res.body.match(/data-lm-root="((?:[^"\\]|\\.)*)"/);
  if (!m) {
    throw new Error('data-lm-root not found in layout page HTML');
  }
  // Decode HTML entities (named + hex + decimal) and JSON parse
  const decoded = decodeHtmlEntities(m[1]);
  try {
    return JSON.parse(decoded);
  } catch (e) {
    throw new Error(`Could not parse data-lm-root JSON: ${e.message}`);
  }
}

/** Decode the entity escapes Joomla emits in attributes (named, hex, decimal). */
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
 * Save a new layout structure by POSTing directly to Gantry's save endpoint.
 *
 * Captured request shape (via DevTools network):
 *   POST  /administrator/index.php?option=com_gantry5&view=configurations/<outline>/layout&theme=<theme>&<token>=1&format=json
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: preset=<urlencoded preset JSON>&layout=<urlencoded layout array>
 *
 * Returns the JSON response Gantry sent back.
 */
/**
 * `pageOrCtx` accepts either a browser ctx (with .fetch) or a legacy Page —
 * we keep the older signature working for the dialog-flow callers.
 */
async function saveLayoutDirect(pageOrCtx, ctx, outline, structure) {
  // Determine which mode we're in
  const usingPage = pageOrCtx && typeof pageOrCtx.evaluate === 'function';
  const fetchFn = usingPage
    ? null // page mode — we'll inline the fetch via evaluate
    : pageOrCtx.fetch;

  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '') +
    `&format=json`;

  // Read the current preset metadata. Browser mode reads it from the live
  // page; HTTP mode fetches the layout page and parses data-lm-preset.
  let preset = '';
  if (usingPage) {
    preset = await pageOrCtx.evaluate(() => {
      const el = document.querySelector('.lm-blocks, [data-lm-preset]');
      return el?.getAttribute('data-lm-preset') || '';
    });
  } else {
    const layoutUrl =
      `${ctx.base}/administrator/index.php?option=com_gantry5` +
      `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
      `&theme=${encodeURIComponent(ctx.theme)}` +
      (ctx.token ? `&${ctx.token}=1` : '');
    const r = await fetchFn(layoutUrl, { method: 'GET' });
    const m = r.body.match(/data-lm-preset="((?:[^"\\]|\\.)*)"/);
    if (m) preset = decodeHtmlEntities(m[1]);
  }

  const body =
    'preset=' + encodeURIComponent(preset) +
    '&layout=' + encodeURIComponent(JSON.stringify(structure));

  let result;
  if (usingPage) {
    result = await pageOrCtx.evaluate(
      async (url, body) => {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body,
        });
        return { status: res.status, text: await res.text() };
      },
      url,
      body
    );
  } else {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    result = { status: r.status, text: r.body };
  }

  if (result.status >= 400) {
    throw new Error(`Save layout POST returned ${result.status}: ${result.text.slice(0, 400)}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.text);
  } catch {}
  if (!parsed) {
    throw new Error(`Save returned non-JSON (session expired or CSRF rejected): ${result.text.slice(0, 200)}`);
  }
  if (parsed.success === false) {
    throw new Error(`Save reported failure: ${parsed.error || result.text.slice(0, 400)}`);
  }
  return parsed;
}

/**
 * High-level helper: fetch current structure, mutate it, POST it to Gantry.
 *
 *   const ctx = await session.start({...});
 *   await openLayout(page, ctx, '75');
 *   await mutateLayout(page, ctx, '75', (structure) => {
 *     addParticleToSection(structure, 'expanded', 'blockcontent');
 *   }, { op: 'add' });
 *
 * Production-hardened defaults:
 *   - Auto-takes a backup before mutating.       Disable with { backup: false }
 *   - --dry-run mode prints diff and skips POST. Enable with { dryRun: true }
 *
 * Bypasses the Save Layout button entirely — POSTs directly to the layout
 * endpoint with the form-encoded body Gantry expects.
 */
/**
 * Three accepted calling conventions:
 *   1. (page, ctx, outline, mutator, opts)        — legacy browser
 *   2. (null|undefined, ctx, outline, mutator, opts) — legacy HTTP (page omitted)
 *   3. (ctx, outline, mutator, opts)              — new clean signature
 */
async function mutateLayout(arg1, arg2, arg3, arg4, arg5) {
  let ctx, outline, mutator, opts, page;
  if (arg1 && typeof arg1.evaluate === 'function') {
    // form 1
    page = arg1;
    ctx = arg2;
    outline = arg3;
    mutator = arg4;
    opts = arg5 || {};
  } else if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    // form 3
    ctx = arg1;
    outline = arg2;
    mutator = arg3;
    opts = arg4 || {};
    page = ctx?.page;
  } else {
    // form 2: page is null/undefined, args shift back by one
    page = arg1;
    ctx = arg2;
    outline = arg3;
    mutator = arg4;
    opts = arg5 || {};
    if (!page) page = ctx?.page;
  }
  const { op = 'mutate', backup: doBackup = true, dryRun = false } = opts;

  // Read current state — browser mode reads in-memory; HTTP fetches from disk
  let before;
  if (ctx?.mode === 'browser' && page) {
    before = await page.evaluate(() => window.G5.lm.builder.serialize());
  } else {
    before = await fetchSavedLayout(ctx, outline);
  }

  let backupPath = null;
  if (doBackup && !dryRun) {
    backupPath = backup.takeBackup(ctx, outline, op, before);
  }

  const after = JSON.parse(JSON.stringify(before));
  const result = mutator(after);

  if (dryRun) {
    const diff = diffStructures(before, after);
    return { structure: after, result, diff, dryRun: true };
  }

  // saveLayoutDirect is dual-mode: pass page in browser, ctx in http
  const saveTarget = ctx?.mode === 'browser' && page ? page : ctx;
  const resp = await saveLayoutDirect(saveTarget, ctx, outline, after);
  return { structure: after, result, resp, backupPath };
}

/**
 * Cheap-and-cheerful structural diff — flat lists of added / removed / changed.
 * Walks both trees, indexing nodes by id, and reports differences in a way
 * that's useful for a --dry-run summary.
 */
function diffStructures(before, after) {
  const flat = (root) => {
    const map = new Map();
    walk(root, (node) => {
      map.set(node.id, {
        id: node.id,
        type: node.type,
        subtype: node.subtype,
        title: node.title,
        attributes: node.attributes,
        inherit: node.inherit,
        size: node.attributes?.size,
      });
      return false;
    });
    return map;
  };
  const a = flat(before);
  const b = flat(after);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, node] of b) {
    if (!a.has(id)) {
      added.push(node);
      continue;
    }
    const old = a.get(id);
    const oldStr = JSON.stringify(old);
    const newStr = JSON.stringify(node);
    if (oldStr !== newStr) {
      changed.push({ id, type: node.type, before: old, after: node });
    }
  }
  for (const [id, node] of a) {
    if (!b.has(id)) removed.push(node);
  }
  return { added, removed, changed };
}

/**
 * Restore an outline to a saved backup structure (POSTs the JSON to the save
 * endpoint, just like a normal mutate).
 */
async function restoreLayout(page, ctx, outline, structure, opts = {}) {
  const { backup: doBackup = true } = opts;
  if (doBackup) {
    const before = await serializeLayout(page);
    backup.takeBackup(ctx, outline, 'pre-restore', before);
  }
  return saveLayoutDirect(page, ctx, outline, structure);
}

/**
 * Fetch the catalog of available presets (and other-outline copy targets) by
 * calling /configurations/<outline>/layout/switch&format=json and parsing the
 * dialog HTML. Returns:
 *   { presets: [{ name, title }], outlines: [{ id, title }] }
 *
 * The /switch endpoint is global within a theme — calling it on any outline
 * gives the same preset catalog.
 */
async function listAvailablePresets(arg1, arg2, arg3) {
  let ctx, outline;
  if (arg1 && typeof arg1.evaluate === 'function') {
    // (page, ctx, outline)
    ctx = arg2;
    outline = arg3;
  } else if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    // (ctx, outline)
    ctx = arg1;
    outline = arg2;
  } else {
    // (undefined-page, ctx, outline) — HTTP mode legacy callers
    ctx = arg2;
    outline = arg3;
  }
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout/switch')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '') +
    `&format=json`;
  const res = await ctx.fetch(url, { method: 'GET' });
  if (res.status >= 400) throw new Error(`switch endpoint returned ${res.status}`);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`switch response was not JSON: ${e.message}`);
  }
  const html = parsed.html || '';
  // Pull every <li> that carries a data-switch attribute (preset or outline copy)
  const items = html.match(/<li[\s\S]*?data-switch[\s\S]*?<\/li>/g) || [];
  const presets = [];
  const outlines = [];
  for (const item of items) {
    const url = (item.match(/data-switch="([^"]+)"/) || [])[1];
    if (!url) continue;
    const ariaLabel = (item.match(/aria-label="([^"]+)"/) || [])[1] || '';
    const innerText = (item
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim());
    const title = (ariaLabel || innerText).replace(/&amp;/g, '&').trim();
    const presetMatch = url.match(/\/preset\/([^&?"]+)/);
    if (presetMatch) {
      presets.push({ name: presetMatch[1], title });
      continue;
    }
    // Outline-copy items have URLs like /configurations/<id>/layout (no /preset/)
    const outlineMatch = url.match(/configurations\/([^/]+)\/layout/);
    if (outlineMatch) {
      outlines.push({ id: outlineMatch[1], title });
    }
  }
  return { presets, outlines };
}

/**
 * Load a built-in preset onto an outline:
 *   1. GET /configurations/<outline>/layout/preset/<presetName>&format=json
 *      → returns { preset: <json string>, data: <json string>, title }
 *   2. POST those fields back to /configurations/<outline>/layout&format=json
 *      so the layout is persisted.
 */
async function loadPresetByName(page, ctx, outline, presetName) {
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout/preset/' + presetName)}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '') +
    `&format=json`;

  // 1. Fetch the preset
  const res = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'same-origin' });
    return { status: r.status, body: await r.text() };
  }, url);
  if (res.status >= 400) throw new Error(`preset fetch returned ${res.status}: ${res.body.slice(0, 200)}`);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`preset response was not JSON: ${e.message}`);
  }
  if (parsed.success === false) {
    throw new Error(`preset fetch reported failure: ${parsed.message || res.body.slice(0, 200)}`);
  }
  if (!parsed.data) throw new Error(`preset response missing "data" field`);

  // 2. POST it as the new layout. preset and data are already JSON strings.
  const saveUrl =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '') +
    `&format=json`;

  const saveRes = await page.evaluate(
    async (u, preset, data) => {
      const body = 'preset=' + encodeURIComponent(preset) + '&layout=' + encodeURIComponent(data);
      const r = await fetch(u, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
      });
      return { status: r.status, body: await r.text() };
    },
    saveUrl,
    parsed.preset || '',
    parsed.data
  );
  if (saveRes.status >= 400) {
    throw new Error(`save returned ${saveRes.status}: ${saveRes.body.slice(0, 200)}`);
  }
  let saveParsed = null;
  try { saveParsed = JSON.parse(saveRes.body); } catch {}
  if (saveParsed && saveParsed.success === false) {
    throw new Error(`save reported failure: ${saveParsed.message || saveRes.body.slice(0, 200)}`);
  }
  return {
    preset: presetName,
    title: parsed.title || presetName,
    data: JSON.parse(parsed.data),
  };
}

/**
 * Copy the layout from `fromOutline` into `toOutline` in one browser session.
 * Single login, two navigations, one POST.
 *
 * Reuses openLayout from lib/layout to land on each page; the page's
 * window.G5.lm.builder is what we serialize from.
 */
async function copyLayoutFrom(page, ctx, fromOutline, toOutline, openLayoutFn) {
  // Source: navigate, serialize
  await openLayoutFn(page, ctx, fromOutline);
  const source = await serializeLayout(page);
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error(`Source outline "${fromOutline}" has no layout to copy.`);
  }
  // Target: navigate, POST
  await openLayoutFn(page, ctx, toOutline);
  const resp = await saveLayoutDirect(page, ctx, toOutline, source);
  return { source, resp };
}

module.exports = {
  // pure helpers
  walk,
  findNode,
  removeNode,
  makeParticleNode,
  makeBlockNode,
  makeGridNode,
  addParticleToSection,
  addParticleNextTo,
  moveParticleToSection,
  moveParticleNextTo,
  editParticleFromForm,
  editSectionAttrs,
  addSectionClasses,
  setNodeInherit,
  clearNodeInherit,
  clearLayout,
  // page-bound
  serializeLayout,
  saveLayoutDirect,
  mutateLayout,
  diffStructures,
  restoreLayout,
  copyLayoutFrom,
  listAvailablePresets,
  loadPresetByName,
  fetchSavedLayout,
  getLayoutStructure,
  listParticlesIn,
  listSectionsIn,
  dumpTreeIn,
};
