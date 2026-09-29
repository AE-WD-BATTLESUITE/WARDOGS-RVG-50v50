#!/usr/bin/env node
'use strict';
/*
 * selftest. fakes a whole WARDOGS server in memory so every rule can be proven
 * with out going anywhere near a real game.
 *
 *   node selftest.js
 *
 * run this before you trust the thing on a live box. dont take my word for any
 * of it, the whole point is that you can check it yourself.
 *
 * no network, no config, no server needed. it never leaves the machine.
 *
 * every case in here is a line out the readme. if you change the logic and one
 * of these fails then the readme is now lying, so fix which ever of the two is
 * wrong.
 *
 * SIXFIVE
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Balancer, RED, GREEN, BLUE, STANDING_LINE } = require('./balancer');

let pass = 0, fail = 0;
const results = [];

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`); }
}

/* ---------- the fake server -----------------------------------------------
 * just enough of the API to fool the balancer. it remembers who got moved so we
 * can check the desicions after. this is the bit that means you dont have to
 * point it at anything real to see if it works. */
function fakeServer(opts) {
  return {
    players: opts.players.slice(),
    map: opts.map || 'Bakurani',
    scores: opts.scores == null ? 100 : opts.scores,
    uptime: opts.uptime == null ? 5000 : opts.uptime,
    moves: [],
    messages: [],
    broadcasts: [],
    restarts: 0,
    scoreLead: 0,
  };
}

function installStub(world) {
  globalThis.fetch = async (url, opt) => {
    const method = (opt && opt.method) || 'GET';
    const u = new URL(url);
    const route = u.pathname;
    const srv = world;

    const json = (o) => ({ ok: true, json: async () => o });

    if (method === 'GET' && route === '/v1/players') {
      return json({ players: srv.players.map((p) => ({ name: p.name, steamId: p.id, faction: p.fac })) });
    }
    if (method === 'GET' && route === '/v1/status') {
      return json({
        map: srv.map,
        experiences: [srv.map + '_KOTH_01'],
        factionScores: [
          { name: RED, score: srv.scores + (srv.scoreLead || 0) },
          { name: GREEN, score: srv.scores },
          { name: BLUE, score: 0 },
        ],
      });
    }
    if (method === 'GET' && route === '/v1/health') return json({ uptimeSeconds: srv.uptime });

    if (method === 'PATCH' && route.startsWith('/v1/players/')) {
      const id = route.split('/').pop();
      const body = JSON.parse(opt.body);
      const p = srv.players.find((x) => x.id === id);
      if (p) { srv.moves.push({ id, from: p.fac, to: body.faction }); p.fac = body.faction; }
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'POST' && route.endsWith('/message')) {
      srv.messages.push(route.split('/')[3]);
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'POST' && route === '/v1/match/restart') {
      srv.restarts++;
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'POST' && route === '/v1/broadcast') {
      srv.broadcasts.push(JSON.parse(opt.body).message);
      return { ok: true, json: async () => ({}) };
    }
    return { ok: false, json: async () => ({}) };
  };
}

function makeBalancer(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdb-'));
  const cfg = Object.assign({
    pollSeconds: 1, dryRun: false, clanGrouping: true,
    sideCap: 50, gapTolerance: 3, closedFaction: BLUE,
    moveCooldownSeconds: 0, bounceCooldownSeconds: 0,
    joinMessage: 'hello', keepMatchHistory: false, stateDir: dir,
    servers: [{ name: 'test', host: '127.0.0.1', port: 1, token: 't' }],
  }, overrides || {});
  return { bal: new Balancer(cfg, () => {}), cfg, dir };
}

/* build a block of players. the offset per faction has to be distinct or green and
 * blue end up sharing steam ids and you spend an hour blaming the balancer for what
 * is actualy a broken test. voice of experiance. */
function team(n, fac, prefix) {
  const base = fac === RED ? 100000 : fac === GREEN ? 200000 : 300000;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: String(base + i), name: `${prefix || 'P'}${i}`, fac });
  return out;
}

