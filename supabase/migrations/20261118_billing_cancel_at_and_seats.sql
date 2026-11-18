-- Ondrift · facturación: cancelación programada y plazas de Dúo / Grupo de 4.
-- Sin instrucciones de borrado (todo es add / create or replace).

-- 1) Columnas
alter table public.coaches
  add column if not exists cancel_at timestamptz,
  add column if not exists billing_owner_id uuid references public.coaches(id) on delete set null,
  add column if not exists invite_token text unique;
create index if not exists coaches_billing_owner_idx on public.coaches(billing_owner_id);

-- Plazas totales del plan, contando al que paga.
create or replace function public.plan_seats(p_plan text)
returns int language sql immutable as $$
  select case p_plan when 'duo' then 2 when 'grupo4' then 4 else 1 end;
$$;

-- 2) Cuando cambia el plan de quien paga, sus invitados le siguen:
--    mismo plan si sigue en Dúo / Grupo; si no, solo lectura ('expired').
create or replace function public.propagate_owner_plan()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.billing_owner_id is null and new.plan is distinct from old.plan then
    update public.coaches m
       set plan = case when new.plan in ('duo','grupo4') then new.plan else 'expired' end
     where m.billing_owner_id = new.id;
  end if;
  return new;
end $$;
create or replace trigger coaches_propagate_owner_plan
  after update of plan on public.coaches
  for each row execute function public.propagate_owner_plan();

-- 3) Estado de facturación del entrenador con sesión (y su grupo).
create or replace function public.my_billing()
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  me public.coaches;
  owner public.coaches;
  members json;
  used int;
begin
  select * into me from public.coaches where id = auth.uid();
  if not found then return null; end if;

  if me.billing_owner_id is not null then
    select * into owner from public.coaches where id = me.billing_owner_id;
    return json_build_object(
      'role', 'member', 'plan', me.plan,
      'owner_name', coalesce(owner.display_name, 'tu compañero'),
      'cancel_at', owner.cancel_at, 'current_period_end', owner.current_period_end);
  end if;

  if me.plan in ('duo','grupo4') and me.stripe_subscription_id is not null then
    if me.invite_token is null then
      update public.coaches set invite_token = replace(gen_random_uuid()::text, '-', '')
       where id = me.id returning * into me;
    end if;
    select coalesce(json_agg(json_build_object('id', m.id, 'name', coalesce(m.display_name, 'Entrenador sin nombre')) order by m.created_at), '[]'::json),
           count(*)::int
      into members, used
      from public.coaches m where m.billing_owner_id = me.id;
    return json_build_object(
      'role', 'owner', 'plan', me.plan, 'subscription_status', me.subscription_status,
      'cancel_at', me.cancel_at, 'current_period_end', me.current_period_end,
      'seats_total', public.plan_seats(me.plan), 'seats_used', used + 1,
      'members', members, 'invite_token', me.invite_token);
  end if;

  return json_build_object(
    'role', 'self', 'plan', me.plan, 'subscription_status', me.subscription_status,
    'cancel_at', me.cancel_at, 'current_period_end', me.current_period_end);
end $$;

-- 4) Unirse al plan de otro entrenador con su enlace de invitación.
create or replace function public.join_billing_group(p_token text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  me public.coaches;
  owner public.coaches;
  used int;
begin
  select * into me from public.coaches where id = auth.uid() for update;
  if not found then return json_build_object('ok', false, 'error', 'Solo una cuenta de entrenador puede unirse a un plan.'); end if;

  select * into owner from public.coaches
   where invite_token = p_token and billing_owner_id is null
     and plan in ('duo','grupo4')
     and subscription_status in ('active','trialing','past_due')
   for update;
  if not found then return json_build_object('ok', false, 'error', 'Este enlace de invitación no es válido o el plan ya no está activo.'); end if;

  if owner.id = me.id then return json_build_object('ok', false, 'error', 'Este es tu propio enlace: compártelo con tus compañeros.'); end if;
  if me.billing_owner_id = owner.id then return json_build_object('ok', true, 'already', true, 'plan', owner.plan, 'owner_name', owner.display_name); end if;
  if me.billing_owner_id is not null then return json_build_object('ok', false, 'error', 'Ya formas parte del plan de otro entrenador.'); end if;
  if me.subscription_status in ('active','trialing','past_due') then
    return json_build_object('ok', false, 'error', 'Ya tienes tu propia suscripción. Cancélala desde "Gestionar suscripción" antes de unirte.');
  end if;

  select count(*)::int into used from public.coaches where billing_owner_id = owner.id;
  if used + 1 >= public.plan_seats(owner.plan) then
    return json_build_object('ok', false, 'error', 'El plan de ' || coalesce(owner.display_name, 'tu compañero') || ' ya no tiene plazas libres.');
  end if;

  update public.coaches
     set billing_owner_id = owner.id, plan = owner.plan, status = 'approved'
   where id = me.id;
  return json_build_object('ok', true, 'plan', owner.plan, 'owner_name', owner.display_name);
end $$;

-- 5) Quien paga quita a un entrenador de su plan (pasa a solo lectura, sin perder datos).
create or replace function public.remove_billing_member(p_member uuid)
returns json language plpgsql volatile security definer set search_path = public as $$
begin
  update public.coaches set billing_owner_id = null, plan = 'expired'
   where id = p_member and billing_owner_id = auth.uid();
  if not found then return json_build_object('ok', false, 'error', 'Ese entrenador no está en tu plan.'); end if;
  return json_build_object('ok', true);
end $$;

-- 6) Enlace nuevo (el anterior deja de valer).
create or replace function public.regenerate_invite()
returns json language plpgsql volatile security definer set search_path = public as $$
declare t text;
begin
  update public.coaches set invite_token = replace(gen_random_uuid()::text, '-', '')
   where id = auth.uid() and billing_owner_id is null and plan in ('duo','grupo4')
   returning invite_token into t;
  if t is null then return json_build_object('ok', false, 'error', 'Solo quien paga un Dúo o un Grupo puede generar enlaces.'); end if;
  return json_build_object('ok', true, 'invite_token', t);
end $$;

-- Permisos: solo entrenadores con sesión; nunca anon.
revoke execute on function public.my_billing(), public.join_billing_group(text), public.remove_billing_member(uuid), public.regenerate_invite(), public.propagate_owner_plan() from public, anon;
grant execute on function public.my_billing(), public.join_billing_group(text), public.remove_billing_member(uuid), public.regenerate_invite() to authenticated;
