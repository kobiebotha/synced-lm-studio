create or replace function public.can_write_to_shared_conversation(
  conversation_uuid uuid,
  expected_device_uuid uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversations c
    where c.id = conversation_uuid
      and c.share_token is not null
      and c.target_device_id is not null
      and (expected_device_uuid is null or c.target_device_id = expected_device_uuid)
  );
$$;

revoke all on function public.can_write_to_shared_conversation(uuid, uuid) from public;
grant execute on function public.can_write_to_shared_conversation(uuid, uuid) to authenticated;

drop policy if exists "messages_shared_insert" on public.messages;
create policy "messages_shared_insert"
on public.messages
for insert
to authenticated
with check (
  messages.role = 'user'
  and messages.source = 'share'
  and public.can_write_to_shared_conversation(messages.conversation_id)
);

drop policy if exists "device_operations_shared_insert" on public.device_operations;
create policy "device_operations_shared_insert"
on public.device_operations
for insert
to authenticated
with check (
  device_operations.requested_by_user_id = auth.uid()
  and device_operations.type = 'send_message'
  and device_operations.status = 'pending'
  and device_operations.error_text is null
  and device_operations.claimed_at is null
  and device_operations.completed_at is null
  and device_operations.conversation_id is not null
  and public.can_write_to_shared_conversation(
    device_operations.conversation_id,
    device_operations.device_id
  )
);
