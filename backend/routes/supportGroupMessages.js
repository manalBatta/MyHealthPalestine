const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");
const requireRole = require("../middleware/roleCheck.js");

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

// Helper to check if user is active member or moderator
const canSendMessage = async (userId, groupId) => {
  // Check if user is moderator
  const group = await runQuery(
    "SELECT moderator_id FROM support_groups WHERE id = ?",
    [groupId]
  );

  if (group.length === 0) {
    return { allowed: false, reason: "Group not found" };
  }

  if (group[0].moderator_id === userId) {
    return { allowed: true, reason: "moderator" };
  }

  // Check if user is active member
  const member = await runQuery(
    "SELECT * FROM support_group_members WHERE group_id = ? AND user_id = ? AND is_active = true",
    [groupId, userId]
  );

  if (member.length > 0) {
    return { allowed: true, reason: "member" };
  }

  return { allowed: false, reason: "Not an active member or moderator" };
};

// POST /support-group-messages - Send message to support group
router.post("/", authenticateToken, async (req, res) => {
  try {
    const senderId = req.user.id;
    const { group_id, message_text } = req.body;

    if (!group_id || !message_text) {
      return res.status(400).json({
        error: "group_id and message_text are required",
      });
    }

    // Check if group exists
    const group = await runQuery(
      "SELECT * FROM support_groups WHERE id = ?",
      [group_id]
    );

    if (group.length === 0) {
      return res.status(404).json({ error: "Support group not found" });
    }

    // Verify user can send messages (active member or moderator)
    const permission = await canSendMessage(senderId, group_id);

    if (!permission.allowed) {
      return res.status(403).json({
        error: permission.reason,
      });
    }

    // Insert message
    const sql = `
      INSERT INTO support_group_messages 
        (group_id, sender_id, message_text, created_at)
      VALUES (?, ?, ?, NOW())
    `;

    const result = await runQuery(sql, [group_id, senderId, message_text]);

    // Fetch the created message with sender info
    const message = await runQuery(
      `SELECT 
        sgm.*,
        u.username as sender_username,
        u.email as sender_email,
        u.role as sender_role
      FROM support_group_messages sgm
      LEFT JOIN users u ON sgm.sender_id = u.id
      WHERE sgm.id = ?`,
      [result.insertId]
    );

    // Emit to WebSocket room for real-time messaging
    const io = req.app.get("io");
    if (io) {
      io.to(`support_group_${group_id}`).emit("new_message", {
        message: message[0],
        group_id: group_id,
      });
    }

    res.status(201).json({
      message: "Message sent successfully",
      message_data: message[0],
    });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /support-group-messages - List messages (role-based)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { group_id, sender_id, page, limit } = req.query;

    if (!group_id) {
      return res.status(400).json({
        error: "group_id is required",
      });
    }

    // Check if group exists
    const group = await runQuery(
      "SELECT * FROM support_groups WHERE id = ?",
      [group_id]
    );

    if (group.length === 0) {
      return res.status(404).json({ error: "Support group not found" });
    }

    // Verify user can view messages (active member, moderator, or admin)
    const isModerator = group[0].moderator_id === userId;
    const isAdmin = userRole === "admin";

    if (!isModerator && !isAdmin) {
      const member = await runQuery(
        "SELECT * FROM support_group_members WHERE group_id = ? AND user_id = ? AND is_active = true",
        [group_id, userId]
      );

      if (member.length === 0) {
        return res.status(403).json({
          error: "You must be an active member or moderator to view messages",
        });
      }
    }

    let sql = `
      SELECT 
        sgm.*,
        u.username as sender_username,
        u.email as sender_email,
        u.role as sender_role
      FROM support_group_messages sgm
      LEFT JOIN users u ON sgm.sender_id = u.id
      WHERE sgm.group_id = ?
    `;

    const params = [group_id];

    // Filter by sender
    if (sender_id) {
      sql += " AND sgm.sender_id = ?";
      params.push(sender_id);
    }

    sql += " ORDER BY sgm.created_at ASC";

    // Pagination
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offset = (pageNum - 1) * limitNum;

    sql += " LIMIT ? OFFSET ?";
    params.push(limitNum, offset);

    const messages = await runQuery(sql, params);

    // Get total count for pagination
    let countSql = `
      SELECT COUNT(*) as total
      FROM support_group_messages
      WHERE group_id = ?
    `;
    const countParams = [group_id];
    if (sender_id) {
      countSql += " AND sender_id = ?";
      countParams.push(sender_id);
    }
    const countResult = await runQuery(countSql, countParams);
    const total = countResult[0].total;

    res.json({
      message: "Messages retrieved successfully",
      messages,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /support-group-messages/:id - Get single message
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const sql = `
      SELECT 
        sgm.*,
        sg.moderator_id,
        u.username as sender_username,
        u.email as sender_email,
        u.role as sender_role
      FROM support_group_messages sgm
      LEFT JOIN support_groups sg ON sgm.group_id = sg.id
      LEFT JOIN users u ON sgm.sender_id = u.id
      WHERE sgm.id = ?
    `;

    const message = await runQuery(sql, [id]);

    if (message.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Verify user can view message (active member, moderator, or admin)
    const isModerator = message[0].moderator_id === userId;
    const isAdmin = userRole === "admin";

    if (!isModerator && !isAdmin) {
      const member = await runQuery(
        "SELECT * FROM support_group_members WHERE group_id = ? AND user_id = ? AND is_active = true",
        [message[0].group_id, userId]
      );

      if (member.length === 0) {
        return res.status(403).json({
          error: "You must be an active member or moderator to view this message",
        });
      }
    }

    res.json({
      message: "Message retrieved successfully",
      message_data: message[0],
    });
  } catch (error) {
    console.error("Error fetching message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /support-group-messages/:id - Delete message (moderator or admin only)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if message exists
    const existing = await runQuery(
      `SELECT sgm.*, sg.moderator_id, sg.created_by
       FROM support_group_messages sgm
       LEFT JOIN support_groups sg ON sgm.group_id = sg.id
       WHERE sgm.id = ?`,
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Only moderator, creator, or admin can delete messages
    if (
      existing[0].moderator_id !== userId &&
      existing[0].created_by !== userId &&
      userRole !== "admin"
    ) {
      return res.status(403).json({
        error: "Only the moderator, creator, or admin can delete messages",
      });
    }

    // Hard delete
    await runQuery("DELETE FROM support_group_messages WHERE id = ?", [id]);

    // Emit deletion event to WebSocket room
    const io = req.app.get("io");
    if (io) {
      io.to(`support_group_${existing[0].group_id}`).emit("message_deleted", {
        message_id: id,
        group_id: existing[0].group_id,
      });
    }

    res.json({ message: "Message deleted successfully" });
  } catch (error) {
    console.error("Error deleting message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

