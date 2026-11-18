-- Corrige la revocación del 16-nov: las reglas RLS (rol public, incluye anon) llaman a
-- estas funciones. Sin EXECUTE para anon, toda lectura antes del login fallaba con 401
-- y la app mostraba "La clave de Supabase no es válida". Sin sesión devuelven
-- false / null, así que no revelan datos (comprobado: 0 filas en todas las tablas).
-- Siguen cerradas a anon: list_coaches_for_admin, my_coach_status, coach_athlete_limit,
-- handle_new_coach, enforce_athlete_limit y las funciones de facturación.

-- Producción (skblkxwaxnefycgrqeyt):
-- grant execute on function public.is_admin(), public.is_approved_coach(), public.current_athlete_id(),
--   public.current_athlete_coach_id(), public.coach_can_write(uuid), public.coach_owns_athlete(uuid) to anon;

-- Staging (ibahgkauqzbbkxjeqsno):
grant execute on function public.is_admin(), public.is_approved_coach(), public.current_athlete_id(),
  public.current_athlete_coach_id(), public.coach_can_write(uuid), public.my_athlete_ids() to anon;
