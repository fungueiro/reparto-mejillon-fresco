-- Paso 1 de 2. Los socios pasan a entrar solo con barco + PIN, sin la clave
-- común previa. Solo AÑADE: la app que hay en producción sigue funcionando
-- igual mientras se despliega la nueva. El cierre es la migración 04.

/* ── PIN por barco, cifrado ────────────────────────────────────────────── */
-- Hasta ahora el PIN vivía en claro dentro del JSON de `estado` y lo
-- comprobaba el navegador. Pasa a una tabla propia, cifrado con bcrypt y
-- comprobado en el servidor. La tabla no tiene políticas: es inalcanzable
-- desde el cliente.
create table if not exists public.pines_barco (
  barco_id   text primary key,
  pin_hash   text not null,
  updated_at timestamptz not null default now()
);
alter table public.pines_barco enable row level security;
revoke all on public.pines_barco from anon, authenticated;

-- Backfill desde los PIN que ya existen, para que nadie se quede fuera hoy.
insert into public.pines_barco (barco_id, pin_hash)
select b->>'id', extensions.crypt(b->>'pin', extensions.gen_salt('bf'))
  from public.estado e, jsonb_array_elements(e.data->'barcos') b
 where e.id = 'principal' and coalesce(b->>'pin','') <> ''
on conflict (barco_id) do nothing;

/* ── Freno a la fuerza bruta ───────────────────────────────────────────── */
-- Un PIN de 4 dígitos son 10.000 combinaciones. Sin freno, probarlas todas es
-- cuestión de minutos. 10 fallos en 15 minutos bloquean ese barco hasta que
-- pase la ventana; un acierto lo limpia.
create table if not exists public.intentos_pin (
  barco_id text primary key,
  fallos   int not null default 0,
  desde    timestamptz not null default now()
);
alter table public.intentos_pin enable row level security;
revoke all on public.intentos_pin from anon, authenticated;

create or replace function public.pin_valido(p_barco_id text, p_pin text)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $fn$
declare h text; f int; d timestamptz; ok boolean;
begin
  if p_barco_id is null or p_pin is null or length(p_pin) = 0 then return false; end if;

  select fallos, desde into f, d from public.intentos_pin where barco_id = p_barco_id;
  if found and d > now() - interval '15 minutes' and f >= 10 then
    return false;                      -- bloqueado por intentos
  end if;

  select pin_hash into h from public.pines_barco where barco_id = p_barco_id;
  ok := h is not null and h = crypt(p_pin, h);

  if ok then
    delete from public.intentos_pin where barco_id = p_barco_id;
  else
    insert into public.intentos_pin (barco_id, fallos, desde)
         values (p_barco_id, 1, now())
    on conflict (barco_id) do update
         set fallos = case when public.intentos_pin.desde > now() - interval '15 minutes'
                           then public.intentos_pin.fallos + 1 else 1 end,
             desde  = case when public.intentos_pin.desde > now() - interval '15 minutes'
                           then public.intentos_pin.desde else now() end;
  end if;
  return ok;
end; $fn$;

/* ── Acceso de los socios ──────────────────────────────────────────────── */
-- Pública a propósito: la pantalla de acceso necesita el desplegable de
-- barcos. Devuelve SOLO id y nombre de los activos; ningún PIN sale de aquí.
create or replace function public.listar_barcos()
returns table (id text, nombre text)
language sql security definer set search_path to 'public' as $fn$
  select b->>'id', b->>'nombre'
    from public.estado e, jsonb_array_elements(e.data->'barcos') b
   where e.id = 'principal' and coalesce((b->>'activo')::boolean, true)
   order by b->>'nombre';
$fn$;

-- Quita los PIN del estado antes de mandarlo a cualquier cliente y añade
-- `tienePin` para que Configuración pueda avisar de los que faltan.
create or replace function public.estado_para_cliente(p_data jsonb)
returns jsonb language sql security definer set search_path to 'public' as $fn$
  select case when p_data is null then null else jsonb_set(p_data, '{barcos}',
    coalesce((select jsonb_agg((b - 'pin') ||
                jsonb_build_object('tienePin',
                  exists(select 1 from public.pines_barco p where p.barco_id = b->>'id'))
              order by ord)
                from jsonb_array_elements(p_data->'barcos') with ordinality t(b, ord)),
             '[]'::jsonb)) end;
$fn$;
revoke all on function public.estado_para_cliente(jsonb) from anon, authenticated;

create or replace function public.iniciar_sesion_patron(p_barco_id text, p_pin text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare b jsonb;
begin
  if not public.pin_valido(p_barco_id, p_pin) then return null; end if;
  select x into b from public.estado e, jsonb_array_elements(e.data->'barcos') x
   where e.id = 'principal' and x->>'id' = p_barco_id limit 1;
  if b is null then return null; end if;
  return jsonb_build_object('id', b->>'id', 'nombre', b->>'nombre');
end; $fn$;

create or replace function public.cargar_estado_patron(p_barco_id text, p_pin text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
begin
  if not public.pin_valido(p_barco_id, p_pin) then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  return public.estado_para_cliente((select data from public.estado where id = 'principal'));
end; $fn$;

/* ── Gestión de PIN desde la oficina ───────────────────────────────────── */
create or replace function public.cambiar_pin(p_pass_oficinista text, p_barco_id text, p_pin text)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $fn$
begin
  if public.rol_de_pass(p_pass_oficinista) is distinct from 'oficinista' then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  if p_pin !~ '^\d{4}$' then
    raise exception 'el PIN debe ser exactamente 4 dígitos';
  end if;
  insert into public.pines_barco (barco_id, pin_hash, updated_at)
       values (p_barco_id, crypt(p_pin, gen_salt('bf')), now())
  on conflict (barco_id) do update
       set pin_hash = excluded.pin_hash, updated_at = excluded.updated_at;
  delete from public.intentos_pin where barco_id = p_barco_id;
  return true;
end; $fn$;

create or replace function public.barcos_sin_pin()
returns integer language sql security definer set search_path to 'public' as $fn$
  select count(*)::int
    from public.estado e, jsonb_array_elements(e.data->'barcos') b
   where e.id = 'principal' and coalesce((b->>'activo')::boolean, true)
     and not exists (select 1 from public.pines_barco p where p.barco_id = b->>'id');
$fn$;

/* ── Permisos ──────────────────────────────────────────────────────────── */
revoke all on function public.pin_valido(text, text) from anon, authenticated;

grant execute on function public.listar_barcos()                   to anon, authenticated;
grant execute on function public.iniciar_sesion_patron(text, text) to anon, authenticated;
grant execute on function public.cargar_estado_patron(text, text)  to anon, authenticated;
grant execute on function public.cambiar_pin(text, text, text)     to anon, authenticated;
grant execute on function public.barcos_sin_pin()                  to anon, authenticated;
