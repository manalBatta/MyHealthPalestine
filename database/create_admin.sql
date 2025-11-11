

INSERT INTO users (
  username,
  email,
  contact_phone,
  password_hash,
  role,
  language_pref,
  verification_status,
  created_at
) VALUES (
  'admin_username',
  'admin@example.com',
  '+1234567890',
  'YOUR_BCRYPT_HASHED_PASSWORD',
  'admin',
  'en',
  'verified',
  NOW()
);

INSERT INTO users (
  username, email, contact_phone, password_hash, role, language_pref, verification_status
) VALUES (
  'admin',
  'admin@healthpal.com',
  '+1234567890',
  '$2a$12$oCg3HuhvetV.Cdf8LtrSGuG3vKukJ/Mn21mX9EWKhghl1sLocYFlm', -- bcrypt hash for "123456"
  'admin',
  'en',
  'verified'
);

