#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { Command } = require('commander');
const session = require('./lib/session');
const layout = require('./lib/layout');
const menu = require('./lib/menu');
const styles = require('./lib/styles');
const outlines = require('./lib/outlines');
const pageMod = require('./lib/page');
const layoutApi = require('./lib/layout-api');
const backup = require('./lib/backup');

const program = new Command();
program
  .name('gantry')
  .description('Puppeteer automation for Joomla + Gantry 5 (Studius)')
  .option('-s, --site <url>', 'Joomla site URL (https://example.com)')
  .option('-t, --theme <name>', 'Gantry theme directory (defaults to studius/rt_studius)', process.env.GANTRY_THEME || 'studius')
  .option('-u, --user <name>', 'Admin username (overrides env)')
  .option('-p, --pass <password>', 'Admin password (overrides env)')
  .option('--headless', 'Run browser headless (visible by default) — only relevant with --browser')
  .option('--keep-open', 'Leave the browser open after the command finishes — only relevant with --browser')
  .option('--browser', 'Use Puppeteer instead of pure HTTP (slower, but enables --via-dialog and DOM-based diagnostics)')
  .option('--dry-run', 'Layout mutations: show the diff, skip the save POST')
  .option('--no-backup', 'Skip the auto-backup snapshot before mutating layouts')
  .option('--sites <csvUrls>', 'Comma-separated list of site URLs — fan-out the command to each')
  .option('--sites-file <path>', 'JSON file with [{site, user?, pass?, theme?}] entries')
  .option('--fail-fast', 'When using --sites/--sites-file: abort on first failure (default: continue)');

/** Parse `key=value` pairs from CLI variadic args, coercing booleans. */
function parsePairs(arr = []) {
  const out = {};
  for (const p of arr) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i);
    let v = p.slice(i + 1);
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    out[k] = v;
  }
  return out;
}

/** Format a layout-api diff as a compact summary printed to stdout. */
function printLayoutDiff(diff) {
  if (!diff) return;
  const { added = [], removed = [], changed = [] } = diff;
  if (!added.length && !removed.length && !changed.length) {
    console.log('  (no changes)');
    return;
  }
  for (const n of added) {
    console.log(`  + ${n.type}/${n.subtype || ''} ${n.id}` + (n.title ? ` "${n.title}"` : ''));
  }
  for (const n of removed) {
    console.log(`  - ${n.type}/${n.subtype || ''} ${n.id}` + (n.title ? ` "${n.title}"` : ''));
  }
  for (const c of changed) {
    const before = JSON.stringify(c.before.attributes || {});
    const after = JSON.stringify(c.after.attributes || {});
    console.log(`  ~ ${c.type} ${c.id}`);
    if (before !== after) console.log(`      attrs: ${before}  ->  ${after}`);
    if (JSON.stringify(c.before.inherit) !== JSON.stringify(c.after.inherit)) {
      console.log(`      inherit: ${JSON.stringify(c.before.inherit)} -> ${JSON.stringify(c.after.inherit)}`);
    }
  }
}

/** Common mutateLayout opts derived from the global flags. */
function mutateOpts(opts, op) {
  return {
    op,
    backup: opts.backup !== false, // commander sets to false on --no-backup
    dryRun: !!opts.dryRun,
  };
}

/**
 * Resolve the list of sites to operate against.
 *
 * Priority:
 *   1. --sites-file <path>    — JSON array [{site, user?, pass?, theme?}, ...]
 *   2. --sites <csvUrls>      — comma-separated site URLs (creds come from env)
 *   3. --site <url>           — single site (back-compat)
 *
 * Returns an array of {site, user?, pass?, theme?}.
 */
function resolveSites(opts) {
  const fs = require('fs');
  if (opts.sitesFile) {
    // Tolerate JSONC: strip /* */ block comments, // line comments, and
    // trailing commas before parsing.
    let text = fs.readFileSync(opts.sitesFile, 'utf8');
    text = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([,\{\[]\s*)\/\/.*$/gm, '$1')
      .replace(/,(\s*[\]}])/g, '$1');
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`Could not parse ${opts.sitesFile}: ${err.message}`);
    }
    if (!Array.isArray(raw) || !raw.length) {
      throw new Error(`sites-file ${opts.sitesFile} must be a non-empty JSON array`);
    }
    return raw.map((entry) => {
      if (typeof entry === 'string') return { site: entry };
      if (!entry.site) throw new Error('sites-file entry missing required "site" field');
      return entry;
    });
  }
  if (opts.sites) {
    return opts.sites
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((site) => ({ site }));
  }
  if (opts.site) return [{ site: opts.site, user: opts.user, pass: opts.pass, theme: opts.theme }];
  return [];
}

/** Wrap a body so it always opens a session and tears it down — multi-site aware. */
function withSession(body) {
  return async function handler(...handlerArgs) {
    const command = handlerArgs[handlerArgs.length - 1];
    const args = handlerArgs.slice(0, -1);
    const opts = { ...program.opts(), ...command.opts() };

    let sites;
    try {
      sites = resolveSites(opts);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    if (!sites.length) {
      console.error('Error: pass --site, --sites, or --sites-file.');
      process.exit(1);
    }

    const isMulti = sites.length > 1;
    const failures = [];
    const successes = [];
    for (const target of sites) {
      if (isMulti) {
        console.log(`\n${'='.repeat(70)}\n  ${target.site}\n${'='.repeat(70)}`);
      }
      let ctx;
      try {
        ctx = await session.start({
          mode: opts.browser ? 'browser' : 'http',
          site: target.site,
          headless: opts.headless,
          user: target.user || opts.user,
          pass: target.pass || opts.pass,
          themeName: target.theme || opts.theme,
        });
        await body(ctx, args, opts);
        successes.push(target.site);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error(`[${target.site}] Command failed: ${msg}`);
        failures.push({ site: target.site, error: msg });
        process.exitCode = 1;
        if (opts.failFast) {
          if (ctx && !opts.keepOpen) await ctx.close?.().catch(() => {});
          break;
        }
      } finally {
        if (ctx && !opts.keepOpen) await ctx.close?.().catch(() => {});
      }
    }

    if (isMulti) {
      console.log(`\n${'='.repeat(70)}\n  Summary: ${successes.length} ok, ${failures.length} failed (of ${sites.length})\n${'='.repeat(70)}`);
      for (const f of failures) console.log(`  ✗ ${f.site} — ${f.error}`);
    }
  };
}

// ---------- login ----------
program
  .command('login')
  .description('Smoke test: log in, click Studius Configure, capture token.')
  .action(
    withSession(async (ctx) => {
      console.log(`Logged in. Theme: ${ctx.theme}  Token: ${ctx.token || '(none)'}`);
    })
  );

// ---------- outlines ----------
const outlineCmd = program.command('outlines').description('Outlines (configurations)');
outlineCmd
  .command('list')
  .description('List all outlines defined in this theme')
  .action(
    withSession(async (ctx) => {
      const { page } = ctx;
      await outlines.openOutlines(page, ctx);
      const list = await outlines.listOutlines(page || ctx);
      // Trim long URLs for terminal display
      console.table(
        list.map((o) => ({ id: o.id, title: o.title, isDefault: o.isDefault }))
      );
      console.log(`(${list.length} outlines)`);
    })
  );

outlineCmd
  .command('delete')
  .description('Delete one or more outlines (use with care — there is no undo for outlines)')
  .option('--id <outlineId>', 'Outline id to delete (pass multiple times for batch)', (v, prev) => (prev || []).concat(v), [])
  .option('--ids <csvIds>', 'Comma-separated outline ids')
  .action(
    withSession(async (ctx, _args, opts) => {
      const ids = [...(opts.id || [])];
      if (opts.ids) ids.push(...opts.ids.split(',').map((s) => s.trim()).filter(Boolean));
      if (!ids.length) {
        console.error('Error: pass --id or --ids');
        process.exit(1);
      }
      for (const id of ids) {
        try {
          await outlines.deleteOutline(ctx, id);
          console.log(`Deleted outline ${id}.`);
        } catch (err) {
          console.error(`Failed to delete ${id}: ${err.message}`);
        }
      }
    })
  );

outlineCmd
  .command('duplicate')
  .description('Duplicate an existing outline')
  .requiredOption('--id <id>', 'Outline id (e.g. default, 32, 71)')
  .option('--title <name>', 'Title for the new outline (default: auto-generated)')
  .option('--no-inherit', 'Clone children instead of inheriting from the source outline')
  .action(
    withSession(async (ctx, _args, opts) => {
      await outlines.duplicateOutline(ctx, opts.id, {
        title: opts.title,
        inherit: opts.inherit, // commander sets to false when --no-inherit is passed
      });
      console.log(`Duplicated outline ${opts.id}${opts.title ? ` as "${opts.title}"` : ''}.`);
    })
  );

// ---------- layout ----------
const layoutCmd = program.command('layout').description('Layout Manager');

layoutCmd
  .command('list')
  .description('List particles in an outline')
  .option('-o, --outline <name>', 'Outline slug', 'default')
  .option('--editable', 'Skip inherited and disabled particles')
  .option('--include-blocks', 'Include wrapper blocks in output (rarely useful)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const structure = await layoutApi.getLayoutStructure(ctx, opts.outline);
      if (!structure || !structure.length) {
        console.log('(no layout — run `layout load-preset` first or copy from another outline)');
        return;
      }
      console.table(
        layoutApi.listParticlesIn(structure, {
          onlyEditable: !!opts.editable,
          includeBlocks: !!opts.includeBlocks,
        })
      );
    })
  );

