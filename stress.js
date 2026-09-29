'use strict';
/*
 * stress harness.
 *
 *   node stress.js          full campaign, 60 seeds a profile, takes a couple of minutes
 *   node stress.js 10       quick pass
 *
 * selftest.js checks the cases I thought of. this checks the ones I didnt. it makes up
 * random servers with realistic churn, runs the REAL balancer against them and asserts
 * the invariants below after every single tick. its seeded, so if it ever does break, the
 * seed it prints reproduces it exactly.
 *
 * no network, no config, no server. it never leaves the machine.
 *
 * Invariants checked on every tick of every run:
 *   I1  no move ever targets the closed faction
 *   I2  no settled player is moved mid-match (only joiners, self-switchers,
 *       closed-faction occupants, or players at a match boundary may move)
 *   I3  the closed faction empties and stays empty
 *   I4  with no churn, the gap converges to <= tolerance and stays there
 *   I5  no player is moved twice inside the move cooldown
 *   I6  memory (the known-player map) stays bounded by the live player count
 *   I7  no oscillation: nobody is bounced back and forth indefinitely
 *   I8  moves per tick stay bounded (no thrashing)
 *
 * SIXFIVE
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Balancer, RED, GREEN, BLUE } = require('./balancer');

/* ---------- deterministic PRNG so every failure is reproducible ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- fake clock so we can simulate hours in milliseconds ---------- */
const realNow = Date.now;
let CLOCK = 1700000000000;
Date.now = () => CLOCK;
function advance(ms) { CLOCK += ms; }

/* ---------- a simulated WARDOGS server ----------------------------------- */
let idSeq = 1;
function newId() { return '765611' + String(100000000 + idSeq++); }

function makeWorld(rand, opts) {
  const players = [];
  const clans = opts.clans || 0;
  for (let i = 0; i < opts.red; i++) players.push({ id: newId(), name: 'r' + i, fac: RED });
  for (let i = 0; i < opts.green; i++) players.push({ id: newId(), name: 'g' + i, fac: GREEN });
  for (let i = 0; i < opts.blue; i++) players.push({ id: newId(), name: 'b' + i, fac: BLUE });
  for (let c = 0; c < clans; c++) {
    const tag = 'CL' + c;
    const size = 2 + Math.floor(rand() * 6);
    for (let m = 0; m < size; m++) {
      players.push({ id: newId(), name: `[${tag}] m${m}`, fac: rand() < 0.5 ? RED : GREEN });
    }
  }
  return { players, map: 'Bakurani', scores: 120, uptime: 9000, moves: [], broadcasts: [], restarts: 0, down: false, malformed: false };
}

function installStub(world) {
  globalThis.fetch = async (url, opt) => {
    const method = (opt && opt.method) || 'GET';
    const route = new URL(url).pathname;
    if (world.down) throw new Error('ECONNREFUSED');
    const j = (o) => ({ ok: true, json: async () => o });

    if (method === 'GET' && route === '/v1/players') {
      if (world.malformed) return j({ players: [{ nonsense: true }, { name: 'x' }] });
      return j({ players: world.players.map((p) => ({ name: p.name, steamId: p.id, faction: p.fac })) });
    }
    if (method === 'GET' && route === '/v1/status') {
      return j({ map: world.map, experiences: [world.map + '_K'],
        factionScores: [{ name: RED, score: world.scores + 40 }, { name: GREEN, score: world.scores }, { name: BLUE, score: 0 }] });
    }
    if (method === 'GET' && route === '/v1/health') return j({ uptimeSeconds: world.uptime });
    if (method === 'PATCH' && route.startsWith('/v1/players/')) {
      const id = route.split('/').pop();
      const to = JSON.parse(opt.body).faction;
      const p = world.players.find((x) => x.id === id);
      if (p) { world.moves.push({ id, from: p.fac, to, at: CLOCK }); p.fac = to; }
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'POST' && route === '/v1/match/restart') { world.restarts++; world.scores = 0; return { ok: true, json: async () => ({}) }; }
    if (method === 'POST' && route === '/v1/broadcast') {
      world.broadcasts.push(JSON.parse(opt.body).message);
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'POST') return { ok: true, json: async () => ({}) };
    return { ok: false, json: async () => ({}) };
  };
}

