-- ============================================================
-- 问题反馈：提交记录 + 限流依据
-- 只记「谁在什么时候提交了哪一条」，install_id 是客户端生成的随机 UUID，
-- 不与账号/邮箱关联；附件字节在 R2，不落这张表。
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_log (
  id               TEXT PRIMARY KEY,
  install_id       TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL DEFAULT '',
  area             TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL DEFAULT '',
  file_path        TEXT NOT NULL DEFAULT '',
  issue_number     INTEGER NOT NULL DEFAULT 0,
  attachment_bytes INTEGER NOT NULL DEFAULT 0,
  attachments      TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  ip_hash          TEXT NOT NULL DEFAULT ''
);

-- 限流查的是「同一个 install_id 在时间窗内有多少条」，这个复合索引就是为它建的
CREATE INDEX IF NOT EXISTS idx_feedback_install_time ON feedback_log(install_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_log(created_at);
