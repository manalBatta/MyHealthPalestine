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

// Helper to check if user can create health guides
const canCreateHealthGuide = (role) => {
  return ["doctor", "hospital", "ngo", "admin"].includes(role);
};

// POST /health-guides - Create health guide (doctors, hospitals, NGOs, admins only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!canCreateHealthGuide(userRole)) {
      return res.status(403).json({
        error: "Only doctors, hospitals, NGOs, and admins can create health guides",
      });
    }

    const { title, category, description, media_url, language } = req.body;

    // Validate required fields
    if (!title || !category || !description) {
      return res.status(400).json({
        error: "title, category, and description are required",
      });
    }

    // Validate category enum
    const validCategories = [
      "first_aid",
      "chronic_illness",
      "nutrition",
      "maternal_care",
      "mental_health",
      "other",
    ];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        error: `category must be one of: ${validCategories.join(", ")}`,
      });
    }

    // Validate language (optional, defaults to 'ar')
    const guideLanguage = language || "ar";

    const sql = `
      INSERT INTO health_guides 
        (title, category, description, media_url, language, created_by, approved, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, false, NOW(), NOW())
    `;

    const result = await runQuery(sql, [
      title,
      category,
      description,
      media_url || null,
      guideLanguage,
      userId,
    ]);

    const guideId = result.insertId;

    // Fetch the created guide
    const guide = await runQuery(
      `SELECT 
        hg.*,
        u.username as creator_username,
        u.email as creator_email
      FROM health_guides hg
      LEFT JOIN users u ON hg.created_by = u.id
      WHERE hg.id = ?`,
      [guideId]
    );

    res.status(201).json({
      message: "Health guide created successfully. Pending admin approval.",
      guide: guide[0],
    });
  } catch (error) {
    console.error("Error creating health guide:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /health-guides - List health guides (approved only for public, all for admins/creators)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { category, language, approved_only, created_by_me } = req.query;

    let sql = `
      SELECT 
        hg.*,
        u.username as creator_username,
        u.email as creator_email,
        approver.username as approver_username
      FROM health_guides hg
      LEFT JOIN users u ON hg.created_by = u.id
      LEFT JOIN users approver ON hg.approved_by = approver.id
      WHERE 1=1
    `;

    const params = [];

    // Admins can see all guides
    // Others see only approved guides, unless they're the creator
    if (userRole !== "admin") {
      if (created_by_me === "true") {
        // Show user's own guides (approved or not)
        sql += " AND hg.created_by = ?";
        params.push(userId);
      } else {
        // Show only approved guides
        sql += " AND hg.approved = true";
      }
    } else if (approved_only === "false") {
      // Admin can see all if explicitly requested
      // Otherwise show approved by default
    } else {
      // Default: show approved guides
      sql += " AND hg.approved = true";
    }

    // Filter by category
    if (category) {
      sql += " AND hg.category = ?";
      params.push(category);
    }

    // Filter by language
    if (language) {
      sql += " AND hg.language = ?";
      params.push(language);
    }

    sql += " ORDER BY hg.created_at DESC";

    const guides = await runQuery(sql, params);

    res.json({
      message: "Health guides retrieved successfully",
      guides,
    });
  } catch (error) {
    console.error("Error fetching health guides:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /health-guides/:id - Get single health guide
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const sql = `
      SELECT 
        hg.*,
        u.username as creator_username,
        u.email as creator_email,
        approver.username as approver_username
      FROM health_guides hg
      LEFT JOIN users u ON hg.created_by = u.id
      LEFT JOIN users approver ON hg.approved_by = approver.id
      WHERE hg.id = ?
    `;

    const guide = await runQuery(sql, [id]);

    if (guide.length === 0) {
      return res.status(404).json({ error: "Health guide not found" });
    }

    // Check if user can view this guide
    // Admins and creators can see unapproved guides
    // Others can only see approved guides
    if (
      !guide[0].approved &&
      userRole !== "admin" &&
      guide[0].created_by !== userId
    ) {
      return res.status(403).json({
        error: "This health guide is pending approval and not yet visible",
      });
    }

    res.json({
      message: "Health guide retrieved successfully",
      guide: guide[0],
    });
  } catch (error) {
    console.error("Error fetching health guide:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /health-guides/:id - Update health guide (creator or admin)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if guide exists
    const existing = await runQuery(
      "SELECT * FROM health_guides WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Health guide not found" });
    }

    // Only creator or admin can update
    if (existing[0].created_by !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the guide creator or admin can update this guide",
      });
    }

    // If approved, only admin can update
    if (existing[0].approved && userRole !== "admin") {
      return res.status(403).json({
        error: "Approved health guides can only be updated by admin",
      });
    }

    const { title, category, description, media_url, language } = req.body;

    const updates = [];
    const params = [];

    if (title !== undefined) {
      updates.push("title = ?");
      params.push(title);
    }
    if (category !== undefined) {
      const validCategories = [
        "first_aid",
        "chronic_illness",
        "nutrition",
        "maternal_care",
        "mental_health",
        "other",
      ];
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          error: `category must be one of: ${validCategories.join(", ")}`,
        });
      }
      updates.push("category = ?");
      params.push(category);
    }
    if (description !== undefined) {
      updates.push("description = ?");
      params.push(description);
    }
    if (media_url !== undefined) {
      updates.push("media_url = ?");
      params.push(media_url);
    }
    if (language !== undefined) {
      updates.push("language = ?");
      params.push(language);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // If updated by creator, reset approval status
    if (existing[0].created_by === userId && existing[0].approved) {
      updates.push("approved = false");
      updates.push("approved_by = NULL");
    }

    updates.push("updated_at = NOW()");
    params.push(id);

    const sql = `UPDATE health_guides SET ${updates.join(", ")} WHERE id = ?`;

    await runQuery(sql, params);

    // Fetch updated guide
    const updated = await runQuery(
      `SELECT 
        hg.*,
        u.username as creator_username,
        u.email as creator_email
      FROM health_guides hg
      LEFT JOIN users u ON hg.created_by = u.id
      WHERE hg.id = ?`,
      [id]
    );

    res.json({
      message: "Health guide updated successfully",
      guide: updated[0],
    });
  } catch (error) {
    console.error("Error updating health guide:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /health-guides/:id/approve - Approve/reject health guide (admin only)
router.put("/:id/approve", authenticateToken, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const { approved } = req.body;

    if (typeof approved !== "boolean") {
      return res.status(400).json({
        error: "approved must be a boolean value",
      });
    }

    // Check if guide exists
    const existing = await runQuery(
      "SELECT * FROM health_guides WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Health guide not found" });
    }

    const sql = `
      UPDATE health_guides 
      SET approved = ?, approved_by = ?, updated_at = NOW()
      WHERE id = ?
    `;

    await runQuery(sql, [approved, adminId, id]);

    // Fetch updated guide
    const updated = await runQuery(
      `SELECT 
        hg.*,
        u.username as creator_username,
        u.email as creator_email,
        approver.username as approver_username
      FROM health_guides hg
      LEFT JOIN users u ON hg.created_by = u.id
      LEFT JOIN users approver ON hg.approved_by = approver.id
      WHERE hg.id = ?`,
      [id]
    );

    res.json({
      message: approved
        ? "Health guide approved successfully"
        : "Health guide rejected successfully",
      guide: updated[0],
    });
  } catch (error) {
    console.error("Error approving health guide:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /health-guides/:id - Delete health guide (creator or admin)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if guide exists
    const existing = await runQuery(
      "SELECT * FROM health_guides WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Health guide not found" });
    }

    // Only creator or admin can delete
    if (existing[0].created_by !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the guide creator or admin can delete this guide",
      });
    }

    await runQuery("DELETE FROM health_guides WHERE id = ?", [id]);

    res.json({ message: "Health guide deleted successfully" });
  } catch (error) {
    console.error("Error deleting health guide:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

