-- The views of the super admin, in the schema admin (docs/ARCHITECTURE.md, section 7.6, requirements S6 and S7).
-- The owner role of the database owns the views. Row-level security does not limit it, because no account table
-- has FORCE ROW LEVEL SECURITY. A runtime role reads a view and never the tables behind it.
-- A view calculates its numbers when it is read. A view gives numbers, ids and names of bots, models, task types
-- and decision points. It never gives the text of a message, a brief, a fact or an action.
-- The value of one credit, in millionths of a US dollar, comes from the setting app.credit_value_micros of the
-- transaction (the setting CREDIT_VALUE_MICROS of the Worker). Without it, the value is 0.

CREATE FUNCTION admin.credit_value_micros() RETURNS bigint LANGUAGE sql STABLE AS $$
	SELECT coalesce(nullif(current_setting('app.credit_value_micros', true), ''), '0')::bigint
$$;

-- The UTC month of a cost row. A share has its period. Each other row has the month of its time.
CREATE FUNCTION admin.period_of(period text, at timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS $$
	SELECT coalesce(period, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM'))
$$;

-- The usage of each account in each period: the number of its cost rows that are not divided, of each kind.
CREATE VIEW admin.usage AS
	SELECT account_id, admin.period_of(period, at) AS period, kind, count(*) AS cost_rows
	FROM costs WHERE NOT divided
	GROUP BY account_id, admin.period_of(period, at), kind;

-- For each account: the cost of each kind, the credits used, and the difference in millionths of a US dollar.
CREATE VIEW admin.account AS
	WITH cost AS (
		SELECT account_id,
			sum(amount) FILTER (WHERE kind = 'large model') AS large_model,
			sum(amount) FILTER (WHERE kind = 'decider') AS decider,
			sum(amount) FILTER (WHERE kind = 'checker model') AS checker_model,
			sum(amount) FILTER (WHERE kind = 'sandbox') AS sandbox,
			sum(amount) FILTER (WHERE kind = 'outside service') AS outside_service,
			sum(amount) FILTER (WHERE kind = 'storage') AS storage,
			sum(amount) FILTER (WHERE kind = 'database') AS database,
			sum(amount) FILTER (WHERE kind = 'worker') AS worker,
			sum(amount) AS cost
		FROM costs GROUP BY account_id
	), used AS (
		SELECT account_id, -sum(credits) AS credits_used FROM ledger
		WHERE kind IN ('charge', 'give back') GROUP BY account_id
	)
	SELECT accounts.id AS account_id,
		coalesce(cost.large_model, 0) AS large_model,
		coalesce(cost.decider, 0) AS decider,
		coalesce(cost.checker_model, 0) AS checker_model,
		coalesce(cost.sandbox, 0) AS sandbox,
		coalesce(cost.outside_service, 0) AS outside_service,
		coalesce(cost.storage, 0) AS storage,
		coalesce(cost.database, 0) AS database,
		coalesce(cost.worker, 0) AS worker,
		coalesce(cost.cost, 0) AS cost,
		coalesce(used.credits_used, 0) AS credits_used,
		coalesce(used.credits_used, 0) * admin.credit_value_micros() - coalesce(cost.cost, 0) AS difference
	FROM accounts
	LEFT JOIN cost ON cost.account_id = accounts.id
	LEFT JOIN used ON used.account_id = accounts.id;

-- One row for each task: the price in credits (its charge row) and its real cost. The two views below use it.
CREATE VIEW admin.task_cost AS
	SELECT tasks.account_id, tasks.id AS task_id, tasks.bot, tasks.task_type,
		coalesce((SELECT -sum(credits) FROM ledger
			WHERE ledger.account_id = tasks.account_id AND ledger.task_id = tasks.id AND ledger.kind = 'charge'), 0)
			AS price,
		coalesce((SELECT sum(amount) FROM costs
			WHERE costs.account_id = tasks.account_id AND costs.task_id = tasks.id), 0) AS cost
	FROM tasks;

-- For each task type of each account: the price in credits, the mean real cost, and the tasks above their price.
CREATE VIEW admin.task_type AS
	SELECT account_id, bot, task_type, max(price) AS price, count(*) AS tasks,
		round(avg(cost))::bigint AS mean_cost,
		count(*) FILTER (WHERE cost > price * admin.credit_value_micros()) AS above_price
	FROM admin.task_cost GROUP BY account_id, bot, task_type;

-- For each bot of each account: the tasks, the cost, and the mean cost of one task.
CREATE VIEW admin.bot AS
	SELECT account_id, bot, count(*) AS tasks, sum(cost) AS cost, round(avg(cost))::bigint AS mean_cost
	FROM admin.task_cost GROUP BY account_id, bot;

-- For each provider and model: the calls, the units and the cost. One call has an input row and an output row.
CREATE VIEW admin.model AS
	SELECT provider, model,
		count(DISTINCT regexp_replace(source_ref, '/[^/]+$', '')) AS calls,
		coalesce(sum(units) FILTER (WHERE unit = '1M input tokens'), 0) AS input_tokens,
		coalesce(sum(units) FILTER (WHERE unit = '1M output tokens'), 0) AS output_tokens,
		coalesce(sum(units) FILTER (WHERE unit NOT IN ('1M input tokens', '1M output tokens')), 0) AS other_units,
		sum(amount) AS cost
	FROM costs WHERE kind IN ('large model', 'decider', 'checker model')
	GROUP BY provider, model;

-- For each decision point and decider of each account: the answers, the answers that were used, the answers
-- below the level, the outcomes, the mean time, and the cost of the calls in which the point was asked.
-- A decider cost row belongs to a call by its cause (the part of its key before /model/) and by its model.
CREATE VIEW admin.decision_point AS
	SELECT d.account_id, d.point, d.decider, d.shadow,
		count(*) AS answers,
		count(*) FILTER (WHERE d.used) AS used,
		count(*) FILTER (WHERE d.answer IS NOT NULL AND d.probability IS NOT NULL AND NOT d.used AND NOT d.shadow)
			AS below_level,
		coalesce(sum(o.approved), 0) AS approved,
		coalesce(sum(o.rejected), 0) AS rejected,
		coalesce(sum(o.changed), 0) AS changed,
		round(avg(d.ms))::bigint AS mean_ms,
		coalesce((SELECT sum(c.amount) FROM costs c
			WHERE c.account_id = d.account_id AND c.kind = 'decider' AND c.model = d.decider
				AND EXISTS (SELECT 1 FROM decisions x
					WHERE x.account_id = d.account_id AND x.point = d.point AND x.decider = d.decider
						AND x.shadow = d.shadow
						AND starts_with(x.source_ref, split_part(c.source_ref, '/model/', 1) || '/'))), 0) AS cost
	FROM decisions d
	LEFT JOIN (
		SELECT account_id, decision_ref,
			count(*) FILTER (WHERE outcome = 'approved') AS approved,
			count(*) FILTER (WHERE outcome = 'rejected') AS rejected,
			count(*) FILTER (WHERE outcome = 'changed') AS changed
		FROM decision_outcomes GROUP BY account_id, decision_ref
	) o ON o.account_id = d.account_id AND o.decision_ref = d.source_ref AND NOT d.shadow
	WHERE d.decider NOT IN ('code', 'owner')
	GROUP BY d.account_id, d.point, d.decider, d.shadow;

-- The operations view (requirement S7). One row is one item: its kind, its account, the id that it names, its
-- time, and a count. The Platform object keeps an "open task" only when it is stuck (section 7.6), and adds the
-- requests for a sandbox that no launcher took in the take time.
CREATE VIEW admin.operations AS
	SELECT 'open task' AS item, tasks.account_id, tasks.id AS ref,
		coalesce((SELECT max(at) FROM trail WHERE trail.account_id = tasks.account_id AND trail.task_id = tasks.id),
			tasks.created_at) AS at,
		1::bigint AS count
	FROM tasks WHERE tasks.status IN ('starting', 'running')
	UNION ALL
	SELECT 'approval that waits', account_id, task_id || '/' || tool_call_id, NULL, 1 FROM approvals
	WHERE status = 'pending'
	UNION ALL
	SELECT 'action not confirmed', account_id, task_id || '/' || tool_call_id, done_at, 1 FROM actions
	WHERE status = 'not_confirmed'
	UNION ALL
	SELECT 'checks', account_id, NULL, NULL, count(*) FROM trail WHERE kind = 'check' GROUP BY account_id
	UNION ALL
	SELECT 'failed checks', account_id, NULL, NULL, count(*) FROM trail
	WHERE kind = 'check' AND data ->> 'verdict' = 'continue' GROUP BY account_id
	-- No command rejects a result. The nearest measure is an approval that the owner rejected.
	UNION ALL
	SELECT 'approval rejected by the owner', account_id, task_id || '/' || tool_call_id, decided_at, 1 FROM approvals
	WHERE status = 'rejected'
	UNION ALL
	SELECT 'period with no shared cost', NULL, months.period || '/' || kinds.kind, NULL, 1
	FROM (SELECT DISTINCT admin.period_of(period, at) AS period FROM costs) months
	CROSS JOIN (VALUES ('storage'), ('database'), ('worker')) AS kinds (kind)
	WHERE NOT EXISTS (SELECT 1 FROM shared_costs s WHERE s.period = months.period AND s.kind = kinds.kind)
	UNION ALL
	SELECT 'cost row with no price', account_id, source_ref, at, 1 FROM costs
	WHERE unit_price = 0 AND NOT divided;

REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.credit_value_micros(), admin.period_of(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.credit_value_micros(), admin.period_of(text, timestamptz)
	TO ts_admin_views, ts_platform;
GRANT SELECT ON admin.usage, admin.account, admin.task_type, admin.bot, admin.model, admin.decision_point,
	admin.operations TO ts_admin_views;
-- The Platform object reads the usage view for the division of a shared cost (section 3.3).
GRANT SELECT ON admin.usage TO ts_platform;
