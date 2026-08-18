-- APLICADA. Accesos por rol, historial de versiones y funciones de acceso.
--
-- Las tablas `accesos` y `estado_historial` no tienen ninguna política: son
-- inalcanzables desde el cliente y solo se tocan desde funciones SECURITY
-- DEFINER, igual que se venía haciendo con `officers`.

create table if not exists public.accesos (
  rol           text primary key check (rol in ('oficinista','patron')),
  password_hash text not null,
  algoritmo     text not null default 'bcrypt' check (algoritmo in ('bcrypt','sha256')),
  updated_at    timestamptz not null default now()
);
alter table public.accesos enable row level security;
revoke all on public.accesos from anon, authenticated;

-- Conserva la contraseña de oficinista que ya estaba en uso (hash sha256).
insert into public.accesos (rol, password_hash, algoritmo)
select 'oficinista', o.password_hash, 'sha256' from public.officers o limit 1
on conflict (rol) do nothing;

-- Historial de versiones de `estado`: red de seguridad en el servidor.
create table if not exists public.estado_historial (
  id          bigserial primary key,
  data        jsonb not null,
  guardado_en timestamptz not null default now()
);
alter table public.estado_historial enable row level security;
revoke all on public.estado_historial from anon, authenticated;

create or replace function public.estado_versionar()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.estado_historial (data) values (old.data);
  delete from public.estado_historial
   where id not in (select id from public.estado_historial order by id desc limit 50);
  return new;
end; $$;

drop trigger if exists trg_estado_versionar on public.estado;
create trigger trg_estado_versionar
  before update on public.estado
  for each row execute function public.estado_versionar();

-- Verifica la contraseña. Acepta el hash sha256 heredado y lo reescribe a
-- bcrypt en el primer acceso correcto, sin que el usuario note nada.
create or replace function public.rol_de_pass(p_pass text)
returns text language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare a record; ok boolean;
begin
  if p_pass is null or length(p_pass) = 0 then return null; end if;
  for a in select * from public.accesos order by (rol = 'oficinista') desc loop
    if a.algoritmo = 'bcrypt' then
      ok := (a.password_hash = crypt(p_pass, a.password_hash));
    else
      ok := (a.password_hash = encode(digest(p_pass, 'sha256'), 'hex'));
      if ok then
        update public.accesos
           set password_hash = crypt(p_pass, gen_salt('bf')),
               algoritmo = 'bcrypt', updated_at = now()
         where rol = a.rol;
      end if;
    end if;
    if ok then return a.rol; end if;
  end loop;
  return null;
end; $$;

create or replace function public.iniciar_sesion(p_pass text)
returns text language sql security definer set search_path to 'public'
as $$ select public.rol_de_pass(p_pass); $$;

create or replace function public.cargar_estado(p_pass text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if public.rol_de_pass(p_pass) is null then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  return (select data from public.estado where id = 'principal');
end; $$;

create or replace function public.guardar_estado(p_pass text, p_data jsonb)
returns boolean language plpgsql security definer set search_path to 'public' as $$
begin
  if public.rol_de_pass(p_pass) is distinct from 'oficinista' then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  insert into public.estado (id, data, updated_at)
       values ('principal', p_data, now())
  on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at;
  return true;
end; $$;

create or replace function public.cambiar_pass(p_pass_oficinista text, p_rol text, p_nueva text)
returns boolean language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  if public.rol_de_pass(p_pass_oficinista) is distinct from 'oficinista' then
    raise exception 'acceso denegado' using errcode = '42501';
  end if;
  if p_rol not in ('oficinista','patron') then
    raise exception 'rol no válido';
  end if;
  if p_nueva is null or length(p_nueva) < 6 then
    raise exception 'la contraseña debe tener al menos 6 caracteres';
  end if;
  insert into public.accesos (rol, password_hash, algoritmo, updated_at)
       values (p_rol, crypt(p_nueva, gen_salt('bf')), 'bcrypt', now())
  on conflict (rol) do update
       set password_hash = excluded.password_hash,
           algoritmo     = excluded.algoritmo,
           updated_at    = excluded.updated_at;
  return true;
end; $$;

create or replace function public.hay_pass_patron()
returns boolean language sql security definer set search_path to 'public'
as $$ select exists (select 1 from public.accesos where rol = 'patron'); $$;

-- rol_de_pass no se expone: el cliente solo entra por iniciar_sesion.
revoke all on function public.rol_de_pass(text) from anon, authenticated;
grant execute on function public.iniciar_sesion(text)           to anon, authenticated;
grant execute on function public.cargar_estado(text)            to anon, authenticated;
grant execute on function public.guardar_estado(text, jsonb)    to anon, authenticated;
grant execute on function public.cambiar_pass(text, text, text)  to anon, authenticated;
grant execute on function public.hay_pass_patron()               to anon, authenticated;

-- COMPATIBILIDAD TEMPORAL: la versión de la app que hay en producción mientras
-- se despliega esta sigue llamando a estas dos. Se eliminan en la migración 02.
create or replace function public.validar_oficinista(p_pass text)
returns boolean language sql security definer set search_path to 'public'
as $$ select public.rol_de_pass(p_pass) = 'oficinista'; $$;

create or replace function public.cambiar_pass_oficinista(p_actual text, p_nueva text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
begin
  return public.cambiar_pass(p_actual, 'oficinista', p_nueva);
exception when others then
  return false;
end; $$;

grant execute on function public.validar_oficinista(text)            to anon, authenticated;
grant execute on function public.cambiar_pass_oficinista(text, text) to anon, authenticated;

drop function if exists public.login_oficinista(text);