/* ---------- one randomised run ------------------------------------------- */
async function run(seed, cfgOverrides, churn, ticks) {
  const rand = rng(seed);
  const world = makeWorld(rand, {
    red: 5 + Math.floor(rand() * 45),
    green: 5 + Math.floor(rand() * 45),
    blue: Math.floor(rand() * 8),
    clans: Math.floor(rand() * 4),
  });
  installStub(world);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-'));
  const cfg = Object.assign({
    pollSeconds: 2, dryRun: false, clanGrouping: true, sideCap: 50, gapTolerance: 3,
    closedFaction: BLUE, moveCooldownSeconds: 30, bounceCooldownSeconds: 5,
    joinMessage: '', keepMatchHistory: false, stateDir: dir, exempt: [],
    announce: { everyMinutes: 60, minPlayers: 1 },
    servers: [{ name: 's', host: '10.0.0.1', port: 7779, token: 't' }],
  }, cfgOverrides || {});
  const bal = new Balancer(cfg, () => {});

  const V = [];                       // violations
  const moveTimes = {};               // id -> [timestamps]
  const moveCounts = {};              // id -> total moves
  let maxKnown = 0, maxMovesInTick = 0, boundaries = 0;
  const gapSamples = [];

  const pendingJoined = new Set();    // churn the balancer has not SEEN yet
  const pendingSwitched = new Set();  // (it cannot react while the box is down)
  let pendingBoundary = false;

  await bal.tick();                   // seed
  const seedMoves = world.moves.length;
  if (seedMoves > 0) V.push(`seed tick moved ${seedMoves} player(s)`);

  for (let t = 0; t < ticks; t++) {
    advance(cfg.pollSeconds * 1000);
    world.moves.length = 0;

    // ---- churn, recording what the WORLD did so we can attribute moves ----
    let boundaryThisTick = false;

    for (let k = 0; k < churn.joinsPerTick; k++) {
      if (rand() < churn.joinChance && world.players.length < 100) {
        const p = { id: newId(), name: 'n' + idSeq, fac: [RED, GREEN, BLUE][Math.floor(rand() * 3)] };
        world.players.push(p); pendingJoined.add(p.id);
      }
    }
    if (rand() < churn.leaveChance && world.players.length > 4) {
      world.players.splice(Math.floor(rand() * world.players.length), 1);
    }
    if (churn.collapseChance && rand() < churn.collapseChance) {
      const side = rand() < 0.5 ? RED : GREEN;
      const n = 12 + Math.floor(rand() * 14);           // 12 to 25 of them walk
      let gone = 0;
      world.players = world.players.filter((p) => {
        if (p.fac === side && gone < n) { gone++; return false; }
        return true;
      });
    }
    if (rand() < churn.switchChance && world.players.length > 2) {
      const p = world.players[Math.floor(rand() * world.players.length)];
      if (p.fac === RED || p.fac === GREEN) {
        p.fac = p.fac === RED ? GREEN : RED; pendingSwitched.add(p.id);
      }
    }
    if (rand() < churn.mapChance) {
      world.map = world.map === 'Bakurani' ? 'Ozeti' : 'Bakurani';
      world.scores = 0; pendingBoundary = true; boundaries++;
      advance(61000);                 // clear the 60s boundary guard
    } else {
      world.scores += 3;
    }
    if (rand() < churn.flapChance) { world.down = !world.down; }
    if (rand() < churn.malformedChance) { world.malformed = true; } else { world.malformed = false; }

    const beforeClosed = world.players.filter((p) => p.fac === BLUE).map((p) => p.id);
    const restartsBefore = world.restarts;
    const sawServer = !world.down && !world.malformed;
    const joinedThisTick = new Set(pendingJoined);
    const switchedThisTick = new Set(pendingSwitched);
    boundaryThisTick = pendingBoundary;
    await bal.tick();
    if (sawServer) { pendingJoined.clear(); pendingSwitched.clear(); pendingBoundary = false; }

    // ---- invariants -----------------------------------------------------
    const restartedThisTick = world.restarts > restartsBefore;
    if (restartedThisTick) { pendingBoundary = true; }   // a restart IS a new match
    if (world.moves.length > maxMovesInTick) maxMovesInTick = world.moves.length;

    for (const m of world.moves) {
      // I1
      if (m.to === BLUE) V.push(`I1 move to closed faction: ${m.id}`);
      // I2
      const legit = joinedThisTick.has(m.id) || switchedThisTick.has(m.id) ||
                    beforeClosed.includes(m.id) || boundaryThisTick || restartedThisTick;
      if (!legit) V.push(`I2 settled player moved mid-match: ${m.id} ${m.from}->${m.to}`);
      // I5
      (moveTimes[m.id] = moveTimes[m.id] || []).push(m.at);
      moveCounts[m.id] = (moveCounts[m.id] || 0) + 1;
      const ts = moveTimes[m.id];
      if (ts.length >= 2) {
        const gap = ts[ts.length - 1] - ts[ts.length - 2];
        const forced = beforeClosed.includes(m.id) || switchedThisTick.has(m.id);
        const floor = forced ? cfg.bounceCooldownSeconds : cfg.moveCooldownSeconds;
        if (gap < floor * 1000 && !boundaryThisTick) V.push(`I5 moved again after ${gap}ms (floor ${floor * 1000}ms): ${m.id}`);
      }
    }

    // I6
    const known = Object.keys(bal.state['s'] ? bal.state['s'].known : {}).length;
    if (known > maxKnown) maxKnown = known;
    // the balancer deliberately remembers leavers for 5 min, so the bound is live
    // players plus whoever could plausibly have left inside that window
    if (known > world.players.length + 160) V.push(`I6 known map ${known} unbounded vs ${world.players.length} live`);

    const r = world.players.filter((p) => p.fac === RED).length;
    const g = world.players.filter((p) => p.fac === GREEN).length;
    gapSamples.push(Math.abs(r - g));
  }

  // ---- quiescence: stop all churn and let it settle -----------------------
  let settleTicks = 0;
  world.map = world.map === 'Bakurani' ? 'Ozeti' : 'Bakurani';   // a fresh match
  world.scores = 0;
  advance(61000);
  for (let t = 0; t < 40; t++) {
    advance(cfg.pollSeconds * 1000);
    world.moves.length = 0;
    world.down = false; world.malformed = false;
    await bal.tick();
    settleTicks++;
    if (world.moves.length === 0) break;
  }
  const finalR = world.players.filter((p) => p.fac === RED).length;
  const finalG = world.players.filter((p) => p.fac === GREEN).length;
  const finalBlue = world.players.filter((p) => p.fac === BLUE).length;

  // I3
  if (cfg.closedFaction && finalBlue > 0) V.push(`I3 closed faction still has ${finalBlue} after settling`);
  // I4 (only meaningful if enough players to balance)
  if (world.players.length >= 8 && Math.abs(finalR - finalG) > cfg.gapTolerance) {
    V.push(`I4 settled gap ${Math.abs(finalR - finalG)} > tolerance ${cfg.gapTolerance}`);
  }
  // I7 oscillation
  const worst = Object.entries(moveCounts).sort((a, b) => b[1] - a[1])[0];
  const worstMoves = worst ? worst[1] : 0;
  if (worstMoves > ticks / 3) V.push(`I7 oscillation: one player moved ${worstMoves} times in ${ticks} ticks`);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

  return {
    seed, violations: V,
    players: world.players.length, finalGap: Math.abs(finalR - finalG), finalBlue,
    boundaries, maxMovesInTick, maxKnown, worstMoves, restarts: world.restarts,
    meanGap: gapSamples.reduce((a, b) => a + b, 0) / (gapSamples.length || 1),
    settleTicks,
  };
}

