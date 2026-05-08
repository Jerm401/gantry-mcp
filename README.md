# Gantry 5 Editor — Puppeteer Automation

A command-line toolkit for automating Joomla + Gantry 5 (Studius) admin tasks via Puppeteer. Layout edits, particle settings, themes, page settings, outlines — all scriptable.

The trick that makes it reliable: instead of trying to drive Gantry's drag-drop UI, we read the in-memory layout JSON from `window.G5.lm.builder.serialize()`, mutate it, and POST the result directly to the layout save endpoint. This skips every flaky bit of the UI.

---

## Setup

```
npm install
cp .env.example .env       # then edit .env with your credentials
```

`.env` keys:

```
GANTRY_ADMIN_USER=your_joomla_admin_username
GANTRY_ADMIN_PASS=your_joomla_admin_password

# Optional: per-site overrides
# Host gets normalized — example.com → EXAMPLE_COM_USER / EXAMPLE_COM_PASS
# EXAMPLE_COM_USER=admin
# EXAMPLE_COM_PASS=hunter2

GANTRY_THEME=studius                # default theme to look for
GANTRY_USER_DATA_DIR=./.puppeteer-profile
GANTRY_BACKUP_DIR=./backups         # where auto-snapshots land
GANTRY_SLOWMO=0                     # ms slow-mo for headful debugging
```

Smoke test:

```
node gantry.js -s https://yoursite.com login
```

Should print `Logged in. Theme: rt_studius  Token: <hash>`.

---

## Global flags

These work on every command:

| Flag | Effect |
|------|--------|
| `-s, --site <url>` | Joomla site URL (required) |
| `-t, --theme <name>` | Gantry theme directory name (defaults to `studius`/`rt_studius`) |
| `-u, --user <name>` | Override admin username from .env |
| `-p, --pass <password>` | Override admin password from .env |
| `--headless` | Run Chromium headless (default: visible) |
| `--keep-open` | Leave browser open after the command finishes |
| `--dry-run` | For mutating commands: print the diff and skip the POST |
| `--no-backup` | Skip the auto-snapshot before mutating |
| `--sites <csvUrls>` | Comma-separated list of site URLs — fan-out the command to each |
| `--sites-file <path>` | JSON file with `[{site, user?, pass?, theme?}]` entries |
| `--fail-fast` | When using `--sites`/`--sites-file`: abort on first failure |

---

## Reading commands

```
gantry login                                  # smoke test login + Configure
gantry outlines list                          # 37 outlines on a fresh Studius
gantry layout list -o <outline> --editable    # particles only, skip wrappers
gantry layout tree -o <outline>               # full hierarchical tree
gantry layout sections -o <outline>           # stable section ids for --to
gantry layout available -o <outline>          # picker enumeration (which subtypes work)
gantry layout fields -o <outline> --id <particleId>     # every field of a particle's settings
gantry layout section fields -o <outline> --id <sectionId>
gantry styles list -o <outline>
gantry page list -o <outline>
gantry menu list -m mainmenu
gantry particles available  (alias of `layout available`)
```

`-o, --outline` defaults to `default` (the base outline).

---

## Mutating layout commands

All of these auto-backup to `./backups/<host>/<outline>/<timestamp>-<op>.json` and respect `--dry-run`.

### Add a particle

```
gantry layout add -o 75 --type particle --subtype custom --to expanded --title "My HTML"
gantry layout add -o 75 --type particle --subtype custom --next-to contentarray-6583 --size 40
gantry layout add -o 75 --type spacer --subtype spacer --to navigation
gantry layout add -o 75 --type system --subtype messages --to top
gantry layout add -o 75 --type position --subtype module --to expanded
```

`--type` is one of `particle | position | spacer | system`.
`--subtype` matches the picker — see `layout available`.
`--to <sectionId>` drops in a new full-width grid; `--next-to <particleId>` drops as a sibling block in the same grid (auto-resize). `--size N` sets the new block's width %.

### Move

```
gantry layout move -o 75 --id contentarray-6583 --to footer
gantry layout move -o 75 --id contentarray-6583 --next-to logo-7708
```

### Remove

```
gantry layout remove -o 75 --id custom-1234
gantry layout remove -o 75 --id A --id B --id C        # multi
gantry layout remove -o 75 --ids A,B,C                 # csv
```

### Edit a particle's settings

JSON-patch path (default — fast, auto-backed-up, dry-run aware):

```
gantry layout edit -o 75 --id contentarray-6583 -- particles[contentarray][title]="Newsroom" particles[contentarray][article][limit][total]=5
gantry layout edit -o 75 --id contentarray-6583 -- block[size]=50 block[class]="my-cls"
gantry layout edit -o 75 --id contentarray-6583 -- inherit[mode]=clone inherit[outline]=default
```

