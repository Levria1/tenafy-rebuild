// Idempotent seed of the operator's slot-level posting schedule.
//
//   node scripts/seedAdvertisingSchedule.js [orgId]   (default: main org)
//
// The schedule is seeded exactly as supplied. Known repeat violations are not
// corrected here; the app reports them for operator approval.
require('dotenv').config();
const { getOrgPool } = require('../src/config/poolRegistry');
const { forumWeeklyLoad } = require('../src/utils/advertisingPlan');

const ORG_ID = process.argv[2] || '8300127259922432';
const newId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

const FORUMS = {
  NFR: 'No Fee Rental',
  FAR: 'Find A Room In Hong Kong',
  STR: 'Hong Kong Apartments - Short term Rentals',
  HKS: 'Hong Kong Apartment For Rent & Sale 香港樓宇租售',
  NAF: 'No Agent fee / Direct listings of flat / apartment in Hong Kong',
  HKR: 'HK Apartment for Rent',
  HKP: '香港免佣樓房舖 自助租售-資訊提供HKproperty',
  HLA: 'Hong Kong - Houses, land, apartments for Rent or Sale',
  ARR: 'Apartments & Rooms for Rent Hong Kong',
  AFS: 'Hong Kong Apartment and Flats for Sale and Rent',
  MKT: 'Market Place',
};

const ACCOUNTS = {
  J: 'tane.joanne@gmail.com',
  P: 'parcellesignature@gmail.com',
  T6: 'taneresidence6@gmail.com',
  T4: 'taneresidence4@gmail.com',
  A: 'acjairbnb@gmail.com',
  B: 'bookings@taneresidence.com',
};

const byDay = [
  { weekday: 1, rows: ['Prop1 FAR J', 'Prop2 NFR P', 'Prop3 HKS T6', 'Prop4 NAF T4', 'Prop5 HKS A', 'Prop6 HLA J', 'Prop7 NFR B'] },
  { weekday: 2, rows: ['Prop8 STR J', 'Prop9 NFR B', 'Prop10 FAR T6', 'Prop11 HKR T4', 'Prop12 NFR A', 'Urgent1 HKP J', 'Urgent2 HKS B'] },
  { weekday: 3, rows: ['Prop1 FAR J', 'Prop2 NFR B', 'Prop3 STR T6', 'Prop4 HKR T4', 'Prop5 HKP T4', 'Prop6 NAF T6', 'Prop7 NFR A'] },
  { weekday: 4, rows: ['Prop13 STR A', 'Prop14 NFR T4', 'Prop15 FAR T6', 'Prop8 NAF J', 'Prop9 NFR B', 'Urgent1 MKT T4', 'Urgent2 HKS A'] },
  { weekday: 5, rows: ['Prop1 HKS T4', 'Prop2 STR J', 'Prop3 NFR P', 'Prop4 NFR J', 'Prop10 FAR T6', 'Prop11 ARR A', 'Prop12 HKS B', 'Prop13 STR T4', 'Prop14 NAF T6', 'Prop15 NFR B'] },
  { weekday: 6, rows: ['Prop5 NFR J', 'Prop6 STR T6', 'Prop7 NFR P', 'Prop8 HKS T4', 'Prop9 AFS T6', 'Urgent1 NAF P', 'Urgent2 HLA A'] },
  { weekday: 0, rows: ['Prop16 FAR T6', 'Prop17 NFR B', 'Prop18 STR A', 'Prop19 MKT T4', 'Prop20 AFS T6', 'Urgent1 ARR A', 'Urgent2 NFR T4'] },
];

function parseEntry(entry, position, weekday) {
  const [slot, forumKey, accountKey] = entry.split(/\s+/);
  const m = slot.match(/^(Prop|Urgent)(\d+)$/);
  if (!m) throw new Error(`Bad schedule entry: ${entry}`);
  return {
    weekday,
    position,
    slot_kind: m[1].toLowerCase(),
    slot_no: Number(m[2]),
    forum_key: forumKey,
    forum_name: FORUMS[forumKey],
    account_key: accountKey,
    account_email: ACCOUNTS[accountKey],
  };
}

const SCHEDULE = byDay.flatMap(day => day.rows.map((entry, i) => parseEntry(entry, i + 1, day.weekday)));

