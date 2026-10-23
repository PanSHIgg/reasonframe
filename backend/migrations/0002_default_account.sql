INSERT INTO accounts (id, slug, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default Account')
ON CONFLICT (slug) DO NOTHING;
