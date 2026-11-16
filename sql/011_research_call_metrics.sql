-- MySQL 8.0+
-- Measurements of each AI research call (one OpenRouter request per row). Run once after sql/010.
--
--   response_time_ms    request sent -> stream finished, in milliseconds
--   event_count         events OpenRouter sent on the stream ("OpenRouter 원본 이벤트" in the admin UI)
--   content_characters  characters of the answer the model generated ("N자 생성됨" in the admin UI)
--
-- Results stored before this migration were not measured and stay NULL.
USE aibom;

ALTER TABLE model_research_result
  ADD COLUMN response_time_ms   INT UNSIGNED NULL COMMENT 'OpenRouter call: request sent to stream finished, in ms' AFTER cost_usd,
  ADD COLUMN event_count        INT UNSIGNED NULL COMMENT 'events OpenRouter sent on the stream' AFTER response_time_ms,
  ADD COLUMN content_characters INT UNSIGNED NULL COMMENT 'characters of the answer the model generated' AFTER event_count;
