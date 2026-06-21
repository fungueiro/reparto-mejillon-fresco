import { useState, useMemo, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { cargarEstadoRemoto, guardarEstadoRemoto, validarOficinista, cambiarPassOficinista } from "./supabaseClient";

const GlobalStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800&family=DM+Mono:wght@400;500&family=Barlow:wght@400;500;600&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Barlow', sans-serif; background: #0f1923; }
    .mono { font-family: 'DM Mono', monospace; }
    .cond { font-family: 'Barlow Condensed', sans-serif; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #1a2a3a; }
    ::-webkit-scrollbar-thumb { background: #2d4a6a; border-radius: 3px; }
    .fade-in { animation: fadeIn .25s ease; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
    input[type=number]::-webkit-inner-spin-button,
    input[type=number]::-webkit-outer-spin-button { opacity: 1; }
    input, select { color-scheme: dark; }
    @media print {
      body { background: white !important; }
      .no-print { display: none !important; }
      .print-header { display: block !important; }
      table { border-collapse: collapse; width: 100%; }
      th { background: #1a3a5c !important; color: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      th, td { border: 1px solid #ccc !important; padding: 6px 10px !important; font-size: 11px !important; color: black !important; }
      tr:nth-child(even) td { background: #f5f5f5 !important; }
    }
    .print-header { display: none; }
  `}</style>
);

/* ── LÓGICA DE NEGOCIO ─────────────────────────────────────── */
const uid = () => Math.random().toString(36).slice(2, 9);
const hoy = () => new Date().toISOString().slice(0, 10);

const getCiclos  = (b) => (b <= 3 ? 1 : b <= 6 ? 2 : 3);
const isEspecial = (b) => b >= 0.5 && b <= 1;
// CAMBIO 1: cupo proporcional — 0.5bat→300, 1bat→600
const getCupoCiclo = (b) =>
  isEspecial(b) ? Math.round(b * 300 * 2) : Math.round((b * 300) / getCiclos(b));

const recalc = (arr) => arr.map((s, i) => ({ ...s, posicion: i + 1 }));

function isBoatFullyClosed(cierres, barcoId, barcos) {
  const activos = cierres.filter((x) => x.barcoId === barcoId && !x.fechaFin);
  if (activos.length === 0) return false;
  const b = barcos?.find((x) => x.id === barcoId);
  if (!b) return false;
  const totalCerradas = activos.reduce((s, c) => s + (c.bateasCerradas || 0), 0);
  return totalCerradas >= b.numBateas;
}

// Total de bateas cerradas (cierres activos) de un barco
function bateasCerradasActivas(cierres, barcoId) {
  return cierres
    .filter((c) => c.barcoId === barcoId && !c.fechaFin)
    .reduce((s, c) => s + (c.bateasCerradas || 0), 0);
}

// Suma de todos los acumulados pendientes de un barco (cierres reabiertos)
function acumuladoPendiente(barcoId, cierres) {
  return cierres
    .filter((c) => c.barcoId === barcoId && c.fechaFin && c.cupoAcumulado > c.cupoConsumido)
    .reduce((s, c) => s + (c.cupoAcumulado - c.cupoConsumido), 0);
}

// Cupo NORMAL del slot, reducido si hay cierre parcial activo
function cupoNormalSlot(slot, cierres, barcos) {
  const base = Math.max(0, slot.cupoCiclo + slot.ajusteBolsas);
  const cerradas = bateasCerradasActivas(cierres, slot.barcoId);
  if (cerradas > 0 && barcos) {
    const b = barcos.find((x) => x.id === slot.barcoId);
    if (b) {
      const open = Math.max(0, b.numBateas - cerradas);
      if (open <= 0) return 0;
      return Math.max(0, Math.round((open / b.numBateas) * base));
    }
  }
  return base;
}

// Cupo efectivo = cupo normal + acumulado pendiente (SUMA, opción A)
function getEfectivo(slot, cierres, barcos) {
  return cupoNormalSlot(slot, cierres, barcos) + acumuladoPendiente(slot.barcoId, cierres);
}

function getRestante(slot, cierres, barcos) {
  return getEfectivo(slot, cierres, barcos) - slot.bolsasEntregadas;
}

// Mueve un slot al final del bloque "cobrando" (no al principio)
function insertAlFinalDeCobrando(arr, slot) {
  const firstNonCob = arr.findIndex((s) => s.estado !== "cobrando");
  if (firstNonCob === -1) { arr.push(slot); }
  else { arr.splice(firstNonCob, 0, slot); }
}

function processAssignment(slots, barcos, cierres, slotId, bolsas) {
  let arr = slots.map((s) => ({ ...s }));
  let nc  = cierres.map((c) => ({ ...c }));
  const idx = arr.findIndex((s) => s.id === slotId);
  if (idx < 0) return { newSlots: arr, newCierres: nc };

  const slot  = arr[idx];
  const barco = barcos.find((b) => b.id === slot.barcoId);

  // Acumulado pendiente y cupo normal
  const acumTotal = acumuladoPendiente(slot.barcoId, nc);
  const normalEfectivo = cupoNormalSlot(slot, nc, barcos);
  const combinedEfectivo = normalEfectivo + acumTotal;

  const totalEntregado = slot.bolsasEntregadas + bolsas;
  const remCombined = combinedEfectivo - totalEntregado;

  // Consumir acumulado primero (cierres más antiguos primero)
  let restoBolsas = bolsas;
  const acumIdxs = nc
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.barcoId === slot.barcoId && c.fechaFin && c.cupoAcumulado > c.cupoConsumido)
    .sort((a, b) => (a.c.fechaInicio || "").localeCompare(b.c.fechaInicio || ""));
  // Pero el acumulado se consume DESPUÉS de la parte normal ya entregada en ciclos anteriores;
  // en la práctica: consumimos del acumulado lo que exceda el cupo normal ya servido.
  // Para simplificar y ser consistente: el acumulado se consume primero en este reparto.
  for (const { i } of acumIdxs) {
    if (restoBolsas <= 0) break;
    const rem = nc[i].cupoAcumulado - nc[i].cupoConsumido;
    const consume = Math.min(rem, restoBolsas);
    nc[i] = { ...nc[i], cupoConsumido: nc[i].cupoConsumido + consume };
    restoBolsas -= consume;
  }

  /* Caso: queda cupo combinado ≥ 200 → sigue cobrando */
  if (remCombined >= 200) {
    arr[idx] = { ...slot, bolsasEntregadas: totalEntregado, estado: "cobrando" };
    const [s] = arr.splice(idx, 1);
    insertAlFinalDeCobrando(arr, s);
    return { newSlots: recalc(arr), newCierres: nc };
  }

  /* Rota al final. El ajuste al siguiente ciclo solo afecta al cupo NORMAL. */
  const normalConsumido = Math.max(0, totalEntregado - acumTotal);
  const normalRem = normalEfectivo - normalConsumido; // + remanente / - exceso
  const ajuste = normalRem;
  const sib = arr.filter((s) => s.barcoId === slot.barcoId && s.id !== slotId)
                 .sort((a, b) => a.posicion - b.posicion)[0];
  if (sib && ajuste !== 0)
    arr = arr.map((s) => s.id === sib.id ? { ...s, ajusteBolsas: s.ajusteBolsas + ajuste } : s);
  const nextEstado = barco && isEspecial(barco.numBateas) ? "saltando_turno" : "en_espera";
  const selfAjuste = !sib && ajuste !== 0 ? ajuste : 0;
  arr = arr.map((s) =>
    s.id === slotId ? { ...s, bolsasEntregadas: 0, ajusteBolsas: selfAjuste, estado: nextEstado } : s
  );
  const removed = arr.splice(arr.findIndex((s) => s.id === slotId), 1)[0];
  arr.push(removed);
  return { newSlots: recalc(arr), newCierres: nc };
}

function makeSlotsForBarco(barco, startPos) {
  const n = getCiclos(barco.numBateas);
  const cupo = getCupoCiclo(barco.numBateas);
  return Array.from({ length: n }, (_, i) => ({
    id: uid(), barcoId: barco.id, numeroCiclo: i + 1,
    cupoCiclo: cupo, bolsasEntregadas: 0, ajusteBolsas: 0,
    posicion: startPos + i, estado: "en_espera",
  }));
}

/* ── CÁLCULO AUTOMÁTICO DE CUPO ACUMULADO ─────────────────── */
// Fórmula: (Σ bolsas servidas DESDE apertura del cierre ÷ bateas abiertas) × bateas cerradas
function calcularCupoAcumulado(cierre, fechaFin, cierres, barcos, historial) {
  if (!cierre || !fechaFin) return { totalBolsas: 0, bateasAbiertas: 0, ratePorBatea: 0, cupo: 0 };

  const cierreTs = cierre.createdTs || 0;
  const finTs    = new Date(fechaFin + "T23:59:59").getTime();

  // Solo pedidos confirmados DESPUÉS de abrir el cierre y ANTES de cerrarlo
  const totalBolsas = historial
    .filter((p) => (p.ts || 0) > cierreTs && (p.ts || 0) <= finTs)
    .reduce((sum, p) => sum + p.lineas.reduce((s, l) => s + l.bolsas, 0), 0);

  const totalBateas = barcos.filter((b) => b.activo).reduce((sum, b) => sum + b.numBateas, 0);

  const totalCerradas = cierres.reduce((sum, c) => {
    const cFinTs  = c.fechaFin ? new Date(c.fechaFin + "T23:59:59").getTime() : finTs;
    const solapa  = (c.createdTs || 0) <= finTs && cFinTs >= cierreTs;
    return solapa ? sum + (c.bateasCerradas || 0) : sum;
  }, 0);

  const bateasAbiertas = Math.max(0.5, totalBateas - totalCerradas);
  const ratePorBatea   = totalBolsas > 0 ? totalBolsas / bateasAbiertas : 0;
  // CORRECCIÓN: multiplicar por las bateas que tenía cerradas este barco
  const cupo = Math.round(ratePorBatea * (cierre.bateasCerradas || 1));
  return { totalBolsas, bateasAbiertas, ratePorBatea: Math.round(ratePorBatea), cupo };
}

/* ── DATOS DEMO ────────────────────────────────────────────── */
const DEMO_BARCOS = [
  { id: "b1", nombre: "Nuevo Horizonte", numBateas: 2,   activo: true, pin: "1111" },
  { id: "b2", nombre: "Mar de Arousa", numBateas: 4,   activo: true, pin: "2222" },
  { id: "b3", nombre: "Santa María", numBateas: 1,   activo: true, pin: "3333" },
  { id: "b4", nombre: "Virgen del Carmen", numBateas: 7,   activo: true, pin: "4444" },
  { id: "b5", nombre: "San José", numBateas: 5.5, activo: true, pin: "5555" },
  { id: "b6", nombre: "Rosalía de Castro", numBateas: 0.5, activo: true, pin: "6666" },
  { id: "b7", nombre: "A Moureira", numBateas: 3,   activo: true, pin: "7777" },
];
function initSlots(barcos) {
  let pos = 1;
  return barcos.flatMap((b) => {
    const s = makeSlotsForBarco(b, pos); pos += s.length; return s;
  });
}

/* ── DESIGN TOKENS ─────────────────────────────────────────── */
const C = {
  bg: "#0f1923", surface: "#111e2b", border: "#1e3348", border2: "#2d4a6a",
  navy: "#1a2f45", accent: "#f59e0b", accentL: "#fbbf24",
  blue: "#3b82f6", green: "#10b981", red: "#ef4444", violet: "#8b5cf6",
  orange: "#f97316", text: "#e2eaf4", textMid: "#7a99b8", textDim: "#4a6882",
};

/* ── COMPONENTES BASE ──────────────────────────────────────── */
const ESTADO_CFG = {
  en_espera:      { bg: "#1a2f45", text: "#7a99b8", dot: "#3b82f6", label: "En espera" },
  cobrando:       { bg: "#2d1f00", text: "#f59e0b", dot: "#f59e0b", label: "⚡ Cobrando" },
  saltando_turno: { bg: "#1e1040", text: "#8b5cf6", dot: "#8b5cf6", label: "⏭ Salta turno" },
  excluido:       { bg: "#1e1040", text: "#8b5cf6", dot: "#8b5cf6", label: "🚫 Sin producto" },
};
function Badge({ estado }) {
  const c = ESTADO_CFG[estado] || ESTADO_CFG.en_espera;
  return (
    <span style={{ background: c.bg, color: c.text, padding: "2px 10px", borderRadius: 20,
      fontSize: 11, fontWeight: 600, letterSpacing: "0.04em",
      display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${c.dot}30` }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, display: "inline-block" }} />
      {c.label}
    </span>
  );
}
function Bar({ value, max, color = C.blue }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, background: C.border, borderRadius: 4, height: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width .4s ease" }} />
      </div>
      <span className="mono" style={{ fontSize: 11, color: C.textMid, whiteSpace: "nowrap" }}>{value}/{max}</span>
    </div>
  );
}
function Btn({ children, onClick, color = C.blue, outline = false, small = false, disabled = false, style = {} }) {
  return (
    <button onClick={disabled ? undefined : onClick} style={{
      background: outline ? "transparent" : disabled ? "#1e3348" : color,
      color: disabled ? C.textDim : outline ? C.textMid : "#fff",
      border: outline ? `1px solid ${C.border2}` : disabled ? `1px solid ${C.border}` : "none",
      padding: small ? "5px 12px" : "8px 18px", borderRadius: 8,
      fontSize: small ? 12 : 13, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: "'Barlow', sans-serif", opacity: disabled ? 0.5 : 1, ...style,
    }}>{children}</button>
  );
}
function Input({ value, onChange, type = "text", placeholder, style = {}, ...rest }) {
  return (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder}
      style={{ background: C.navy, border: `1px solid ${C.border2}`, color: C.text,
        padding: "8px 12px", borderRadius: 8, fontSize: 13,
        fontFamily: "'Barlow', sans-serif", outline: "none", width: "100%", ...style }}
      {...rest} />
  );
}
function Sel({ value, onChange, children, style = {} }) {
  return (
    <select value={value} onChange={onChange}
      style={{ background: C.navy, border: `1px solid ${C.border2}`, color: C.text,
        padding: "8px 12px", borderRadius: 8, fontSize: 13,
        fontFamily: "'Barlow', sans-serif", outline: "none", width: "100%", ...style }}>
      {children}
    </select>
  );
}
function Card({ children, style = {} }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, ...style }}>
      {children}
    </div>
  );
}
function SectionTitle({ children }) {
  return (
    <div className="cond" style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: "0.02em", marginBottom: 16 }}>
      {children}
    </div>
  );
}
function Label({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
      {children}
    </div>
  );
}
function DataTable({ cols, rows, empty = "Sin datos" }) {
  return (
    <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}` }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 500 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={{ background: "#0a1520", color: C.textDim, padding: "10px 14px",
                textAlign: c.right ? "right" : c.center ? "center" : "left",
                fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                fontFamily: "'Barlow Condensed', sans-serif", borderBottom: `1px solid ${C.border}` }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length} style={{ padding: 40, textAlign: "center", color: C.textDim, fontSize: 13 }}>{empty}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={row._key ?? i} style={{ background: i % 2 === 0 ? C.surface : C.bg, borderBottom: `1px solid ${C.border}` }}>
              {cols.map((c) => (
                <td key={c.key} style={{ padding: "10px 14px", textAlign: c.right ? "right" : c.center ? "center" : "left", fontSize: 13, color: C.text }}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── PANTALLA DE LOGIN ─────────────────────────────────────── */
function LoginScreen({ barcos, onLoginOficinista, onLoginPatron }) {
  const [modo,   setModo]   = useState(null); // null | 'oficinista' | 'patron'
  const [pass,   setPass]   = useState("");
  const [barcoId,setBarcoId]= useState("");
  const [pin,    setPin]    = useState("");
  const [error,  setError]  = useState("");
  const [cargando, setCargando] = useState(false);

  const loginOficinista = async () => {
    if (cargando) return;
    setCargando(true); setError("");
    try {
      const ok = await validarOficinista(pass);
      if (ok) { onLoginOficinista(); }
      else setError("Contraseña incorrecta");
    } catch (_) {
      setError("Sin conexión con el servidor. Revisa tu internet.");
    } finally {
      setCargando(false);
    }
  };
  const loginPatron = () => {
    const b = barcos.find((x) => x.id === barcoId);
    if (!b) { setError("Selecciona un barco"); return; }
    if (pin === b.pin) { setError(""); onLoginPatron(barcoId); }
    else setError("PIN incorrecto");
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <div style={{ marginBottom: 12 }}>
          <svg width="64" height="64" viewBox="0 0 48 48">
            <rect x="8" y="14" width="32" height="5" rx="1.5" fill="#f59e0b"/>
            <line x1="13" y1="19" x2="13" y2="40" stroke="#3b82f6" strokeWidth="1.6"/>
            <line x1="19" y1="19" x2="19" y2="44" stroke="#3b82f6" strokeWidth="1.6"/>
            <line x1="24" y1="19" x2="24" y2="42" stroke="#3b82f6" strokeWidth="1.6"/>
            <line x1="29" y1="19" x2="29" y2="44" stroke="#3b82f6" strokeWidth="1.6"/>
            <line x1="35" y1="19" x2="35" y2="40" stroke="#3b82f6" strokeWidth="1.6"/>
            <path d="M4 44 Q12 40 20 44 T36 44 T52 44" fill="none" stroke="#7a99b8" strokeWidth="1.5" opacity="0.6"/>
          </svg>
        </div>
        <div className="cond" style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: "0.02em" }}>Sistema de Reparto</div>
        <div style={{ fontSize: 12, color: C.textDim, letterSpacing: "0.1em", marginTop: 4 }}>ASOCIACIÓN DE PRODUCTORES DE MEJILLÓN</div>
      </div>

      {!modo && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
          {[
            { id: "oficinista", label: "Oficinista", icon: "🗂️", desc: "Gestión de pedidos, flota e informes" },
            { id: "patron",     label: "Socio / Patrón", icon: "⚓", desc: "Consulta tu posición en lista" },
          ].map((m) => (
            <button key={m.id} onClick={() => { setModo(m.id); setError(""); setPass(""); setPin(""); }}
              style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 16, padding: "28px 36px",
                cursor: "pointer", textAlign: "center", width: 220, transition: "border-color .15s" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>{m.icon}</div>
              <div className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 6 }}>{m.label}</div>
              <div style={{ fontSize: 12, color: C.textDim }}>{m.desc}</div>
            </button>
          ))}
        </div>
      )}

      {modo === "oficinista" && (
        <Card style={{ width: "100%", maxWidth: 360 }}>
          <div className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 16 }}>🗂️ Acceso Oficinista</div>
          {error && <div style={{ fontSize: 12, color: C.red, background: "#1f0808", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>{error}</div>}
          <Label>Contraseña</Label>
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)}
            placeholder="••••••" style={{ marginBottom: 16 }}
            onKeyDown={(e) => e.key === "Enter" && loginOficinista()} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={loginOficinista} color={C.blue} disabled={cargando} style={{ flex: 1 }}>{cargando ? "Comprobando…" : "Entrar"}</Btn>
            <Btn outline onClick={() => { setModo(null); setError(""); }}>Volver</Btn>
          </div>
        </Card>
      )}

      {modo === "patron" && (
        <Card style={{ width: "100%", maxWidth: 360 }}>
          <div className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 16 }}>⚓ Acceso Socio / Patrón</div>
          {error && <div style={{ fontSize: 12, color: C.red, background: "#1f0808", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>{error}</div>}
          <Label>Tu barco</Label>
          <Sel value={barcoId} onChange={(e) => setBarcoId(e.target.value)} style={{ marginBottom: 12 }}>
            <option value="">Seleccionar barco...</option>
            {barcos.filter((b) => b.activo).map((b) => (
              <option key={b.id} value={b.id}>{b.nombre}</option>
            ))}
          </Sel>
          <Label>PIN (4 dígitos)</Label>
          <Input type="password" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value)}
            placeholder="••••" style={{ marginBottom: 16 }}
            onKeyDown={(e) => e.key === "Enter" && loginPatron()} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={loginPatron} color={C.accent} style={{ flex: 1, color: "#000" }}>Entrar</Btn>
            <Btn outline onClick={() => { setModo(null); setError(""); }}>Volver</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ── HTML COMPARTIDO PARA IMPRIMIR / IMAGEN ────────────────── */
function buildFilasLista(slots, barcos, cierres, excluidoSet, faltanInfo) {
  const acumIds = new Set(cierres.filter((c) => c.fechaFin && c.cupoAcumulado > c.cupoConsumido).map((c) => c.barcoId));
  return slots.map((s, i) => {
    const b  = barcos.find((x) => x.id === s.barcoId);
    const activeCierre = cierres.find((c) => c.barcoId === s.barcoId && !c.fechaFin);
    const isFull    = activeCierre && b && (activeCierre.bateasCerradas || 0) >= b.numBateas;
    const isPartial = activeCierre && !isFull;
    const excluido  = excluidoSet?.has(s.barcoId);
    const faltan    = faltanInfo?.[s.id] || { reales: 0, posibles: 0 };
    const flags = [
      isFull    ? "CIERRE TOTAL" : "",
      isPartial ? `PARCIAL ${activeCierre.bateasCerradas}/${b?.numBateas}` : "",
      acumIds.has(s.barcoId) ? "ACUMULADO" : "",
      excluido  ? "SIN PRODUCTO" : "",
    ].filter(Boolean).join(" · ");
    const faltanTxt = faltan.posibles !== faltan.reales
      ? `${faltan.reales.toLocaleString()} <small style="color:#888">(${faltan.posibles.toLocaleString()} pos.)</small>`
      : faltan.reales.toLocaleString();
    const bg = excluido ? "background:#efe9f7" : i % 2 === 1 ? "background:#f5f5f5" : "";
    return `
      <tr style="${bg}">
        <td style="text-align:center;font-weight:700;font-size:15px">${s.posicion}</td>
        <td><strong>${b?.nombre ?? "—"}</strong>${flags ? `<br><small style="color:#a05a00">${flags}</small>` : ""}</td>
                <td style="text-align:center">${b?.numBateas ?? ""}</td>
        <td style="text-align:right;font-weight:700">${faltanTxt}</td>
      </tr>`;
  }).join("");
}

function buildListaHTML(slots, barcos, cierres, excluidoSet, faltanInfo, calidadNombre, forImage) {
  const filas = buildFilasLista(slots, barcos, cierres, excluidoSet, faltanInfo);
  const titulo = `Lista de Reparto${calidadNombre ? ` — ${calidadNombre}` : ""}`;
  return `<!DOCTYPE html><html lang="es"><head>
    <meta charset="UTF-8">
    <title>${titulo} — ${hoy()}</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 13px; color: #000; margin: ${forImage ? "0" : "20px"}; ${forImage ? "width:680px;padding:24px;background:#fff;" : ""} }
      h1 { font-size: 18px; margin-bottom: 2px; color:#1a3a5c; }
      p  { font-size: 12px; color: #555; margin: 0 0 16px; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #1a3a5c; color: #fff; padding: 8px 10px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
      th.r { text-align:right; } th.c { text-align:center; }
      td { padding: 8px 10px; border-bottom: 1px solid #ddd; vertical-align: middle; }
      .leyenda { font-size: 10px; color:#777; margin-top:12px; }
    </style>
  </head><body id="cap">
    <h1>${titulo}</h1>
    <p>Asociación de Productores de Mejillón &nbsp;·&nbsp; ${hoy()} &nbsp;·&nbsp; ${slots.length} posiciones</p>
    <table>
      <thead><tr>
        <th class="c">#</th><th>Barco</th><th>Matrícula</th><th class="c">Bateas</th><th class="r">Bolsas para su turno</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="leyenda">Bolsas para su turno = suma de bolsas que tienen que salir de los barcos por delante. La cifra cuenta barcos activos; (pos.) incluye los marcados sin producto por si se reactivan.</div>
  </body></html>`;
}

function imprimirLista(slots, barcos, cierres, excluidoSet, faltanInfo, calidadNombre) {
  const html = buildListaHTML(slots, barcos, cierres, excluidoSet, faltanInfo, calidadNombre, false)
    .replace("</body>", "<script>window.onload=()=>window.print();<\/script></body>");
  const win = window.open("", "_blank", "width=900,height=700");
  if (win) { win.document.write(html); win.document.close(); }
  else alert("El navegador bloqueó la ventana emergente. Permite las ventanas emergentes para este sitio.");
}

async function descargarImagen(slots, barcos, cierres, excluidoSet, faltanInfo, calidadNombre) {
  // Carga html2canvas desde CDN si no está
  if (!window.html2canvas) {
    await new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
      sc.onload = res; sc.onerror = rej;
      document.head.appendChild(sc);
    });
  }
  const html = buildListaHTML(slots, barcos, cierres, excluidoSet, faltanInfo, calidadNombre, true);
  const cont = document.createElement("div");
  cont.style.cssText = "position:fixed;left:-9999px;top:0;";
  cont.innerHTML = html.replace(/<!DOCTYPE[\s\S]*?<body id="cap">/, '<div id="cap" style="width:680px;padding:24px;background:#fff;font-family:Arial,sans-serif;font-size:13px;color:#000">').replace("</body></html>", "</div>");
  // Re-inserta estilos inline para que html2canvas los respete
  document.body.appendChild(cont);
  try {
    const node = cont.querySelector("#cap");
    const canvas = await window.html2canvas(node, { scale: 2, backgroundColor: "#fff" });
    const link = document.createElement("a");
    link.download = `lista_reparto_${calidadNombre || ""}_${hoy()}.png`.replace(/\s+/g, "_");
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (e) {
    alert("No se pudo generar la imagen. Usa el botón Imprimir y guarda como PDF.");
  } finally {
    document.body.removeChild(cont);
  }
}


/* ── TAB LISTA ─────────────────────────────────────────────── */
function TabLista({ slots, barcos, cierres, calidadNombre, setSlots, exclusiones, calidadActiva }) {
  const acumIds = useMemo(
    () => new Set(cierres.filter((c) => c.fechaFin && c.cupoAcumulado > c.cupoConsumido).map((c) => c.barcoId)),
    [cierres]
  );
  const excluidoSet = useMemo(
    () => new Set((exclusiones || []).filter((e) => e.calidadId === calidadActiva && !e.fechaFin).map((e) => e.barcoId)),
    [exclusiones, calidadActiva]
  );

  // Precalcula, para cada slot, las bolsas acumuladas de los que van por delante
  // - reales: solo barcos activos (no excluidos, no cerrados totales)
  // - posibles: incluye también los autoexcluidos (por si se reactivan)
  const faltanInfo = useMemo(() => {
    const info = {};
    let accReales = 0, accPosibles = 0;
    slots.forEach((slot) => {
      info[slot.id] = { reales: accReales, posibles: accPosibles };
      const isFull   = isBoatFullyClosed(cierres, slot.barcoId, barcos);
      const excl     = excluidoSet.has(slot.barcoId);
      const salta    = slot.estado === "saltando_turno";
      const disp     = Math.max(0, getRestante(slot, cierres, barcos));
      if (!isFull && !salta) {
        accPosibles += disp;                    // posibles incluye excluidos
        if (!excl) accReales += disp;           // reales excluye excluidos
      }
    });
    return info;
  }, [slots, cierres, barcos, excluidoSet]);

  const rows = slots.map((slot) => {
    const b = barcos.find((x) => x.id === slot.barcoId);
    const activeCierre = cierres.find((c) => c.barcoId === slot.barcoId && !c.fechaFin);
    const isFull    = activeCierre && b && (activeCierre.bateasCerradas || 0) >= b.numBateas;
    const isPartial = activeCierre && !isFull;
    const hasAcum   = acumIds.has(slot.barcoId);
    const excluido  = excluidoSet.has(slot.barcoId);
    const ef        = getEfectivo(slot, cierres, barcos);
    const bloqueado = ef <= 0 && !hasAcum && !isFull && !excluido && slot.estado !== "saltando_turno";
    const faltan    = faltanInfo[slot.id] || { reales: 0, posibles: 0 };

    const rescue = bloqueado && setSlots ? () => {
      setSlots((ss) => {
        const arr = ss.map((s) =>
          s.id === slot.id
            ? { ...s, bolsasEntregadas: 0, ajusteBolsas: Math.max(0, s.ajusteBolsas), estado: "en_espera" }
            : s
        );
        const sin = arr.filter((s) => s.id !== slot.id);
        const este = arr.find((s) => s.id === slot.id);
        return recalc([...sin, este]);
      });
    } : null;

    return {
      _key: slot.id,
      pos: <span className="mono cond" style={{ fontSize: 18, fontWeight: 800, color: bloqueado ? C.red : excluido ? C.textDim : C.accentL }}>{slot.posicion}</span>,
      barco: (
        <div>
          <div style={{ fontWeight: 600, color: excluido ? C.textMid : C.text }}>{b?.nombre}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
            {isFull    && <span style={{ fontSize: 10, color: C.red,    fontWeight: 700 }}>🔒 CIERRE TOTAL</span>}
            {isPartial && <span style={{ fontSize: 10, color: C.orange, fontWeight: 700 }}>🔒 PARCIAL ({activeCierre.bateasCerradas}/{b?.numBateas} bat.)</span>}
            {hasAcum   && <span style={{ fontSize: 10, color: C.accent, fontWeight: 700 }}>★ ACUMULADO</span>}
            {excluido  && <span style={{ fontSize: 10, color: C.violet, fontWeight: 700 }}>🚫 SIN PRODUCTO</span>}
            {bloqueado && (
              <span style={{ fontSize: 10, color: C.red, fontWeight: 700 }}>
                ⚠ BLOQUEADO{" "}
                {rescue && <button onClick={rescue} style={{ background: C.red, color: "#fff", border: "none", borderRadius: 4, fontSize: 9, padding: "1px 6px", cursor: "pointer", fontWeight: 700 }}>DESBLOQUEAR</button>}
              </span>
            )}
          </div>
        </div>
      ),
      bateas:    <span className="mono" style={{ color: C.textMid }}>{b?.numBateas}</span>,
      faltan: (
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: excluido ? C.textDim : C.text }}>
            {faltan.reales.toLocaleString()}
          </div>
          {faltan.posibles !== faltan.reales && (
            <div className="mono" style={{ fontSize: 10, color: C.violet }}>
              ({faltan.posibles.toLocaleString()} posibles)
            </div>
          )}
        </div>
      ),
      cupo: (
        <div style={{ minWidth: 140 }}>
          <Bar value={slot.bolsasEntregadas} max={Math.max(ef, slot.bolsasEntregadas)}
            color={bloqueado ? C.red : isFull ? C.red : isPartial ? C.orange : excluido ? C.violet : slot.estado === "cobrando" ? C.accent : C.blue} />
          {slot.ajusteBolsas !== 0 && (
            <div className="mono" style={{ fontSize: 10, marginTop: 3, color: slot.ajusteBolsas > 0 ? C.green : C.red }}>
              {slot.ajusteBolsas > 0 ? "+" : ""}{slot.ajusteBolsas} ajuste
            </div>
          )}
        </div>
      ),
      estado: excluido ? <Badge estado="excluido" /> : <Badge estado={slot.estado} />,
    };
  });

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <SectionTitle>📋 Lista de Reparto{calidadNombre ? ` — ${calidadNombre}` : ""}</SectionTitle>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="mono no-print" style={{ fontSize: 12, color: C.textDim, background: C.navy, padding: "4px 12px", borderRadius: 20, border: `1px solid ${C.border}` }}>
            {slots.length} posiciones
          </span>
          <Btn small onClick={() => imprimirLista(slots, barcos, cierres, excluidoSet, faltanInfo, calidadNombre)} color={C.navy} outline className="no-print">
            🖨️ Imprimir
          </Btn>
          <Btn small onClick={() => descargarImagen(slots, barcos, cierres, excluidoSet, faltanInfo, calidadNombre)} color={C.green} className="no-print">
            📷 Descargar imagen
          </Btn>
        </div>
      </div>
      <DataTable
        cols={[
          { key: "pos",       label: "#",          center: true },
          { key: "barco",     label: "Barco" },
          { key: "bateas",    label: "Bateas",      center: true },
          { key: "faltan",    label: "Bolsas para su turno", right: true },
          { key: "cupo",      label: "Progreso cupo" },
          { key: "estado",    label: "Estado" },
        ]}
        rows={rows}
        empty="Sin barcos en lista"
      />
      <div style={{ fontSize: 11, color: C.textDim, marginTop: 10, lineHeight: 1.5 }}>
        <strong style={{ color: C.textMid }}>Bolsas para su turno:</strong> suma de bolsas que tienen que salir de los barcos por delante antes de que le toque.
        La cifra principal cuenta solo barcos activos; <span style={{ color: C.violet }}>(posibles)</span> incluye los marcados sin producto por si se reactivan.
      </div>
    </div>
  );
}

/* ── TAB PEDIDO ────────────────────────────────────────────── */
function TabPedido({ slots, barcos, cierres, setCierres, setSlots, setHistorial, pedidoActivo, setPedidoActivo,
                     exclusiones, setExclusiones, rechazos, setRechazos, calidadActiva, snapshot }) {
  const [fecha, setFecha] = useState(hoy());
  const [desc,  setDesc]  = useState("");

  const excluidoSet = useMemo(
    () => new Set(exclusiones.filter((e) => e.calidadId === calidadActiva && !e.fechaFin).map((e) => e.barcoId)),
    [exclusiones, calidadActiva]
  );

  const candidatosBase = useMemo(() =>
    slots
      .filter((s) =>
        s.estado !== "saltando_turno" &&
        !isBoatFullyClosed(cierres, s.barcoId, barcos) &&
        !excluidoSet.has(s.barcoId) &&
        barcos.find((b) => b.id === s.barcoId)?.activo
      )
      .map((s) => {
        const b = barcos.find((x) => x.id === s.barcoId);
        const cupoDisp  = getRestante(s, cierres, barcos);
        const acumPend  = acumuladoPendiente(s.barcoId, cierres);
        const hasAcum   = acumPend > 0;
        const cerradas  = bateasCerradasActivas(cierres, s.barcoId);
        return { slot: s, barco: b, cupoDisp, hasAcum, acumPend, isPartial: cerradas > 0, bateasCerradas: cerradas };
      })
      .filter((c) => c.cupoDisp > 0),
    [slots, cierres, barcos, excluidoSet]
  );

  const iniciar = () => {
    let cur = [...slots]; let changed = false;
    // Avanza barcos saltando_turno al frente
    while (cur.length > 0 && cur[0].estado === "saltando_turno") {
      const [s, ...rest] = cur;
      cur = recalc([...rest, { ...s, estado: "en_espera", bolsasEntregadas: 0, ajusteBolsas: 0 }]);
      changed = true;
    }
    // FIX: avanza barcos bloqueados (cupo ≤ 0, sin acumulado, no cobrando) al final
    let safety = 0;
    while (cur.length > 0 && safety < 20) {
      const front = cur[0];
      const restante = getRestante(front, cierres, barcos);
      const acum     = acumuladoPendiente(front.barcoId, cierres);
      const esCerradoTotal = isBoatFullyClosed(cierres, front.barcoId, barcos);
      if (restante <= 0 && acum <= 0 && front.estado !== "cobrando" && !esCerradoTotal) {
        const [s, ...rest] = cur;
        // Perdona deuda y rota al final
        cur = recalc([...rest, { ...s, bolsasEntregadas: 0, ajusteBolsas: Math.max(0, s.ajusteBolsas), estado: "en_espera" }]);
        changed = true;
        safety++;
      } else break;
    }
    if (changed) setSlots(cur);
    setPedidoActivo({
      fecha, desc,
      asigs: candidatosBase.map((c) => ({
        slotId: c.slot.id, barcoId: c.barco?.id, barcoNombre: c.barco?.nombre,
        posicion: c.slot.posicion, cupoDisp: c.cupoDisp, bolsas: String(c.cupoDisp),
        resultado: "pendiente", hasAcum: c.hasAcum, acumPend: c.acumPend, isPartial: c.isPartial,
        bateasCerradas: c.bateasCerradas, numBateas: c.barco?.numBateas,
      })),
    });
  };

  const upd = (slotId, field, val) =>
    setPedidoActivo((p) => ({ ...p, asigs: p.asigs.map((a) => (a.slotId === slotId ? { ...a, [field]: val } : a)) }));

  const confirmar = () => {
    if (!pedidoActivo) return;
    snapshot && snapshot(`Confirmar pedido — ${pedidoActivo.fecha}`);
    let ns = [...slots]; let nc = [...cierres];
    let nuevosRechazos = { ...rechazos };
    const lineas = [];

    // Guardar qué slots estaban cobrando ANTES de procesar este pedido
    const cobrandoAntes = new Set(slots.filter((s) => s.estado === "cobrando").map((s) => s.id));

    pedidoActivo.asigs.forEach((asig) => {
      const key = `${calidadActiva}:${asig.barcoId}`;
      if (asig.resultado === "aceptado") {
        const b = parseInt(asig.bolsas) || 0;
        if (b > 0) {
          lineas.push({ barcoNombre: asig.barcoNombre, bolsas: b });
          const r = processAssignment(ns, barcos, nc, asig.slotId, b);
          ns = r.newSlots; nc = r.newCierres;
          nuevosRechazos[key] = 0;
        }
      } else if (asig.resultado === "rechazado") {
        const acumPend = acumuladoPendiente(asig.barcoId, nc);
        if (acumPend > 0) {
          const cuenta = (nuevosRechazos[key] || 0) + 1;
          if (cuenta >= 3) {
            nc = nc.map((c) =>
              c.barcoId === asig.barcoId && c.fechaFin && c.cupoAcumulado > c.cupoConsumido
                ? { ...c, cupoConsumido: c.cupoAcumulado, acumuladoBorradoPorRechazo: true }
                : c
            );
            nuevosRechazos[key] = 0;
            ns = ns.map((s) => {
              if (s.barcoId !== asig.barcoId) return s;
              const cupoNorm = Math.max(0, s.cupoCiclo + s.ajusteBolsas);
              const queda    = cupoNorm - s.bolsasEntregadas;
              if (queda <= 0 || s.estado === "cobrando") {
                return { ...s, bolsasEntregadas: 0, ajusteBolsas: Math.max(0, s.ajusteBolsas), estado: "en_espera" };
              }
              return s;
            });
            const afectados   = ns.filter((s) => s.barcoId === asig.barcoId && s.estado === "en_espera" && s.bolsasEntregadas === 0);
            const noAfectados = ns.filter((s) => !(s.barcoId === asig.barcoId && afectados.find((a) => a.id === s.id)));
            ns = recalc([...noAfectados, ...afectados]);
          } else {
            nuevosRechazos[key] = cuenta;
          }
        }
      }
    });

    // ── POST-PROCESO: si hay barcos que acaban de servir y siguen cobrando,
    // mover al final del bloque cobrando los que rechazaron estando cobrando.
    // Así el que sirvió queda siempre por delante del que rechazó.
    const recienCobrando = new Set(
      pedidoActivo.asigs
        .filter((a) => a.resultado === "aceptado")
        .map((a) => a.slotId)
        .filter((id) => ns.find((s) => s.id === id)?.estado === "cobrando")
    );

    if (recienCobrando.size > 0) {
      const rechazadosCobrando = pedidoActivo.asigs.filter(
        (a) => a.resultado === "rechazado" && cobrandoAntes.has(a.slotId) &&
               ns.find((s) => s.id === a.slotId)?.estado === "cobrando"
      );
      rechazadosCobrando.forEach((asig) => {
        const idx = ns.findIndex((s) => s.id === asig.slotId);
        if (idx < 0) return;
        const [slot] = ns.splice(idx, 1);
        insertAlFinalDeCobrando(ns, slot);
      });
      if (rechazadosCobrando.length > 0) ns = recalc(ns);
    }

    setSlots(ns); setCierres(nc); setRechazos(nuevosRechazos);
    setHistorial((h) => [{ id: uid(), fecha: pedidoActivo.fecha, desc: pedidoActivo.desc, lineas, ts: Date.now() }, ...h]);
    setPedidoActivo(null);
  };

  if (!pedidoActivo) {
    return (
      <div className="fade-in" style={{ maxWidth: 420 }}>
        <SectionTitle>📦 Nuevo Pedido</SectionTitle>
        <Card>
          <Label>Fecha del pedido</Label>
          <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ marginBottom: 14 }} />
          <Label>Descripción <span style={{ color: C.textDim, fontWeight: 400 }}>(opcional)</span></Label>
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="ej. Mercadona · 2 toneladas" style={{ marginBottom: 20 }} />
          <Btn onClick={iniciar} disabled={!candidatosBase.length} color={C.accent} style={{ width: "100%", color: "#000" }}>
            Ver candidatos ({candidatosBase.length})
          </Btn>
          {excluidoSet.size > 0 && (
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 10, textAlign: "center" }}>
              {excluidoSet.size} barco(s) excluido(s) de esta calidad
            </div>
          )}
        </Card>
      </div>
    );
  }

  const totalAcep = pedidoActivo.asigs.filter((a) => a.resultado === "aceptado").reduce((s, a) => s + (parseInt(a.bolsas) || 0), 0);

  return (
    <div className="fade-in">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <SectionTitle style={{ marginBottom: 4 }}>📦 Pedido — {pedidoActivo.fecha}</SectionTitle>
          {pedidoActivo.desc && <div style={{ fontSize: 13, color: C.textMid }}>{pedidoActivo.desc}</div>}
        </div>
        <div className="mono" style={{ background: "#1a2f45", border: `1px solid ${C.accent}40`, color: C.accent, padding: "6px 16px", borderRadius: 24, fontSize: 14, fontWeight: 700 }}>
          {totalAcep} bolsas asignadas
        </div>
      </div>
      <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}`, marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 540 }}>
          <thead>
            <tr>
              {["#", "Barco", "Cupo disp.", "Resultado", "Bolsas"].map((h, i) => (
                <th key={i} style={{ background: "#0a1520", color: C.textDim, padding: "10px 14px",
                  textAlign: i >= 2 ? "center" : "left", fontSize: 10, fontWeight: 700,
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  fontFamily: "'Barlow Condensed', sans-serif", borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pedidoActivo.asigs.map((asig, i) => {
              const rowBg = asig.resultado === "aceptado" ? "#0d2b1a" : asig.resultado === "rechazado" ? "#1f1010" : i % 2 === 0 ? C.surface : C.bg;
              return (
                <tr key={asig.slotId} style={{ background: rowBg, borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 14px" }}>
                    <span className="mono cond" style={{ fontSize: 16, fontWeight: 800, color: C.accentL }}>{asig.posicion}</span>
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    <div style={{ fontWeight: 600, color: C.text }}>{asig.barcoNombre}</div>
                    <div className="mono" style={{ fontSize: 11, color: C.textDim }}>
                      {asig.hasAcum   && <span style={{ marginLeft: 6, color: C.accent }}>★ acum.</span>}
                      {asig.isPartial && <span style={{ marginLeft: 6, color: C.orange }}>🔒 {asig.bateasCerradas}/{asig.numBateas} bat.</span>}
                    </div>
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "center" }}>
                    <span className="mono" style={{ fontWeight: 700, color: C.textMid }}>{asig.cupoDisp}</span>
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "center" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                      {[
                        { r: "aceptado",  label: "✓", col: C.green },
                        { r: "rechazado", label: "✗", col: C.red },
                        { r: "pendiente", label: "—", col: C.textDim },
                      ].map(({ r, label, col }) => (
                        <button key={r} onClick={() => upd(asig.slotId, "resultado", r)}
                          style={{ width: 32, height: 32, borderRadius: 8, border: "none",
                            background: asig.resultado === r ? col : C.navy,
                            color: asig.resultado === r ? "#fff" : C.textDim,
                            cursor: "pointer", fontSize: 14, fontWeight: 700 }}>{label}</button>
                      ))}
                    </div>
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "center" }}>
                    <input type="number" min="1" step="50" max={asig.cupoDisp} value={asig.bolsas}
                      disabled={asig.resultado !== "aceptado"}
                      onChange={(e) => upd(asig.slotId, "bolsas", e.target.value)}
                      className="mono"
                      style={{ width: 90, background: asig.resultado === "aceptado" ? C.navy : C.bg,
                        border: `1px solid ${asig.resultado === "aceptado" ? C.border2 : C.border}`,
                        color: asig.resultado === "aceptado" ? C.text : C.textDim,
                        padding: "6px 10px", borderRadius: 8, fontSize: 13, textAlign: "right", outline: "none",
                        fontFamily: "'DM Mono', monospace" }} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Btn outline onClick={() => setPedidoActivo(null)}>Cancelar</Btn>
        <Btn onClick={confirmar} color={C.green}>✓ Confirmar pedido</Btn>
      </div>
    </div>
  );
}

/* ── TAB FLOTA ─────────────────────────────────────────────── */
/* ── MODAL IMPORTAR LISTA (POR CALIDAD) ────────────────────── */
// La lista es propia de CADA calidad. Este modal descarga una plantilla
// Excel con el orden actual de ESTA calidad para editarla y volver a subirla,
// y al confirmar reordena únicamente la lista de la calidad activa.
function ModalImportarLista({ barcos, slots, setSlots, calidadNombre, snapshot, onClose }) {
  const [filas,    setFilas]    = useState(null);
  const [errores,  setErrores]  = useState([]);
  const [warnings, setWarnings] = useState([]);
  const inputRef = useRef(null);

  const norm = (s) => String(s ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const ALIAS_BARCO = ["barco", "embarcacion", "buque", "nombre"];
  const ALIAS_ORDEN = ["orden", "posicion", "pos", "n", "no", "numero", "#"];
  const nombreDe = (id) => barcos.find((b) => b.id === id)?.nombre ?? "";

  const procesar = (rows) => {
    const nombresBarcos = barcos.map((b) => norm(b.nombre));
    // Localizar cabecera con columna "Barco" (y opcional "Orden")
    let colBarco = 0, colOrden = -1, headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const celdas = (rows[i] || []).map(norm);
      const cb = celdas.findIndex((c) => ALIAS_BARCO.includes(c));
      if (cb >= 0) { headerIdx = i; colBarco = cb; colOrden = celdas.findIndex((c) => ALIAS_ORDEN.includes(c)); break; }
    }
    let dataRows;
    if (headerIdx >= 0) {
      dataRows = rows.slice(headerIdx + 1);
    } else {
      // Sin cabecera reconocible: nombres en la 1ª columna; saltar 1ª fila si no es un barco
      colBarco = 0;
      dataRows = rows;
      const first = norm(rows[0]?.[0] ?? "");
      if (rows.length && !nombresBarcos.includes(first)) dataRows = rows.slice(1);
    }
    // Registros {nombre, orden}
    let registros = dataRows
      .map((r) => ({
        nombre: String(r[colBarco] ?? "").trim(),
        orden: colOrden >= 0 ? parseInt(String(r[colOrden] ?? "").trim(), 10) : null,
      }))
      .filter((x) => x.nombre);
    // Si hay columna "Orden" válida en todas las filas, ordenar por ella
    if (colOrden >= 0 && registros.length && registros.every((x) => Number.isFinite(x.orden))) {
      registros = registros.map((r, i) => ({ r, i })).sort((a, b) => a.r.orden - b.r.orden || a.i - b.i).map((x) => x.r);
    }
    const nombres = registros.map((x) => x.nombre);
    const errs = [];
    const warns = [];
    nombres.forEach((n, i) => {
      if (!barcos.find((b) => norm(b.nombre) === norm(n))) {
        errs.push(`Fila ${i + 1}: "${n}" no coincide con ningún barco`);
      }
    });
    // Comprobar ciclos esperados por barco
    barcos.forEach((b) => {
      const expected = getCiclos(b.numBateas);
      const found = nombres.filter((n) => norm(n) === norm(b.nombre)).length;
      if (found !== expected) {
        warns.push(`${b.nombre}: esperados ${expected} ciclo(s), encontrados ${found}`);
      }
    });
    setErrores(errs);
    setWarnings(warns);
    setFilas(nombres);
  };

  const cargar = (file) => {
    const ext = file.name.split(".").pop().toLowerCase();
    const reader = new FileReader();
    reader.onload = (e) => {
      if (ext === "csv") {
        const rows = e.target.result.split("\n").map((l) => l.split(","));
        procesar(rows);
      } else {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        procesar(rows);
      }
    };
    if (ext === "csv") reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  };

  // Descarga una plantilla Excel con el orden ACTUAL de esta calidad.
  // Una fila por posición de la rueda (cada barco aparece tantas veces como ciclos tenga).
  const descargarPlantilla = () => {
    let nombresOrden;
    if (slots && slots.length) {
      nombresOrden = [...slots].sort((a, b) => a.posicion - b.posicion).map((s) => nombreDe(s.barcoId)).filter(Boolean);
    } else {
      nombresOrden = barcos.flatMap((b) => Array.from({ length: getCiclos(b.numBateas) }, () => b.nombre));
    }
    const aoa = [["Orden", "Barco"], ...nombresOrden.map((n, i) => [i + 1, n])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Lista");
    const safe = String(calidadNombre || "lista").replace(/\s+/g, "_");
    XLSX.writeFile(wb, `plantilla_lista_${safe}.xlsx`);
  };

  const confirmar = () => {
    if (!filas || errores.length > 0) return;
    snapshot && snapshot(`Importar lista — ${calidadNombre || ""}`);
    // Solo reordena la lista de la calidad activa
    setSlots((currentSlots) => {
      const ordenImport = filas.map((nombre) => {
        const b = barcos.find((x) => norm(x.nombre) === norm(nombre));
        return b ? b.id : null;
      }).filter(Boolean);

      const slotsPorBarco = {};
      barcos.forEach((b) => {
        slotsPorBarco[b.id] = currentSlots
          .filter((s) => s.barcoId === b.id)
          .sort((a, b2) => a.numeroCiclo - b2.numeroCiclo);
      });

      const cicloIdx = {};
      barcos.forEach((b) => { cicloIdx[b.id] = 0; });

      const ordenados = [];
      const usados = new Set();

      ordenImport.forEach((barcoId) => {
        const bSlots = slotsPorBarco[barcoId] || [];
        const idx = cicloIdx[barcoId] || 0;
        if (idx < bSlots.length) {
          ordenados.push({ ...bSlots[idx] });
          usados.add(bSlots[idx].id);
          cicloIdx[barcoId] = idx + 1;
        }
      });

      // Conservar al final cualquier slot no cubierto por la importación
      currentSlots.forEach((s) => {
        if (!usados.has(s.id)) ordenados.push({ ...s });
      });

      return recalc(ordenados);
    });
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <Card style={{ maxWidth: 480, width: "100%", boxShadow: "0 24px 64px #000a", maxHeight: "90vh", overflowY: "auto" }}>
        <div className="cond" style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 4 }}>📂 Importar lista{calidadNombre ? ` — ${calidadNombre}` : ""}</div>
        <div style={{ fontSize: 13, color: C.textMid, marginBottom: 6 }}>
          Solo afecta a la lista de la calidad <strong style={{ color: C.text }}>{calidadNombre || "activa"}</strong>. Cada calidad tiene su propia lista.
        </div>
        <div style={{ fontSize: 13, color: C.textMid, marginBottom: 16 }}>
          1) Descarga la plantilla (trae el orden actual). 2) Reordena las filas en Excel — un barco por fila, repetido tantas veces como ciclos tenga. 3) Vuelve a subirla. Acepta <span className="mono" style={{ color: C.text }}>.xlsx</span> y <span className="mono" style={{ color: C.text }}>.csv</span>.
        </div>
        <input ref={inputRef} type="file" accept=".xlsx,.csv" style={{ display: "none" }}
          onChange={(e) => e.target.files[0] && cargar(e.target.files[0])} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
          <Btn onClick={() => inputRef.current?.click()} color={C.blue}>
            Seleccionar archivo
          </Btn>
          <Btn outline onClick={descargarPlantilla}>⬇ Descargar plantilla</Btn>
        </div>
        {errores.length > 0 && (
          <div style={{ background: "#1f1010", border: `1px solid ${C.red}40`, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
            {errores.map((e, i) => <div key={i} style={{ fontSize: 12, color: C.red }}>{e}</div>)}
          </div>
        )}
        {warnings.length > 0 && (
          <div style={{ background: "#1a1400", border: `1px solid ${C.accent}40`, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
            {warnings.map((w, i) => <div key={i} style={{ fontSize: 12, color: C.accent }}>⚠ {w}</div>)}
          </div>
        )}
        {filas && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: C.textDim, marginBottom: 8 }}>Vista previa — {filas.length} posición(es)</div>
            <div style={{ maxHeight: 240, overflowY: "auto", border: `1px solid ${C.border2}`, borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {filas.map((nombre, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td className="mono" style={{ padding: "6px 12px", fontSize: 12, color: C.textDim, width: 40 }}>#{i + 1}</td>
                      <td style={{ padding: "6px 12px", fontSize: 13, color: C.text }}>{nombre}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={confirmar} color={C.green} disabled={!filas || errores.length > 0} style={{ flex: 1 }}>
            Confirmar orden
          </Btn>
          <Btn outline onClick={onClose}>Cancelar</Btn>
        </div>
      </Card>
    </div>
  );
}

function TabBarcos({ barcos, slots, cierres, calidades, listas, calidadNombre, setBarcos, setSlots, setSlotsTodas, setCierres, snapshot }) {
  const [form,       setForm]       = useState({ nombre: "", numBateas: "" });
  const [show,       setShow]       = useState(false);
  const [err,        setErr]        = useState("");
  const [confirmDel, setConfirmDel] = useState(null);
  const [editing,    setEditing]    = useState(null);
  const [showImport, setShowImport] = useState(false); // { barcoId, newBateas }

  const add = () => {
    const b = parseFloat(form.numBateas);
    if (!form.nombre.trim() || isNaN(b) || b < 0.5) {
      setErr("Completa todos los campos. Mínimo 0.5 bateas."); return;
    }
    const nb = { id: uid(), nombre: form.nombre.trim(), numBateas: b, activo: true, pin: "0000" };
    snapshot && snapshot(`Añadir barco — ${nb.nombre}`);
    const makeNS = (existingSlots) => {
      const ns = makeSlotsForBarco(nb, existingSlots.length + 1);
      return recalc([...existingSlots, ...ns]);
    };
    setBarcos((x) => [...x, nb]);
    setSlotsTodas(makeNS);
    setForm({ nombre: "", numBateas: "" }); setShow(false); setErr("");
  };

  const aplicarCambioBateas = () => {
    if (!editing) return;
    const nuevasBateas = parseFloat(editing.newBateas);
    if (isNaN(nuevasBateas) || nuevasBateas < 0.5) return;
    const barco = barcos.find((b) => b.id === editing.barcoId);
    if (!barco) return;
    const nuevosCiclos   = getCiclos(nuevasBateas);
    const nuevoCupo      = getCupoCiclo(nuevasBateas);
    const ciclosActuales = getCiclos(barco.numBateas);
    snapshot && snapshot(`Modificar bateas — ${barco.nombre}`);
    setBarcos((bs) => bs.map((b) => b.id === barco.id ? { ...b, numBateas: nuevasBateas, nombre: editing.newNombre?.trim() || barco.nombre } : b));
    setSlotsTodas((currentSlots) => {
      let ns = currentSlots.map((s) => s.barcoId === barco.id ? { ...s, cupoCiclo: nuevoCupo } : s);
      const slotsBarco = currentSlots.filter((s) => s.barcoId === barco.id);
      if (nuevosCiclos > ciclosActuales) {
        const maxPos = Math.max(...ns.map((s) => s.posicion), 0);
        for (let i = ciclosActuales + 1; i <= nuevosCiclos; i++) {
          ns.push({ id: uid(), barcoId: barco.id, numeroCiclo: i,
            cupoCiclo: nuevoCupo, bolsasEntregadas: 0, ajusteBolsas: 0,
            posicion: maxPos + (i - ciclosActuales), estado: "en_espera" });
        }
      } else if (nuevosCiclos < ciclosActuales) {
        const porPos    = slotsBarco.slice().sort((a, b) => b.posicion - a.posicion);
        const aEliminar = new Set(porPos.slice(0, ciclosActuales - nuevosCiclos).map((s) => s.id));
        ns = ns.filter((s) => !aEliminar.has(s.id));
      }
      return recalc(ns);
    });
    setEditing(null);
  };

  const borrar = (barcoId) => {
    const b = barcos.find((x) => x.id === barcoId);
    snapshot && snapshot(`Dar de baja — ${b?.nombre ?? "barco"}`);
    setBarcos((bs) => bs.filter((b) => b.id !== barcoId));
    setSlotsTodas((ss) => recalc(ss.filter((s) => s.barcoId !== barcoId)));
    if (setCierres) setCierres((cs) => cs.filter((c) => c.barcoId !== barcoId));
    setConfirmDel(null);
  };

  const barcoABorrar = confirmDel ? barcos.find((b) => b.id === confirmDel) : null;
  const tieneActividad = confirmDel
    ? slots.some((s) => s.barcoId === confirmDel && s.bolsasEntregadas > 0)
    : false;

  const rows = barcos.map((b) => {
    const bs = slots.filter((s) => s.barcoId === b.id);
    const tieneCierre = cierres?.some((c) => c.barcoId === b.id && !c.fechaFin);
    return {
      _key: b.id,
      barco: (
        <div>
          <div style={{ fontWeight: 600, color: C.text }}>
            {b.nombre}
            {isEspecial(b.numBateas) && <span style={{ marginLeft: 8, fontSize: 11, color: C.violet, background: "#1e1040", padding: "1px 8px", borderRadius: 12, border: `1px solid ${C.violet}40` }}>⚡ especial</span>}
            {tieneCierre && <span style={{ marginLeft: 8, fontSize: 11, color: C.red }}>🔒</span>}
          </div>
        </div>
      ),
      bateas:     <span className="mono">{b.numBateas}</span>,
      ciclos:     <span className="mono">{getCiclos(b.numBateas)}</span>,
      cupoCiclo:  <span className="mono" style={{ color: C.accent }}>{getCupoCiclo(b.numBateas)}</span>,
      posiciones: (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {bs.map((s) => (
            <span key={s.id} className="mono" style={{ fontSize: 13, fontWeight: 700, color: C.blue, background: "#0a1f35", border: `1px solid ${C.blue}40`, padding: "2px 8px", borderRadius: 6 }}>#{s.posicion}</span>
          ))}
        </div>
      ),
      saldo: (calidades && listas) ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {calidades.map((cal) => {
            const slotsCal = (listas[cal.id]?.slots || []).filter((s) => s.barcoId === b.id);
            const total = slotsCal.reduce((a, s) => a + (s.ajusteBolsas || 0), 0);
            const color = total > 0 ? C.green : total < 0 ? C.red : C.textDim;
            return (
              <div key={cal.id} className="mono" style={{ fontSize: 11, color }}>
                {cal.nombre}: {total > 0 ? "+" : ""}{total}
              </div>
            );
          })}
        </div>
      ) : null,
      accion: (
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setEditing({ barcoId: b.id, newBateas: String(b.numBateas), newNombre: b.nombre })}
            style={{ background: "transparent", border: `1px solid ${C.blue}40`, color: C.blue,
              padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
            Editar
          </button>
          <button onClick={() => setConfirmDel(b.id)}
            style={{ background: "transparent", border: `1px solid ${C.red}40`, color: C.red,
              padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
            Dar de baja
          </button>
        </div>
      ),
    };
  });

  return (
    <div className="fade-in">
      {/* Modal edición bateas */}
      {editing && (() => {
        const b = barcos.find((x) => x.id === editing.barcoId);
        const nv = parseFloat(editing.newBateas);
        const ciclosNuevos = !isNaN(nv) && nv >= 0.5 ? getCiclos(nv) : null;
        const cupoNuevo    = !isNaN(nv) && nv >= 0.5 ? getCupoCiclo(nv) : null;
        const ciclosActual = b ? getCiclos(b.numBateas) : null;
        const cambio = ciclosNuevos !== null && ciclosActual !== null
          ? ciclosNuevos - ciclosActual : 0;
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
            <Card style={{ maxWidth: 380, width: "100%", boxShadow: "0 24px 64px #000a" }}>
              <div className="cond" style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 4 }}>Modificar bateas</div>
              <div style={{ fontSize: 14, color: C.textMid, marginBottom: 16 }}>{b?.nombre}</div>
              <Label>Nombre del barco</Label>
              <Input value={editing.newNombre || ""} onChange={(e) => setEditing((ed) => ({ ...ed, newNombre: e.target.value }))} style={{ marginBottom: 12 }} />
              <Label>Bateas actuales: <span style={{ color: C.accent }}>{b?.numBateas}</span></Label>
              <Input type="number" step="0.5" min="0.5" value={editing.newBateas}
                onChange={(e) => setEditing((ed) => ({ ...ed, newBateas: e.target.value }))}
                placeholder="Nuevo número de bateas" style={{ marginBottom: 12 }} />
              {ciclosNuevos !== null && (
                <div className="mono" style={{ fontSize: 12, background: "#0a1f35", border: `1px solid ${C.blue}30`, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
                  <div style={{ color: C.blue, marginBottom: 4 }}>
                    → {ciclosNuevos} ciclo(s) · {cupoNuevo} bolsas/ciclo
                    {isEspecial(nv) ? " · ⚡ especial" : ""}
                  </div>
                  {cambio > 0 && <div style={{ color: C.green }}>+{cambio} slot(s) añadidos al final de la lista</div>}
                  {cambio < 0 && <div style={{ color: C.accent }}>⚠ {Math.abs(cambio)} slot(s) eliminados (los de mayor posición)</div>}
                  {cambio === 0 && <div style={{ color: C.textDim }}>Mismo número de ciclos, solo cambia el cupo por ciclo</div>}
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <Btn onClick={aplicarCambioBateas} color={C.blue} disabled={isNaN(nv) || nv < 0.5} style={{ flex: 1 }}>Aplicar cambio</Btn>
                <Btn outline onClick={() => setEditing(null)}>Cancelar</Btn>
              </div>
            </Card>
          </div>
        );
      })()}
      {confirmDel && barcoABorrar && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
          <Card style={{ maxWidth: 380, width: "100%", boxShadow: "0 24px 64px #000a" }}>
            <div className="cond" style={{ fontSize: 20, fontWeight: 800, color: C.red, marginBottom: 8 }}>⚠ Dar de baja barco</div>
            <div style={{ fontSize: 14, color: C.text, marginBottom: 12 }}>
              <strong>{barcoABorrar.nombre}</strong>
            </div>
            {tieneActividad && (
              <div style={{ fontSize: 12, color: C.accent, background: "#1a1400", border: `1px solid ${C.accent}40`, borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
                ⚠ Este barco tiene ciclos con bolsas entregadas. El historial de pedidos se conservará.
              </div>
            )}
            <div style={{ fontSize: 13, color: C.textMid, marginBottom: 20 }}>
              Se eliminará de la lista y de la flota. Sus pedidos en el historial quedarán registrados.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn onClick={() => borrar(confirmDel)} color={C.red} style={{ flex: 1 }}>Confirmar baja</Btn>
              <Btn outline onClick={() => setConfirmDel(null)}>Cancelar</Btn>
            </div>
          </Card>
        </div>
      )}

      {showImport && <ModalImportarLista barcos={barcos} slots={slots} setSlots={setSlots} calidadNombre={calidadNombre} snapshot={snapshot} onClose={() => setShowImport(false)} />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <SectionTitle>🚢 Flota</SectionTitle>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn outline onClick={() => setShowImport(true)}>📂 Importar lista{calidadNombre ? ` — ${calidadNombre}` : ""}</Btn>
          <Btn onClick={() => setShow(!show)} color={C.blue}>+ Añadir barco</Btn>
        </div>
      </div>
      {show && (
        <Card style={{ maxWidth: 400, marginBottom: 20 }}>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>Nuevo barco</div>
          {err && <div style={{ fontSize: 12, color: C.red, background: "#1f1010", border: `1px solid ${C.red}40`, borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>{err}</div>}
          <Label>Nombre</Label>
          <Input value={form.nombre} onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))} placeholder="Nombre del barco" style={{ marginBottom: 10 }} />
          <Label>Número de bateas</Label>
          <Input type="number" step="0.5" min="0.5" value={form.numBateas} onChange={(e) => setForm((f) => ({ ...f, numBateas: e.target.value }))} placeholder="ej. 4 o 3.5" style={{ marginBottom: 8 }} />
          {form.numBateas && !isNaN(parseFloat(form.numBateas)) && (() => {
            const b = parseFloat(form.numBateas);
            return <div className="mono" style={{ fontSize: 11, color: C.blue, background: "#0a1f35", border: `1px solid ${C.blue}30`, borderRadius: 8, padding: "8px 12px", marginBottom: 14 }}>
              → {getCiclos(b)} ciclo(s) · {getCupoCiclo(b)} bolsas/ciclo{isEspecial(b) ? ` · ⚡ especial (salta turno)` : ""}
            </div>;
          })()}
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={add} color={C.green} style={{ flex: 1 }}>Añadir</Btn>
            <Btn outline onClick={() => { setShow(false); setErr(""); }}>Cancelar</Btn>
          </div>
        </Card>
      )}
      <DataTable
        cols={[
          { key: "barco",      label: "Barco" },
          { key: "bateas",     label: "Bateas",     center: true },
          { key: "ciclos",     label: "Ciclos",     center: true },
          { key: "cupoCiclo",  label: "Cupo/ciclo", center: true },
          { key: "posiciones", label: "Pos. en lista" },
          { key: "saldo",     label: "Saldo bolsas" },
          { key: "accion",     label: "",           center: true },
        ]}
        rows={rows}
      />
    </div>
  );
}

/* ── TAB CIERRES ───────────────────────────────────────────── */
function CloseModal({ cierre, barco, barcos, cierres, historial, onConfirm, onCancel }) {
  const [fecha,     setFecha]     = useState(hoy());
  const [override,  setOverride]  = useState("");   // corrección manual opcional

  const calc = useMemo(
    () => calcularCupoAcumulado(cierre, fecha, cierres, barcos, historial),
    [cierre, fecha, cierres, barcos, historial]
  );

  const cupoFinal = override !== "" ? (parseInt(override) || 0) : calc.cupo;
  const cerradas  = cierre?.bateasCerradas || 0;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 16, padding: 28, maxWidth: 420, width: "100%", boxShadow: "0 24px 64px #000a" }}>
        <div className="cond" style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 4 }}>Reabrir batea</div>
        <div style={{ fontSize: 14, color: C.textMid, marginBottom: 16 }}>{barco?.nombre} · {cerradas}/{barco?.numBateas} bat. cerradas</div>

        <Label>Fecha de reapertura</Label>
        <Input type="date" value={fecha} onChange={(e) => { setFecha(e.target.value); setOverride(""); }} style={{ marginBottom: 16 }} />

        {/* Cupo calculado automáticamente */}
        <div style={{ background: "#0a1f10", border: `1px solid ${C.green}40`, borderRadius: 10, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            Cupo acumulado calculado automáticamente
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 12 }}>
            <span className="mono" style={{ fontSize: 36, fontWeight: 800, color: C.green }}>{calc.cupo}</span>
            <span style={{ fontSize: 14, color: C.textMid }}>bolsas</span>
          </div>
          {/* Desglose: (bolsas ÷ bat.abiertas) × bat.cerradas */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr auto 1fr", alignItems: "center", gap: 4, fontSize: 11 }}>
            <div style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{calc.totalBolsas}</div>
              <div style={{ color: C.textDim, marginTop: 2 }}>bolsas servidas</div>
            </div>
            <div style={{ color: C.textDim, fontSize: 16, textAlign: "center" }}>÷</div>
            <div style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{calc.bateasAbiertas}</div>
              <div style={{ color: C.textDim, marginTop: 2 }}>bat. abiertas</div>
            </div>
            <div style={{ color: C.textDim, fontSize: 16, textAlign: "center" }}>×</div>
            <div style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{cerradas}</div>
              <div style={{ color: C.textDim, marginTop: 2 }}>bat. cerradas</div>
            </div>
            <div style={{ color: C.textDim, fontSize: 16, textAlign: "center" }}>=</div>
            <div style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{calc.cupo}</div>
              <div style={{ color: C.textDim, marginTop: 2 }}>cupo total</div>
            </div>
          </div>
          {calc.totalBolsas === 0 && (
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 10, textAlign: "center" }}>
              Sin pedidos en historial durante este período
            </div>
          )}
        </div>

        {/* Corrección manual opcional */}
        <div style={{ marginBottom: 20 }}>
          <Label>Corrección manual <span style={{ color: C.textDim, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(dejar vacío para usar el calculado)</span></Label>
          <Input type="number" min="0" value={override}
            onChange={(e) => setOverride(e.target.value)}
            placeholder={`${calc.cupo} (calculado)`} />
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={() => onConfirm(cupoFinal, fecha)} color={C.green} style={{ flex: 1 }}>
            Confirmar — {cupoFinal} bolsas acumuladas
          </Btn>
          <Btn outline onClick={onCancel}>Cancelar</Btn>
        </div>
      </div>
    </div>
  );
}

function TabCierres({ barcos, cierres, setCierres, historial, snapshot }) {
  const [form,    setForm]    = useState({ barcoId: "", fecha: hoy(), bateasCerradas: "" });
  const [show,    setShow]    = useState(false);
  const [closing, setClosing] = useState(null);
  const active     = cierres.filter((c) => !c.fechaFin);
  const hist       = cierres.filter((c) =>  c.fechaFin);
  // Barcos disponibles: los que aún tienen bateas sin cerrar
  const available  = barcos.filter((b) => {
    if (!b.activo) return false;
    const cerradas = bateasCerradasActivas(cierres, b.id);
    return cerradas < b.numBateas;
  });
  const selBarco   = barcos.find((b) => b.id === form.barcoId);
  const yaCerradas = selBarco ? bateasCerradasActivas(cierres, selBarco.id) : 0;
  const disponibles = selBarco ? selBarco.numBateas - yaCerradas : 0;
  // Opciones de bateas en pasos de 0.5, limitadas a las que quedan abiertas
  const bateaOpts  = selBarco
    ? Array.from({ length: Math.round(disponibles / 0.5) }, (_, i) => Math.round((i + 1) * 5) / 10)
    : [];
  const abrir = () => {
    if (!form.barcoId || !form.bateasCerradas) return;
    snapshot && snapshot("Abrir cierre");
    setCierres((cs) => [...cs, { id: uid(), barcoId: form.barcoId, fechaInicio: form.fecha, fechaFin: null, cupoAcumulado: 0, cupoConsumido: 0, bateasCerradas: parseFloat(form.bateasCerradas), createdTs: Date.now() }]);
    setForm({ barcoId: "", fecha: hoy(), bateasCerradas: "" }); setShow(false);
  };
  const cerrar = (id, cupo, fecha) => {
    snapshot && snapshot("Reabrir batea");
    setCierres((cs) => cs.map((c) => c.id === id ? { ...c, fechaFin: fecha, cupoAcumulado: parseInt(cupo) || 0 } : c));
    setClosing(null);
  };
  const cierreToClose = closing ? cierres.find((c) => c.id === closing) : null;
  return (
    <div className="fade-in">
      {cierreToClose && (
        <CloseModal cierre={cierreToClose} barco={barcos.find((b) => b.id === cierreToClose.barcoId)}
          barcos={barcos} cierres={cierres} historial={historial}
          onConfirm={(cupo, fecha) => cerrar(closing, cupo, fecha)} onCancel={() => setClosing(null)} />
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <SectionTitle>🔒 Cierres Administrativos</SectionTitle>
        <Btn onClick={() => setShow(!show)} color={C.red}>+ Nuevo cierre</Btn>
      </div>
      {show && (
        <Card style={{ maxWidth: 380, marginBottom: 20, borderColor: `${C.red}40` }}>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.red, marginBottom: 14 }}>Cierre por toxina / Veda</div>
          <Label>Barco afectado</Label>
          <Sel value={form.barcoId} onChange={(e) => setForm((f) => ({ ...f, barcoId: e.target.value, bateasCerradas: "" }))} style={{ marginBottom: 10 }}>
            <option value="">Seleccionar barco...</option>
            {available.map((b) => {
              const yc = bateasCerradasActivas(cierres, b.id);
              return <option key={b.id} value={b.id}>{b.nombre} ({b.numBateas} bat.{yc > 0 ? ` · ${yc} ya cerradas` : ""})</option>;
            })}
          </Sel>
          {selBarco && (
            <>
              {yaCerradas > 0 && (
                <div style={{ fontSize: 11, color: C.orange, background: "#1a1400", border: `1px solid ${C.orange}40`, borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>
                  Este barco ya tiene {yaCerradas} batea(s) cerrada(s) en otro polígono. Quedan {disponibles} disponibles.
                </div>
              )}
              <Label>Bateas a cerrar ahora (quedan {disponibles} abiertas)</Label>
              <Sel value={form.bateasCerradas} onChange={(e) => setForm((f) => ({ ...f, bateasCerradas: e.target.value }))} style={{ marginBottom: 10 }}>
                <option value="">Seleccionar número...</option>
                {bateaOpts.map((v) => {
                  const totalTrasCierre = yaCerradas + v;
                  return (
                    <option key={v} value={v}>
                      {v} batea{v !== 1 ? "s" : ""} — {totalTrasCierre >= selBarco.numBateas ? "cierre total" : `${selBarco.numBateas - totalTrasCierre} quedarían abiertas`}
                    </option>
                  );
                })}
              </Sel>
            </>
          )}
          <Label>Fecha de inicio</Label>
          <Input type="date" value={form.fecha} onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))} style={{ marginBottom: 14 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={abrir} color={C.red} disabled={!form.barcoId || !form.bateasCerradas} style={{ flex: 1 }}>Abrir cierre</Btn>
            <Btn outline onClick={() => setShow(false)}>Cancelar</Btn>
          </div>
        </Card>
      )}
      {active.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.red, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Activos</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {active.map((c) => {
              const b = barcos.find((x) => x.id === c.barcoId);
              const isFull   = (c.bateasCerradas || 0) >= (b?.numBateas || 0);
              const abiertas = b ? b.numBateas - (c.bateasCerradas || 0) : 0;
              return (
                <div key={c.id} style={{ background: "#1a0a0a", border: `1px solid ${isFull ? C.red : C.orange}40`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: C.text }}>{b?.nombre}</div>
                    <div style={{ fontSize: 12, color: C.textDim, marginTop: 2 }}>
                      Desde {c.fechaInicio} · <span style={{ color: isFull ? C.red : C.orange, fontWeight: 600 }}>
                        {c.bateasCerradas}/{b?.numBateas} bat. cerradas
                        {isFull ? " — Excluido de propuestas" : ` — ${abiertas} bat. activas (cupo reducido)`}
                      </span>
                    </div>
                  </div>
                  <Btn small onClick={() => setClosing(c.id)} color={C.green}>Reabrir</Btn>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {hist.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Histórico</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hist.map((c) => {
              const b = barcos.find((x) => x.id === c.barcoId);
              const rest = c.cupoAcumulado - c.cupoConsumido;
              return (
                <Card key={c.id} style={{ padding: "14px 18px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <div>
                      <span style={{ fontWeight: 600, color: C.text }}>{b?.nombre}</span>
                      <span className="mono" style={{ marginLeft: 10, fontSize: 11, color: C.textDim }}>{c.bateasCerradas}/{b?.numBateas} bat.</span>
                    </div>
                    <span className="mono" style={{ fontSize: 11, color: C.textDim }}>{c.fechaInicio} → {c.fechaFin}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.textMid, marginBottom: 8 }}>
                    Cupo acumulado: <span className="mono" style={{ fontWeight: 700, color: C.text }}>{c.cupoAcumulado}</span> bolsas
                    {c.acumuladoBorradoPorRechazo
                      ? <span style={{ marginLeft: 10, color: C.red }}>✗ Borrado por 3 rechazos</span>
                      : rest > 0 ? <span style={{ marginLeft: 10, color: C.accent }}>({rest} pendientes)</span>
                      : <span style={{ marginLeft: 10, color: C.green }}>✓ Agotado</span>}
                  </div>
                  {c.cupoAcumulado > 0 && <Bar value={c.cupoConsumido} max={c.cupoAcumulado} color={C.accent} />}
                </Card>
              );
            })}
          </div>
        </div>
      )}
      {active.length === 0 && hist.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.textDim }}>
          <svg width="48" height="48" viewBox="0 0 48 48" style={{ marginBottom: 8 }}>
            <rect x="8" y="14" width="32" height="5" rx="1.5" fill="#f59e0b" opacity="0.4"/>
            <line x1="13" y1="19" x2="13" y2="40" stroke="#3b82f6" strokeWidth="1.6" opacity="0.4"/>
            <line x1="19" y1="19" x2="19" y2="44" stroke="#3b82f6" strokeWidth="1.6" opacity="0.4"/>
            <line x1="24" y1="19" x2="24" y2="42" stroke="#3b82f6" strokeWidth="1.6" opacity="0.4"/>
            <line x1="29" y1="19" x2="29" y2="44" stroke="#3b82f6" strokeWidth="1.6" opacity="0.4"/>
            <line x1="35" y1="19" x2="35" y2="40" stroke="#3b82f6" strokeWidth="1.6" opacity="0.4"/>
            <path d="M4 44 Q12 40 20 44 T36 44 T52 44" fill="none" stroke="#7a99b8" strokeWidth="1.5" opacity="0.3"/>
          </svg>
          <div>Sin cierres registrados</div>
        </div>
      )}
    </div>
  );
}

/* ── TAB EXCLUSIONES (sin producto / sin calidad) ──────────── */
function TabExclusiones({ barcos, exclusiones, setExclusiones, calidades, calidadActiva, snapshot }) {
  const [barcoId, setBarcoId] = useState("");
  const calNombre = calidades.find((c) => c.id === calidadActiva)?.nombre ?? "";

  const activas = exclusiones.filter((e) => e.calidadId === calidadActiva && !e.fechaFin);
  const activasBIds = new Set(activas.map((e) => e.barcoId));
  const disponibles = barcos.filter((b) => b.activo && !activasBIds.has(b.id));

  const excluir = () => {
    if (!barcoId) return;
    snapshot && snapshot("Excluir barco (sin producto)");
    setExclusiones((es) => [...es, { id: uid(), barcoId, calidadId: calidadActiva, fechaInicio: hoy(), fechaFin: null }]);
    setBarcoId("");
  };
  const reactivar = (id) => {
    snapshot && snapshot("Marcar barco operativo");
    setExclusiones((es) => es.map((e) => e.id === id ? { ...e, fechaFin: hoy() } : e));
  };

  return (
    <div className="fade-in">
      <SectionTitle>🚫 Exclusiones — {calNombre}</SectionTitle>
      <div style={{ fontSize: 13, color: C.textMid, marginBottom: 16, maxWidth: 600 }}>
        Marca un barco como sin producto o sin esta calidad. No aparecerá en las propuestas de <strong style={{ color: C.text }}>{calNombre}</strong>, pero su posición en la lista sigue avanzando con normalidad y no acumula cupo.
      </div>

      <Card style={{ maxWidth: 420, marginBottom: 20 }}>
        <Label>Excluir barco de {calNombre}</Label>
        <div style={{ display: "flex", gap: 8 }}>
          <Sel value={barcoId} onChange={(e) => setBarcoId(e.target.value)} style={{ flex: 1 }}>
            <option value="">Seleccionar barco...</option>
            {disponibles.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
          </Sel>
          <Btn onClick={excluir} color={C.orange} disabled={!barcoId}>Excluir</Btn>
        </div>
      </Card>

      {activas.length > 0 ? (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.orange, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
            Excluidos de {calNombre}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {activas.map((e) => {
              const b = barcos.find((x) => x.id === e.barcoId);
              return (
                <div key={e.id} style={{ background: "#1a1400", border: `1px solid ${C.orange}40`, borderRadius: 12, padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontWeight: 600, color: C.text }}>{b?.nombre}</div>
                    <div style={{ fontSize: 12, color: C.textDim, marginTop: 2 }}>Sin producto desde {e.fechaInicio}</div>
                  </div>
                  <Btn small onClick={() => reactivar(e.id)} color={C.green}>Marcar operativo</Btn>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "40px 0", color: C.textDim }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>✓</div>
          <div>Todos los barcos operativos en {calNombre}</div>
        </div>
      )}
    </div>
  );
}

/* ── TAB HISTORIAL ─────────────────────────────────────────── */
function TabHistorial({ historial, calidadNombre }) {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [vista, setVista] = useState("pedidos"); // "pedidos" | "barcos"

  const filtrado = useMemo(() => {
    return historial.filter((p) => {
      if (desde && p.fecha < desde) return false;
      if (hasta && p.fecha > hasta) return false;
      return true;
    });
  }, [historial, desde, hasta]);

  const resumenPorBarco = useMemo(() => {
    const mapa = {};
    filtrado.forEach((p) => {
      p.lineas.forEach((l) => {
        if (!mapa[l.barcoNombre]) mapa[l.barcoNombre] = { bolsas: 0, pedidos: 0 };
        mapa[l.barcoNombre].bolsas  += l.bolsas;
        mapa[l.barcoNombre].pedidos += 1;
      });
    });
    return Object.entries(mapa).sort((a, b) => b[1].bolsas - a[1].bolsas);
  }, [filtrado]);

  const exportarExcel = () => {
    const wb = XLSX.utils.book_new();
    // Hoja 1: detalle de pedidos
    const detalleData = [["Fecha", "Descripción", "Barco", "Bolsas"]];
    filtrado.forEach((p) => p.lineas.forEach((l) => detalleData.push([p.fecha, p.desc || "", l.barcoNombre, l.bolsas])));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detalleData), "Historial");
    // Hoja 2: resumen por barco
    const resumenData = [["Barco", "Total bolsas", "Nº pedidos"]];
    resumenPorBarco.forEach(([nombre, d]) => resumenData.push([nombre, d.bolsas, d.pedidos]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumenData), "Por barco");
    const sufijo = desde || hasta ? `_${desde || "inicio"}_${hasta || "hoy"}` : "";
    XLSX.writeFile(wb, `reparto_mejillon${sufijo}.xlsx`);
  };

  const totalBolsas = filtrado.reduce((s, p) => s + p.lineas.reduce((ss, l) => ss + l.bolsas, 0), 0);

  if (historial.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 0", color: C.textDim }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>📋</div>
        <div>Sin pedidos confirmados aún</div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <SectionTitle>📜 Historial{calidadNombre ? ` — ${calidadNombre}` : ""}</SectionTitle>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn small onClick={exportarExcel} color={C.green}>⬇ Excel</Btn>
        </div>
      </div>

      {/* Filtros */}
      <Card style={{ marginBottom: 16, padding: "14px 18px" }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <Label>Desde</Label>
            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <Label>Hasta</Label>
            <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {["pedidos", "barcos"].map((v) => (
              <button key={v} onClick={() => setVista(v)} style={{
                padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                fontSize: 12, fontWeight: 700, fontFamily: "'Barlow', sans-serif",
                background: vista === v ? C.blue : C.navy, color: vista === v ? "#fff" : C.textMid,
              }}>
                {v === "pedidos" ? "Por pedido" : "Por barco"}
              </button>
            ))}
          </div>
          {(desde || hasta) && (
            <Btn small outline onClick={() => { setDesde(""); setHasta(""); }}>✕ Limpiar</Btn>
          )}
        </div>
        <div className="mono" style={{ fontSize: 11, color: C.textDim, marginTop: 10 }}>
          {filtrado.length} pedido{filtrado.length !== 1 ? "s" : ""} · {totalBolsas.toLocaleString()} bolsas totales
          {(desde || hasta) && ` · filtrado de ${historial.length} total`}
        </div>
      </Card>

      {/* Vista por pedido */}
      {vista === "pedidos" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filtrado.length === 0 && (
            <div style={{ textAlign: "center", padding: 40, color: C.textDim }}>Sin pedidos en el periodo seleccionado</div>
          )}
          {filtrado.map((p) => {
            const total = p.lineas.reduce((s, l) => s + l.bolsas, 0);
            return (
              <Card key={p.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <span className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{p.fecha}</span>
                    {p.desc && <span style={{ marginLeft: 10, fontSize: 13, color: C.textMid }}>{p.desc}</span>}
                  </div>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: C.accent, background: "#1a2f00", border: `1px solid ${C.accent}40`, padding: "3px 12px", borderRadius: 20 }}>
                    {total} bolsas · {p.lineas.length} barco{p.lineas.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {p.lineas.map((l, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 12px", borderRadius: 8, background: "#0a2010", fontSize: 13 }}>
                      <span style={{ color: C.text }}>{l.barcoNombre}</span>
                      <span className="mono" style={{ color: C.green, fontWeight: 700 }}>{l.bolsas} bolsas</span>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Vista por barco */}
      {vista === "barcos" && (
        <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Barco", "Total bolsas", "Nº pedidos", "Media/pedido"].map((h) => (
                  <th key={h} style={{ background: "#0a1520", color: C.textDim, padding: "10px 16px", textAlign: h === "Barco" ? "left" : "right",
                    fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                    fontFamily: "'Barlow Condensed', sans-serif", borderBottom: `1px solid ${C.border}` }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resumenPorBarco.length === 0 && (
                <tr><td colSpan={4} style={{ padding: 40, textAlign: "center", color: C.textDim }}>Sin datos</td></tr>
              )}
              {resumenPorBarco.map(([nombre, d], i) => (
                <tr key={nombre} style={{ background: i % 2 === 0 ? C.surface : C.bg, borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 16px", fontWeight: 600, color: C.text }}>{nombre}</td>
                  <td className="mono" style={{ padding: "10px 16px", textAlign: "right", color: C.accent, fontWeight: 700 }}>{d.bolsas}</td>
                  <td className="mono" style={{ padding: "10px 16px", textAlign: "right", color: C.textMid }}>{d.pedidos}</td>
                  <td className="mono" style={{ padding: "10px 16px", textAlign: "right", color: C.textDim }}>{Math.round(d.bolsas / d.pedidos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── TAB VISTA BARCO ───────────────────────────────────────── */
// CAMBIO 4: bolsas que tienen que salir antes de que toque
function TabVistaBarco({ barcos, slots, cierres, fixedBarcoId, exclusiones, calidadActiva }) {
  const [bid, setBid] = useState(fixedBarcoId || "");
  const barco      = barcos.find((b) => b.id === bid);
  const bSlots     = slots.filter((s) => s.barcoId === bid);
  const cierre     = cierres.find((c) => c.barcoId === bid && !c.fechaFin);
  const acumCierre = cierres.find((c) => c.barcoId === bid && c.fechaFin && c.cupoAcumulado > c.cupoConsumido);
  const totalActivos = slots.filter((s) => s.estado !== "saltando_turno").length;

  const excluidoSet = new Set((exclusiones || []).filter((e) => e.calidadId === calidadActiva && !e.fechaFin).map((e) => e.barcoId));

  // Devuelve { reales, posibles } de bolsas que tienen que salir antes
  const bolsasAntesDe = (mySlot) => {
    let reales = 0, posibles = 0;
    slots
      .filter((s) => s.posicion < mySlot.posicion && s.estado !== "saltando_turno" && !isBoatFullyClosed(cierres, s.barcoId, barcos))
      .forEach((s) => {
        const disp = Math.max(0, getRestante(s, cierres, barcos));
        posibles += disp;
        if (!excluidoSet.has(s.barcoId)) reales += disp;
      });
    return { reales, posibles };
  };

  return (
    <div className="fade-in">
      <SectionTitle>👤 Mi Posición</SectionTitle>
      {!fixedBarcoId && (
        <Card style={{ marginBottom: 20 }}>
          <Label>Selecciona tu barco</Label>
          <Sel value={bid} onChange={(e) => setBid(e.target.value)}>
            <option value="">— Selecciona un barco —</option>
            {barcos.filter((b) => b.activo).map((b) => (
              <option key={b.id} value={b.id}>{b.nombre}</option>
            ))}
          </Sel>
        </Card>
      )}
      {!barco && (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.textDim }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🚢</div>
          <div style={{ fontSize: 15 }}>Selecciona tu barco para ver tu posición</div>
        </div>
      )}
      {barco && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "linear-gradient(135deg, #1a3a5c 0%, #0f1f35 100%)", border: `1px solid ${C.border2}`, borderRadius: 16, padding: 24 }}>
            <div className="cond" style={{ fontSize: 28, fontWeight: 800, color: "#fff" }}>{barco.nombre}</div>
            <div className="mono" style={{ fontSize: 12, color: C.textMid, marginTop: 4 }}>
              {barco.numBateas} bateas · {getCiclos(barco.numBateas)} ciclo(s) · {getCupoCiclo(barco.numBateas)} bolsas/ciclo
            </div>
            {isEspecial(barco.numBateas) && (
              <div style={{ marginTop: 8, fontSize: 12, color: C.violet, background: "#1e1040", border: `1px solid ${C.violet}40`, display: "inline-block", padding: "3px 12px", borderRadius: 20 }}>
                ⚡ Régimen especial ({getCupoCiclo(barco.numBateas)} bolsas + salta turno)
              </div>
            )}
            {cierre && (
              <div style={{ marginTop: 10, fontSize: 12, color: C.red, background: "#1a0505", border: `1px solid ${C.red}50`, display: "inline-block", padding: "5px 14px", borderRadius: 20, fontWeight: 700 }}>
                🔒 {cierre.bateasCerradas}/{barco.numBateas} bateas en cierre desde {cierre.fechaInicio}
              </div>
            )}
          </div>
          {acumCierre && (
            <div style={{ background: "#1a1400", border: `2px solid ${C.accent}60`, borderRadius: 14, padding: 18 }}>
              <div style={{ fontWeight: 700, color: C.accent, marginBottom: 6 }}>★ Cupo compensatorio activo</div>
              <div style={{ fontSize: 13, color: C.textMid, marginBottom: 10 }}>
                Tienes <strong style={{ color: C.accentL }}>{acumCierre.cupoAcumulado - acumCierre.cupoConsumido}</strong> bolsas acumuladas pendientes
              </div>
              <Bar value={acumCierre.cupoConsumido} max={acumCierre.cupoAcumulado} color={C.accent} />
            </div>
          )}
          {bSlots.map((slot) => {
            const ef   = getEfectivo(slot, cierres, barcos);
            const rest = getRestante(slot, cierres, barcos);
            const pct  = ef > 0 ? Math.min(100, (slot.bolsasEntregadas / ef) * 100) : 0;
            const ahead = slots.filter((s) => s.posicion < slot.posicion && s.estado !== "saltando_turno").length;
            const bolsasAntes = bolsasAntesDe(slot);
            return (
              <Card key={slot.id} style={{ padding: 24, borderColor: slot.estado === "cobrando" ? `${C.accent}60` : C.border }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
                  <div>
                    <div className="cond mono" style={{ fontSize: 60, fontWeight: 800, color: C.accentL, lineHeight: 1 }}>#{slot.posicion}</div>
                    <div style={{ fontSize: 13, color: C.textMid, marginTop: 4 }}>
                      {ahead === 0
                        ? <span style={{ color: C.green, fontWeight: 700 }}>¡Eres el siguiente!</span>
                        : `${ahead} barco(s) por delante`}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <Badge estado={slot.estado} />
                    <div className="mono" style={{ fontSize: 11, color: C.textDim, marginTop: 8 }}>Ciclo {slot.numeroCiclo}/{getCiclos(barco.numBateas)}</div>
                  </div>
                </div>
                {ahead > 0 && (
                  <div style={{ background: "#0a1f35", border: `1px solid ${C.blue}30`, borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                      Bolsas que tienen que salir antes de que te toque
                    </div>
                    <div className="mono" style={{ fontSize: 28, fontWeight: 800, color: C.blue }}>
                      {bolsasAntes.reales.toLocaleString()}
                      <span style={{ fontSize: 14, fontWeight: 400, color: C.textMid, marginLeft: 6 }}>bolsas</span>
                    </div>
                    {bolsasAntes.posibles !== bolsasAntes.reales && (
                      <div style={{ fontSize: 12, color: C.violet, marginTop: 4 }}>
                        Hasta <span className="mono" style={{ fontWeight: 700 }}>{bolsasAntes.posibles.toLocaleString()}</span> si se reactivan los barcos sin producto
                      </div>
                    )}
                  </div>
                )}
                <div style={{ background: C.navy, borderRadius: 12, padding: 16, marginBottom: slot.ajusteBolsas !== 0 ? 10 : 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.textMid, marginBottom: 8 }}>
                    <span>Cupo del ciclo</span>
                    <span className="mono" style={{ fontWeight: 700, color: C.text }}>{slot.bolsasEntregadas} / {ef} bolsas</span>
                  </div>
                  <div style={{ background: C.border, borderRadius: 6, height: 12, overflow: "hidden", marginBottom: 6 }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg, ${C.blue}, ${C.accent})`, borderRadius: 6, transition: "width .5s ease" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.textDim }}>
                    <span className="mono">{Math.round(pct)}% completado</span>
                    <span className="mono">Restante: <strong style={{ color: C.text }}>{rest}</strong> bolsas</span>
                  </div>
                </div>
                {slot.ajusteBolsas !== 0 && (
                  <div style={{ fontSize: 12, borderRadius: 8, padding: "8px 12px",
                    background: slot.ajusteBolsas > 0 ? "#0a1f0a" : "#1f0808",
                    border: `1px solid ${slot.ajusteBolsas > 0 ? C.green : C.red}40`,
                    color: slot.ajusteBolsas > 0 ? C.green : C.red }}>
                    Ajuste de ciclo anterior: <strong className="mono">{slot.ajusteBolsas > 0 ? "+" : ""}{slot.ajusteBolsas} bolsas</strong>
                  </div>
                )}
                {slot.estado === "saltando_turno" && (
                  <div style={{ fontSize: 12, borderRadius: 8, padding: "8px 12px", marginTop: 8, background: "#1e1040", border: `1px solid ${C.violet}40`, color: C.violet }}>
                    ⏭ Esta posición salta la próxima rotación (compensación por cupo doble anterior)
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── TAB CONFIGURACIÓN ─────────────────────────────────────── */
function TabConfiguracion({ barcos, setBarcos, calidades, addCalidad, deleteCalidad, listas, exportarBackup, importarBackup }) {
  const [actualPass, setActualPass] = useState("");
  const [newPass,    setNewPass]    = useState("");
  const [confirmPass,setConfirmPass]= useState("");
  const [passMsg,    setPassMsg]    = useState("");
  const [pins,       setPins]       = useState(() => Object.fromEntries(barcos.map((b) => [b.id, b.pin || "0000"])));

  const savePass = async () => {
    if (newPass.length < 4) { setPassMsg("Mínimo 4 caracteres"); return; }
    if (newPass !== confirmPass) { setPassMsg("Las contraseñas no coinciden"); return; }
    setPassMsg("Guardando…");
    const ok = await cambiarPassOficinista(actualPass, newPass);
    if (ok) {
      setActualPass(""); setNewPass(""); setConfirmPass("");
      setPassMsg("✓ Contraseña actualizada");
      setTimeout(() => setPassMsg(""), 3000);
    } else {
      setPassMsg("✗ La contraseña actual no es correcta o falló la conexión");
    }
  };

  const savePin = (barcoId) => {
    const pin = pins[barcoId] || "0000";
    if (!/^\d{4}$/.test(pin)) { alert("El PIN debe ser exactamente 4 dígitos"); return; }
    setBarcos((bs) => bs.map((b) => b.id === barcoId ? { ...b, pin } : b));
  };

  return (
    <div className="fade-in">
      <SectionTitle>⚙️ Configuración</SectionTitle>
      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        {/* Contraseña oficinista */}
        <Card>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>🔑 Contraseña Oficinista</div>
          <Label>Contraseña actual</Label>
          <Input type="password" value={actualPass} onChange={(e) => setActualPass(e.target.value)} placeholder="Contraseña actual" style={{ marginBottom: 10 }} />
          <Label>Nueva contraseña</Label>
          <Input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="Nueva contraseña" style={{ marginBottom: 10 }} />
          <Label>Confirmar</Label>
          <Input type="password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} placeholder="Repetir contraseña" style={{ marginBottom: 14 }}
            onKeyDown={(e) => e.key === "Enter" && savePass()} />
          {passMsg && <div style={{ fontSize: 12, marginBottom: 10, color: passMsg.startsWith("✓") ? C.green : C.red }}>{passMsg}</div>}
          <Btn onClick={savePass} color={C.blue} style={{ width: "100%" }}>Guardar contraseña</Btn>
        </Card>

        {/* PINs de barcos */}
        <Card>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>⚓ PINs de Socios (4 dígitos)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {barcos.filter((b) => b.activo).map((b) => (
              <div key={b.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ flex: 1, fontSize: 13, color: C.text, fontWeight: 600 }}>{b.nombre}</div>
                <input
                  type="text" maxLength={4} value={pins[b.id] || ""}
                  onChange={(e) => setPins((p) => ({ ...p, [b.id]: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                  className="mono"
                  style={{ width: 70, background: C.navy, border: `1px solid ${C.border2}`, color: C.text,
                    padding: "6px 10px", borderRadius: 8, fontSize: 14, textAlign: "center", outline: "none", letterSpacing: 4 }}
                />
                <Btn small onClick={() => savePin(b.id)} color={C.green}>✓</Btn>
              </div>
            ))}
          </div>
        </Card>

        {/* Copia de seguridad */}
        <Card style={{ gridColumn: "1 / -1", borderColor: `${C.green}40` }}>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>💾 Copia de seguridad</div>
          <div style={{ fontSize: 12, color: C.textMid, marginBottom: 14, maxWidth: 640 }}>
            Los datos se guardan en este navegador. Si se borra la caché, se cambia de ordenador o se reinstala Windows, <strong style={{ color: C.accent }}>se pierden</strong>. Descarga una copia con regularidad y guárdala en una memoria USB o en la nube.
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Btn onClick={exportarBackup} color={C.green}>⬇ Descargar copia (.json)</Btn>
            <label style={{
              display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
              background: "transparent", border: `1px solid ${C.border2}`, color: C.textMid,
              padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            }}>
              ⬆ Restaurar copia
              <input type="file" accept=".json,application/json" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) importarBackup(f); e.target.value = ""; }} />
            </label>
          </div>
        </Card>

        {/* Gestión de calidades */}
        <Card style={{ gridColumn: "1 / -1" }}>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>🏷️ Calidades de Mejillón</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
            {calidades.map((c) => {
              const nPedidos = Object.values(listas[c.id]?.historial ?? []).length;
              return (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, background: C.navy, border: `1px solid ${C.border2}`, borderRadius: 10, padding: "8px 14px" }}>
                  <span className="cond" style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{c.nombre}</span>
                  <span className="mono" style={{ fontSize: 11, color: C.textDim }}>{nPedidos} pedido{nPedidos !== 1 ? "s" : ""}</span>
                  {calidades.length > 1 && (
                    <button onClick={() => {
                      if (nPedidos > 0 && !window.confirm(`La calidad "${c.nombre}" tiene ${nPedidos} pedidos en historial. ¿Confirmas el borrado?`)) return;
                      deleteCalidad(c.id);
                    }} style={{ background: "transparent", border: "none", color: C.red, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>
          <NuevaCalidadForm onAdd={addCalidad} calidades={calidades} />
        </Card>
      </div>
    </div>
  );
}

function NuevaCalidadForm({ onAdd, calidades }) {
  const [nombre, setNombre] = useState("");
  const add = () => {
    const n = nombre.trim();
    if (!n) return;
    if (calidades.some((c) => c.nombre.toLowerCase() === n.toLowerCase())) { alert("Ya existe esa calidad"); return; }
    onAdd(n); setNombre("");
  };
  return (
    <div style={{ display: "flex", gap: 8, maxWidth: 340 }}>
      <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nueva calidad (ej. Extra)"
        onKeyDown={(e) => e.key === "Enter" && add()} style={{ flex: 1 }} />
      <Btn onClick={add} color={C.green} disabled={!nombre.trim()}>+ Añadir</Btn>
    </div>
  );
}

/* ── APP PRINCIPAL ─────────────────────────────────────────── */
const TABS_OFICINISTA = [
  { id: "lista",       label: "📋 Lista" },
  { id: "pedido",      label: "📦 Pedido" },
  { id: "barcos",      label: "🚢 Flota" },
  { id: "cierres",     label: "🔒 Cierres" },
  { id: "exclusiones", label: "🚫 Exclusiones" },
  { id: "historial",   label: "📜 Historial" },
  { id: "config",      label: "⚙️ Config" },
];

const CALIDADES_DEMO = [
  { id: "q1", nombre: "P2" },
  { id: "q2", nombre: "P1" },
  { id: "q3", nombre: "Europeo" },
  { id: "q4", nombre: "Normal" },
];

export default function App() {
  const [barcos,         setBarcos]         = useState(DEMO_BARCOS);
  const [cierres,        setCierres]        = useState([]);
  const [calidades,      setCalidades]      = useState(CALIDADES_DEMO);
  // listas: { [calidadId]: { slots, historial } }
  const [listas,         setListas]         = useState(() => {
    const init = {};
    CALIDADES_DEMO.forEach((c) => { init[c.id] = { slots: initSlots(DEMO_BARCOS), historial: [] }; });
    return init;
  });
  const [calidadActiva,  setCalidadActiva]  = useState("q1");
  const [pedidoActivo,   setPedidoActivo]   = useState(null); // incluye calidadId
  const [tab,            setTab]            = useState("lista");
  const [role,           setRole]           = useState(null);
  const [patronBarcoId,  setPatronBarcoId]  = useState(null);
  const [exclusiones,    setExclusiones]    = useState([]);   // {id, barcoId, calidadId, fechaInicio, fechaFin}
  const [rechazos,       setRechazos]       = useState({});   // { "calidadId:barcoId": contador }
  const [loaded,         setLoaded]         = useState(false);

  // Derivados de la calidad activa
  const slots    = listas[calidadActiva]?.slots    ?? [];
  const historial = listas[calidadActiva]?.historial ?? [];

  const setSlots = (updater) => setListas((prev) => ({
    ...prev,
    [calidadActiva]: {
      ...prev[calidadActiva],
      slots: typeof updater === "function" ? updater(prev[calidadActiva]?.slots ?? []) : updater,
    },
  }));

  const setHistorial = (updater) => setListas((prev) => ({
    ...prev,
    [calidadActiva]: {
      ...prev[calidadActiva],
      historial: typeof updater === "function" ? updater(prev[calidadActiva]?.historial ?? []) : updater,
    },
  }));

  // Actualiza slots en TODAS las calidades (para alta/baja/edición de barcos)
  const setSlotsTodas = (updaterFn) => setListas((prev) => {
    const next = { ...prev };
    Object.keys(next).forEach((cid) => {
      next[cid] = { ...next[cid], slots: updaterFn(next[cid]?.slots ?? []) };
    });
    return next;
  });

  /* ── PILA DE DESHACER (snapshots del estado operativo) ── */
  const undoStack = useRef([]);
  const [undoCount, setUndoCount] = useState(0);

  // Captura una foto del estado ANTES de una acción destructiva.
  // 'etiqueta' describe la acción para mostrarla en el botón.
  const snapshot = (etiqueta) => {
    undoStack.current.push({
      etiqueta,
      ts: Date.now(),
      data: JSON.parse(JSON.stringify({ barcos, cierres, calidades, listas, exclusiones, rechazos })),
    });
    // sin límite, pero protegemos memoria por si acaso (1000 acciones)
    if (undoStack.current.length > 1000) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  };

  const deshacer = () => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    setBarcos(snap.data.barcos);
    setCierres(snap.data.cierres);
    setCalidades(snap.data.calidades);
    setListas(snap.data.listas);
    setExclusiones(snap.data.exclusiones);
    setRechazos(snap.data.rechazos);
    setPedidoActivo(null);
    // si la calidad activa fue borrada en el snapshot, recolócala
    if (!snap.data.calidades.find((c) => c.id === calidadActiva)) {
      setCalidadActiva(snap.data.calidades[0]?.id ?? "");
    }
    setUndoCount(undoStack.current.length);
  };

  const ultimaAccion = undoCount > 0 ? undoStack.current[undoStack.current.length - 1].etiqueta : null;

  /* ── PERSISTENCIA (Supabase + caché local) ── */
  const aplicandoRemoto = useRef(false);   // evita re-guardar lo que acabamos de recibir
  const [estadoRed, setEstadoRed] = useState("conectando"); // conectando | online | offline

  // Aplica un objeto de estado (venga de Supabase o de la caché local) al React state
  const aplicarEstado = (s) => {
    if (!s) return;
    aplicandoRemoto.current = true;
    if (s.barcos)        setBarcos(s.barcos);
    if (s.cierres)       setCierres(s.cierres);
    if (s.calidades)     setCalidades(s.calidades);
    if (s.listas)        setListas(s.listas);
    if (s.calidadActiva) setCalidadActiva((prev) => prev || s.calidadActiva);
    if (s.exclusiones)   setExclusiones(s.exclusiones);
    if (s.rechazos)      setRechazos(s.rechazos);
    // ojo: oficinistaPass YA NO viaja en el estado; vive solo en el servidor
    setTimeout(() => { aplicandoRemoto.current = false; }, 0);
  };

  // Carga inicial: primero caché local (instantáneo), luego Supabase (autoritativo)
  useEffect(() => {
    // 1) caché local para pintar algo de inmediato
    try {
      const raw = localStorage.getItem("mejillon-state");
      if (raw) aplicarEstado(JSON.parse(raw));
    } catch (_) {}
    // 2) estado remoto
    (async () => {
      const remoto = await cargarEstadoRemoto();
      if (remoto) { aplicarEstado(remoto); setEstadoRed("online"); }
      else setEstadoRed("offline");
      setLoaded(true);
    })();
  }, []);

  // Guardado: el oficinista escribe en Supabase; todos guardan caché local
  useEffect(() => {
    if (!loaded || aplicandoRemoto.current) return;
    const estado = { barcos, cierres, calidades, listas, calidadActiva, exclusiones, rechazos };
    try { localStorage.setItem("mejillon-state", JSON.stringify(estado)); } catch (_) {}
    if (role === "oficinista") {
      guardarEstadoRemoto(estado).then((ok) => setEstadoRed(ok ? "online" : "offline"));
    }
  }, [barcos, cierres, calidades, listas, calidadActiva, exclusiones, rechazos, loaded, role]);

  // Polling: socios (y oficinista) refrescan desde Supabase cada 5 s.
  // El oficinista NO se auto-sobrescribe mientras tiene un pedido en curso.
  useEffect(() => {
    if (!loaded) return;
    const id = setInterval(async () => {
      if (role === "oficinista" && pedidoActivo) return; // no pisar trabajo en curso
      const remoto = await cargarEstadoRemoto();
      if (remoto) { aplicarEstado(remoto); setEstadoRed("online"); }
    }, 5000);
    return () => clearInterval(id);
  }, [loaded, role, pedidoActivo]);

  /* ── COPIA DE SEGURIDAD (exportar / importar todo el estado en JSON) ── */
  const exportarBackup = () => {
    const estado = { barcos, cierres, calidades, listas, calidadActiva, exclusiones, rechazos, _version: 1, _fecha: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(estado, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `copia_reparto_mejillon_${hoy()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importarBackup = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const s = JSON.parse(e.target.result);
        if (!s.barcos || !s.listas || !s.calidades) {
          alert("El archivo no es una copia válida del sistema.");
          return;
        }
        if (!window.confirm("Esto reemplazará TODOS los datos actuales por los de la copia. ¿Continuar?")) return;
        setBarcos(s.barcos);
        setCierres(s.cierres ?? []);
        setCalidades(s.calidades);
        setListas(s.listas);
        setCalidadActiva(s.calidades.find((c) => c.id === s.calidadActiva) ? s.calidadActiva : s.calidades[0]?.id ?? "");
        setExclusiones(s.exclusiones ?? []);
        setRechazos(s.rechazos ?? {});
        setPedidoActivo(null);
        undoStack.current = [];
        setUndoCount(0);
        alert("Copia restaurada correctamente.");
      } catch (_) {
        alert("No se pudo leer el archivo. ¿Es un JSON de copia válido?");
      }
    };
    reader.readAsText(file);
  };

  /* ── GESTIÓN DE CALIDADES ── */
  const addCalidad = (nombre) => {
    const id = uid();
    setCalidades((cs) => [...cs, { id, nombre }]);
    setListas((prev) => ({ ...prev, [id]: { slots: initSlots(barcos), historial: [] } }));
  };

  const deleteCalidad = (cid) => {
    if (calidades.length <= 1) return;
    snapshot(`Borrar calidad — ${calidades.find((c) => c.id === cid)?.nombre ?? ""}`);
    setCalidades((cs) => cs.filter((c) => c.id !== cid));
    setListas((prev) => { const n = { ...prev }; delete n[cid]; return n; });
    if (calidadActiva === cid) setCalidadActiva(calidades.find((c) => c.id !== cid)?.id ?? "");
  };

  if (!loaded) {
    return (
      <>
        <GlobalStyles />
        <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", color: C.textMid }}>
          <div style={{ textAlign: "center" }}>
            <svg width="64" height="64" viewBox="0 0 48 48" style={{ marginBottom: 16 }}>
              <rect x="8" y="14" width="32" height="5" rx="1.5" fill="#f59e0b"/>
              <line x1="13" y1="19" x2="13" y2="40" stroke="#3b82f6" strokeWidth="1.6"/>
              <line x1="19" y1="19" x2="19" y2="44" stroke="#3b82f6" strokeWidth="1.6"/>
              <line x1="24" y1="19" x2="24" y2="42" stroke="#3b82f6" strokeWidth="1.6"/>
              <line x1="29" y1="19" x2="29" y2="44" stroke="#3b82f6" strokeWidth="1.6"/>
              <line x1="35" y1="19" x2="35" y2="40" stroke="#3b82f6" strokeWidth="1.6"/>
              <path d="M4 44 Q12 40 20 44 T36 44 T52 44" fill="none" stroke="#7a99b8" strokeWidth="1.5" opacity="0.6"/>
            </svg>
            Cargando datos...
          </div>
        </div>
      </>
    );
  }

  if (!role) {
    return (
      <>
        <GlobalStyles />
        <LoginScreen barcos={barcos}
          onLoginOficinista={() => { setRole("oficinista"); setTab("lista"); }}
          onLoginPatron={(bid) => { setRole("patron"); setPatronBarcoId(bid); }} />
      </>
    );
  }

  /* ── VISTA PATRÓN ── */
  if (role === "patron") {
    const barco = barcos.find((b) => b.id === patronBarcoId);
    return (
      <>
        <GlobalStyles />
        <div style={{ minHeight: "100vh", background: C.bg, color: C.text }}>
          <header style={{ background: "#0a1520", borderBottom: `1px solid ${C.border}`, padding: "0 20px", display: "flex", alignItems: "center", gap: 12, height: 52 }}>
            <svg width="28" height="28" viewBox="0 0 48 48">
              <rect x="8" y="14" width="32" height="5" rx="1.5" fill="#f59e0b"/>
              <line x1="13" y1="19" x2="13" y2="40" stroke="#3b82f6" strokeWidth="1.6"/>
              <line x1="19" y1="19" x2="19" y2="44" stroke="#3b82f6" strokeWidth="1.6"/>
              <line x1="24" y1="19" x2="24" y2="42" stroke="#3b82f6" strokeWidth="1.6"/>
              <line x1="29" y1="19" x2="29" y2="44" stroke="#3b82f6" strokeWidth="1.6"/>
              <line x1="35" y1="19" x2="35" y2="40" stroke="#3b82f6" strokeWidth="1.6"/>
              <path d="M4 44 Q12 40 20 44 T36 44 T52 44" fill="none" stroke="#7a99b8" strokeWidth="1.5" opacity="0.6"/>
            </svg>
            <div className="cond" style={{ fontSize: 16, fontWeight: 800, color: C.text, flex: 1 }}>
              {barco?.nombre}
              
            </div>
            <button onClick={() => { setRole(null); setPatronBarcoId(null); }}
              style={{ background: "transparent", border: `1px solid ${C.border2}`, color: C.textMid, padding: "5px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>
              Cerrar sesión
            </button>
          </header>
          {/* Selector de calidad para patrón */}
          <div style={{ background: "#0a1520", borderBottom: `1px solid ${C.border}`, display: "flex", overflowX: "auto", padding: "0 20px" }}>
            {calidades.map((c) => (
              <button key={c.id} onClick={() => setCalidadActiva(c.id)} style={{
                padding: "10px 16px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
                fontFamily: "'Barlow Condensed', sans-serif", background: "transparent", whiteSpace: "nowrap",
                color: calidadActiva === c.id ? C.accentL : C.textDim,
                borderBottom: calidadActiva === c.id ? `2px solid ${C.accent}` : "2px solid transparent",
              }}>{c.nombre}</button>
            ))}
          </div>
          <main style={{ maxWidth: 640, margin: "0 auto", padding: "24px 20px" }}>
            <TabVistaBarco barcos={barcos} slots={slots} cierres={cierres} fixedBarcoId={patronBarcoId} exclusiones={exclusiones} calidadActiva={calidadActiva} />
          </main>
        </div>
      </>
    );
  }

  /* ── VISTA OFICINISTA ── */
  const calidadNombre = calidades.find((c) => c.id === calidadActiva)?.nombre ?? "";

  return (
    <>
      <GlobalStyles />
      <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Barlow', sans-serif" }}>
        {/* Header */}
        <header className="no-print" style={{ background: "#0a1520", borderBottom: `1px solid ${C.border}`, padding: "0 24px", display: "flex", alignItems: "center", gap: 16, height: 56 }}>
          <svg width="32" height="32" viewBox="0 0 48 48">
            <rect x="8" y="14" width="32" height="5" rx="1.5" fill="#f59e0b"/>
            <line x1="13" y1="19" x2="13" y2="40" stroke="#3b82f6" strokeWidth="1.6"/>
            <line x1="19" y1="19" x2="19" y2="44" stroke="#3b82f6" strokeWidth="1.6"/>
            <line x1="24" y1="19" x2="24" y2="42" stroke="#3b82f6" strokeWidth="1.6"/>
            <line x1="29" y1="19" x2="29" y2="44" stroke="#3b82f6" strokeWidth="1.6"/>
            <line x1="35" y1="19" x2="35" y2="40" stroke="#3b82f6" strokeWidth="1.6"/>
            <path d="M4 44 Q12 40 20 44 T36 44 T52 44" fill="none" stroke="#7a99b8" strokeWidth="1.5" opacity="0.6"/>
          </svg>
          <div>
            <div className="cond" style={{ fontSize: 18, fontWeight: 800, color: C.text, lineHeight: 1.1 }}>Sistema de Reparto de Pedidos</div>
            <div style={{ fontSize: 11, color: C.textDim, letterSpacing: "0.06em" }}>ASOCIACIÓN DE PRODUCTORES DE MEJILLÓN</div>
          </div>
          {pedidoActivo && (
            <div style={{ fontSize: 12, fontWeight: 700, color: C.accent, background: "#1a1400", border: `1px solid ${C.accent}50`, padding: "4px 14px", borderRadius: 20 }}>
              ⚠ Pedido en curso — {pedidoActivo.fecha} — {calidadNombre}
            </div>
          )}
          <button
            onClick={deshacer}
            disabled={undoCount === 0}
            title={ultimaAccion ? `Deshacer: ${ultimaAccion}` : "No hay nada que deshacer"}
            style={{
              marginLeft: "auto", display: "flex", alignItems: "center", gap: 6,
              background: undoCount === 0 ? "transparent" : "#1a2f45",
              border: `1px solid ${undoCount === 0 ? C.border : C.accent}50`,
              color: undoCount === 0 ? C.textDim : C.accentL,
              padding: "5px 14px", borderRadius: 8,
              cursor: undoCount === 0 ? "not-allowed" : "pointer",
              fontSize: 12, fontWeight: 700, opacity: undoCount === 0 ? 0.5 : 1,
            }}>
            ↩ Deshacer{undoCount > 0 ? ` (${undoCount})` : ""}
          </button>
          {ultimaAccion && (
            <span style={{ fontSize: 11, color: C.textDim, maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {ultimaAccion}
            </span>
          )}
          <button onClick={() => setRole(null)} style={{ background: "transparent", border: `1px solid ${C.border2}`, color: C.textMid, padding: "5px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>
            Cerrar sesión
          </button>
        </header>

        {/* Selector de calidades */}
        <div className="no-print" style={{ background: "#0d1c2b", borderBottom: `1px solid ${C.border2}`, display: "flex", overflowX: "auto", padding: "0 24px", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: C.textDim, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginRight: 8, whiteSpace: "nowrap" }}>Calidad:</span>
          {calidades.map((c) => (
            <button key={c.id} onClick={() => { setCalidadActiva(c.id); setPedidoActivo(null); }} style={{
              padding: "8px 18px", border: "none", cursor: "pointer",
              fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800,
              letterSpacing: "0.06em", background: "transparent", whiteSpace: "nowrap",
              color: calidadActiva === c.id ? "#fff" : C.textDim,
              borderBottom: calidadActiva === c.id ? `3px solid ${C.accent}` : "3px solid transparent",
              textTransform: "uppercase",
            }}>{c.nombre}</button>
          ))}
        </div>

        {/* Tabs de sección */}
        <nav className="no-print" style={{ background: "#0a1520", borderBottom: `1px solid ${C.border}`, display: "flex", overflowX: "auto", padding: "0 24px" }}>
          {TABS_OFICINISTA.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "11px 18px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
              letterSpacing: "0.04em", fontFamily: "'Barlow Condensed', sans-serif",
              background: "transparent", whiteSpace: "nowrap",
              color: tab === t.id ? C.accentL : C.textDim,
              borderBottom: tab === t.id ? `2px solid ${C.accent}` : "2px solid transparent",
            }}>{t.label}</button>
          ))}
        </nav>

        <main style={{ maxWidth: 960, margin: "0 auto", padding: "28px 24px" }}>
          {tab === "lista"     && <TabLista      slots={slots} barcos={barcos} cierres={cierres} calidadNombre={calidadNombre} setSlots={setSlots} exclusiones={exclusiones} calidadActiva={calidadActiva} />}
          {tab === "pedido"    && <TabPedido     slots={slots} barcos={barcos} cierres={cierres} setCierres={setCierres} setSlots={setSlots} setHistorial={setHistorial} pedidoActivo={pedidoActivo} setPedidoActivo={setPedidoActivo} calidadNombre={calidadNombre} exclusiones={exclusiones} setExclusiones={setExclusiones} rechazos={rechazos} setRechazos={setRechazos} calidadActiva={calidadActiva} snapshot={snapshot} />}
          {tab === "barcos"    && <TabBarcos     barcos={barcos} slots={slots} cierres={cierres} listas={listas} calidades={calidades} calidadNombre={calidadNombre} setBarcos={setBarcos} setSlots={setSlots} setSlotsTodas={setSlotsTodas} setCierres={setCierres} snapshot={snapshot} />}
          {tab === "cierres"   && <TabCierres    barcos={barcos} cierres={cierres} setCierres={setCierres} historial={historial} snapshot={snapshot} />}
          {tab === "exclusiones" && <TabExclusiones barcos={barcos} exclusiones={exclusiones} setExclusiones={setExclusiones} calidades={calidades} calidadActiva={calidadActiva} snapshot={snapshot} />}
          {tab === "historial" && <TabHistorial  historial={historial} calidadNombre={calidadNombre} />}
          {tab === "config"    && <TabConfiguracion barcos={barcos} setBarcos={setBarcos} calidades={calidades} addCalidad={addCalidad} deleteCalidad={deleteCalidad} listas={listas} exportarBackup={exportarBackup} importarBackup={importarBackup} />}
        </main>
      </div>
    </>
  );
}