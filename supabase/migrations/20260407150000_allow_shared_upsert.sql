drop policy if exists "messages_shared_select" on public.messages;
create policy "messages_shared_select"
on public.messages
for select
to authenticated
using (
  public.can_write_to_shared_conversation(messages.conversation_id)
);

drop policy if exists "messages_shared_update" on public.messages;
create policy "messages_shared_update"
on public.messages
for update
to authenticated
using (
  public.can_write_to_shared_conversation(messages.conversation_id)
)
with check (
  messages.role = 'user'
  and messages.source = 'share'
  and public.can_write_to_shared_conversation(messages.conversation_id)
);

drop policy if exists "device_operations_shared_select" on public.device_operations;
create policy "device_operations_shared_select"
on public.device_operations
for select
to authenticated
using (
  public.can_write_to_shared_conversation(
    device_operations.conversation_id,
    device_operations.device_id
  )
);

drop policy if exists "device_operations_shared_update" on public.device_operations;
create policy "device_operations_shared_update"
on public.device_operations
for update
to authenticated
using (
  public.can_write_to_shared_conversation(
    device_operations.conversation_id,
    device_operations.device_id
  )
)
with check (
  device_operations.requested_by_user_id = auth.uid()
  and device_operations.type = 'send_message'
  and device_operations.status = 'pending'
  and device_operations.error_text is null
  and device_operations.claimed_at is null
  and device_operations.completed_at is null
  and public.can_write_to_shared_conversation(
    device_operations.conversation_id,
    device_operations.device_id
  )
);
