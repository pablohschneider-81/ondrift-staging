-- Bajada de plan con más invitados que plazas: se quedan los que se unieron primero;
-- los demás pasan a solo lectura (sin perder datos) y ambos lados reciben un aviso.
-- Aplicada en staging el 19-nov (migración 'billing_downgrade_seats').
alter table public.coaches
  add column if not exists billing_joined_at timestamptz,
  add column if not exists billing_notice text;

-- Los ya unidos: fecha de alta como aproximación.
update public.coaches set billing_joined_at = created_at
 where billing_owner_id is not null and billing_joined_at is null;

create or replace function public.propagate_owner_plan()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  keep int;
  owner_name text := coalesce(new.display_name, 'tu compañero');
  plan_label text := case new.plan when 'duo' then 'Dúo' when 'grupo4' then 'Grupo de 4' when 'individual' then 'Individual' else 'sin plan' end;
  dropped text;
begin
  if new.billing_owner_id is not null or new.plan is not distinct from old.plan then
    return new;
  end if;

  if new.plan in ('duo','grupo4') then
    keep := public.plan_seats(new.plan) - 1;  -- plazas para invitados
    with ordered as (
      select id, row_number() over (order by coalesce(billing_joined_at, created_at), id) rn
        from public.coaches where billing_owner_id = new.id
    ), out_ as (
      update public.coaches m
         set billing_owner_id = null, plan = 'inactive',
             billing_notice = 'El plan de ' || owner_name || ' pasó a ' || plan_label
               || ' y ya no tenía plaza para ti. Tu cuenta queda en solo lectura (no pierdes nada): puedes suscribirte por tu cuenta o pedirle que te vuelva a invitar.'
        from ordered o
       where m.id = o.id and o.rn > keep
      returning coalesce(m.display_name, (select email from auth.users u where u.id = m.id), 'un entrenador') as who
    )
    select string_agg(who, ', ') into dropped from out_;

    update public.coaches set plan = new.plan where billing_owner_id = new.id;

    if dropped is not null then
      update public.coaches
         set billing_notice = 'Al pasar a ' || plan_label || ' han quedado fuera de tu plan: ' || dropped
           || '. Sus cuentas siguen con sus datos, en solo lectura.'
       where id = new.id;
    end if;
  else
    -- Dejó de pagar o bajó a Individual: todos sus invitados pasan a solo lectura.
    update public.coaches m
       set billing_owner_id = null, plan = 'inactive',
           billing_notice = case when new.plan = 'individual'
             then 'El plan de ' || owner_name || ' pasó a Individual y ya no incluye a otros entrenadores. Tu cuenta queda en solo lectura (no pierdes nada): puedes suscribirte por tu cuenta.'
             else 'El plan de ' || owner_name || ' ha terminado. Tu cuenta queda en solo lectura (no pierdes nada): puedes suscribirte por tu cuenta.' end
     where m.billing_owner_id = new.id;
  end if;
  return new;
end $$;

-- Unirse guarda la fecha de unión y borra avisos antiguos.
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
     set billing_owner_id = owner.id, plan = owner.plan, status = 'approved',
         billing_joined_at = now(), billing_notice = null
   where id = me.id;
  return json_build_object('ok', true, 'plan', owner.plan, 'owner_name', owner.display_name);
end $$;

-- Avisos: leer (dentro de my_billing) y cerrar.
create or replace function public.dismiss_billing_notice()
returns void language sql volatile security definer set search_path = public as $$
  update public.coaches set billing_notice = null where id = auth.uid();
$$;

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
      'billing_interval', owner.billing_interval,
      'cancel_at', owner.cancel_at, 'current_period_end', owner.current_period_end,
      'notice', me.billing_notice);
  end if;

  if me.plan in ('duo','grupo4') and me.stripe_subscription_id is not null then
    if me.invite_token is null then
      update public.coaches set invite_token = replace(gen_random_uuid()::text, '-', '')
       where id = me.id returning * into me;
    end if;
    select coalesce(json_agg(json_build_object('id', m.id, 'name', coalesce(m.display_name, u.email, 'Entrenador sin nombre')) order by coalesce(m.billing_joined_at, m.created_at)), '[]'::json),
           count(*)::int
      into members, used
      from public.coaches m left join auth.users u on u.id = m.id
     where m.billing_owner_id = me.id;
    return json_build_object(
      'role', 'owner', 'plan', me.plan, 'subscription_status', me.subscription_status,
      'billing_interval', me.billing_interval,
      'cancel_at', me.cancel_at, 'current_period_end', me.current_period_end,
      'seats_total', public.plan_seats(me.plan), 'seats_used', used + 1,
      'members', members, 'invite_token', me.invite_token,
      'notice', me.billing_notice);
  end if;

  return json_build_object(
    'role', 'self', 'plan', me.plan, 'subscription_status', me.subscription_status,
    'billing_interval', me.billing_interval,
    'cancel_at', me.cancel_at, 'current_period_end', me.current_period_end,
    'notice', me.billing_notice);
end $$;

revoke execute on function public.my_billing(), public.join_billing_group(text), public.dismiss_billing_notice(), public.propagate_owner_plan() from public, anon;
grant execute on function public.my_billing(), public.join_billing_group(text), public.dismiss_billing_notice() to authenticated;