async function resolveByKey(pool, table, column, values) {
  const placeholders = values.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT id, ${column} FROM ${table}
      WHERE org_id = ? AND deleted_at IS NULL AND ${column} IN (${placeholders})`,
    [ORG_ID, ...values]
  );
  const map = new Map(rows.map(r => [r[column], String(r.id)]));
  const missing = values.filter(v => !map.has(v));
  if (missing.length) throw new Error(`Missing ${table} rows: ${missing.join(', ')}`);
  return map;
}

(async () => {
  if (SCHEDULE.length !== 52) throw new Error(`Expected 52 schedule rows, found ${SCHEDULE.length}`);
  const pool = await getOrgPool(ORG_ID);
  const forumNames = [...new Set(Object.values(FORUMS))];
  const accountEmails = [...new Set(Object.values(ACCOUNTS))];
  const forumIds = await resolveByKey(pool, 'advertising_forum', 'name', forumNames);
  const accountIds = await resolveByKey(pool, 'advertising_account', 'email', accountEmails);

  const resolved = SCHEDULE.map(row => ({
    ...row,
    forum_id: forumIds.get(row.forum_name),
    account_id: accountIds.get(row.account_email),
  }));

  const memberPairs = resolved.map(row => [row.forum_id, row.account_id]);
  const pairSql = memberPairs.map(() => '(forum_id = ? AND account_id = ?)').join(' OR ');
  const [members] = await pool.execute(
    `SELECT forum_id, account_id FROM advertising_forum_account
      WHERE org_id = ? AND (${pairSql})`,
    [ORG_ID, ...memberPairs.flat()]
  );
  const validPairs = new Set(members.map(m => `${String(m.forum_id)}|${String(m.account_id)}`));
  const invalid = resolved.filter(row => !validPairs.has(`${row.forum_id}|${row.account_id}`));
  if (invalid.length) {
    console.error('SEED FAILED: schedule contains forum/account pairs that are not members:');
    for (const row of invalid) {
      console.error(`  weekday ${row.weekday} ${row.slot_kind}${row.slot_no}: ${row.forum_name} <- ${row.account_email}`);
    }
    process.exit(1);
  }

  let inserted = 0;
  let updated = 0;
  for (const row of resolved) {
    const [[existing]] = await pool.execute(
      `SELECT id, forum_id, account_id, position, status, deleted_at
         FROM advertising_schedule
        WHERE org_id = ? AND weekday = ? AND slot_kind = ? AND slot_no = ?
        LIMIT 1`,
      [ORG_ID, row.weekday, row.slot_kind, row.slot_no]
    );
    if (existing) {
      await pool.execute(
        `UPDATE advertising_schedule
            SET position = ?, forum_id = ?, account_id = ?, status = 1, deleted_at = NULL
          WHERE id = ? AND org_id = ?`,
        [row.position, row.forum_id, row.account_id, existing.id, ORG_ID]
      );
      updated++;
    } else {
      await pool.execute(
        `INSERT INTO advertising_schedule
           (id, org_id, weekday, slot_kind, slot_no, position, forum_id, account_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
        [newId(), ORG_ID, row.weekday, row.slot_kind, row.slot_no, row.position, row.forum_id, row.account_id]
      );
      inserted++;
    }
  }

  const forumRows = forumNames.map(name => ({
    forum_id: forumIds.get(name),
    forum_name: name,
    is_owned: ['No Fee Rental', 'Hong Kong Apartments - Short term Rentals', 'Find A Room In Hong Kong'].includes(name) ? 1 : 0,
    max_per_week: null,
  }));
  const loadRows = resolved.map(row => ({
    forum_id: row.forum_id,
    forum_name: row.forum_name,
    is_owned: forumRows.find(f => f.forum_id === row.forum_id)?.is_owned || 0,
  }));
  console.log(`rows inserted: ${inserted}`);
  console.log(`rows updated: ${updated}`);
  console.log('weekly count:');
  for (const f of forumWeeklyLoad(loadRows, forumRows)) {
    console.log(`  ${f.forum_name}: ${f.count}`);
  }
  process.exit(0);
})().catch(e => { console.error('SEED FAILED:', e.message); process.exit(1); });
