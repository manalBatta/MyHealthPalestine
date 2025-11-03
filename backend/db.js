const mysql = require("mysql2");

const db = mysql.createPool({
  host: "localhost", // your MySQL server
  user: "root", // MySQL username
  password: "123456", // MySQL password
  database: "healthpal", // the database you created
});

module.exports = db;
