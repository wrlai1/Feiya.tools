// Apply the same field-scoped rules as styleNames/colorNames inside PostgreSQL.
// Historical documents never need to cross the database HTTP connection.
export const renameDocumentSql = [`
CREATE OR REPLACE FUNCTION pg_temp.inventory_rename_identity(value TEXT, aliases JSONB, color_mode BOOLEAN, prefix TEXT DEFAULT '')
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE parts JSONB; lookup TEXT; replacement TEXT; result TEXT;
BEGIN
  IF value IS NULL OR left(value,length(prefix)+1) <> prefix || '[' THEN RETURN value; END IF;
  BEGIN parts := substring(value FROM length(prefix)+1)::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN value; END;
  IF jsonb_typeof(parts) <> 'array' OR jsonb_array_length(parts) <> 3 THEN RETURN value; END IF;
  IF color_mode THEN
    lookup := '[' || to_jsonb(upper(btrim(parts->>0)))::text || ',' || to_jsonb(upper(btrim(parts->>1)))::text || ']';
  ELSE lookup := upper(btrim(parts->>0)); END IF;
  replacement := aliases->>lookup;
  IF replacement IS NULL THEN RETURN value; END IF;
  parts := jsonb_set(parts, CASE WHEN color_mode THEN '{1}'::text[] ELSE '{0}'::text[] END, to_jsonb(lower(btrim(replacement))));
  SELECT '[' || string_agg(item::text, ',' ORDER BY ord) || ']' INTO result FROM jsonb_array_elements(parts) WITH ORDINALITY AS entries(item,ord);
  RETURN prefix || result;
END $$;`, `
CREATE OR REPLACE FUNCTION pg_temp.inventory_rename_document(value JSONB, aliases JSONB, color_mode BOOLEAN, field TEXT DEFAULT '', parent_style TEXT DEFAULT '')
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE result JSONB; item JSONB; entry RECORD; next_key TEXT; style TEXT; context TEXT; lookup TEXT; replacement TEXT;
BEGIN
  IF value IS NULL THEN RETURN value; END IF;
  IF (color_mode AND lower(field) = ANY(ARRAY['color','color_n','targetcolor','original_color','substitute_color','originalcolor','substitutecolor']))
    OR (NOT color_mode AND lower(field) = ANY(ARRAY['style','style_n','targetstyle','originalstyle','stylename','stylenumber','style_number','style number','款号','内部款号'])) THEN
    IF jsonb_typeof(value) <> 'string' THEN RETURN value; END IF;
    IF color_mode THEN lookup := '[' || to_jsonb(upper(btrim(parent_style)))::text || ',' || to_jsonb(upper(btrim(value#>>'{}')))::text || ']';
    ELSE lookup := upper(btrim(value#>>'{}')); END IF;
    replacement := aliases->>lookup;
    RETURN CASE WHEN replacement IS NULL THEN value ELSE to_jsonb(replacement) END;
  END IF;
  IF field = 'target' AND jsonb_typeof(value) = 'string' THEN
    RETURN to_jsonb(pg_temp.inventory_rename_identity(value#>>'{}',aliases,color_mode,'sku:'));
  END IF;
  IF jsonb_typeof(value) = 'array' THEN
    IF NOT color_mode AND lower(field) = ANY(ARRAY['styles','selectedstyles']) THEN
      SELECT coalesce(jsonb_agg(mapped ORDER BY first_ord),'[]'::jsonb) INTO result FROM (
        SELECT mapped,min(ord) first_ord FROM (
          SELECT pg_temp.inventory_rename_document(element,aliases,false,'style','') mapped, ord
          FROM jsonb_array_elements(value) WITH ORDINALITY AS items(element,ord)
        ) mapped_items GROUP BY mapped
      ) unique_items;
    ELSE
      SELECT coalesce(jsonb_agg(pg_temp.inventory_rename_document(element,aliases,color_mode,CASE WHEN color_mode THEN field ELSE '' END,parent_style) ORDER BY ord),'[]'::jsonb)
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(element,ord);
    END IF;
    RETURN result;
  END IF;
  IF jsonb_typeof(value) <> 'object' THEN RETURN value; END IF;
  style := coalesce(nullif(value->'style','null')#>>'{}',nullif(value->'Style','null')#>>'{}',nullif(value->'STYLE','null')#>>'{}',nullif(value->'style_n','null')#>>'{}',
    nullif(value->'styleNumber','null')#>>'{}',nullif(value->'style_number','null')#>>'{}',nullif(value->'Style Number','null')#>>'{}',nullif(value->'款号','null')#>>'{}',nullif(value->'内部款号','null')#>>'{}',nullif(value->'targetStyle','null')#>>'{}',parent_style);
  result := '{}';
  FOR entry IN SELECT key, val FROM jsonb_each(value) AS pairs(key,val) LOOP
    next_key := pg_temp.inventory_rename_identity(entry.key,aliases,color_mode,'sku:');
    IF result ? next_key THEN RAISE EXCEPTION 'Names conflict in saved warehouse overrides' USING ERRCODE='23505'; END IF;
    context := CASE WHEN color_mode AND lower(entry.key) = 'targetcolor' THEN coalesce(nullif(value->'targetStyle','null')#>>'{}',style) ELSE style END;
    item := pg_temp.inventory_rename_document(entry.val,aliases,color_mode,entry.key,context);
    result := result || jsonb_build_object(next_key,item);
  END LOOP;
  IF jsonb_typeof(value->'key') = 'string' AND ((color_mode AND style <> '') OR (NOT color_mode AND jsonb_typeof(value->'style') = 'string')) THEN
    result := jsonb_set(result,'{key}',to_jsonb(pg_temp.inventory_rename_identity(value->>'key',aliases,color_mode)));
  END IF;
  RETURN result;
END $$;
`]
