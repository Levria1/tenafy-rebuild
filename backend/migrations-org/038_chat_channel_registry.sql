-- Per-org migration: register accepted public chat channels and alert on first sight.
--
-- The public fact API no longer hard-codes a channel list. It accepts any well-shaped
-- channel, records it here, and notifies staff the FIRST time one appears — so a typo'd
-- channel surfaces as an alert the same day instead of as duplicate inquiries weeks later
-- (`channel` is half the session identity, UNIQUE(channel, channel_user_id)).

CREATE TABLE IF NOT EXISTS chat_channel (
  id             BIGINT      NOT NULL,
  org_id         BIGINT      NOT NULL,
  channel        VARCHAR(20) NOT NULL,
  first_seen_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivery_count INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_chat_channel_org (org_id, channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the channels ALREADY in use so a live org does not alert on whatsapp/email/airbnb
-- the first time each is delivered to after this deploy.
--
-- The org id comes from `inquiry`, NOT from `organization`. A per-org database still
-- carries a full copy of the platform's `organization` table — 695 rows on the live org —
-- so joining it would seed 695 orgs' worth of junk and, with ids drawn from RAND() inside
-- one second, silently lose rows to primary-key collisions under INSERT IGNORE.
-- `inquiry.org_id` is a single value per org database (verified: 1).
--
-- Channels come from `chat_session` rather than a hard-coded list, so whatever an org
-- actually uses is covered. `staff-%` is excluded deliberately: those are the internal
-- assistant namespace, the public API now rejects them outright with `reserved_channel`,
-- and they can never arrive through the path this table describes.
--
-- delivery_count is backfilled from the session count — an approximation of historical
-- volume, not a true delivery tally, which only starts accruing from this deploy.
INSERT IGNORE INTO chat_channel (id, org_id, channel, delivery_count)
SELECT
  (UNIX_TIMESTAMP() * 1000000 + FLOOR(RAND() * 1000000)) AS id,
  o.org_id,
  c.channel,
  c.session_count
FROM (SELECT DISTINCT org_id FROM inquiry) o
JOIN (
  SELECT channel, COUNT(*) AS session_count
    FROM chat_session
   WHERE channel IS NOT NULL
     AND channel <> ''
     AND channel NOT LIKE 'staff-%'
     AND CHAR_LENGTH(channel) <= 20
   GROUP BY channel
) c;
