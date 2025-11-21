const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");
const requireRole = require("../middleware/roleCheck.js");

if (typeof authenticateToken !== "function") {
  throw new Error("authenticateToken middleware must be a function");
}

const allowedTraumaTypes = [
  "war_trauma",
  "loss",
  "childhood",
  "stress",
  "other",
];

const allowedSeverityLevels = ["mild", "moderate", "severe", "critical"];
const allowedAgeGroups = ["child", "teen", "adult", "senior"];
const allowedModes = ["video", "audio", "chat"];

const getConnection = () =>
  new Promise((resolve, reject) => {
    db.getConnection((err, connection) => {
      if (err) reject(err);
      else resolve(connection);
    });
  });

const queryConnection = (connection, sql, params = []) =>
  new Promise((resolve, reject) => {
    connection.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

const booleanize = (value, defaultValue = false) => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.toLowerCase());
  }
  return defaultValue;
};

const baseSelect = `
  SELECT
    c.id AS consultation_id,
    c.patient_id,
    c.doctor_id,
    c.specialty,
    c.status,
    c.mode,
    c.notes,
    c.slot_id,
    c.created_at AS consultation_created_at,
    c.updated_at AS consultation_updated_at,
    mhc.id AS mhc_id,
    mhc.trauma_type,
    mhc.severity_level,
    mhc.anonymity AS mhc_anonymity,
    mhc.age_group,
    mhc.session_focus,
    mhc.follow_up_required,
    mhc.follow_up_notes,
    mhc.created_at AS mhc_created_at,
    mhc.updated_at AS mhc_updated_at,
    p.username AS patient_username,
    p.email AS patient_email,
    p.contact_phone AS patient_contact_phone,
    d.username AS doctor_username,
    d.email AS doctor_email,
    d.contact_phone AS doctor_contact_phone,
    d.specialty AS doctor_specialty
  FROM mental_health_consultations mhc
  JOIN consultations c ON mhc.consultation_id = c.id
  JOIN users p ON c.patient_id = p.id
  JOIN users d ON c.doctor_id = d.id
`;

const formatConsultation = (row, requesterRole, requesterId) => {
  const base = {
    consultation_id: row.consultation_id,
    patient_id: row.patient_id,
    doctor_id: row.doctor_id,
    specialty: row.specialty,
    status: row.status,
    mode: row.mode,
    notes: row.notes,
    slot_id: row.slot_id,
    created_at: row.consultation_created_at,
    updated_at: row.consultation_updated_at,
    mental_health: {
      id: row.mhc_id,
      trauma_type: row.trauma_type,
      severity_level: row.severity_level,
      anonymity: !!row.mhc_anonymity,
      age_group: row.age_group,
      session_focus: row.session_focus,
      follow_up_required: !!row.follow_up_required,
      follow_up_notes: row.follow_up_notes,
      created_at: row.mhc_created_at,
      updated_at: row.mhc_updated_at,
    },
  };

  const patientVisible =
    requesterRole === "admin" ||
    row.patient_id === requesterId ||
    !row.mhc_anonymity;

  if (patientVisible) {
    base.patient = {
      id: row.patient_id,
      username: row.patient_username,
      email: row.patient_email,
      contact_phone: row.patient_contact_phone,
    };
  } else {
    base.patient = {
      anonymous: true,
      age_group: row.age_group,
    };
  }

  base.doctor = {
    id: row.doctor_id,
    username: row.doctor_username,
    email: row.doctor_email,
    contact_phone: row.doctor_contact_phone,
    specialty: row.doctor_specialty,
  };

  return base;
};

const fetchMentalConsultation = (whereClause, params) =>
  new Promise((resolve, reject) => {
    db.query(
      `${baseSelect} ${whereClause}`,
      params,
      (err, results) => {
        if (err) reject(err);
        else resolve(results);
      }
    );
  });

