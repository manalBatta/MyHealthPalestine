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

// Helper function to check and update expired medicines
const checkAndUpdateExpiredMedicines = async () => {
  try {
    await runQuery(
      `UPDATE inventory_registry 
       SET \`condition\` = 'expired' 
       WHERE type = 'medicine' 
       AND expiry_date < CURDATE() 
       AND \`condition\` != 'expired'`
    );
  } catch (error) {
    console.error("Error updating expired medicines:", error);
  }
};

// POST /inventory-registry - Create inventory item (sources, admins, doctors)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const {
      name,
      type,
      quantity_available,
      total_quantity,
      storage_location,
      condition,
      expiry_date,
      source_id,
    } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Validate required fields
    if (
      !name ||
      !type ||
      quantity_available === undefined ||
      total_quantity === undefined ||
      !storage_location ||
      !condition ||
      !source_id
    ) {
      return res.status(400).json({
        error:
          "name, type, quantity_available, total_quantity, storage_location, condition, and source_id are required",
      });
    }

    // Validate type enum
    const validTypes = ["medicine", "equipment"];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `type must be one of: ${validTypes.join(", ")}`,
      });
    }

    // Validate condition enum
    const validConditions = ["good", "needs_repair", "out_of_service", "expired", "damaged"];
    if (!validConditions.includes(condition)) {
      return res.status(400).json({
        error: `condition must be one of: ${validConditions.join(", ")}`,
      });
    }

    // Validate quantity_available <= total_quantity
    if (parseInt(quantity_available) > parseInt(total_quantity)) {
      return res.status(400).json({
        error: "quantity_available cannot be greater than total_quantity",
      });
    }

    // Validate quantity_available is not negative
    if (parseInt(quantity_available) < 0) {
      return res.status(400).json({
        error: "quantity_available cannot be negative",
      });
    }

    // Validate expiry_date for medicines
    if (type === "medicine" && !expiry_date) {
      return res.status(400).json({
        error: "expiry_date is required for medicines",
      });
    }

    // Validate expiry_date format if provided
    if (expiry_date) {
      const expiryDate = new Date(expiry_date);
      if (Number.isNaN(expiryDate.getTime())) {
        return res.status(400).json({ error: "Invalid expiry_date format" });
      }
    }

    // Check if source exists
    const source = await runQuery("SELECT id, role FROM users WHERE id = ?", [source_id]);
    if (source.length === 0) {
      return res.status(404).json({ error: "Source not found" });
    }

    // Authorization: Sources can only create for themselves, admins/doctors can create for any source
    if (["hospital", "ngo", "donor"].includes(userRole)) {
      if (parseInt(source_id) !== userId) {
        return res.status(403).json({
          error: "Sources can only create inventory items for themselves",
        });
      }
    } else if (!["admin", "doctor"].includes(userRole)) {
      return res.status(403).json({
        error: "Only sources, admins, and doctors can create inventory items",
      });
    }

    // Check if medicine is already expired
    let finalCondition = condition;
    if (type === "medicine" && expiry_date) {
      const expiryDate = new Date(expiry_date);
      if (expiryDate < new Date()) {
        finalCondition = "expired";
      }
    }

    // Insert inventory item
    const result = await runQuery(
      `INSERT INTO inventory_registry 
       (name, type, quantity_available, total_quantity, storage_location, \`condition\`, expiry_date, source_id, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        name,
        type,
        quantity_available,
        total_quantity,
        storage_location,
        finalCondition,
        expiry_date || null,
        source_id,
      ]
    );

    const inventoryItem = await runQuery(
      "SELECT * FROM inventory_registry WHERE item_id = ?",
      [result.insertId]
    );

    res.status(201).json({
      message: "Inventory item created successfully",
      data: inventoryItem[0],
    });
  } catch (error) {
    console.error("Error creating inventory item:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /inventory-registry - List inventory items with filtering and pagination
router.get("/", authenticateToken, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sort_by = "created_at",
      sort_order = "desc",
      type,
      source_id,
      condition,
      name,
      expired_only,
      created_from,
      created_to,
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
      "item_id",
      "name",
      "type",
      "quantity_available",
      "total_quantity",
      "condition",
      "source_id",
      "created_at",
      "updated_at",
      "expiry_date",
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

    // Check and update expired medicines before querying
    await checkAndUpdateExpiredMedicines();

    // Build conditions
    const conditions = [];
    const params = [];

    // Role-based filtering
    if (["hospital", "ngo", "donor"].includes(userRole)) {
      conditions.push("ir.source_id = ?");
      params.push(userId);
    } else if (!["admin", "doctor"].includes(userRole)) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Additional filters
    if (type) {
      const validTypes = ["medicine", "equipment"];
      if (!validTypes.includes(type)) {
        return res.status(400).json({
          error: `Invalid type. Allowed: ${validTypes.join(", ")}`,
        });
      }
      conditions.push("ir.type = ?");
      params.push(type);
    }

    if (source_id) {
      const sourceIdNum = parseInt(source_id, 10);
      if (Number.isNaN(sourceIdNum)) {
        return res.status(400).json({ error: "source_id must be a number" });
      }
      conditions.push("ir.source_id = ?");
      params.push(sourceIdNum);
    }

    if (condition) {
      const validConditions = ["good", "needs_repair", "out_of_service", "expired", "damaged"];
      if (!validConditions.includes(condition)) {
        return res.status(400).json({
          error: `Invalid condition. Allowed: ${validConditions.join(", ")}`,
        });
      }
      conditions.push("ir.\`condition\` = ?");
      params.push(condition);
    }

    if (name) {
      conditions.push("ir.name LIKE ?");
      params.push(`%${name}%`);
    }

    if (expired_only === "true") {
      conditions.push("ir.type = 'medicine' AND ir.expiry_date < CURDATE()");
    }

    if (created_from) {
      const fromDate = new Date(created_from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "Invalid created_from date" });
      }
      const mysqlFromDate = fromDate.toISOString().slice(0, 19).replace("T", " ");
      conditions.push("ir.created_at >= ?");
      params.push(mysqlFromDate);
    }

    if (created_to) {
      const toDate = new Date(created_to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "Invalid created_to date" });
      }
      const mysqlToDate = toDate.toISOString().slice(0, 19).replace("T", " ");
      conditions.push("ir.created_at <= ?");
      params.push(mysqlToDate);
    }

    const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";

    const offset = (pageNum - 1) * limitNum;

    // Escape condition column name if needed
    const sortField = sort_by === "condition" ? "ir.`condition`" : `ir.${sort_by}`;
    
    const dataQuery = `
      SELECT ir.*, u.username as source_name, u.role as source_role
      FROM inventory_registry ir
      LEFT JOIN users u ON ir.source_id = u.id
      ${whereClause}
      ORDER BY ${sortField} ${normalizedSortOrder}
      LIMIT ?
      OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM inventory_registry ir
      ${whereClause}
    `;

    const [items, countResult] = await Promise.all([
      runQuery(dataQuery, [...params, limitNum, offset]),
      runQuery(countQuery, params),
    ]);

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / limitNum);

    res.status(200).json({
      message: "Inventory items retrieved successfully",
      data: items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching inventory items:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /inventory-registry/:id - Get single inventory item
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check and update expired medicines
    await checkAndUpdateExpiredMedicines();

    const item = await runQuery(
      `SELECT ir.*, u.username as source_name, u.role as source_role
       FROM inventory_registry ir
       LEFT JOIN users u ON ir.source_id = u.id
       WHERE ir.item_id = ?`,
      [id]
    );

    if (item.length === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    const inventoryItem = item[0];

    // Authorization check
    if (["hospital", "ngo", "donor"].includes(userRole)) {
      if (parseInt(inventoryItem.source_id) !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
    } else if (!["admin", "doctor"].includes(userRole)) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.status(200).json({
      message: "Inventory item retrieved successfully",
      data: inventoryItem,
    });
  } catch (error) {
    console.error("Error fetching inventory item:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /inventory-registry/:id - Update inventory item
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      type,
      quantity_available,
      total_quantity,
      storage_location,
      condition,
      expiry_date,
    } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Get existing item
    const existing = await runQuery(
      "SELECT * FROM inventory_registry WHERE item_id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    const item = existing[0];

    // Authorization: Source can update their own, admin can update any
    if (["hospital", "ngo", "donor"].includes(userRole)) {
      if (parseInt(item.source_id) !== userId) {
        return res.status(403).json({
          error: "Sources can only update their own inventory items",
        });
      }
    } else if (userRole !== "admin") {
      return res.status(403).json({
        error: "Only sources and admins can update inventory items",
      });
    }

    // Build update query dynamically
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push(name);
    }

    if (type !== undefined) {
      const validTypes = ["medicine", "equipment"];
      if (!validTypes.includes(type)) {
        return res.status(400).json({
          error: `type must be one of: ${validTypes.join(", ")}`,
        });
      }
      updates.push("type = ?");
      params.push(type);
    }

    if (quantity_available !== undefined) {
      const qtyAvailable = parseInt(quantity_available);
      if (qtyAvailable < 0) {
        return res.status(400).json({
          error: "quantity_available cannot be negative",
        });
      }
      updates.push("quantity_available = ?");
      params.push(qtyAvailable);
    }

    if (total_quantity !== undefined) {
      const totalQty = parseInt(total_quantity);
      updates.push("total_quantity = ?");
      params.push(totalQty);
    }

    if (storage_location !== undefined) {
      updates.push("storage_location = ?");
      params.push(storage_location);
    }

    if (condition !== undefined) {
      const validConditions = ["good", "needs_repair", "out_of_service", "expired", "damaged"];
      if (!validConditions.includes(condition)) {
        return res.status(400).json({
          error: `condition must be one of: ${validConditions.join(", ")}`,
        });
      }
      updates.push("\`condition\` = ?");
      params.push(condition);
    }

    if (expiry_date !== undefined) {
      if (expiry_date === null || expiry_date === "") {
        updates.push("expiry_date = NULL");
      } else {
        const expiryDate = new Date(expiry_date);
        if (Number.isNaN(expiryDate.getTime())) {
          return res.status(400).json({ error: "Invalid expiry_date format" });
        }
        updates.push("expiry_date = ?");
        params.push(expiry_date);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // Validate quantity_available <= total_quantity after updates
    const finalQtyAvailable =
      quantity_available !== undefined ? parseInt(quantity_available) : item.quantity_available;
    const finalTotalQty =
      total_quantity !== undefined ? parseInt(total_quantity) : item.total_quantity;

    if (finalQtyAvailable > finalTotalQty) {
      return res.status(400).json({
        error: "quantity_available cannot be greater than total_quantity",
      });
    }

    // Check if medicine is expired and update condition
    let finalCondition = condition !== undefined ? condition : item.condition;
    if (type !== undefined ? type === "medicine" : item.type === "medicine") {
      const finalExpiryDate = expiry_date !== undefined ? expiry_date : item.expiry_date;
      if (finalExpiryDate) {
        const expiryDate = new Date(finalExpiryDate);
        if (expiryDate < new Date()) {
          finalCondition = "expired";
          updates.push("\`condition\` = ?");
          params.push("expired");
        }
      }
    }

    // Auto-update total_quantity if quantity_available is updated
    // When quantity_available decreases, total_quantity should decrease by the same amount
    if (quantity_available !== undefined && total_quantity === undefined) {
      const diff = finalQtyAvailable - item.quantity_available;
      if (diff !== 0) {
        updates.push("total_quantity = total_quantity + ?");
        params.push(diff);
      }
    }

    updates.push("updated_at = NOW()");
    params.push(id);

    await runQuery(
      `UPDATE inventory_registry SET ${updates.join(", ")} WHERE item_id = ?`,
      params
    );

    const updated = await runQuery(
      "SELECT * FROM inventory_registry WHERE item_id = ?",
      [id]
    );

    res.status(200).json({
      message: "Inventory item updated successfully",
      data: updated[0],
    });
  } catch (error) {
    console.error("Error updating inventory item:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /inventory-registry/:id - Delete inventory item (source or admin)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Get existing item
    const existing = await runQuery(
      "SELECT * FROM inventory_registry WHERE item_id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    const item = existing[0];

    // Authorization: Source can delete their own, admin can delete any
    if (["hospital", "ngo", "donor"].includes(userRole)) {
      if (parseInt(item.source_id) !== userId) {
        return res.status(403).json({
          error: "Sources can only delete their own inventory items",
        });
      }
    } else if (userRole !== "admin") {
      return res.status(403).json({
        error: "Only sources and admins can delete inventory items",
      });
    }

    // Hard delete
    await runQuery("DELETE FROM inventory_registry WHERE item_id = ?", [id]);

    res.status(200).json({
      message: "Inventory item deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting inventory item:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

