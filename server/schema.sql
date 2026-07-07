CREATE TABLE IF NOT EXISTS videos (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  youtube_url TEXT NOT NULL,
  youtube_video_id TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE videos ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS videos_is_active_idx ON videos (is_active);
CREATE INDEX IF NOT EXISTS videos_sort_order_idx ON videos (sort_order, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS playlists (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playlist_videos (
  playlist_id BIGINT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (playlist_id, video_id)
);

CREATE INDEX IF NOT EXISTS playlists_sort_order_idx ON playlists (sort_order, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS playlist_videos_video_idx ON playlist_videos (video_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  phone TEXT,
  identity_type TEXT NOT NULL DEFAULT 'phone',
  identity_value TEXT,
  session_id TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (identity_type IN ('phone', 'line'))
);

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS identity_type TEXT NOT NULL DEFAULT 'phone';
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS identity_value TEXT;
UPDATE user_sessions
SET identity_type = 'phone',
    identity_value = phone
WHERE identity_value IS NULL
  AND phone IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_sessions_pkey'
      AND conrelid = 'user_sessions'::regclass
  ) THEN
    ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_pkey;
  END IF;
END $$;

ALTER TABLE user_sessions ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE user_sessions ALTER COLUMN identity_type SET NOT NULL;
ALTER TABLE user_sessions ALTER COLUMN identity_value SET NOT NULL;

CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx ON user_sessions (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_identity_idx ON user_sessions (identity_type, identity_value);

CREATE TABLE IF NOT EXISTS membership_requests (
  id BIGSERIAL PRIMARY KEY,
  line_user_id TEXT NOT NULL UNIQUE,
  line_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS membership_requests_status_idx ON membership_requests (status, created_at DESC);

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) - 1 AS next_order
  FROM videos
)
UPDATE videos
SET sort_order = ordered.next_order
FROM ordered
WHERE videos.id = ordered.id
  AND NOT EXISTS (
    SELECT 1
    FROM videos existing_order
    WHERE existing_order.sort_order <> 0
  );
