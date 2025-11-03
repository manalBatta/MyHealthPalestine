const express = require("express");
const router = express.Router();
const db = require("../db.js");

// GET all consultations
router.get("/", (req, res) => {
  db.query("SELECT * FROM consultations", (err, results) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(results);
  });
});

module.exports = router;
