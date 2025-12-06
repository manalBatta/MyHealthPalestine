-- Add optional foreign key columns to recovery_updates table
ALTER TABLE `recovery_updates` 
ADD COLUMN `treatment_request_id` int AFTER `patient_id`,
ADD COLUMN `consultation_id` int AFTER `treatment_request_id`;

-- Add foreign key constraints
ALTER TABLE `recovery_updates` 
ADD FOREIGN KEY (`treatment_request_id`) REFERENCES `treatment_requests` (`id`),
ADD FOREIGN KEY (`consultation_id`) REFERENCES `consultations` (`id`);

