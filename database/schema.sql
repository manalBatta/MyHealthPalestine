CREATE TABLE `users` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `username` varchar(255),
  `email` varchar(255),
  `contact_phone` varchar(255),
  `password_hash` varchar(255),
  `role` enum(patient,doctor,donor,ngo,admin,hospital),
  `specialty` varchar(255), //doctor specialty (optional)
  `language_pref` varchar(255),
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp,
  `official_document_url` varchar(255),//doctor official document url (optional)
  `registration_number` varchar(255),//doctor registration number (optional)
  `website_url` varchar(255),//NGOs /hospitals  website url (optional)
  `verification_status` enum(none,requested,verified,rejected) DEFAULT 'none',
  `verification_requested_at` timestamp,
  `verified_at` timestamp
);

CREATE TABLE `consultations` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `patient_id` int,
  `doctor_id` int,
  `specialty` varchar(255),
  `status` enum(pending,confirmed,completed,cancelled),
  `mode` enum(video,audio,chat),
  `notes` text,
  `slot_id` int,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `mental_health_consultations` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `consultation_id` int UNIQUE,
  `trauma_type` enum(war_trauma,loss,childhood,stress,other),
  `severity_level` enum(mild,moderate,severe,critical),
  `anonymity` bool DEFAULT false,
  `age_group` enum(child,teen,adult,senior),
  `session_focus` text,
  `follow_up_required` bool DEFAULT false,
  `follow_up_notes` text,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `connections` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `patient_id` int,
  `doctor_id` int,
  `connected_at` timestamp,
  `status` enum(active,inactive)
);

CREATE TABLE `messages` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `consultation_id` int,
  `sender_id` int,
  `receiver_id` int,
  `message_text` text,
  `language` varchar(255),
  `translated_text` text,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `support_group_messages` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `group_id` int,
  `sender_id` int,
  `message_text` text,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `consultation_slots` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `doctor_id` int,
  `start_datetime` datetime,
  `end_datetime` datetime,
  `is_booked` boolean,
  `consultation_id` int,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `treatment_requests` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `consultation_id` int,
  `doctor_id` int,
  `patient_id` int,
  `treatment_type` enum(note,prescription,attachment,surgery,cancer_treatment,dialysis,rehabilitation),
  `content` text,
  `medicine_name` varchar(255),
  `dosage` varchar(255),
  `frequency` varchar(255),
  `duration` varchar(255),
  `attachment_type` enum(image,lab_result,other),
  `file_url` varchar(255),
  `description` text,
  `sponsered` bool,
  `goal_amount` decimal(10,2),
  `raised_amount` decimal(10,2) DEFAULT 0,
  `status` enum(open,funded,closed,cancelled) DEFAULT 'open',
  `language` varchar(255),
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `recovery_updates` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `patient_id` int,
  `content` text,
  `file_url` varchar(255),
  `status` enum(improving,stable,critical,recovered),
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `donations` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `treatment_request_id` int,
  `donor_id` int,
  `amount` decimal(10,2),
  `donated_at` timestamp,
  `verified` bool DEFAULT false
);

CREATE TABLE `sponsorship_verification` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `treatment_request_id` int,
  `approved` bool DEFAULT false,
  `receipt_url` varchar(255),
  `patient_feedback` text,
  `approved_at` timestamp,
  `approved_by` int,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `medicine_requests` (
  `request_id` int PRIMARY KEY AUTO_INCREMENT,
  `patient_id` int,
  `item_name_requested` varchar(255),
  `quantity_needed` int,
  `delivery_location` varchar(255),
  `assigned_source_id` int,
  `status` enum(pending,available,in_progress,fulfilled,rejected,cancelled) DEFAULT 'pending',
  `requested_date` timestamp DEFAULT (current_timestamp),
  `fulfilled_by` int,
  `fulfilled_date` timestamp,
  `notes` text
);