layoutCmd
  .command('available')
  .description('List every particle/position/spacer/system available in the picker')
  .option('-o, --outline <name>', 'Outline (any one — picker is the same for all)', 'default')
  .option('--enabled', 'Hide entries flagged disabled')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      await layout.openLayout(page, ctx, opts.outline);
      let rows = await layout.listAvailableParticles(page);
      if (opts.enabled) rows = rows.filter((r) => !r.disabled);
      console.table(rows);
    })
  );

layoutCmd
  .command('fields')
  .description('Open a particle\'s settings dialog and dump every form field')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--id <particleId>', 'Particle id (use `layout list` to find one)')
  .option('--values', 'Show current values (default: true)', true)
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      await layout.openLayout(page, ctx, opts.outline);
      const fields = await layout.inspectParticleFields(page, opts.id);
      // Trim long values + option lists for display
      const trimmed = fields.map((f) => ({
        name: f.name,
        type: f.type,
        value: typeof f.value === 'string' && f.value.length > 60 ? f.value.slice(0, 60) + '…' : f.value,
        options: f.options ? f.options.map((o) => o.value).join('|').slice(0, 60) : '',
      }));
      console.table(trimmed);
      console.log(`(${fields.length} fields)`);
    })
  );

layoutCmd
  .command('sections')
  .description('List the stable section ids — use these as the --to target for add/move')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const structure = await layoutApi.getLayoutStructure(ctx, opts.outline);
      console.table(layoutApi.listSectionsIn(structure));
    })
  );

layoutCmd
  .command('tree')
  .description('Dump the layout container tree (sections > grids > blocks > particles)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const structure = await layoutApi.getLayoutStructure(ctx, opts.outline);
      const tree = layoutApi.dumpTreeIn(structure);
      const byParent = new Map();
      tree.forEach((n) => {
        if (!byParent.has(n.parent)) byParent.set(n.parent, []);
        byParent.get(n.parent).push(n);
      });
      const visit = (parent, depth) => {
        (byParent.get(parent) || []).forEach((n) => {
          console.log('  '.repeat(depth) + `[${n.type || '?'}] ${n.id}`);
          visit(n.id, depth + 1);
        });
      };
      visit(null, 0);
    })
  );

layoutCmd
  .command('move')
  .description('Move a particle to another section, or next to another particle')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--id <particleId>', 'Source particle id')
  .option('--to <sectionId>', 'Target section id (drops in a new full-width grid)')
  .option('--next-to <particleId>', 'Place in the same grid as this particle (auto-resize)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      if (!opts.to && !opts.nextTo) {
        console.error('Error: pass --to <sectionId> or --next-to <particleId>.');
        process.exit(1);
      }
      await layout.openLayout(page, ctx, opts.outline);
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => {
          if (opts.nextTo) {
            layoutApi.moveParticleNextTo(structure, opts.id, opts.nextTo);
          } else {
            layoutApi.moveParticleToSection(structure, opts.id, opts.to);
          }
        },
        mutateOpts(opts, 'move')
      );
      const where = opts.nextTo ? `next to ${opts.nextTo}` : `to section ${opts.to}`;
      if (r.dryRun) {
        console.log(`[dry-run] Would move ${opts.id} ${where}:`);
        printLayoutDiff(r.diff);
      } else {
        console.log(`Moved ${opts.id} ${where}.${r.backupPath ? ' (backup: ' + r.backupPath + ')' : ''}`);
      }
    })
  );

layoutCmd
  .command('add')
  .description('Add a node to a section via the layout-JSON API (no drag)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .option('--type <blocktype>', 'particle (default) | position | spacer | system', 'particle')
  .requiredOption('--subtype <subtype>', 'Subtype as shown in `layout available` (e.g. blockcontent, custom, content, messages, module)')
  .option('--to <sectionId>', 'Target section id (e.g. expanded, navigation)')
  .option('--next-to <particleId>', 'Place as a sibling of an existing particle (same row, auto-resize)')
  .option('--size <pct>', 'Width % for the new block when using --next-to (default: equal split)', (v) => Number(v))
  .option('--mode <mode>', 'For --to: newGrid (default, new row) | firstGrid (append into first grid)', 'newGrid')
  .option('--title <name>', 'Display title')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      if (!opts.to && !opts.nextTo) {
        console.error('Error: pass --to <sectionId> or --next-to <particleId>.');
        process.exit(1);
      }
      await layout.openLayout(page, ctx, opts.outline);
      let added;
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => {
          if (opts.nextTo) {
            added = layoutApi.addParticleNextTo(
              structure,
              opts.nextTo,
              opts.type,
              opts.subtype,
              { title: opts.title, size: opts.size }
            );
          } else {
            added = layoutApi.addParticleToSection(
              structure,
              opts.to,
              opts.type,
              opts.subtype,
              { title: opts.title, mode: opts.mode }
            );
          }
        },
        mutateOpts(opts, 'add')
      );
      const where = opts.nextTo ? `next to ${opts.nextTo}` : `in section ${opts.to}`;
      if (r.dryRun) {
        console.log(`[dry-run] Would add ${opts.type}/${opts.subtype} (${added.id}) ${where}:`);
        printLayoutDiff(r.diff);
      } else {
        console.log(`Added ${opts.type}/${opts.subtype} (${added.id}) ${where}.${r.backupPath ? ' (backup: ' + r.backupPath + ')' : ''}`);
      }
    })
  );

