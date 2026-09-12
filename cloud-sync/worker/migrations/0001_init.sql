-- ============================================================
-- 云端同步后端 D1 初始迁移
-- 账号体系 + 邮箱验证 + 会话 + 用户数据（歌单/歌曲）
-- MIDI 文件体暂存于 songs.data（BLOB）；storage 层支持切 R2。
-- ============================================================

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password        TEXT NOT NULL,          -- $pbkdf2$iter$salt$hash
  email_verified  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- 邮箱验证码（注册完发码，验证通过即标记邮箱已验证）
CREATE TABLE IF NOT EXISTS email_codes (
  email        TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- 登录会话（Bearer token 的 SHA-256 摘要）
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 歌曲（MIDI 文件体存 data BLOB；deleted=1 为删除墓碑，用于双向同步传播删除）
CREATE TABLE IF NOT EXISTS songs (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  data        BLOB,                       -- MIDI 原始字节
  meta        TEXT,                       -- JSON 元数据
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_songs_user ON songs(user_id, updated_at);

-- 歌单
CREATE TABLE IF NOT EXISTS playlists (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  song_ids    TEXT NOT NULL DEFAULT '[]', -- JSON 数组
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id, updated_at);