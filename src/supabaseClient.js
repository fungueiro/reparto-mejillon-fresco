import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://cfqlattwvyvtakkyznpb.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmcWxhdHR3dnl2dGFra3l6bnBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTg3MDcsImV4cCI6MjA5NTk5NDcwN30.NJqmlSTVTSKLpROk-IZQd4Q7hpbPQ4KxHRWPNgtdIGw";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function cargarEstadoRemoto() {
  const { data, error } = await supabase
    .from("estado")
    .select("data")
    .eq("id", "principal")
    .single();
  if (error) throw error;
  return data?.data ?? null;
}

export async function guardarEstadoRemoto(estado) {
  const { error } = await supabase.from("estado").upsert({
    id: "principal",
    data: estado,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function validarOficinista(pass) {
  const { data, error } = await supabase.rpc("validar_oficinista", { p_pass: pass });
  if (error) throw error;
  return data === true;
}

export async function cambiarPassOficinista(actualPass, newPass) {
  const { data, error } = await supabase.rpc("cambiar_pass_oficinista", {
    p_actual: actualPass,
    p_nueva: newPass,
  });
  if (error) throw error;
  if (data !== true) throw new Error("Contraseña actual incorrecta");
}
