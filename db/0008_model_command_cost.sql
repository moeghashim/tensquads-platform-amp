-- The cost of one owner command for each provider and model (task 12, requirement N8).
-- A model call of Petra in a command has the key cmd/{commandId}/model/{requestId}/{unit} (section 7.1).
-- An owner command is a command of the kind OwnerMessage in events. The mean cost of one owner command is the sum
-- of the cost rows of the owner commands, divided by the number of those commands. The view adds two columns at
-- the end, so the earlier columns and the grants stay.

CREATE OR REPLACE VIEW admin.model AS
	WITH command_cost AS (
		SELECT c.provider, c.model, c.account_id,
			substr(split_part(c.source_ref, '/model/', 1), length('cmd/') + 1) AS command_id,
			c.amount
		FROM costs c
		WHERE c.kind IN ('large model', 'decider', 'checker model') AND starts_with(c.source_ref, 'cmd/')
			AND strpos(c.source_ref, '/model/') > 0
	), owner_cost AS (
		SELECT cc.provider, cc.model,
			count(DISTINCT (cc.account_id, cc.command_id)) AS owner_commands,
			sum(cc.amount) AS owner_command_cost
		FROM command_cost cc
		JOIN events e ON e.account_id = cc.account_id AND e.command_id = cc.command_id AND e.kind = 'OwnerMessage'
		GROUP BY cc.provider, cc.model
	), model_cost AS (
		SELECT provider, model,
			count(DISTINCT regexp_replace(source_ref, '/[^/]+$', '')) AS calls,
			coalesce(sum(units) FILTER (WHERE unit = '1M input tokens'), 0) AS input_tokens,
			coalesce(sum(units) FILTER (WHERE unit = '1M output tokens'), 0) AS output_tokens,
			coalesce(sum(units) FILTER (WHERE unit NOT IN ('1M input tokens', '1M output tokens')), 0) AS other_units,
			sum(amount) AS cost
		FROM costs WHERE kind IN ('large model', 'decider', 'checker model')
		GROUP BY provider, model
	)
	SELECT m.provider, m.model, m.calls, m.input_tokens, m.output_tokens, m.other_units, m.cost,
		coalesce(o.owner_commands, 0) AS owner_commands,
		CASE WHEN coalesce(o.owner_commands, 0) = 0 THEN NULL
			ELSE round(o.owner_command_cost::numeric / o.owner_commands)::bigint END AS mean_command_cost
	FROM model_cost m
	LEFT JOIN owner_cost o ON o.provider = m.provider AND o.model = m.model;
