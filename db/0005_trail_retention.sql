-- The retention of the trail (docs/ARCHITECTURE.md, section 7.7, requirement T8).
-- The role of Petra can delete a trail row only through this row-level rule.
-- The rule uses the time of the database, never a time from Petra.
-- A row of a task: the task ended (done, failed or cancelled) more than one month ago.
-- A row with no task: the row was written more than one month ago.
-- The policy is RESTRICTIVE, so it adds to the account policy of migration 0004. It does not replace it.

CREATE POLICY petra_trail_retention ON trail AS RESTRICTIVE FOR DELETE TO ts_petra
	USING (
		(task_id IS NULL AND at < now() - interval '1 month')
		OR EXISTS (
			SELECT 1 FROM tasks
			WHERE tasks.id = trail.task_id
				AND tasks.account_id = trail.account_id
				AND tasks.status IN ('done', 'failed', 'cancelled')
				AND tasks.ended_at < now() - interval '1 month'
		)
	);