CREATE TABLE `inventory_registry` (
  `item_id` int PRIMARY KEY AUTO_INCREMENT,
  `name` varchar(255),
  `type` enum(medicine,equipment),
  `quantity_available` int,
  `total_quantity` int,
  `storage_location` varchar(255),
  `condition` enum(good,needs_repair,out_of_service,expired,damaged),
  `expiry_date` date,
  `source_id` int,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `health_guides` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `title` varchar(255),
  `category` enum(first_aid,chronic_illness,nutrition,maternal_care,mental_health,other),
  `description` text,
  `media_url` varchar(255),
  `language` varchar(255) DEFAULT 'ar',
  `created_by` int,
  `approved` bool DEFAULT false,
  `approved_by` int,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `public_health_alerts` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `title` varchar(255),
  `message` text,
  `alert_type` enum(disease_outbreak,air_quality,urgent_need,general),
  `severity` enum(low,moderate,high,critical),
  `country` varchar(255),
  `city` varchar(255),
  `published_by` int,
  `is_active` bool DEFAULT true,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP  ,
  `expires_at` timestamp
);

CREATE TABLE `workshops` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `title` varchar(255),
  `topic` varchar(255),
  `description` text,
  `mode` enum(online,in_person),
  `location` varchar(255),
  `date` datetime,
  `duration` int,
  `created_by` int,
  `approved` bool DEFAULT false,
  `approved_by` int,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `workshop_registrations` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `workshop_id` int,
  `user_id` int,
  `registered_at` timestamp,
  `attended` bool DEFAULT false
);

CREATE TABLE `support_groups` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `title` varchar(255),
  `topic` enum(chronic_illness,disability,loss,trauma,mental_health,other),
  `description` text,
  `mode` enum(online,in_person),
  `meeting_link` varchar(255),
  `location` varchar(255),
  `created_by` int,
  `moderator_id` int,
  `max_members` int DEFAULT 50,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `support_group_members` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `group_id` int,
  `user_id` int,
  `joined_at` timestamp,
  `is_active` bool DEFAULT true
);

CREATE TABLE `anonymous_sessions` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `therapist_id` int,
  `pseudo_patient_name` varchar(255),
  `session_token` varchar(255),
  `started_at` timestamp,
  `ended_at` timestamp,
  `active` bool DEFAULT true
);

CREATE TABLE `anonymous_messages` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `session_id` int,
  `sender_role` enum(therapist,patient),
  `message_text` text,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `missions` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `title` varchar(255),
  `description` text,
  `doctor_id` int,
  `ngo_id` int,
  `location` varchar(255),
  `start_datetime` datetime,
  `end_datetime` datetime,
  `registration_expiration` datetime,
  `slots_available` int,
  `slots_filled` int DEFAULT 0,
  `status` enum(upcoming,ongoing,completed,cancelled) DEFAULT 'upcoming',
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `mission_registrations` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `mission_id` int,
  `patient_id` int,
  `registered_at` timestamp,
  `attended` bool DEFAULT false
);

CREATE TABLE `surgical_missions` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `title` varchar(255),
  `description` text,
  `doctor_id` int,
  `ngo_id` int,
  `location` varchar(255),
  `start_datetime` datetime,
  `end_datetime` datetime,
  `status` enum(upcoming,ongoing,completed,cancelled) DEFAULT 'upcoming',
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp
);

CREATE TABLE `token_blacklist` (
  `id` int PRIMARY KEY AUTO_INCREMENT,
  `token` varchar(500) UNIQUE NOT NULL,
  `expires_at` timestamp NOT NULL,
  `blacklisted_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_expires_at` (`expires_at`)
);

ALTER TABLE `consultations` ADD FOREIGN KEY (`patient_id`) REFERENCES `users` (`id`);

ALTER TABLE `consultations` ADD FOREIGN KEY (`doctor_id`) REFERENCES `users` (`id`);

ALTER TABLE `consultations` ADD FOREIGN KEY (`slot_id`) REFERENCES `consultation_slots` (`id`);

ALTER TABLE `mental_health_consultations` ADD FOREIGN KEY (`consultation_id`) REFERENCES `consultations` (`id`);

ALTER TABLE `connections` ADD FOREIGN KEY (`patient_id`) REFERENCES `users` (`id`);

ALTER TABLE `connections` ADD FOREIGN KEY (`doctor_id`) REFERENCES `users` (`id`);

ALTER TABLE `messages` ADD FOREIGN KEY (`consultation_id`) REFERENCES `consultations` (`id`);

