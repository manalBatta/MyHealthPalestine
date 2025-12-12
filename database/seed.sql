-- Seed data for HealthPal
-- All passwords set to 123456

SET FOREIGN_KEY_CHECKS = 0;
START TRANSACTION;

-- Users
INSERT INTO users (id, username, email, contact_phone, password_hash, role, specialty, language_pref, website_url, verification_status, created_at)
VALUES
  (1, 'alice_patient', 'alice@example.com', '+10000000001', '123456', 'patient', NULL, 'en', NULL, 'verified', NOW()),
  (2, 'dr_bob', 'dr.bob@example.com', '+10000000002', '123456', 'doctor', 'cardiology', 'en', NULL, 'verified', NOW()),
  (3, 'dan_donor', 'dan@example.com', '+10000000003', '123456', 'donor', NULL, 'en', NULL, 'verified', NOW()),
  (4, 'hope_aid', 'contact@hopeaid.org', '+10000000004', '123456', 'ngo', NULL, 'en', 'https://hopeaid.org', 'verified', NOW()),
  (5, 'admin_user', 'admin@example.com', '+10000000005', '123456', 'admin', NULL, 'en', NULL, 'verified', NOW()),
  (6, 'city_hospital', 'hospital@example.com', '+10000000006', '123456', 'hospital', NULL, 'en', 'https://cityhospital.example.com', 'verified', NOW());

-- Consultations (slot_id will be linked after slots are created)
INSERT INTO consultations (id, patient_id, doctor_id, specialty, status, mode, notes, slot_id, created_at, updated_at)
VALUES
  (1, 1, 2, 'cardiology', 'confirmed', 'video', 'Follow-up on chest pain', NULL, NOW(), NOW());

-- Mental health consultation linked to consultation 1
INSERT INTO mental_health_consultations (id, consultation_id, trauma_type, severity_level, anonymity, age_group, session_focus, follow_up_required, created_at)
VALUES
  (1, 1, 'stress', 'moderate', false, 'adult', 'Coping strategies', true, NOW());

-- Connections
INSERT INTO connections (id, patient_id, doctor_id, connected_at, status)
VALUES
  (1, 1, 2, NOW(), 'active');

-- Consultation slots (link to consultation_id; consultation will be updated to reference slot 1)
INSERT INTO consultation_slots (id, doctor_id, start_datetime, end_datetime, is_booked, consultation_id, created_at, updated_at)
VALUES
  (1, 2, '2025-12-20 10:00:00', '2025-12-20 10:30:00', true, 1, NOW(), NOW()),
  (2, 2, '2025-12-21 14:00:00', '2025-12-21 14:30:00', false, NULL, NOW(), NOW());

-- Link consultation 1 to slot 1
UPDATE consultations SET slot_id = 1 WHERE id = 1;

-- Messages in consultation
INSERT INTO messages (id, consultation_id, sender_id, receiver_id, message_text, language, created_at)
VALUES
  (1, 1, 1, 2, 'Hello doctor, I have mild chest discomfort.', 'en', NOW()),
  (2, 1, 2, 1, 'Please monitor and schedule a follow-up.', 'en', NOW());

-- Treatment request for consultation
INSERT INTO treatment_requests (id, consultation_id, doctor_id, patient_id, treatment_type, content, medicine_name, dosage, frequency, duration, attachment_type, description, sponsered, goal_amount, raised_amount, status, language, created_at, updated_at)
VALUES
  (1, 1, 2, 1, 'prescription', 'Prescribe beta blockers', 'Metoprolol', '50mg', 'Once daily', '30 days', 'other', 'Initial prescription', true, 500.00, 100.00, 'open', 'en', NOW(), NOW());

-- Recovery update
INSERT INTO recovery_updates (id, patient_id, treatment_request_id, consultation_id, content, status, created_at)
VALUES
  (1, 1, 1, 1, 'Feeling better after medication', 'improving', NOW());

-- Donations (seeded directly for demo; production flow uses Stripe/webhooks)
INSERT INTO donations (id, treatment_request_id, donor_id, amount, donated_at, verified)
VALUES
  (1, 1, 3, 100.00, NOW(), true);

-- Sponsorship verification
INSERT INTO sponsorship_verification (id, treatment_request_id, approved, receipt_url, patient_feedback, approved_at, approved_by, created_at)
VALUES
  (1, 1, true, 'https://files.example.com/receipt1.pdf', 'Thank you!', NOW(), 5, NOW());

