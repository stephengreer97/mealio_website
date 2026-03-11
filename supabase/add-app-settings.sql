-- App-wide settings table (single row, keyed by setting name)
create table if not exists app_settings (
  key   text primary key,
  value text
);

-- Insert the broadcast_message row (empty = no active broadcast)
insert into app_settings (key, value)
values ('broadcast_message', null)
on conflict (key) do nothing;

-- No RLS needed — read via service role only
