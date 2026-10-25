/* NATS NKey and .creds (JWT) authentication for the WebSocket client.
   The server sends a nonce in INFO; the client signs it with an Ed25519 key and sends the signature with either the public key (NKey)
   or the user JWT (.creds). Keys are used in the page and never stored. Needs WebCrypto Ed25519 (Chrome 137+, Firefox 129+, Safari 17+). */
(function () {
  const lib = DT.lib, B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const PREFIX_SEED = 18 << 3;                                                   // seeds start with "S"
  const TYPES = { operator: 14 << 3, server: 13 << 3, cluster: 2 << 3, account: 0, user: 20 << 3 };   // public key prefix bytes
  const PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

  const b32encode = bytes => {
    let bits = 0, val = 0, out = "";
    for (const b of bytes) { val = ((val << 8) | b) & 0xFFFFFF; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits) out += B32[(val << (5 - bits)) & 31];
    return out;
  };
  const crc16 = bytes => { let crc = 0; for (const b of bytes) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF; } return crc; };
  const withCrc = bytes => { const c = crc16(bytes); return Uint8Array.from([...bytes, c & 255, c >> 8]); };
  const b64url = bytes => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  lib.nkeyCrc16 = crc16;

  /* "S..." seed text -> { type, raw (32 bytes) }; throws with a reason when it is not a valid seed. */
  lib.nkeyDecodeSeed = function (seed) {
    const text = String(seed).trim();
    if (!/^S[A-Z2-7]+$/.test(text)) throw new Error("An NKey seed starts with S and uses only A-Z and 2-7.");
    const bytes = lib.base32Decode(text);
    if (bytes.length !== 36) throw new Error("That seed is the wrong length.");
    const body = bytes.subarray(0, 34), crc = bytes[34] | (bytes[35] << 8);
    if (crc16(body) !== crc) throw new Error("That seed has a typo: its checksum does not match.");
    if ((body[0] & 248) !== PREFIX_SEED) throw new Error("That is not a seed.");
    const type = ((body[0] & 7) << 5) | (body[1] >> 3), name = Object.keys(TYPES).find(k => TYPES[k] === type);
    if (!name) throw new Error("Unknown NKey type.");
    return { type: name, raw: body.slice(2) };
  };
  lib.nkeyEncodePublic = (type, pub) => b32encode(withCrc(Uint8Array.from([TYPES[type], ...pub])));
  lib.nkeyEncodeSeed = (type, raw) => { const t = TYPES[type]; return b32encode(withCrc(Uint8Array.from([PREFIX_SEED | (t >> 5), (t & 31) << 3, ...raw]))); };

  const importSeed = async raw => crypto.subtle.importKey("pkcs8", Uint8Array.from([...PKCS8, ...raw]), { name: "Ed25519" }, true, ["sign"]);
  /* seed -> { publicKey: "U...", sign(bytes) -> Uint8Array } */
  lib.nkeyFromSeed = async function (seed) {
    const { type, raw } = lib.nkeyDecodeSeed(seed);
    let key;
    try { key = await importSeed(raw); } catch (e) { throw new Error("This browser cannot do Ed25519 signatures, which NKey authentication needs (Chrome 137+, Firefox 129+, Safari 17+)."); }
    const pub = fromB64url((await crypto.subtle.exportKey("jwk", key)).x);
    return { type, publicKey: lib.nkeyEncodePublic(type, pub), sign: async data => new Uint8Array(await crypto.subtle.sign("Ed25519", key, data)) };
  };
  /* A fresh key pair as text: { seed, publicKey } (type "user" by default). */
  lib.nkeyGenerate = async function (type = "user") {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pk8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)), raw = pk8.slice(pk8.length - 32);
    const pub = fromB64url((await crypto.subtle.exportKey("jwk", pair.privateKey)).x);
    return { seed: lib.nkeyEncodeSeed(type, raw), publicKey: lib.nkeyEncodePublic(type, pub) };
  };

  /* The user JWT and seed out of a .creds file. */
  lib.natsParseCreds = function (text) {
    const jwt = /-----BEGIN NATS USER JWT-----\s+([A-Za-z0-9_.-]+)\s+------END NATS USER JWT------/.exec(text);
    const seed = /-----BEGIN USER NKEY SEED-----\s+(S[A-Z2-7]+)\s+------END USER NKEY SEED------/.exec(text);
    if (!jwt || !seed) throw new Error("This does not look like a NATS .creds file (it needs a user JWT and a user NKey seed).");
    return { jwt: jwt[1], seed: seed[1] };
  };

  /* What the client adds to CONNECT: { sig, nkey } for a bare NKey, { sig, jwt } for creds. nonce comes from INFO. */
  lib.natsSignNonce = async function ({ seed, jwt }, nonce) {
    if (!nonce) throw new Error("The server did not ask for a signature (no nonce in INFO). It may not be configured for NKey or JWT authentication.");
    const k = await lib.nkeyFromSeed(seed), sig = b64url(await k.sign(new TextEncoder().encode(nonce)));
    return jwt ? { sig, jwt } : { sig, nkey: k.publicKey };
  };
})();
