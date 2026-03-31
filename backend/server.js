const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');
const COURSES_FILE = path.join(__dirname, 'courses.json');

// Load or initialize data
let data = { games: {} };
try {
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (e) {
  console.log('Starting fresh data');
}

// Load courses
let courses = { courses: [] };
try {
  courses = JSON.parse(fs.readFileSync(COURSES_FILE, 'utf8'));
} catch (e) {
  console.log('No courses file');
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// === ROUTES ===

// Get all courses
app.get('/api/courses', (req, res) => {
  res.json(courses.courses);
});

// Get course by ID
app.get('/api/courses/:id', (req, res) => {
  const course = courses.courses.find(c => c.id === req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json(course);
});

// Get nearby holes based on GPS
app.get('/api/courses/:id/nearby', (req, res) => {
  const { lat, lng } = req.query;
  const course = courses.courses.find(c => c.id === req.params.id);
  
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  
  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);
  
  // Calculate distance to each hole
  const holesWithDistance = course.holes.map(hole => {
    const distance = calculateDistance(userLat, userLng, hole.lat, hole.lng);
    return { ...hole, distance };
  });
  
  // Sort by distance
  holesWithDistance.sort((a, b) => a.distance - b.distance);
  
  res.json(holesWithDistance.slice(0, 5)); // Return 5 nearest holes
});

// Haversine formula for distance
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distanceKm = R * c;
  return Math.round(distanceKm * 1000); // Return in meters
}

function toRad(deg) {
  return deg * (Math.PI/180);
}

// Create new game
app.post('/api/games', (req, res) => {
  const { courseName, adminName, adminPhone, adminPassword, gameType, buyIn, courseId } = req.body;
  const gameId = generateId();
  const now = new Date().toISOString();
  
  data.games[gameId] = {
    gameId,
    courseName: courseName || 'Golf Course',
    courseId: courseId || null,
    gameType: gameType || 'Nassau',
    buyIn: buyIn || 0,
    date: now.split('T')[0],
    created: now,
    admin: { name: adminName, phone: adminPhone, password: adminPassword },
    players: [],
    status: 'open',
    showLeaderboard: false,
    currentHole: 1
  };
  
  saveData();
  res.json({ gameId });
});

// Get game by ID
app.get('/api/games/:id', (req, res) => {
  const game = data.games[req.params.id];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  
  const response = { ...game };
  if (!response.showLeaderboard) {
    response.players = response.players.map(p => ({
      ...p,
      front9: p.front9 !== undefined ? '***' : null,
      back9: p.back9 !== undefined ? '***' : null,
      total: p.total !== undefined ? '***' : null
    }));
  }
  res.json(response);
});

// Register player
app.post('/api/games/:id/players', (req, res) => {
  const game = data.games[req.params.id];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.status !== 'open') return res.status(400).json({ error: 'Game already started' });
  
  const { name, phone, isScorekeeper } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  
  const player = {
    id: generateId(),
    name,
    phone: phone || '',
    isScorekeeper: isScorekeeper || false,
    front9: null,
    back9: null,
    total: null,
    payout: 0,
    scores: {}, // Hole-by-hole scores
    created: new Date().toISOString()
  };
  
  game.players.push(player);
  saveData();
  res.json(player);
});

// Admin login
app.post('/api/games/:id/login', (req, res) => {
  const game = data.games[req.params.id];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  
  const { password } = req.body;
  if (password !== game.admin.password) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ ok: true, adminName: game.admin.name });
});

// Update scores (by hole or total)
app.put('/api/games/:id/players/:playerId', (req, res) => {
  const game = data.games[req.params.id];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  
  const player = game.players.find(p => p.id === req.params.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  
  const { front9, back9, holeScore, holeNumber } = req.body;
  
  // Hole-by-hole score
  if (holeNumber !== undefined && holeScore !== undefined) {
    player.scores[holeNumber] = parseInt(holeScore);
  }
  
  if (front9 !== null && front9 !== undefined) player.front9 = parseInt(front9);
  if (back9 !== null && back9 !== undefined) player.back9 = parseInt(back9);
  
  // Auto-calculate total
  if (player.front9 !== null && player.back9 !== null) {
    player.total = player.front9 + player.back9;
  }
  
  saveData();
  res.json(player);
});

// Toggle leaderboard visibility
app.post('/api/games/:id/toggle-leaderboard', (req, res) => {
  const game = data.games[req.params.id];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  
  const { password } = req.body;
  if (password !== game.admin.password) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  game.showLeaderboard = !game.showLeaderboard;
  saveData();
  res.json({ showLeaderboard: game.showLeaderboard });
});

// Update game status
app.post('/api/games/:id/status', (req, res) => {
  const game = data.games[req.params.id];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  
  const { status, password, currentHole } = req.body;
  if (password !== game.admin.password) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  if (status) game.status = status;
  if (currentHole) game.currentHole = currentHole;
  
  saveData();
  res.json({ status: game.status, currentHole: game.currentHole });
});

// Calculate payouts
app.post('/api/games/:id/calculate-payouts', (req, res) => {
  const game = data.games[req.params.id];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  
  const { password, buyIn } = req.body;
  if (password !== game.admin.password) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  const players = game.players.filter(p => p.total !== null);
  if (players.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 players with scores' });
  }
  
  players.sort((a, b) => a.total - b.total);
  
  const entryFee = parseFloat(buyIn) || game.buyIn || 0;
  const pot = players.length * entryFee;
  
  game.players.forEach(p => p.payout = 0);
  
  if (pot > 0) {
    const winnerIndex = 0;
    game.players.find(p => p.id === players[winnerIndex].id).payout = pot;
  }
  
  saveData();
  res.json({ players: game.players, pot });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Golf app server running on port ' + PORT));