layoutCmd
  .command('remove')
  .description('Remove one or more particles via the layout-JSON API (single save)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .option(
    '--id <particleId>',
    'Particle id (pass multiple times for batch removal)',
    (v, prev) => (prev || []).concat(v),
    []
  )
  .option('--ids <csvIds>', 'Comma-separated list of particle ids')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      const ids = [...(opts.id || [])];
      if (opts.ids) ids.push(...opts.ids.split(',').map((s) => s.trim()).filter(Boolean));
      if (!ids.length) {
        console.error('Error: pass --id or --ids');
        process.exit(1);
      }
      await layout.openLayout(page, ctx, opts.outline);
      const removedIds = [];
      const missing = [];
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => {
          for (const id of ids) {
            const removed = layoutApi.removeNode(structure, id);
            if (removed) removedIds.push(id);
            else missing.push(id);
          }
          if (!removedIds.length) {
            throw new Error(`None of the ids were found: ${ids.join(', ')}`);
          }
        },
        mutateOpts(opts, 'remove')
      );
      if (r.dryRun) {
        console.log(`[dry-run] Would remove: ${removedIds.join(', ')}`);
        if (missing.length) console.log(`           Not found: ${missing.join(', ')}`);
        printLayoutDiff(r.diff);
      } else {
        console.log(`Removed: ${removedIds.join(', ')}${r.backupPath ? ' (backup: ' + r.backupPath + ')' : ''}`);
        if (missing.length) console.warn(`Not found: ${missing.join(', ')}`);
      }
    })
  );

layoutCmd
  .command('edit')
  .description('Edit a particle\'s settings (field=value pairs) — JSON-patch path by default; auto-backup + dry-run aware')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--id <particleId>', 'Particle id')
  .option('--via-dialog', 'Open the Gantry dialog and click Apply and Save (slower; uses Gantry validation)')
  .option('--dialog-mode <mode>', 'For --via-dialog: applyAndSave | apply | cancel', 'applyAndSave')
  .argument('[fields...]', 'name=value pairs (e.g. particles[contentarray][title]="Foo" block[size]=50)')
  .action(
    withSession(async (ctx, args, opts) => {
      const { page } = ctx;
      const edits = parsePairs(args[0] || []);
      await layout.openLayout(page, ctx, opts.outline);

      if (opts.viaDialog) {
        // Old path — dialog. No auto-backup (Gantry handles it server-side).
        await layout.editParticle(page, opts.id, edits, opts.dialogMode);
        if (opts.dialogMode !== 'applyAndSave' && opts.dialogMode !== 'cancel') {
          await layout.saveLayout(page);
        }
        console.log('Edited via dialog:', edits, `(mode: ${opts.dialogMode})`);
        return;
      }

      // JSON-patch path: routes through mutateLayout → auto-backup + --dry-run support
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => layoutApi.editParticleFromForm(structure, opts.id, edits),
        mutateOpts(opts, 'edit')
      );
      if (r.dryRun) {
        console.log('[dry-run] Would edit', opts.id, edits);
        printLayoutDiff(r.diff);
      } else {
        console.log(`Edited ${opts.id}:`, edits, r.backupPath ? `(backup: ${r.backupPath})` : '');
      }
    })
  );

// ---------- section ops ----------
const sectionCmd = layoutCmd
  .command('section')
  .description('Operate on a section/container by id (expanded, navigation, footer, …)');

sectionCmd
  .command('edit')
  .description('Edit section attributes (class, boxed, variations, …)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--id <sectionId>', 'Section id')
  .argument('[fields...]', 'name=value pairs (e.g. class="my-cls" boxed=1 variations="dark")')
  .action(
    withSession(async (ctx, args, opts) => {
      const { page } = ctx;
      const fields = args[0] || [];
      const attrs = parsePairs(fields);
      await layout.openLayout(page, ctx, opts.outline);
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => layoutApi.editSectionAttrs(structure, opts.id, attrs),
        mutateOpts(opts, 'section-edit')
      );
      if (r.dryRun) printLayoutDiff(r.diff);
      console.log(`Patched section ${opts.id}:`, attrs);
    })
  );

sectionCmd
  .command('class')
  .description('Add/remove CSS classes on a section')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--id <sectionId>', 'Section id')
  .option('--add <list>', 'Comma-separated classes to add')
  .option('--remove <list>', 'Comma-separated classes to remove')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      const add = (opts.add || '').split(',').map((s) => s.trim()).filter(Boolean);
      const remove = (opts.remove || '').split(',').map((s) => s.trim()).filter(Boolean);
      await layout.openLayout(page, ctx, opts.outline);
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => layoutApi.addSectionClasses(structure, opts.id, add, remove),
        mutateOpts(opts, 'section-class')
      );
      if (r.dryRun) printLayoutDiff(r.diff);
      console.log(`Updated classes on ${opts.id} (added: [${add.join(',')}], removed: [${remove.join(',')}]).`);
    })
  );

sectionCmd
  .command('inherit')
  .description('Make a section inherit from another outline')
  .option('-o, --outline <name>', 'Outline being edited', 'default')
  .requiredOption('--id <sectionId>', 'Section id (e.g. expanded)')
  .requiredOption('--from <fromOutline>', 'Outline to inherit from (e.g. default)')
  .option('--include <list>', 'Comma-separated parts to inherit (children,attributes,block)', 'children,attributes')
  .option('--particle <id>', 'Specific source section id (defaults to same id)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      const include = (opts.include || '').split(',').map((s) => s.trim()).filter(Boolean);
      const inherit = { outline: opts.from, include };
      if (opts.particle) inherit.particle = opts.particle;
      await layout.openLayout(page, ctx, opts.outline);
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => layoutApi.setNodeInherit(structure, opts.id, inherit),
        mutateOpts(opts, 'section-inherit')
      );
      if (r.dryRun) printLayoutDiff(r.diff);
      console.log(`Section ${opts.id} now inherits from ${opts.from} (include: ${include.join(',')}).`);
    })
  );

sectionCmd
  .command('fields')
  .description('Open a section\'s settings dialog and dump every form field')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--id <sectionId>', 'Section id (e.g. expanded, navigation)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      await layout.openLayout(page, ctx, opts.outline);
      const fields = await layout.inspectParticleFields(page, opts.id);
      const trimmed = fields.map((f) => ({
        name: f.name,
        type: f.type,
        value: typeof f.value === 'string' && f.value.length > 60 ? f.value.slice(0, 60) + '…' : f.value,
        options: f.options ? f.options.map((o) => o.value).join('|').slice(0, 60) : '',
      }));
      console.table(trimmed);
      console.log(`(${fields.length} fields on ${opts.id})`);
    })
  );

sectionCmd
  .command('clone')
  .description('Break inheritance on a section (clears the inherit field)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--id <sectionId>', 'Section id')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      await layout.openLayout(page, ctx, opts.outline);
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => layoutApi.clearNodeInherit(structure, opts.id),
        mutateOpts(opts, 'section-clone')
      );
      if (r.dryRun) printLayoutDiff(r.diff);
      console.log(`Inheritance broken on ${opts.id}.`);
    })
  );

// ---------- backups ----------
const backupsCmd = layoutCmd
  .command('backups')
  .description('Manage automatic layout backups (./backups by default; override via $GANTRY_BACKUP_DIR)');

