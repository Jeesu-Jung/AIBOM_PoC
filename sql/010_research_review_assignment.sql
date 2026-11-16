-- MySQL 8.0+
-- Share the review of AI research runs between several people. Run once after sql/009.
--
--   reviewer            people who review research runs (a name list; the app has no login)
--   model_research_run  + who the run is assigned to, and who reviewed and saved it
--
-- A run is "pending" while model_research_run.model_id is NULL and "saved" once it is linked to
-- the catalog model saved from it, so no separate status column is kept.
USE aibom;

CREATE TABLE IF NOT EXISTS reviewer (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(100) NOT NULL COMMENT 'display name',
  email      VARCHAR(255) NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'inactive reviewers get no new runs but keep their history',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY ux_reviewer_name (name)
) ENGINE=InnoDB;

ALTER TABLE model_research_run
  ADD COLUMN reviewer_id BIGINT UNSIGNED NULL COMMENT 'reviewer the run is assigned to; NULL = unassigned' AFTER model_id,
  ADD COLUMN assigned_at TIMESTAMP(6) NULL AFTER reviewer_id,
  ADD COLUMN reviewed_by BIGINT UNSIGNED NULL COMMENT 'reviewer who reviewed the run and saved the model' AFTER assigned_at,
  ADD COLUMN reviewed_at TIMESTAMP(6) NULL COMMENT 'when the run was saved to the catalog' AFTER reviewed_by,
  ADD KEY ix_model_research_run_reviewer (reviewer_id, model_id),
  ADD KEY ix_model_research_run_reviewed_by (reviewed_by),
  ADD CONSTRAINT fk_model_research_run_reviewer FOREIGN KEY (reviewer_id) REFERENCES reviewer(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_model_research_run_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES reviewer(id) ON DELETE SET NULL;

-- Runs saved before this migration: the save time is the best known review time.
UPDATE model_research_run SET reviewed_at = updated_at WHERE model_id IS NOT NULL AND reviewed_at IS NULL;
