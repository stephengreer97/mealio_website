-- Hash deduplication table
CREATE TABLE photo_hashes (
  hash       text        PRIMARY KEY,
  url        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_photo_hashes_url ON photo_hashes (url);

-- RPC to list storage objects (avoids .schema('storage') portability issues)
CREATE OR REPLACE FUNCTION public.list_storage_objects(bucket text)
RETURNS TABLE (name text, size int) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT name, (metadata->>'size')::int
  FROM storage.objects
  WHERE bucket_id = bucket;
$$;
