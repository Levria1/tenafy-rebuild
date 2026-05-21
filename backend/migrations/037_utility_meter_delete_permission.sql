-- Grant the Utility Meter Delete permission to the default Landlord System
-- Manager role (role_id = 230000000001) so the existing system admin keeps
-- the ability to delete meters after this permission gate is introduced.
--
-- New custom roles created after this migration will NOT have the permission
-- by default — administrators must opt in via the role detail page.

INSERT IGNORE INTO role_permission (role_id, permission_code) VALUES
  (230000000001, 'LANDLORD/UTILITY_METER_DELETE');
