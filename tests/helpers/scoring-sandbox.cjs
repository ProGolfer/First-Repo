'use strict';
const { loadApp } = require('./load-app.cjs');

const NAMES = [
  'CLIFFSIDE_HOLES', 'scoreToPoints', 'calculateHolePointsForScores', 'getHoleInfo',
  'getTodayKey', 'getLiveScoreStorageKey', 'loadTeamLiveScore', 'getTeamMoneyTotals',
  'getPlayerScorecardData', 'getTeamName', 'getAutoTeamCount', 'getApprovedPlayers',
  'getApprovedPlayerCount', 'getActiveTeamCount', 'getActiveTeams', 'getTeamScoreRows',
  'formatMoneyAmount', 'splitPoolAmongTeams', 'calculateMoneyGamePayouts', 'getFinalRecapData'
];

// Fresh sandbox holding the app's real scoring code and a fake appState.
function scoringSandbox({ players = [], teams = [], numTeams } = {}) {
  const appState = { players, teams, teamMode: 'manual', numTeams: numTeams || teams.length, selectedNumTeams: numTeams || teams.length };
  const sb = loadApp(NAMES, { appState, window: {} });
  const holes = sb.run('CLIFFSIDE_HOLES');
  // Same shape submitCurrentHole() writes for each submitted hole.
  function saveTeamRound(teamId, playerOffsets /* {playerId: [18 offsets from par]} */, { holesDone = 18 } = {}) {
    const scores = {};
    for (let h = 1; h <= holesDone; h++) {
      const par = holes[h - 1].par;
      const playerScores = {};
      for (const [pid, offs] of Object.entries(playerOffsets)) playerScores[pid] = par + offs[h - 1];
      scores[String(h)] = {
        hole: h, par, playerScores,
        holePoints: sb.ctx.calculateHolePointsForScores(playerScores, par),
        submittedAt: '2026-09-05T13:00:00.000Z'
      };
    }
    sb.localStorage.setItem(sb.run(`getLiveScoreStorageKey(${JSON.stringify(teamId)})`),
      JSON.stringify({ currentHole: Math.min(18, holesDone + 1), scores }));
  }
  return { ...sb, appState, holes, saveTeamRound };
}

module.exports = { scoringSandbox, NAMES };
