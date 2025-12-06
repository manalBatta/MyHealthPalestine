const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

// POST /anonymous-messages - Send message in anonymous session
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { session_id, message_text } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Validate required fields
    if (!session_id || !message_text) {
      return res.status(400).json({
        error: "session_id and message_text are required",
      });
    }

    // Get session
    const session = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [session_id]
    );

    if (session.length === 0) {
      return res.status(404).json({ error: "Anonymous session not found" });
    }

    const sess = session[0];

    // Check if session is active
    if (!sess.active) {
      return res.status(400).json({
        error: "Cannot send messages in inactive session",
      });
    }

    // Check if session is ended
    if (sess.ended_at) {
      return res.status(400).json({
        error: "Cannot send messages in ended session",
      });
    }

    // Determine sender_role from JWT
    let senderRole;
    if (userRole === "doctor") {
      // Check if this doctor is the therapist
      if (parseInt(sess.therapist_id) !== userId) {
        return res.status(403).json({
          error: "Only the assigned therapist can send messages",
        });
      }
      senderRole = "therapist";
    } else if (userRole === "patient") {
      // Patients can send messages if they have the session_token
      const { session_token } = req.query;
      if (!session_token || session_token !== sess.session_token) {
        return res.status(403).json({
          error: "Invalid or missing session_token",
        });
      }
      senderRole = "patient";
    } else {
      return res.status(403).json({
        error: "Only therapists and patients can send messages",
      });
    }

    // Insert message
    const result = await runQuery(
      `INSERT INTO anonymous_messages 
       (session_id, sender_role, message_text, created_at) 
       VALUES (?, ?, ?, NOW())`,
      [session_id, senderRole, message_text]
    );

    const message = await runQuery(
      "SELECT * FROM anonymous_messages WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json({
      message: "Message sent successfully",
      data: message[0],
    });
  } catch (error) {
    console.error("Error sending anonymous message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /anonymous-messages - Get messages for a session
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { session_id, session_token } = req.query;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!session_id) {
      return res.status(400).json({
        error: "session_id is required",
      });
    }

    // Get session
    const session = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [session_id]
    );

    if (session.length === 0) {
      return res.status(404).json({ error: "Anonymous session not found" });
    }

    const sess = session[0];

    // Authorization check
    if (userRole === "doctor") {
      // Therapist can view messages if they own the session
      if (parseInt(sess.therapist_id) !== userId) {
        return res.status(403).json({
          error: "Access denied",
        });
      }
      // Therapists can only see active sessions
      if (!sess.active) {
        return res.status(403).json({
          error: "Therapists can only view messages in active sessions",
        });
      }
    } else if (userRole === "patient") {
      // Patients need session_token
      if (!session_token || session_token !== sess.session_token) {
        return res.status(403).json({
          error: "Invalid or missing session_token",
        });
      }
    } else {
      return res.status(403).json({ error: "Access denied" });
    }

    // Get messages
    const messages = await runQuery(
      "SELECT * FROM anonymous_messages WHERE session_id = ? ORDER BY created_at ASC",
      [session_id]
    );

    res.status(200).json({
      message: "Messages retrieved successfully",
      data: messages,
    });
  } catch (error) {
    console.error("Error fetching anonymous messages:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /anonymous-messages/:id - Get single message
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const message = await runQuery(
      "SELECT * FROM anonymous_messages WHERE id = ?",
      [id]
    );

    if (message.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }

    const msg = message[0];

    // Get session to check authorization
    const session = await runQuery(
      "SELECT * FROM anonymous_sessions WHERE id = ?",
      [msg.session_id]
    );

    if (session.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const sess = session[0];

    // Authorization check
    if (userRole === "doctor") {
      if (parseInt(sess.therapist_id) !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (!sess.active) {
        return res.status(403).json({
          error: "Therapists can only view messages in active sessions",
        });
      }
    } else if (userRole === "patient") {
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
      message: "Message retrieved successfully",
      data: msg,
    });
  } catch (error) {
    console.error("Error fetching anonymous message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

