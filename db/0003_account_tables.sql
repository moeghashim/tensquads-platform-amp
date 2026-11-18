-- The tables of an account (docs/ARCHITECTURE.md, section 7.2). Only the Petra of the account writes them.
-- Each table has account_id and its natural key. A second write with the same key changes nothing.
-- The trail, the ledger and the costs only get new rows. Migration 0004 adds the row-level security.

CREATE TABLE events (
	account_id text NOT NULL REFERENCES accounts (id),
	command_id text NOT NULL,
	kind text NOT NULL,
	payload jsonb NOT NULL,
	origin text NOT NULL CHECK (origin IN ('owner', 'bot', 'not trusted', 'system')),
	customer_ref text,
	status text NOT NULL CHECK (status IN ('received', 'done')),
	received_at timestamptz NOT NULL,
	PRIMARY KEY (account_id, command_id)
);

CREATE TABLE messages (
	account_id text NOT NULL REFERENCES accounts (id),
	source_ref text NOT NULL,
	seq bigint NOT NULL CHECK (seq > 0),
	direction text NOT NULL CHECK (direction IN ('in', 'out')),
	channel text NOT NULL,
	sender text NOT NULL,
	customer_ref text,
	type text NOT NULL,
	body jsonb NOT NULL,
	task_id text,
	hidden boolean NOT NULL DEFAULT false,
	cleaned_at timestamptz,
	at timestamptz NOT NULL,
	search tsvector,
	PRIMARY KEY (account_id, source_ref),
	UNIQUE (account_id, seq)
);

CREATE TABLE tasks (
	id text PRIMARY KEY,
	account_id text NOT NULL REFERENCES accounts (id),
	command_id text NOT NULL,
	bot text NOT NULL,
	task_type text NOT NULL,
	brief jsonb NOT NULL,
	customer_ref text,
	status text NOT NULL CHECK (
		status IN ('starting', 'running', 'waiting for the owner', 'done', 'failed', 'cancelled')
	),
	stop text,
	created_at timestamptz NOT NULL,
	ended_at timestamptz,
	UNIQUE (account_id, command_id)
);

CREATE TABLE attempts (
	task_id text NOT NULL REFERENCES tasks (id),
	attempt_no integer NOT NULL CHECK (attempt_no > 0),
	account_id text NOT NULL REFERENCES accounts (id),
	cause_ref text NOT NULL,
	runner_id text,
	reason text NOT NULL CHECK (
		reason IN (
			'first',
			'after an approval',
			'after an answer',
			'after a failure',
			'the sandbox did not start'
		)
	),
	versions jsonb NOT NULL,
	started_at timestamptz,
	ended_at timestamptz,
	exit text,
	PRIMARY KEY (task_id, attempt_no),
	UNIQUE (task_id, cause_ref)
);

CREATE TABLE journal_copies (
	task_id text NOT NULL REFERENCES tasks (id),
	attempt_no integer NOT NULL,
	call_no integer NOT NULL,
	account_id text NOT NULL REFERENCES accounts (id),
	blob_key text NOT NULL,
	at timestamptz NOT NULL,
	PRIMARY KEY (task_id, attempt_no, call_no)
);

CREATE TABLE draft_files (
	task_id text NOT NULL REFERENCES tasks (id),
	path text NOT NULL,
	attempt_no integer NOT NULL,
	call_no integer NOT NULL,
	account_id text NOT NULL REFERENCES accounts (id),
	blob_key text NOT NULL,
	at timestamptz NOT NULL,
	PRIMARY KEY (task_id, path, attempt_no, call_no)
);

CREATE TABLE task_inbox (
	task_id text NOT NULL REFERENCES tasks (id),
	source_ref text NOT NULL,
	account_id text NOT NULL REFERENCES accounts (id),
	kind text NOT NULL CHECK (kind IN ('message', 'forget')),
	body jsonb,
	fact_id text,
	at timestamptz NOT NULL,
	PRIMARY KEY (task_id, source_ref)
);

CREATE TABLE actions (
	task_id text NOT NULL REFERENCES tasks (id),
	tool_call_id text NOT NULL,
	account_id text NOT NULL REFERENCES accounts (id),
	attempt_no integer NOT NULL,
	tool text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('money', 'public', 'other')),
	content jsonb NOT NULL,
	content_hash text NOT NULL,
	status text NOT NULL,
	service_ref text,
	answer jsonb,
	started_at timestamptz,
	done_at timestamptz,
	PRIMARY KEY (task_id, tool_call_id)
);

CREATE TABLE approvals (
	task_id text NOT NULL REFERENCES tasks (id),
	tool_call_id text NOT NULL,
	content_hash text NOT NULL,
	account_id text NOT NULL REFERENCES accounts (id),
	rule_id text,
	limit_at_that_time jsonb,
	status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
	decided_by text,
	decided_at timestamptz,
	PRIMARY KEY (task_id, tool_call_id, content_hash)
);

CREATE TABLE rules (
	account_id text NOT NULL REFERENCES accounts (id),
	command_id text NOT NULL,
	kind text NOT NULL,
	params jsonb NOT NULL,
	active boolean NOT NULL,
	created_by text NOT NULL,
	created_at timestamptz NOT NULL,
	PRIMARY KEY (account_id, command_id)
);

