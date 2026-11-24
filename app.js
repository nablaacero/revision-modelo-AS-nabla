/* Extensión "Revisión Nabla" (v2) para el visor 3D de Trimble Connect.
   No habla con ningún servidor propio: deja la solicitud en una carpeta del proyecto
   ("Revisiones Nabla/_cola") y lee de ahí el avance y los resultados que deja la PC de Nabla. */
(function () {
  "use strict";
  const VERSION = "2.3 (23-nov-2026)";
  const CFG = window.NABLA_CONFIG || {};
  const AVISO_APAGADO = CFG.avisoServidorApagado ||
    "Favor solicitar a Oscar Rodas que encienda su equipo y tener el servidor conectado.";
  const CARPETA = CFG.carpeta || "Revisiones Nabla";
  const COLA = "_cola";
  const MIN_LATIDO = CFG.minutosSinLatido || 3;
  const GRUPO = (CFG.grupoPermitido || "").trim();
  const SIEMPRE = (CFG.siempreAcceso || []).map((x) => String(x).toLowerCase());
  const API_REGION = {
    northamerica: "https://app.connect.trimble.com/tc/api/2.0",
    europe: "https://app21.connect.trimble.com/tc/api/2.0",
    asia: "https://app31.connect.trimble.com/tc/api/2.0",
    australia: "https://app32.connect.trimble.com/tc/api/2.0",
  };
  const LETRA = { choques: "C", pernos: "P", agujeros: "A" };
  const NOMBRES = { choques: "Choques", pernos: "Pernos", agujeros: "Agujeros" };
  const COLUMNAS = {
    choques: ["Tipo", "Ensamble A", "Pieza A", "Ensamble B", "Pieza B", "Volumen cm3", "Interferencia mm"],
    pernos: ["Estado", "Perno", "Ø mm", "Ensamble (otro)", "Pieza (otro)", "Interferencia mm"],
    agujeros: ["Estado", "Ensamble", "Pieza", "Perno Ø", "Agujero estandar", "Agujero real"],
  };
  const GUIDS = { choques: ["GUID A", "GUID B"], pernos: ["GUID perno", "GUID otro"], agujeros: ["GUID pieza"] };

  const $ = (id) => document.getElementById(id);
  let api = null, token = null, proyecto = null, base = null, carpetaId = null, colaId = null;
  let modelos = [], solId = null, modeloTrabajo = null, resultados = {}, tabActual = null, sondeo = null;
  let latido = { visto: null, t: 0 };

  function msg(el, texto, clase) { el.textContent = texto; el.className = "msg" + (clase ? " " + clase : ""); }
  function aviso(el, texto) { el.textContent = texto || ""; el.classList.toggle("oculto", !texto); }
  const guardar = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const leer = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ API de Connect (token del usuario)
  async function tc(metodo, ruta, cuerpo, reintento) {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: Object.assign({ Authorization: "Bearer " + token, Accept: "application/json" },
        cuerpo ? { "Content-Type": "application/json" } : {}),
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (r.status === 401 && !reintento) { await espera(2500); return tc(metodo, ruta, cuerpo, true); }
    let d = null;
    try { d = await r.json(); } catch (e) {}
    if (!r.ok) {
      const e = new Error((d && (d.message || d.error)) || ("HTTP " + r.status));
      e.status = r.status;
      throw e;
    }
    return d;
  }
  async function items(carpeta) {
    const d = await tc("GET", "/folders/" + carpeta + "/items");
    const l = Array.isArray(d) ? d : (d && d.items) || [];
    for (const x of l) x._tipo = String(x.type || x.tp || "").toUpperCase();
    return l;
  }
  async function hija(padre, nombre, crear) {
    const l = await items(padre);
    const c = l.find((x) => x._tipo === "FOLDER" && x.name === nombre);
    if (c) return c.id;
    if (!crear) return null;
    return (await tc("POST", "/folders", { name: nombre, parentId: padre })).id;
  }
  async function baseDeRegion(loc) {
    const clave = String(loc || "northamerica").replace(/[\s_]/g, "").toLowerCase();
    try {
      const r = await fetch(API_REGION.northamerica + "/regions");
      for (const x of (await r.json()) || []) {
        const l = String(x.location || x.serviceRegion || "").toLowerCase();
        const a = x["tc-api"] || (x.origin ? x.origin.replace(/\/+$/, "") + "/tc/api/2.0" : "");
        if (l && a) API_REGION[l] = a.replace(/\/+$/, "");
      }
    } catch (e) {}
    return API_REGION[clave] || API_REGION.northamerica;
  }

  // ------------------------------------------------------------------ inicio
  function alEvento(evento, args) {
    if (evento === "extension.accessToken") {
      const nuevo = args && args.data;
      const primero = !token;
      token = nuevo;
      if (primero && token && proyecto) listo();
    }
  }

  async function iniciar() {
    $("version").textContent = "versión " + VERSION;
    try {
      api = await TrimbleConnectWorkspace.connect(window.parent, alEvento, 30000);
    } catch (e) {
      msg($("estado-con"), "Esta página debe abrirse como extensión dentro de Trimble Connect.", "err");
      return;
    }
    try { proyecto = await api.project.getCurrentProject(); } catch (e) { proyecto = await api.project.getProject(); }
    base = await baseDeRegion(proyecto.location);
    const r = await api.extension.requestPermission("accesstoken");
    if (r === "denied") {
      msg($("estado-con"), "No se dio permiso de acceso. Actívalo en la configuración de la extensión.", "err");
      return;
    }
    if (r && r !== "pending" && r !== "granted") token = r;
    if (token) listo();
    else msg($("estado-con"), "Acepta el permiso de acceso que pide Trimble Connect...");
  }

  // ------------------------------------------------------------------ acceso por grupo
  function lista(d) { return Array.isArray(d) ? d : (d && (d.items || d.users || d.data)) || []; }
  function correo(u) { return String(u.email || (u.user && u.user.email) || "").toLowerCase(); }

  async function tieneAcceso() {
    if (!GRUPO) return { ok: true };
    const yo = await tc("GET", "/users/me");
    const mio = String(yo.email || "").toLowerCase();
    if (SIEMPRE.includes(mio)) return { ok: true };
    let grupos;
    try { grupos = lista(await tc("GET", "/groups?projectId=" + encodeURIComponent(proyecto.id))); }
    catch (e) { return { ok: false, motivo: "No se pudo verificar el grupo " + GRUPO + " (" + e.message + ")." }; }
    const g = grupos.find((x) => String(x.name || "").trim().toLowerCase() === GRUPO.toLowerCase());
    if (!g) return { ok: false, motivo: "Este proyecto no tiene un grupo llamado " + GRUPO + "." };
    let miembros;
    try { miembros = lista(await tc("GET", "/groups/" + g.id + "/users")); }
    catch (e) { return { ok: false, motivo: "No se pudo verificar el grupo " + GRUPO + " (" + e.message + ")." }; }
    const ids = [yo.id, yo.tiduuid].filter(Boolean);
    const esta = miembros.some((u) => correo(u) === mio || ids.includes(u.id) || ids.includes(u.tiduuid) ||
                                      (u.user && ids.includes(u.user.id)));
    return esta ? { ok: true } : { ok: false, motivo: "" };
  }

  function bloquear(motivo) {
    for (const id of ["s-lanzar", "s-avance", "s-res"]) $(id).classList.add("oculto");
    aviso($("aviso-servidor"), "");
    $("estado-con").className = "msg";
    $("estado-con").innerHTML = "";
    const d = document.createElement("div");
    d.style.cssText = "padding:24px 4px;text-align:center;color:#6a6e79";
    const t = document.createElement("div");
    t.style.cssText = "font-size:28px;margin-bottom:8px";
    t.textContent = "🔒";
    const m = document.createElement("div");
    m.style.cssText = "font-weight:600;color:#252a2e;margin-bottom:6px";
    m.textContent = "Acceso solo para el grupo " + GRUPO;
    const n = document.createElement("div");
    n.textContent = motivo || "No perteneces al grupo " + GRUPO + " de este proyecto. Si necesitas una revisión, solicítala a un miembro de ese grupo.";
    d.append(t, m, n);
    $("estado-con").appendChild(d);
  }

  async function listo() {
    if (!$("s-lanzar").classList.contains("oculto")) return;
    msg($("estado-con"), "Verificando acceso...");
    let acc;
    try { acc = await tieneAcceso(); } catch (e) { acc = { ok: false, motivo: "No se pudo verificar el acceso (" + e.message + ")." }; }
    if (!acc.ok) { bloquear(acc.motivo); return; }
    try {
      const p = await tc("GET", "/projects/" + proyecto.id);
      carpetaId = await hija(p.rootId, CARPETA, true);
      colaId = await hija(carpetaId, COLA, true);
    } catch (e) {
      msg($("estado-con"), "No se pudo preparar la carpeta \"" + CARPETA + "\" en la raíz del proyecto (" + e.message +
        "). Pide a un administrador del proyecto que abra este panel una vez.", "err");
      return;
    }
    msg($("estado-con"), "Proyecto: " + (proyecto.name || proyecto.id), "ok");
    $("s-lanzar").classList.remove("oculto");
    await revisarLatido(true);
    await leerModelos();
    const pend = leer("nabla_sol_" + proyecto.id);
    if (pend) { solId = pend; modeloTrabajo = leer("nabla_modelo_" + proyecto.id); seguir(); }
  }

  // ------------------------------------------------------------------ ¿está encendida la PC?
  async function revisarLatido(forzar) {
    if (!forzar && Date.now() - latido.t < 30000) return latido.ok;
    latido.t = Date.now();
    let ultimo = null;
    try {
      for (const x of await items(colaId)) {
        const m = /^servidor_activo__(\d{8})T(\d{6})Z/.exec(x.name || "");
        if (x._tipo === "FILE" && m) {
          const d = m[1], h = m[2];
          const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +h.slice(0, 2), +h.slice(2, 4), +h.slice(4, 6));
          if (!ultimo || t > ultimo) ultimo = t;
        }
      }
    } catch (e) { return latido.ok; }
    latido.ok = ultimo && Date.now() - ultimo < MIN_LATIDO * 60000;
    let txt = "";
    if (!latido.ok) {
      txt = "⚠ " + AVISO_APAGADO;
      if (!ultimo) txt += " (Si el panel se acaba de usar por primera vez en este proyecto, el servidor puede tardar hasta 3 min en detectarlo.)";
      else txt += " (Última señal del servidor: " + new Date(ultimo).toLocaleString() + ")";
    }
    aviso($("aviso-servidor"), txt);
    return latido.ok;
  }

  async function leerModelos() {
    const sel = $("modelo");
    sel.innerHTML = "";
    modelos = [];
    let lista = [], vistos = [], todos = [], err = "";
    try { lista = await api.viewer.getModels("loaded"); } catch (e) { err = e.message || String(e); }
    if (!lista || !lista.length) {
      try { todos = await api.viewer.getModels(); } catch (e) { err = err || e.message || String(e); }
      lista = (todos || []).filter((m) => String(m.state || "").toLowerCase() === "loaded");
    }
    for (const m of lista || []) {
      let fe = {}, f = null;
      try { f = await api.viewer.getLoadedModel(m.id); } catch (e) {}
      if (f) fe = Object.assign({}, f.file || {}, { name: (f.file && f.file.name) || f.name, id: (f.file && f.file.id) || f.id });
      // si el visor no da el archivo, se pregunta a Connect con los identificadores del modelo
      for (const cand of [fe.id, m.id, m.versionId]) {
        if (fe.name && fe.id) break;
        if (!cand) continue;
        try { const x = await tc("GET", "/files/" + cand); fe = Object.assign({}, x, { id: x.id || cand }); } catch (e) {}
      }
      const nombre = fe.name || m.name || "";
      const esIfc = /\.ifc$/i.test(nombre) || /ifc/i.test(String(m.type || ""));
      vistos.push(nombre + " [" + (m.type || "?") + "]");
      if (!esIfc || !fe.id) continue;
      modelos.push({ modelId: m.id, fileId: fe.id, nombre: /\.ifc$/i.test(nombre) ? nombre : nombre + ".ifc",
                     mb: fe.size ? Math.round(fe.size / 1048576) : null });
    }
    for (const [i, m] of modelos.entries()) {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = m.nombre + (m.mb ? " (" + m.mb + " MB)" : "");
      sel.appendChild(o);
    }
    if (!modelos.length) {
      const o = document.createElement("option");
      o.textContent = vistos.length ? "Ningún IFC entre los modelos abiertos" : "Abre un modelo IFC en el visor y presiona ↻";
      sel.appendChild(o);
      msg($("msg-lanzar"), vistos.length ? "Modelos abiertos en el visor: " + vistos.join(", ")
        : "El visor no reporta modelos cargados (" + (todos || []).length + " en el árbol" +
          (todos && todos.length ? ": " + todos.slice(0, 5).map((m) => (m.name || m.id) + " [" + (m.state || "?") + "]").join(", ") : "") +
          (err ? "; error: " + err : "") + ")", "err");
    }
    $("b-revisar").disabled = !modelos.length;
  }

  // ------------------------------------------------------------------ solicitud
  async function revisar() {
    const m = modelos[+$("modelo").value];
    const revs = ["choques", "pernos", "agujeros"].filter((r) => $("r-" + r).checked);
    if (!m) return;
    if (!revs.length) { msg($("msg-lanzar"), "Marca al menos una revisión.", "err"); return; }
    $("b-revisar").disabled = true;
    msg($("msg-lanzar"), "Enviando solicitud...");
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const nombre = "SOL_" + ts + "_" + revs.map((r) => LETRA[r]).join("") + "_" + m.fileId;
    try {
      const f = await tc("POST", "/folders", { name: nombre, parentId: colaId });
      solId = f.id;
      modeloTrabajo = m.modelId;
      guardar("nabla_sol_" + proyecto.id, solId);
      guardar("nabla_modelo_" + proyecto.id, m.modelId);
      msg($("msg-lanzar"), "");
      $("s-res").classList.add("oculto");
      seguir();
    } catch (e) {
      msg($("msg-lanzar"), "No se pudo enviar la solicitud: " + e.message, "err");
      $("b-revisar").disabled = false;
    }
  }

  function formatoEta(seg) {
    if (!seg) return "";
    const fin = new Date(Date.now() + seg * 1000);
    const min = Math.max(1, Math.round(seg / 60));
    return "Tiempo restante ≈ " + (min >= 60 ? Math.floor(min / 60) + " h " + (min % 60) + " min" : min + " min") +
      " (termina aprox. " + fin.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ")";
  }

  function seguir() {
    $("s-avance").classList.remove("oculto");
    $("b-revisar").disabled = true;
    clearTimeout(sondeo);
    const paso = async () => {
      let l;
      try { l = await items(solId); } catch (e) {
        if (e.status === 404) { terminar(); $("s-avance").classList.add("oculto"); return; }
        sondeo = setTimeout(paso, 10000);
        return;
      }
      const est = l.find((x) => x._tipo === "FILE" && /^estado__/.test(x.name || ""));
      const p = est ? est.name.replace(/\.txt$/, "").split("__") : null;
      const estado = p ? p[1] : "enviada", pct = p ? +p[2] : 0, eta = p ? +p[3] : 0, txt = p ? p.slice(4).join("__") : "";
      const encendido = await revisarLatido(false);
      $("av-paso").className = estado === "error" ? "err" : "";
      $("av-barra").classList.toggle("indef", estado === "enviada" || estado === "cola");
      $("av-i").style.width = (estado === "listo" ? 100 : pct) + "%";
      if (estado === "enviada") {
        $("av-paso").textContent = "Solicitud enviada; esperando al servidor...";
        $("av-tiempo").textContent = "";
      } else if (estado === "cola") {
        $("av-paso").textContent = txt || "En cola";
        $("av-tiempo").textContent = "";
      } else if (estado === "trabajando") {
        $("av-paso").textContent = (txt || "Trabajando") + " · " + pct + " %";
        $("av-tiempo").textContent = formatoEta(eta);
      } else if (estado === "listo") {
        $("av-paso").textContent = "Terminado · " + txt;
        $("av-tiempo").textContent = "";
      } else if (estado === "error") {
        $("av-paso").textContent = txt || "Error";
        $("av-tiempo").textContent = "El detalle está en registro.txt dentro de la carpeta de la solicitud.";
      }
      aviso($("av-aviso"), !encendido && estado !== "listo" && estado !== "error"
        ? "⚠ El servidor no está respondiendo. " + AVISO_APAGADO : "");
      if (estado === "listo") {
        terminar();
        const rj = l.find((x) => x._tipo === "FILE" && x.name === "resultados.json");
        if (rj) cargarResultados(rj.id);
        else sondeo = setTimeout(paso, 5000);
      } else if (estado === "error") {
        terminar();
      } else {
        sondeo = setTimeout(paso, 8000);
      }
    };
    paso();
  }

  function terminar() {
    $("b-revisar").disabled = false;
    guardar("nabla_sol_" + proyecto.id, null);
  }

  async function cargarResultados(fileId) {
    try {
      const u = await tc("GET", "/files/fs/" + fileId + "/downloadurl");
      const r = await fetch(u.url);
      const d = await r.json();
      mostrarResultados(d);
    } catch (e) {
      $("s-res").classList.remove("oculto");
      $("tabs").innerHTML = "";
      $("thead").innerHTML = $("tbody").innerHTML = "";
      msg($("res-info"), "La revisión terminó, pero no se pudo cargar la tabla aquí (" + e.message +
        "). Los CSV e IFC coloreados están en la carpeta \"" + CARPETA + "\" junto al modelo.", "err");
    }
  }

  // ------------------------------------------------------------------ resultados
  function mostrarResultados(d) {
    resultados = d.resultados || {};
    const tabs = $("tabs");
    tabs.innerHTML = "";
    const claves = Object.keys(resultados);
    for (const k of claves) {
      const b = document.createElement("button");
      const r = resultados[k];
      b.textContent = NOMBRES[k] + " (" + (k === "agujeros" ? r.con_problema : r.total) + ")";
      b.onclick = () => verTab(k);
      b.dataset.k = k;
      tabs.appendChild(b);
    }
    $("res-sub").textContent = (d.subidos && d.subidos.length
      ? "Guardado en Connect, carpeta \"" + CARPETA + "\" junto al modelo: " + d.subidos.join(", ") : "") +
      (d.segundos ? " · tardó " + Math.round(d.segundos / 60) + " min" : "");
    $("s-res").classList.remove("oculto");
    if (claves.length) verTab(claves[0]);
  }

  function filasFiltradas() {
    const r = resultados[tabActual];
    const f = $("filtro").value.trim().toLowerCase();
    if (!f) return r.filas;
    return r.filas.filter((x) => Object.values(x).some((v) => String(v).toLowerCase().includes(f)));
  }

  function verTab(k) {
    tabActual = k;
    for (const b of $("tabs").children) b.classList.toggle("act", b.dataset.k === k);
    pintarTabla();
  }

  function pintarTabla() {
    const r = resultados[tabActual];
    const cols = COLUMNAS[tabActual].filter((c) => r.columnas.includes(c));
    $("thead").innerHTML = "";
    const trh = document.createElement("tr");
    for (const c of cols) { const th = document.createElement("th"); th.textContent = c; trh.appendChild(th); }
    $("thead").appendChild(trh);
    const tb = $("tbody");
    tb.innerHTML = "";
    const filas = filasFiltradas();
    const frag = document.createDocumentFragment();
    for (const fila of filas.slice(0, 1500)) {
      const tr = document.createElement("tr");
      for (const c of cols) {
        const td = document.createElement("td");
        if (c === "Tipo" || c === "Estado") {
          const s = document.createElement("span");
          s.className = "et" + (/mismo|corto|largo|menor|sobre/i.test(fila[c]) ? " n" : "");
          s.textContent = fila[c];
          td.appendChild(s);
        } else td.textContent = fila[c];
        tr.appendChild(td);
      }
      tr.onclick = () => {
        for (const x of tb.querySelectorAll("tr.sel")) x.classList.remove("sel");
        tr.classList.add("sel");
        irA(fila);
      };
      frag.appendChild(tr);
    }
    tb.appendChild(frag);
    $("res-info").className = "msg";
    $("res-info").textContent = filas.length + " filas" + (filas.length > 1500 ? " (se muestran 1500; usa el filtro)" : "") +
      (r.mostradas < r.con_problema ? " · se enviaron " + r.mostradas + " de " + r.con_problema + "; el CSV completo está en Connect" : "") +
      " · clic en una fila para ir a la pieza";
  }

  async function runtimeIds(guids) {
    const out = [];
    for (let i = 0; i < guids.length; i += 2000) {
      const ids = await api.viewer.convertToObjectRuntimeIds(modeloTrabajo, guids.slice(i, i + 2000));
      for (const x of ids || []) if (x != null && x >= 0) out.push(x);
    }
    return out;
  }

  async function irA(fila) {
    const guids = GUIDS[tabActual].map((c) => fila[c]).filter(Boolean);
    try {
      const ids = await runtimeIds(guids);
      if (!ids.length) { msg($("res-info"), "Esas piezas no se encontraron en el modelo abierto (¿es la misma versión?).", "err"); return; }
      const selector = { modelObjectIds: [{ modelId: modeloTrabajo, objectRuntimeIds: ids }] };
      await api.viewer.setSelection(selector, "set");
      await api.viewer.setCamera(selector, { animationTime: 500 });
    } catch (e) {
      msg($("res-info"), "No se pudo seleccionar en el visor: " + e.message, "err");
    }
  }

  async function colorearTodo() {
    const guids = [];
    for (const f of filasFiltradas()) for (const c of GUIDS[tabActual]) if (f[c]) guids.push(f[c]);
    msg($("res-info"), "Coloreando " + guids.length + " piezas...");
    try {
      await api.viewer.setObjectState(undefined, { color: { r: 170, g: 170, b: 170, a: 90 } });
      const ids = await runtimeIds([...new Set(guids)]);
      await api.viewer.setObjectState({ modelObjectIds: [{ modelId: modeloTrabajo, objectRuntimeIds: ids }] }, { color: "#DA212C" });
      msg($("res-info"), ids.length + " piezas en rojo; el resto en gris transparente.");
    } catch (e) {
      msg($("res-info"), "No se pudo colorear: " + e.message, "err");
    }
  }

  async function limpiar() {
    try {
      await api.viewer.setObjectState(undefined, { color: "reset", visible: "reset" });
      await api.viewer.setSelection({ modelObjectIds: [] }, "set");
    } catch (e) {}
    for (const x of $("tbody").querySelectorAll("tr.sel")) x.classList.remove("sel");
  }

  async function diagnosticar() {
    const pasos = [];
    const p = async (n, f) => { try { pasos.push("✔ " + n + ": " + ((await f()) || "OK")); return true; } catch (e) { pasos.push("✘ " + n + ": " + e.message); return false; } };
    msg($("msg-lanzar"), "Probando...");
    await p("API de la región", async () => (proyecto.location || "?") + " → " + base);
    await p("Usuario", async () => { const u = await tc("GET", "/users/me"); return u.email; });
    await p("Carpeta buzón", async () => CARPETA + "/" + COLA + (colaId ? " lista" : " no encontrada"));
    await p("Servidor de Nabla", async () => { if (!(await revisarLatido(true))) throw new Error("sin señal reciente"); return "activo"; });
    const m = modelos[+$("modelo").value];
    if (m) await p("Archivo del modelo", async () => { const f = await tc("GET", "/files/" + m.fileId); return f.name; });
    $("msg-lanzar").innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "11px";
    pre.textContent = pasos.join("\n");
    $("msg-lanzar").appendChild(pre);
  }

  $("b-revisar").onclick = revisar;
  $("b-diag").onclick = diagnosticar;
  $("b-recargar").onclick = leerModelos;
  $("b-colorear").onclick = colorearTodo;
  $("b-reset").onclick = limpiar;
  let tf;
  $("filtro").oninput = () => { clearTimeout(tf); tf = setTimeout(pintarTabla, 250); };
  setInterval(() => { if (colaId && $("s-avance").classList.contains("oculto")) revisarLatido(false); }, 60000);
  iniciar();
})();