backupsCmd
  .command('list')
  .description('List backups for an outline (newest first)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const list = backup.listBackups(ctx, opts.outline);
      if (!list.length) {
        console.log('(no backups)');
        return;
      }
      console.table(
        list.map((b) => ({
          name: b.name,
          size: b.size,
          mtime: b.mtime.toISOString(),
        }))
      );
    })
  );

backupsCmd
  .command('inspect')
  .description('Print summary of a specific backup\'s structure')
  .option('-o, --outline <name>', 'Outline', 'default')
  .option('--ref <ref>', 'Backup name, absolute path, or "latest"', 'latest')
  .action(
    withSession(async (ctx, _args, opts) => {
      const file = backup.resolveBackup(ctx, opts.outline, opts.ref);
      const structure = backup.readBackup(file);
      console.log('Backup:', file);
      console.log('Top-level nodes:');
      for (const node of structure) {
        console.log(`  [${node.type}] ${node.id} — title: ${node.title || '(none)'}`);
      }
      console.log(`(${structure.length} top-level nodes)`);
    })
  );

layoutCmd
  .command('undo')
  .description('Restore the most recent backup for an outline (alias of `restore --ref latest`)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      const file = backup.resolveBackup(ctx, opts.outline, 'latest');
      const structure = backup.readBackup(file);
      await layout.openLayout(page, ctx, opts.outline);
      if (opts.dryRun) {
        const before = await layoutApi.serializeLayout(page);
        const diff = layoutApi.diffStructures(before, structure);
        console.log('[dry-run] Would restore', file);
        printLayoutDiff(diff);
        return;
      }
      await layoutApi.restoreLayout(page, ctx, opts.outline, structure, {
        backup: opts.backup !== false,
      });
      console.log(`Restored from backup: ${file}`);
    })
  );

layoutCmd
  .command('restore')
  .description('Restore an outline from a saved backup file')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--ref <ref>', 'Backup name (in ./backups/<host>/<outline>/), absolute path, or "latest"')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      const file = backup.resolveBackup(ctx, opts.outline, opts.ref);
      const structure = backup.readBackup(file);
      await layout.openLayout(page, ctx, opts.outline);
      if (opts.dryRun) {
        const before = await layoutApi.serializeLayout(page);
        const diff = layoutApi.diffStructures(before, structure);
        console.log('[dry-run] Would restore', file);
        printLayoutDiff(diff);
        return;
      }
      await layoutApi.restoreLayout(page, ctx, opts.outline, structure, {
        backup: opts.backup !== false,
      });
      console.log(`Restored from backup: ${file}`);
    })
  );

// ---------- presets / load-preset ----------
layoutCmd
  .command('presets')
  .description('List built-in presets available for a theme')
  .option('-o, --outline <name>', 'Outline (any one — preset list is global)', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      await layout.openLayout(page, ctx, opts.outline);
      const { presets } = await layoutApi.listAvailablePresets(page, ctx, opts.outline);
      console.table(presets);
      console.log(`(${presets.length} presets)`);
    })
  );

layoutCmd
  .command('load-preset')
  .description('Apply a built-in preset to an outline (auto-backup, dry-run aware)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--preset <name>', 'Preset name (see `layout presets`)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      await layout.openLayout(page, ctx, opts.outline);
      const before = await layoutApi.serializeLayout(page);

      // Fetch the preset (no save yet) so dry-run can diff and backups can snapshot
      const probeUrl =
        `${ctx.base}/administrator/index.php` +
        `?option=com_gantry5` +
        `&view=${encodeURIComponent('configurations/' + opts.outline + '/layout/preset/' + opts.preset)}` +
        `&theme=${encodeURIComponent(ctx.theme)}` +
        (ctx.token ? `&${ctx.token}=1` : '') +
        `&format=json`;
      const fetched = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'same-origin' });
        return { status: r.status, body: await r.text() };
      }, probeUrl);
      if (fetched.status >= 400) throw new Error(`preset fetch ${fetched.status}: ${fetched.body.slice(0,200)}`);
      const parsed = JSON.parse(fetched.body);
      if (parsed.success === false) throw new Error(`preset reported failure: ${parsed.message || ''}`);
      const newLayout = JSON.parse(parsed.data);
      const diff = layoutApi.diffStructures(before, newLayout);

      if (opts.dryRun) {
        console.log(`[dry-run] Would load preset "${opts.preset}" (title: ${parsed.title}) onto outline ${opts.outline}:`);
        printLayoutDiff(diff);
        return;
      }

      // Auto-backup current state
      let backupPath = null;
      if (opts.backup !== false) {
        backupPath = backup.takeBackup(ctx, opts.outline, `pre-load-preset-${opts.preset}`, before);
      }

      // POST the preset's payload to the save endpoint (preset metadata + data)
      const saveUrl =
        `${ctx.base}/administrator/index.php` +
        `?option=com_gantry5` +
        `&view=${encodeURIComponent('configurations/' + opts.outline + '/layout')}` +
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
      if (saveRes.status >= 400) throw new Error(`save ${saveRes.status}: ${saveRes.body.slice(0,200)}`);
      console.log(
        `Loaded preset "${opts.preset}" (${parsed.title}) onto outline ${opts.outline}.${backupPath ? ' (backup: ' + backupPath + ')' : ''}`
      );
    })
  );

// ---------- export / import (YAML) ----------
layoutCmd
  .command('export')
  .description('Export an outline layout (every particle, position, attribute) as YAML')
  .option('-o, --outline <name>', 'Source outline', 'default')
  .option('--output <path>', 'Write YAML to this file (omit = print to stdout)')
  .option('--strip-ids', 'Strip random ids from grids/blocks (kept by default; cosmetic only)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const yaml = require('js-yaml');
      const fs = require('fs');
      const structure = await layoutApi.getLayoutStructure(ctx, opts.outline);
      let toDump = structure;
      if (opts.stripIds) {
        const strip = (n) => {
          if (!n || typeof n !== 'object') return;
          if (Array.isArray(n)) return n.forEach(strip);
          // Keep section ids (stable, semantic) — drop the random ones
          if (n.id && /^(grid|block)-\d+$/.test(n.id)) delete n.id;
          if (n.id && /^[a-z][a-z0-9-]*-\d+$/.test(n.id) && !['default'].includes(n.id)) {
            // particle/position/system/spacer ids — drop too
            // Actually keep them so post-import particles preserve titles in tools
            // Could be debated; leave them for now
          }
          strip(n.children);
        };
        strip(toDump);
      }
      const yamlText = yaml.dump(
        {
          schema: 1,
          source: { outline: opts.outline, theme: ctx.theme, host: new URL(ctx.base).host },
          exportedAt: new Date().toISOString(),
          layout: toDump,
        },
        { lineWidth: -1, noRefs: true }
      );
      if (opts.output) {
        fs.writeFileSync(opts.output, yamlText);
        console.log(`Exported layout (outline ${opts.outline}) to ${opts.output} (${yamlText.length} bytes)`);
      } else {
        process.stdout.write(yamlText);
      }
    })
  );

