const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");
const { translateText } = require("../utils/translator.js");

const DEFAULT_LANGUAGE = "en";

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

const findActiveConnection = async (userId, otherUserId) => {
  const results = await runQuery(
    `
      SELECT *
      FROM connections
      WHERE status = 'active'
        AND (
          (patient_id = ? AND doctor_id = ?)
          OR (patient_id = ? AND doctor_id = ?)
        )
      LIMIT 1
    `,
    [userId, otherUserId, otherUserId, userId]
  );

  return results[0];
};

const getUserLanguagePref = async (userId) => {
  const results = await runQuery(
    "SELECT language_pref FROM users WHERE id = ?",
    [userId]
  );

  if (results.length === 0) {
    return DEFAULT_LANGUAGE;
  }

  return results[0].language_pref || DEFAULT_LANGUAGE;
};

router.post("/", authenticateToken, async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiver_id, message_text, consultation_id } = req.body;

    if (!receiver_id || !message_text) {
      return res.status(400).json({
        error: "receiver_id and message_text are required",
      });
    }

    if (Number(receiver_id) === senderId) {
      return res.status(400).json({
        error: "Cannot send message to yourself",
      });
    }

    // Verify users are connected and active
    const connection = await findActiveConnection(senderId, receiver_id);

    if (!connection) {
      return res.status(403).json({
        error: "You must have an active connection to send messages",
      });
    }

    // Optional: validate consultation belongs to these users
    if (consultation_id) {
      const consultationResults = await runQuery(
        `SELECT id FROM consultations
         WHERE id = ?
           AND (
             (patient_id = ? AND doctor_id = ?)
             OR (patient_id = ? AND doctor_id = ?)
           )
        `,
        [
          consultation_id,
          senderId,
          receiver_id,
          receiver_id,
          senderId,
        ]
      );

      if (consultationResults.length === 0) {
        return res.status(400).json({
          error: "Consultation does not belong to this patient/doctor pair",
        });
      }
    }

    const targetLanguage = await getUserLanguagePref(receiver_id);
    const translation = await translateText(message_text, targetLanguage);

    const insertResult = await runQuery(
      `INSERT INTO messages
        (consultation_id, sender_id, receiver_id, message_text, language, translated_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        consultation_id || null,
        senderId,
        receiver_id,
        message_text,
        translation.language,
        translation.translatedText,
      ]
    );

    const messageId = insertResult.insertId;

    const message = await runQuery(
      "SELECT * FROM messages WHERE id = ?",
      [messageId]
    );

    const payload = {
      connection_id: connection.id,
      ...message[0],
    };

    const io = req.app.get("io");
    if (io) {
      io.to(`connection_${connection.id}`).emit("message:received", payload);
    }

    res.status(201).json({
      message: "Message sent successfully",
      data: payload,
    });
  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({
      error: "Internal server error while sending message",
    });
  }
});

router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      connection_id,
      with_user,
      consultation_id,
      page = 1,
      limit = 50,
    } = req.query;

    const limitNum = parseInt(limit, 10);
    const pageNum = parseInt(page, 10);

    if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 200) {
      return res.status(400).json({
        error: "Invalid limit. Must be between 1 and 200",
      });
    }

    if (Number.isNaN(pageNum) || pageNum < 1) {
      return res.status(400).json({
        error: "Invalid page number",
      });
    }

    let filterConnection = null;

    if (connection_id) {
      const connResults = await runQuery(
        "SELECT * FROM connections WHERE id = ?",
        [connection_id]
      );

      if (connResults.length === 0) {
        return res.status(404).json({ error: "Connection not found" });
      }

      const conn = connResults[0];
      if (
        conn.patient_id !== userId &&
        conn.doctor_id !== userId
      ) {
        return res.status(403).json({
          error: "You do not have access to this connection",
        });
      }

      filterConnection = conn;
    } else if (with_user) {
      const conn = await findActiveConnection(userId, Number(with_user));
      if (!conn) {
        return res.status(403).json({
          error: "You do not have an active connection with this user",
        });
      }
      filterConnection = conn;
    } else if (consultation_id) {
      const consultationResults = await runQuery(
        `SELECT patient_id, doctor_id
         FROM consultations
         WHERE id = ?`,
        [consultation_id]
      );

      if (consultationResults.length === 0) {
        return res.status(404).json({
          error: "Consultation not found",
        });
      }

      const { patient_id, doctor_id } = consultationResults[0];
      if (patient_id !== userId && doctor_id !== userId) {
        return res.status(403).json({
          error: "You do not have access to this consultation",
        });
      }

      const conn = await findActiveConnection(patient_id, doctor_id);
      filterConnection = conn || {
        patient_id,
        doctor_id,
      };
    } else {
      return res.status(400).json({
        error: "Provide connection_id, with_user, or consultation_id",
      });
    }

    const offset = (pageNum - 1) * limitNum;

    const whereParts = [
      "((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))",
    ];
    const params = [
      filterConnection.patient_id,
      filterConnection.doctor_id,
      filterConnection.doctor_id,
      filterConnection.patient_id,
    ];

    if (consultation_id) {
      whereParts.push("(consultation_id = ?)");
      params.push(consultation_id);
    }

    const messages = await runQuery(
      `SELECT *
       FROM messages
       WHERE ${whereParts.join(" AND ")}
       ORDER BY created_at ASC
       LIMIT ?
       OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({
      message: "Messages retrieved successfully",
      data: messages,
      meta: {
        page: pageNum,
        limit: limitNum,
      },
    });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving messages",
    });
  }
});

router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const messageId = req.params.id;

    const results = await runQuery(
      "SELECT * FROM messages WHERE id = ?",
      [messageId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }

    const message = results[0];

    if (
      message.sender_id !== userId &&
      message.receiver_id !== userId
    ) {
      return res.status(403).json({
        error: "You do not have access to this message",
      });
    }

    res.json({
      message: "Message retrieved successfully",
      data: message,
    });
  } catch (error) {
    console.error("Get message error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving message",
    });
  }
});

module.exports = router;