/* ---------- scenarios ------------------------------------------------------ */
(async () => {

  // 1. first look never moves anyone, however bad the teams are. this is the one
  //    that stops it wreaking a live round the second you install it.
  {
    const world = fakeServer({ players: [...team(40, RED), ...team(10, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();
    check('seeding an uneven server moves nobody', world.moves.length, 0);
  }

  // 2. someone turns up, they go to the emptier side.
  {
    const world = fakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();                                    // seed
    world.players.push({ id: '999001', name: 'Newcomer', fac: RED });
    await bal.tick();
    check('new joiner sent to the lighter side', world.moves.map(m => [m.id, m.to]), [['999001', GREEN]]);
  }

  // 3. third side is shut, so anyone who picks it gets moved.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();
    world.players.push({ id: '999002', name: 'BlueGuy', fac: BLUE });
    await bal.tick();
    const m = world.moves[0];
    check('player on the closed faction is moved off', [world.moves.length, m && m.from, m && m.to !== BLUE], [1, BLUE, true]);
  }

  // 4. settled players stay put even when it goes lopsided. this is the promise.
  {
    const world = fakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();                                    // everyone settled at 30/20
    await bal.tick();
    await bal.tick();
    check('settled players are never moved mid-match', world.moves.length, 0);
  }

  // 5. someone stacks onto the big side. back you go.
  {
    const world = fakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();
    const jumper = world.players.find((p) => p.fac === GREEN);
    jumper.fac = RED;                                    // they switched themselves onto the big side
    await bal.tick();
    check('switching onto the heavier side is bounced back', world.moves.map(m => [m.from, m.to]), [[RED, GREEN]]);
  }

  // 6. someone volenteers for the small side. good lad, leave him alone.
  {
    const world = fakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();
    const jumper = world.players.find((p) => p.fac === RED);
    jumper.fac = GREEN;                                  // moving to the small side, fine
    await bal.tick();
    check('switching toward the lighter side is allowed', world.moves.length, 0);
  }

  // 7. map changes, teams get sorted. nobodys mid fight at a map change.
  {
    const world = fakeServer({ players: [...team(35, RED), ...team(15, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();                                    // seed at 35/15
    world.map = 'Ozeti';                                 // map rotated: new match
    await bal.tick();
    const after = { red: world.players.filter(p => p.fac === RED).length, green: world.players.filter(p => p.fac === GREEN).length };
    check('teams are evened at a match boundary', Math.abs(after.red - after.green) <= 3, true);
  }

  // 8. the cap is the cap.
  {
    const world = fakeServer({ players: [...team(50, RED), ...team(40, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer({ sideCap: 50 });
    await bal.tick();
    world.players.push({ id: '999003', name: 'Latecomer', fac: RED });   // 51st on red
    await bal.tick();
    check('a joiner cannot push a side past the cap', world.moves.map(m => m.to), [GREEN]);
  }

  // 9. clan turns up, gets put with the rest of the clan.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN)] });
    world.players.push({ id: '888001', name: '[WOLF] One', fac: GREEN });
    world.players.push({ id: '888002', name: '[WOLF] Two', fac: GREEN });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();                                    // seed, clan sits on green
    world.players.push({ id: '888003', name: '[WOLF] Three', fac: RED });
    await bal.tick();
    check('a clan member joins their clan', world.moves.map(m => [m.id, m.to]), [['888003', GREEN]]);
  }

  // 10. but not if that would blow the cap. mates is nice, 51 v 43 is not.
  {
    const world = fakeServer({ players: [...team(49, RED), ...team(50, GREEN, 'G')] });
    world.players[60].name = '[WOLF] Anchor';            // clan sits on the full green side
    installStub(world);
    const { bal } = makeBalancer({ sideCap: 50 });
    await bal.tick();
    world.players.push({ id: '888004', name: '[WOLF] Late', fac: RED });
    await bal.tick();
    const moved = world.moves.find(m => m.id === '888004');
    check('clan grouping yields to the cap', moved ? moved.to : 'not moved', 'not moved');
  }

  // 11. dry run thinks hard and does nothing.
  {
    const world = fakeServer({ players: [...team(30, RED), ...team(20, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer({ dryRun: true });
    await bal.tick();
    world.players.push({ id: '999004', name: 'Ghost', fac: RED });
    await bal.tick();
    check('dry run moves nobody', [world.moves.length, world.messages.length], [0, 0]);
  }

  // 12. restart it and it remembers, instead of rearanging a live match.
  {
    const world = fakeServer({ players: [...team(35, RED), ...team(15, GREEN)] });
    installStub(world);
    const { bal, cfg } = makeBalancer();
    await bal.tick();                                    // seed uneven, settled
    bal.stop();                                          // writes state
    const revived = new Balancer(cfg, () => {});         // "restart"
    await revived.tick();
    check('a restart resumes and does not reshuffle', world.moves.length, 0);
  }

  // 13. welcome message once. nobody wants it every two seconds.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();
    world.players.push({ id: '999005', name: 'Chatty', fac: GREEN });
    await bal.tick();
    await bal.tick();
    await bal.tick();
    check('join message sent once per player', world.messages.filter(x => x === '999005').length, 1);
  }

  // 14. closedFaction null and the third side is nobodys business.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN)] });
    installStub(world);
    const { bal } = makeBalancer({ closedFaction: null });
    await bal.tick();
    world.players.push({ id: '999006', name: 'Blue', fac: BLUE });
    await bal.tick();
    check('with no closed faction the third side is left alone', world.moves.length, 0);
  }

  // 15. it NEVER puts anyone on the closed side. not once, not ever, whatever the
  //     teams look like. hammering it here because this is the one that would be
  //     embarasing to get wrong on somebody elses server.
  {
    let everSentToClosed = false;
    for (const [r, g, b] of [[50, 2, 6], [2, 50, 6], [25, 25, 20], [49, 49, 4], [1, 1, 40], [40, 3, 9]]) {
      const world = fakeServer({ players: [...team(r, RED), ...team(g, GREEN, 'G'), ...team(b, BLUE, 'B')] });
      installStub(world);
      const { bal } = makeBalancer();
      await bal.tick();
      world.map = 'Ozeti';           // force a boundary so everyone gets re placed
      await bal.tick();
      await bal.tick();
      if (world.moves.some((m) => m.to === BLUE)) everSentToClosed = true;
      if (world.players.some((p) => p.fac === BLUE)) everSentToClosed = true;
    }
    check('never moves anyone onto the closed side, across 6 messy servers', everSentToClosed, false);
  }

  // 16. only ever red or green. every move target, every scenario.
  {
    const world = fakeServer({ players: [...team(38, RED), ...team(6, GREEN, 'G'), ...team(8, BLUE, 'B')] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();
    world.map = 'Ozeti';
    await bal.tick();
    const targets = [...new Set(world.moves.map((m) => m.to))].sort();
    check('every move target is red or green only', targets, [GREEN, RED].sort());
  }

  // 17. clan gets pulled back together at a match boundry, not just on join.
  {
    const world = fakeServer({ players: [...team(24, RED), ...team(24, GREEN, 'G')] });
    // a clan of 4 split down the middle, 2 each side
    world.players.push({ id: '777001', name: '[OWLS] a', fac: RED });
    world.players.push({ id: '777002', name: '[OWLS] b', fac: RED });
    world.players.push({ id: '777003', name: '[OWLS] c', fac: GREEN });
    world.players.push({ id: '777004', name: '[OWLS] d', fac: GREEN });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();
    world.map = 'Ozeti';
    await bal.tick();
    await bal.tick();
    const owls = world.players.filter((p) => p.name.startsWith('[OWLS]'));
    const onRed = owls.filter((p) => p.fac === RED).length;
    check('a split clan ends up more together than it started', Math.max(onRed, 4 - onRed) >= 3, true);
  }

  // 18. the anouncement does NOT fire the moment you start it up.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    installStub(world);
    const { bal } = makeBalancer({ announce: { everyMinutes: 60, message: 'come to my discord' } });
    await bal.tick();
    await bal.tick();
    check('no announcement on startup', world.broadcasts.length, 0);
  }

  // 19. it does fire once the clock is up, and only once.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    installStub(world);
    const { bal } = makeBalancer({ announce: { everyMinutes: 60, message: 'come to my discord' } });
    await bal.tick();
    // wind the clock back an hour and a bit
    bal.state['test'].lastAnnounceAt = Date.now() - 61 * 60000;
    await bal.tick();
    await bal.tick();
    await bal.tick();
    check('announces once when due, then waits again', world.broadcasts, ['come to my discord']);
  }

  // 20. leave announce.message alone and you get the default line.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    installStub(world);
    const { bal } = makeBalancer({ announce: { everyMinutes: 60 } });
    await bal.tick();
    bal.state['test'].lastAnnounceAt = 0;
    await bal.tick();
    check('with no message set, the default line goes out', world.broadcasts, [STANDING_LINE]);
  }

  // 20b. put your own line in and yours is used.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    installStub(world);
    const { bal } = makeBalancer({ announce: { everyMinutes: 60, message: 'MYCLAN.COM - come and play' } });
    await bal.tick();
    bal.state['test'].lastAnnounceAt = 0;
    await bal.tick();
    check('your own message replaces the default', world.broadcasts, ['MYCLAN.COM - come and play']);
  }

  // 20c. empty message and it never sends anything at all.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    installStub(world);
    const { bal } = makeBalancer({ announce: { everyMinutes: 60, message: '' } });
    await bal.tick();
    bal.state['test'].lastAnnounceAt = 0;
    await bal.tick();
    await bal.tick();
    check('an empty message turns announcements off completly', world.broadcasts.length, 0);
  }

  // 21. dry run doesnt shout at anyone either.
  {
    const world = fakeServer({ players: [...team(25, RED), ...team(25, GREEN, 'G')] });
    installStub(world);
    const { bal } = makeBalancer({ dryRun: true, announce: { everyMinutes: 60, message: 'hello' } });
    await bal.tick();
    bal.state['test'].lastAnnounceAt = 0;
    await bal.tick();
    check('dry run does not send announcements', world.broadcasts.length, 0);
  }

  // 22. blue, hammered. people keep turning up on the closed side every single
  //     tick for 12 ticks, across a map change. nobody should ever be sat on it
  //     when the dust settles and nobody should ever be SENT there.
  {
    const world = fakeServer({ players: [...team(30, RED), ...team(18, GREEN, 'G')] });
    installStub(world);
    const { bal } = makeBalancer();
    await bal.tick();
    let sentToClosed = 0, strandedTicks = 0, n = 0;
    for (let t = 0; t < 12; t++) {
      // two fresh idiots pick blue every tick
      world.players.push({ id: String(400000 + n++), name: 'blue' + t + 'a', fac: BLUE });
      world.players.push({ id: String(400000 + n++), name: 'blue' + t + 'b', fac: BLUE });
      if (t === 6) world.map = 'Ozeti';          // map change halfway through
      await bal.tick();
      await bal.tick();                          // settle
      if (world.players.some((p) => p.fac === BLUE)) strandedTicks++;
      sentToClosed += world.moves.filter((m) => m.to === BLUE).length;
      world.moves.length = 0;
    }
    check('12 ticks of people picking blue: never sent there, never left there',
      [sentToClosed, strandedTicks], [0, 0]);
  }

  // 23. an exempt admin is never touched. stacks the big side, sits there.
  {
    const world = fakeServer({ players: [...team(30, RED), ...team(18, GREEN, 'G')] });
    world.players.push({ id: '555001', name: 'TheAdmin', fac: RED });
    installStub(world);
    const { bal } = makeBalancer({ exempt: ['555001'] });
    await bal.tick();
    world.map = 'Ozeti';
    await bal.tick();
    await bal.tick();
    const moved = world.moves.some((m) => m.id === '555001');
    const stillRed = world.players.find((p) => p.id === '555001').fac === RED;
    check('exempt admin is never moved, even at a match boundry', [moved, stillRed], [false, true]);
  }

  // 24. exempt admin can hop sides to go and watch somebody, no bounce.
  {
    const world = fakeServer({ players: [...team(30, RED), ...team(18, GREEN, 'G')] });
    world.players.push({ id: '555002', name: 'TheAdmin', fac: GREEN });
    installStub(world);
    const { bal } = makeBalancer({ exempt: ['555002'] });
    await bal.tick();
    world.players.find((p) => p.id === '555002').fac = RED;   // hops onto the big side
    await bal.tick();
    await bal.tick();
    check('exempt admin can switch onto the heavy side without being put back',
      world.moves.filter((m) => m.id === '555002').length, 0);
  }

  // 25. exempting somebody doesnt stop the closed side being cleared for everyone else
  {
    const world = fakeServer({ players: [...team(24, RED), ...team(24, GREEN, 'G'), ...team(5, BLUE, 'B')] });
    world.players.push({ id: '555003', name: 'TheAdmin', fac: RED });
    installStub(world);
    const { bal } = makeBalancer({ exempt: ['555003'] });
    await bal.tick();
    await bal.tick();
    await bal.tick();
    const blueLeft = world.players.filter((p) => p.fac === BLUE && p.id !== '555003').length;
    check('exempting one person does not break the closed side clear', blueLeft, 0);
  }

  // 26. REGRESSION. a stress run found this: one empty/dud player list used to wipe
  //     the memory, and the next good tick re placed everybody mid match. on a
  //     lopsided server that yanked 10 settled players out of a fight.
  {
    const world = fakeServer({ players: [...team(40, RED), ...team(18, GREEN, 'G')] });
    installStub(world);
    const realFetch = globalThis.fetch;
    const { bal } = makeBalancer();
    await bal.tick();                       // seed 40 v 18, everyone settled
    const knownAfterSeed = Object.keys(bal.state['test'].known).length;

    // one dud response, as if the api hiccupped mid match
    globalThis.fetch = async (url, opt) => {
      if (String(url).endsWith('/v1/players')) return { ok: true, json: async () => ({ players: [] }) };
      return realFetch(url, opt);
    };
    await bal.tick();
    const knownAfterBlip = Object.keys(bal.state['test'].known).length;

    globalThis.fetch = realFetch;
    world.moves.length = 0;
    await bal.tick();                       // back to normal

    check('one dud player list does not wipe memory or reshuffle a live match',
      [knownAfterSeed, knownAfterBlip, world.moves.length], [58, 58, 0]);
  }

  // ---- the rescue: warn, give them a chance, then restart the round ----------
  // helper: drive a world to a given score lead and run the clock forward
  async function rescueRun(red, green, lead, opts) {
    const world = fakeServer({ players: [...team(red, RED), ...team(green, GREEN, 'G')] });
    world.scoreLead = lead;
    installStub(world);
    const { bal } = makeBalancer(Object.assign({
      rescue: { enabled: true, graceMinutes: 3, warnSeconds: 90, scoreLead: 15 },
    }, opts || {}));
    await bal.tick();                                   // seed
    bal.state['test'].lopsidedSince = Date.now() - 4 * 60000;   // grace allready served
    await bal.tick();                                   // -> should warn
    const warned = world.broadcasts.length;
    bal.state['test'].warnedAt = Date.now() - 91 * 1000;        // window expired
    await bal.tick();                                   // -> should restart
    return { warned, restarts: world.restarts, world, bal };
  }

  // 27. the numbers the founder called FINE must never trigger
  {
    const fine = [[59, 48], [40, 30], [50, 40], [45, 40], [30, 20]];
    let anyFired = false;
    for (const [r, g] of fine) {
      const out = await rescueRun(r, g, 40);
      if (out.warned || out.restarts) anyFired = true;
    }
    check('teams the founder called fine are never restarted', anyFired, false);
  }

  // 28. the numbers he called NOT fine must warn, then restart
  {
    const bad = [[40, 25], [45, 23], [50, 30]];
    let allWarned = true, allRestarted = true;
    for (const [r, g] of bad) {
      const out = await rescueRun(r, g, 40);
      if (!out.warned) allWarned = false;
      if (!out.restarts) allRestarted = false;
    }
    check('badly lopsided teams get warned then restarted', [allWarned, allRestarted], [true, true]);
  }

  // 29. lopsided but still a close game: leave it alone, its not hurting anyone
  {
    const out = await rescueRun(45, 23, 5);             // lead of 5, under the 15
    check('lopsided but close on score is left alone', [out.warned, out.restarts], [0, 0]);
  }

  // 30. if they do as they are told and even it up, the match carries on
  {
    const world = fakeServer({ players: [...team(45, RED), ...team(23, GREEN, 'G')] });
    world.scoreLead = 40;
    installStub(world);
    const { bal } = makeBalancer({ rescue: { enabled: true, graceMinutes: 3, warnSeconds: 90, scoreLead: 15 } });
    await bal.tick();
    bal.state['test'].lopsidedSince = Date.now() - 4 * 60000;
    await bal.tick();                                   // warned
    // 11 people do the decent thing and switch to the small side
    let moved = 0;
    for (const p of world.players) { if (p.fac === RED && moved < 11) { p.fac = GREEN; moved++; } }
    bal.state['test'].warnedAt = Date.now() - 91 * 1000;
    await bal.tick();
    check('if players even it up themselves, no restart happens', world.restarts, 0);
  }

  // 31. off by default. nobody elses match gets restarted uninvited.
  {
    const world = fakeServer({ players: [...team(45, RED), ...team(23, GREEN, 'G')] });
    world.scoreLead = 40;
    installStub(world);
    const { bal } = makeBalancer();                     // no rescue block at all
    await bal.tick();
    bal.state['test'].lopsidedSince = Date.now() - 10 * 60000;
    bal.state['test'].warnedAt = Date.now() - 10 * 60000;
    await bal.tick();
    await bal.tick();
    check('rescue is off unless you switch it on', [world.broadcasts.length, world.restarts], [0, 0]);
  }

  /* 34 and 35 drive the real index.js instead of a copy of its logic. a test that
   * re implements the thing its testing passes happily while the actual file is
   * broken, which is how the shallow merge slipped past me in the first place.
   */
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdb-cfg-'));
  const accepts = (obj) => {
    const f = path.join(cfgDir, 'c' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(f, JSON.stringify(obj));
    return spawnSync(process.execPath, [path.join(__dirname, 'index.js'), f, '--check'],
                     { encoding: 'utf8' }).status === 0;
  };
  const good = (extra) => Object.assign(
    { servers: [{ name: 's', host: '10.0.0.5', port: 7779, token: 'Hx8kQ2mVp' }] }, extra || {});

  // 34. REGRESSION. setting ONE key inside announce or rescue used to wipe the rest
  //     of that block, becuase the config merge was shallow. the readme literally
  //     tells people to write { "rescue": { "enabled": true } } and it was rejected.
  check('setting one key keeps the rest of that block',
    [accepts(good({ rescue: { enabled: true } })), accepts(good({ announce: { message: 'mine' } }))],
    [true, true]);

  // 35. every placeholder printed in the readme, the wiki or the example config has to
  //     bounce off --check. if one of them sails through, the first thing somebody sees
  //     is a connection error with no clue in it, and they blame the tool.
  {
    // that last one looks like a fake IP and isnt. its real, routable, and belongs to
    // somebody, which is exactly why its in here. nothing in this list is ever contacted,
    // the test is that every one of them gets refused.
    const hosts  = ['YOUR.IP', 'OTHER.IP', '203.0.113.10', '198.51.100.4', '192.0.2.7', '123.45.67.89'];
    const tokens = ['PUT_YOUR_RCON_PASSWORD_HERE', 'PUT_THE_PASSWORD_HERE',
                    'the-password-from-step-1', '...', 'changeme', 'xxxx'];
    const leaked = [
      ...hosts.filter((x) => accepts({ servers: [{ name: 's', host: x, port: 7779, token: 'Hx8kQ2mVp' }] })),
      ...tokens.filter((x) => accepts({ servers: [{ name: 's', host: '10.0.0.5', port: 7779, token: x }] })),
    ];
    check('every placeholder in the docs is rejected by --check', leaked, []);
    check('a config with real values is still accepted', accepts(good()), true);
  }
  fs.rmSync(cfgDir, { recursive: true, force: true });

  console.log('\nwd-balancer self-test\n');
  console.log(results.join('\n'));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
