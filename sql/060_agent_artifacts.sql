-- Generated file delivery receipts. No credentials, binary data, or business messages.
CREATE TABLE IF NOT EXISTS bz_agent_artifacts (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  record_json JSON NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'pending',
  url TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (session_id, upload_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
