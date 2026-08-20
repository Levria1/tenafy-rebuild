-- 072_publish_public_faqs.sql  (PER-ORG)
--
-- Operator decision, 2026-08-20: public means public. An FAQ marked Public is published to the
-- marketing site as well as shared with the chatbot, and is unpublished individually when it
-- should not be. Remembering a second switch for every entry is how a website goes stale.
--
-- This backfills the entries that already exist. Deliberately narrow:
--   kind='faq'          rules are team instructions and are never customer-facing copy
--   status=1            archived entries stay archived
--
-- Note it does NOT look at `visibility`. The two audiences are independent: an entry can be on
-- the website without being handed to TaneChat, and the reverse.
--
-- Note this migration PUBLISHES CONTENT TO THE OPEN INTERNET for any org whose public FAQs were
-- written for the chatbot rather than for readers. At the time of writing that is 7 entries on
-- the live org and 0 elsewhere, all reviewed. Anything unsuitable is withdrawn with the Website
-- switch, which also clears automatically if the entry is later made Internal.
--
-- Idempotent: re-running sets the same rows to the value they already hold.

UPDATE chat_knowledge
   SET publish_website = 1
 WHERE kind = 'faq' AND status = 1 AND publish_website = 0;