ALTER TABLE `messages` ADD FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`);

ALTER TABLE `messages` ADD FOREIGN KEY (`receiver_id`) REFERENCES `users` (`id`);

ALTER TABLE `support_group_messages` ADD FOREIGN KEY (`group_id`) REFERENCES `support_groups` (`id`);

ALTER TABLE `support_group_messages` ADD FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`);

ALTER TABLE `consultation_slots` ADD FOREIGN KEY (`doctor_id`) REFERENCES `users` (`id`);

ALTER TABLE `consultation_slots` ADD FOREIGN KEY (`consultation_id`) REFERENCES `consultations` (`id`);

ALTER TABLE `treatment_requests` ADD FOREIGN KEY (`consultation_id`) REFERENCES `consultations` (`id`);

ALTER TABLE `treatment_requests` ADD FOREIGN KEY (`doctor_id`) REFERENCES `users` (`id`);

ALTER TABLE `treatment_requests` ADD FOREIGN KEY (`patient_id`) REFERENCES `users` (`id`);

ALTER TABLE `recovery_updates` ADD FOREIGN KEY (`patient_id`) REFERENCES `users` (`id`);

ALTER TABLE `donations` ADD FOREIGN KEY (`treatment_request_id`) REFERENCES `treatment_requests` (`id`);

ALTER TABLE `donations` ADD FOREIGN KEY (`donor_id`) REFERENCES `users` (`id`);

ALTER TABLE `sponsorship_verification` ADD FOREIGN KEY (`treatment_request_id`) REFERENCES `treatment_requests` (`id`);

ALTER TABLE `sponsorship_verification` ADD FOREIGN KEY (`approved_by`) REFERENCES `users` (`id`);

ALTER TABLE `medicine_requests` ADD FOREIGN KEY (`patient_id`) REFERENCES `users` (`id`);

ALTER TABLE `medicine_requests` ADD FOREIGN KEY (`assigned_source_id`) REFERENCES `users` (`id`);

ALTER TABLE `medicine_requests` ADD FOREIGN KEY (`fulfilled_by`) REFERENCES `users` (`id`);

ALTER TABLE `inventory_registry` ADD FOREIGN KEY (`source_id`) REFERENCES `users` (`id`);

ALTER TABLE `health_guides` ADD FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

ALTER TABLE `health_guides` ADD FOREIGN KEY (`approved_by`) REFERENCES `users` (`id`);

ALTER TABLE `public_health_alerts` ADD FOREIGN KEY (`published_by`) REFERENCES `users` (`id`);

ALTER TABLE `workshops` ADD FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

ALTER TABLE `workshops` ADD FOREIGN KEY (`approved_by`) REFERENCES `users` (`id`);

ALTER TABLE `workshop_registrations` ADD FOREIGN KEY (`workshop_id`) REFERENCES `workshops` (`id`);

ALTER TABLE `workshop_registrations` ADD FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);

ALTER TABLE `support_groups` ADD FOREIGN KEY (`created_by`) REFERENCES `users` (`id`);

ALTER TABLE `support_groups` ADD FOREIGN KEY (`moderator_id`) REFERENCES `users` (`id`);

ALTER TABLE `support_group_members` ADD FOREIGN KEY (`group_id`) REFERENCES `support_groups` (`id`);

ALTER TABLE `support_group_members` ADD FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);

ALTER TABLE `anonymous_sessions` ADD FOREIGN KEY (`therapist_id`) REFERENCES `users` (`id`);

ALTER TABLE `anonymous_messages` ADD FOREIGN KEY (`session_id`) REFERENCES `anonymous_sessions` (`id`);

ALTER TABLE `missions` ADD FOREIGN KEY (`doctor_id`) REFERENCES `users` (`id`);

ALTER TABLE `missions` ADD FOREIGN KEY (`ngo_id`) REFERENCES `users` (`id`);

ALTER TABLE `mission_registrations` ADD FOREIGN KEY (`mission_id`) REFERENCES `missions` (`id`);

ALTER TABLE `mission_registrations` ADD FOREIGN KEY (`patient_id`) REFERENCES `users` (`id`);

ALTER TABLE `surgical_missions` ADD FOREIGN KEY (`doctor_id`) REFERENCES `users` (`id`);

ALTER TABLE `surgical_missions` ADD FOREIGN KEY (`ngo_id`) REFERENCES `users` (`id`);