layoutCmd
  .command('import')
  .description('Import a YAML layout and apply to an outline (auto-backup, --dry-run aware)')
  .option('-o, --outline <name>', 'Target outline', 'default')
  .requiredOption('--input <path>', 'YAML file produced by `layout export`')
  .action(
    withSession(async (ctx, _args, opts) => {
      const yaml = require('js-yaml');
      const fs = require('fs');
      const path = require('path');
      const yamlText = fs.readFileSync(opts.input, 'utf8');
      const doc = yaml.load(yamlText);
      if (!doc || !Array.isArray(doc.layout)) {
        throw new Error('YAML must have a top-level "layout" array (use `layout export` to generate one)');
      }
      const newStructure = doc.layout;
      const before = await layoutApi.fetchSavedLayout(ctx, opts.outline).catch(() => []);
      const diff = layoutApi.diffStructures(before, newStructure);

      if (opts.dryRun) {
        console.log(
          `[dry-run] Would import layout from ${opts.input} to outline ${opts.outline}` +
            (doc.source ? ` (originally exported from outline ${doc.source.outline} on ${doc.source.host})` : '')
        );
        printLayoutDiff(diff);
        return;
      }

      let backupPath = null;
      if (opts.backup !== false && before.length) {
        backupPath = backup.takeBackup(
          ctx,
          opts.outline,
          'pre-import-' + path.basename(opts.input).replace(/\W+/g, '_'),
          before
        );
      }
      await layoutApi.saveLayoutDirect(ctx, ctx, opts.outline, newStructure);
      console.log(
        `Imported layout from ${opts.input} to outline ${opts.outline}.${backupPath ? ' (backup: ' + backupPath + ')' : ''}`
      );
    })
  );

// ---------- copy layout from another outline ----------
layoutCmd
  .command('copy-from')
  .description('Copy the entire layout from one outline into another (single session)')
  .requiredOption('--from <fromOutline>', 'Source outline id (e.g. 33, default, 58)')
  .requiredOption('--to <toOutline>', 'Target outline id')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      // Source: fetch
      await layout.openLayout(page, ctx, opts.from);
      const source = await layoutApi.serializeLayout(page);
      if (!Array.isArray(source) || !source.length) {
        throw new Error(`Source outline "${opts.from}" has no layout to copy.`);
      }
      // Target: open + diff against current
      await layout.openLayout(page, ctx, opts.to);
      const before = await layoutApi.serializeLayout(page);
      const diff = layoutApi.diffStructures(before, source);
      if (opts.dryRun) {
        console.log(`[dry-run] Would copy layout ${opts.from} -> ${opts.to} (${source.length} top-level nodes)`);
        printLayoutDiff(diff);
        return;
      }
      // Auto-backup target
      let backupPath = null;
      if (opts.backup !== false) {
        backupPath = backup.takeBackup(ctx, opts.to, `copy-from-${opts.from}`, before);
      }
      await layoutApi.saveLayoutDirect(page, ctx, opts.to, source);
      console.log(
        `Copied layout from outline ${opts.from} -> ${opts.to}  (${source.length} top-level nodes).${backupPath ? ' (backup: ' + backupPath + ')' : ''}`
      );
    })
  );

// ---------- clear ----------
layoutCmd
  .command('clear')
  .description('Clear the layout (full wipe or keep-inheritance)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .option('--mode <mode>', 'full | keep-inheritance', 'full')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      await layout.openLayout(page, ctx, opts.outline);
      const r = await layoutApi.mutateLayout(
        page,
        ctx,
        opts.outline,
        (structure) => layoutApi.clearLayout(structure, opts.mode),
        mutateOpts(opts, 'clear-' + opts.mode)
      );
      if (r.dryRun) {
        console.log(`[dry-run] Would clear (${opts.mode}):`);
        printLayoutDiff(r.diff);
      } else {
        console.log(`Cleared layout (${opts.mode}) on outline ${opts.outline}.${r.backupPath ? ' (backup: ' + r.backupPath + ')' : ''}`);
      }
    })
  );

layoutCmd
  .command('batch')
  .description('Run multiple add/remove/move/edit ops in one session and save once')
  .option('-o, --outline <name>', 'Outline', 'default')
  .option('--ops <json>', 'JSON array of operations (inline)')
  .option('--file <path>', 'Path to JSON file containing operations')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      const fs = require('fs');
      let ops;
      if (opts.file) ops = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
      else if (opts.ops) ops = JSON.parse(opts.ops);
      else throw new Error('Pass --file <path> or --ops <json>');
      if (!Array.isArray(ops)) throw new Error('Operations must be a JSON array');

      await layout.openLayout(page, ctx, opts.outline);
      const log = [];
      const r = await layoutApi.mutateLayout(page, ctx, opts.outline, (structure) => {
        for (const op of ops) {
          switch (op.op) {
            case 'add': {
              let added;
              if (op.nextTo) {
                added = layoutApi.addParticleNextTo(
                  structure,
                  op.nextTo,
                  op.type || 'particle',
                  op.subtype,
                  { title: op.title, size: op.size, attrs: op.attrs }
                );
              } else {
                added = layoutApi.addParticleToSection(
                  structure,
                  op.to,
                  op.type || 'particle',
                  op.subtype,
                  { title: op.title, mode: op.mode || 'newGrid', attrs: op.attrs }
                );
              }
              log.push(`+ ${added.type}/${added.subtype} (${added.id})`);
              break;
            }
            case 'remove': {
              const ids = Array.isArray(op.ids) ? op.ids : op.id ? [op.id] : [];
              for (const id of ids) {
                const r = layoutApi.removeNode(structure, id);
                log.push(r ? `- ${id}` : `! ${id} (not found)`);
              }
              break;
            }
            case 'move': {
              if (op.nextTo) {
                layoutApi.moveParticleNextTo(structure, op.id, op.nextTo);
                log.push(`> ${op.id} next to ${op.nextTo}`);
              } else {
                layoutApi.moveParticleToSection(structure, op.id, op.to);
                log.push(`> ${op.id} -> ${op.to}`);
              }
              break;
            }
            case 'edit': {
              // Patch the node's attributes directly in the JSON (fast — no dialog).
              // op.attrs       — merged into node.attributes (deep)
              // op.blockAttrs  — merged into wrapping block's attributes
              const found = layoutApi.findNode(structure, op.id);
              if (!found) throw new Error(`edit: node ${op.id} not found`);
              if (op.attrs) deepMerge(found.node.attributes || (found.node.attributes = {}), op.attrs);
              if (op.title !== undefined) found.node.title = op.title;
              if (op.blockAttrs) {
                const block = layoutApi.findNode(structure, (n) =>
                  Array.isArray(n.children) && n.children.includes(found.node)
                );
                if (!block) throw new Error(`edit: no block wraps ${op.id}`);
                deepMerge(block.node.attributes || (block.node.attributes = {}), op.blockAttrs);
              }
              log.push(`~ ${op.id}`);
              break;
            }
            default:
              throw new Error(`Unknown op: ${op.op}`);
          }
        }
      }, mutateOpts(opts, 'batch'));
      if (r.dryRun) {
        console.log(`[dry-run] Batch (${ops.length} ops):\n  ` + log.join('\n  '));
        printLayoutDiff(r.diff);
      } else {
        console.log(`Batch complete (${ops.length} ops):\n  ` + log.join('\n  '));
        if (r.backupPath) console.log(`  (backup: ${r.backupPath})`);
      }
    })
  );

/** Deep-merge `src` into `dst` — used by batch edit to patch nested attributes. */
function deepMerge(dst, src) {
  for (const k of Object.keys(src)) {
    if (
      src[k] &&
      typeof src[k] === 'object' &&
      !Array.isArray(src[k]) &&
      dst[k] &&
      typeof dst[k] === 'object' &&
      !Array.isArray(dst[k])
    ) {
      deepMerge(dst[k], src[k]);
    } else {
      dst[k] = src[k];
    }
  }
}

