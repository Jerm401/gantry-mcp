#!/usr/bin/env node
'use strict';

/**
 * MCP server exposing the gantry CLI as Model Context Protocol tools.
 *
 * Run as a stdio server; an MCP client (Claude Desktop, Claude Code, etc.)
 * spawns this process and talks to it over JSON-RPC on stdin/stdout.
 *
 * Tools accept a `site` argument (URL of the Joomla install). Sessions are
 * cached per-site so an LLM can run dozens of operations without paying the
 * login cost each time.
 */

require('dotenv').config();

const http = require('http');
const { randomUUID } = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const session = require('./lib/session');
const layout = require('./lib/layout');
const layoutApi = require('./lib/layout-api');
const outlines = require('./lib/outlines');
const styles = require('./lib/styles');
const pageMod = require('./lib/page');
const backup = require('./lib/backup');

/* ---------------------------- session cache --------------------------- */

const ctxCache = new Map(); // siteUrl -> { ctx, lastUsed }
const CTX_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getCtx(args) {
  const site = args.site;
  if (!site) throw new Error('Missing required argument: site');
  const key = `${site}|${args.theme || ''}`;
  const cached = ctxCache.get(key);
  if (cached && Date.now() - cached.lastUsed < CTX_TTL_MS) {
    cached.lastUsed = Date.now();
    return cached.ctx;
  }
  // Need a fresh ctx
  if (cached) {
    try { await cached.ctx.close?.(); } catch {}
    ctxCache.delete(key);
  }
  const ctx = await session.start({
    mode: 'http',
    site,
    user: args.user,
    pass: args.pass,
    themeName: args.theme,
  });
  ctxCache.set(key, { ctx, lastUsed: Date.now() });
  return ctx;
}

/** Drop the cached ctx for a site (e.g. on auth failure). */
function invalidateCtx(site, theme = '') {
  const key = `${site}|${theme}`;
  const cached = ctxCache.get(key);
  if (cached) {
    cached.ctx.close?.().catch(() => {});
    ctxCache.delete(key);
  }
}

/* --------------------------- tool definitions ------------------------- */

// Common pieces of input schema we reuse
const SITE_FIELD = {
  site: {
    type: 'string',
    description: 'Joomla site URL (e.g. https://example.com). Credentials come from .env.',
  },
};
const SITE_THEME_FIELDS = {
  ...SITE_FIELD,
  theme: { type: 'string', description: 'Theme directory (default: studius/rt_studius)' },
};
const OUTLINE_FIELD = {
  outline: { type: 'string', description: 'Outline id (e.g. "default", "33", "75")', default: 'default' },
};

