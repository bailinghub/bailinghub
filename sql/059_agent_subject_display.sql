-- Optional business-supplied display metadata. Existing authorizations remain
-- unnamed; no inference from device labels, identities, route names or history.
ALTER TABLE `bz_agent_authorizations` ADD COLUMN `subject_display` JSON DEFAULT NULL COMMENT 'Business subject display only, never an authorization identity';

ALTER TABLE `bz_agent_sessions` ADD COLUMN `subject_display` JSON DEFAULT NULL COMMENT 'Current business subject display, independent of frozen audit labels';
