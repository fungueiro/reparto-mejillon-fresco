# Migraciones de Supabase

Las migraciones de este directorio ya están **aplicadas** en el proyecto, salvo
las marcadas como PENDIENTE. Se guardan aquí para que quede constancia en el
repositorio de lo que hay en la base de datos.

| Archivo | Estado |
|---|---|
| `01_accesos_por_rol.sql` | aplicada |
| `02_cerrar_acceso_directo.sql` | **PENDIENTE** — ver instrucciones dentro |

## Por qué existe esto

La clave anónima de Supabase viaja en el JavaScript de la app y cualquiera puede
extraerla: no es un secreto, y nunca lo fue. Lo que protegía los datos tenían que
ser las políticas RLS, pero todas eran `USING (true) WITH CHECK (true)`, es decir,
abiertas a cualquiera. En la práctica, cualquier persona con la URL podía leer
todos los datos y sobrescribirlos enteros.

La solución adoptada: las tablas dejan de ser accesibles desde el cliente y todo
pasa por funciones `SECURITY DEFINER` que exigen la contraseña de un rol
(`oficinista`, que lee y escribe; `patron`, que solo lee). Es el mismo patrón que
ya se usaba para la contraseña de oficinista, extendido al resto.
