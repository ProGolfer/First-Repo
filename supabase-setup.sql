-- Run these SQL statements in your Supabase SQL Editor to set up the database

-- Players table
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  handicap TEXT,
  status TEXT DEFAULT 'pending',
  approved_at TEXT,
  team TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Teams table
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  captain TEXT,
  front_score INTEGER DEFAULT 0,
  back_score INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  submitted BOOLEAN DEFAULT FALSE,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS (Row Level Security) - optional but recommended
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Allow public read/write access (for now)
CREATE POLICY "Allow public access to players" ON players FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public access to teams" ON teams FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public access to settings" ON settings FOR ALL USING (true) WITH CHECK (true);
