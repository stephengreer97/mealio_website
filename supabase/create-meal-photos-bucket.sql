-- Create the meal-photos storage bucket (public read, service-role write)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'meal-photos',
  'meal-photos',
  true,
  5242880,  -- 5 MB per file
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Allow anyone to read (bucket is public, but explicit policy is good practice)
CREATE POLICY "Public read meal-photos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'meal-photos');
