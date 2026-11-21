-- MySQL 8.0+
-- Let the artifact format and the tensor type hold up to 500 characters. Run once after sql/012.
--
-- The research model sometimes describes the artifact in a sentence ("The repository includes
-- audio_projector.safetensors and auxiliary files, not the base weights."), which
-- did not fit VARCHAR(100) and kept the draft from being saved.
--
-- Widening a VARCHAR keeps every stored value as it is. Neither column is indexed.
USE aibom;

ALTER TABLE model_info
  MODIFY COLUMN artifact_format VARCHAR(500) NULL,
  MODIFY COLUMN tensor_type VARCHAR(500) NULL;