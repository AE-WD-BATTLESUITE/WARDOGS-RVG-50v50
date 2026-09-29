#!/usr/bin/env node
'use strict';
/*
 * startup. read the config, moan about anything obviously wrong, start the loop.
 *   --check     validate and exit
 *   --dry-run   deside everything, move nobody
 *
 * the validation is deliberatly shouty. the worst failure this has is not
 * crashing, its sitting there all night looking alive and balancing absolutly
 * nothing because a port was a string.
 *
 * SIXFIVE
 */

const fs = require('fs');
const path = require('path');
const { Balancer, FACTIONS } = require('./balancer');

const DEFAULTS = {
  pollSeconds: 2,
  dryRun: false,
  clanGrouping: true,
  sideCap: 50,
  gapTolerance: 3,
  closedFaction: 'Lonestar',
  moveCooldownSeconds: 30,
  bounceCooldownSeconds: 5,
  joinMessage: '',
  announce: { everyMinutes: 60, minPlayers: 10 },
  exempt: [],
  rescue: { enabled: false, minPlayers: 20, minorityShare: 0.40, minGap: 8,
            scoreLead: 15, graceMinutes: 3, warnSeconds: 90, cooldownMinutes: 15 },
  keepMatchHistory: true,
  stateDir: './state',
  servers: [],
};

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(...a) {
  console.log(`[${stamp()}]`, ...a);
}
function die(msg) {
  console.error(`\n  config error: ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const fileArg = args.find((a) => !a.startsWith('--'));
const configPath = path.resolve(fileArg || 'config.json');

if (!fs.existsSync(configPath)) {
  die(
    `no config at ${configPath}\n` +
    `  copy config.example.json to config.json and put your servers in it.`
  );
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  // nine times out of ten this is a trailing coma
  die(`${configPath} is not valid JSON: ${e.message}`);
}

const cfg = Object.assign({}, DEFAULTS, raw);
/* Object.assign is shallow, so `"rescue": { "enabled": true }` in somebodys config
 * REPLACES the whole default rescue block and takes minorityShare, minGap and the
 * rest with it. The validator then rejects a config the readme told them to write.
 * So merge the nested blocks properly. */
for (const k of ['announce', 'rescue']) {
  cfg[k] = Object.assign({}, DEFAULTS[k], raw[k] || {});
}
if (flags.has('--dry-run')) cfg.dryRun = true;

/* work out stateDir from where the config file is, not from where ever the shell
 * happens to be stood. systemd starts you in / and then your state ends up in
 * /state and you spend an hour wondering why it re seeds on every boot. */
cfg.stateDir = path.resolve(path.dirname(configPath), cfg.stateDir);

/* ---------- validation ----------------------------------------------------- */
if (!Array.isArray(cfg.servers) || cfg.servers.length === 0) {
  die('no servers configured. put at least one in "servers".');
}

const seen = new Set();
cfg.servers.forEach((s, i) => {
  const where = `servers[${i}]`;
  if (!s.name) die(`${where} needs a "name". any label you like, it shows in the logs.`);
  // the name keys the saved state, so two the same would share one
  if (seen.has(s.name)) die(`two servers are both called "${s.name}". names have to be unique.`);
  seen.add(s.name);
  if (s.enabled === false) return;
  if (!s.host) die(`${where} ("${s.name}") needs a "host".`);
  if (!s.port) die(`${where} ("${s.name}") needs a "port". thats the RCON port, not the game port.`);

  // name an env var instead if you dont want the password in a file
  if (!s.token && s.tokenEnv) {
    const v = process.env[s.tokenEnv];
    if (!v) die(`${where} ("${s.name}") points at env var ${s.tokenEnv} but its not set in this shell.`);
    s.token = v;
  }
  if (!s.token) die(`${where} ("${s.name}") needs a "token" (your RCON password) or a "tokenEnv" naming an env var that holds it.`);

  /* people copy the example, run --check, get told its fine, then wonder why it
   * cant connect. catch the placeholder so the error lands where the mistake is. */
  if (/^(PUT_|YOUR_|CHANGE_|the-password|\.{2,}$|xxx+$|password$|changeme$)/i.test(String(s.token).trim())) {
    die(`${where} ("${s.name}") still has the example password in it (${s.token}).
` +
        `  put your real RCON password there. its the one from your servers
` +
        `  [/Script/WDRCON.WDRCONSettings] block, not your game or admin password.`);
  }
  /* every placeholder we print anywhere. the readme and the wiki say YOUR.IP, the
   * example config uses the documentation ranges. none of them go anywhere, so say
   * so here rather than leaving somebody staring at a dns error at 2am. */
  const h = String(s.host).trim();
  if (/^(203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|123\.45\.67\.)/.test(h) || /^(your|other)\.ip$/i.test(h)) {
    die(`${where} ("${s.name}") still has the example host ${s.host} in it.
` +
        `  thats a placeholder, it goes nowhere. put your servers real IP there, the
` +
        `  same address people type to connect.`);
  }
  const cap = s.sideCap != null ? s.sideCap : cfg.sideCap;
  if (!(cap > 0)) die(`${where} ("${s.name}") has a sideCap of ${cap}, which would be a quiet server.`);
});

if (cfg.closedFaction && !FACTIONS.includes(cfg.closedFaction)) {
  die(`closedFaction "${cfg.closedFaction}" is not one of: ${FACTIONS.join(', ')}. use null to leave all three open.`);
}
if (!(cfg.gapTolerance >= 0)) die('gapTolerance has to be 0 or more.');

// exempt list has to be steam ids, not names. names change, ids dont.
for (const list of [cfg.exempt, ...cfg.servers.map((s) => s.exempt)]) {
  if (list == null) continue;
  if (!Array.isArray(list)) die('"exempt" has to be a list of steam ids in [ ] brackets.');
  for (const id of list) {
    if (!/^\d{15,20}$/.test(String(id).trim())) {
      die(`exempt list has "${id}" in it. that needs to be a steam id (the long number), not a name.`);
    }
  }
}
{
  // stop somebody setting it to every 2 minutes and getting the whole server to
  // mute chat, which makes the anouncement worthless and annoys everyone.
  const a = cfg.announce || {};
  const sending = a.message === undefined || String(a.message).trim() !== '';
  if (sending && !(Number(a.everyMinutes) >= 5)) {
    die('announce.everyMinutes has to be 5 or more. once an hour is plenty.');
  }
}
if (!(cfg.pollSeconds >= 1)) die('pollSeconds has to be at least 1. be kind to your server.');

if (cfg.rescue && cfg.rescue.enabled) {
  const R = cfg.rescue;
  // these restart peoples matches, so a fat finger here is expensive
  if (!(R.minorityShare > 0.10 && R.minorityShare < 0.50)) {
    die('rescue.minorityShare has to be between 0.10 and 0.50. 0.40 means the small side must be 40% of the server.');
  }
  if (!(R.minPlayers >= 10)) die('rescue.minPlayers has to be 10 or more. dont restart matches on a quiet server.');
  if (!(R.minGap >= 4)) die('rescue.minGap has to be 4 or more.');
  if (!(R.graceMinutes >= 1)) die('rescue.graceMinutes has to be at least 1. give it a chance to recover first.');
  if (!(R.warnSeconds >= 15)) die('rescue.warnSeconds has to be at least 15. people need time to actually switch.');
  if (cfg.closedFaction === null) die('rescue needs a closed faction. with three sides open the maths does not mean anything.');
}

/* the mistake everyone makes once. walk up looking for a .git and check the
 * config is actualy ignored. reads .gitignore only, never shells out to git. */
(function warnIfConfigIsInARepo() {
  try {
    const base = path.basename(configPath);
    let dir = path.dirname(configPath);
    for (let hops = 0; hops < 6; hops++) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        let ignored = false;
        for (const g of [path.join(path.dirname(configPath), '.gitignore'), path.join(dir, '.gitignore')]) {
          if (!fs.existsSync(g)) continue;
          const rules = fs.readFileSync(g, 'utf8').split(/\r?\n/).map((l) => l.trim());
          if (rules.some((l) => l && !l.startsWith('#') && !l.startsWith('!') &&
              (l === base || l === '/' + base || (l.includes('*') && new RegExp('^' + l.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(base))))) {
            ignored = true;
          }
        }
        if (!ignored) {
          console.error('');
          console.error('  ******************************************************************');
          console.error('  *  WARNING: ' + base + ' holds your RCON password and it is       ');
          console.error('  *  sat in a git repo WITHOUT being ignored.                       ');
          console.error('  *                                                                 ');
          console.error('  *  add this to .gitignore before you push anything:               ');
          console.error('  *      ' + base);
          console.error('  *                                                                 ');
          console.error('  *  if it is allready pushed, change the RCON password on your      ');
          console.error('  *  server first. that is what actualy closes the hole.            ');
          console.error('  ******************************************************************');
          console.error('');
        }
        return;
      }
      const up = path.dirname(dir);
      if (up === dir) return;
      dir = up;
    }
  } catch (e) { /* a warning that crashes the app is worse than no warning */ }
})();

const active = cfg.servers.filter((s) => s.enabled !== false);
if (flags.has('--check')) {
  console.log(`config OK: ${active.length} server(s) enabled, cap ${cfg.sideCap} a side, ` +
    `tolerance ${cfg.gapTolerance}, closed side ${cfg.closedFaction || 'none'}, ` +
    `clan grouping ${cfg.clanGrouping ? 'on' : 'off'}` +
    `${(cfg.exempt || []).length ? ', ' + cfg.exempt.length + ' exempt' : ''}` +
    `${(cfg.rescue || {}).enabled ? ', rescue ON (restarts at <' + Math.round(cfg.rescue.minorityShare * 100) + '% a side)' : ', rescue off'}` +
    `${(cfg.announce || {}).message !== undefined && String(cfg.announce.message).trim() === ''
        ? ', announcements off'
        : ', announcing every ' + cfg.announce.everyMinutes + 'min'}` +
    `${cfg.dryRun ? ', DRY RUN' : ''}.`);
  process.exit(0);
}

// dont let one bad responce kill it at 2am
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => log('uncaughtException:', e && e.message ? e.message : e));


// before the balancer, so the state line it prints has context
log(`config: ${configPath}`);
log(`state:  ${cfg.stateDir}`);

const bal = new Balancer(cfg, log);

// save on the way out or a restart re seeds
function shutdown(sig) {
  log(`${sig}, saving state and stopping.`);
  bal.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

bal.start();
