const express = require("express");
const router = express.Router();
const db = require("../db.js");
const authenticateToken = require("../middleware/auth.js");

const SPONSORED_TYPES = [
  "surgery",
  "cancer_treatment",
  "dialysis",
  "rehabilitation",
];

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

const ensurePatientAndDoctor = async (patientId, doctorId) => {
  const users = await runQuery(
    "SELECT id, role FROM users WHERE id IN (?, ?)",
    [patientId, doctorId]
  );

  if (users.length !== 2) {
    throw new Error("Patient or doctor not found");
  }

  const patient = users.find((u) => u.id === Number(patientId));
  const doctor = users.find((u) => u.id === Number(doctorId));

  if (!patient || patient.role !== "patient") {
    throw new Error("Invalid patient_id");
  }

  if (!doctor || doctor.role !== "doctor") {
    throw new Error("Invalid doctor_id");
  }
};

const canManageRequest = (user, request) => {
  if (user.role === "patient") {
    return request.patient_id === user.id;
  }
  if (user.role === "doctor") {
    return request.doctor_id === user.id;
  }
  return user.role !== "patient";
};

router.post("/", authenticateToken, async (req, res) => {
  try {
    if (req.user.role === "patient") {
      return res
        .status(403)
        .json({ error: "Patients cannot create treatment requests" });
    }

    const {
      consultation_id,
      doctor_id,
      patient_id,
      treatment_type,
      content,
      medicine_name,
      dosage,
      frequency,
      duration,
      attachment_type,
      file_url,
      description,
      sponsered,
      goal_amount,
      language,
    } = req.body;

    if (!patient_id) {
      return res.status(400).json({ error: "patient_id is required" });
    }
    if (!treatment_type) {
      return res.status(400).json({ error: "treatment_type is required" });
    }

    const resolvedDoctorId =
      req.user.role === "doctor"
        ? req.user.id
        : doctor_id || req.user.id;

    if (!resolvedDoctorId) {
      return res.status(400).json({ error: "doctor_id is required" });
    }

    await ensurePatientAndDoctor(patient_id, resolvedDoctorId);

    const isSponsoredType = SPONSORED_TYPES.includes(treatment_type);
    const finalSponsored =
      typeof sponsered === "boolean" ? sponsered : isSponsoredType;

    if (finalSponsored && (!goal_amount || Number(goal_amount) <= 0)) {
      return res.status(400).json({
        error: "goal_amount must be provided for sponsored requests",
      });
    }

    const insertResult = await runQuery(
      `INSERT INTO treatment_requests
        (consultation_id, doctor_id, patient_id, treatment_type, content,
         medicine_name, dosage, frequency, duration, attachment_type, file_url,
         description, sponsered, goal_amount, language, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        consultation_id || null,
        resolvedDoctorId,
        patient_id,
        treatment_type,
        content || null,
        medicine_name || null,
        dosage || null,
        frequency || null,
        duration || null,
        attachment_type || null,
        file_url || null,
        description || null,
        finalSponsored ? 1 : 0,
        finalSponsored ? goal_amount : null,
        language || null,
      ]
    );

    const [request] = await runQuery(
      "SELECT * FROM treatment_requests WHERE id = ?",
      [insertResult.insertId]
    );

    res.status(201).json({
      message: "Treatment request created successfully",
      treatment_request: request,
    });
  } catch (error) {
    console.error("Create treatment request error:", error);
    res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
});

router.get("/", authenticateToken, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const {
      status,
      treatment_type,
      patient_id,
      doctor_id,
      page = 1,
      limit = 20,
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

    const conditions = [];
    const params = [];

    if (role === "patient") {
      conditions.push("patient_id = ?");
      params.push(userId);
    } else if (role === "doctor") {
      conditions.push("doctor_id = ?");
      params.push(userId);
    } else {
      if (patient_id) {
        conditions.push("patient_id = ?");
        params.push(patient_id);
      }
      if (doctor_id) {
        conditions.push("doctor_id = ?");
        params.push(doctor_id);
      }
    }

    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    if (treatment_type) {
      conditions.push("treatment_type = ?");
      params.push(treatment_type);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const data = await runQuery(
      `SELECT * FROM treatment_requests
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ?
       OFFSET ?`,
      [...params, limitNum, (pageNum - 1) * limitNum]
    );

    res.json({
      message: "Treatment requests retrieved successfully",
      data,
      meta: { page: pageNum, limit: limitNum },
    });
  } catch (error) {
    console.error("Get treatment requests error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving treatment requests",
    });
  }
});

router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const requestId = req.params.id;

    const results = await runQuery(
      "SELECT * FROM treatment_requests WHERE id = ?",
      [requestId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: "Treatment request not found" });
    }

    const request = results[0];

    if (!canManageRequest(req.user, request)) {
      return res.status(403).json({
        error: "You do not have access to this treatment request",
      });
    }

    res.json({
      message: "Treatment request retrieved successfully",
      treatment_request: request,
    });
  } catch (error) {
    console.error("Get treatment request error:", error);
    res.status(500).json({
      error: "Internal server error while retrieving treatment request",
    });
  }
});

router.put("/:id", authenticateToken, async (req, res) => {
  try {
    if (req.user.role === "patient") {
      return res
        .status(403)
        .json({ error: "Patients cannot update treatment requests" });
    }

    const requestId = req.params.id;
    const results = await runQuery(
      "SELECT * FROM treatment_requests WHERE id = ?",
      [requestId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: "Treatment request not found" });
    }

    const request = results[0];

    if (!canManageRequest(req.user, request)) {
      return res.status(403).json({
        error: "You do not have access to this treatment request",
      });
    }

    const {
      content,
      medicine_name,
      dosage,
      frequency,
      duration,
      attachment_type,
      file_url,
      description,
      sponsered,
      goal_amount,
      status,
      language,
    } = req.body;

    const updates = [];
    const params = [];

    const addField = (field, value) => {
      updates.push(`${field} = ?`);
      params.push(value);
    };

    if (content !== undefined) addField("content", content);
    if (medicine_name !== undefined) addField("medicine_name", medicine_name);
    if (dosage !== undefined) addField("dosage", dosage);
    if (frequency !== undefined) addField("frequency", frequency);
    if (duration !== undefined) addField("duration", duration);
    if (attachment_type !== undefined)
      addField("attachment_type", attachment_type);
    if (file_url !== undefined) addField("file_url", file_url);
    if (description !== undefined) addField("description", description);
    if (language !== undefined) addField("language", language);

    if (sponsered !== undefined) addField("sponsered", sponsered ? 1 : 0);
    if (goal_amount !== undefined) addField("goal_amount", goal_amount);
    if (status !== undefined) addField("status", status);

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    addField("updated_at", new Date());
    params.push(requestId);

    await runQuery(
      `UPDATE treatment_requests SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    const [updated] = await runQuery(
      "SELECT * FROM treatment_requests WHERE id = ?",
      [requestId]
    );

    res.json({
      message: "Treatment request updated successfully",
      treatment_request: updated,
    });
  } catch (error) {
    console.error("Update treatment request error:", error);
    res.status(500).json({
      error: "Internal server error while updating treatment request",
    });
  }
});

router.get(
  "/donations/browse",
  authenticateToken,
  async (req, res) => {
    try {
      const {
        doctor_id,
        patient_id,
        treatment_type,
        min_remaining,
        max_remaining,
        status = "open",
        search,
        page = 1,
        limit = 20,
      } = req.query;

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      if (Number.isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({ error: "Invalid page number" });
      }
      if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res
          .status(400)
          .json({ error: "Invalid limit. Must be between 1 and 100" });
      }

      const conditions = ["sponsered = TRUE"];
      const params = [];

      if (status) {
        conditions.push("status = ?");
        params.push(status);
      }

      if (doctor_id) {
        conditions.push("doctor_id = ?");
        params.push(doctor_id);
      }

      if (patient_id) {
        conditions.push("patient_id = ?");
        params.push(patient_id);
      }

      if (treatment_type) {
        conditions.push("treatment_type = ?");
        params.push(treatment_type);
      }

      const remainingExpr = "(goal_amount - raised_amount)";
      if (min_remaining) {
        conditions.push(`${remainingExpr} >= ?`);
        params.push(min_remaining);
      }

      if (max_remaining) {
        conditions.push(`${remainingExpr} <= ?`);
        params.push(max_remaining);
      }

      if (search) {
        conditions.push("(content LIKE ? OR description LIKE ?)");
        params.push(`%${search}%`, `%${search}%`);
      }

      const whereClause = `WHERE ${conditions.join(" AND ")}`;

      const data = await runQuery(
        `SELECT *,
                (goal_amount - raised_amount) AS remaining_amount
         FROM treatment_requests
         ${whereClause}
         ORDER BY remaining_amount DESC
         LIMIT ?
         OFFSET ?`,
        [...params, limitNum, (pageNum - 1) * limitNum]
      );

      res.json({
        message: "Sponsored treatment requests retrieved successfully",
        data,
        meta: { page: pageNum, limit: limitNum },
      });
    } catch (error) {
      console.error("Browse treatment requests error:", error);
      res.status(500).json({
        error: "Internal server error while browsing treatment requests",
      });
    }
  }
);

module.exports = router;

