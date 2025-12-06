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

// POST /workshop-registrations - Register for workshop
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { workshop_id } = req.body;

    if (!workshop_id) {
      return res.status(400).json({
        error: "workshop_id is required",
      });
    }

    // Check if workshop exists and is approved
    const workshop = await runQuery(
      "SELECT * FROM workshops WHERE id = ?",
      [workshop_id]
    );

    if (workshop.length === 0) {
      return res.status(404).json({ error: "Workshop not found" });
    }

    if (!workshop[0].approved) {
      return res.status(403).json({
        error: "Cannot register for a workshop that is not yet approved",
      });
    }

    // Check if workshop date is in the past
    const workshopDate = new Date(workshop[0].date);
    if (workshopDate <= new Date()) {
      return res.status(400).json({
        error: "Cannot register for a workshop that has already passed",
      });
    }

    // Check if user is already registered (prevent duplicates)
    const existing = await runQuery(
      "SELECT * FROM workshop_registrations WHERE workshop_id = ? AND user_id = ?",
      [workshop_id, userId]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        error: "You are already registered for this workshop",
      });
    }

    // Create registration
    const sql = `
      INSERT INTO workshop_registrations 
        (workshop_id, user_id, registered_at, attended)
      VALUES (?, ?, NOW(), false)
    `;

    const result = await runQuery(sql, [workshop_id, userId]);

    // Fetch the created registration
    const registration = await runQuery(
      `SELECT 
        wr.*,
        w.title as workshop_title,
        w.date as workshop_date,
        w.mode as workshop_mode,
        w.location as workshop_location,
        u.username as user_username,
        u.email as user_email
      FROM workshop_registrations wr
      LEFT JOIN workshops w ON wr.workshop_id = w.id
      LEFT JOIN users u ON wr.user_id = u.id
      WHERE wr.id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      message: "Successfully registered for workshop",
      registration: registration[0],
    });
  } catch (error) {
    console.error("Error registering for workshop:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workshop-registrations - List registrations (role-based)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { workshop_id, user_id, attended } = req.query;

    let sql = `
      SELECT 
        wr.*,
        w.title as workshop_title,
        w.date as workshop_date,
        w.mode as workshop_mode,
        w.location as workshop_location,
        w.created_by as workshop_creator_id,
        u.username as user_username,
        u.email as user_email
      FROM workshop_registrations wr
      LEFT JOIN workshops w ON wr.workshop_id = w.id
      LEFT JOIN users u ON wr.user_id = u.id
      WHERE 1=1
    `;

    const params = [];

    // Role-based filtering
    if (userRole === "admin") {
      // Admin can see all registrations
    } else if (userRole === "doctor" || userRole === "hospital" || userRole === "ngo") {
      // Creators can see registrations for their workshops
      sql += " AND w.created_by = ?";
      params.push(userId);
    } else {
      // Regular users can only see their own registrations
      sql += " AND wr.user_id = ?";
      params.push(userId);
    }

    // Additional filters
    if (workshop_id) {
      sql += " AND wr.workshop_id = ?";
      params.push(workshop_id);
    }

    if (user_id) {
      // Only admin or workshop creator can filter by user_id
      if (userRole === "admin" || (userRole !== "patient" && userRole !== "donor")) {
        sql += " AND wr.user_id = ?";
        params.push(user_id);
      }
    }

    if (attended !== undefined) {
      sql += " AND wr.attended = ?";
      params.push(attended === "true" ? 1 : 0);
    }

    sql += " ORDER BY wr.registered_at DESC";

    const registrations = await runQuery(sql, params);

    res.json({
      message: "Registrations retrieved successfully",
      registrations,
    });
  } catch (error) {
    console.error("Error fetching registrations:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workshop-registrations/:id - Get single registration
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const sql = `
      SELECT 
        wr.*,
        w.title as workshop_title,
        w.date as workshop_date,
        w.mode as workshop_mode,
        w.location as workshop_location,
        w.created_by as workshop_creator_id,
        u.username as user_username,
        u.email as user_email
      FROM workshop_registrations wr
      LEFT JOIN workshops w ON wr.workshop_id = w.id
      LEFT JOIN users u ON wr.user_id = u.id
      WHERE wr.id = ?
    `;

    const registration = await runQuery(sql, [id]);

    if (registration.length === 0) {
      return res.status(404).json({ error: "Registration not found" });
    }

    // Check access: user can see their own, admin can see all, creator can see for their workshops
    if (
      userRole !== "admin" &&
      registration[0].user_id !== userId &&
      registration[0].workshop_creator_id !== userId
    ) {
      return res.status(403).json({
        error: "Access denied",
      });
    }

    res.json({
      message: "Registration retrieved successfully",
      registration: registration[0],
    });
  } catch (error) {
    console.error("Error fetching registration:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workshop-registrations/:id/attendance - Mark attendance (admin or workshop creator)
router.put("/:id/attendance", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const { attended } = req.body;

    if (typeof attended !== "boolean") {
      return res.status(400).json({
        error: "attended must be a boolean value",
      });
    }

    // Check if registration exists
    const existing = await runQuery(
      `SELECT wr.*, w.created_by as workshop_creator_id
       FROM workshop_registrations wr
       LEFT JOIN workshops w ON wr.workshop_id = w.id
       WHERE wr.id = ?`,
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Registration not found" });
    }

    // Only admin or workshop creator can mark attendance
    if (
      userRole !== "admin" &&
      existing[0].workshop_creator_id !== userId
    ) {
      return res.status(403).json({
        error: "Only admin or workshop creator can mark attendance",
      });
    }

    const sql = `UPDATE workshop_registrations SET attended = ? WHERE id = ?`;

    await runQuery(sql, [attended, id]);

    // Fetch updated registration
    const updated = await runQuery(
      `SELECT 
        wr.*,
        w.title as workshop_title,
        w.date as workshop_date,
        u.username as user_username
      FROM workshop_registrations wr
      LEFT JOIN workshops w ON wr.workshop_id = w.id
      LEFT JOIN users u ON wr.user_id = u.id
      WHERE wr.id = ?`,
      [id]
    );

    res.json({
      message: attended
        ? "Attendance marked successfully"
        : "Attendance unmarked successfully",
      registration: updated[0],
    });
  } catch (error) {
    console.error("Error updating attendance:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /workshop-registrations/:id - Cancel registration
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if registration exists
    const existing = await runQuery(
      `SELECT wr.*, w.created_by as workshop_creator_id, w.date as workshop_date
       FROM workshop_registrations wr
       LEFT JOIN workshops w ON wr.workshop_id = w.id
       WHERE wr.id = ?`,
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Registration not found" });
    }

    // Users can cancel their own registration, admin can cancel any
    if (existing[0].user_id !== userId && userRole !== "admin") {
      return res.status(403).json({
        error: "You can only cancel your own registration",
      });
    }

    // Check if workshop has already passed
    const workshopDate = new Date(existing[0].workshop_date);
    if (workshopDate <= new Date() && existing[0].attended) {
      return res.status(400).json({
        error: "Cannot cancel registration for a workshop that has already occurred",
      });
    }

    await runQuery("DELETE FROM workshop_registrations WHERE id = ?", [id]);

    res.json({ message: "Registration cancelled successfully" });
  } catch (error) {
    console.error("Error cancelling registration:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

