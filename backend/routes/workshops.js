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

// Helper to check if user can create workshops
const canCreateWorkshop = (role) => {
  return ["doctor", "hospital", "ngo", "admin"].includes(role);
};

// Helper to format date for MySQL
const formatMySQLDate = (dateString) => {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
};

// POST /workshops - Create workshop (doctors, hospitals, NGOs, admins only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!canCreateWorkshop(userRole)) {
      return res.status(403).json({
        error: "Only doctors, hospitals, NGOs, and admins can create workshops",
      });
    }

    const { title, topic, description, mode, location, date, duration } =
      req.body;

    // Validate required fields
    if (!title || !topic || !description || !mode || !date || !duration) {
      return res.status(400).json({
        error:
          "title, topic, description, mode, date, and duration are required",
      });
    }

    // Validate mode
    if (!["online", "in_person"].includes(mode)) {
      return res.status(400).json({
        error: "mode must be either 'online' or 'in_person'",
      });
    }

    // Location is required if mode is in_person
    if (mode === "in_person" && !location) {
      return res.status(400).json({
        error: "location is required when mode is 'in_person'",
      });
    }

    // Validate duration (must be positive integer)
    const durationInt = parseInt(duration, 10);
    if (Number.isNaN(durationInt) || durationInt <= 0) {
      return res.status(400).json({
        error: "duration must be a positive integer (in minutes)",
      });
    }

    // Validate and format date
    const formattedDate = formatMySQLDate(date);
    if (!formattedDate) {
      return res.status(400).json({
        error: "Invalid date format",
      });
    }

    // Check if date is in the future
    const workshopDate = new Date(date);
    if (workshopDate <= new Date()) {
      return res.status(400).json({
        error: "Workshop date must be in the future",
      });
    }

    const sql = `
      INSERT INTO workshops 
        (title, topic, description, mode, location, date, duration, created_by, approved, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, false, NOW(), NOW())
    `;

    const result = await runQuery(sql, [
      title,
      topic,
      description,
      mode,
      location || null,
      formattedDate,
      durationInt,
      userId,
    ]);

    const workshopId = result.insertId;

    // Fetch the created workshop
    const workshop = await runQuery(
      "SELECT * FROM workshops WHERE id = ?",
      [workshopId]
    );

    res.status(201).json({
      message: "Workshop created successfully. Pending admin approval.",
      workshop: workshop[0],
    });
  } catch (error) {
    console.error("Error creating workshop:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workshops - List workshops (approved only for public, all for admins/creators)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { approved_only, created_by_me } = req.query;

    let sql = `
      SELECT 
        w.*,
        u.username as creator_username,
        u.email as creator_email,
        (SELECT COUNT(*) FROM workshop_registrations wr WHERE wr.workshop_id = w.id) as registration_count
      FROM workshops w
      LEFT JOIN users u ON w.created_by = u.id
      WHERE 1=1
    `;

    const params = [];

    // Admins can see all workshops
    // Others see only approved workshops, unless they're the creator
    if (userRole !== "admin") {
      if (created_by_me === "true") {
        // Show user's own workshops (approved or not)
        sql += " AND w.created_by = ?";
        params.push(userId);
      } else {
        // Show only approved workshops
        sql += " AND w.approved = true";
      }
    } else if (approved_only === "false") {
      // Admin can see all if explicitly requested
      // Otherwise show approved by default
    } else {
      // Default: show approved workshops
      sql += " AND w.approved = true";
    }

    sql += " ORDER BY w.date ASC, w.created_at DESC";

    const workshops = await runQuery(sql, params);

    res.json({
      message: "Workshops retrieved successfully",
      workshops,
    });
  } catch (error) {
    console.error("Error fetching workshops:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workshops/:id - Get single workshop
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const sql = `
      SELECT 
        w.*,
        u.username as creator_username,
        u.email as creator_email,
        (SELECT COUNT(*) FROM workshop_registrations wr WHERE wr.workshop_id = w.id) as registration_count,
        (SELECT COUNT(*) FROM workshop_registrations wr2 WHERE wr2.workshop_id = w.id AND wr2.user_id = ?) as user_registered
      FROM workshops w
      LEFT JOIN users u ON w.created_by = u.id
      WHERE w.id = ?
    `;

    const workshop = await runQuery(sql, [userId, id]);

    if (workshop.length === 0) {
      return res.status(404).json({ error: "Workshop not found" });
    }

    // Check if user can view this workshop
    // Admins and creators can see unapproved workshops
    // Others can only see approved workshops
    if (
      !workshop[0].approved &&
      userRole !== "admin" &&
      workshop[0].created_by !== userId
    ) {
      return res.status(403).json({
        error: "This workshop is pending approval and not yet visible",
      });
    }

    res.json({
      message: "Workshop retrieved successfully",
      workshop: workshop[0],
    });
  } catch (error) {
    console.error("Error fetching workshop:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workshops/:id - Update workshop (creator or admin)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if workshop exists
    const existing = await runQuery(
      "SELECT * FROM workshops WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Workshop not found" });
    }

    // Only creator or admin can update
    if (existing[0].created_by !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the workshop creator or admin can update this workshop",
      });
    }

    // If approved, only admin can update
    if (existing[0].approved && userRole !== "admin") {
      return res.status(403).json({
        error: "Approved workshops can only be updated by admin",
      });
    }

    const { title, topic, description, mode, location, date, duration } =
      req.body;

    const updates = [];
    const params = [];

    if (title !== undefined) {
      updates.push("title = ?");
      params.push(title);
    }
    if (topic !== undefined) {
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

      // If mode is in_person, location is required
      if (mode === "in_person" && !location && !existing[0].location) {
        return res.status(400).json({
          error: "location is required when mode is 'in_person'",
        });
      }
    }
    if (location !== undefined) {
      updates.push("location = ?");
      params.push(location);
    }
    if (date !== undefined) {
      const formattedDate = formatMySQLDate(date);
      if (!formattedDate) {
        return res.status(400).json({ error: "Invalid date format" });
      }
      updates.push("date = ?");
      params.push(formattedDate);
    }
    if (duration !== undefined) {
      const durationInt = parseInt(duration, 10);
      if (Number.isNaN(durationInt) || durationInt <= 0) {
        return res.status(400).json({
          error: "duration must be a positive integer (in minutes)",
        });
      }
      updates.push("duration = ?");
      params.push(durationInt);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.push("updated_at = NOW()");
    params.push(id);

    const sql = `UPDATE workshops SET ${updates.join(", ")} WHERE id = ?`;

    await runQuery(sql, params);

    // Fetch updated workshop
    const updated = await runQuery(
      "SELECT * FROM workshops WHERE id = ?",
      [id]
    );

    res.json({
      message: "Workshop updated successfully",
      workshop: updated[0],
    });
  } catch (error) {
    console.error("Error updating workshop:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workshops/:id/approve - Approve/reject workshop (admin only)
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

    // Check if workshop exists
    const existing = await runQuery(
      "SELECT * FROM workshops WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Workshop not found" });
    }

    const sql = `
      UPDATE workshops 
      SET approved = ?, approved_by = ?, updated_at = NOW()
      WHERE id = ?
    `;

    await runQuery(sql, [approved, adminId, id]);

    // Fetch updated workshop
    const updated = await runQuery(
      "SELECT * FROM workshops WHERE id = ?",
      [id]
    );

    res.json({
      message: approved
        ? "Workshop approved successfully"
        : "Workshop rejected successfully",
      workshop: updated[0],
    });
  } catch (error) {
    console.error("Error approving workshop:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /workshops/:id - Delete workshop (creator or admin)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if workshop exists
    const existing = await runQuery(
      "SELECT * FROM workshops WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Workshop not found" });
    }

    // Only creator or admin can delete
    if (existing[0].created_by !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the workshop creator or admin can delete this workshop",
      });
    }

    // Check if there are registrations
    const registrations = await runQuery(
      "SELECT COUNT(*) as count FROM workshop_registrations WHERE workshop_id = ?",
      [id]
    );

    if (registrations[0].count > 0) {
      return res.status(400).json({
        error:
          "Cannot delete workshop with existing registrations. Please cancel the workshop instead.",
      });
    }

    await runQuery("DELETE FROM workshops WHERE id = ?", [id]);

    res.json({ message: "Workshop deleted successfully" });
  } catch (error) {
    console.error("Error deleting workshop:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

