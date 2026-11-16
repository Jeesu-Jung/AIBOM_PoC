-- MySQL 8.0+
-- model_role is now BASE or DERIVED only. The family developer's official Instruct checkpoints
-- (previously INSTRUCT) are BASE: they stay roots of their family tree. Run once after sql/008.
USE aibom;

UPDATE model_info SET model_role = 'BASE' WHERE model_role = 'INSTRUCT';

ALTER TABLE model_info
  MODIFY COLUMN model_role ENUM('BASE', 'DERIVED') NOT NULL;
