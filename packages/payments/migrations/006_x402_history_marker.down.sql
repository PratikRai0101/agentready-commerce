-- Manual rollback for the history marker compatibility migration.
CREATE OR REPLACE FUNCTION x402_record_role_history() RETURNS trigger
  LANGUAGE plpgsql AS $func$
DECLARE
  trigger_name TEXT := COALESCE(NULLIF(current_setting('x402_history_trigger', true), ''), 'database-role-write');
  history_note TEXT := COALESCE(NULLIF(current_setting('x402_history_note', true), ''), 'state change recorded by database guard');
BEGIN
  IF current_setting('x402_store_history_recorded', true) = 'true' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO x402_reconciliation_history
      (operation_id, from_status, to_status, trigger, note, lease_owner)
    VALUES (NEW.operation_id, 'pending', NEW.status, trigger_name, history_note, NEW.lease_owner);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO x402_reconciliation_history
      (operation_id, from_status, to_status, trigger, note, lease_owner)
    VALUES (NEW.operation_id, OLD.status, NEW.status, trigger_name, history_note, NEW.lease_owner);
  END IF;
  RETURN NEW;
END;
$func$;

DELETE FROM schema_migrations WHERE filename = '006_x402_history_marker.sql';
