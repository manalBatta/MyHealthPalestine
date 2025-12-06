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

// Helper to check if user can create surgical missions
const canCreateSurgicalMission = (role) => {
  return ["doctor", "ngo", "admin"].includes(role);
};

// Helper to format date for MySQL
const formatMySQLDate = (dateString) => {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
};

// POST /surgical-missions - Create surgical mission (doctors, NGOs, admins only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!canCreateSurgicalMission(userRole)) {
      return res.status(403).json({
        error: "Only doctors, NGOs, and admins can create surgical missions",
      });
    }

    const {
      title,
      description,
      doctor_id,
      ngo_id,
      location,
      start_datetime,
      end_datetime,
    } = req.body;

    // Validate required fields
    if (!title || !location || !start_datetime || !end_datetime) {
      return res.status(400).json({
        error:
          "title, location, start_datetime, and end_datetime are required",
      });
    }

    // Validate doctor_id or ngo_id (at least one must be provided)
    if (!doctor_id && !ngo_id) {
      return res.status(400).json({
        error: "Either doctor_id or ngo_id must be provided",
      });
    }

    // If doctor_id is provided, validate it exists and is a doctor
    if (doctor_id) {
      const doctor = await runQuery(
        "SELECT id, role FROM users WHERE id = ?",
        [doctor_id]
      );
      if (doctor.length === 0) {
        return res.status(404).json({ error: "Doctor not found" });
      }
      if (doctor[0].role !== "doctor") {
        return res.status(400).json({ error: "User is not a doctor" });
      }
    }

    // If ngo_id is provided, validate it exists and is an NGO
    if (ngo_id) {
      const ngo = await runQuery(
        "SELECT id, role FROM users WHERE id = ?",
        [ngo_id]
      );
      if (ngo.length === 0) {
        return res.status(404).json({ error: "NGO not found" });
      }
      if (ngo[0].role !== "ngo") {
        return res.status(400).json({ error: "User is not an NGO" });
      }
    }

    // Validate and format dates
    const formattedStartDate = formatMySQLDate(start_datetime);
    const formattedEndDate = formatMySQLDate(end_datetime);

    if (!formattedStartDate || !formattedEndDate) {
      return res.status(400).json({
        error: "Invalid date format for start_datetime or end_datetime",
      });
    }

    // Validate date logic
    const startDate = new Date(start_datetime);
    const endDate = new Date(end_datetime);
    const now = new Date();

    if (startDate >= endDate) {
      return res.status(400).json({
        error: "start_datetime must be before end_datetime",
      });
    }

    if (startDate <= now) {
      return res.status(400).json({
        error: "start_datetime must be in the future",
      });
    }

    const sql = `
      INSERT INTO surgical_missions 
        (title, description, doctor_id, ngo_id, location, start_datetime, end_datetime, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'upcoming', NOW(), NOW())
    `;

    const result = await runQuery(sql, [
      title,
      description || null,
      doctor_id || null,
      ngo_id || null,
      location,
      formattedStartDate,
      formattedEndDate,
    ]);

    const surgicalMissionId = result.insertId;

    // Fetch the created surgical mission
    const surgicalMission = await runQuery(
      `SELECT 
        sm.*,
        d.username as doctor_username,
        d.email as doctor_email,
        n.username as ngo_username,
        n.email as ngo_email
      FROM surgical_missions sm
      LEFT JOIN users d ON sm.doctor_id = d.id
      LEFT JOIN users n ON sm.ngo_id = n.id
      WHERE sm.id = ?`,
      [surgicalMissionId]
    );

    res.status(201).json({
      message: "Surgical mission created successfully",
      surgical_mission: surgicalMission[0],
    });
  } catch (error) {
    console.error("Error creating surgical mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /surgical-missions - List surgical missions
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { status, doctor_id, ngo_id, my_missions } = req.query;

    let sql = `
      SELECT 
        sm.*,
        d.username as doctor_username,
        d.email as doctor_email,
        n.username as ngo_username,
        n.email as ngo_email
      FROM surgical_missions sm
      LEFT JOIN users d ON sm.doctor_id = d.id
      LEFT JOIN users n ON sm.ngo_id = n.id
      WHERE 1=1
    `;

    const params = [];

    // Filter by status
    if (status) {
      const validStatuses = ["upcoming", "ongoing", "completed", "cancelled"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: `status must be one of: ${validStatuses.join(", ")}`,
        });
      }
      sql += " AND sm.status = ?";
      params.push(status);
    }

    // Filter by doctor_id
    if (doctor_id) {
      sql += " AND sm.doctor_id = ?";
      params.push(doctor_id);
    }

    // Filter by ngo_id
    if (ngo_id) {
      sql += " AND sm.ngo_id = ?";
      params.push(ngo_id);
    }

    // Filter by user's missions (missions they created or are associated with)
    if (my_missions === "true") {
      if (userRole === "doctor") {
        sql += " AND sm.doctor_id = ?";
        params.push(userId);
      } else if (userRole === "ngo") {
        sql += " AND sm.ngo_id = ?";
        params.push(userId);
      }
      // Admin sees all, no filter needed
    }

    sql += " ORDER BY sm.start_datetime ASC, sm.created_at DESC";

    const surgicalMissions = await runQuery(sql, params);

    res.json({
      message: "Surgical missions retrieved successfully",
      surgical_missions: surgicalMissions,
    });
  } catch (error) {
    console.error("Error fetching surgical missions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /surgical-missions/:id - Get single surgical mission
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `
      SELECT 
        sm.*,
        d.username as doctor_username,
        d.email as doctor_email,
        n.username as ngo_username,
        n.email as ngo_email
      FROM surgical_missions sm
      LEFT JOIN users d ON sm.doctor_id = d.id
      LEFT JOIN users n ON sm.ngo_id = n.id
      WHERE sm.id = ?
    `;

    const surgicalMission = await runQuery(sql, [id]);

    if (surgicalMission.length === 0) {
      return res.status(404).json({ error: "Surgical mission not found" });
    }

    res.json({
      message: "Surgical mission retrieved successfully",
      surgical_mission: surgicalMission[0],
    });
  } catch (error) {
    console.error("Error fetching surgical mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /surgical-missions/:id - Update surgical mission (creator or admin)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if surgical mission exists
    const existing = await runQuery(
      "SELECT * FROM surgical_missions WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Surgical mission not found" });
    }

    // Only creator (doctor or NGO) or admin can update
    const isCreator =
      existing[0].doctor_id === userId || existing[0].ngo_id === userId;

    if (!isCreator && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the surgical mission creator or admin can update this mission",
      });
    }

    // Cannot update if mission is completed or cancelled
    if (existing[0].status === "completed" || existing[0].status === "cancelled") {
      return res.status(400).json({
        error: "Cannot update a surgical mission that is completed or cancelled",
      });
    }

    const {
      title,
      description,
      doctor_id,
      ngo_id,
      location,
      start_datetime,
      end_datetime,
      status,
    } = req.body;

    const updates = [];
    const params = [];

    if (title !== undefined) {
      updates.push("title = ?");
      params.push(title);
    }
    if (description !== undefined) {
      updates.push("description = ?");
      params.push(description);
    }
    if (doctor_id !== undefined) {
      if (doctor_id) {
        const doctor = await runQuery(
          "SELECT id, role FROM users WHERE id = ?",
          [doctor_id]
        );
        if (doctor.length === 0) {
          return res.status(404).json({ error: "Doctor not found" });
        }
        if (doctor[0].role !== "doctor") {
          return res.status(400).json({ error: "User is not a doctor" });
        }
      }
      updates.push("doctor_id = ?");
      params.push(doctor_id || null);
    }
    if (ngo_id !== undefined) {
      if (ngo_id) {
        const ngo = await runQuery(
          "SELECT id, role FROM users WHERE id = ?",
          [ngo_id]
        );
        if (ngo.length === 0) {
          return res.status(404).json({ error: "NGO not found" });
        }
        if (ngo[0].role !== "ngo") {
          return res.status(400).json({ error: "User is not an NGO" });
        }
      }
      updates.push("ngo_id = ?");
      params.push(ngo_id || null);
    }
    if (location !== undefined) {
      updates.push("location = ?");
      params.push(location);
    }
    if (start_datetime !== undefined) {
      const formattedStartDate = formatMySQLDate(start_datetime);
      if (!formattedStartDate) {
        return res.status(400).json({ error: "Invalid start_datetime format" });
      }
      updates.push("start_datetime = ?");
      params.push(formattedStartDate);
    }
    if (end_datetime !== undefined) {
      const formattedEndDate = formatMySQLDate(end_datetime);
      if (!formattedEndDate) {
        return res.status(400).json({ error: "Invalid end_datetime format" });
      }
      updates.push("end_datetime = ?");
      params.push(formattedEndDate);
    }
    if (status !== undefined) {
      const validStatuses = ["upcoming", "ongoing", "completed", "cancelled"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: `status must be one of: ${validStatuses.join(", ")}`,
        });
      }
      updates.push("status = ?");
      params.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.push("updated_at = NOW()");
    params.push(id);

    const sql = `UPDATE surgical_missions SET ${updates.join(", ")} WHERE id = ?`;

    await runQuery(sql, params);

    // Fetch updated surgical mission
    const updated = await runQuery(
      `SELECT 
        sm.*,
        d.username as doctor_username,
        d.email as doctor_email,
        n.username as ngo_username,
        n.email as ngo_email
      FROM surgical_missions sm
      LEFT JOIN users d ON sm.doctor_id = d.id
      LEFT JOIN users n ON sm.ngo_id = n.id
      WHERE sm.id = ?`,
      [id]
    );

    res.json({
      message: "Surgical mission updated successfully",
      surgical_mission: updated[0],
    });
  } catch (error) {
    console.error("Error updating surgical mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /surgical-missions/:id - Delete surgical mission (creator or admin)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if surgical mission exists
    const existing = await runQuery(
      "SELECT * FROM surgical_missions WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Surgical mission not found" });
    }

    // Only creator or admin can delete
    const isCreator =
      existing[0].doctor_id === userId || existing[0].ngo_id === userId;

    if (!isCreator && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the surgical mission creator or admin can delete this mission",
      });
    }

    await runQuery("DELETE FROM surgical_missions WHERE id = ?", [id]);

    res.json({ message: "Surgical mission deleted successfully" });
  } catch (error) {
    console.error("Error deleting surgical mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