CREATE TABLE ledger (
	account_id text NOT NULL REFERENCES accounts (id),
	source_ref text NOT NULL,
	task_id text,
	kind text NOT NULL CHECK (kind IN ('grant', 'charge', 'give back')),
	credits bigint NOT NULL,
	at timestamptz NOT NULL,
	PRIMARY KEY (account_id, source_ref)
);

CREATE TABLE costs (
	account_id text NOT NULL REFERENCES accounts (id),
	source_ref text NOT NULL,
	task_id text,
	attempt_no integer,
	kind text NOT NULL CHECK (
		kind IN (
			'large model',
			'decider',
			'checker model',
			'sandbox',
			'outside service',
			'storage',
			'database',
			'worker'
		)
	),
	provider text,
	model text,
	units bigint NOT NULL,
	unit text NOT NULL,
	unit_price bigint NOT NULL,
	amount bigint NOT NULL,
	divided boolean NOT NULL DEFAULT false,
	period text,
	at timestamptz NOT NULL,
	PRIMARY KEY (account_id, source_ref)
);

CREATE TABLE trail (
	account_id text NOT NULL REFERENCES accounts (id),
	source_ref text NOT NULL,
	task_id text,
	attempt_no integer,
	turn_no integer,
	seq bigint GENERATED ALWAYS AS IDENTITY,
	kind text NOT NULL CHECK (
		kind IN (
			'owner message',
			'decision',
			'model call',
			'tool use',
			'check',
			'approval',
			'action',
			'refusal',
			'message to the owner',
			'memory'
		)
	),
	actor text NOT NULL,
	summary text NOT NULL,
	data jsonb,
	blob_key text,
	blob_hash text,
	at timestamptz NOT NULL,
	PRIMARY KEY (account_id, source_ref)
);

CREATE TABLE decisions (
	account_id text NOT NULL REFERENCES accounts (id),
	source_ref text NOT NULL,
	decider text NOT NULL,
	task_id text,
	point text NOT NULL,
	message_seq bigint,
	options jsonb NOT NULL,
	answer text,
	probability double precision CHECK (probability BETWEEN 0 AND 1),
	shadow boolean NOT NULL,
	used boolean NOT NULL,
	ms integer,
	at timestamptz NOT NULL,
	PRIMARY KEY (account_id, source_ref, decider)
);

CREATE TABLE decision_outcomes (
	account_id text NOT NULL REFERENCES accounts (id),
	decision_ref text NOT NULL,
	command_id text NOT NULL,
	outcome text NOT NULL CHECK (outcome IN ('approved', 'rejected', 'changed')),
	by text NOT NULL,
	at timestamptz NOT NULL,
	PRIMARY KEY (account_id, decision_ref, command_id)
);

CREATE TABLE admin_reads (
	account_id text NOT NULL REFERENCES accounts (id),
	read_id text NOT NULL,
	admin_ref text NOT NULL,
	task_id text NOT NULL,
	at timestamptz NOT NULL,
	PRIMARY KEY (account_id, read_id)
);

CREATE TABLE notes (
	account_id text NOT NULL REFERENCES accounts (id),
	source_ref text NOT NULL,
	bot text NOT NULL,
	task_id text,
	text text NOT NULL,
	origin text NOT NULL CHECK (origin IN ('owner', 'bot', 'not trusted', 'system')),
	customer_ref text,
	target_page text,
	status text NOT NULL,
	at timestamptz NOT NULL,
	PRIMARY KEY (account_id, source_ref)
);

CREATE TABLE pages (
	account_id text NOT NULL REFERENCES accounts (id),
	name text NOT NULL,
	accepts_from text NOT NULL,
	created_by text NOT NULL,
	PRIMARY KEY (account_id, name)
);

CREATE TABLE facts (
	account_id text NOT NULL REFERENCES accounts (id),
	source_ref text NOT NULL,
	page text NOT NULL,
	text text NOT NULL,
	origin text NOT NULL CHECK (origin IN ('owner', 'bot', 'not trusted', 'system')),
	made_by text NOT NULL,
	customer_ref text,
	approved_by_owner boolean NOT NULL DEFAULT false,
	status text NOT NULL CHECK (status IN ('current', 'replaced', 'forgotten')),
	replaced_by text,
	forgotten_at timestamptz,
	cleaned_at timestamptz,
	at timestamptz NOT NULL,
	search tsvector,
	PRIMARY KEY (account_id, source_ref)
);

CREATE TABLE core_items (
	account_id text NOT NULL REFERENCES accounts (id),
	source_ref text NOT NULL,
	text text NOT NULL,
	source text NOT NULL CHECK (source IN ('owner', 'night job')),
	fact_ref text,
	customer_ref text,
	cleaned_at timestamptz,
	status text NOT NULL CHECK (status IN ('active', 'removed')),
	at timestamptz NOT NULL,
	PRIMARY KEY (account_id, source_ref)
);

CREATE TABLE proposals (
	account_id text NOT NULL REFERENCES accounts (id),
	week text NOT NULL,
	n integer NOT NULL,
	kind text NOT NULL,
	text text NOT NULL,
	evidence jsonb NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
	PRIMARY KEY (account_id, week, n)
);
