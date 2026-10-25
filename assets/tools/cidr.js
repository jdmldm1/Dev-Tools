(function () {
  const lib = DT.lib;

  lib.ipToInt = function (ip) {
    const p = String(ip).trim().split(".");
    if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || +x > 255)) throw new Error(`"${ip}" is not a valid IPv4 address`);
    return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
  };
  lib.intToIp = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const maskOf = p => p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;

  lib.parseCidr = function (text) {
    const m = /^\s*([\d.]+)\s*(?:\/\s*(\d{1,2})|\s+([\d.]+))?\s*$/.exec(text);
    if (!m) throw new Error("Use CIDR like 10.0.0.0/24 (or an IP with a netmask).");
    let prefix;
    if (m[2] !== undefined) prefix = +m[2];
    else if (m[3]) {
      const mk = lib.ipToInt(m[3]), bin = mk.toString(2).padStart(32, "0");
      if (!/^1*0*$/.test(bin)) throw new Error("That netmask is not contiguous.");
      prefix = bin.indexOf("0") === -1 ? 32 : bin.indexOf("0");
    } else prefix = 32;
    if (prefix > 32) throw new Error("Prefix must be 0-32.");
    const ip = lib.ipToInt(m[1]), mask = maskOf(prefix), net = (ip & mask) >>> 0, bc = (net | (~mask >>> 0)) >>> 0;
    const size = 2 ** (32 - prefix);
    const hosts = prefix >= 31 ? size : size - 2;
    const first = prefix >= 31 ? net : net + 1, last = prefix >= 31 ? bc : bc - 1;
    const o = lib.intToIp(net).split(".").map(Number);
    const cls = o[0] < 128 ? "A" : o[0] < 192 ? "B" : o[0] < 224 ? "C" : o[0] < 240 ? "D (multicast)" : "E (reserved)";
    const priv = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
    const special = o[0] === 127 ? "loopback" : (o[0] === 169 && o[1] === 254) ? "link-local" : (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ? "carrier-grade NAT" : priv ? "private (RFC 1918)" : "public";
    return { prefix, ip: lib.intToIp(ip), network: lib.intToIp(net), broadcast: lib.intToIp(bc), mask: lib.intToIp(mask), wildcard: lib.intToIp(~mask >>> 0), first: lib.intToIp(first), last: lib.intToIp(last), hosts, size, cls, special, netInt: net, bcInt: bc };
  };

  lib.cidrContains = (cidr, ip) => { const c = lib.parseCidr(cidr), n = lib.ipToInt(ip); return n >= c.netInt && n <= c.bcInt; };

  lib.splitCidr = function (cidr, newPrefix, max = 256) {
    const c = lib.parseCidr(cidr);
    if (newPrefix < c.prefix || newPrefix > 32) throw new Error(`New prefix must be between /${c.prefix} and /32.`);
    const count = 2 ** (newPrefix - c.prefix), step = 2 ** (32 - newPrefix), out = [];
    for (let i = 0; i < Math.min(count, max); i++) out.push(`${lib.intToIp(c.netInt + i * step)}/${newPrefix}`);
    return { blocks: out, total: count };
  };

  /* Smallest list of CIDR blocks covering exactly [start, end]. */
  lib.rangeToCidrs = function (a, b) {
    let s = lib.ipToInt(a), e = lib.ipToInt(b);
    if (s > e) throw new Error("Start address is after the end address.");
    const out = [];
    while (s <= e) {
      let size = 32;
      while (size > 0 && ((s & ~maskOf(size - 1)) >>> 0) === 0 && s + 2 ** (32 - (size - 1)) - 1 <= e) size--;
      out.push(`${lib.intToIp(s)}/${size}`);
      const next = s + 2 ** (32 - size);
      if (next > 0xffffffff) break;
      s = next;
    }
    return out;
  };

  DT.register({
    id: "cidr", name: "CIDR / Subnet Calculator", group: "Network & Security",
    desc: "IPv4 subnet math: network, broadcast, mask, usable host range, membership checks, splitting into smaller subnets, and IP range to CIDR blocks.",
    keywords: "subnet netmask ip address network cidr ipv4 range hosts wildcard vpc",
    render(root) {
      root.innerHTML = `
        <div class="opts"><input type="text" id="in" class="mono" style="max-width:300px" value="192.168.10.37/26" spellcheck="false" aria-label="CIDR"><span class="hint">e.g. 10.0.0.0/16 or "172.16.0.0 255.255.0.0"</span></div>
        <div class="status" id="st"></div><div id="res"></div>
        <div class="two">
          <div class="panel"><div class="lbl" style="margin-bottom:8px">Is this IP inside the network?</div><div class="opts"><input type="text" id="ip" aria-label="IP address" class="mono" placeholder="192.168.10.50" style="max-width:220px"></div><div id="ipr" class="mono"></div></div>
          <div class="panel"><div class="lbl" style="margin-bottom:8px">Split into subnets</div><div class="opts"><label>New prefix /<input type="number" id="np" min="1" max="32" value="28" style="width:80px"></label></div><div id="spl" class="mono" style="max-height:200px;overflow:auto"></div></div>
        </div>
        <div class="panel"><div class="lbl" style="margin-bottom:8px">IP range → CIDR blocks</div><div class="opts"><input type="text" id="r1" aria-label="Range start" class="mono" placeholder="10.0.0.5" style="width:170px"><span>to</span><input type="text" id="r2" aria-label="Range end" class="mono" placeholder="10.0.0.200" style="width:170px"></div><div id="rr" class="mono"></div></div>
        <p class="hint">IPv4 only. /31 (point-to-point) and /32 (single host) report all addresses as usable, per RFC 3021.</p>`;
      const $ = s => root.querySelector(s);
      function main() {
        try {
          const c = lib.parseCidr($("#in").value);
          DT.status($("#st"), "", "");
          $("#res").innerHTML = DT.kv([["Network", `${c.network}/${c.prefix}`], ["Netmask", c.mask], ["Wildcard", c.wildcard], ["Broadcast", c.broadcast], ["First usable", c.first], ["Last usable", c.last], ["Usable hosts", c.hosts.toLocaleString()], ["Total addresses", c.size.toLocaleString()], ["Class / type", `${c.cls} · ${c.special}`], ["Binary mask", c.mask.split(".").map(o => (+o).toString(2).padStart(8, "0")).join(".")]]);
          inside(); split();
        } catch (e) { $("#res").innerHTML = ""; DT.status($("#st"), "err", e.message); }
      }
      function inside() {
        const v = $("#ip").value.trim();
        if (!v) return $("#ipr").textContent = "";
        try { $("#ipr").innerHTML = lib.cidrContains($("#in").value, v) ? '<span style="color:var(--green)">Yes, inside.</span>' : '<span style="color:var(--bad)">No, outside.</span>'; } catch (e) { $("#ipr").textContent = e.message; }
      }
      function split() {
        try {
          const r = lib.splitCidr($("#in").value, +$("#np").value);
          $("#spl").innerHTML = `<div class="hint">${r.total.toLocaleString()} subnet${r.total === 1 ? "" : "s"}${r.total > r.blocks.length ? ` (showing ${r.blocks.length})` : ""}</div>` + r.blocks.map(b => DT.esc(b)).join("<br>");
        } catch (e) { $("#spl").textContent = e.message; }
      }
      function range() {
        const a = $("#r1").value.trim(), b = $("#r2").value.trim();
        if (!a || !b) return $("#rr").textContent = "";
        try { $("#rr").innerHTML = lib.rangeToCidrs(a, b).map(DT.esc).join("<br>"); } catch (e) { $("#rr").textContent = e.message; }
      }
      $("#in").addEventListener("input", DT.debounce(main, 120));
      $("#ip").addEventListener("input", inside); $("#np").addEventListener("input", split);
      $("#r1").addEventListener("input", range); $("#r2").addEventListener("input", range);
      main();
    },
  });
})();
