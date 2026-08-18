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
let clave = null;
let rol   = null;

export const rolActual = () => rol;

// Devuelve 'oficinista' | 'patron' si la contraseña es válida, null si no.
export async function iniciarSesion(pass) {
  const { data, error } = await supabase.rpc("iniciar_sesion", { p_pass: pass });
  if (error) throw error;
  if (!data) return null;
  clave = pass;
  rol   = data;
  return rol;
}

export function cerrarSesion() {
  clave = null;
  rol   = null;
}

export async function cargarEstadoRemoto() {
  if (!clave) return null;
  const { data, error } = await supabase.rpc("cargar_estado", { p_pass: clave });
  if (error) throw error;
  return data ?? null;
}

// Solo el oficinista puede escribir; el servidor lo vuelve a comprobar.
export async function guardarEstadoRemoto(estado) {
  if (rol !== "oficinista") return false;
  const { error } = await supabase.rpc("guardar_estado", { p_pass: clave, p_data: estado });
  return !error;
}

// Cambia la contraseña de un rol. Siempre exige la de oficinista.
export async function cambiarPass(actual, rolDestino, nueva) {
  const { data, error } = await supabase.rpc("cambiar_pass", {
    p_pass_oficinista: actual,
    p_rol: rolDestino,
    p_nueva: nueva,
  });
  if (error) throw error;
  // Si el oficinista ha cambiado su propia clave, la sesión sigue con la nueva.
  if (data === true && rolDestino === "oficinista" && rol === "oficinista") clave = nueva;
  return data === true;
}

export async function hayPassPatron() {
  const { data, error } = await supabase.rpc("hay_pass_patron");
  if (error) throw error;
  return data === true;
}
