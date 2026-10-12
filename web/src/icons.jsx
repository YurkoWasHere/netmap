// Small line icons for the map (24x24, drawn with currentColor so they follow the theme and the node's colour),
// and the rules that pick one for a device or a client.
import { memo } from "react";

const P = {
  router: <><rect x="3" y="12" width="18" height="7" rx="2" /><path d="M7 12V7M17 12V7" /><path d="M7 15.5h.01M10.5 15.5h.01" /><path d="M14 15.5h4" /></>,
  ap: <><circle cx="12" cy="16" r="2.2" /><path d="M8.5 12.5a5 5 0 0 1 7 0M5.8 9.8a9 9 0 0 1 12.4 0" /><path d="M12 18.2V21" /></>,
  switch: <><rect x="2.5" y="8" width="19" height="9" rx="1.5" /><path d="M5.5 11.5h2v2.5h-2zM9.5 11.5h2v2.5h-2zM13.5 11.5h2v2.5h-2z" /><path d="M18 12.7h.01" /></>,
  "switch-plain": <><rect x="2.5" y="8" width="19" height="9" rx="1.5" strokeDasharray="2.5 2" /><path d="M5.5 11.5h2v2.5h-2zM9.5 11.5h2v2.5h-2zM13.5 11.5h2v2.5h-2z" /></>,
  server: <><rect x="4" y="3.5" width="16" height="7" rx="1.5" /><rect x="4" y="13.5" width="16" height="7" rx="1.5" /><path d="M7.5 7h.01M7.5 17h.01M11 7h5.5M11 17h5.5" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /></>,
  laptop: <><rect x="4.5" y="5" width="15" height="10" rx="1.2" /><path d="M2.5 18.5h19l-1.5-3.5h-16z" /></>,
  desktop: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M9 20h6M12 16v4" /></>,
  tv: <><rect x="2.5" y="5" width="19" height="12" rx="1.5" /><path d="M8 21h8M9 2.5l3 2.5 3-2.5" /></>,
  camera: <><path d="M3 7.5l13-3 1.5 6-13 3z" /><circle cx="14" cy="8.2" r="1.4" /><path d="M8 13.5l1.5 4H5.5M5.5 15v5" /></>,
  nas: <><rect x="5" y="3" width="14" height="18" rx="1.8" /><path d="M8.5 7.5h7M8.5 11h7M8.5 14.5h7" /><path d="M12 18h.01" /></>,
  printer: <><path d="M7 9V3.5h10V9" /><rect x="3.5" y="9" width="17" height="7.5" rx="1.5" /><path d="M7 14.5h10V20.5H7z" /></>,
  voip: <><path d="M5 4.5c0 8.3 6.2 14.5 14.5 14.5l1-3.5-3.8-1.7-1.9 1.9a10.6 10.6 0 0 1-5-5l1.9-1.9L10 5 6.5 4z" /></>,
  board: <><rect x="6" y="6" width="12" height="12" rx="1.5" /><rect x="9.5" y="9.5" width="5" height="5" /><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3" /></>,
  vm: <><path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z" /><path d="M4 7.2l8 4.4 8-4.4M12 11.6v9.6" /></>,
  device: <><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="12" cy="12" r="2.5" /></>
};

export const Icon = memo(function Icon({ name, size = 18, className }) {
  return (
    <svg className={"nm-ico " + (className || "")} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name] || P.device}
    </svg>
  );
});

// What kind of box a managed device is.
export function deviceIcon(d) {
  if (d.driver === "proxmox") return "server";
  if (d.driver === "none") return "switch-plain";
  if (d.driver === "snmp" || d.driver === "tplink" || d.driver === "dlink" || d.driver === "realtek") return "switch";
  // OpenWrt: the gateway and anything with a WAN is a router; a box that only serves Wi-Fi is an access point
  if (d.isRoot || (d.wan && d.wan.length)) return "router";
  if ((d.wifi || []).length && !(d.interfaces || []).some((i) => /^wan/.test(i.name) && i.up)) return "ap";
  return "router";
}

// A guess at what a client is, from how it's connected, its maker and its name. Unknowns get a generic box.
const RULES = [
  ["nas", /synology|qnap|western digital|asustor|terramaster|\bnas\b/i],
  ["camera", /hikvision|dahua|zhejiang|axis comm|reolink|amcrest|ubiquiti.*protect|camera|\bcam\d*\b|ipc\b|nvr/i],
  ["printer", /brother|epson|canon|lexmark|xerox|kyocera|printer|laserjet|officejet/i],
  ["voip", /audio ?codes|polycom|yealink|grandstream|cisco spa|snom|obihai|\bata\b|voip|\bmp20\d\b/i],
  ["board", /raspberry|espressif|arduino|\bpi\b|\brpi\b|esp32|esp8266|matrixpi/i],
  ["tv", /\btv\b|roku|chromecast|apple tv|fire ?tv|android tv|sonos|samsung electronics|lg electronics|vizio|tcl/i],
  ["phone", /iphone|ipad|android|galaxy|pixel|\bs\d{1,2}(-|\b)|-s\d{1,2}|oneplus|xiaomi|huawei|motorola|\bphone\b/i],
  ["laptop", /laptop|macbook|thinkpad|notebook|surface|chromebook|work-?lap/i],
  ["desktop", /desktop|\bpc\b|tower|workstation|giga-?byte|micro-star|msi\b|asustek|\bdell\b/i]
];
export function clientIcon(c) {
  if (c.via === "vm") return "vm";
  const text = [c.hostname, c.label, c.name, c.vendor].filter(Boolean).join(" ");
  for (const [icon, re] of RULES) if (re.test(text)) return icon;
  if (c.randomized && c.via === "wifi") return "phone"; // a private Wi-Fi MAC is almost always a phone or tablet
  if (/intel corporate|realtek|liteon|azurewave|apple/i.test(c.vendor || "")) return c.via === "wifi" ? "laptop" : "desktop";
  return "device";
}