// ---------- menu ----------
const menuCmd = program.command('menu').description('Menu Editor');

menuCmd
  .command('list')
  .description('List menu items')
  .option('-m, --menu <name>', 'Menu alias', 'mainmenu')
  .action(
    withSession(async (ctx, _args, opts) => {
      const { page } = ctx;
      await menu.openMenu(page, ctx, opts.menu);
      console.table(await menu.listMenuItems(page));
    })
  );

menuCmd
  .command('edit')
  .description('Edit a menu item (field=value pairs)')
  .option('-m, --menu <name>', 'Menu alias', 'mainmenu')
  .requiredOption('--id <itemId>', 'Menu item id')
  .argument('[fields...]')
  .action(
    withSession(async (ctx, args, opts) => {
      const { page } = ctx;
      const edits = parsePairs(args[0] || []);
      await menu.openMenu(page, ctx, opts.menu);
      await menu.selectMenuItem(page, opts.id);
      await menu.applyEdits(page, edits);
      await menu.saveMenu(page);
      console.log('Edited menu item:', opts.id);
    })
  );

menuCmd
  .command('assign')
  .description('Toggle outline assignments (id=true|false pairs)')
  .requiredOption('-o, --outline <name>', 'Non-default outline')
  .argument('[pairs...]')
  .action(
    withSession(async (ctx, args, opts) => {
      const { page } = ctx;
      const a = {};
      for (const p of args[0] || []) {
        const [k, v] = p.split('=');
        a[k] = v === 'true' || v === 'on' || v === '1';
      }
      await menu.openAssignments(page, ctx, opts.outline);
      await menu.setAssignments(page, a);
      console.log('Assignments updated for', opts.outline);
    })
  );

// ---------- styles ----------
const stylesCmd = program.command('styles').description('Theme styles (colors, fonts, etc.)');

stylesCmd
  .command('list')
  .description('Dump all style fields and their current values')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      await styles.openStyles(ctx, opts.outline);
      console.table(await styles.listStyles(ctx));
    })
  );

stylesCmd
  .command('edit')
  .description('Edit style fields (name=value pairs, e.g. styles[base][background]=#ffffff)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .argument('[fields...]')
  .action(
    withSession(async (ctx, args, opts) => {
      const edits = parsePairs(args[0] || []);
      await styles.openStyles(ctx, opts.outline);
      await styles.editStyles(ctx, edits);
      await styles.saveStyles(ctx);
      console.log('Saved styles:', Object.keys(edits));
    })
  );

// ---------- page settings ----------
const pageCmd = program.command('page').description('Per-outline Page Settings');

pageCmd
  .command('list')
  .description('Dump every Page Settings field with its current value')
  .option('-o, --outline <name>', 'Outline', 'default')
  .option('--all', 'Include hidden _json aggregator fields')
  .action(
    withSession(async (ctx, _args, opts) => {
      await pageMod.openPage(ctx, opts.outline);
      console.table(await pageMod.listPage(ctx, { all: !!opts.all }));
    })
  );

pageCmd
  .command('edit')
  .description('Edit Page Settings (name=value pairs, e.g. page[body][attribs][id]=top)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .argument('[fields...]')
  .action(
    withSession(async (ctx, args, opts) => {
      const edits = parsePairs(args[0] || []);
      await pageMod.openPage(ctx, opts.outline);
      await pageMod.editPage(ctx, edits);
      await pageMod.savePage(ctx);
      console.log('Saved Page Settings:', Object.keys(edits));
    })
  );

pageCmd
  .command('open')
  .description('Open the Page Settings view (debug helper, pair with --keep-open)')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      await pageMod.openPage(ctx, opts.outline);
      console.log('Page Settings opened.');
    })
  );

// ---------- diagnostic: probe a preset URL with GET + empty POST ----------
program
  .command('probe-preset')
  .description('Try GET and empty-body POST against /preset/<name> to see how Gantry returns preset layouts')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--preset <name>', 'Preset name (e.g. default, fullwidth, left_sidebar)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const fs = require('fs');
      const path = require('path');
      const layout = require('./lib/layout');
      const { gantryUrl } = require('./lib/util');
      const dir = path.resolve(process.cwd(), 'discovery');
      fs.mkdirSync(dir, { recursive: true });

      await layout.openLayout(ctx.page, ctx, opts.outline);

      const url = gantryUrl(ctx, `configurations/${opts.outline}/layout/preset/${opts.preset}`) + '&format=json';
      console.log('URL:', url.replace(/[a-f0-9]{32}=1/g, '<TOKEN>=1'));

      const probes = await ctx.page.evaluate(async (url) => {
        const out = {};
        try {
          const r1 = await fetch(url, { credentials: 'same-origin' });
          out.GET = { status: r1.status, ct: r1.headers.get('content-type'), body: await r1.text() };
        } catch (e) { out.GET = { error: e.message }; }
        try {
          const r2 = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: '',
          });
          out.POST_empty = { status: r2.status, ct: r2.headers.get('content-type'), body: await r2.text() };
        } catch (e) { out.POST_empty = { error: e.message }; }
        return out;
      }, url);

      const file = path.join(dir, `probe-preset-${opts.preset}.json`);
      fs.writeFileSync(file, JSON.stringify(probes, null, 2));
      console.log('GET status:',  probes.GET?.status, 'ct:', probes.GET?.ct, 'len:', (probes.GET?.body || '').length);
      console.log('POST status:', probes.POST_empty?.status, 'ct:', probes.POST_empty?.ct, 'len:', (probes.POST_empty?.body || '').length);
      console.log('Wrote', file);
    })
  );

// ---------- diagnostic: dump the /layout/switch response (preset catalog) ----------
program
  .command('dump-presets')
  .description('Fetch /configurations/<outline>/layout/switch and write the response to ./discovery/presets-<outline>.json')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const fs = require('fs');
      const path = require('path');
      const layout = require('./lib/layout');
      const { gantryUrl } = require('./lib/util');
      const dir = path.resolve(process.cwd(), 'discovery');
      fs.mkdirSync(dir, { recursive: true });

      // Land on the layout page first so cookies + session state are mounted.
      await layout.openLayout(ctx.page, ctx, opts.outline);

      const url = gantryUrl(ctx, `configurations/${opts.outline}/layout/switch`) + '&format=json';
      const sanitized = url.replace(/[a-f0-9]{32}=1/g, '<TOKEN>=1');
      console.log('GET', sanitized);
      const res = await ctx.page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'same-origin' });
        return { status: r.status, ct: r.headers.get('content-type'), body: await r.text() };
      }, url);
      const file = path.join(dir, `presets-${opts.outline}.json`);
      fs.writeFileSync(file, res.body);
      console.log(`Status ${res.status}  ct=${res.ct}  bytes=${res.body.length}`);
      console.log('Wrote', file);
    })
  );

