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

// Helper function to check inventory and set status/assigned_source_id
const checkInventoryAndSetStatus = async (itemName, quantityNeeded) => {
  // Fuzzy matching: find items in inventory that match the requested item name
  const inventoryItems = await runQuery(
    `SELECT source_id, SUM(quantity_available) as total_available
     FROM inventory_registry
     WHERE name LIKE ? AND quantity_available > 0
     GROUP BY source_id
     HAVING total_available >= ?`,
    [`%${itemName}%`, quantityNeeded]
  );

  if (inventoryItems.length > 0) {
    // Find the source with the most available quantity
    const bestSource = inventoryItems.reduce((prev, current) =>
      prev.total_available > current.total_available ? prev : current
    );
    return {
      status: "available",
      assigned_source_id: bestSource.source_id,
    };
  }

  // Check if any inventory exists (even if insufficient)
  const anyInventory = await runQuery(
    `SELECT SUM(quantity_available) as total
     FROM inventory_registry
     WHERE name LIKE ?`,
    [`%${itemName}%`]
  );

  if (anyInventory[0] && anyInventory[0].total && anyInventory[0].total > 0) {
    // Some inventory exists but not enough
    return {
      status: "pending",
      assigned_source_id: null,
    };
  }

  // No inventory found
  return {
    status: "pending",
    assigned_source_id: null,
  };
};

