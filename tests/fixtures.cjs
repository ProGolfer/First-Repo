'use strict';
// Fixed, hand-readable inputs for the scoring characterization tests.
// Each row is a golfer's strokes relative to par on holes 1..18.
const teams = [
  { id: 3, team_number: 1, team_name: 'Team 1' },
  { id: 4, team_number: 2, team_name: 'Team 2' },
  { id: 5, team_number: 3, team_name: 'Team 3' }
];
const offsets = {
  3: { 'p-A1': [-1,1,-2,0,2,-1,1,-2,0,2,-1,1,-2,0,2,-1,1,-2], 'p-A2': [2,0,-2,1,-1,2,0,-2,1,-1,2,0,-2,1,-1,2,0,-2],
       'p-A3': [0,-1,-2,2,1,0,-1,-2,2,1,0,-1,-2,2,1,0,-1,-2], 'p-A4': Array(18).fill(-2) },
  4: { 'p-B1': [2,0,-2,1,-1,2,0,-2,1,-1,2,0,-2,1,-1,2,0,-2], 'p-B2': [0,-1,-2,2,1,0,-1,-2,2,1,0,-1,-2,2,1,0,-1,-2],
       'p-B3': Array(18).fill(-2), 'p-B4': [1,2,-2,-1,0,1,2,-2,-1,0,1,2,-2,-1,0,1,2,-2] },
  5: { 'p-C1': [0,-1,-2,2,1,0,-1,-2,2,1,0,-1,-2,2,1,0,-1,-2], 'p-C2': Array(18).fill(-2),
       'p-C3': [1,2,-2,-1,0,1,2,-2,-1,0,1,2,-2,-1,0,1,2,-2], 'p-C4': [-1,1,-2,0,2,-1,1,-2,0,2,-1,1,-2,0,2,-1,1,-2] }
};
function makePlayers() {
  const out = [];
  for (const [team, ps] of Object.entries(offsets)) for (const id of Object.keys(ps)) out.push({ id, name: id.slice(2), status: 'approved', team: Number(team), score: null });
  return out;
}
module.exports = { teams, offsets, makePlayers };