router.post("/", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;

  if (userRole !== "patient") {
    return res
      .status(403)
      .json({ error: "Only patients can create mental health consultations" });
  }

  const {
    doctor_id,
    slot_id,
    mode,
    notes,
    trauma_type,
    severity_level,
    anonymity,
    age_group,
    session_focus,
    follow_up_required,
    follow_up_notes,
  } = req.body;

  if (!doctor_id || !slot_id || !mode || !session_focus) {
    return res.status(400).json({
      error: "doctor_id, slot_id, mode, and session_focus are required",
    });
  }

  if (notes !== undefined && notes !== null) {
    return res
      .status(400)
      .json({ error: "Notes must be null when creating a consultation" });
  }

  if (!allowedModes.includes(mode)) {
    return res
      .status(400)
      .json({ error: `Invalid mode. Allowed: ${allowedModes.join(", ")}` });
  }

  if (trauma_type && !allowedTraumaTypes.includes(trauma_type)) {
    return res.status(400).json({
      error: `Invalid trauma_type. Allowed: ${allowedTraumaTypes.join(", ")}`,
    });
  }

  if (severity_level && !allowedSeverityLevels.includes(severity_level)) {
    return res.status(400).json({
      error: `Invalid severity_level. Allowed: ${allowedSeverityLevels.join(
        ", "
      )}`,
    });
  }

  if (age_group && !allowedAgeGroups.includes(age_group)) {
    return res.status(400).json({
      error: `Invalid age_group. Allowed: ${allowedAgeGroups.join(", ")}`,
    });
  }

  const sanitizedSessionFocus = String(session_focus).trim();
  if (sanitizedSessionFocus.length === 0) {
    return res
      .status(400)
      .json({ error: "session_focus cannot be empty" });
  }

  let connection;

  try {
    connection = await getConnection();
    await queryConnection(connection, "START TRANSACTION");

    const doctorResult = await queryConnection(
      connection,
      "SELECT id, role FROM users WHERE id = ?",
      [doctor_id]
    );

    if (doctorResult.length === 0 || doctorResult[0].role !== "doctor") {
      await queryConnection(connection, "ROLLBACK");
      return res
        .status(400)
        .json({ error: "Selected doctor does not exist or is not a doctor" });
    }

    const slotResult = await queryConnection(
      connection,
      "SELECT id, doctor_id, is_booked FROM consultation_slots WHERE id = ? FOR UPDATE",
      [slot_id]
    );

    if (slotResult.length === 0) {
      await queryConnection(connection, "ROLLBACK");
      return res.status(400).json({ error: "Selected slot does not exist" });
    }

    const slot = slotResult[0];

    if (slot.doctor_id !== Number(doctor_id)) {
      await queryConnection(connection, "ROLLBACK");
      return res.status(400).json({
        error: "Selected slot does not belong to the specified doctor",
      });
    }

    if (slot.is_booked) {
      await queryConnection(connection, "ROLLBACK");
      return res
        .status(400)
        .json({ error: "Selected slot is already booked" });
    }

    const consultationInsert = await queryConnection(
      connection,
      `INSERT INTO consultations
        (patient_id, doctor_id, specialty, status, mode, notes, slot_id)
        VALUES (?, ?, ?, 'pending', ?, NULL, ?)`,
      [userId, doctor_id, "mental_health", mode, slot_id]
    );

    const consultationId = consultationInsert.insertId;

    await queryConnection(
      connection,
      `INSERT INTO mental_health_consultations
        (consultation_id, trauma_type, severity_level, anonymity, age_group, session_focus, follow_up_required, follow_up_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        consultationId,
        trauma_type || null,
        severity_level || null,
        booleanize(anonymity),
        age_group || null,
        sanitizedSessionFocus,
        booleanize(follow_up_required),
        follow_up_notes || null,
      ]
    );

    await queryConnection(
      connection,
      `UPDATE consultation_slots
         SET is_booked = TRUE, consultation_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [consultationId, slot_id]
    );

    await queryConnection(connection, "COMMIT");

    const createdRows = await fetchMentalConsultation(
      "WHERE c.id = ?",
      [consultationId]
    );

    const created = createdRows[0];

    res.status(201).json({
      message: "Mental health consultation created successfully",
      consultation: formatConsultation(created, userRole, userId),
    });
  } catch (error) {
    if (connection) {
      try {
        await queryConnection(connection, "ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError);
      }
    }
    console.error("Create mental consultation error:", error);
    res.status(500).json({
      error: "Internal server error during mental consultation creation",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.get("/", authenticateToken, async (req, res) => {
  const role = req.user.role;
  const userId = req.user.id;

  if (!["patient", "doctor"].includes(role)) {
    return res.status(403).json({
      error: "Only patients or doctors can view mental health consultations",
    });
  }

  let whereClause = "WHERE";
  let params;

  if (role === "patient") {
    whereClause += " c.patient_id = ?";
    params = [userId];
  } else {
    whereClause += " c.doctor_id = ?";
    params = [userId];
  }

  try {
    const rows = await fetchMentalConsultation(whereClause, params);
    const consultations = rows.map((row) =>
      formatConsultation(row, role, userId)
    );

    res.json({
      message: "Mental health consultations retrieved successfully",
      consultations,
    });
  } catch (error) {
    console.error("Fetch mental consultations error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving mental consultations",
    });
  }
});

router.get(
  "/all",
  authenticateToken,
  requireRole("admin"),
  async (req, res) => {
    const {
      page = 1,
      limit = 20,
      sort_by = "c.created_at",
      sort_order = "desc",
      status,
      mode,
      doctor_id,
      patient_id,
      trauma_type,
      severity_level,
      anonymity,
      age_group,
      created_from,
      created_to,
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    if (Number.isNaN(pageNum) || pageNum < 1) {
      return res.status(400).json({ error: "Invalid page number" });
    }

    if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({
        error: "Invalid limit. Must be between 1 and 100",
      });
    }

    const allowedSortFields = [
      "c.created_at",
      "c.updated_at",
      "c.status",
      "c.mode",
      "c.doctor_id",
      "c.patient_id",
      "mhc.severity_level",
    ];

    if (!allowedSortFields.includes(sort_by)) {
      return res.status(400).json({
        error: `Invalid sort field. Allowed: ${allowedSortFields.join(", ")}`,
      });
    }

    const normalizedSortOrder = sort_order.toLowerCase();
    if (!["asc", "desc"].includes(normalizedSortOrder)) {
      return res
        .status(400)
        .json({ error: "Invalid sort order. Allowed: asc, desc" });
    }

    const conditions = [];
    const params = [];

    if (status) {
      const allowedStatus = ["pending", "confirmed", "completed", "cancelled"];
      if (!allowedStatus.includes(status)) {
        return res.status(400).json({
          error: `Invalid status. Allowed: ${allowedStatus.join(", ")}`,
        });
      }
      conditions.push("c.status = ?");
      params.push(status);
    }

    if (mode) {
      if (!allowedModes.includes(mode)) {
        return res.status(400).json({
          error: `Invalid mode. Allowed: ${allowedModes.join(", ")}`,
        });
      }
      conditions.push("c.mode = ?");
      params.push(mode);
    }

    if (doctor_id) {
      const doctorIdNum = parseInt(doctor_id, 10);
      if (Number.isNaN(doctorIdNum)) {
        return res.status(400).json({ error: "doctor_id must be a number" });
      }
      conditions.push("c.doctor_id = ?");
      params.push(doctorIdNum);
    }

    if (patient_id) {
      const patientIdNum = parseInt(patient_id, 10);
      if (Number.isNaN(patientIdNum)) {
        return res.status(400).json({ error: "patient_id must be a number" });
      }
      conditions.push("c.patient_id = ?");
      params.push(patientIdNum);
    }

    if (trauma_type) {
      if (!allowedTraumaTypes.includes(trauma_type)) {
        return res.status(400).json({
          error: `Invalid trauma_type. Allowed: ${allowedTraumaTypes.join(
            ", "
          )}`,
        });
      }
      conditions.push("mhc.trauma_type = ?");
      params.push(trauma_type);
    }

    if (severity_level) {
      if (!allowedSeverityLevels.includes(severity_level)) {
        return res.status(400).json({
          error: `Invalid severity_level. Allowed: ${allowedSeverityLevels.join(
            ", "
          )}`,
        });
      }
      conditions.push("mhc.severity_level = ?");
      params.push(severity_level);
    }

    if (anonymity !== undefined) {
      conditions.push("mhc.anonymity = ?");
      params.push(booleanize(anonymity) ? 1 : 0);
    }

    if (age_group) {
      if (!allowedAgeGroups.includes(age_group)) {
        return res.status(400).json({
          error: `Invalid age_group. Allowed: ${allowedAgeGroups.join(", ")}`,
        });
      }
      conditions.push("mhc.age_group = ?");
      params.push(age_group);
    }

    if (created_from) {
      const fromDate = new Date(created_from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "Invalid created_from date" });
      }
      conditions.push("c.created_at >= ?");
      params.push(created_from);
    }

    if (created_to) {
      const toDate = new Date(created_to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "Invalid created_to date" });
      }
      conditions.push("c.created_at <= ?");
      params.push(created_to);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (pageNum - 1) * limitNum;

    const dataQuery = `
      ${baseSelect}
      ${whereClause}
      ORDER BY ${sort_by} ${normalizedSortOrder}
      LIMIT ?
      OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM mental_health_consultations mhc
      JOIN consultations c ON mhc.consultation_id = c.id
      ${whereClause}
    `;

    db.query(countQuery, params, (countErr, countResults) => {
      if (countErr) {
        res.status(500).json({ error: countErr.message });
        return;
      }

      const total = countResults[0]?.total || 0;

      db.query(
        dataQuery,
        [...params, limitNum, offset],
        (dataErr, dataResults) => {
          if (dataErr) {
            res.status(500).json({ error: dataErr.message });
            return;
          }

          const consultations = dataResults.map((row) =>
            formatConsultation(row, "admin", null)
          );

          res.json({
            message: "All mental health consultations retrieved successfully",
            meta: {
              page: pageNum,
              limit: limitNum,
              total,
              total_pages: Math.ceil(total / limitNum),
            },
            consultations,
          });
        }
      );
    });
  }
);

router.get("/:id", authenticateToken, async (req, res) => {
  const mentalId = req.params.id;
  const role = req.user.role;
  const userId = req.user.id;

  try {
    const rows = await fetchMentalConsultation(
      "WHERE mhc.id = ?",
      [mentalId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Mental health consultation not found" });
    }

    const row = rows[0];

    if (
      role !== "admin" &&
      row.patient_id !== userId &&
      row.doctor_id !== userId
    ) {
      return res.status(403).json({
        error: "You do not have access to this consultation",
      });
    }

    res.json({
      message: "Mental health consultation retrieved successfully",
      consultation: formatConsultation(row, role, userId),
    });
  } catch (error) {
    console.error("Fetch mental consultation error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving mental consultation",
    });
  }
});

router.put("/:id", authenticateToken, async (req, res) => {
  const mentalId = req.params.id;
  const role = req.user.role;
  const userId = req.user.id;

  if (!["patient", "doctor"].includes(role)) {
    return res.status(403).json({
      error: "Only patients or doctors can update mental health consultations",
    });
  }

  try {
    const rows = await fetchMentalConsultation(
      "WHERE mhc.id = ?",
      [mentalId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Mental health consultation not found" });
    }

    const row = rows[0];

    if (role === "patient" && row.patient_id !== userId) {
      return res.status(403).json({
        error: "You can only update your own consultations",
      });
    }

    if (role === "doctor" && row.doctor_id !== userId) {
      return res.status(403).json({
        error: "You can only update your own consultations",
      });
    }

    const {
      session_focus,
      anonymity,
      age_group,
      trauma_type,
      severity_level,
      follow_up_required,
      follow_up_notes,
    } = req.body;

    const updates = [];
    const params = [];

    if (role === "patient") {
      if (session_focus !== undefined) {
        const focusTrimmed = String(session_focus).trim();
        if (focusTrimmed.length === 0) {
          return res
            .status(400)
            .json({ error: "session_focus cannot be empty" });
        }
        updates.push("session_focus = ?");
        params.push(focusTrimmed);
      }

      if (anonymity !== undefined) {
        updates.push("anonymity = ?");
        params.push(booleanize(anonymity) ? 1 : 0);
      }

      if (age_group !== undefined) {
        if (age_group && !allowedAgeGroups.includes(age_group)) {
          return res.status(400).json({
            error: `Invalid age_group. Allowed: ${allowedAgeGroups.join(", ")}`,
          });
        }
        updates.push("age_group = ?");
        params.push(age_group || null);
      }
    } else if (role === "doctor") {
      if (session_focus !== undefined) {
        const focusTrimmed = String(session_focus).trim();
        if (focusTrimmed.length === 0) {
          return res
            .status(400)
            .json({ error: "session_focus cannot be empty" });
        }
        updates.push("session_focus = ?");
        params.push(focusTrimmed);
      }

      if (trauma_type !== undefined) {
        if (trauma_type && !allowedTraumaTypes.includes(trauma_type)) {
          return res.status(400).json({
            error: `Invalid trauma_type. Allowed: ${allowedTraumaTypes.join(
              ", "
            )}`,
          });
        }
        updates.push("trauma_type = ?");
        params.push(trauma_type || null);
      }

      if (severity_level !== undefined) {
        if (
          severity_level &&
          !allowedSeverityLevels.includes(severity_level)
        ) {
          return res.status(400).json({
            error: `Invalid severity_level. Allowed: ${allowedSeverityLevels.join(
              ", "
            )}`,
          });
        }
        updates.push("severity_level = ?");
        params.push(severity_level || null);
      }

      if (follow_up_required !== undefined) {
        updates.push("follow_up_required = ?");
        params.push(booleanize(follow_up_required) ? 1 : 0);
      }

      if (follow_up_notes !== undefined) {
        updates.push("follow_up_notes = ?");
        params.push(follow_up_notes || null);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    updates.push("updated_at = NOW()");
    params.push(mentalId);

    await new Promise((resolve, reject) => {
      db.query(
        `UPDATE mental_health_consultations SET ${updates.join(", ")} WHERE id = ?`,
        params,
        (err, results) => {
          if (err) reject(err);
          else resolve(results);
        }
      );
    });

    const updatedRows = await fetchMentalConsultation(
      "WHERE mhc.id = ?",
      [mentalId]
    );

    res.json({
      message: "Mental health consultation updated successfully",
      consultation: formatConsultation(updatedRows[0], role, userId),
    });
  } catch (error) {
    console.error("Update mental consultation error:", error);
    res.status(500).json({
      error: "Internal server error during mental consultation update",
    });
  }
});

router.delete(
  "/:id",
  authenticateToken,
  requireRole("admin"),
  async (req, res) => {
    const mentalId = req.params.id;
    let connection;

    try {
      connection = await getConnection();
      await queryConnection(connection, "START TRANSACTION");

      const mentalResult = await queryConnection(
        connection,
        `SELECT mhc.consultation_id, c.slot_id
         FROM mental_health_consultations mhc
         JOIN consultations c ON mhc.consultation_id = c.id
         WHERE mhc.id = ? FOR UPDATE`,
        [mentalId]
      );

      if (mentalResult.length === 0) {
        await queryConnection(connection, "ROLLBACK");
        return res
          .status(404)
          .json({ error: "Mental health consultation not found" });
      }

      const { consultation_id, slot_id } = mentalResult[0];

      await queryConnection(
        connection,
        "DELETE FROM mental_health_consultations WHERE id = ?",
        [mentalId]
      );

      await queryConnection(
        connection,
        "DELETE FROM consultations WHERE id = ?",
        [consultation_id]
      );

      if (slot_id) {
        await queryConnection(
          connection,
          `UPDATE consultation_slots
             SET is_booked = FALSE,
                 consultation_id = NULL,
                 updated_at = NOW()
           WHERE id = ?`,
          [slot_id]
        );
      }

      await queryConnection(connection, "COMMIT");

      res.json({ message: "Mental health consultation deleted successfully" });
    } catch (error) {
      if (connection) {
        try {
          await queryConnection(connection, "ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback error:", rollbackError);
        }
      }
      console.error("Delete mental consultation error:", error);
      res.status(500).json({
        error: "Internal server error during mental consultation deletion",
      });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

module.exports = router;