// POST /medicine-requests - Create medicine request (patient or doctor)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { patient_id, item_name_requested, quantity_needed, delivery_location, notes } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Validate required fields
    if (!patient_id || !item_name_requested || !quantity_needed || !delivery_location) {
      return res.status(400).json({
        error: "patient_id, item_name_requested, quantity_needed, and delivery_location are required",
      });
    }

    if (quantity_needed <= 0) {
      return res.status(400).json({
        error: "quantity_needed must be greater than 0",
      });
    }

    // Check if patient exists
    const patient = await runQuery("SELECT id, role FROM users WHERE id = ?", [patient_id]);
    if (patient.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }
    if (patient[0].role !== "patient") {
      return res.status(400).json({ error: "patient_id must refer to a patient" });
    }

    // Authorization: Patient can only create for themselves, doctor can create for their patients
    if (userRole === "patient") {
      if (parseInt(patient_id) !== userId) {
        return res.status(403).json({
          error: "Patients can only create medicine requests for themselves",
        });
      }
    } else if (userRole === "doctor") {
      // Check if doctor has a connection with this patient
      const connection = await runQuery(
        "SELECT id FROM connections WHERE patient_id = ? AND doctor_id = ? AND status = 'active'",
        [patient_id, userId]
      );
      if (connection.length === 0) {
        return res.status(403).json({
          error: "Doctor can only create medicine requests for connected patients",
        });
      }
    } else {
      return res.status(403).json({
        error: "Only patients and doctors can create medicine requests",
      });
    }

    // Check inventory and determine status/assigned_source_id
    const inventoryCheck = await checkInventoryAndSetStatus(item_name_requested, quantity_needed);

    // Insert medicine request
    const result = await runQuery(
      `INSERT INTO medicine_requests 
       (patient_id, item_name_requested, quantity_needed, delivery_location, assigned_source_id, status, notes, requested_date) 
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        patient_id,
        item_name_requested,
        quantity_needed,
        delivery_location,
        inventoryCheck.assigned_source_id,
        inventoryCheck.status,
        notes || null,
      ]
    );

    const medicineRequest = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [result.insertId]
    );

    res.status(201).json({
      message: "Medicine request created successfully",
      data: medicineRequest[0],
    });
  } catch (error) {
    console.error("Error creating medicine request:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /medicine-requests - List medicine requests with filtering and pagination
router.get("/", authenticateToken, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sort_by = "requested_date",
      sort_order = "desc",
      status,
      patient_id,
      assigned_source_id,
      item_name_requested,
      has_inventory, // Filter by requests where source has inventory (for sources)
      requested_from,
      requested_to,
    } = req.query;

    const userId = req.user.id;
    const userRole = req.user.role;

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
      "request_id",
      "patient_id",
      "item_name_requested",
      "quantity_needed",
      "assigned_source_id",
      "status",
      "requested_date",
      "fulfilled_date",
    ];

    if (!allowedSortFields.includes(sort_by)) {
      return res.status(400).json({
        error: `Invalid sort field. Allowed: ${allowedSortFields.join(", ")}`,
      });
    }

    const normalizedSortOrder = sort_order.toLowerCase();
    if (!["asc", "desc"].includes(normalizedSortOrder)) {
      return res.status(400).json({ error: "Invalid sort order. Allowed: asc, desc" });
    }

    // Build conditions and params
    const conditions = [];
    const params = [];
    let joins = "";

    // Role-based base filtering
    if (userRole === "patient") {
      conditions.push("mr.patient_id = ?");
      params.push(userId);
    } else if (userRole === "doctor") {
      joins = "INNER JOIN connections c ON mr.patient_id = c.patient_id";
      conditions.push("c.doctor_id = ? AND c.status = 'active'");
      params.push(userId);
    } else if (userRole === "admin") {
      // Admin sees all - no base condition
    } else if (["hospital", "ngo", "donor"].includes(userRole)) {
      // Sources see all requests, but can filter by their inventory
      // No base condition - they see all
    } else {
      return res.status(403).json({ error: "Access denied" });
    }

    // Filter by inventory availability (for sources) - add join if needed
    if (has_inventory === "true" && ["hospital", "ngo", "donor"].includes(userRole)) {
      if (joins) {
        joins += ` INNER JOIN inventory_registry ir ON mr.item_name_requested LIKE CONCAT('%', ir.name, '%')`;
      } else {
        joins = `INNER JOIN inventory_registry ir ON mr.item_name_requested LIKE CONCAT('%', ir.name, '%')`;
      }
      conditions.push("ir.source_id = ? AND ir.quantity_available > 0");
      params.push(userId);
    }

    // Add additional filters
    if (status) {
      const allowedStatuses = ["pending", "available", "in_progress", "fulfilled", "rejected", "cancelled"];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          error: `Invalid status. Allowed: ${allowedStatuses.join(", ")}`,
        });
      }
      conditions.push("mr.status = ?");
      params.push(status);
    }

    if (patient_id) {
      const patientIdNum = parseInt(patient_id, 10);
      if (Number.isNaN(patientIdNum)) {
        return res.status(400).json({ error: "patient_id must be a number" });
      }
      conditions.push("mr.patient_id = ?");
      params.push(patientIdNum);
    }

    if (assigned_source_id) {
      const sourceIdNum = parseInt(assigned_source_id, 10);
      if (Number.isNaN(sourceIdNum)) {
        return res.status(400).json({ error: "assigned_source_id must be a number" });
      }
      conditions.push("mr.assigned_source_id = ?");
      params.push(sourceIdNum);
    }

    if (item_name_requested) {
      conditions.push("mr.item_name_requested LIKE ?");
      params.push(`%${item_name_requested}%`);
    }

    if (requested_from) {
      const fromDate = new Date(requested_from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "Invalid requested_from date" });
      }
      conditions.push("mr.requested_date >= ?");
      params.push(requested_from);
    }

    if (requested_to) {
      const toDate = new Date(requested_to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "Invalid requested_to date" });
      }
      conditions.push("mr.requested_date <= ?");
      params.push(requested_to);
    }

    // Build WHERE clause
    const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";

    const offset = (pageNum - 1) * limitNum;

    // Build data query
    const dataQuery = `
      SELECT DISTINCT mr.*
      FROM medicine_requests mr
      ${joins}
      ${whereClause}
      ORDER BY mr.${sort_by} ${normalizedSortOrder}
      LIMIT ?
      OFFSET ?
    `;

    // Build count query (same structure)
    const countQuery = `
      SELECT COUNT(DISTINCT mr.request_id) AS total
      FROM medicine_requests mr
      ${joins}
      ${whereClause}
    `;

    const [requests, countResult] = await Promise.all([
      runQuery(dataQuery, [...params, limitNum, offset]),
      runQuery(countQuery, params),
    ]);

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / limitNum);

    res.status(200).json({
      message: "Medicine requests retrieved successfully",
      data: requests,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching medicine requests:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /medicine-requests/:id - Get single medicine request
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const request = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    if (request.length === 0) {
      return res.status(404).json({ error: "Medicine request not found" });
    }

    const reqData = request[0];

    // Authorization check
    if (userRole === "patient") {
      if (parseInt(reqData.patient_id) !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
    } else if (userRole === "doctor") {
      // Check if doctor has a connection with this patient
      const connection = await runQuery(
        "SELECT id FROM connections WHERE patient_id = ? AND doctor_id = ? AND status = 'active'",
        [reqData.patient_id, userId]
      );
      if (connection.length === 0) {
        return res.status(403).json({ error: "Access denied" });
      }
    } else if (!["admin", "hospital", "ngo", "donor"].includes(userRole)) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.status(200).json({
      message: "Medicine request retrieved successfully",
      data: reqData,
    });
  } catch (error) {
    console.error("Error fetching medicine request:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /medicine-requests/:id/accept - Accept request (source only)
router.put("/:id/accept", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Only sources can accept
    if (!["hospital", "ngo", "donor"].includes(userRole)) {
      return res.status(403).json({
        error: "Only hospitals, NGOs, and donors can accept medicine requests",
      });
    }

    const request = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    if (request.length === 0) {
      return res.status(404).json({ error: "Medicine request not found" });
    }

    const reqData = request[0];

    // Check if request is available or pending
    if (!["pending", "available", "rejected"].includes(reqData.status)) {
      return res.status(400).json({
        error: `Cannot accept request with status: ${reqData.status}`,
      });
    }

    // Check if source has inventory for this item (fuzzy match)
    const inventory = await runQuery(
      `SELECT SUM(quantity_available) as total
       FROM inventory_registry
       WHERE source_id = ? AND name LIKE ? AND quantity_available > 0`,
      [userId, `%${reqData.item_name_requested}%`]
    );

    if (!inventory[0].total || inventory[0].total < reqData.quantity_needed) {
      return res.status(400).json({
        error: "Insufficient inventory to fulfill this request",
      });
    }

    // Update request status and assign source
    await runQuery(
      "UPDATE medicine_requests SET status = 'in_progress', assigned_source_id = ? WHERE request_id = ?",
      [userId, id]
    );

    const updated = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    res.status(200).json({
      message: "Medicine request accepted successfully",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error accepting medicine request:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /medicine-requests/:id/reject - Reject request (source only)
router.put("/:id/reject", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Only sources can reject
    if (!["hospital", "ngo", "donor"].includes(userRole)) {
      return res.status(403).json({
        error: "Only hospitals, NGOs, and donors can reject medicine requests",
      });
    }

    const request = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    if (request.length === 0) {
      return res.status(404).json({ error: "Medicine request not found" });
    }

    const reqData = request[0];

    // Check if request is in_progress or available
    if (!["in_progress", "available"].includes(reqData.status)) {
      return res.status(400).json({
        error: `Cannot reject request with status: ${reqData.status}`,
      });
    }

    // Check if this source is assigned
    if (reqData.status === "in_progress" && parseInt(reqData.assigned_source_id) !== userId) {
      return res.status(403).json({
        error: "Only the assigned source can reject this request",
      });
    }

    // Update request status to rejected and clear assigned_source_id
    await runQuery(
      "UPDATE medicine_requests SET status = 'rejected', assigned_source_id = NULL WHERE request_id = ?",
      [id]
    );

    // Check inventory again to see if it should become available
    const inventoryCheck = await checkInventoryAndSetStatus(
      reqData.item_name_requested,
      reqData.quantity_needed
    );

    if (inventoryCheck.status === "available") {
      await runQuery(
        "UPDATE medicine_requests SET status = 'available', assigned_source_id = ? WHERE request_id = ?",
        [inventoryCheck.assigned_source_id, id]
      );
    }

    const updated = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    res.status(200).json({
      message: "Medicine request rejected. Status updated based on inventory availability.",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error rejecting medicine request:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /medicine-requests/:id/fulfill - Fulfill request (assigned source or admin)
router.put("/:id/fulfill", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const request = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    if (request.length === 0) {
      return res.status(404).json({ error: "Medicine request not found" });
    }

    const reqData = request[0];

    // Authorization: Only assigned source or admin can fulfill
    if (userRole !== "admin") {
      if (!["hospital", "ngo", "donor"].includes(userRole)) {
        return res.status(403).json({
          error: "Only assigned sources or admins can fulfill requests",
        });
      }
      if (parseInt(reqData.assigned_source_id) !== userId) {
        return res.status(403).json({
          error: "Only the assigned source can fulfill this request",
        });
      }
    }

    // Check if request is in_progress
    if (reqData.status !== "in_progress") {
      return res.status(400).json({
        error: `Cannot fulfill request with status: ${reqData.status}`,
      });
    }

    // Use transaction to update request and inventory atomically
    await new Promise((resolve, reject) => {
      db.beginTransaction((err) => {
        if (err) return reject(err);

        // Update request status
        db.query(
          "UPDATE medicine_requests SET status = 'fulfilled', fulfilled_by = ?, fulfilled_date = NOW() WHERE request_id = ?",
          [userId, id],
          (err, results) => {
            if (err) {
              return db.rollback(() => reject(err));
            }

            // Find matching inventory items (fuzzy match) and decrease quantity
            db.query(
              `SELECT item_id, quantity_available, name
               FROM inventory_registry
               WHERE source_id = ? AND name LIKE ? AND quantity_available > 0
               ORDER BY quantity_available DESC`,
              [reqData.assigned_source_id, `%${reqData.item_name_requested}%`],
              (err, inventoryItems) => {
                if (err) {
                  return db.rollback(() => reject(err));
                }

                let remainingNeeded = reqData.quantity_needed;

                // Decrease inventory starting with items that have the most quantity
                const updatePromises = inventoryItems.map((item) => {
                  return new Promise((resolveItem, rejectItem) => {
                    if (remainingNeeded <= 0) {
                      return resolveItem();
                    }

                    const decreaseAmount = Math.min(remainingNeeded, item.quantity_available);
                    remainingNeeded -= decreaseAmount;

                    db.query(
                      "UPDATE inventory_registry SET quantity_available = quantity_available - ? WHERE item_id = ?",
                      [decreaseAmount, item.item_id],
                      (err) => {
                        if (err) rejectItem(err);
                        else resolveItem();
                      }
                    );
                  });
                });

                Promise.all(updatePromises)
                  .then(() => {
                    db.commit((err) => {
                      if (err) {
                        return db.rollback(() => reject(err));
                      }
                      resolve();
                    });
                  })
                  .catch((err) => {
                    db.rollback(() => reject(err));
                  });
              }
            );
          }
        );
      });
    });

    const updated = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    res.status(200).json({
      message: "Medicine request fulfilled successfully. Inventory updated.",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error fulfilling medicine request:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /medicine-requests/:id/cancel - Cancel request (patient only)
router.put("/:id/cancel", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (userRole !== "patient") {
      return res.status(403).json({
        error: "Only patients can cancel their medicine requests",
      });
    }

    const request = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    if (request.length === 0) {
      return res.status(404).json({ error: "Medicine request not found" });
    }

    const reqData = request[0];

    // Check if patient owns this request
    if (parseInt(reqData.patient_id) !== userId) {
      return res.status(403).json({
        error: "Patients can only cancel their own requests",
      });
    }

    // Check if request can be cancelled
    if (["fulfilled", "cancelled"].includes(reqData.status)) {
      return res.status(400).json({
        error: `Cannot cancel request with status: ${reqData.status}`,
      });
    }

    // Update request status
    await runQuery(
      "UPDATE medicine_requests SET status = 'cancelled' WHERE request_id = ?",
      [id]
    );

    const updated = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    res.status(200).json({
      message: "Medicine request cancelled successfully",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error cancelling medicine request:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /medicine-requests/:id - Update request (admin or assigned source for notes only)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    const request = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    if (request.length === 0) {
      return res.status(404).json({ error: "Medicine request not found" });
    }

    const reqData = request[0];

    // Only admin or assigned source can update notes
    if (userRole === "admin") {
      // Admin can update notes
    } else if (["hospital", "ngo", "donor"].includes(userRole)) {
      if (parseInt(reqData.assigned_source_id) !== userId) {
        return res.status(403).json({
          error: "Only the assigned source can update this request",
        });
      }
    } else {
      return res.status(403).json({
        error: "Only admins and assigned sources can update requests",
      });
    }

    // Only notes can be updated
    if (notes === undefined) {
      return res.status(400).json({ error: "No fields to update" });
    }

    await runQuery("UPDATE medicine_requests SET notes = ? WHERE request_id = ?", [notes || null, id]);

    const updated = await runQuery(
      "SELECT * FROM medicine_requests WHERE request_id = ?",
      [id]
    );

    res.status(200).json({
      message: "Medicine request updated successfully",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error updating medicine request:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

