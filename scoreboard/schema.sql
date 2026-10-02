-- one row per score posted to the board
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL CHECK (game IN ('hoop', 'words')),
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_board ON scores (game, score DESC, created_at);
-- site analytics: one row per thing a visitor did (a visit, a knock-over, a game, a link click...)
-- visitor = a random anonymous id kept in that browser; visit = a random id per page load
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  host TEXT,        -- which site sent it (the test page's events are kept apart from the live site's)
  visitor TEXT NOT NULL,
  visit TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT,        -- small JSON details (a score, which link, where the visit came from...)
  label TEXT,       -- a device's name, set by a secret link (e.g. "alia", "dad")
  device TEXT,      -- phone / tablet / computer
  country TEXT, city TEXT,
  network TEXT      -- the organisation behind the connection (often an internet provider, sometimes a company)
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_visit ON events (visit);
CREATE INDEX IF NOT EXISTS events_event ON events (event, ts);

-- names Alia gives visitors she recognises (a friend, a recruiter...); unlike a device label, named people still count
CREATE TABLE IF NOT EXISTS names (
  visitor TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated INTEGER NOT NULL
);
