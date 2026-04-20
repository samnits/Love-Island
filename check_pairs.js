const db = require('./db');

db.all(
  `
  SELECT
    p1.id AS profile1_id,
    p1.name AS profile1_name,
    p1.email AS profile1_email,
    p2.id AS profile2_id,
    p2.name AS profile2_name,
    p2.email AS profile2_email
  FROM profiles p1
  JOIN profiles p2 ON p1.partner_id = p2.id AND p2.partner_id = p1.id
  ORDER BY p1.id
  `,
  [],
  (err, rows) => {
    if (err) {
      console.error('Error:', err.message || err);
      process.exit(1);
    }
    console.log('\n=== Connected Pairs ===\n');
    if (rows.length === 0) {
      console.log('No connected pairs found.');
    } else {
      rows.forEach((row, idx) => {
        console.log(`Pair ${idx + 1}:`);
        console.log(`  ${row.profile1_name} (${row.profile1_email})`);
        console.log(`  ↔`);
        console.log(`  ${row.profile2_name} (${row.profile2_email})`);
        console.log();
      });
    }
    process.exit(0);
  }
);
