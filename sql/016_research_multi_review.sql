-- MySQL 8.0+
-- Let several reviewers review one AI research run and save the majority answer. Run once after sql/015.
--
--   model_research_review  one row per (run, reviewer): the assignment, and the answer once submitted
--   model_research_run     + the state of the save that starts when every reviewer has submitted
--
-- A run is saved from its reviews when all of them are submitted: each value is the one most
-- reviewers chose, and the values they tied on are merged by the AI (finalize_status = 'merging').
--
-- model_research_run.reviewer_id / assigned_at are no longer read: the assignment lives in
-- model_research_review. The columns are kept (nothing is dropped here); reviewed_by still names
-- the reviewer of runs saved before this migration.
USE aibom;

CREATE TABLE IF NOT EXISTS model_research_review (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id       BIGINT UNSIGNED NOT NULL,
  reviewer_id  BIGINT UNSIGNED NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'assigned' COMMENT 'assigned | submitted',
  review_json  JSON NULL COMMENT 'the submitted answer: { model, aibom, evidence }',
  assigned_at  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  submitted_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_model_research_review_run_reviewer (run_id, reviewer_id),
  KEY ix_model_research_review_reviewer (reviewer_id, status),
  CONSTRAINT fk_model_research_review_run FOREIGN KEY (run_id) REFERENCES model_research_run(id) ON DELETE CASCADE,
  CONSTRAINT fk_model_research_review_reviewer FOREIGN KEY (reviewer_id) REFERENCES reviewer(id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE model_research_run
  ADD COLUMN finalize_status VARCHAR(20) NULL COMMENT 'saving | merging | failed while the reviews are being saved, NULL otherwise' AFTER reviewed_at,
  ADD COLUMN finalize_error TEXT NULL COMMENT 'why the save failed' AFTER finalize_status,
  ADD COLUMN finalize_started_at TIMESTAMP(6) NULL AFTER finalize_error,
  ADD COLUMN finalize_json JSON NULL COMMENT 'how each value was decided: unanimous, majority or AI merge' AFTER finalize_started_at;

-- Runs still waiting for the one reviewer they were assigned to.
INSERT INTO model_research_review (run_id, reviewer_id, status, assigned_at)
SELECT id, reviewer_id, 'assigned', COALESCE(assigned_at, CURRENT_TIMESTAMP(6))
FROM model_research_run
WHERE reviewer_id IS NOT NULL AND model_id IS NULL;
