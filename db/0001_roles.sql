-- The three database roles of docs/ARCHITECTURE.md, section 3.3.
-- They cannot log in. Each place has one login user for each role, and that user is a member of only its role.
-- The migrations run with the owner role of the database. No runtime part has that role.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ts_petra') THEN
		CREATE ROLE ts_petra NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ts_platform') THEN
		CREATE ROLE ts_platform NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ts_admin_views') THEN
		CREATE ROLE ts_admin_views NOLOGIN;
	END IF;
END
$$;

-- The views of the super admin are in the schema "admin". Task 10 adds them.
CREATE SCHEMA IF NOT EXISTS admin;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ts_petra, ts_platform;
GRANT USAGE ON SCHEMA admin TO ts_admin_views, ts_platform;
