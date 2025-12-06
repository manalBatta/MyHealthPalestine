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

// Helper to check if user can create missions
const canCreateMission = (role) => {
  return ["doctor", "ngo", "admin"].includes(role);
};

// Helper to format date for MySQL
const formatMySQLDate = (dateString) => {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
};

// POST /missions - Create mission (doctors, NGOs, admins only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!canCreateMission(userRole)) {
      return res.status(403).json({
        error: "Only doctors, NGOs, and admins can create missions",
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
      registration_expiration,
      slots_available,
    } = req.body;

    // Validate required fields
    if (!title || !location || !start_datetime || !end_datetime || !slots_available) {
      return res.status(400).json({
        error:
          "title, location, start_datetime, end_datetime, and slots_available are required",
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

    // Validate slots_available (must be positive integer)
    const slotsInt = parseInt(slots_available, 10);
    if (Number.isNaN(slotsInt) || slotsInt <= 0) {
      return res.status(400).json({
        error: "slots_available must be a positive integer",
      });
    }

    // Validate and format dates
    const formattedStartDate = formatMySQLDate(start_datetime);
    const formattedEndDate = formatMySQLDate(end_datetime);
    const formattedRegExpiration = registration_expiration
      ? formatMySQLDate(registration_expiration)
      : null;

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

    // Validate registration_expiration if provided
    if (formattedRegExpiration) {
      const regExpDate = new Date(registration_expiration);
      if (regExpDate >= startDate) {
        return res.status(400).json({
          error: "registration_expiration must be before start_datetime",
        });
      }
    }

    const sql = `
      INSERT INTO missions 
        (title, description, doctor_id, ngo_id, location, start_datetime, end_datetime, registration_expiration, slots_available, slots_filled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'upcoming', NOW(), NOW())
    `;

    const result = await runQuery(sql, [
      title,
      description || null,
      doctor_id || null,
      ngo_id || null,
      location,
      formattedStartDate,
      formattedEndDate,
      formattedRegExpiration,
      slotsInt,
    ]);

    const missionId = result.insertId;

    // Fetch the created mission
    const mission = await runQuery(
      `SELECT 
        m.*,
        d.username as doctor_username,
        d.email as doctor_email,
        n.username as ngo_username,
        n.email as ngo_email
      FROM missions m
      LEFT JOIN users d ON m.doctor_id = d.id
      LEFT JOIN users n ON m.ngo_id = n.id
      WHERE m.id = ?`,
      [missionId]
    );

    res.status(201).json({
      message: "Mission created successfully",
      mission: mission[0],
    });
  } catch (error) {
    console.error("Error creating mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /missions - List missions
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { status, doctor_id, ngo_id, my_missions } = req.query;

    let sql = `
      SELECT 
        m.*,
        d.username as doctor_username,
        d.email as doctor_email,
        n.username as ngo_username,
        n.email as ngo_email,
        (SELECT COUNT(*) FROM mission_registrations mr WHERE mr.mission_id = m.id) as registration_count
      FROM missions m
      LEFT JOIN users d ON m.doctor_id = d.id
      LEFT JOIN users n ON m.ngo_id = n.id
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
      sql += " AND m.status = ?";
      params.push(status);
    }

    // Filter by doctor_id
    if (doctor_id) {
      sql += " AND m.doctor_id = ?";
      params.push(doctor_id);
    }

    // Filter by ngo_id
    if (ngo_id) {
      sql += " AND m.ngo_id = ?";
      params.push(ngo_id);
    }

    // Filter by user's missions (missions they created or are associated with)
    if (my_missions === "true") {
      if (userRole === "doctor") {
        sql += " AND m.doctor_id = ?";
        params.push(userId);
      } else if (userRole === "ngo") {
        sql += " AND m.ngo_id = ?";
        params.push(userId);
      } else if (userRole === "admin") {
        // Admin sees all, no filter needed
      } else {
        // For other roles, check if they're registered
        sql += " AND EXISTS (SELECT 1 FROM mission_registrations mr WHERE mr.mission_id = m.id AND mr.patient_id = ?)";
        params.push(userId);
      }
    }

    sql += " ORDER BY m.start_datetime ASC, m.created_at DESC";

    const missions = await runQuery(sql, params);

    res.json({
      message: "Missions retrieved successfully",
      missions,
    });
  } catch (error) {
    console.error("Error fetching missions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /missions/:id - Get single mission
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const sql = `
      SELECT 
        m.*,
        d.username as doctor_username,
        d.email as doctor_email,
        n.username as ngo_username,
        n.email as ngo_email,
        (SELECT COUNT(*) FROM mission_registrations mr WHERE mr.mission_id = m.id) as registration_count,
        (SELECT COUNT(*) FROM mission_registrations mr2 WHERE mr2.mission_id = m.id AND mr2.patient_id = ?) as user_registered
      FROM missions m
      LEFT JOIN users d ON m.doctor_id = d.id
      LEFT JOIN users n ON m.ngo_id = n.id
      WHERE m.id = ?
    `;

    const mission = await runQuery(sql, [userId, id]);

    if (mission.length === 0) {
      return res.status(404).json({ error: "Mission not found" });
    }

    res.json({
      message: "Mission retrieved successfully",
      mission: mission[0],
    });
  } catch (error) {
    console.error("Error fetching mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /missions/:id - Update mission (creator or admin)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if mission exists
    const existing = await runQuery(
      "SELECT * FROM missions WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Mission not found" });
    }

    // Only creator (doctor or NGO) or admin can update
    const isCreator =
      existing[0].doctor_id === userId || existing[0].ngo_id === userId;

    if (!isCreator && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the mission creator or admin can update this mission",
      });
    }

    // Cannot update if mission is completed or cancelled
    if (existing[0].status === "completed" || existing[0].status === "cancelled") {
      return res.status(400).json({
        error: "Cannot update a mission that is completed or cancelled",
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
      registration_expiration,
      slots_available,
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
    if (registration_expiration !== undefined) {
      const formattedRegExpiration = registration_expiration
        ? formatMySQLDate(registration_expiration)
        : null;
      updates.push("registration_expiration = ?");
      params.push(formattedRegExpiration);
    }
    if (slots_available !== undefined) {
      const slotsInt = parseInt(slots_available, 10);
      if (Number.isNaN(slotsInt) || slotsInt <= 0) {
        return res.status(400).json({
          error: "slots_available must be a positive integer",
        });
      }
      // Cannot reduce slots below current filled slots
      if (slotsInt < existing[0].slots_filled) {
        return res.status(400).json({
          error: `Cannot reduce slots_available below current slots_filled (${existing[0].slots_filled})`,
        });
      }
      updates.push("slots_available = ?");
      params.push(slotsInt);
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

    const sql = `UPDATE missions SET ${updates.join(", ")} WHERE id = ?`;

    await runQuery(sql, params);

    // Fetch updated mission
    const updated = await runQuery(
      `SELECT 
        m.*,
        d.username as doctor_username,
        d.email as doctor_email,
        n.username as ngo_username,
        n.email as ngo_email
      FROM missions m
      LEFT JOIN users d ON m.doctor_id = d.id
      LEFT JOIN users n ON m.ngo_id = n.id
      WHERE m.id = ?`,
      [id]
    );

    res.json({
      message: "Mission updated successfully",
      mission: updated[0],
    });
  } catch (error) {
    console.error("Error updating mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /missions/:id - Delete mission (creator or admin)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if mission exists
    const existing = await runQuery(
      "SELECT * FROM missions WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Mission not found" });
    }

    // Only creator or admin can delete
    const isCreator =
      existing[0].doctor_id === userId || existing[0].ngo_id === userId;

    if (!isCreator && userRole !== "admin") {
      return res.status(403).json({
        error: "Only the mission creator or admin can delete this mission",
      });
    }

    // Check if there are registrations
    const registrations = await runQuery(
      "SELECT COUNT(*) as count FROM mission_registrations WHERE mission_id = ?",
      [id]
    );

    if (registrations[0].count > 0) {
      return res.status(400).json({
        error:
          "Cannot delete mission with existing registrations. Please cancel the mission instead.",
      });
    }

    await runQuery("DELETE FROM missions WHERE id = ?", [id]);

    res.json({ message: "Mission deleted successfully" });
  } catch (error) {
    console.error("Error deleting mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