// ---------- diagnostic: capture every gantry5 request while you watch in the browser ----------
program
  .command('capture-traffic')
  .description('Open the layout for an outline and log every gantry5 request that fires until you Ctrl+C. Use this to capture Load/Clear/etc. flows by performing the action manually in the visible browser.')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const fs = require('fs');
      const path = require('path');
      const layout = require('./lib/layout');
      const dir = path.resolve(process.cwd(), 'discovery');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `traffic-${opts.outline}-${Date.now()}.jsonl`);
      const stream = fs.createWriteStream(f);
      console.log('Logging to', f);

      ctx.page.on('request', (req) => {
        const url = req.url();
        if (!/option=com_gantry5/.test(url)) return;
        const entry = {
          ts: Date.now(),
          method: req.method(),
          url: url.replace(/[a-f0-9]{32}=1/g, '<TOKEN>=1'),
          ct: req.headers()['content-type'] || '',
          body: req.postData() || null,
        };
        stream.write(JSON.stringify(entry) + '\n');
        const tag = entry.method.padEnd(4);
        const sliced = (entry.url.match(/view=([^&]+)/) || [, entry.url])[1];
        console.log(`  ${tag} ${sliced}  body=${(entry.body || '').length}`);
      });

      await layout.openLayout(ctx.page, ctx, opts.outline);
      console.log('Layout open. Perform any action in the browser; press Ctrl+C when done.');
      // Keep alive
      await new Promise(() => {});
    })
  );

// ---------- diagnostic: capture the body Gantry POSTs when saving layout ----------
program
  .command('capture-save-body')
  .description('Edit a particle (no-op) and capture the resulting Save POST body to ./discovery/layout-save-<outline>.body.txt')
  .option('-o, --outline <name>', 'Outline', 'default')
  .requiredOption('--id <particleId>', 'A particle id whose dialog we open and re-save (use one from `layout list`)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const fs = require('fs');
      const path = require('path');
      const layout = require('./lib/layout');
      const dir = path.resolve(process.cwd(), 'discovery');
      fs.mkdirSync(dir, { recursive: true });

      await layout.openLayout(ctx.page, ctx, opts.outline);

      // Capture every gantry5 POST — we don't yet know which URL gets hit.
      const allPosts = [];
      const handler = (req) => {
        const url = req.url();
        if (/option=com_gantry5/.test(url) && req.method() === 'POST') {
          allPosts.push({
            url: url.replace(/[a-f0-9]{32}=1/g, '<TOKEN>=1'),
            ct: req.headers()['content-type'] || '',
            bodyLength: (req.postData() || '').length,
            body: req.postData() || '',
          });
        }
      };
      ctx.page.on('request', handler);

      // 1) Open particle dialog and click "Apply and Save"
      await layout.editParticle(ctx.page, opts.id, {}, 'applyAndSave');
      await new Promise((r) => setTimeout(r, 2000));

      // 2) Also explicitly click Save Layout — in case Apply-and-Save just queues it
      const saveBtn = await ctx.page.$('[data-save="Layout"]');
      if (saveBtn) {
        await saveBtn.click();
        await new Promise((r) => setTimeout(r, 3000));
      }

      ctx.page.off('request', handler);

      const f = path.join(dir, `layout-save-${opts.outline}.posts.json`);
      fs.writeFileSync(f, JSON.stringify(allPosts, null, 2));
      console.log(`Captured ${allPosts.length} POST(s):`);
      allPosts.forEach((p, i) =>
        console.log(`  [${i}] len=${p.bodyLength}  ct=${p.ct}  url=${p.url.slice(0, 110)}…`)
      );
    })
  );

// ---------- diagnostic: pull layout JSON via GET / window state ----------
program
  .command('dump-layout-json')
  .description('Try multiple strategies to fetch the layout JSON for an outline. Writes ./discovery/layout-<outline>.json.')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const fs = require('fs');
      const path = require('path');
      const layout = require('./lib/layout');
      const { gantryUrl } = require('./lib/util');
      const dir = path.resolve(process.cwd(), 'discovery');
      fs.mkdirSync(dir, { recursive: true });

      // Strategy 1: GET the layout view with format=json
      const getUrl = gantryUrl(ctx, `configurations/${opts.outline}/layout`) + '&format=json';
      console.log('Trying GET:', getUrl.replace(/[a-f0-9]{32}=1/, '<TOKEN>=1'));
      try {
        const res = await ctx.page.evaluate(async (url) => {
          const r = await fetch(url, { credentials: 'same-origin' });
          return { status: r.status, ct: r.headers.get('content-type'), body: await r.text() };
        }, getUrl);
        const file = path.join(dir, `layout-${opts.outline}.get.json`);
        fs.writeFileSync(file, res.body);
        console.log(`  -> ${res.status} ${res.ct}  bytes=${res.body.length}  file=${file}`);
      } catch (e) {
        console.warn('  GET failed:', e.message);
      }

      // Strategy 2: read window.G5 in-memory state from the live layout page
      await layout.openLayout(ctx.page, ctx, opts.outline);
      const state = await ctx.page.evaluate(() => {
        const top = window.G5 || {};
        const grab = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 3) return undefined;
          const out = {};
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === 'function') continue;
            if (v && typeof v === 'object') {
              try {
                JSON.stringify(v); // catch circular
                out[k] = v;
              } catch {
                out[k] = '[circular]';
              }
            } else {
              out[k] = v;
            }
          }
          return out;
        };
        return {
          G5keys: Object.keys(top),
          G5shallow: grab(top),
        };
      });
      const sFile = path.join(dir, `layout-${opts.outline}.window.json`);
      fs.writeFileSync(sFile, JSON.stringify(state, null, 2));
      console.log('Wrote window state to', sFile);

      // Strategy 3.5: probe lm.builder for serialize/toJSON/save + dump structure
      const builderProbe = await ctx.page.evaluate(() => {
        const b = window.G5?.lm?.builder;
        if (!b) return { error: 'no builder' };
        const protoMethods = new Set();
        let p = b;
        while (p && p !== Object.prototype) {
          for (const k of Object.getOwnPropertyNames(p)) {
            try {
              if (typeof p[k] === 'function') protoMethods.add(k);
            } catch {}
          }
          p = Object.getPrototypeOf(p);
        }
        // Try serialize/toJSON/save methods
        const tryCall = (name) => {
          try {
            if (typeof b[name] !== 'function') return null;
            const res = b[name]();
            const str = typeof res === 'string' ? res : JSON.stringify(res);
            return { ok: true, len: str ? str.length : 0, sample: (str || '').slice(0, 400) };
          } catch (e) {
            return { ok: false, err: e.message };
          }
        };
        return {
          ownKeys: Object.keys(b),
          protoMethods: [...protoMethods].sort(),
          structureType: typeof b.structure,
          structureKeys: b.structure && typeof b.structure === 'object' ? Object.keys(b.structure).slice(0, 30) : null,
          calls: {
            serialize: tryCall('serialize'),
            toJSON: tryCall('toJSON'),
            toString: tryCall('toString'),
            save: tryCall('save'),
            data: tryCall('data'),
          },
        };
      });
      const bFile = path.join(dir, `layout-${opts.outline}.builder.json`);
      fs.writeFileSync(bFile, JSON.stringify(builderProbe, null, 2));
      console.log('Wrote builder probe to', bFile);

      // Strategy 3.6: probe layoutmanager methods + try calling builder.add() so we can see its signature
      const lmProbe = await ctx.page.evaluate(() => {
        const out = { layoutmanager: {}, builderTryCalls: {} };
        // Layoutmanager prototype methods
        const lm = window.G5?.lm?.layoutmanager;
        if (lm) {
          const meths = new Set();
          let p = lm;
          while (p && p !== Object.prototype) {
            for (const k of Object.getOwnPropertyNames(p)) {
              try {
                if (typeof p[k] === 'function') meths.add(k);
              } catch {}
            }
            p = Object.getPrototypeOf(p);
          }
          out.layoutmanager.methods = [...meths].sort();
          out.layoutmanager.optionKeys = lm.options ? Object.keys(lm.options) : null;
          out.layoutmanager.historyType = typeof window.G5.lm.history;
        }
        // Try calling builder.add() variations to see error messages
        const b = window.G5?.lm?.builder;
        if (b) {
          const tries = [
            { args: [] },
            { args: ['particle'] },
            { args: [{ type: 'particle', subtype: 'branding' }] },
            { args: ['expanded', { type: 'particle', subtype: 'branding' }] },
          ];
          tries.forEach((t, i) => {
            try {
              const r = b.add(...t.args);
              out.builderTryCalls['try' + i] = {
                args: t.args,
                ok: true,
                ret: typeof r === 'object' ? Object.keys(r || {}).slice(0, 6) : String(r),
              };
            } catch (e) {
              out.builderTryCalls['try' + i] = {
                args: t.args,
                ok: false,
                err: e.message,
              };
            }
          });
        }
        return out;
      });
      const pmFile = path.join(dir, `layout-${opts.outline}.lmprobe.json`);
      fs.writeFileSync(pmFile, JSON.stringify(lmProbe, null, 2));
      console.log('Wrote layoutmanager probe to', pmFile);

      // Strategy 4: capture the FULL serialize() output so we know the layout shape
      const serialized = await ctx.page.evaluate(() => {
        try {
          return JSON.stringify(window.G5.lm.builder.serialize(), null, 2);
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      });
      const fullFile = path.join(dir, `layout-${opts.outline}.serialized.json`);
      fs.writeFileSync(fullFile, serialized);
      console.log(`Wrote full serialized layout to ${fullFile}  (${serialized.length} chars)`);

      // Strategy 3: probe the lm namespace specifically — methods + builder data
      const lmInfo = await ctx.page.evaluate(() => {
        const seen = new WeakSet();
        const summarize = (obj, depth = 0) => {
          if (obj === null || obj === undefined) return obj;
          if (depth > 4) return '[depth-limit]';
          if (typeof obj === 'function') return '[function]';
          if (typeof obj !== 'object') return obj;
          if (seen.has(obj)) return '[circular]';
          seen.add(obj);
          if (Array.isArray(obj)) {
            return obj.slice(0, 8).map((v) => summarize(v, depth + 1));
          }
          const out = {};
          for (const k of Object.keys(obj).slice(0, 30)) {
            try {
              out[k] = summarize(obj[k], depth + 1);
            } catch {
              out[k] = '[err]';
            }
          }
          return out;
        };
        const lm = window.G5.lm;
        const result = {
          methods: [],
          properties: [],
          shape: summarize(lm, 0),
        };
        // Walk prototype chain to enumerate methods
        let proto = lm && Object.getPrototypeOf(lm);
        while (proto && proto !== Object.prototype) {
          for (const k of Object.getOwnPropertyNames(proto)) {
            if (typeof proto[k] === 'function') result.methods.push(k);
          }
          proto = Object.getPrototypeOf(proto);
        }
        // Direct keys
        if (lm) result.properties = Object.keys(lm);
        return result;
      });
      const lFile = path.join(dir, `layout-${opts.outline}.lm.json`);
      fs.writeFileSync(lFile, JSON.stringify(lmInfo, null, 2));
      console.log('Wrote lm probe to', lFile);
    })
  );