-- Inventory registry (hospital as source)
INSERT INTO inventory_registry (item_id, name, type, quantity_available, total_quantity, storage_location, `condition`, expiry_date, source_id, created_at, updated_at)
VALUES
  (1, 'Paracetamol 500mg', 'medicine', 500, 500, 'Main pharmacy', 'good', '2026-12-31', 6, NOW(), NOW()),
  (2, 'Wheelchair', 'equipment', 10, 12, 'Equipment room', 'good', NULL, 6, NOW(), NOW());

-- Medicine requests (assigned to hospital)
INSERT INTO medicine_requests (request_id, patient_id, item_name_requested, quantity_needed, delivery_location, assigned_source_id, status, requested_date, notes)
VALUES
  (1, 1, 'Paracetamol 500mg', 20, 'Patient address A', 6, 'in_progress', NOW(), 'Urgent need for pain management'),
  (2, 1, 'Wheelchair', 1, 'Patient address A', 6, 'pending', NOW(), 'Mobility assistance');

-- Health guides
INSERT INTO health_guides (id, title, category, description, media_url, language, created_by, approved, approved_by, created_at, updated_at)
VALUES
  (1, 'Heart Health Basics', 'chronic_illness', 'Guide on managing heart health', 'https://cdn.example.com/guides/heart.pdf', 'en', 2, true, 5, NOW(), NOW());

-- Public health alerts
INSERT INTO public_health_alerts (id, title, message, alert_type, severity, country, city, published_by, is_active, created_at, expires_at)
VALUES
  (1, 'Heatwave Warning', 'Stay hydrated and avoid midday sun', 'general', 'moderate', 'CountryX', 'CityY', 5, true, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY));

-- Workshops
INSERT INTO workshops (id, title, topic, description, mode, location, date, duration, created_by, approved, approved_by, created_at, updated_at)
VALUES
  (1, 'CPR Training', 'first_aid', 'Basic CPR skills', 'in_person', 'Community Center', '2025-12-22 10:00:00', 90, 4, true, 5, NOW(), NOW());

-- Workshop registrations
INSERT INTO workshop_registrations (id, workshop_id, user_id, registered_at, attended)
VALUES
  (1, 1, 1, NOW(), false);

-- Support groups
INSERT INTO support_groups (id, title, topic, description, mode, meeting_link, location, created_by, moderator_id, max_members, created_at, updated_at)
VALUES
  (1, 'Cardiac Recovery Group', 'chronic_illness', 'Support for heart patients', 'online', 'https://meet.example.com/group1', NULL, 4, 2, 50, NOW(), NOW());

-- Support group members
INSERT INTO support_group_members (id, group_id, user_id, joined_at, is_active)
VALUES
  (1, 1, 1, NOW(), true),
  (2, 1, 2, NOW(), true);

-- Support group messages
INSERT INTO support_group_messages (id, group_id, sender_id, message_text, created_at)
VALUES
  (1, 1, 1, 'Happy to join this group!', NOW());

-- Anonymous sessions and messages
INSERT INTO anonymous_sessions (id, therapist_id, pseudo_patient_name, session_token, started_at, ended_at, active)
VALUES
  (1, 2, 'Guest123', 'session-token-abc', NOW(), NULL, true);

INSERT INTO anonymous_messages (id, session_id, sender_role, message_text, created_at)
VALUES
  (1, 1, 'patient', 'I need to discuss anxiety.', NOW()),
  (2, 1, 'therapist', 'I am here to help. Can you tell me more?', NOW());

-- Missions
INSERT INTO missions (id, title, description, doctor_id, ngo_id, location, start_datetime, end_datetime, registration_expiration, slots_available, slots_filled, status, created_at, updated_at)
VALUES
  (1, 'Rural Cardio Camp', 'Cardiology checkups in rural area', 2, 4, 'Village Clinic', '2026-01-10 09:00:00', '2026-01-10 17:00:00', '2026-01-05 23:59:59', 50, 5, 'upcoming', NOW(), NOW());

-- Mission registrations
INSERT INTO mission_registrations (id, mission_id, patient_id, registered_at, attended)
VALUES
  (1, 1, 1, NOW(), false);

-- Surgical missions
INSERT INTO surgical_missions (id, title, description, doctor_id, ngo_id, location, start_datetime, end_datetime, status, created_at, updated_at)
VALUES
  (1, 'Cardiac Surgery Week', 'Pro-bono cardiac surgeries', 2, 4, 'City Hospital OR', '2026-02-01 08:00:00', '2026-02-05 18:00:00', 'upcoming', NOW(), NOW());

-- Token blacklist (example expired token)
INSERT INTO token_blacklist (id, token, expires_at, blacklisted_at)
VALUES
  (1, 'expired-demo-token', DATE_SUB(NOW(), INTERVAL 1 DAY), NOW());

SET FOREIGN_KEY_CHECKS = 1;
COMMIT;


