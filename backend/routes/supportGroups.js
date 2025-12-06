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

// Helper to check if user can create support groups
const canCreateSupportGroup = (role) => {
  return ["doctor", "hospital", "ngo", "admin"].includes(role);
};

// POST /support-groups - Create support group (doctors, hospitals, NGOs, admins only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!canCreateSupportGroup(userRole)) {
      return res.status(403).json({
        error: "Only doctors, hospitals, NGOs, and admins can create support groups",
      });
    }

    const { title, topic, description, mode, meeting_link, location, moderator_id, max_members } =
      req.body;

    // Validate required fields
    if (!title || !topic || !mode || !moderator_id) {
      return res.status(400).json({
        error: "title, topic, mode, and moderator_id are required",
      });
    }

    // Validate topic enum
    const validTopics = ["chronic_illness", "disability", "loss", "trauma", "mental_health", "other"];
    if (!validTopics.includes(topic)) {
      return res.status(400).json({
        error: `topic must be one of: ${validTopics.join(", ")}`,
      });
    }

    // Validate mode
    if (!["online", "in_person"].includes(mode)) {
      return res.status(400).json({
        error: "mode must be either 'online' or 'in_person'",
      });
    }

    // Validate moderator exists and is a doctor or admin
    const moderator = await runQuery(
      "SELECT id, role FROM users WHERE id = ?",
      [moderator_id]
    );

    if (moderator.length === 0) {
      return res.status(404).json({ error: "Moderator not found" });
    }

    if (!["doctor", "admin"].includes(moderator[0].role)) {
      return res.status(400).json({
        error: "Moderator must be a doctor or admin",
      });
    }

    // Validate max_members (default 50, must be positive)
    const maxMembersInt = max_members ? parseInt(max_members, 10) : 50;
    if (Number.isNaN(maxMembersInt) || maxMembersInt <= 0) {
      return res.status(400).json({
        error: "max_members must be a positive integer",
      });
    }

    const sql = `
      INSERT INTO support_groups 
        (title, topic, description, mode, meeting_link, location, created_by, moderator_id, max_members, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `;

    const result = await runQuery(sql, [
      title,
      topic,
      description || null,
      mode,
      meeting_link || null,
      location || null,
      userId,
      moderator_id,
      maxMembersInt,
    ]);

    const groupId = result.insertId;

    // Automatically add moderator as a member (active)
    await runQuery(
      `INSERT INTO support_group_members (group_id, user_id, joined_at, is_active)
       VALUES (?, ?, NOW(), true)`,
      [groupId, moderator_id]
    );

    // Fetch the created group with member count
    const group = await runQuery(
      `SELECT 
        sg.*,
        u1.username as creator_username,
        u2.username as moderator_username,
        u2.email as moderator_email,
        (SELECT COUNT(*) FROM support_group_members sgm WHERE sgm.group_id = sg.id AND sgm.is_active = true) as member_count
      FROM support_groups sg
      LEFT JOIN users u1 ON sg.created_by = u1.id
      LEFT JOIN users u2 ON sg.moderator_id = u2.id
      WHERE sg.id = ?`,
      [groupId]
    );

    res.status(201).json({
      message: "Support group created successfully",
      group: group[0],
    });
  } catch (error) {
    console.error("Error creating support group:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /support-groups - List support groups
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { topic, mode, moderator_id, my_groups } = req.query;

    let sql = `
      SELECT 
        sg.*,
        u1.username as creator_username,
        u2.username as moderator_username,
        u2.email as moderator_email,
        (SELECT COUNT(*) FROM support_group_members sgm WHERE sgm.group_id = sg.id AND sgm.is_active = true) as member_count,
        (SELECT COUNT(*) FROM support_group_members sgm2 WHERE sgm2.group_id = sg.id AND sgm2.user_id = ? AND sgm2.is_active = true) as is_member
      FROM support_groups sg
      LEFT JOIN users u1 ON sg.created_by = u1.id
      LEFT JOIN users u2 ON sg.moderator_id = u2.id
      WHERE 1=1
    `;

    const params = [userId];

    // Filter by topic
    if (topic) {
      sql += " AND sg.topic = ?";
      params.push(topic);
    }

    // Filter by mode
    if (mode) {
      sql += " AND sg.mode = ?";
      params.push(mode);
    }

    // Filter by moderator
    if (moderator_id) {
      sql += " AND sg.moderator_id = ?";
      params.push(moderator_id);
    }

    // Filter by user's groups (groups they're a member of)
    if (my_groups === "true") {
      sql += " AND EXISTS (SELECT 1 FROM support_group_members sgm3 WHERE sgm3.group_id = sg.id AND sgm3.user_id = ? AND sgm3.is_active = true)";
      params.push(userId);
    }

    sql += " ORDER BY sg.created_at DESC";

    const groups = await runQuery(sql, params);

    res.json({
      message: "Support groups retrieved successfully",
      groups,
    });
  } catch (error) {
    console.error("Error fetching support groups:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /support-groups/:id - Get single support group
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const sql = `
      SELECT 
        sg.*,
        u1.username as creator_username,
        u2.username as moderator_username,
        u2.email as moderator_email,
        (SELECT COUNT(*) FROM support_group_members sgm WHERE sgm.group_id = sg.id AND sgm.is_active = true) as member_count,
        (SELECT COUNT(*) FROM support_group_members sgm2 WHERE sgm2.group_id = sg.id AND sgm2.user_id = ? AND sgm2.is_active = true) as is_member
      FROM support_groups sg
      LEFT JOIN users u1 ON sg.created_by = u1.id
      LEFT JOIN users u2 ON sg.moderator_id = u2.id
      WHERE sg.id = ?
    `;

    const group = await runQuery(sql, [userId, id]);

    if (group.length === 0) {
      return res.status(404).json({ error: "Support group not found" });
    }

    res.json({
      message: "Support group retrieved successfully",
      group: group[0],
    });
  } catch (error) {
    console.error("Error fetching support group:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /support-groups/:id - Update support group (moderator or creator or admin)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if group exists
    const existing = await runQuery(
      "SELECT * FROM support_groups WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Support group not found" });
    }

    // Only moderator, creator, or admin can update
    if (
      existing[0].moderator_id !== userId &&
      existing[0].created_by !== userId &&
      userRole !== "admin"
    ) {
      return res.status(403).json({
        error: "Only the moderator, creator, or admin can update this group",
      });
    }

    const { title, topic, description, mode, meeting_link, location, moderator_id, max_members } =
      req.body;

    const updates = [];
    const params = [];

    if (title !== undefined) {
      updates.push("title = ?");
      params.push(title);
    }
    if (topic !== undefined) {
      const validTopics = ["chronic_illness", "disability", "loss", "trauma", "mental_health", "other"];
      if (!validTopics.includes(topic)) {
        return res.status(400).json({
          error: `topic must be one of: ${validTopics.join(", ")}`,
        });
      }
      updates.push("topic = ?");
      params.push(topic);
    }
    if (description !== undefined) {
      updates.push("description = ?");
      params.push(description);
    }
    if (mode !== undefined) {
      if (!["online", "in_person"].includes(mode)) {
        return res.status(400).json({
          error: "mode must be either 'online' or 'in_person'",
        });
      }
      updates.push("mode = ?");
      params.push(mode);
    }
    if (meeting_link !== undefined) {
      updates.push("meeting_link = ?");
      params.push(meeting_link);
    }
    if (location !== undefined) {
      updates.push("location = ?");
      params.push(location);
    }
    if (moderator_id !== undefined) {
      // Validate new moderator
      const moderator = await runQuery(
        "SELECT id, role FROM users WHERE id = ?",
        [moderator_id]
      );

      if (moderator.length === 0) {
        return res.status(404).json({ error: "Moderator not found" });
      }

      if (!["doctor", "admin"].includes(moderator[0].role)) {
        return res.status(400).json({
          error: "Moderator must be a doctor or admin",
        });
      }

      updates.push("moderator_id = ?");
      params.push(moderator_id);

      // Add new moderator as member if not already
      const existingMember = await runQuery(
        "SELECT * FROM support_group_members WHERE group_id = ? AND user_id = ?",
        [id, moderator_id]
      );

      if (existingMember.length === 0) {
        await runQuery(
          `INSERT INTO support_group_members (group_id, user_id, joined_at, is_active)
           VALUES (?, ?, NOW(), true)`,
          [id, moderator_id]
        );
      } else if (!existingMember[0].is_active) {
        // Reactivate if previously left
        await runQuery(
          "UPDATE support_group_members SET is_active = true, joined_at = NOW() WHERE group_id = ? AND user_id = ?",
          [id, moderator_id]
        );
      }
    }
    if (max_members !== undefined) {
      const maxMembersInt = parseInt(max_members, 10);
      if (Number.isNaN(maxMembersInt) || maxMembersInt <= 0) {
        return res.status(400).json({
          error: "max_members must be a positive integer",
        });
      }
      updates.push("max_members = ?");
      params.push(maxMembersInt);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.push("updated_at = NOW()");
    params.push(id);

    const sql = `UPDATE support_groups SET ${updates.join(", ")} WHERE id = ?`;

    await runQuery(sql, params);

    // Fetch updated group
    const updated = await runQuery(
      `SELECT 
        sg.*,
        u1.username as creator_username,
        u2.username as moderator_username,
        (SELECT COUNT(*) FROM support_group_members sgm WHERE sgm.group_id = sg.id AND sgm.is_active = true) as member_count
      FROM support_groups sg
      LEFT JOIN users u1 ON sg.created_by = u1.id
      LEFT JOIN users u2 ON sg.moderator_id = u2.id
      WHERE sg.id = ?`,
      [id]
    );

    res.json({
      message: "Support group updated successfully",
      group: updated[0],
    });
  } catch (error) {
    console.error("Error updating support group:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /support-groups/:id - Delete support group (creator or admin) - cascade delete
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if group exists
    const existing = await runQuery(
      "SELECT * FROM support_groups WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Support group not found" });
    }

    // Only creator or admin can delete
    if (existing[0].created_by !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the group creator or admin can delete this group",
      });
    }

    // Start transaction for cascade delete
    const connection = await new Promise((resolve, reject) => {
      db.getConnection((err, conn) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });

    try {
      await new Promise((resolve, reject) => {
        connection.beginTransaction((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Delete messages
      await new Promise((resolve, reject) => {
        connection.query(
          "DELETE FROM support_group_messages WHERE group_id = ?",
          [id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Delete members
      await new Promise((resolve, reject) => {
        connection.query(
          "DELETE FROM support_group_members WHERE group_id = ?",
          [id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Delete group
      await new Promise((resolve, reject) => {
        connection.query(
          "DELETE FROM support_groups WHERE id = ?",
          [id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      await new Promise((resolve, reject) => {
        connection.commit((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      connection.release();

      res.json({ message: "Support group and all related data deleted successfully" });
    } catch (error) {
      await new Promise((resolve) => {
        connection.rollback(() => {
          connection.release();
          resolve();
        });
      });
      throw error;
    }
  } catch (error) {
    console.error("Error deleting support group:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

