// Node.js script to generate bcrypt hash and create admin user SQL query
// Run this with: node database/create_admin.js

const bcrypt = require("bcrypt");

// Configuration - Update these values
const adminConfig = {
  username: "admin",
  email: "admin@healthpal.com",
  contact_phone: "+1234567890",
  password: "123456", // Change this to your desired password
  language_pref: "en",
};

async function generateAdminSQL() {
  try {
    // Hash the password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(adminConfig.password, saltRounds);

    // Generate SQL query
    const sqlQuery = `INSERT INTO users (
  username,
  email,
  contact_phone,
  password_hash,
  role,
  language_pref,
  verification_status,
  created_at
) VALUES (
  '${adminConfig.username}',
  '${adminConfig.email}',
  '${adminConfig.contact_phone}',
  '${password_hash}',
  'admin',
  '${adminConfig.language_pref}',
  'verified',
  NOW()
);`;

    console.log("=".repeat(80));
    console.log("ADMIN USER SQL QUERY");
    console.log("=".repeat(80));
    console.log(sqlQuery);
    console.log("=".repeat(80));
    console.log("\nCopy the SQL query above and run it in your MySQL database.");
    console.log("\nAdmin Credentials:");
    console.log(`  Username/Email: ${adminConfig.email}`);
    console.log(`  Password: ${adminConfig.password}`);
    console.log("\n⚠️  IMPORTANT: Change the password after first login!");
    console.log("=".repeat(80));
  } catch (error) {
    console.error("Error generating admin SQL:", error);
  }
}

generateAdminSQL();

