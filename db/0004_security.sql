-- The grants and the row-level security of docs/ARCHITECTURE.md, sections 3.3 and 8.
-- A transaction of Petra sets app.account_id first. If it is not set, Petra gets zero rows.
-- No table has FORCE ROW LEVEL SECURITY, so the owner of the views is not limited (section 7.6).

DO $$
DECLARE
	account_table text;
	account_tables text[] := ARRAY[
		'events', 'messages', 'tasks', 'attempts', 'journal_copies', 'draft_files', 'task_inbox',
		'actions', 'approvals', 'rules', 'ledger', 'costs', 'trail', 'decisions', 'decision_outcomes',
		'admin_reads', 'notes', 'pages', 'facts', 'core_items', 'proposals'
	];
BEGIN
	FOREACH account_table IN ARRAY account_tables LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', account_table);
		EXECUTE format(
			'CREATE POLICY petra_own_account ON %I TO ts_petra '
			'USING (account_id = current_setting(''app.account_id'', true)) '
			'WITH CHECK (account_id = current_setting(''app.account_id'', true))',
			account_table
		);
		-- The ledger and the costs only get new rows. The trail also gets the deletes of retention (D32).
		IF account_table IN ('ledger', 'costs') THEN
			EXECUTE format('GRANT SELECT, INSERT ON %I TO ts_petra', account_table);
		ELSIF account_table = 'trail' THEN
			EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I TO ts_petra', account_table);
		ELSE
			EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ts_petra', account_table);
		END IF;
	END LOOP;
END
$$;

-- Petra reads the accounts and owners rows of her account. The Platform object reads and writes all of them.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;

CREATE POLICY petra_own_account ON accounts FOR SELECT TO ts_petra
	USING (id = current_setting('app.account_id', true));
CREATE POLICY petra_own_account ON owners FOR SELECT TO ts_petra
	USING (account_id = current_setting('app.account_id', true));
CREATE POLICY platform_all_accounts ON accounts TO ts_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all_accounts ON owners TO ts_platform USING (true) WITH CHECK (true);

GRANT SELECT ON accounts, owners, unit_prices TO ts_petra;

GRANT SELECT, INSERT, UPDATE ON admin_commands, accounts, owners, unit_prices, shared_costs, shared_cost_parts
	TO ts_platform;
