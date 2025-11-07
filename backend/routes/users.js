const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");

// Validate that authenticateToken is a function
if (typeof authenticateToken !== "function") {
  throw new Error("authenticateToken middleware must be a function");
}

// GET all users
router.get("/", (req, res) => {
  db.query("SELECT * FROM users", (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(results);
  });
});

// GET user by ID with JWT authentication
router.get("/:id", authenticateToken, (req, res) => {
  const userId = req.params.id;

  db.query("SELECT * FROM users WHERE id = ?", [userId], (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (results.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    console.log(results);
    res.json(results[0]);
  });
});

module.exports = router;
