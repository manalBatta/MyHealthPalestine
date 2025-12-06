const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

// Helper to ensure a user is a doctor
const ensureDoctorRole = (user) => {
  if (user.role !== "doctor") {
    const error = new Error("Only doctors can manage consultation slots");
    error.statusCode = 403;
    throw error;
  }
};

// POST /consultation-slots - create (optionally recurring) slots (doctor only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    ensureDoctorRole(req.user);
    const doctorId = req.user.id;

    const {
      start_datetime,
      end_datetime,
      recurrence_count, // optional: number of extra slots
      recurrence_interval_days, // optional: days between repeats (default 7)
    } = req.body;

    if (!start_datetime || !end_datetime) {
      return res.status(400).json({
        error: "start_datetime and end_datetime are required",
      });
    }

    const start = new Date(start_datetime);
    const end = new Date(end_datetime);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({
        error: "Invalid start_datetime or end_datetime format",
      });
    }

    if (end <= start) {
      return res.status(400).json({
        error: "end_datetime must be after start_datetime",
      });
    }

    const count = recurrence_count ? parseInt(recurrence_count, 10) : 0;
    const intervalDays = recurrence_interval_days
      ? parseInt(recurrence_interval_days, 10)
      : 7;

    if (count < 0) {
      return res.status(400).json({
        error: "recurrence_count must be a positive integer",
      });
    }

    if (intervalDays <= 0) {
      return res.status(400).json({
        error: "recurrence_interval_days must be a positive integer",
      });
    }

    const slotsToCreate = [];
    for (let i = 0; i <= count; i += 1) {
      const slotStart = new Date(start.getTime());
      const slotEnd = new Date(end.getTime());
      if (i > 0) {
        slotStart.setDate(slotStart.getDate() + i * intervalDays);
        slotEnd.setDate(slotEnd.getDate() + i * intervalDays);
      }
      // Convert to MySQL datetime format: YYYY-MM-DD HH:MM:SS
      const mysqlStart = slotStart.toISOString().slice(0, 19).replace('T', ' ');
      const mysqlEnd = slotEnd.toISOString().slice(0, 19).replace('T', ' ');
      const mysqlCreated = new Date().toISOString().slice(0, 19).replace('T', ' ');
      slotsToCreate.push([doctorId, mysqlStart, mysqlEnd, false, null, mysqlCreated, null]);
    }

    const insertSql = `
      INSERT INTO consultation_slots
        (doctor_id, start_datetime, end_datetime, is_booked, consultation_id, created_at, updated_at)
      VALUES ?
    `;

    const result = await new Promise((resolve, reject) => {
      db.query(insertSql, [slotsToCreate], (err, res2) => {
        if (err) reject(err);
        else resolve(res2);
      });
    });

    const firstId = result.insertId;
    const ids = Array.from({ length: slotsToCreate.length }, (_, idx) => firstId + idx);

    const createdSlots = await runQuery(
      `SELECT * FROM consultation_slots WHERE id IN (?) ORDER BY start_datetime ASC`,
      [ids]
    );

    res.status(201).json({
      message: "Consultation slot(s) created successfully",
      slots: createdSlots,
    });
  } catch (error) {
    console.error("Create consultation slots error:", error);
    res.status(error.statusCode || 500).json({
      error:
        error.statusCode === 403
          ? error.message
          : "Internal server error while creating consultation slots",
    });
  }
});

// GET /consultation-slots - list slots (doctor: own; patient: available by doctor)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;

    const {
      doctor_id,
      is_booked,
      from,
      to,
      page = 1,
      limit = 50,
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    if (Number.isNaN(pageNum) || pageNum < 1) {
      return res.status(400).json({ error: "Invalid page number" });
    }
    if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 200) {
      return res.status(400).json({
        error: "Invalid limit. Must be between 1 and 200",
      });
    }

    const conditions = [];
    const params = [];

    if (role === "doctor") {
      conditions.push("doctor_id = ?");
      params.push(userId);
    } else if (role === "patient") {
      if (!doctor_id) {
        return res.status(400).json({
          error: "doctor_id is required for patients",
        });
      }
      conditions.push("doctor_id = ?");
      params.push(doctor_id);
      conditions.push("is_booked = FALSE");
      conditions.push("end_datetime > NOW()");
    } else {
      if (doctor_id) {
        conditions.push("doctor_id = ?");
        params.push(doctor_id);
      }
    }

    if (is_booked !== undefined && role !== "patient") {
      if (!["true", "false", "0", "1"].includes(String(is_booked))) {
        return res.status(400).json({
          error: "is_booked must be a boolean (true/false)",
        });
      }
      const bookedVal =
        String(is_booked).toLowerCase() === "true" ||
        String(is_booked) === "1";
      conditions.push("is_booked = ?");
      params.push(bookedVal ? 1 : 0);
    }

    if (from) {
      const fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "Invalid from date" });
      }
      // Convert to MySQL datetime format: YYYY-MM-DD HH:MM:SS
      const mysqlFrom = fromDate.toISOString().slice(0, 19).replace('T', ' ');
      conditions.push("start_datetime >= ?");
      params.push(mysqlFrom);
    }

    if (to) {
      const toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "Invalid to date" });
      }
      // Convert to MySQL datetime format: YYYY-MM-DD HH:MM:SS
      const mysqlTo = toDate.toISOString().slice(0, 19).replace('T', ' ');
      conditions.push("end_datetime <= ?");
      params.push(mysqlTo);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const data = await runQuery(
      `SELECT * FROM consultation_slots
       ${whereClause}
       ORDER BY start_datetime ASC
       LIMIT ?
       OFFSET ?`,
      [...params, limitNum, (pageNum - 1) * limitNum]
    );

    res.json({
      message: "Consultation slots retrieved successfully",
      slots: data,
      meta: { page: pageNum, limit: limitNum },
    });
  } catch (error) {
    console.error("Get consultation slots error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving consultation slots",
    });
  }
});

