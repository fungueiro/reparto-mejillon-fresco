-- Paso 2 de 2. Cierra el cambio a PIN por barco:
--   · saca los PIN en claro del JSON de `estado`
--   · impide que el cliente los vuelva a meter
--   · retira la clave común de socios, que ya no la pide nadie
--
-- Requiere que la versión nueva de la app esté desplegada y probada. Una
-- pestaña con el JavaScript viejo dejará de poder entrar como socio hasta
-- que se recargue.

/* ── 1) Fuera los PIN en claro del estado ──────────────────────────────── */
-- Ya están cifrados en `pines_barco` desde la migración 03. El JSON los
-- llevaba duplicados.
update public.estado
   set data = jsonb_set(data, '{barcos}',
         coalesce((select jsonb_agg((b - 'pin' - 'tienePin') order by ord)
                     from jsonb_array_elements(data->'barcos') with ordinality t(b, ord)),
                  '[]'::jsonb))
 where id = 'principal'
   and exists (select 1 from jsonb_array_elements(data->'barcos') b where b ? 'pin');

/* ── 2) El estado que sale al cliente nunca lleva PIN ──────────────────── */
create or replace function public.cargar_estado(p_pass text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
begin
  if public.rol_de_pass(p_pass) is null then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  return public.estado_para_cliente((select data from public.estado where id = 'principal'));
end; $fn$;

/* ── 3) El que entra tampoco los lleva ─────────────────────────────────── */
-- Si el payload trae un `pin` en claro (alta de barco o importación), se
-- cifra en `pines_barco` y se descarta del JSON. `tienePin` es solo de
-- lectura y también se descarta.
create or replace function public.guardar_estado(p_pass text, p_data jsonb)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $fn$
declare limpio jsonb;
begin
  if public.rol_de_pass(p_pass) is distinct from 'oficinista' then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;

  insert into public.pines_barco (barco_id, pin_hash, updated_at)
  select b->>'id', crypt(b->>'pin', gen_salt('bf')), now()
    from jsonb_array_elements(p_data->'barcos') b
   where coalesce(b->>'pin','') ~ '^\d{4}$'
  on conflict (barco_id) do update
       set pin_hash = excluded.pin_hash, updated_at = excluded.updated_at;

  limpio := jsonb_set(p_data, '{barcos}',
    coalesce((select jsonb_agg((b - 'pin' - 'tienePin') order by ord)
                from jsonb_array_elements(p_data->'barcos') with ordinality t(b, ord)),
             '[]'::jsonb));

  insert into public.estado (id, data, updated_at)
       values ('principal', limpio, now())
  on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at;
  return true;
end; $fn$;

/* ── 4) Fuera la clave común de socios ─────────────────────────────────── */
-- Mientras exista sigue siendo una llave que abre los datos, aunque la app ya
-- no la pida en ningún sitio.
delete from public.accesos where rol = 'patron';
alter table public.accesos drop constraint if exists accesos_rol_check;
alter table public.accesos add constraint accesos_rol_check check (rol = 'oficinista');

-- cambiar_pass ya solo puede tocar la de oficinista.
create or replace function public.cambiar_pass(p_pass_oficinista text, p_rol text, p_nueva text)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $fn$
begin
  if public.rol_de_pass(p_pass_oficinista) is distinct from 'oficinista' then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  if p_rol is distinct from 'oficinista' then
    raise exception 'rol no válido';
  end if;
  if p_nueva is null or length(p_nueva) < 6 then
    raise exception 'la contraseña debe tener al menos 6 caracteres';
  end if;
  update public.accesos
     set password_hash = crypt(p_nueva, gen_salt('bf')),
         algoritmo = 'bcrypt', updated_at = now()
   where rol = 'oficinista';
  return true;
end; $fn$;

drop function if exists public.hay_pass_patron();
