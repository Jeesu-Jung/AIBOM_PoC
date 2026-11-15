-- MySQL 8.0+
-- Where inside the source a value is stated (table / figure number, section), so a reviewer can go
-- straight to it. Filled for evaluation results. Run once after sql/007.
USE aibom;

ALTER TABLE model_evidence
  ADD COLUMN locator VARCHAR(500) NULL
    COMMENT 'place inside the source: "Table 2 (Main results), row ..., column ...", "Section 4.2"'
    AFTER url;
