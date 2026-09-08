#!/usr/bin/env node
/**
 * Create the editable "Tenant Portal Invitation" email template for each org.
 *
 * Usage:
 *   node scripts/seedPortalInviteTemplate.js            # dry run, all active orgs
 *   node scripts/seedPortalInviteTemplate.js --apply
 *
 * WHY A SCRIPT AND NOT A MIGRATION
 * --------------------------------
 * A row in email_template needs the right org_id, and a per-org SQL migration
 * cannot know it. migrate-orgs.js runs each file against an org DATABASE without
 * telling the file which org that is, so the only org ids available inside the SQL
 * are whatever happens to be in the tables — and email_template in tena_prod_v2
 * holds dozens of legacy org ids, one row each. A first attempt at this as
 * migration 082 was dry-run against production and would have created twelve
 * templates for eleven organisations that do not exist.
 *
 * The master `organizations` table is the only authority on which org owns which
 * database, so the work is done from here, one org at a time, with its real id.
 *
 * WHY SEED AT ALL
 * ---------------
 * The portal sign-up email was hardcoded. Every other tenant-facing email is
 * editable under Settings > Email Templates, and this is the one a tenant sees
 * FIRST: it arrives unprompted, carries a link, and asks them to set a password.
 * Whoever writes to your tenants should be able to word it.
 *
 * The seeded copy is the built-in wording, so nothing changes the day it runs.
 * Editing the template is what changes the email.
 *
 * %Portal Signup Link% IS NOT OPTIONAL. The link is single-use and time-limited,
 * so it is substituted at send time and cannot be pre-baked. If an edited template
 * loses it, utils/tenantPortalInvite.js notices and sends the built-in email
 * instead, rather than a polite note with no way in.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../src/config');
const { getMasterPool } = require('../src/config/poolRegistry');

const TEMPLATE_TYPE = 'Portal-Invite-Tenant';
const TEMPLATE_NAME = 'Tenant Portal Invitation';
const SUBJECT = '%Company Name%: Set up your tenant portal password on Tenafy';

// The built-in wording, as HTML the rich-text editor can open.
const BODY = [
  '<p>Dear %Name - Lease%,</p>',
  '<p>%Company Name% uses Tenafy to manage its tenancies. Your tenant portal account is ready, and this email is the last step: choosing your password.</p>',
  '<p>Set your password here:<br>%Portal Signup Link%</p>',
  '<p>This link expires in %Link Expiry Minutes% minutes and can only be used once. If it expires, you can request another from the sign-in page.</p>',
  '<p>Once you are signed in you will be able to:</p>',
  '<ul>',
  '<li>View your tenancy details, including start and end dates</li>',
  '<li>View your invoices and payment history</li>',
  '<li>Report a repair, attach photographs, and follow its progress</li>',
  '<li>Keep your contact details up to date</li>',
  '</ul>',
  '<p>If you did not request this, no action is needed. Your account cannot be used until a password is set, and this link will stop working shortly.</p>',
  '<p>This message was sent from an address that is not monitored. Please contact %Company Name% directly if you have any questions.</p>',
  '<p>Kind regards,<br>%Company Name%</p>',
].join('');

const newId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

async function main() {
  const apply = process.argv.includes('--apply');

  const [orgs] = await getMasterPool().execute(
    'SELECT CAST(id AS CHAR) AS id, display_name, db_name, db_host, db_port, db_user, db_password FROM organizations WHERE status = 1 ORDER BY id'
  );
  console.log(`${orgs.length} active organisation(s) in master\n`);

  let created = 0, skipped = 0;
  for (const org of orgs) {
    let conn;
    try {
      conn = await mysql.createConnection({
        host: org.db_host || config.database.host,
        port: org.db_port || config.database.port,
        user: org.db_user || config.database.user,
        password: org.db_password || config.database.password,
        database: org.db_name,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });

      const [[has]] = await conn.execute(
        `SELECT COUNT(*) AS n FROM email_template WHERE org_id = ? AND template_type = ?`,
        [org.id, TEMPLATE_TYPE]
      );
      // COUNT(*) arrives as a STRING (bigNumberStrings) and '0' is truthy.
      if (Number(has.n) > 0) {
        console.log(`  ${org.display_name} (${org.db_name}): already has one, left alone`);
        skipped++;
        continue;
      }

      if (!apply) {
        console.log(`  ${org.display_name} (${org.db_name}): would create "${TEMPLATE_NAME}" for org ${org.id}`);
        created++;
        continue;
      }

      const id = newId();
      await conn.execute(
        `INSERT INTO email_template
           (id, org_id, template_name, template_type, subject, template_content,
            status, is_default_template, created_time, updated_time)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, NOW(), NOW())`,
        [id, org.id, TEMPLATE_NAME, TEMPLATE_TYPE, SUBJECT, BODY]
      );
      console.log(`  ${org.display_name} (${org.db_name}): created template ${id}`);
      created++;
    } catch (err) {
      console.error(`  ${org.display_name} (${org.db_name}): FAILED — ${err.message}`);
    } finally {
      if (conn) await conn.end();
    }
  }

  console.log('');
  console.log(apply
    ? `Done. ${created} created, ${skipped} already had one.`
    : `DRY RUN — nothing written. ${created} would be created, ${skipped} already have one.`);
  console.log('');
  console.log('To remove a template this created:');
  console.log(`  UPDATE email_template SET status = 0 WHERE id = <the id printed above>;`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
