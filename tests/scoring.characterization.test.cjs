'use strict';
// Step 0 — characterization tests. These pin down TODAY's scoring behaviour using the
// real functions from netlify/index.html. They must keep passing unchanged through every phase.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { scoringSandbox } = require('./helpers/scoring-sandbox.cjs');
const { index } = require('./helpers/load-app.cjs');
const fx = require('./fixtures.cjs');

function fullDay() {
  const sb = scoringSandbox({ players: fx.makePlayers(), teams: fx.teams });
  for (const t of [3, 4, 5]) sb.saveTeamRound(t, fx.offsets[t]);
  return sb;
}

test('scoreToPoints: eagle+ 4, birdie 3, par 2, bogey 1, double+ 0', () => {
  const { ctx } = scoringSandbox();
  const cases = [[2, 4, 4], [1, 5, 4], [2, 5, 4], [3, 4, 3], [4, 4, 2], [5, 4, 1], [6, 4, 0], [9, 4, 0], [1, 3, 4], [3, 5, 4], [4, 5, 3]];
  for (const [score, par, pts] of cases) assert.equal(ctx.scoreToPoints(score, par), pts, `score ${score} on par ${par}`);
});

test('calculateHolePointsForScores: best 3 of the team, any extras are ignored', () => {
  const { ctx } = scoringSandbox();
  // par 4: birdie(3) par(2) bogey(1) eagle(4) -> best three = 4+3+2
  assert.equal(ctx.calculateHolePointsForScores({ a: 3, b: 4, c: 5, d: 2 }, 4), 9);
  // only 3 golfers: all count
  assert.equal(ctx.calculateHolePointsForScores({ a: 4, b: 4, c: 4 }, 4), 6);
  // fewer than 3 golfers: just what exists
  assert.equal(ctx.calculateHolePointsForScores({ a: 3, b: 5 }, 4), 4);
  // five golfers: still only best three
  assert.equal(ctx.calculateHolePointsForScores({ a: 4, b: 4, c: 4, d: 4, e: 4 }, 4), 6);
  // everyone blows up: zero
  assert.equal(ctx.calculateHolePointsForScores({ a: 8, b: 9, c: 7, d: 8 }, 4), 0);
  assert.equal(ctx.calculateHolePointsForScores({}, 4), 0);
});

test('GOLDEN Best 3 Front / Back / Total per team (also checked against an independent reference)', () => {
  const sb = fullDay();
  const golden = { 3: { front: 82, back: 83, total: 165 }, 4: { front: 81, back: 82, total: 163 }, 5: { front: 83, back: 81, total: 164 } };
  for (const t of [3, 4, 5]) assert.deepEqual({ ...sb.ctx.getTeamMoneyTotals(t) }, golden[t], `team ${t}`);

  // Independent re-implementation straight from the rules, to catch a wrong golden value.
  const pts = d => (d <= -2 ? 4 : d === -1 ? 3 : d === 0 ? 2 : d === 1 ? 1 : 0);
  for (const t of [3, 4, 5]) {
    let front = 0, back = 0;
    for (let h = 0; h < 18; h++) {
      const best3 = Object.values(fx.offsets[t]).map(o => pts(o[h])).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
      if (h < 9) front += best3; else back += best3;
    }
    assert.deepEqual({ ...sb.ctx.getTeamMoneyTotals(t) }, { front, back, total: front + back });
  }
});

test('GOLDEN individual 18-hole scorecards: strokes and points for Front, Back and Total', () => {
  const sb = fullDay();
  // [frontStrokes, backStrokes, totalStrokes, frontPts, backPts, totalPts, holesCompleted]
  const golden = {
    'p-A1': [34, 36, 70, 20, 18, 38, 18], 'p-A2': [37, 35, 72, 17, 19, 36, 18], 'p-A3': [35, 34, 69, 19, 20, 39, 18], 'p-A4': [18, 18, 36, 36, 36, 72, 18],
    'p-B1': [37, 35, 72, 17, 19, 36, 18], 'p-B2': [35, 34, 69, 19, 20, 39, 18], 'p-B3': [18, 18, 36, 36, 36, 72, 18], 'p-B4': [36, 37, 73, 18, 17, 35, 18],
    'p-C1': [35, 34, 69, 19, 20, 39, 18], 'p-C2': [18, 18, 36, 36, 36, 72, 18], 'p-C3': [36, 37, 73, 18, 17, 35, 18], 'p-C4': [34, 36, 70, 20, 18, 38, 18]
  };
  for (const [id, g] of Object.entries(golden)) {
    const c = sb.ctx.getPlayerScorecardData(id);
    assert.deepEqual([c.frontScore, c.backScore, c.totalScore, c.frontPoints, c.backPoints, c.totalPoints, c.completed], g, id);
    assert.equal(c.holes.length, 18);
    assert.equal(c.front.length, 9);
    assert.equal(c.back.length, 9);
  }
});

