-- 073_chat_knowledge_image.sql (PER-ORG)
-- Structured public FAQ images.

SET @t := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_knowledge_image');
SET @s := IF(@t=0,
 'CREATE TABLE chat_knowledge_image (id BIGINT NOT NULL, chat_knowledge_id BIGINT NOT NULL, file_id BIGINT NOT NULL, caption VARCHAR(255) NULL, sort_order INT NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id), KEY idx_cki_knowledge (chat_knowledge_id), CONSTRAINT fk_cki_knowledge FOREIGN KEY (chat_knowledge_id) REFERENCES chat_knowledge(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
