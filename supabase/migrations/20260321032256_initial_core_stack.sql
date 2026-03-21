create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  machine_key text not null unique,
  display_name text not null,
  status text not null default 'offline',
  platform text,
  bridge_version text,
  metadata_json text not null default '{}'::text,
  last_seen_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.device_models (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  model_identifier text not null,
  display_name text,
  is_loaded boolean not null default false,
  state text not null default 'discovered',
  discovered_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (device_id, model_identifier)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  target_device_id uuid references public.devices (id) on delete set null,
  title text not null default 'New conversation',
  status text not null default 'active',
  metadata_json text not null default '{}'::text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  last_message_at timestamptz
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content_json text not null,
  source text not null default 'app',
  model_identifier text,
  token_count integer,
  lmstudio_response_id text,
  error_text text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.lmstudio_threads (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.conversations (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  current_response_id text,
  model_identifier text,
  cache_filename text,
  last_synced_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.device_operations (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  requested_by_user_id uuid not null references auth.users (id) on delete cascade,
  type text not null,
  payload_json text not null default '{}'::text,
  status text not null default 'pending',
  error_text text,
  created_at timestamptz not null default timezone('utc', now()),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.operation_events (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.device_operations (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  event_type text not null,
  payload_json text not null default '{}'::text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists devices_owner_user_id_idx on public.devices (owner_user_id);
create index if not exists devices_last_seen_at_idx on public.devices (last_seen_at desc);
create index if not exists device_models_device_id_idx on public.device_models (device_id);
create index if not exists conversations_owner_user_id_idx on public.conversations (owner_user_id);
create index if not exists conversations_target_device_id_idx on public.conversations (target_device_id);
create index if not exists conversations_last_message_at_idx on public.conversations (last_message_at desc nulls last);
create index if not exists messages_conversation_id_idx on public.messages (conversation_id);
create index if not exists messages_created_at_idx on public.messages (created_at);
create index if not exists lmstudio_threads_device_id_idx on public.lmstudio_threads (device_id);
create index if not exists device_operations_device_id_idx on public.device_operations (device_id);
create index if not exists device_operations_status_idx on public.device_operations (status);
create index if not exists operation_events_operation_id_idx on public.operation_events (operation_id);

drop trigger if exists devices_set_updated_at on public.devices;
create trigger devices_set_updated_at
before update on public.devices
for each row
execute function public.set_updated_at();

drop trigger if exists device_models_set_updated_at on public.device_models;
create trigger device_models_set_updated_at
before update on public.device_models
for each row
execute function public.set_updated_at();

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
before update on public.conversations
for each row
execute function public.set_updated_at();

drop trigger if exists messages_set_updated_at on public.messages;
create trigger messages_set_updated_at
before update on public.messages
for each row
execute function public.set_updated_at();

drop trigger if exists lmstudio_threads_set_updated_at on public.lmstudio_threads;
create trigger lmstudio_threads_set_updated_at
before update on public.lmstudio_threads
for each row
execute function public.set_updated_at();

drop trigger if exists device_operations_set_updated_at on public.device_operations;
create trigger device_operations_set_updated_at
before update on public.device_operations
for each row
execute function public.set_updated_at();

create or replace function public.bump_conversation_from_message()
returns trigger
language plpgsql
as $$
begin
  update public.conversations
  set
    updated_at = coalesce(new.created_at, timezone('utc', now())),
    last_message_at = coalesce(new.created_at, timezone('utc', now()))
  where id = new.conversation_id;

  return new;
end;
$$;

drop trigger if exists messages_bump_conversation on public.messages;
create trigger messages_bump_conversation
after insert on public.messages
for each row
execute function public.bump_conversation_from_message();

alter table public.devices enable row level security;
alter table public.device_models enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.lmstudio_threads enable row level security;
alter table public.device_operations enable row level security;
alter table public.operation_events enable row level security;

create policy "devices_owner_all"
on public.devices
for all
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

create policy "device_models_owner_all"
on public.device_models
for all
using (
  exists (
    select 1
    from public.devices d
    where d.id = device_models.device_id
      and d.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.devices d
    where d.id = device_models.device_id
      and d.owner_user_id = auth.uid()
  )
);

create policy "conversations_owner_all"
on public.conversations
for all
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

create policy "messages_owner_all"
on public.messages
for all
using (
  exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and c.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and c.owner_user_id = auth.uid()
  )
);

create policy "lmstudio_threads_owner_all"
on public.lmstudio_threads
for all
using (
  exists (
    select 1
    from public.conversations c
    where c.id = lmstudio_threads.conversation_id
      and c.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.conversations c
    where c.id = lmstudio_threads.conversation_id
      and c.owner_user_id = auth.uid()
  )
);

create policy "device_operations_owner_all"
on public.device_operations
for all
using (
  exists (
    select 1
    from public.devices d
    where d.id = device_operations.device_id
      and d.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.devices d
    where d.id = device_operations.device_id
      and d.owner_user_id = auth.uid()
  )
);

create policy "operation_events_owner_all"
on public.operation_events
for all
using (
  exists (
    select 1
    from public.devices d
    where d.id = operation_events.device_id
      and d.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.devices d
    where d.id = operation_events.device_id
      and d.owner_user_id = auth.uid()
  )
);

alter table public.devices replica identity full;
alter table public.device_models replica identity full;
alter table public.conversations replica identity full;
alter table public.messages replica identity full;
alter table public.lmstudio_threads replica identity full;
alter table public.device_operations replica identity full;
alter table public.operation_events replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'powersync') then
    alter publication powersync add table
      public.devices,
      public.device_models,
      public.conversations,
      public.messages,
      public.lmstudio_threads,
      public.device_operations,
      public.operation_events;
  else
    create publication powersync for table
      public.devices,
      public.device_models,
      public.conversations,
      public.messages,
      public.lmstudio_threads,
      public.device_operations,
      public.operation_events;
  end if;
exception
  when duplicate_object then
    null;
end;
$$;
