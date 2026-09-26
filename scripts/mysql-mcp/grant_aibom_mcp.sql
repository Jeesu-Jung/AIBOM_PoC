-- MySQL 8.0+
-- Dedicated account for the DBHub MCP server (see dbhub.example.toml).
-- Access is limited server-side with table-level grants: the account sees only
-- the tables listed below (information_schema hides everything else), has no
-- DDL rights, and cannot touch any other database on this server.
--
-- Run as root with the password supplied via a session variable so it never
-- lands in this file:
--   { echo "SET @mcp_password='...';"; cat scripts/mysql-mcp/grant_aibom_mcp.sql; } | mysql -uroot -p
--
-- New tables added by later migrations are NOT visible to the MCP until they
-- are granted here and this script is re-run.

SET @create_user = CONCAT(
  'CREATE USER IF NOT EXISTS ''aibom_mcp''@''localhost'' IDENTIFIED BY ',
  QUOTE(@mcp_password), ' WITH MAX_USER_CONNECTIONS 5');
PREPARE stmt FROM @create_user;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Re-running resets the grants to exactly the list below.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'aibom_mcp'@'localhost';

GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.model_hierarchy       TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.model_info            TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.model_research_result TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.dataset               TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.dataset_hierarchy     TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.model_dataset         TO 'aibom_mcp'@'localhost';

-- AIBOM area tables (sql/004_aibom_extended_schema.sql) and read views (sql/005_aibom_views.sql).
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.model          TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.transformation TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.evaluation     TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.provenance     TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.safety_ethics  TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.license_policy TO 'aibom_mcp'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON aibom.reference      TO 'aibom_mcp'@'localhost';
GRANT SELECT ON aibom.v_model_lineage    TO 'aibom_mcp'@'localhost';
GRANT SELECT ON aibom.v_model_evaluation TO 'aibom_mcp'@'localhost';
GRANT SELECT ON aibom.v_model_aibom      TO 'aibom_mcp'@'localhost';

SHOW GRANTS FOR 'aibom_mcp'@'localhost';