// ---------- diagnostic: capture the Save Layout POST body ----------
program
  .command('capture-layout-save')
  .description('Click Save Layout and write the POST body to ./discovery/layout-<outline>.json')
  .option('-o, --outline <name>', 'Outline', 'default')
  .action(
    withSession(async (ctx, _args, opts) => {
      const fs = require('fs');
      const path = require('path');
      const layout = require('./lib/layout');
      const dir = path.resolve(process.cwd(), 'discovery');
      fs.mkdirSync(dir, { recursive: true });

      await layout.openLayout(ctx.page, ctx, opts.outline);

      let captured = null;
      ctx.page.on('request', (req) => {
        const url = req.url();
        if (
          /option=com_gantry5/.test(url) &&
          /view=configurations\//.test(url) &&
          /\/layout/.test(url) &&
          /format=json/.test(url) &&
          req.method() === 'POST'
        ) {
          captured = { url: url.replace(/[a-f0-9]{32}=1/, '<TOKEN>=1'), body: req.postData() };
        }
      });

      // Click Save Layout — Gantry will POST the current state even if nothing changed.
      const btn = await ctx.page.$('[data-save="Layout"]');
      if (!btn) throw new Error('Save Layout button not found');
      await btn.click();
      // Give the request a moment to fire and resolve
      await new Promise((r) => setTimeout(r, 4000));

      if (!captured) throw new Error('No save POST captured (check the browser for errors).');
      const file = path.join(dir, `layout-${opts.outline}.json`);
      fs.writeFileSync(file, captured.body || '');
      const meta = path.join(dir, `layout-${opts.outline}.meta.json`);
      fs.writeFileSync(meta, JSON.stringify({ url: captured.url, bodyLength: (captured.body || '').length }, null, 2));
      console.log('Wrote', file, '(' + (captured.body || '').length + ' chars)');
    })
  );

// ---------- diagnostic: dump any view's DOM ----------
program
  .command('dump')
  .description('Open a specific Gantry view and dump its structure to ./discovery/<name>.json')
  .requiredOption('--view <path>', 'view= path, e.g. configurations or configurations/default/page')
  .option('--name <name>', 'Output basename (default: derived from --view)')
  .action(
    withSession(async (ctx, _args, opts) => {
      const fs = require('fs');
      const path = require('path');
      const { gantryUrl, sleep } = require('./lib/util');
      const dir = path.resolve(process.cwd(), 'discovery');
      fs.mkdirSync(dir, { recursive: true });
      const name = (opts.name || opts.view).replace(/[\/\\]/g, '__');
      const url = gantryUrl(ctx, opts.view);
      console.log('Visiting', url);
      await ctx.page.goto(url, { waitUntil: 'networkidle2' });
      await sleep(1500);
      const fp = await ctx.page.evaluate(() => {
        const trim = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
        const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
          text: trim((a.textContent || '').trim(), 80),
          href: a.getAttribute('href'),
          cls: a.getAttribute('class') || '',
        }));
        const inputs = Array.from(document.querySelectorAll('input,select,textarea')).map((el) => ({
          tag: el.tagName,
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          cls: el.getAttribute('class') || '',
        }));
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).map((b) => ({
          text: trim((b.textContent || '').trim(), 60),
          cls: b.getAttribute('class') || '',
          id: b.id || '',
          dataAttrs: Object.fromEntries(
            Array.from(b.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])
          ),
        }));
        const tokens = new Set();
        document.querySelectorAll('*').forEach((el) => {
          (typeof el.className === 'string' ? el.className.split(/\s+/) : []).forEach((t) => {
            if (t && /^(g-|g5|outline|theme|particle|atom)/i.test(t)) tokens.add(t);
          });
        });
        const dataAttrs = new Set();
        document.querySelectorAll('*').forEach((el) =>
          Array.from(el.attributes).forEach((a) => a.name.startsWith('data-') && dataAttrs.add(a.name))
        );
        return {
          url: location.href,
          title: document.title,
          links,
          inputs,
          buttons,
          classes: [...tokens].sort(),
          dataAttrs: [...dataAttrs].sort(),
          html: document.documentElement.outerHTML,
        };
      });
      const file = path.join(dir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(fp, null, 2));
      await ctx.page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => {});
      console.log(`✓ Wrote ${file}  (${fp.links.length} links, ${fp.inputs.length} inputs)`);
    })
  );

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
