// Configuración del panel "Revisión Nabla"
window.NABLA_CONFIG = {
  // Aviso que ven los usuarios cuando la PC del servidor no está atendiendo
  avisoServidorApagado: "Favor solicitar a Oscar Rodas que encienda su equipo y tener el servidor conectado.",
  // Carpeta (en la raíz del proyecto) que sirve de buzón. Debe coincidir con config.json del servidor.
  carpeta: "Revisiones Nabla",
  // Minutos sin "latido" del servidor para considerarlo apagado
  minutosSinLatido: 3,
  // Solo los miembros de este grupo del proyecto pueden usar el panel ("" = todos)
  grupoPermitido: "MODELADO",
  // Correos con acceso aunque no estén en el grupo
  siempreAcceso: ["oscar.rodas@gruponabla.com"]
};
