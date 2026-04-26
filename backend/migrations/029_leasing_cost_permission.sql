-- Grant the Leasing Cost Edit permission to the Landlord System Manager role
-- (role_id = 230000000001) so existing system admins can edit leasing cost
-- on the Vacancy Cost report without any manual step.

INSERT IGNORE INTO role_permission (role_id, permission_code) VALUES
  (230000000001, 'LANDLORD/REPORT/LEASING_COST_EDIT');
