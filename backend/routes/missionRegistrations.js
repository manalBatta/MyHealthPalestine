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

// POST /mission-registrations - Register for mission (patients only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { mission_id } = req.body;

    // Only patients can register
    if (userRole !== "patient") {
      return res.status(403).json({
        error: "Only patients can register for missions",
      });
    }

    if (!mission_id) {
      return res.status(400).json({
        error: "mission_id is required",
      });
    }

    // Check if mission exists
    const mission = await runQuery(
      "SELECT * FROM missions WHERE id = ?",
      [mission_id]
    );

    if (mission.length === 0) {
      return res.status(404).json({ error: "Mission not found" });
    }

    // Check if mission is cancelled
    if (mission[0].status === "cancelled") {
      return res.status(400).json({
        error: "Cannot register for a cancelled mission",
      });
    }

    // Check if registration has expired
    if (mission[0].registration_expiration) {
      const regExpDate = new Date(mission[0].registration_expiration);
      if (regExpDate <= new Date()) {
        return res.status(400).json({
          error: "Registration period has expired for this mission",
        });
      }
    }

    // Check if mission has already started
    const startDate = new Date(mission[0].start_datetime);
    if (startDate <= new Date()) {
      return res.status(400).json({
        error: "Cannot register for a mission that has already started",
      });
    }

    // Check if slots are available
    if (mission[0].slots_filled >= mission[0].slots_available) {
      return res.status(400).json({
        error: "No slots available for this mission",
      });
    }

    // Check if user is already registered (prevent duplicates)
    const existing = await runQuery(
      "SELECT * FROM mission_registrations WHERE mission_id = ? AND patient_id = ?",
      [mission_id, userId]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        error: "You are already registered for this mission",
      });
    }

    // Start transaction to register and update slots
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

      // Create registration
      await new Promise((resolve, reject) => {
        connection.query(
          `INSERT INTO mission_registrations 
            (mission_id, patient_id, registered_at, attended)
          VALUES (?, ?, NOW(), false)`,
          [mission_id, userId],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Update slots_filled
      await new Promise((resolve, reject) => {
        connection.query(
          "UPDATE missions SET slots_filled = slots_filled + 1 WHERE id = ?",
          [mission_id],
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

      // Fetch the created registration
      const registration = await runQuery(
        `SELECT 
          mr.*,
          m.title as mission_title,
          m.start_datetime as mission_start_datetime,
          m.end_datetime as mission_end_datetime,
          m.location as mission_location,
          u.username as patient_username,
          u.email as patient_email
        FROM mission_registrations mr
        LEFT JOIN missions m ON mr.mission_id = m.id
        LEFT JOIN users u ON mr.patient_id = u.id
        WHERE mr.mission_id = ? AND mr.patient_id = ?`,
        [mission_id, userId]
      );

      res.status(201).json({
        message: "Successfully registered for mission",
        registration: registration[0],
      });
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
    console.error("Error registering for mission:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /mission-registrations - List registrations (role-based)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { mission_id, patient_id, attended } = req.query;

    let sql = `
      SELECT 
        mr.*,
        m.title as mission_title,
        m.start_datetime as mission_start_datetime,
        m.end_datetime as mission_end_datetime,
        m.location as mission_location,
        m.doctor_id,
        m.ngo_id,
        u.username as patient_username,
        u.email as patient_email
      FROM mission_registrations mr
      LEFT JOIN missions m ON mr.mission_id = m.id
      LEFT JOIN users u ON mr.patient_id = u.id
      WHERE 1=1
    `;

    const params = [];

    // Role-based filtering
    if (userRole === "admin") {
      // Admin can see all registrations
    } else if (userRole === "doctor") {
      // Doctors can see registrations for their missions
      sql += " AND m.doctor_id = ?";
      params.push(userId);
    } else if (userRole === "ngo") {
      // NGOs can see registrations for their missions
      sql += " AND m.ngo_id = ?";
      params.push(userId);
    } else {
      // Patients can only see their own registrations
      sql += " AND mr.patient_id = ?";
      params.push(userId);
    }

    // Additional filters
    if (mission_id) {
      sql += " AND mr.mission_id = ?";
      params.push(mission_id);
    }

    if (patient_id) {
      // Only admin, doctor, or NGO can filter by patient_id
      if (userRole === "admin" || userRole === "doctor" || userRole === "ngo") {
        sql += " AND mr.patient_id = ?";
        params.push(patient_id);
      }
    }

    if (attended !== undefined) {
      sql += " AND mr.attended = ?";
      params.push(attended === "true" ? 1 : 0);
    }

    sql += " ORDER BY mr.registered_at DESC";

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

// GET /mission-registrations/:id - Get single registration
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const sql = `
      SELECT 
        mr.*,
        m.title as mission_title,
        m.start_datetime as mission_start_datetime,
        m.end_datetime as mission_end_datetime,
        m.location as mission_location,
        m.doctor_id,
        m.ngo_id,
        u.username as patient_username,
        u.email as patient_email
      FROM mission_registrations mr
      LEFT JOIN missions m ON mr.mission_id = m.id
      LEFT JOIN users u ON mr.patient_id = u.id
      WHERE mr.id = ?
    `;

    const registration = await runQuery(sql, [id]);

    if (registration.length === 0) {
      return res.status(404).json({ error: "Registration not found" });
    }

    // Check access: user can see their own, admin can see all, creator can see for their missions
    const isCreator =
      registration[0].doctor_id === userId || registration[0].ngo_id === userId;

    if (
      userRole !== "admin" &&
      registration[0].patient_id !== userId &&
      !isCreator
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

// PUT /mission-registrations/:id/attendance - Mark attendance (admin, doctor, or NGO)
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
      `SELECT mr.*, m.doctor_id, m.ngo_id
       FROM mission_registrations mr
       LEFT JOIN missions m ON mr.mission_id = m.id
       WHERE mr.id = ?`,
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Registration not found" });
    }

    // Only admin, doctor, or NGO associated with the mission can mark attendance
    const isCreator =
      existing[0].doctor_id === userId || existing[0].ngo_id === userId;

    if (userRole !== "admin" && !isCreator) {
      return res.status(403).json({
        error: "Only admin, doctor, or NGO associated with the mission can mark attendance",
      });
    }

    const sql = `UPDATE mission_registrations SET attended = ? WHERE id = ?`;

    await runQuery(sql, [attended, id]);

    // Fetch updated registration
    const updated = await runQuery(
      `SELECT 
        mr.*,
        m.title as mission_title,
        m.start_datetime as mission_start_datetime,
        u.username as patient_username
      FROM mission_registrations mr
      LEFT JOIN missions m ON mr.mission_id = m.id
      LEFT JOIN users u ON mr.patient_id = u.id
      WHERE mr.id = ?`,
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

// DELETE /mission-registrations/:id - Cancel registration
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if registration exists
    const existing = await runQuery(
      `SELECT mr.*, m.start_datetime, m.doctor_id, m.ngo_id
       FROM mission_registrations mr
       LEFT JOIN missions m ON mr.mission_id = m.id
       WHERE mr.id = ?`,
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Registration not found" });
    }

    // Users can cancel their own registration, admin/creator can cancel any
    const isCreator =
      existing[0].doctor_id === userId || existing[0].ngo_id === userId;

    if (
      existing[0].patient_id !== userId &&
      userRole !== "admin" &&
      !isCreator
    ) {
      return res.status(403).json({
        error: "You can only cancel your own registration",
      });
    }

    // Check if mission has already started
    const startDate = new Date(existing[0].start_datetime);
    if (startDate <= new Date() && existing[0].attended) {
      return res.status(400).json({
        error: "Cannot cancel registration for a mission that has already occurred",
      });
    }

    // Start transaction to cancel registration and update slots
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

      // Delete registration
      await new Promise((resolve, reject) => {
        connection.query(
          "DELETE FROM mission_registrations WHERE id = ?",
          [id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Update slots_filled
      await new Promise((resolve, reject) => {
        connection.query(
          "UPDATE missions SET slots_filled = GREATEST(0, slots_filled - 1) WHERE id = ?",
          [existing[0].mission_id],
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

      res.json({ message: "Registration cancelled successfully" });
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
    console.error("Error cancelling registration:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

