// Thin client for the netmap server API. Pass a different base to embed the map elsewhere.
export function makeApi(base = "") {
  const req = async (method, path, body) => {
    const r = await fetch(base + path, {
      method, cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  return {
    graph: () => req("GET", "/api/graph"),
    devices: () => req("GET", "/api/devices"),
    addDevice: (d) => req("POST", "/api/devices", d),
    updateDevice: (id, d) => req("PATCH", `/api/devices/${id}`, d),
    deleteDevice: (id) => req("DELETE", `/api/devices/${id}`),
    startSetup: (d) => req("POST", "/api/setup", d),
    proxmoxNodes: (d) => req("POST", "/api/proxmox/nodes", d),
    setupStatus: (id) => req("GET", `/api/setup/${id}`),
    pollDevice: (id) => req("POST", `/api/devices/${id}/poll`),
    pauseDevice: (id, minutes) => req("POST", `/api/devices/${id}/pause`, { minutes }),
    savePositions: (nodes) => req("PUT", "/api/positions", { nodes }),
    resetPositions: () => req("DELETE", "/api/positions"),
    labelClient: (mac, label) => req("PATCH", `/api/clients/${mac}`, { label }),
    placeClient: (mac, device, port) => req("PATCH", `/api/clients/${mac}`, { placed_device: device, placed_port: port }),
    setUplink: (id, device, port) => req("PUT", `/api/devices/${id}/uplink`, { device, port }),
    addLink: (l) => req("POST", "/api/links", l),
    deleteLink: (id) => req("DELETE", `/api/links/${id}`)
  };
}
