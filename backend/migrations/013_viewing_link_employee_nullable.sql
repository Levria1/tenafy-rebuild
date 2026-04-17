-- Allow viewing_link.employee_id to be NULL so staff can generate a link
-- first and assign an employee later. A link with no employee is inactive
-- from the public perspective — see routes/viewingPublic.js (returns 404
-- on GET /link/:token and rejects POST submissions until assigned).

ALTER TABLE viewing_link MODIFY COLUMN employee_id BIGINT DEFAULT NULL;
