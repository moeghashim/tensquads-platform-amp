-- The tables that have no account (docs/ARCHITECTURE.md, section 7.2). Only the Platform object writes them.
-- Each table has its natural key. All times are UTC. Money is in whole millionths of a US dollar.

CREATE TABLE admin_commands (
	command_id text PRIMARY KEY,
	kind text NOT NULL,
	payload jsonb NOT NULL,
	admin_ref text NOT NULL,
	status text NOT NULL CHECK (status IN ('received', 'done')),
	answer jsonb,
	at timestamptz NOT NULL
);

CREATE TABLE accounts (
	id text PRIMARY KEY,
	name text NOT NULL,
	time_zone text NOT NULL,
	language text NOT NULL CHECK (language IN ('en', 'ar')),
	model_profile text NOT NULL CHECK (model_profile IN ('real', 'test')),
	created_at timestamptz NOT NULL
);

CREATE TABLE owners (
	account_id text NOT NULL REFERENCES accounts (id),
	identity_ref text NOT NULL,
	created_at timestamptz NOT NULL,
	PRIMARY KEY (account_id, identity_ref)
);

CREATE TABLE unit_prices (
	provider text NOT NULL,
	model text NOT NULL,
	unit text NOT NULL,
	starts_at timestamptz NOT NULL,
	price bigint NOT NULL CHECK (price >= 0),
	PRIMARY KEY (provider, model, unit, starts_at)
);

CREATE TABLE shared_costs (
	id text PRIMARY KEY,
	period text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('storage', 'database', 'worker')),
	provider text NOT NULL,
	amount bigint NOT NULL,
	supersedes text UNIQUE REFERENCES shared_costs (id),
	set_by text NOT NULL,
	at timestamptz NOT NULL
);

CREATE TABLE shared_cost_parts (
	shared_cost_id text NOT NULL REFERENCES shared_costs (id),
	account_id text NOT NULL REFERENCES accounts (id),
	usage bigint NOT NULL CHECK (usage >= 0),
	amount bigint NOT NULL,
	PRIMARY KEY (shared_cost_id, account_id)
);
