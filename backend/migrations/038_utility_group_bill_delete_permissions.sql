-- Grant the Utility Group Delete and Utility Bill Delete permissions to the
-- default Landlord System Manager role (role_id = 230000000001) so the
-- existing system admin keeps the ability to delete groups and bills after
-- these permission gates are introduced.
--
-- New custom roles created after this migration will NOT have these
-- permissions by default — administrators must opt in via the role detail
-- page (Settings → Roles → edit → Utilities group).

INSERT IGNORE INTO role_permission (role_id, permission_code) VALUES
  (230000000001, 'LANDLORD/UTILITY_GROUP_DELETE'),
  (230000000001, 'LANDLORD/UTILITY_BILL_DELETE');