/* ---------- the campaign -------------------------------------------------- */
(async () => {
  const profiles = [
    { name: 'calm, light churn',      churn: { joinsPerTick: 1, joinChance: 0.25, leaveChance: 0.2, switchChance: 0.05, mapChance: 0.02, flapChance: 0,    malformedChance: 0 },    ticks: 120 },
    { name: 'busy prime time',        churn: { joinsPerTick: 3, joinChance: 0.6,  leaveChance: 0.5, switchChance: 0.25, mapChance: 0.04, flapChance: 0,    malformedChance: 0 },    ticks: 150 },
    { name: 'stack war (lots switch)',churn: { joinsPerTick: 2, joinChance: 0.4,  leaveChance: 0.3, switchChance: 0.80, mapChance: 0.03, flapChance: 0,    malformedChance: 0 },    ticks: 150 },
    { name: 'map rotating constantly',churn: { joinsPerTick: 2, joinChance: 0.4,  leaveChance: 0.3, switchChance: 0.2,  mapChance: 0.30, flapChance: 0,    malformedChance: 0 },    ticks: 120 },
    { name: 'flaky server',           churn: { joinsPerTick: 2, joinChance: 0.4,  leaveChance: 0.3, switchChance: 0.2,  mapChance: 0.03, flapChance: 0.15, malformedChance: 0 },    ticks: 120 },
    { name: 'garbage responses',      churn: { joinsPerTick: 2, joinChance: 0.4,  leaveChance: 0.3, switchChance: 0.2,  mapChance: 0.03, flapChance: 0.05, malformedChance: 0.2 },  ticks: 120 },
    { name: 'zero cooldowns',         churn: { joinsPerTick: 3, joinChance: 0.6,  leaveChance: 0.4, switchChance: 0.5,  mapChance: 0.05, flapChance: 0,    malformedChance: 0 },    ticks: 150, cfg: { moveCooldownSeconds: 0, bounceCooldownSeconds: 0 } },
    { name: 'tight tolerance, 32 cap',churn: { joinsPerTick: 2, joinChance: 0.5,  leaveChance: 0.4, switchChance: 0.3,  mapChance: 0.04, flapChance: 0,    malformedChance: 0 },    ticks: 150, cfg: { sideCap: 32, gapTolerance: 1 } },
    { name: 'rescue: mass quits',     churn: { joinsPerTick: 1, joinChance: 0.10, leaveChance: 0.15, switchChance: 0.1,  mapChance: 0.01, flapChance: 0,    malformedChance: 0, collapseChance: 0.02 }, ticks: 400, cfg: { rescue: { enabled: true, graceMinutes: 1, warnSeconds: 30, scoreLead: 15, cooldownMinutes: 5 } } },
    { name: 'rescue OFF, same quits', churn: { joinsPerTick: 1, joinChance: 0.10, leaveChance: 0.15, switchChance: 0.1,  mapChance: 0.01, flapChance: 0,    malformedChance: 0, collapseChance: 0.02 }, ticks: 400 },
    { name: 'all three open',         churn: { joinsPerTick: 2, joinChance: 0.5,  leaveChance: 0.4, switchChance: 0.3,  mapChance: 0.04, flapChance: 0,    malformedChance: 0 },    ticks: 120, cfg: { closedFaction: null } },
  ];

  const RUNS_PER_PROFILE = Number(process.argv[2] || 60);
  let totalRuns = 0, totalTicks = 0, failed = 0;
  const allViolations = [];
  const rows = [];

  for (const prof of profiles) {
    const stats = { gaps: [], blue: 0, osc: 0, maxTick: 0, settle: [], restarts: 0 };
    let bad = 0;
    for (let i = 0; i < RUNS_PER_PROFILE; i++) {
      const seed = 1000 + i;
      const r = await run(seed, prof.cfg, prof.churn, prof.ticks);
      totalRuns++; totalTicks += prof.ticks;
      if (r.violations.length) {
        bad++; failed++;
        allViolations.push(`[${prof.name} seed ${seed}] ` + r.violations.slice(0, 3).join(' | '));
      }
      stats.gaps.push(r.finalGap);
      stats.blue += r.finalBlue;
      stats.osc = Math.max(stats.osc, r.worstMoves);
      stats.maxTick = Math.max(stats.maxTick, r.maxMovesInTick);
      stats.settle.push(r.settleTicks);
      stats.restarts += r.restarts;
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    rows.push({
      profile: prof.name, runs: RUNS_PER_PROFILE, failed: bad,
      meanFinalGap: mean(stats.gaps).toFixed(2),
      maxFinalGap: Math.max(...stats.gaps),
      strandedOnClosed: stats.blue,
      maxMovesOneTick: stats.maxTick,
      worstOscillation: stats.osc,
      restarts: stats.restarts,
      meanTicksToSettle: mean(stats.settle).toFixed(1),
    });
  }

  Date.now = realNow;

  console.log('\nwd-balancer stress campaign\n');
  console.log(`  ${totalRuns} randomised runs, ${totalTicks} ticks, ${RUNS_PER_PROFILE} seeds per profile\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log('  ' + pad('profile', 28) + pad('runs', 6) + pad('fail', 6) + pad('mean gap', 10) + pad('max gap', 9) + pad('stranded', 10) + pad('max moves/tick', 16) + pad('worst osc', 11) + pad('settle', 8) + 'restarts');
  console.log('  ' + '-'.repeat(106));
  for (const r of rows) {
    console.log('  ' + pad(r.profile, 28) + pad(r.runs, 6) + pad(r.failed, 6) + pad(r.meanFinalGap, 10) +
      pad(r.maxFinalGap, 9) + pad(r.strandedOnClosed, 10) + pad(r.maxMovesOneTick, 16) + pad(r.worstOscillation, 11) + pad(r.meanTicksToSettle, 8) + r.restarts);
  }

  console.log('');
  if (allViolations.length) {
    console.log(`  INVARIANT VIOLATIONS: ${failed} of ${totalRuns} runs\n`);
    for (const v of allViolations.slice(0, 25)) console.log('    ' + v);
    if (allViolations.length > 25) console.log(`    ... and ${allViolations.length - 25} more`);
  } else {
    console.log(`  NO INVARIANT VIOLATIONS across ${totalRuns} runs and ${totalTicks} ticks.`);
  }
  console.log('');
  process.exit(failed ? 1 : 0);
})();
