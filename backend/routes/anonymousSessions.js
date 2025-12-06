const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");
const requireRole = require("../middleware/roleCheck.js");
const crypto = require("crypto");

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

// Generate a random pseudo patient name
const generatePseudoName = () => {
  const adjectives = ["Anonymous", "Patient", "Seeker", "Guest", "User"];
  const numbers = Math.floor(Math.random() * 10000);
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${numbers}`;
};

// POST /anonymous-sessions - Create anonymous session request (patient only)
router.post("/", authenticateToken, requireRole("patient"), async (req, res) => {
  try {
    const { therapist_id, started_at, pseudo_patient_name, session_token } = req.body;
    const patientId = req.user.id; // Not stored, but used for validation

    // Validate required fields
    if (!therapist_id || !started_at) {
      return res.status(400).json({
        error: "therapist_id and started_at are required",
      });
    }

    // Check if therapist exists and is a doctor
    const therapist = await runQuery(
      "SELECT id, role FROM users WHERE id = ?",
      [therapist_id]
    );

    if (therapist.length === 0) {
      return res.status(404).json({ error: "Therapist not found" });
    }

    if (therapist[0].role !== "doctor") {
      return res.status(400).json({ error: "therapist_id must refer to a doctor" });
    }

    // Validate started_at date
    const startDate = new Date(started_at);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: "Invalid started_at date format" });
    }

    // Convert ISO 8601 date to MySQL format (YYYY-MM-DD HH:MM:SS)
    const mysqlDate = startDate.toISOString().slice(0, 19).replace('T', ' ');

    // Generate session_token if not provided
    const finalSessionToken = session_token || crypto.randomUUID();

    // Generate pseudo_patient_name if not provided
    const finalPseudoName = pseudo_patient_name || generatePseudoName();

    // Insert session with active=false (pending therapist acceptance)
    const result = await runQuery(
      `INSERT INTO anonymous_sessions 
       (therapist_id, pseudo_patient_name, session_token, started_at, active) 
       VALUES (?, ?, ?, ?, FALSE)`,
      [therapist_id, finalPseudoName, finalSessionToken, mysqlDate]
    );

    const session = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json({
      message: "Anonymous session request created successfully. Waiting for therapist acceptance.",
      data: session[0],
    });
  } catch (error) {
    console.error("Error creating anonymous session:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /anonymous-sessions - List sessions
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let query = "SELECT * FROM anonymous_sessions";
    const params = [];

    if (userRole === "patient") {
      // Patients can view sessions by providing session_token(s)
      // They can provide multiple tokens separated by comma, or a single token
      const { session_token } = req.query;
      if (session_token) {
        // Support multiple tokens (comma-separated) or single token
        const tokens = session_token.split(",").map((t) => t.trim());
        if (tokens.length === 1) {
          query += " WHERE session_token = ?";
          params.push(tokens[0]);
        } else {
          query += " WHERE session_token IN (?" + ",?".repeat(tokens.length - 1) + ")";
          params.push(...tokens);
        }
      } else {
        // If no session_token provided, return empty
        return res.status(200).json({
          message: "Provide session_token(s) to view your sessions. You received the token when you created the session.",
          data: [],
        });
      }
    } else if (userRole === "doctor") {
      // Doctors see only their active sessions
      query += " WHERE therapist_id = ? AND active = TRUE";
      params.push(userId);
    } else {
      return res.status(403).json({ error: "Access denied" });
    }

    query += " ORDER BY started_at DESC";

    const sessions = await runQuery(query, params);

    res.status(200).json({
      message: "Anonymous sessions retrieved successfully",
      data: sessions,
    });
  } catch (error) {
    console.error("Error fetching anonymous sessions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /anonymous-sessions/pending - Get pending session requests (therapist only)
router.get("/pending", authenticateToken, requireRole("doctor"), async (req, res) => {
  try {
    const therapistId = req.user.id;

    const sessions = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE therapist_id = ? AND active = FALSE ORDER BY started_at ASC",
      [therapistId]
    );

    res.status(200).json({
      message: "Pending session requests retrieved successfully",
      data: sessions,
    });
  } catch (error) {
    console.error("Error fetching pending sessions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /anonymous-sessions/:id - Get single session
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const session = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [id]
    );

    if (session.length === 0) {
      return res.status(404).json({ error: "Anonymous session not found" });
    }

    const sess = session[0];

    // Authorization: Therapist can see their own sessions, patients need session_token
    if (userRole === "doctor") {
      if (parseInt(sess.therapist_id) !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      // Therapists can only see active sessions
      if (!sess.active) {
        return res.status(403).json({
          error: "Therapists can only view active sessions",
        });
      }
    } else if (userRole === "patient") {
      // Patients can view if they provide session_token
      const { session_token } = req.query;
      if (!session_token || session_token !== sess.session_token) {
        return res.status(403).json({
          error: "Invalid or missing session_token",
        });
      }
    } else {
      return res.status(403).json({ error: "Access denied" });
    }

    res.status(200).json({
      message: "Anonymous session retrieved successfully",
      data: sess,
    });
  } catch (error) {
    console.error("Error fetching anonymous session:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /anonymous-sessions/:id/accept - Accept session (therapist only)
router.put("/:id/accept", authenticateToken, requireRole("doctor"), async (req, res) => {
  try {
    const { id } = req.params;
    const therapistId = req.user.id;

    const session = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [id]
    );

    if (session.length === 0) {
      return res.status(404).json({ error: "Anonymous session not found" });
    }

    const sess = session[0];

    // Check if therapist owns this session
    if (parseInt(sess.therapist_id) !== therapistId) {
      return res.status(403).json({
        error: "Only the assigned therapist can accept this session",
      });
    }

    // Check if session is already active
    if (sess.active) {
      return res.status(400).json({
        error: "Session is already active",
      });
    }

    // Check if session is already ended
    if (sess.ended_at) {
      return res.status(400).json({
        error: "Cannot accept an ended session",
      });
    }

    // Activate session
    await runQuery(
      "UPDATE anonymous_sessions SET active = TRUE WHERE id = ?",
      [id]
    );

    const updated = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [id]
    );

    res.status(200).json({
      message: "Session accepted and activated successfully",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error accepting session:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /anonymous-sessions/:id/end - End session (therapist or patient)
router.put("/:id/end", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const session = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [id]
    );

    if (session.length === 0) {
      return res.status(404).json({ error: "Anonymous session not found" });
    }

    const sess = session[0];

    // Authorization check
    if (userRole === "doctor") {
      if (parseInt(sess.therapist_id) !== userId) {
        return res.status(403).json({
          error: "Only the assigned therapist can end this session",
        });
      }
    } else if (userRole === "patient") {
      // Patients need to provide session_token
      const { session_token } = req.query;
      if (!session_token || session_token !== sess.session_token) {
        return res.status(403).json({
          error: "Invalid or missing session_token",
        });
      }
    } else {
      return res.status(403).json({
        error: "Only therapists and patients can end sessions",
      });
    }

    // Check if session is already ended
    if (sess.ended_at) {
      return res.status(400).json({
        error: "Session is already ended",
      });
    }

    // End session
    await runQuery(
      "UPDATE anonymous_sessions SET active = FALSE, ended_at = NOW() WHERE id = ?",
      [id]
    );

    const updated = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [id]
    );

    res.status(200).json({
      message: "Session ended successfully",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error ending session:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

