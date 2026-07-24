// One-time (idempotent) seed of Facebook forums + accounts + membership for an org,
// extracted from the Mon–Sat posting sheet. Safe to re-run: accounts are matched by
// email, forums by name; membership is reset to the lists below each run.
//
//   node scripts/seedAdvertisingForums.js [orgId]   (default: main org)
require('dotenv').config();
const { getOrgPool } = require('../src/config/poolRegistry');

const ORG_ID = process.argv[2] || '8300127259922432';
const newId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

// email → display name (name is a placeholder to be mapped later; email is the key)
const ACCOUNTS = [
  { email: 'tane.joanne@gmail.com' },
  { email: 'parcellesignature@gmail.com' },
  { email: 'taneresidence6@gmail.com' },
  { email: 'taneresidence4@gmail.com' },
  { email: 'acjairbnb@gmail.com' },
  { email: 'bookings@taneresidence.com' },
];

// forum → { url, members: [account emails that can post there] }
const FORUMS = [
  { name: 'Find A Room In Hong Kong', url: 'https://www.facebook.com/groups/834480980283746/',
    members: ['tane.joanne@gmail.com', 'taneresidence6@gmail.com'] },
  { name: 'No Fee Rental', url: 'https://www.facebook.com/groups/1716536568586766/',
    members: ['parcellesignature@gmail.com', 'bookings@taneresidence.com', 'acjairbnb@gmail.com', 'taneresidence4@gmail.com', 'tane.joanne@gmail.com'] },
  { name: 'Hong Kong Apartment For Rent & Sale 香港樓宇租售', url: 'https://www.facebook.com/groups/219523561811865/?fref=nf',
    members: ['taneresidence6@gmail.com', 'acjairbnb@gmail.com', 'bookings@taneresidence.com', 'taneresidence4@gmail.com'] },
  { name: 'No Agent fee / Direct listings of flat / apartment in Hong Kong', url: 'https://www.facebook.com/groups/directflatrentalhongkong/buy_sell_discussion',
    members: ['taneresidence4@gmail.com', 'taneresidence6@gmail.com', 'tane.joanne@gmail.com', 'parcellesignature@gmail.com'] },
  { name: 'Hong Kong - Houses, land, apartments for Rent or Sale', url: 'https://www.facebook.com/groups/3514886515413195/',
    members: ['tane.joanne@gmail.com', 'acjairbnb@gmail.com'] },
  { name: 'Hong Kong Apartments - Short term Rentals', url: 'https://www.facebook.com/groups/2371084182935911/',
    members: ['tane.joanne@gmail.com', 'taneresidence6@gmail.com', 'acjairbnb@gmail.com', 'taneresidence4@gmail.com'] },
  { name: 'HK Apartment for Rent', url: 'https://www.facebook.com/groups/1579588322364125/',
    members: ['taneresidence4@gmail.com'] },
  { name: '香港免佣樓房舖 自助租售-資訊提供HKproperty', url: 'https://www.facebook.com/groups/1608000189417107',
    members: ['tane.joanne@gmail.com', 'taneresidence4@gmail.com'] },
  { name: 'Apartments & Rooms for Rent Hong Kong', url: 'https://www.facebook.com/groups/364096407723542',
    members: ['acjairbnb@gmail.com'] },
  { name: 'Hong Kong Apartment and Flats for Sale and Rent', url: 'https://www.facebook.com/groups/623371937800725',
    members: ['taneresidence6@gmail.com'] },
  { name: 'Market Place', url: 'https://www.facebook.com/marketplace/create/rental',
    members: ['taneresidence4@gmail.com'] },
];

async function upsertAccount(pool, email) {
  const [[existing]] = await pool.execute(
    'SELECT id FROM advertising_account WHERE org_id = ? AND email = ? AND deleted_at IS NULL LIMIT 1', [ORG_ID, email]);
  if (existing) return String(existing.id);
  const id = newId();
  await pool.execute(
    'INSERT INTO advertising_account (id, org_id, name, email, status, created_at) VALUES (?, ?, NULL, ?, 1, NOW())',
    [id, ORG_ID, email]);
  return id;
}

async function upsertForum(pool, name, url) {
  const [[existing]] = await pool.execute(
    'SELECT id FROM advertising_forum WHERE org_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1', [ORG_ID, name]);
  if (existing) {
    await pool.execute('UPDATE advertising_forum SET url = ? WHERE id = ?', [url, existing.id]);
    return String(existing.id);
  }
  const id = newId();
  await pool.execute(
    'INSERT INTO advertising_forum (id, org_id, name, url, status, created_at) VALUES (?, ?, ?, ?, 1, NOW())',
    [id, ORG_ID, name, url]);
  return id;
}

(async () => {
  const pool = await getOrgPool(ORG_ID);
  const acctId = {};
  for (const a of ACCOUNTS) acctId[a.email] = await upsertAccount(pool, a.email);
  console.log(`accounts: ${Object.keys(acctId).length}`);

  let memberships = 0;
  for (const f of FORUMS) {
    const forumId = await upsertForum(pool, f.name, f.url);
    await pool.execute('DELETE FROM advertising_forum_account WHERE forum_id = ? AND org_id = ?', [forumId, ORG_ID]);
    for (const email of f.members) {
      const aId = acctId[email];
      if (!aId) { console.warn(`  ! unknown member email ${email} for ${f.name}`); continue; }
      await pool.execute(
        'INSERT INTO advertising_forum_account (id, org_id, forum_id, account_id, created_at) VALUES (?, ?, ?, ?, NOW())',
        [newId(), ORG_ID, forumId, aId]);
      memberships++;
    }
    console.log(`  ${f.name}  (${f.members.length} members)`);
  }
  console.log(`forums: ${FORUMS.length}, memberships: ${memberships}`);
  process.exit(0);
})().catch(e => { console.error('SEED FAILED:', e.message); process.exit(1); });