const TOOLS = [
  /* Outlines */
  {
    name: 'gantry_outlines_list',
    description:
      'List every outline (configuration) defined for the theme. Returns id, title, and isDefault flag for each. Outline id is what you pass as `outline` to all the layout commands.',
    schema: { type: 'object', properties: SITE_THEME_FIELDS, required: ['site'] },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await outlines.openOutlines(ctx);
      return outlines.listOutlines(ctx);
    },
  },
  {
    name: 'gantry_outlines_duplicate',
    description:
      'Duplicate an existing outline. Pass --no-inherit-equivalent (inherit:false) to deep-clone children rather than reference them. Returns the server response (which includes the new outline id when available).',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        sourceId: { type: 'string', description: 'Outline to duplicate' },
        title: { type: 'string', description: 'Optional new outline title (auto-generated if blank)' },
        inherit: { type: 'boolean', description: 'When false, clones children instead of inheriting (default: true)' },
      },
      required: ['site', 'sourceId'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      return outlines.duplicateOutline(ctx, args.sourceId, {
        title: args.title,
        inherit: args.inherit,
      });
    },
  },
  {
    name: 'gantry_outlines_delete',
    description: 'Delete an outline. Cannot be undone (outlines have no backup). Pass `ids` (array) to delete several.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        id: { type: 'string', description: 'Outline id to delete' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Multiple outline ids' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const ids = [...(args.ids || []), ...(args.id ? [args.id] : [])];
      const results = [];
      for (const id of ids) {
        try {
          await outlines.deleteOutline(ctx, id);
          results.push({ id, deleted: true });
        } catch (err) {
          results.push({ id, deleted: false, error: err.message });
        }
      }
      return results;
    },
  },

  /* Layout — read */
  {
    name: 'gantry_layout_list',
    description:
      'List every editable particle/system/spacer/position in an outline\'s layout. Returns id, type, subtype, title, sectionId, inherited flag, disabled flag.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        editable: { type: 'boolean', description: 'Skip inherited and disabled particles (default: false)' },
        includeBlocks: { type: 'boolean', description: 'Include wrapper block nodes (rarely useful)' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const structure = await layoutApi.getLayoutStructure(ctx, args.outline || 'default');
      return layoutApi.listParticlesIn(structure, {
        onlyEditable: !!args.editable,
        includeBlocks: !!args.includeBlocks,
      });
    },
  },
  {
    name: 'gantry_layout_tree',
    description:
      'Return the full nested tree of containers / sections / grids / blocks / particles for an outline. Useful for understanding structure before editing.',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const structure = await layoutApi.getLayoutStructure(ctx, args.outline || 'default');
      return layoutApi.dumpTreeIn(structure);
    },
  },
  {
    name: 'gantry_layout_sections',
    description:
      'List the stable section ids for an outline (top, navigation, header, expanded, footer, etc.). These are the valid `to` targets for layout_add and layout_move.',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const structure = await layoutApi.getLayoutStructure(ctx, args.outline || 'default');
      return layoutApi.listSectionsIn(structure);
    },
  },
  {
    name: 'gantry_layout_presets',
    description: 'List Gantry\'s built-in layout presets (default, fullwidth, left_sidebar, …) that can be applied via layout_load_preset.',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const { presets } = await layoutApi.listAvailablePresets(ctx, args.outline || 'default');
      return presets;
    },
  },

  /* Layout — write */
  {
    name: 'gantry_layout_add',
    description:
      'Add a particle / position / spacer / system node to a section. Either drop into a section as a new full-width row (`to`) or place beside an existing particle (`nextTo`). The standard Studius particle subtypes include: blockcontent, custom, gridstatistic, image, contentarray, logo, menu, mobile-menu, pricingtable, search, simplecontent, slider, social, swiper, timeline, totop, video. Positions: module, position. Spacer: spacer. System: content, messages.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        type: { type: 'string', enum: ['particle', 'position', 'spacer', 'system'], default: 'particle' },
        subtype: { type: 'string', description: 'Subtype name from layout_available' },
        to: { type: 'string', description: 'Target section id (e.g. expanded, navigation)' },
        nextTo: { type: 'string', description: 'Place next to this existing particle id' },
        size: { type: 'number', description: 'Width % when using nextTo (default: equal split)' },
        title: { type: 'string', description: 'Display title for the new particle' },
        mode: { type: 'string', enum: ['newGrid', 'firstGrid'], default: 'newGrid' },
        dryRun: { type: 'boolean', description: 'Show the diff and skip the save POST' },
      },
      required: ['site', 'subtype'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      let added;
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => {
          if (args.nextTo) {
            added = layoutApi.addParticleNextTo(structure, args.nextTo, args.type || 'particle', args.subtype, {
              title: args.title,
              size: args.size,
            });
          } else if (args.to) {
            added = layoutApi.addParticleToSection(structure, args.to, args.type || 'particle', args.subtype, {
              title: args.title,
              mode: args.mode || 'newGrid',
            });
          } else {
            throw new Error('Pass `to` (section) or `nextTo` (sibling particle id)');
          }
        },
        { op: 'add', dryRun: !!args.dryRun }
      );
      return { added, dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_move',
    description: 'Move a particle to another section, or place it next to another particle.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Particle id to move' },
        to: { type: 'string', description: 'Target section id' },
        nextTo: { type: 'string', description: 'Sibling particle id' },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => {
          if (args.nextTo) layoutApi.moveParticleNextTo(structure, args.id, args.nextTo);
          else if (args.to) layoutApi.moveParticleToSection(structure, args.id, args.to);
          else throw new Error('Pass `to` or `nextTo`');
        },
        { op: 'move', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_remove',
    description: 'Remove one or more particles from a layout.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Particle id to remove' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Multiple particle ids' },
        dryRun: { type: 'boolean' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const ids = [...(args.ids || []), ...(args.id ? [args.id] : [])];
      const removed = [];
      const missing = [];
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => {
          for (const id of ids) {
            const got = layoutApi.removeNode(structure, id);
            (got ? removed : missing).push(id);
          }
        },
        { op: 'remove', dryRun: !!args.dryRun }
      );
      return { removed, missing, dryRun: !!r.dryRun, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_edit',
    description:
      'Edit a particle\'s settings via JSON-patch. Pass `edits` as a flat map of form-field names → values, e.g.:\n  {"particles[contentarray][title]": "News", "block[size]": 50, "inherit[mode]": "clone"}',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Particle id' },
        edits: {
          type: 'object',
          additionalProperties: true,
          description: 'Map of "particles[type][...]" / "block[...]" / "inherit[...]" form names to values',
        },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id', 'edits'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.editParticleFromForm(structure, args.id, args.edits),
        { op: 'edit', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_section_edit',
    description: 'Patch a section\'s attributes (boxed, class, variations, etc.). Pass attrs as a flat object.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Section id (e.g. expanded, navigation)' },
        attrs: { type: 'object', additionalProperties: true },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id', 'attrs'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.editSectionAttrs(structure, args.id, args.attrs),
        { op: 'section-edit', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_section_inherit',
    description: 'Make a section inherit from another outline (from), with optional include parts (children, attributes, block).',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string' },
        from: { type: 'string', description: 'Source outline (e.g. "default")' },
        include: { type: 'array', items: { type: 'string' }, default: ['children', 'attributes'] },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id', 'from'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const inherit = { outline: args.from, include: args.include || ['children', 'attributes'] };
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.setNodeInherit(structure, args.id, inherit),
        { op: 'section-inherit', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null };
    },
  },
  {
    name: 'gantry_layout_section_clone',
    description: 'Break inheritance on a section (clears the inherit field).',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD, id: { type: 'string' }, dryRun: { type: 'boolean' } },
      required: ['site', 'id'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.clearNodeInherit(structure, args.id),
        { op: 'section-clone', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null };
    },
  },
  {
    name: 'gantry_layout_clear',
    description: 'Wipe an outline\'s layout. mode "full" empties everything; "keep-inheritance" preserves nodes that have an inherit set.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        mode: { type: 'string', enum: ['full', 'keep-inheritance'], default: 'full' },
        dryRun: { type: 'boolean' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.clearLayout(structure, args.mode || 'full'),
        { op: 'clear-' + (args.mode || 'full'), dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_copy_from',
    description: 'Copy the entire layout from one outline into another. Auto-backs up the target before overwriting.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        from: { type: 'string', description: 'Source outline id' },
        to: { type: 'string', description: 'Target outline id' },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'from', 'to'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const source = await layoutApi.fetchSavedLayout(ctx, args.from);
      if (!source.length) throw new Error(`Source outline ${args.from} has no layout`);
      const before = await layoutApi.fetchSavedLayout(ctx, args.to);
      const diff = layoutApi.diffStructures(before, source);
      if (args.dryRun) return { dryRun: true, diff };
      const backupPath = backup.takeBackup(ctx, args.to, `copy-from-${args.from}`, before);
      await layoutApi.saveLayoutDirect(ctx, ctx, args.to, source);
      return { copied: true, backupPath };
    },
  },
  {
    name: 'gantry_layout_load_preset',
    description: 'Apply a built-in Gantry preset (see layout_presets) to an outline. Auto-backed-up.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        preset: { type: 'string', description: 'Preset name (e.g. fullwidth, default, left_sidebar)' },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'preset'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = args.outline || 'default';
      // Fetch preset payload
      const url =
        `${ctx.base}/administrator/index.php` +
        `?option=com_gantry5` +
        `&view=${encodeURIComponent('configurations/' + outline + '/layout/preset/' + args.preset)}` +
        `&theme=${encodeURIComponent(ctx.theme)}` +
        (ctx.token ? `&${ctx.token}=1` : '') +
        '&format=json';
      const fetched = await ctx.fetch(url, { method: 'GET' });
      if (fetched.status >= 400) throw new Error(`Preset fetch ${fetched.status}`);
      const parsed = JSON.parse(fetched.body);
      if (parsed.success === false) throw new Error('Preset failed: ' + (parsed.message || ''));
      const newLayout = JSON.parse(parsed.data);
      const before = await layoutApi.fetchSavedLayout(ctx, outline);
      const diff = layoutApi.diffStructures(before, newLayout);
      if (args.dryRun) return { dryRun: true, diff, title: parsed.title };
      const backupPath = backup.takeBackup(ctx, outline, `pre-load-preset-${args.preset}`, before);
      // Use the same form-encoded body shape Gantry expects
      const saveUrl =
        `${ctx.base}/administrator/index.php?option=com_gantry5` +
        `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
        `&theme=${encodeURIComponent(ctx.theme)}` +
        (ctx.token ? `&${ctx.token}=1` : '') +
        '&format=json';
      const body =
        'preset=' + encodeURIComponent(parsed.preset || '') +
        '&layout=' + encodeURIComponent(parsed.data);
      const saveRes = await ctx.fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
      });
      if (saveRes.status >= 400) throw new Error(`Save ${saveRes.status}`);
      return { applied: true, preset: args.preset, title: parsed.title, backupPath };
    },
  },

  /* Backups & undo */
  {
    name: 'gantry_layout_backups_list',
    description: 'List automatic layout backups for an outline (newest first).',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      return backup.listBackups(ctx, args.outline || 'default').map((b) => ({
        name: b.name,
        size: b.size,
        mtime: b.mtime.toISOString(),
        path: b.path,
      }));
    },
  },
  {
    name: 'gantry_layout_undo',
    description: 'Restore the most recent layout backup for an outline. Takes a fresh backup before reverting (so you can re-undo).',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const file = backup.resolveBackup(ctx, args.outline || 'default', 'latest');
      const structure = backup.readBackup(file);
      const before = await layoutApi.fetchSavedLayout(ctx, args.outline || 'default');
      const preBackup = backup.takeBackup(ctx, args.outline || 'default', 'pre-restore', before);
      await layoutApi.saveLayoutDirect(ctx, ctx, args.outline || 'default', structure);
      return { restoredFrom: file, preRestoreBackup: preBackup };
    },
  },

  /* Styles & Page settings */
  {
    name: 'gantry_styles_list',
    description: 'List every style field of an outline (colors, fonts, breakpoints, etc.) with its current value.',
    schema: { type: 'object', properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD }, required: ['site'] },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await styles.openStyles(ctx, args.outline || 'default');
      return styles.listStyles(ctx);
    },
  },
  {
    name: 'gantry_styles_edit',
    description:
      'Edit theme style fields. Pass edits as a flat map, e.g. { "styles[base][background]": "#fafafa", "styles[font][family-title]": "Roboto" }.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        edits: { type: 'object', additionalProperties: true },
      },
      required: ['site', 'edits'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await styles.openStyles(ctx, args.outline || 'default');
      await styles.editStyles(ctx, args.edits);
      await styles.saveStyles(ctx);
      return { saved: Object.keys(args.edits) };
    },
  },
  {
    name: 'gantry_page_list',
    description: 'List every per-outline Page Settings field with its current value (favicon, body class/id, head_bottom, body_top/body_bottom, fontawesome).',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        all: { type: 'boolean', description: 'Include hidden _json aggregator fields' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await pageMod.openPage(ctx, args.outline || 'default');
      return pageMod.listPage(ctx, { all: !!args.all });
    },
  },
  {
    name: 'gantry_page_edit',
    description:
      'Edit Page Settings. Pass edits as a flat map, e.g. { "page[body][attribs][class]": "site-sub", "page[assets][favicon]": "gantry-media://template/favicon.png" }.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        edits: { type: 'object', additionalProperties: true },
      },
      required: ['site', 'edits'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await pageMod.openPage(ctx, args.outline || 'default');
      await pageMod.editPage(ctx, args.edits);
      await pageMod.savePage(ctx);
      return { saved: Object.keys(args.edits) };
    },
  },

  /* Export / Import */
  {
    name: 'gantry_layout_export',
    description: 'Return the full layout structure (JSON) for an outline. The LLM can save this, modify it, or pass it to layout_import.',
    schema: { type: 'object', properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD }, required: ['site'] },
    handler: async (args) => {
      const ctx = await getCtx(args);
      return await layoutApi.fetchSavedLayout(ctx, args.outline || 'default');
    },
  },
  {
    name: 'gantry_layout_import',
    description: 'Apply a previously-exported layout structure to a target outline. Auto-backed-up.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        layout: {
          type: 'array',
          items: { type: 'object' },
          description: 'Layout structure (array of node objects) from gantry_layout_export',
        },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'layout'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const before = await layoutApi.fetchSavedLayout(ctx, args.outline || 'default');
      const diff = layoutApi.diffStructures(before, args.layout);
      if (args.dryRun) return { dryRun: true, diff };
      const backupPath = backup.takeBackup(ctx, args.outline || 'default', 'pre-import', before);
      await layoutApi.saveLayoutDirect(ctx, ctx, args.outline || 'default', args.layout);
      return { imported: true, backupPath };
    },
  },
];

/* --------------------------- server bootstrap ------------------------- */

function buildServer() {
  const srv = new Server(
    { name: 'gantry5-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.schema,
    })),
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      };
    }
    try {
      const result = await tool.handler(request.params.arguments || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (/401|403|login|cookie|session expired|csrf/i.test(err.message || '')) {
        const args = request.params.arguments || {};
        invalidateCtx(args.site, args.theme || '');
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
      };
    }
  });

  return srv;
}

// Ensure cached ctxs get cleaned up on shutdown
async function shutdown() {
  for (const { ctx } of ctxCache.values()) {
    await ctx.close?.().catch(() => {});
  }
  ctxCache.clear();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  const rawPort = process.env.HTTP_PORT || process.env.PORT;
  const httpPort = rawPort ? parseInt(rawPort, 10) : null;

  if (httpPort) {
    const authToken = process.env.MCP_AUTH_TOKEN || null;
    const sessions = new Map();

    const httpServer = http.createServer(async (req, res) => {
      if (authToken) {
        const auth = req.headers['authorization'] || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (provided !== authToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      try {
        const sessionId = req.headers['mcp-session-id'];
        let transport = sessionId ? sessions.get(sessionId) : null;

        if (!transport) {
          const srv = buildServer();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => sessions.set(id, transport),
          });
          await srv.connect(transport);
        }

        await transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
        }
      }
    });

    await new Promise((resolve) => httpServer.listen(httpPort, resolve));
    process.stderr.write(`gantry5-mcp ready (HTTP port ${httpPort})\n`);
  } else {
    const srv = buildServer();
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    process.stderr.write('gantry5-mcp ready (stdio)\n');
  }
})();
