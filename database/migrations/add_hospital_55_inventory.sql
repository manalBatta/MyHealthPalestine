-- Add medicines to inventory for hospital (source_id = 55)
INSERT INTO `inventory_registry` 
(`name`, `type`, `quantity_available`, `total_quantity`, `storage_location`, `condition`, `expiry_date`, `source_id`, `created_at`, `updated_at`)
VALUES
('Paracetamol 500mg', 'medicine', 100, 100, 'Pharmacy Storage A', 'good', '2026-12-31', 55, NOW(), NOW()),
('Insulin Pen', 'medicine', 50, 50, 'Refrigerated Storage B', 'good', '2026-06-30', 55, NOW(), NOW()),
('Amoxicillin 250mg', 'medicine', 75, 75, 'Pharmacy Storage A', 'good', '2026-09-15', 55, NOW(), NOW()),
('Ibuprofen 400mg', 'medicine', 80, 80, 'Pharmacy Storage A', 'good', '2026-11-20', 55, NOW(), NOW()),
('Metformin 500mg', 'medicine', 60, 60, 'Pharmacy Storage A', 'good', '2026-08-10', 55, NOW(), NOW());

