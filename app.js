/* Extensión "Revisión Nabla" para el visor 3D de Trimble Connect.
   Habla con Connect (Workspace API) y con el servidor Python de Nabla (config.js). */
(function () {
  "use strict";
  const SERVIDOR = (window.NABLA_CONFIG && window.NABLA_CONFIG.servidor || "").replace(/\/+$/, "");
  const AVISO_APAGADO = (window.NABLA_CONFIG && window.NABLA_CONFIG.avisoServidorApagado) ||
    "Favor solicitar a Oscar Rodas que encienda su equipo y tener (servidor y túnel) conectados.";
  const $ = (id) => document.getElementById(id);
  let api = null, token = null, proyecto = null, modelos = [], trabajoId = null, tokenEnviado = null;
  let resultados = {}, tabActual = null, modeloTrabajo = null, sondeo = null;

  const COLUMNAS = {
    choques: ["Tipo", "Ensamble A", "Pieza A", "Ensamble B", "Pieza B", "Volumen cm3", "Interferencia mm"],
    pernos: ["Estado", "Perno", "Ø mm", "Ensamble (otro)", "Pieza (otro)", "Interferencia mm"],
    agujeros: ["Estado", "Ensamble", "Pieza", "Perno Ø", "Agujero estandar", "Agujero real"],
  };
  const GUIDS = {
    choques: ["GUID A", "GUID B"],
    pernos: ["GUID perno", "GUID otro"],
    agujeros: ["GUID pieza"],
  };
  const NOMBRES = { choques: "Choques", pernos: "Pernos", agujeros: "Agujeros" };

  function msg(el, texto, clase) {
    el.textContent = texto;
    el.className = "msg" + (clase ? " " + clase : "");
  }
  const guardar = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const leer = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

  // ------------------------------------------------------------------ Connect
  function alEvento(evento, args) {
    if (evento === "extension.accessToken") {
      token = args && args.data;
      if (token && proyecto) listo();
      enviarToken();
    }
  }

  async function iniciar() {
    if (!SERVIDOR || SERVIDOR.includes("TU-")) {
      msg($("estado-con"), "Falta configurar la dirección del servidor en config.js", "err");
      return;
    }
    try {
      api = await TrimbleConnectWorkspace.connect(window.parent, alEvento, 30000);
    } catch (e) {
      msg($("estado-con"), "Esta página debe abrirse como extensión dentro de Trimble Connect.", "err");
      return;
    }
    try {
      proyecto = await (api.project.getCurrentProject ? api.project.getCurrentProject() : api.project.getProject());
    } catch (e) {
      proyecto = await api.project.getProject();
    }
    const r = await api.extension.requestPermission("accesstoken");
    if (r && r !== "pending" && r !== "denied" && r !== "granted") token = r;
    if (r === "denied") {
      msg($("estado-con"), "No se dio permiso de acceso. Actívalo en la configuración de la extensión.", "err");
      return;
    }
    if (token) listo();
    else msg($("estado-con"), "Acepta el permiso de acceso que pide Trimble Connect...");
  }

  async function listo() {
    if (!$("s-lanzar").classList.contains("oculto")) return;
    let salud = null;
    try {
      salud = await servidor("GET", "/salud");
    } catch (e) {}
    if (!salud || !salud.ok) {
      msg($("estado-con"), "⚠ " + AVISO_APAGADO + " (se vuelve a intentar cada 15 s)", "err");
      setTimeout(() => { $("s-lanzar").classList.add("oculto"); listo(); }, 15000);
      return;
    }
    msg($("estado-con"), "Proyecto: " + (proyecto.name || proyecto.id) + " · servidor conectado" +
      (salud.trabajando || salud.en_cola ? " (ocupado: " + (salud.trabajando + salud.en_cola) + " en proceso)" : ""), "ok");
    $("s-lanzar").classList.remove("oculto");
    await leerModelos();
    const pend = leer("nabla_trabajo");
    if (pend) { trabajoId = pend; seguir(); }
  }

  async function leerModelos() {
    const sel = $("modelo");
    sel.innerHTML = "";
    modelos = [];
    let lista = [];
    try { lista = await api.viewer.getModels("loaded"); } catch (e) {}
    for (const m of lista || []) {
      let f = null;
      try { f = await api.viewer.getLoadedModel(m.id); } catch (e) {}
      const fe = (f && f.file) || {};
      const nombre = fe.name || (f && f.name) || m.name || "";
      if (!/\.ifc$/i.test(nombre)) continue;
      modelos.push({ modelId: m.id, fileId: fe.id || (f && f.id), parentId: fe.parentId || null,
                     nombre: nombre, mb: fe.size ? Math.round(fe.size / 1048576) : null });
    }
    for (const [i, m] of modelos.entries()) {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = m.nombre + (m.mb ? " (" + m.mb + " MB)" : "");
      sel.appendChild(o);
    }
    if (!modelos.length) {
      const o = document.createElement("option");
      o.textContent = "Abre un modelo IFC en el visor y presiona ↻";
      sel.appendChild(o);
    }
    $("b-revisar").disabled = $("b-diag").disabled = !modelos.length;
  }

  // ------------------------------------------------------------------ servidor
  async function servidor(metodo, ruta, cuerpo) {
    const r = await fetch(SERVIDOR + ruta, {
      method: metodo,
      headers: Object.assign({ "ngrok-skip-browser-warning": "1" },
        token ? { Authorization: "Bearer " + token } : {},
        cuerpo ? { "Content-Type": "application/json" } : {}),
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    let d = {};
    try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    return d;
  }

  function pedido(m) {
    return { projectId: proyecto.id, location: proyecto.location, fileId: m.fileId,
             parentId: m.parentId, fileName: m.nombre };
  }

  async function revisar() {
    const m = modelos[+$("modelo").value];
    const revs = ["choques", "pernos", "agujeros"].filter((r) => $("r-" + r).checked);
    if (!m) return;
    if (!revs.length) { msg($("msg-lanzar"), "Marca al menos una revisión.", "err"); return; }
    $("b-revisar").disabled = true;
    msg($("msg-lanzar"), "Enviando...");
    try {
      const t = await servidor("POST", "/trabajos", Object.assign(pedido(m), { revisiones: revs }));
      trabajoId = t.id;
      tokenEnviado = token;
      guardar("nabla_trabajo", t.id);
      guardar("nabla_modelo", m.modelId);
      msg($("msg-lanzar"), "");
      seguir();
    } catch (e) {
      msg($("msg-lanzar"), "No se pudo iniciar: " + e.message, "err");
      $("b-revisar").disabled = false;
    }
  }

  async function diagnosticar() {
    const m = modelos[+$("modelo").value];
    msg($("msg-lanzar"), "Probando conexión (usuario, proyecto, descarga y subida de prueba)...");
    try {
      const d = await servidor("POST", "/diagnostico", m ? pedido(m) : { projectId: proyecto.id, location: proyecto.location });
      const txt = d.pasos.map((p) => (p.ok ? "✔ " : "✘ ") + p.paso + ": " + p.detalle).join("\n");
      $("msg-lanzar").innerHTML = "";
      const pre = document.createElement("pre");
      pre.style.whiteSpace = "pre-wrap";
      pre.style.fontSize = "11px";
      pre.textContent = txt;
      $("msg-lanzar").appendChild(pre);
    } catch (e) {
      msg($("msg-lanzar"), "Falló el diagnóstico: " + e.message, "err");
    }
  }

  async function enviarToken() {
    if (!trabajoId || !token || token === tokenEnviado) return;
    try { await servidor("POST", "/trabajos/" + trabajoId + "/token", {}); tokenEnviado = token; } catch (e) {}
  }

  function seguir() {
    $("s-avance").classList.remove("oculto");
    $("b-revisar").disabled = true;
    clearTimeout(sondeo);
    const paso = async () => {
      let t;
      try {
        t = await servidor("GET", "/trabajos/" + trabajoId);
      } catch (e) {
        if (/no encontrado/i.test(e.message)) { fin(); $("s-avance").classList.add("oculto"); return; }
        $("av-paso").className = "err";
        $("av-paso").textContent = "⚠ Se perdió la conexión con el servidor. " + AVISO_APAGADO;
        sondeo = setTimeout(paso, 8000);
        return;
      }
      $("av-paso").className = "";
      $("av-paso").textContent = t.estado === "en cola" ? "En cola" + (t.en_cola > 1 ? " (posición " + t.en_cola + ")" : "")
        : t.estado === "error" ? "Error" : t.paso;
      $("av-tiempo").textContent = t.archivo + " · " + Math.floor(t.segundos / 60) + " min " + (t.segundos % 60) + " s";
      const log = $("log");
      log.textContent = (t.log || []).join("\n");
      log.scrollTop = log.scrollHeight;
      if (t.estado === "listo") {
        fin();
        mostrarResultados(t);
      } else if (t.estado === "error") {
        fin();
        $("av-paso").className = "err";
        $("av-paso").textContent = "Error: " + (t.error || "");
      } else {
        enviarToken();
        sondeo = setTimeout(paso, 4000);
      }
    };
    paso();
  }

  function fin() {
    $("av-barra").classList.add("oculto");
    $("b-revisar").disabled = false;
    guardar("nabla_trabajo", null);
  }

  // ------------------------------------------------------------------ resultados
  function mostrarResultados(t) {
    resultados = t.resultados || {};
    const mid = leer("nabla_modelo");
    modeloTrabajo = mid || (modelos[+$("modelo").value] || {}).modelId;
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
    $("res-sub").textContent = t.subidos && t.subidos.length
      ? "Guardado en Connect, carpeta \"Revisiones Nabla\": " + t.subidos.join(", ") : "";
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
    $("res-info").textContent = filas.length + " filas" + (filas.length > 1500 ? " (se muestran 1500; usa el filtro)" : "") +
      (r.mostradas < r.con_problema ? " · el servidor envió " + r.mostradas + " de " + r.con_problema + "; el CSV completo está en Connect" : "") +
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
      await api.viewer.setObjectState({ modelObjectIds: [{ modelId: modeloTrabajo, objectRuntimeIds: ids }] },
        { color: "#DA212C" });
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

  $("b-revisar").onclick = revisar;
  $("b-diag").onclick = diagnosticar;
  $("b-recargar").onclick = leerModelos;
  $("b-colorear").onclick = colorearTodo;
  $("b-reset").onclick = limpiar;
  let tf;
  $("filtro").oninput = () => { clearTimeout(tf); tf = setTimeout(pintarTabla, 250); };
  iniciar();
})();
