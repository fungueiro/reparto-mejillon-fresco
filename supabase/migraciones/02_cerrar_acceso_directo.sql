-- PENDIENTE DE APLICAR. Este es el paso que cierra la puerta de verdad.
--
-- NO EJECUTAR hasta que se cumpla TODO lo siguiente, o la app deja de funcionar
-- para todo el mundo:
--
--   1. La versión nueva de la app está desplegada en producción y verificada.
--   2. El oficinista ha entrado en ⚙️ Config y ha fijado la "Clave de socios".
--      Sin ella, ningún patrón puede entrar.
--   3. El oficinista ha cambiado su propia contraseña (la heredada era `admin`).
--
-- Mientras esto no se ejecute, los datos siguen siendo legibles y escribibles
-- por cualquiera que extraiga la clave anónima del JavaScript de la app: las
-- funciones nuevas conviven con las políticas abiertas, no las sustituyen.
--
-- Aviso: la app es una PWA. Un navegador con la versión antigua cacheada seguirá
-- llamando a las tablas directamente y dará error hasta que se recargue.

-- 1) Fuera las políticas abiertas de `estado`.
drop policy if exists "lectura publica"  on public.estado;
drop policy if exists "escritura publica" on public.estado;
revoke all on public.estado from anon, authenticated;

-- 2) Fuera las funciones de compatibilidad con la app antigua.
drop function if exists public.validar_oficinista(text);
drop function if exists public.cambiar_pass_oficinista(text, text);

-- 3) `officers` queda sin uso: la contraseña vive ahora en `accesos`.
--    Se conserva la tabla por si hace falta volver atrás; bórrala cuando
--    la versión nueva lleve un tiempo funcionando.
-- drop table if exists public.officers;

-- 4) Marea (`movimientos`, `programados`, `config_app`) tiene exactamente el
--    mismo problema en este mismo proyecto, y NO se toca aquí porque su app
--    vive en otro repositorio. Sus políticas `anon_all_*` siguen abiertas.