test('a half-finished round only counts submitted holes; unplayed holes show null', () => {
  const sb = scoringSandbox({ players: fx.makePlayers(), teams: fx.teams });
  sb.saveTeamRound(3, fx.offsets[3], { holesDone: 5 });
  const t = sb.ctx.getTeamMoneyTotals(3);
  assert.equal(t.back, 0);
  assert.ok(t.front > 0 && t.front < 82);
  assert.equal(t.total, t.front);
  const c = sb.ctx.getPlayerScorecardData('p-A1');
  assert.equal(c.completed, 5);
  assert.equal(c.holes[5].score, null);
  assert.equal(c.back.every(h => h.score === null), true);
  // another team with nothing saved
  assert.deepEqual({ ...sb.ctx.getTeamMoneyTotals(4) }, { front: 0, back: 0, total: 0 });
});

test("one team's scores never leak into another team's totals", () => {
  const sb = scoringSandbox({ players: fx.makePlayers(), teams: fx.teams });
  sb.saveTeamRound(4, fx.offsets[4]);
  assert.deepEqual({ ...sb.ctx.getTeamMoneyTotals(3) }, { front: 0, back: 0, total: 0 });
  assert.equal(sb.ctx.getTeamMoneyTotals(4).total, 163);
});

test('payouts: 25% front, 25% back, 50% total; winners take their pool', () => {
  const { ctx } = scoringSandbox();
  const row = (id, front, back, total, n = 4) => ({ team: { id }, players: Array(n).fill({}), front, back, total });
  const rows = [row(3, 82, 83, 165), row(4, 81, 82, 163), row(5, 83, 81, 164)];
  const r = ctx.calculateMoneyGamePayouts(rows, 240);
  assert.equal(r.everyTeamTied, false);
  assert.deepEqual([r.frontMoney, r.backMoney, r.totalMoney], [60, 60, 120]);
  assert.deepEqual({ ...r.payouts.get('3') }, { front: 0, back: 60, total: 120, refund: 0, grandTotal: 180 });
  assert.deepEqual({ ...r.payouts.get('5') }, { front: 60, back: 0, total: 0, refund: 0, grandTotal: 60 });
  assert.equal(r.payouts.get('4').grandTotal, 0);
  const paid = [...r.payouts.values()].reduce((s, p) => s + p.grandTotal, 0);
  assert.equal(paid, 240);
});

test('payouts: a Front or Back tie splits that pool to the cent', () => {
  const { ctx } = scoringSandbox();
  const row = (id, front, back, total) => ({ team: { id }, players: Array(4).fill({}), front, back, total });
  const r = ctx.calculateMoneyGamePayouts([row(1, 80, 70, 150), row(2, 80, 75, 155), row(3, 70, 80, 151)], 100);
  assert.equal(r.everyTeamTied, false);
  assert.equal(r.payouts.get('1').front, 12.5);
  assert.equal(r.payouts.get('2').front, 12.5);
  const split = ctx.splitPoolAmongTeams(10, [{ team: { id: 1 } }, { team: { id: 2 } }, { team: { id: 3 } }]);
  assert.deepEqual([...split.values()], [3.34, 3.33, 3.33]);
});

test('payouts: if any two teams tie on Total, everyone gets their $20 back', () => {
  const { ctx } = scoringSandbox();
  const row = (id, total) => ({ team: { id }, players: Array(4).fill({}), front: 80, back: total - 80, total });
  const r = ctx.calculateMoneyGamePayouts([row(1, 160), row(2, 160), row(3, 150)], 240);
  assert.equal(r.everyTeamTied, true);
  for (const id of ['1', '2', '3']) assert.equal(r.payouts.get(id).grandTotal, 80);
});

test('final recap: only exists once every team has an official score; uses the team total', () => {
  const sb = fullDay();
  assert.equal(sb.ctx.getFinalRecapData(), null);
  // The captain's "Submit Final" stores the team total on each player's `score`.
  for (const p of sb.appState.players) p.score = sb.ctx.getTeamMoneyTotals(p.team).total;
  const recap = sb.ctx.getFinalRecapData();
  assert.equal(recap.teams, 3);
  assert.equal(recap.players, 12);
  assert.equal(recap.pot, 240);
  assert.deepEqual(recap.standings.map(r => Number(r.team.id)), [3, 5, 4]);
  assert.equal(recap.payoutData.payouts.get('3').grandTotal, 180);
  assert.ok(recap.mvp && recap.mvp.totalPoints === 72);
});

// If one of these protected functions changes, this fails on purpose: scoring must be changed deliberately,
// never as a side effect of the profile / registration / scorekeeper work. Update the hashes only with Gabe's OK.
test('PROTECTED scoring functions are byte-for-byte unchanged', () => {
  const { decls } = index();
  const protectedNames = ['CLIFFSIDE_HOLES', 'scoreToPoints', 'calculateHolePointsForScores', 'getTeamMoneyTotals', 'getFrontTotal',
    'getBackTotal', 'getRoundTotal', 'getPlayerScorecardData', 'calculateMoneyGamePayouts', 'splitPoolAmongTeams', 'getTeamScoreRows',
    'getFinalRecapData', 'buildCanonicalHistoryPayload', 'currentRoundOfficialRows', 'adjustHoleScore', 'getCurrentHolePlayerScores'];
  const hashes = {};
  for (const n of protectedNames) {
    assert.ok(decls.has(n), `${n} missing`);
    hashes[n] = crypto.createHash('sha256').update(decls.get(n).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
  }
  assert.deepEqual(hashes, require('./scoring-hashes.json'));
});
