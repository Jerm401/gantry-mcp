#!/usr/bin/env node
'use strict';

/**
 * Gantry 5 backend discovery tool.
 *
 * Visits every relevant admin view, dumps a screenshot + a structured JSON
 * snapshot (HTML, links, forms, classnames, iframes) for each, so the main
 * script's selectors can be tuned to your actual install.
 *
 * Output: ./discovery/<page>.{png,json}  +  ./discovery/summary.json
 *
 * Usage:
 *   node discover.js -s https://yoursite.com
 *   node discover.js -s https://yoursite.com --headless
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Command } = require('commander');
const session = require('./lib/session');
const { sleep } = require('./lib/util');

const program = new Command();
program
  .requiredOption('-s, --site <url>', 'Joomla site URL')
  .option('-t, --theme <name>', 'Gantry theme', process.env.GANTRY_THEME || 'studius')
  .option('-u, --user <name>')
  .option('-p, --pass <password>')
  .option('--headless', 'Run headless')
  .option('--outline <name>', 'Outline to inspect (besides "default")', 'home')
  .option('--menu <name>', 'Menu alias to inspect', 'mainmenu')
  .parse(process.argv);

const opts = program.opts();
const OUT = path.resolve(process.cwd(), 'discovery');
fs.mkdirSync(OUT, { recursive: true });

/**
 * Pull a structured fingerprint out of the current page DOM.
 */
async function fingerprint(page) {
  return page.evaluate(() => {
    const trim = (s, n = 400) =>
      s ? (s.length > n ? s.slice(0, n) + '…' : s) : '';

    // Limit HTML to keep files manageable
    const html = document.documentElement.outerHTML;

    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({
        text: trim((a.textContent || '').trim(), 80),
        href: a.getAttribute('href'),
        cls: a.getAttribute('class') || '',
      }))
      .filter((l) => l.href && !l.href.startsWith('javascript:'));

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(
      (b) => ({
        text: trim((b.textContent || '').trim(), 80),
        cls: b.getAttribute('class') || '',
        id: b.id || '',
        type: b.getAttribute('type') || '',
        dataAttrs: Object.fromEntries(
          Array.from(b.attributes)
            .filter((a) => a.name.startsWith('data-'))
            .map((a) => [a.name, a.value])
        ),
      })
    );

    const inputs = Array.from(document.querySelectorAll('input, select, textarea')).map(
      (el) => ({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        id: el.id || '',
        cls: el.getAttribute('class') || '',
        value: el.value && el.type !== 'password' ? trim(String(el.value), 60) : '',
      })
    );

    const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => ({
      src: f.getAttribute('src') || '',
      id: f.id || '',
      cls: f.getAttribute('class') || '',
    }));

    // Collect distinct class tokens that look gantry/joomla-ish
    const tokens = new Set();
    document.querySelectorAll('*').forEach((el) => {
      (el.className && typeof el.className === 'string'
        ? el.className.split(/\s+/)
        : []
      ).forEach((t) => {
        if (!t) return;
        if (/^(g-|g5|gantry|lm-|mm-|theme|outline|particle|atom|section|grid|block)/i.test(t)) {
          tokens.add(t);
        }
      });
    });

    const dataAttrs = new Set();
    document.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        if (a.name.startsWith('data-')) dataAttrs.add(a.name);
      });
    });

    // Detect Gantry's runtime globals
    const globals = {
      hasG5: typeof window.G5 !== 'undefined',
      hasGantry: typeof window.Gantry !== 'undefined',
      title: document.title,
      url: location.href,
    };

    return {
      url: location.href,
      title: document.title,
      links,
      buttons,
      inputs,
      iframes,
      classes: Array.from(tokens).sort(),
      dataAttrs: Array.from(dataAttrs).sort(),
      globals,
      htmlLength: html.length,
      html: html.length > 500_000 ? html.slice(0, 500_000) + '\n<!-- truncated -->' : html,
    };
  });
}

async function dump(page, name) {
  const fp = await fingerprint(page);
  const json = path.join(OUT, `${name}.json`);
  const png = path.join(OUT, `${name}.png`);
  fs.writeFileSync(json, JSON.stringify(fp, null, 2));
  await page.screenshot({ path: png, fullPage: true }).catch(() => {});
  console.log(`  ✓ ${name}  (${fp.htmlLength} chars, ${fp.links.length} links, ${fp.inputs.length} inputs)`);
  return fp;
}

async function visit(page, url, name, waitForSel) {
  console.log(`→ ${name}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    if (waitForSel) {
      await page.waitForSelector(waitForSel, { timeout: 10000 }).catch(() => {});
    }
    await sleep(700);
    return await dump(page, name);
  } catch (err) {
    console.warn(`  ✗ ${name} — ${err.message}`);
    fs.writeFileSync(
      path.join(OUT, `${name}.error.json`),
      JSON.stringify({ url, error: err.message }, null, 2)
    );
    return null;
  }
}

(async () => {
  console.log(`Output: ${OUT}`);
  const ctx = await session.start({
    site: opts.site,
    headless: !!opts.headless,
    user: opts.user,
    pass: opts.pass,
    themeName: opts.theme,
  });
  const { page, base, theme } = ctx;
  console.log(`Logged in. Active theme directory: ${theme}\n`);

  const summary = { theme, base, captured: [] };
  const recordOk = (label, fp) => fp && summary.captured.push({ label, url: fp.url });

  // 1. Themes index (post-Configure click — captures the layout view we landed on)
  recordOk('after-configure', await dump(page, 'after-configure'));

  // 2. Themes list itself
  recordOk(
    'themes-list',
    await visit(
      page,
      `${base}/administrator/index.php?option=com_gantry5&view=themes`,
      'themes-list',
      '.theme.card, .theme'
    )
  );

  // 3. Outlines list
  recordOk(
    'outlines',
    await visit(
      page,
      `${base}/administrator/index.php?option=com_gantry5&view=outlines&theme=${theme}`,
      'outlines'
    )
  );

  // 4-7. Default outline: layout, page-settings, assignments, styles
  for (const view of ['layout', 'page-settings', 'assignments', 'styles']) {
    recordOk(
      `default-${view}`,
      await visit(
        page,
        `${base}/administrator/index.php?option=com_gantry5&view=configurations/default/${view}&theme=${theme}`,
        `default-${view}`
      )
    );
  }

  // 8. Optional secondary outline (e.g. "home")
  if (opts.outline && opts.outline !== 'default') {
    recordOk(
      `${opts.outline}-layout`,
      await visit(
        page,
        `${base}/administrator/index.php?option=com_gantry5&view=configurations/${opts.outline}/layout&theme=${theme}`,
        `${opts.outline}-layout`
      )
    );
  }

  // 9. Menu editor
  recordOk(
    'menu-editor',
    await visit(
      page,
      `${base}/administrator/index.php?option=com_gantry5&view=menu/${opts.menu}&theme=${theme}`,
      'menu-editor'
    )
  );

  // 10. Particles — Gantry stores particle definitions in the layout manager,
  //     but there's also a particles config view per theme.
  recordOk(
    'particles-defaults',
    await visit(
      page,
      `${base}/administrator/index.php?option=com_gantry5&view=configurations/default/particles&theme=${theme}`,
      'particles-defaults'
    )
  );

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nDone. ${summary.captured.length} views captured. See ./discovery/summary.json`);
  await ctx.browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