Dialog path (slower, opens Gantry's actual settings modal):

```
gantry layout edit -o 75 --id contentarray-6583 --via-dialog -- particles[contentarray][title]="Newsroom"
```

### Section-level operations

```
gantry layout section edit    -o 75 --id expanded boxed=1 class="hero" variations="dark"
gantry layout section class   -o 75 --id expanded --add "sticky,narrow" --remove "old-cls"
gantry layout section inherit -o 75 --id expanded --from default --include "children,attributes"
gantry layout section clone   -o 75 --id expanded     # break inheritance
gantry layout section fields  -o 75 --id expanded     # dump every field
```

### Export / Import (YAML)

```
gantry layout export -o 33 --output home.yaml      # snapshot an outline as YAML
gantry layout export -o default                    # or print to stdout
gantry layout import -o 75 --input home.yaml       # apply that snapshot to outline 75
gantry --dry-run layout import -o 75 --input home.yaml   # preview the diff first
```

The exported YAML contains the full structure — every section, grid, block, particle with all their attributes and inheritance settings — plus metadata (source outline, host, timestamp). Import auto-backups the target before overwriting; dry-run shows the diff and skips the POST.

### Clear / Copy / Restore / Preset

```
gantry layout clear -o 75 --mode full
gantry layout clear -o 75 --mode keep-inheritance

gantry layout copy-from --from 58 --to 75      # clone any outline's layout into another

gantry layout presets                          # list built-in presets
gantry layout load-preset -o 75 --preset default       # apply a preset to an outline
gantry --dry-run layout load-preset -o 75 --preset fullwidth   # preview the diff first
```

### Backups, undo, restore

```
gantry layout backups list -o 75
gantry layout backups inspect -o 75 --ref latest
gantry layout undo -o 75                              # restore most recent backup
gantry layout restore -o 75 --ref 2026-05-07T19-18-44-216-edit.json
gantry layout restore -o 75 --ref latest
```

---

## Batch — multiple ops in one session

Run any mix of add / remove / move / edit in a single browser session, with one save POST and one backup at the start.

```
gantry layout batch -o 75 --file ops.json
gantry layout batch -o 75 --ops '[{"op":"remove","ids":["A","B"]},{"op":"add","type":"particle","subtype":"custom","to":"expanded"}]'
```

Op shapes:

```jsonc
[
  // Add
  { "op": "add", "type": "particle", "subtype": "custom",
    "to": "expanded", "title": "My HTML", "mode": "newGrid" },
  { "op": "add", "type": "particle", "subtype": "custom",
    "nextTo": "contentarray-6583", "size": 40 },

  // Remove
  { "op": "remove", "id": "custom-1234" },
  { "op": "remove", "ids": ["A", "B", "C"] },

  // Move
  { "op": "move", "id": "custom-1234", "to": "footer" },
  { "op": "move", "id": "custom-1234", "nextTo": "contentarray-6583" },

  // Edit (deep-merged into node attributes; blockAttrs into wrapping block)
  { "op": "edit", "id": "contentarray-6583",
    "attrs": { "title": "Newsroom",
               "article": { "limit": { "total": "5" } } },
    "blockAttrs": { "size": 50, "class": "my-cls" } }
]
```

---

## Outlines

```
gantry outlines list
gantry outlines duplicate --id 58 --title "Sandbox" --no-inherit
gantry outlines delete --id 73
gantry outlines delete --ids 73,74,75
```

`--no-inherit` makes the duplicate a true clone (children copied) rather than a reference to the source.

---

## Styles, page settings, menu

```
gantry styles list -o default
gantry styles edit -o default styles[base][background]="#fafafa" styles[font][family-title]="Roboto"

gantry page list -o default
gantry page edit -o default page[body][attribs][class]="gantry site-sub withmaxwidth"

gantry menu list -m mainmenu
gantry menu edit -m mainmenu --id home -- title="Welcome"
```

Menu support is functional but less battle-tested; styles and page settings go through Gantry's dialog flow rather than the JSON-API path.

---

## Cross-site batches

Run any command against multiple sites in one invocation. Each site gets its own browser session, login, token, and backup folder. By default failures don't abort the batch — pass `--fail-fast` to stop on the first error.

```
# Inline list — credentials come from .env (per-site or global)
gantry --sites "https://site-a.com,https://site-b.com" outlines list

# JSON config (recommended for >2 sites or when each has its own creds)
cp sites.json.example sites.json    # then edit
gantry --sites-file sites.json layout backups list -o default
gantry --sites-file sites.json layout edit -o default --id contentarray-6583 -- particles[contentarray][title]="Common Title"
```

`sites.json` shape:

```jsonc
[
  { "site": "https://site-a.com" },
  { "site": "https://site-b.com",
    "user": "admin",                 // optional — overrides .env
    "pass": "secret",
    "theme": "studius" }
]
```

Credential lookup order: explicit override in sites.json → per-site env vars (e.g. `SITE_A_COM_USER` / `SITE_A_COM_PASS`) → global `GANTRY_ADMIN_USER` / `GANTRY_ADMIN_PASS`. Per-site env vars are derived from the host: uppercase, dots/dashes/colons → underscores.

When the command finishes, you get a summary like:

```
======================================================================
  Summary: 3 ok, 1 failed (of 4)
======================================================================
  ✗ https://broken.com — Login appears to have failed
```

`--dry-run` and `--no-backup` work the same way per site — diffs print individually, backups land under `./backups/<host>/`.

---

## MCP server (let an LLM drive these tools)

The repo also ships a Model Context Protocol server (`mcp-server.js`) that exposes the same operations as MCP tools an LLM client (Claude Desktop, Claude Code, custom agents) can call directly. Sessions are cached per-site so the LLM doesn't pay the login cost on every tool call.

Configure your MCP client to spawn the server. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gantry": {
      "command": "node",
      "args": ["C:\\path\\to\\Gantry 5 editor\\mcp-server.js"]
    }
  }
}
```

Tools exposed (each takes `site` plus operation-specific args):

```
gantry_outlines_list / duplicate / delete
gantry_layout_list / tree / sections / presets
gantry_layout_add / move / remove / edit
gantry_layout_section_edit / section_inherit / section_clone
gantry_layout_clear / copy_from / load_preset
gantry_layout_undo / backups_list
gantry_layout_export / import          (JSON; pair with the YAML CLI for portable files)
gantry_styles_list / edit
gantry_page_list / edit
```

All write tools accept `dryRun: true` and trigger an auto-backup before mutating, just like the CLI flags.

---

## Diagnostic helpers

```
gantry dump --view configurations            # any view's DOM/links/inputs
gantry dump-layout-json -o 75                # serialized layout + window state probes
gantry capture-traffic -o 75                 # log every gantry5 request until Ctrl+C
gantry capture-save-body -o 75 --id <particleId>     # capture a real save POST body
```

These wrote to `./discovery/` and helped reverse-engineer Gantry's AJAX flows. Useful if Gantry changes or you're investigating something new.

---

## How the JSON-API approach works

Gantry's layout manager exposes `window.G5.lm.builder.serialize()` which returns the full layout as a JSON array. Every mutation in this tool follows the same pattern:

1. Open `view=configurations/<outline>/layout`
2. `await page.evaluate(() => G5.lm.builder.serialize())` to get the structure
3. Mutate the JS object in Node (no DOM manipulation, no drag-drop)
4. POST to `view=configurations/<outline>/layout&format=json` with body `preset=<json>&layout=<json>`
5. Server responds with the saved structure

This means:
- No flaky drag-drop. Move / add / remove are deterministic.
- Inherited and disabled particles are still operable (we work on the JSON, not the dialog).
- Dry-run is just "skip step 4 and print a diff."
- Backup is just "write the result of step 2 to disk before step 4."

---

## Project layout

```
gantry.js                   # CLI entry (commander)
lib/
  session.js                # login + Configure click + token capture
  util.js                   # URL building, env lookup, screenshot helper
  layout.js                 # selectors + DOM helpers (list, available, fields, dialog edit)
  layout-api.js             # JSON-API: serialize, mutate, save, diff, copy, backups
  menu.js                   # menu editor + assignments
  styles.js                 # styles dialog
  page.js                   # page settings dialog
  outlines.js               # list / duplicate / delete / particle-defaults
  backup.js                 # snapshot + restore primitives
discovery/                  # captured traffic + DOM dumps used during dev
backups/                    # auto-snapshots before each mutation
screenshots/                # debug screenshots
```

---

## Gotchas

- **Grid and block IDs are randomized per page load.** Use stable section IDs (`navigation`, `expanded`, `footer`, etc.) as drop targets. `layout sections` lists them.
- **Inherited particles can't be edited via dialog** (they're locked in the UI). The JSON path can still patch them via batch/edit, but the change won't show until you break inheritance.
- **The base outline (`default`)** has Particle Defaults instead of Assignments. Non-default outlines have Assignments.
- **`copy-from` with `--no-inherit`** creates a true clone; without it, sections fall back to the source.
- **Backups don't get cleaned up automatically.** They accumulate in `./backups/`. Prune manually.
