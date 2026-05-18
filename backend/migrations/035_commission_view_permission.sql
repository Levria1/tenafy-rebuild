-- Grant the Commission Tracker view permission to the Landlord System Manager
-- role (role_id = 230000000001) so existing system admins can see the new
-- Reports → Commission Tracker page without any manual step.

INSERT IGNORE INTO role_permission (role_id, permission_code) VALUES
  (230000000001, 'LANDLORD/REPORT/COMMISSION_VIEW');
