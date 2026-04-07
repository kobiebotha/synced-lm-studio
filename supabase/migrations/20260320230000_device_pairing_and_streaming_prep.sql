do $$
begin
  if to_regclass('public.devices') is not null then
    alter table public.devices
      add column if not exists pairing_status text not null default 'pending'
        check (pairing_status in ('pending', 'paired')),
      add column if not exists pairing_code text,
      add column if not exists paired_at timestamptz;

    create index if not exists devices_pairing_status_idx on public.devices (pairing_status);
  end if;
end;
$$;
