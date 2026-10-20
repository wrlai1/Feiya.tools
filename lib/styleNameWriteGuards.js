// An import may read aliases just before a rename, then write just after it.
// Reject that stale write at the database boundary instead of recreating old names.
export const styleNameWriteGuardSql = `
CREATE OR REPLACE FUNCTION inventory_guard_style_names() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  document jsonb := '{}'::jsonb;
  column_name text;
BEGIN
  IF current_setting('feiya.inventory_name_rename', true) = 'on' THEN RETURN NEW; END IF;
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF TG_OP = 'UPDATE' AND to_jsonb(NEW)->column_name IS NOT DISTINCT FROM to_jsonb(OLD)->column_name THEN
      CONTINUE;
    END IF;
    document := document || jsonb_build_object(column_name, to_jsonb(NEW)->column_name);
  END LOOP;
  IF EXISTS (
    WITH RECURSIVE nodes(field, value) AS (
      SELECT ''::text, document
      UNION ALL
      SELECT child.field, child.value
      FROM nodes CROSS JOIN LATERAL (
        SELECT key AS field, value FROM jsonb_each(CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END)
        UNION ALL
        SELECT nodes.field, value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(nodes.value) = 'array' THEN nodes.value ELSE '[]'::jsonb END)
      ) child
    )
    SELECT 1 FROM nodes JOIN inventory_style_aliases aliases
      ON aliases.alias_key = UPPER(BTRIM(nodes.value #>> '{}'))
    WHERE jsonb_typeof(nodes.value) = 'string'
      AND LOWER(nodes.field) IN ('style','style_n','targetstyle','originalstyle','stylename','stylenumber','style_number','style number','款号','内部款号','styles','selectedstyles')
      AND nodes.value #>> '{}' IS DISTINCT FROM aliases.style
  ) THEN
    RAISE EXCEPTION 'Style name changed while saving. Refresh and try again.' USING ERRCODE = 'PST01';
  END IF;
  RETURN NEW;
END
$guard$`

export function styleNameWriteGuardQueries(txn, table, fields, quote) {
  const args = fields.map(field => "'" + field.replaceAll("'", "''") + "'").join(',')
  return [
    txn.query(`DROP TRIGGER IF EXISTS inventory_style_name_guard ON ${quote(table)}`),
    txn.query(`CREATE TRIGGER inventory_style_name_guard BEFORE INSERT OR UPDATE ON ${quote(table)}
      FOR EACH ROW EXECUTE FUNCTION inventory_guard_style_names(${args})`),
    txn.query(`DROP TRIGGER IF EXISTS inventory_color_name_guard ON ${quote(table)}`),
    txn.query(`CREATE TRIGGER inventory_color_name_guard BEFORE INSERT OR UPDATE ON ${quote(table)}
      FOR EACH ROW EXECUTE FUNCTION inventory_guard_color_names(${args})`),
  ]
}

export const colorNameWriteGuardSql = `
CREATE OR REPLACE FUNCTION inventory_guard_color_names() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  document jsonb;
  column_name text;
BEGIN
  IF current_setting('feiya.inventory_name_rename', true) = 'on' THEN RETURN NEW; END IF;
  document := jsonb_build_object('style', COALESCE(to_jsonb(NEW)->>'style',to_jsonb(NEW)->>'STYLE',to_jsonb(NEW)->>'Style',''));
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF TG_OP = 'UPDATE' AND to_jsonb(NEW)->column_name IS NOT DISTINCT FROM to_jsonb(OLD)->column_name THEN CONTINUE; END IF;
    document := document || jsonb_build_object(column_name,to_jsonb(NEW)->column_name);
  END LOOP;
  IF EXISTS (
    WITH RECURSIVE nodes(field,value,style) AS (
      SELECT ''::text,document,''::text
      UNION ALL
      SELECT child.field,child.value,
        CASE WHEN jsonb_typeof(nodes.value)='object' AND LOWER(child.field)='targetcolor' AND nodes.value ? 'targetStyle' THEN nodes.value->>'targetStyle'
        WHEN jsonb_typeof(nodes.value)='object' THEN COALESCE(nodes.value->>'style',nodes.value->>'Style',nodes.value->>'STYLE',nodes.value->>'style_n',nodes.value->>'styleNumber',nodes.value->>'style_number',nodes.value->>'Style Number',nodes.value->>'款号',nodes.value->>'内部款号',nodes.value->>'targetStyle',nodes.style) ELSE nodes.style END
      FROM nodes CROSS JOIN LATERAL (
        SELECT key AS field,value FROM jsonb_each(CASE WHEN jsonb_typeof(nodes.value)='object' THEN nodes.value ELSE '{}'::jsonb END)
        UNION ALL
        SELECT nodes.field,value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(nodes.value)='array' THEN nodes.value ELSE '[]'::jsonb END)
      ) child
    )
    SELECT 1 FROM nodes JOIN inventory_color_aliases aliases
      ON aliases.style_key=UPPER(BTRIM(nodes.style)) AND aliases.color_key=UPPER(BTRIM(nodes.value #>> '{}'))
    WHERE jsonb_typeof(nodes.value)='string'
      AND LOWER(nodes.field) IN ('color','color_n','targetcolor','original_color','substitute_color','originalcolor','substitutecolor')
      AND nodes.value #>> '{}' IS DISTINCT FROM aliases.color
  ) THEN RAISE EXCEPTION 'Color name changed while saving. Refresh and try again.' USING ERRCODE='PST01'; END IF;
  RETURN NEW;
END
$guard$`
