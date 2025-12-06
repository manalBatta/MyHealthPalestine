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

// POST /support-group-members - Join support group (patients only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { group_id } = req.body;

    // Only patients can join
    if (userRole !== "patient") {
      return res.status(403).json({
        error: "Only patients can join support groups",
      });
    }

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

    // Check current member count
    const memberCount = await runQuery(
      "SELECT COUNT(*) as count FROM support_group_members WHERE group_id = ? AND is_active = true",
      [group_id]
    );

    if (memberCount[0].count >= group[0].max_members) {
      return res.status(400).json({
        error: "Support group has reached maximum member capacity",
      });
    }

    // Check if user is already an active member
    const existingActive = await runQuery(
      "SELECT * FROM support_group_members WHERE group_id = ? AND user_id = ? AND is_active = true",
      [group_id, userId]
    );

    if (existingActive.length > 0) {
      return res.status(400).json({
        error: "You are already an active member of this group",
      });
    }

    // Check if user previously left (is_active = false)
    const existingInactive = await runQuery(
      "SELECT * FROM support_group_members WHERE group_id = ? AND user_id = ? AND is_active = false",
      [group_id, userId]
    );

    if (existingInactive.length > 0) {
      // Reactivate membership
      await runQuery(
        "UPDATE support_group_members SET is_active = true, joined_at = NOW() WHERE group_id = ? AND user_id = ?",
        [group_id, userId]
      );

      const reactivated = await runQuery(
        `SELECT 
          sgm.*,
          sg.title as group_title,
          u.username as user_username
        FROM support_group_members sgm
        LEFT JOIN support_groups sg ON sgm.group_id = sg.id
        LEFT JOIN users u ON sgm.user_id = u.id
        WHERE sgm.group_id = ? AND sgm.user_id = ?`,
        [group_id, userId]
      );

      return res.json({
        message: "Successfully rejoined support group",
        membership: reactivated[0],
      });
    }

    // Create new membership
    const sql = `
      INSERT INTO support_group_members 
        (group_id, user_id, joined_at, is_active)
      VALUES (?, ?, NOW(), true)
    `;

    const result = await runQuery(sql, [group_id, userId]);

    // Fetch the created membership
    const membership = await runQuery(
      `SELECT 
        sgm.*,
        sg.title as group_title,
        u.username as user_username
      FROM support_group_members sgm
      LEFT JOIN support_groups sg ON sgm.group_id = sg.id
      LEFT JOIN users u ON sgm.user_id = u.id
      WHERE sgm.id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      message: "Successfully joined support group",
      membership: membership[0],
    });
  } catch (error) {
    console.error("Error joining support group:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /support-group-members - List members (role-based)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { group_id, user_id, active_only } = req.query;

    let sql = `
      SELECT 
        sgm.*,
        sg.title as group_title,
        u.username as user_username,
        u.email as user_email,
        u.role as user_role
      FROM support_group_members sgm
      LEFT JOIN support_groups sg ON sgm.group_id = sg.id
      LEFT JOIN users u ON sgm.user_id = u.id
      WHERE 1=1
    `;

    const params = [];

    // Role-based filtering
    if (userRole === "admin") {
      // Admin can see all memberships
    } else if (userRole === "doctor") {
      // Doctors can see members of groups they moderate
      sql += " AND EXISTS (SELECT 1 FROM support_groups sg2 WHERE sg2.id = sgm.group_id AND sg2.moderator_id = ?)";
      params.push(userId);
    } else {
      // Regular users can only see their own memberships
      sql += " AND sgm.user_id = ?";
      params.push(userId);
    }

    // Additional filters
    if (group_id) {
      sql += " AND sgm.group_id = ?";
      params.push(group_id);
    }

    if (user_id) {
      // Only admin or moderator can filter by user_id
      if (userRole === "admin" || userRole === "doctor") {
        sql += " AND sgm.user_id = ?";
        params.push(user_id);
      }
    }

    if (active_only === "true") {
      sql += " AND sgm.is_active = true";
    }

    sql += " ORDER BY sgm.joined_at DESC";

    const memberships = await runQuery(sql, params);

    res.json({
      message: "Members retrieved successfully",
      members: memberships,
    });
  } catch (error) {
    console.error("Error fetching members:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /support-group-members/:id - Get single membership
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const sql = `
      SELECT 
        sgm.*,
        sg.title as group_title,
        sg.moderator_id,
        u.username as user_username,
        u.email as user_email
      FROM support_group_members sgm
      LEFT JOIN support_groups sg ON sgm.group_id = sg.id
      LEFT JOIN users u ON sgm.user_id = u.id
      WHERE sgm.id = ?
    `;

    const membership = await runQuery(sql, [id]);

    if (membership.length === 0) {
      return res.status(404).json({ error: "Membership not found" });
    }

    // Check access: user can see their own, admin can see all, moderator can see for their groups
    if (
      userRole !== "admin" &&
      membership[0].user_id !== userId &&
      membership[0].moderator_id !== userId
    ) {
      return res.status(403).json({
        error: "Access denied",
      });
    }

    res.json({
      message: "Membership retrieved successfully",
      membership: membership[0],
    });
  } catch (error) {
    console.error("Error fetching membership:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /support-group-members/:id/leave - Leave support group (set is_active = false)
router.put("/:id/leave", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if membership exists
    const existing = await runQuery(
      "SELECT * FROM support_group_members WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Membership not found" });
    }

    // Users can only leave their own membership, admins can leave any
    if (existing[0].user_id !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "You can only leave your own membership",
      });
    }

    if (!existing[0].is_active) {
      return res.status(400).json({
        error: "You are not an active member of this group",
      });
    }

    // Set is_active to false
    await runQuery(
      "UPDATE support_group_members SET is_active = false WHERE id = ?",
      [id]
    );

    // Fetch updated membership
    const updated = await runQuery(
      `SELECT 
        sgm.*,
        sg.title as group_title,
        u.username as user_username
      FROM support_group_members sgm
      LEFT JOIN support_groups sg ON sgm.group_id = sg.id
      LEFT JOIN users u ON sgm.user_id = u.id
      WHERE sgm.id = ?`,
      [id]
    );

    res.json({
      message: "Successfully left support group",
      membership: updated[0],
    });
  } catch (error) {
    console.error("Error leaving support group:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /support-group-members/:id - Remove member (hard delete - moderator or admin only)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if membership exists
    const existing = await runQuery(
      `SELECT sgm.*, sg.moderator_id, sg.created_by
       FROM support_group_members sgm
       LEFT JOIN support_groups sg ON sgm.group_id = sg.id
       WHERE sgm.id = ?`,
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Membership not found" });
    }

    // Only moderator, creator, or admin can remove members
    if (
      existing[0].moderator_id !== userId &&
      existing[0].created_by !== userId &&
      userRole !== "admin"
    ) {
      return res.status(403).json({
        error: "Only the moderator, creator, or admin can remove members",
      });
    }

    // Hard delete
    await runQuery("DELETE FROM support_group_members WHERE id = ?", [id]);

    res.json({ message: "Member removed successfully" });
  } catch (error) {
    console.error("Error removing member:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

