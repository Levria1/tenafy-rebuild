-- 071_chat_knowledge_property_and_website.sql (PER-ORG)
-- Property containment, independent website publication, fixed FAQ taxonomy.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_knowledge' AND COLUMN_NAME='publish_website');
SET @s := IF(@c=0, 'ALTER TABLE chat_knowledge ADD COLUMN publish_website TINYINT(1) NOT NULL DEFAULT 0 AFTER visibility', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_knowledge' AND COLUMN_NAME='category');
SET @s := IF(@c=0, 'ALTER TABLE chat_knowledge ADD COLUMN category VARCHAR(32) NOT NULL DEFAULT ''other'' AFTER kind', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_knowledge_property');
SET @s := IF(@t=0,
 'CREATE TABLE chat_knowledge_property (chat_knowledge_id BIGINT NOT NULL, property_id BIGINT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (chat_knowledge_id, property_id), KEY idx_ckp_property (property_id, chat_knowledge_id), CONSTRAINT fk_ckp_knowledge FOREIGN KEY (chat_knowledge_id) REFERENCES chat_knowledge(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
