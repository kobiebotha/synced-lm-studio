alter table public.conversations
  add column if not exists share_token text,
  add column if not exists shared_at timestamptz;

create unique index if not exists conversations_share_token_idx
on public.conversations (share_token)
where share_token is not null;
