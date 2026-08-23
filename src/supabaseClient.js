import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cfqlattwvyvtakkyznpb.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmcWxhdHR3dnl2dGFra3l6bnBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTg3MDcsImV4cCI6MjA5NTk5NDcwN30.NJqmlSTVTSKLpROk-IZQd4Q7hpbPQ4KxHRWPNgtdIGw";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ── SESIÓN ────────────────────────────────────────────────────
   Los datos ya no son accesibles con la clave anónima: todo pasa por
   funciones del servidor que exigen una contraseña de rol (oficinista o
   patrón). La contraseña vive SOLO en memoria mientras la pestaña está
   abierta — ni localStorage, ni el estado de la app, ni el backup. Al
   recargar la página hay que volver a entrar. */
let sesion = null;   // { rol:"oficinista", pass } | { rol:"patron", barcoId, pin }

export const rolActual   = () => (sesion ? sesion.rol : null);
export const barcoSesion = () => (sesion && sesion.rol === "patron" ? sesion.barcoId : null);

// La oficina entra con su contraseña.
export async function iniciarSesion(pass) {
  const { data, error } = await supabase.rpc("iniciar_sesion", { p_pass: pass });
  if (error) throw error;
  if (data !== "oficinista") return null;
  sesion = { rol: "oficinista", pass };
  return "oficinista";
}

// Los socios entran con su barco y su PIN, sin clave común previa. El PIN se
// comprueba en el servidor contra un hash bcrypt; nunca viaja al navegador.
export async function listarBarcos() {
  const { data, error } = await supabase.rpc("listar_barcos");
  if (error) throw error;
  return data || [];
}

export async function entrarPatron(barcoId, pin) {
  const { data, error } = await supabase.rpc("iniciar_sesion_patron", {
    p_barco_id: barcoId, p_pin: pin,
  });
  if (error) throw error;
  if (!data) return null;
  sesion = { rol: "patron", barcoId, pin };
  return data;                        // { id, nombre }
}

export function cerrarSesion() {
  sesion = null;
}

export async function cargarEstadoRemoto() {
  if (!sesion) return null;
  const { data, error } =
    sesion.rol === "oficinista"
      ? await supabase.rpc("cargar_estado", { p_pass: sesion.pass })
      : await supabase.rpc("cargar_estado_patron", { p_barco_id: sesion.barcoId, p_pin: sesion.pin });
  if (error) throw error;
  return data ?? null;
}

// Solo el oficinista puede escribir; el servidor lo vuelve a comprobar.
export async function guardarEstadoRemoto(estado) {
  if (!sesion || sesion.rol !== "oficinista") return false;
  const { error } = await supabase.rpc("guardar_estado", { p_pass: sesion.pass, p_data: estado });
  return !error;
}

// Cambia la contraseña de oficinista. Exige la actual.
export async function cambiarPass(actual, rolDestino, nueva) {
  const { data, error } = await supabase.rpc("cambiar_pass", {
    p_pass_oficinista: actual,
    p_rol: rolDestino,
    p_nueva: nueva,
  });
  if (error) throw error;
  if (data === true && rolDestino === "oficinista" && sesion && sesion.rol === "oficinista" && sesion.pass === actual) {
    sesion = { ...sesion, pass: nueva };
  }
  return data === true;
}

// Fija el PIN de un barco. El PIN se cifra en el servidor y no se puede leer.
export async function cambiarPinBarco(barcoId, pin) {
  if (!sesion || sesion.rol !== "oficinista") return false;
  const { data, error } = await supabase.rpc("cambiar_pin", {
    p_pass_oficinista: sesion.pass, p_barco_id: barcoId, p_pin: pin,
  });
  if (error) throw error;
  return data === true;
}

export async function contarBarcosSinPin() {
  const { data, error } = await supabase.rpc("barcos_sin_pin");
  if (error) throw error;
  return data ?? 0;
}