// GET /consultation-slots/:id - get single slot (doctor owner, patient (if unbooked), or admin)
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;
    const slotId = req.params.id;

    const results = await runQuery(
      "SELECT * FROM consultation_slots WHERE id = ?",
      [slotId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: "Consultation slot not found" });
    }

    const slot = results[0];

    if (role === "doctor" && slot.doctor_id !== userId) {
      return res.status(403).json({
        error: "You can only view your own slots",
      });
    }

    if (role === "patient" && slot.is_booked) {
      return res.status(403).json({
        error: "You can only view available slots",
      });
    }

    res.json({
      message: "Consultation slot retrieved successfully",
      slot,
    });
  } catch (error) {
    console.error("Get consultation slot error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving consultation slot",
    });
  }
});

// PUT /consultation-slots/:id - update slot (doctor only, not booked)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    ensureDoctorRole(req.user);
    const doctorId = req.user.id;
    const slotId = req.params.id;

    const results = await runQuery(
      "SELECT * FROM consultation_slots WHERE id = ?",
      [slotId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: "Consultation slot not found" });
    }

    const slot = results[0];

    if (slot.doctor_id !== doctorId) {
      return res.status(403).json({
        error: "You can only update your own slots",
      });
    }

    if (slot.is_booked) {
      return res.status(400).json({
        error: "Cannot edit a booked slot. Cancel the consultation or delete the slot instead.",
      });
    }

    const {
      start_datetime,
      end_datetime,
    } = req.body;

    const updates = [];
    const params = [];

    if (start_datetime !== undefined) {
      const start = new Date(start_datetime);
      if (Number.isNaN(start.getTime())) {
        return res.status(400).json({ error: "Invalid start_datetime" });
      }
      // Convert to MySQL datetime format: YYYY-MM-DD HH:MM:SS
      const mysqlStart = start.toISOString().slice(0, 19).replace('T', ' ');
      updates.push("start_datetime = ?");
      params.push(mysqlStart);
    }

    if (end_datetime !== undefined) {
      const end = new Date(end_datetime);
      if (Number.isNaN(end.getTime())) {
        return res.status(400).json({ error: "Invalid end_datetime" });
      }
      // Convert to MySQL datetime format: YYYY-MM-DD HH:MM:SS
      const mysqlEnd = end.toISOString().slice(0, 19).replace('T', ' ');
      updates.push("end_datetime = ?");
      params.push(mysqlEnd);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.push("updated_at = NOW()");
    params.push(slotId);

    await runQuery(
      `UPDATE consultation_slots SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    const [updated] = await runQuery(
      "SELECT * FROM consultation_slots WHERE id = ?",
      [slotId]
    );

    res.json({
      message: "Consultation slot updated successfully",
      slot: updated,
    });
  } catch (error) {
    console.error("Update consultation slot error:", error);
    res.status(error.statusCode || 500).json({
      error:
        error.statusCode === 403
          ? error.message
          : "Internal server error while updating consultation slot",
    });
  }
});

// DELETE /consultation-slots/:id - delete slot (doctor only; booked -> also cancel consultation)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    ensureDoctorRole(req.user);
    const doctorId = req.user.id;
    const slotId = req.params.id;

    const results = await runQuery(
      "SELECT * FROM consultation_slots WHERE id = ?",
      [slotId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: "Consultation slot not found" });
    }

    const slot = results[0];

    if (slot.doctor_id !== doctorId) {
      return res.status(403).json({
        error: "You can only delete your own slots",
      });
    }

    const connection = await new Promise((resolve, reject) => {
      db.getConnection((err, conn) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });

    try {
      await new Promise((resolve, reject) =>
        connection.query("START TRANSACTION", (err) =>
          err ? reject(err) : resolve()
        )
      );

      if (slot.is_booked && slot.consultation_id) {
        // Cancel the associated consultation if slot is booked
        await new Promise((resolve, reject) => {
          connection.query(
            `UPDATE consultations
               SET status = 'cancelled', slot_id = NULL, updated_at = NOW()
             WHERE id = ?`,
            [slot.consultation_id],
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            }
          );
        });
      }

      await new Promise((resolve, reject) => {
        connection.query(
          "DELETE FROM consultation_slots WHERE id = ?",
          [slotId],
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      });

      await new Promise((resolve, reject) =>
        connection.query("COMMIT", (err) =>
          err ? reject(err) : resolve()
        )
      );
    } catch (txError) {
      await new Promise((resolve) =>
        connection.query("ROLLBACK", () => resolve())
      );
      throw txError;
    } finally {
      connection.release();
    }

    res.json({
      message: "Consultation slot deleted successfully",
    });
  } catch (error) {
    console.error("Delete consultation slot error:", error);
    res.status(error.statusCode || 500).json({
      error:
        error.statusCode === 403
          ? error.message
          : "Internal server error while deleting consultation slot",
    });
  }
});

module.exports = router;


