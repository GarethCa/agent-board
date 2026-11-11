-- Why a crew's round could not start its reviewers, while `start_failed` is set: its card says it, so the user knows what to put right before trying again.
ALTER TABLE crews ADD COLUMN start_error TEXT;
