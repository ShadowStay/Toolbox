// Page script for pages/calculator.html. Everything runs in the browser; nothing is sent to the server.
//
//   text -> tokens -> syntax tree -> one of
//     ev()        a number, with units where the input has them
//     polyOf()    the same tree as a polynomial in the unknowns, which is how equations are solved exactly:
//                 linear and quadratic by formula, higher degrees by rational roots then numerically,
//                 linear systems by Gaussian elimination. Anything that is not a polynomial (2^x = 64,
//                 sin(x) = 0.5 ...) is solved numerically by scanning for sign changes.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  class CalcError extends Error {}
  class Unknown extends CalcError {
    constructor(name) { super(`Unknown variable "${name}". Write an equation such as ${name} + 1 = 5 to solve for it.`); this.varName = name; }
  }
  class NotPoly extends Error {}

  let angleMode = "rad", digits = 10;
  const userVars = new Map();            // name -> quantity, set with  a := 12
  let lastAns = null;

  // ======================================================================== units
  const BASE = ["m", "kg", "s", "K", "A", "mol", "cd", "bit", "rad"];
  const dimOf = (o) => BASE.map((k) => o[k] || 0);
  const NODIM = dimOf({});
  const same = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  const isScalar = (d) => d.every((x) => x === 0);
  const addD = (a, b, s) => a.map((x, i) => x + s * b[i]);

  const D = {
    len: { m: 1 }, area: { m: 2 }, vol: { m: 3 }, speed: { m: 1, s: -1 }, force: { kg: 1, m: 1, s: -2 },
    press: { kg: 1, m: -1, s: -2 }, energy: { kg: 1, m: 2, s: -2 }, power: { kg: 1, m: 2, s: -3 },
    volt: { kg: 1, m: 2, s: -3, A: -1 }, ohm: { kg: 1, m: 2, s: -3, A: -2 },
  };
  // [names, symbol, factor to SI, dimension, offset (temperatures), prefixes allowed (1 = SI, "bin" = SI and binary)]
  const ROWS = [
    ["m meter meters metre metres", "m", 1, D.len, 0, 1],
    ["in inch inches", "in", 0.0254, D.len],
    ["ft foot feet", "ft", 0.3048, D.len],
    ["yd yard yards", "yd", 0.9144, D.len],
    ["mi mile miles", "mi", 1609.344, D.len],
    ["nmi", "nmi", 1852, D.len],
    ["ly lightyear lightyears", "ly", 9460730472580800, D.len],
    ["g gram grams gramme grammes", "g", 0.001, { kg: 1 }, 0, 1],
    ["lb lbs pound pounds", "lb", 0.45359237, { kg: 1 }],
    ["oz ounce ounces", "oz", 0.028349523125, { kg: 1 }],
    ["tonne tonnes", "t", 1000, { kg: 1 }],
    ["s sec secs second seconds", "s", 1, { s: 1 }, 0, 1],
    ["min mins minute minutes", "min", 60, { s: 1 }],
    ["h hr hrs hour hours", "h", 3600, { s: 1 }],
    ["d day days", "d", 86400, { s: 1 }],
    ["wk week weeks", "wk", 604800, { s: 1 }],
    ["month months", "month", 2629800, { s: 1 }],
    ["yr year years", "yr", 31557600, { s: 1 }],
    ["K kelvin", "K", 1, { K: 1 }],
    ["C degC °C celsius", "°C", 1, { K: 1 }, 273.15],
    ["F degF °F fahrenheit", "°F", 5 / 9, { K: 1 }, (459.67 * 5) / 9],
    ["A amp amps ampere amperes", "A", 1, { A: 1 }, 0, 1],
    ["mol mole moles", "mol", 1, { mol: 1 }, 0, 1],
    ["cd candela", "cd", 1, { cd: 1 }],
    ["rad radian radians", "rad", 1, { rad: 1 }],
    ["deg degree degrees °", "°", Math.PI / 180, { rad: 1 }],
    ["L l liter liters litre litres", "L", 0.001, D.vol, 0, 1],
    ["gal gallon gallons", "gal", 0.003785411784, D.vol],
    ["qt quart quarts", "qt", 0.000946352946, D.vol],
    ["pt pint pints", "pt", 0.000473176473, D.vol],
    ["cup cups", "cup", 0.0002365882365, D.vol],
    ["floz", "fl oz", 0.0000295735295625, D.vol],
    ["tbsp", "tbsp", 0.00001478676478125, D.vol],
    ["tsp", "tsp", 0.00000492892159375, D.vol],
    ["ha hectare hectares", "ha", 10000, D.area],
    ["acre acres", "acre", 4046.8564224, D.area],
    ["mph", "mph", 0.44704, D.speed],
    ["kph kmh", "km/h", 1 / 3.6, D.speed],
    ["knot knots kn", "kn", 1852 / 3600, D.speed],
    ["N newton newtons", "N", 1, D.force, 0, 1],
    ["lbf", "lbf", 4.4482216152605, D.force],
    ["Pa pascal pascals", "Pa", 1, D.press, 0, 1],
    ["bar", "bar", 100000, D.press, 0, 1],
    ["atm", "atm", 101325, D.press],
    ["psi", "psi", 6894.757293168, D.press],
    ["mmHg torr", "mmHg", 133.322387415, D.press],
    ["J joule joules", "J", 1, D.energy, 0, 1],
    ["cal calorie calories", "cal", 4.184, D.energy, 0, 1],
    ["Wh", "Wh", 3600, D.energy, 0, 1],
    ["eV", "eV", 1.602176634e-19, D.energy, 0, 1],
    ["BTU btu", "BTU", 1055.05585262, D.energy],
    ["W watt watts", "W", 1, D.power, 0, 1],
    ["hp", "hp", 745.69987158227, D.power],
    ["Hz hertz", "Hz", 1, { s: -1 }, 0, 1],
    ["V volt volts", "V", 1, D.volt, 0, 1],
    ["ohm ohms Ω", "Ω", 1, D.ohm, 0, 1],
    ["bit bits", "bit", 1, { bit: 1 }, 0, "bin"],
    ["B byte bytes", "B", 8, { bit: 1 }, 0, "bin"],
  ];
  const ALIAS = new Map();
  for (const [names, sym, f, d, off = 0, pre = 0] of ROWS) {
    const row = { sym, f, d: dimOf(d), off, pre };
    for (const n of names.split(" ")) ALIAS.set(n, row);
  }
  const PREFIX = [["T", "tera", 1e12], ["G", "giga", 1e9], ["M", "mega", 1e6], ["k", "kilo", 1e3], ["d", "deci", 1e-1],
    ["c", "centi", 1e-2], ["m", "milli", 1e-3], ["µ", "micro", 1e-6], ["u", "", 1e-6], ["n", "nano", 1e-9], ["p", "pico", 1e-12]];
  const BINARY = [["Ki", "kibi", 1024], ["Mi", "mebi", 1024 ** 2], ["Gi", "gibi", 1024 ** 3], ["Ti", "tebi", 1024 ** 4]];
  const unitCache = new Map();
  function lookupUnit(name) {
    if (unitCache.has(name)) return unitCache.get(name);
    let u = ALIAS.get(name) || (name.length > 3 ? ALIAS.get(name.toLowerCase()) : undefined) || null;
    if (!u) {
      outer: for (const list of [PREFIX, BINARY]) {
        for (const [sym, word, f] of list) {
          for (const p of word ? [sym, word] : [sym]) {
            if (name.length <= p.length || !name.startsWith(p)) continue;
            const base = ALIAS.get(name.slice(p.length));
            if (base && base.pre && (list === PREFIX || base.pre === "bin")) { u = { ...base, sym: sym + base.sym, f: base.f * f, pre: 0 }; break outer; }
          }
        }
      }
    }
    unitCache.set(name, u);
    return u;
  }

  const SUPS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
  const sup = (n) => String(n).replace(/\d/g, (c) => SUPS[c]).replace("-", "⁻");
  const expStr = (e) => (e === 1 ? "" : Number.isInteger(e) ? sup(e) : "^" + e);
  function unitString(entries) {
    const num = entries.filter(([, e]) => e > 0).map(([s, e]) => s + expStr(e));
    const den = entries.filter(([, e]) => e < 0).map(([s, e]) => s + expStr(-e));
    let out = num.join("·") || (den.length ? "1" : "");
    if (den.length) out += "/" + (den.length > 1 ? `(${den.join("·")})` : den[0]);
    return out;
  }
  const DERIVED = [["N", D.force], ["Pa", D.press], ["J", D.energy], ["W", D.power], ["Hz", { s: -1 }], ["V", D.volt], ["Ω", D.ohm]]
    .map(([n, o]) => [n, dimOf(o)]);
  const KINDS = [["length", D.len], ["mass", { kg: 1 }], ["time", { s: 1 }], ["temperature", { K: 1 }], ["current", { A: 1 }],
    ["amount", { mol: 1 }], ["luminous intensity", { cd: 1 }], ["data", { bit: 1 }], ["angle", { rad: 1 }], ["area", D.area],
    ["volume", D.vol], ["speed", D.speed], ["force", D.force], ["pressure", D.press], ["energy", D.energy], ["power", D.power],
    ["frequency", { s: -1 }]].map(([n, o]) => [n, dimOf(o)]);
  function nameDim(d) {
    for (const [n, dd] of DERIVED) if (same(d, dd)) return n;
    return unitString(BASE.map((s, i) => [s, d[i]]).filter(([, e]) => e !== 0));
  }
  function dimName(d) {
    if (isScalar(d)) return "a plain number";
    for (const [n, dd] of KINDS) if (same(d, dd)) return n;
    return nameDim(d);
  }

  // A quantity: value in SI units, dimension, and "lab" = the units the person wrote, so 5 km + 300 m shows as km.
  const Q = (v, d = NODIM, lab = null) => ({ v, d, lab });
  function labMerge(a, b, s) {
    const out = new Map(a || []);
    for (const [k, u] of b || []) {
      const e = (out.get(k) ? out.get(k).e : 0) + s * u.e;
      if (Math.abs(e) < 1e-9) out.delete(k); else out.set(k, { ...u, e });
    }
    return out;
  }
  const labPow = (a, n) => { const out = new Map(); for (const [k, u] of a || []) out.set(k, { ...u, e: u.e * n }); return out; };
  const labOf = (u) => new Map([[u.sym, { e: 1, f: u.f, off: u.off, d: u.d }]]);

  // The number and unit to show for a quantity.
  function unitView(q) {
    if (isScalar(q.d)) return { value: q.v, unit: "" };
    const entries = q.lab ? [...q.lab.values()] : [];
    if (entries.length) {
      const d = entries.reduce((acc, u) => addD(acc, u.d, u.e), NODIM);
      let clash = false;                 // two units of one kind (km * m): fall back to SI
      for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
        if (same(entries[i].d, entries[j].d) || same(entries[i].d, entries[j].d.map((x) => -x))) clash = true;
      }
      if (!clash && same(d, q.d)) {
        const value = entries.length === 1 && entries[0].e === 1 && entries[0].off
          ? (q.v - entries[0].off) / entries[0].f
          : entries.reduce((v, u) => v / Math.pow(u.f, u.e), q.v);
        return { value, unit: unitString([...q.lab].map(([k, u]) => [k, u.e])) };
      }
    }
    return { value: q.v, unit: nameDim(q.d) };
  }

  // ======================================================================== numbers as text
  function fmtDec(x) {
    if (!isFinite(x)) return x > 0 ? "∞" : x < 0 ? "-∞" : "undefined";
    if (x === 0) return "0";
    const s = Number(x.toPrecision(digits)), a = Math.abs(s);
    if (a >= 1e15 || a < 1e-6) {
      const [m, e] = s.toExponential(digits - 1).split("e");
      return `${m.includes(".") ? m.replace(/\.?0+$/, "") : m}×10${sup(+e)}`;
    }
    return String(s);
  }
  const isApprox = (x) => isFinite(x) && x !== 0 && Math.abs(Number(x.toPrecision(digits)) - x) > 1e-14 * Math.abs(x);
  function toFrac(x, maxDen = 10000) {
    if (!isFinite(x) || Math.abs(x) > 1e9) return null;
    const sign = x < 0 ? -1 : 1, a = Math.abs(x);
    let h1 = 1, h2 = 0, k1 = 0, k2 = 1, y = a;
    for (let i = 0; i < 40; i++) {
      const ai = Math.floor(y), h = ai * h1 + h2, k = ai * k1 + k2;
      if (k > maxDen) break;
      h2 = h1; h1 = h; k2 = k1; k1 = k;
      if (Math.abs(a - h1 / k1) <= 1e-11 * Math.max(1, a)) return [sign * h1, k1];
      const rest = y - ai;
      if (rest < 1e-15) break;
      y = 1 / rest;
    }
    return null;
  }
  const nonTerminating = (q) => { while (q % 2 === 0) q /= 2; while (q % 5 === 0) q /= 5; return q > 1; };
  // {text, approx, copy}. 1/3 is shown as "1/3 ≈ 0.3333333333".
  function numText(x, fractions = true) {
    const dec = fmtDec(x);
    if (fractions && isFinite(x) && !Number.isInteger(x) && Math.abs(x) >= 1e-6) {
      const fr = toFrac(x);
      if (fr && fr[1] > 1 && nonTerminating(fr[1])) return { text: `${fr[0]}/${fr[1]} ≈ ${dec}`, approx: false, copy: dec };
    }
    return { text: dec, approx: isApprox(x), copy: dec };
  }

  // ======================================================================== tokens
  const NUM = /^(?:0x[0-9a-f]+|0b[01]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i;
  const IDENT = /^[A-Za-z_°µΩ\u0370-\u03ff][A-Za-z_0-9°µΩ\u0370-\u03ff]*/;
  const OPS = [":=", "<=", ">=", "!=", "==", "+", "-", "*", "/", "^", "(", ")", ",", ";", "=", "!", "%", "<", ">"];
  function tokenize(src) {
    const s = src.replace(/\*\*/g, "^").replace(/[×·∙]/g, "*").replace(/÷/g, "/").replace(/[−–—]/g, "-")
      .replace(/²/g, "^2").replace(/³/g, "^3").replace(/√/g, " sqrt ").replace(/π/g, " pi ").replace(/τ/g, " tau ")
      .replace(/φ/g, " phi ").replace(/∞/g, " inf ");
    const out = [];
    let i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      if (/^\s/.test(rest)) { i++; continue; }
      let m = rest.match(NUM);
      if (m) {
        const t = m[0].toLowerCase();
        out.push({ t: "num", v: t.startsWith("0b") ? parseInt(t.slice(2), 2) : Number(t) });
        i += m[0].length; continue;
      }
      m = rest.match(IDENT);
      if (m) { out.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
      const op = OPS.find((o) => rest.startsWith(o));
      if (op) { out.push({ t: "op", v: op }); i += op.length; continue; }
      throw new CalcError(`Unexpected "${rest[0]}"`);
    }
    return out;
  }
  function splitTop(toks) {              // equations are separated by , ; or "and" outside brackets
    const parts = [[]];
    let depth = 0;
    for (const t of toks) {
      if (t.t === "op" && t.v === "(") depth++;
      if (t.t === "op" && t.v === ")") depth--;
      if (depth === 0 && ((t.t === "op" && (t.v === "," || t.v === ";")) || (t.t === "id" && t.v === "and"))) { parts.push([]); continue; }
      parts[parts.length - 1].push(t);
    }
    return parts.filter((p) => p.length);
  }

  // ======================================================================== functions and constants
  const CONSTS = new Map([["pi", Math.PI], ["e", Math.E], ["tau", 2 * Math.PI], ["phi", (1 + Math.sqrt(5)) / 2], ["inf", Infinity]]);
  const F = Object.create(null);
  const tidy = (v) => (Math.abs(v) < 1e-14 ? 0 : v);
  const need = (a, n, name) => { if (a.length !== n) throw new CalcError(`${name}() takes ${n === 1 ? "one value" : n + " values"}`); };
  const scal = (q, name) => {
    if (!isScalar(q.d)) throw new CalcError(`${name}() needs a plain number, not a value with a unit`);
    return q.v;
  };
  const toRad = (q, name) => {
    if (same(q.d, dimOf({ rad: 1 }))) return q.v;
    if (isScalar(q.d)) return angleMode === "deg" ? (q.v * Math.PI) / 180 : q.v;
    throw new CalcError(`${name}() needs an angle or a plain number`);
  };
  const fromRad = (r) => (angleMode === "deg" ? (r * 180) / Math.PI : r);
  const real = (v) => { if (Number.isNaN(v)) throw new CalcError("That is outside the function's range"); return Q(v); };
  const plain = (name, g, aliases = []) => { F[name] = (a) => { need(a, 1, name); return real(g(scal(a[0], name))); }; aliases.forEach((n) => (F[n] = F[name])); };
  const trig = (name, g) => { F[name] = (a) => { need(a, 1, name); return Q(tidy(g(toRad(a[0], name)))); }; };
  const inv = (name, g) => { F[name] = (a) => { need(a, 1, name); return real(fromRad(g(scal(a[0], name)))); }; };
  trig("sin", Math.sin); trig("cos", Math.cos); trig("tan", Math.tan);
  inv("asin", Math.asin); inv("acos", Math.acos); inv("atan", Math.atan);
  plain("sinh", Math.sinh); plain("cosh", Math.cosh); plain("tanh", Math.tanh);
  plain("asinh", Math.asinh); plain("acosh", Math.acosh); plain("atanh", Math.atanh);
  plain("exp", Math.exp); plain("cbrt", Math.cbrt); plain("log2", Math.log2); plain("log10", Math.log10);
  plain("ln", (v) => { if (v <= 0) throw new CalcError("ln needs a positive number"); return Math.log(v); });
  plain("sign", Math.sign); plain("floor", Math.floor); plain("ceil", Math.ceil, ["ceiling"]); plain("trunc", Math.trunc);
  F.log = (a) => {
    if (a.length === 2) { const x = scal(a[0], "log"), b = scal(a[1], "log"); return real(Math.log(x) / Math.log(b)); }
    need(a, 1, "log");
    const x = scal(a[0], "log");
    if (x <= 0) throw new CalcError("log needs a positive number");
    return Q(Math.log10(x));
  };
  F.round = (a) => {
    if (a.length === 2) { const k = Math.pow(10, scal(a[1], "round")); return Q(Math.round(scal(a[0], "round") * k) / k); }
    need(a, 1, "round");
    return Q(Math.round(scal(a[0], "round")));
  };
  F.abs = (a) => { need(a, 1, "abs"); return Q(Math.abs(a[0].v), a[0].d, a[0].lab); };
  F.sqrt = (a) => {
    need(a, 1, "sqrt");
    const q = a[0];
    if (q.v < 0) throw new CalcError("The square root of a negative number isn't real. For complex roots use an equation such as x^2 = -4.");
    const d = q.d.map((e) => e / 2);
    if (!d.every((e) => Math.abs(e - Math.round(e)) < 1e-9)) throw new CalcError("Can't take the square root of that unit");
    return Q(Math.sqrt(q.v), d.map(Math.round), labPow(q.lab, 0.5));
  };
  F.root = (a) => {
    need(a, 2, "root");
    const x = scal(a[0], "root"), n = scal(a[1], "root");
    return real(x < 0 && n % 2 !== 0 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n));
  };
  F.hypot = (a) => Q(Math.hypot(...a.map((q) => scal(q, "hypot"))));
  F.atan2 = (a) => { need(a, 2, "atan2"); return Q(fromRad(Math.atan2(scal(a[0], "atan2"), scal(a[1], "atan2")))); };
  F.mod = (a) => { need(a, 2, "mod"); const x = scal(a[0], "mod"), y = scal(a[1], "mod"); if (y === 0) throw new CalcError("Division by zero"); return Q(x - y * Math.floor(x / y)); };
  const sameKind = (a, name) => {
    if (!a.length) throw new CalcError(`${name}() needs at least one value`);
    for (const q of a) if (!same(q.d, a[0].d)) throw new CalcError(`${name}() needs values of the same kind`);
  };
  F.max = (a) => { sameKind(a, "max"); return a.reduce((m, q) => (q.v > m.v ? q : m)); };
  F.min = (a) => { sameKind(a, "min"); return a.reduce((m, q) => (q.v < m.v ? q : m)); };
  F.sum = (a) => { sameKind(a, "sum"); return Q(a.reduce((s, q) => s + q.v, 0), a[0].d, a[0].lab); };
  F.mean = (a) => { sameKind(a, "mean"); return Q(a.reduce((s, q) => s + q.v, 0) / a.length, a[0].d, a[0].lab); };
  F.avg = F.average = F.mean;
  const whole = (q, name) => {
    const v = scal(q, name);
    if (!Number.isInteger(v) || v < 0) throw new CalcError(`${name}() needs whole numbers that are 0 or more`);
    return v;
  };
  F.factorial = (a) => {
    need(a, 1, "factorial");
    const n = whole(a[0], "factorial");
    if (n > 170) return Q(Infinity);
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return Q(r);
  };
  F.ncr = F.comb = F.choose = (a) => {
    need(a, 2, "ncr");
    const n = whole(a[0], "ncr"), k = whole(a[1], "ncr");
    if (k > n) return Q(0);
    const kk = Math.min(k, n - k);
    let r = 1;
    for (let i = 1; i <= kk; i++) r = (r * (n - kk + i)) / i;
    return Q(Math.round(r));
  };
  F.npr = F.perm = (a) => {
    need(a, 2, "npr");
    const n = whole(a[0], "npr"), k = whole(a[1], "npr");
    let r = 1;
    for (let i = 0; i < k; i++) r *= n - i;
    return Q(Math.max(0, r));
  };
  const gcd2 = (x, y) => { x = Math.abs(x); y = Math.abs(y); while (y) [x, y] = [y, x % y]; return x; };
  F.gcd = (a) => Q(a.map((q) => whole(q, "gcd")).reduce(gcd2));
  F.lcm = (a) => Q(a.map((q) => whole(q, "lcm")).reduce((x, y) => (x && y ? (x / gcd2(x, y)) * y : 0)));

  // ======================================================================== parser
  const KW = new Set(["to", "in", "of", "mod", "and"]);
  const CMP = ["=", "==", "!=", "<", ">", "<=", ">="];
  function parse(tokens, single) {         // single: letters like m, s, h, C count as units right after a number
    let p = 0;
    const peek = (o = 0) => tokens[p + o];
    const isOp = (v, o = 0) => { const t = tokens[p + o]; return !!t && t.t === "op" && t.v === v; };
    const expectOp = (v) => { if (!isOp(v)) throw new CalcError(v === ")" ? "Missing closing )" : `Expected ${v}`); p++; };
    const startsPrimary = (t) => !!t && ((t.t === "id" && !KW.has(t.v)) || (t.t === "op" && t.v === "("));

    function unitTerm(allowSingle) {
      const t = peek();
      if (!t || t.t !== "id" || userVars.has(t.v)) return null;
      if (t.v.length === 1 && !allowSingle) return null;
      const u = lookupUnit(t.v);
      if (!u) return null;
      p++;
      let node = { k: "unit", u };
      if (isOp("^")) {
        const save = p;
        p++;
        const neg = isOp("-");
        if (neg) p++;
        const n = peek();
        if (n && n.t === "num" && Number.isInteger(n.v)) { p++; node = { k: "bin", op: "^", a: node, b: { k: "num", v: neg ? -n.v : n.v } }; }
        else p = save;
      }
      return node;
    }
    function unitExpr(allowSingle) {
      let node = unitTerm(allowSingle);
      if (!node) return null;
      for (;;) {
        const t = peek();
        if (!(t && t.t === "op" && (t.v === "*" || t.v === "/"))) break;
        const save = p;
        p++;
        const rhs = unitTerm(allowSingle);
        if (!rhs) { p = save; break; }
        node = { k: "bin", op: t.v, a: node, b: rhs };
      }
      return node;
    }
    const withUnit = (node) => { const u = unitExpr(single); return u ? { k: "bin", op: "*", a: node, b: u } : node; };

    function ident(name) {
      if (name === "ans") return { k: "ans" };
      if (userVars.has(name)) return { k: "var", name };
      if (CONSTS.has(name)) return { k: "num", v: CONSTS.get(name) };
      const u = name.length > 1 || name === "°" ? lookupUnit(name) : null;
      if (u) return { k: "unit", u };
      if (/^[A-Za-z]{2,3}$/.test(name)) {     // xy means x times y
        return [...name].map((ch) => (userVars.has(ch) ? { k: "var", name: ch } : CONSTS.has(ch) ? { k: "num", v: CONSTS.get(ch) } : { k: "var", name: ch }))
          .reduce((a, b) => ({ k: "bin", op: "*", a, b }));
      }
      return { k: "var", name };
    }
    function args() {
      expectOp("(");
      const out = [];
      if (!isOp(")")) { out.push(conversion()); while (isOp(",")) { p++; out.push(conversion()); } }
      expectOp(")");
      return out;
    }
    function primary() {
      const t = peek();
      if (!t) throw new CalcError("The expression is not finished");
      if (t.t === "num") { p++; return withUnit({ k: "num", v: t.v }); }
      if (t.t === "op" && t.v === "(") { p++; const e = conversion(); expectOp(")"); return withUnit(e); }
      if (t.t === "id") {
        p++;
        if (F[t.v]) {
          if (isOp("(")) return { k: "fn", name: t.v, args: args() };
          const n = peek();
          if (n && (n.t === "num" || (n.t === "id" && !KW.has(n.v)))) return { k: "fn", name: t.v, args: [power()] };
          throw new CalcError(`${t.v} needs a value, like ${t.v}(2)`);
        }
        return ident(t.v);
      }
      throw new CalcError(`Unexpected "${t.v}"`);
    }
    function postfix() {
      let a = primary();
      for (;;) {
        if (isOp("!")) { p++; a = { k: "fn", name: "factorial", args: [a] }; continue; }
        if (isOp("%")) {
          const n = peek(1);                 // "10 % 3" is a remainder, "10% of 5" and "50 + 10%" are percentages
          if (n && (n.t === "num" || (n.t === "id" && !KW.has(n.v)) || (n.t === "op" && n.v === "("))) break;
          p++; a = { k: "pct", a }; continue;
        }
        return a;
      }
    }
    function power() {
      const base = postfix();
      if (isOp("^")) { p++; return { k: "bin", op: "^", a: base, b: unary() }; }
      return base;
    }
    function unary() {
      if (isOp("-")) { p++; return { k: "neg", a: unary() }; }
      if (isOp("+")) { p++; return unary(); }
      return power();
    }
    function term() {
      let a = unary();
      for (;;) {
        const t = peek();
        if (!t) return a;
        if (t.t === "op" && (t.v === "*" || t.v === "/")) { p++; a = { k: "bin", op: t.v, a, b: unary() }; }
        else if ((t.t === "id" && t.v === "mod") || (t.t === "op" && t.v === "%")) { p++; a = { k: "bin", op: "mod", a, b: unary() }; }
        else if (t.t === "id" && t.v === "of") { p++; a = { k: "bin", op: "*", a, b: unary() }; }
        else if (startsPrimary(t)) a = { k: "bin", op: "*", a, b: unary() };   // 2x, 3(4+1), x y
        else return a;
      }
    }
    function additive() {
      let a = term();
      while (isOp("+") || isOp("-")) { const op = tokens[p++].v; a = { k: "bin", op, a, b: term() }; }
      return a;
    }
    function conversion() {
      let e = additive();
      for (;;) {
        const t = peek();
        if (!(t && t.t === "id" && (t.v === "to" || (t.v === "in" && peek(1) && peek(1).t === "id")))) return e;
        p++;
        const u = unitExpr(true);
        if (!u) throw new CalcError(`Unknown unit "${peek() ? peek().v : ""}"`);
        e = { k: "to", a: e, unit: u };
      }
    }
    function statement() {
      if (peek() && peek().t === "id" && isOp(":=", 1)) {
        const name = peek().v;
        p += 2;
        if (F[name] || CONSTS.has(name) || KW.has(name) || name === "ans" || (name.length > 1 && lookupUnit(name))) throw new CalcError(`"${name}" can't be used as a variable name`);
        return { k: "assign", name, a: conversion() };
      }
      const a = conversion(), t = peek();
      if (t && t.t === "op" && CMP.includes(t.v)) { p++; return { k: "cmp", op: t.v === "==" ? "=" : t.v, a, b: conversion() }; }
      return a;
    }
    const node = statement();
    if (p < tokens.length) throw new CalcError(`Unexpected "${tokens[p].v}"`);
    return node;
  }

  function walk(n, fn) {
    if (!n || typeof n !== "object") return;
    fn(n);
    walk(n.a, fn); walk(n.b, fn); walk(n.unit, fn);
    if (n.args) n.args.forEach((x) => walk(x, fn));
  }
  const hasUnit = (n) => { let found = false; walk(n, (x) => { if (x.k === "unit") found = true; }); return found; };
  function freeVars(...nodes) {
    const set = new Set();
    for (const n of nodes) walk(n, (x) => { if (x.k === "var" && !userVars.has(x.name)) set.add(x.name); });
    return [...set].sort();
  }

  // ======================================================================== numeric evaluation
  function ev(n, bind) {
    switch (n.k) {
      case "num": return Q(n.v);
      case "ans":
        if (!lastAns) throw new CalcError("There is no previous answer yet");
        return lastAns;
      case "var":
        if (bind && bind.has(n.name)) return Q(bind.get(n.name));
        if (userVars.has(n.name)) return userVars.get(n.name);
        throw new Unknown(n.name);
      case "unit": return Q(n.u.f, n.u.d, labOf(n.u));
      case "neg": { const a = ev(n.a, bind); return Q(-a.v, a.d, a.lab); }
      case "pct": { const a = ev(n.a, bind); if (!isScalar(a.d)) throw new CalcError("A percentage needs a plain number"); return Q(a.v / 100); }
      case "fn": return F[n.name](n.args.map((x) => ev(x, bind)));
      case "to": {
        const a = ev(n.a, bind), t = ev(n.unit, bind);
        if (!same(a.d, t.d)) throw new CalcError(`Can't convert ${dimName(a.d)} to ${dimName(t.d)}`);
        return Q(a.v, a.d, t.lab);
      }
      case "bin": {
        const op = n.op;
        if ((op === "+" || op === "-") && n.b.k === "pct") {           // 50 + 10% is 55
          const a = ev(n.a, bind), p = ev(n.b.a, bind);
          if (!isScalar(p.d)) throw new CalcError("A percentage needs a plain number");
          return Q(a.v * (1 + ((op === "+" ? 1 : -1) * p.v) / 100), a.d, a.lab);
        }
        const a = ev(n.a, bind), b = ev(n.b, bind);
        switch (op) {
          case "+": case "-":
            if (!same(a.d, b.d)) throw new CalcError(op === "+" ? `Can't add ${dimName(b.d)} to ${dimName(a.d)}` : `Can't subtract ${dimName(b.d)} from ${dimName(a.d)}`);
            return Q(op === "+" ? a.v + b.v : a.v - b.v, a.d, a.lab && a.lab.size ? a.lab : b.lab);
          case "*":
            if (n.b.k === "unit" && n.b.u.off && isScalar(a.d)) return Q(a.v * n.b.u.f + n.b.u.off, n.b.u.d, labOf(n.b.u));   // 20 °C
            return Q(a.v * b.v, addD(a.d, b.d, 1), labMerge(a.lab, b.lab, 1));
          case "/":
            if (b.v === 0) throw new CalcError("Division by zero");
            return Q(a.v / b.v, addD(a.d, b.d, -1), labMerge(a.lab, b.lab, -1));
          case "mod":
            if (!isScalar(a.d) || !isScalar(b.d)) throw new CalcError("mod needs plain numbers");
            if (b.v === 0) throw new CalcError("Division by zero");
            return Q(a.v - b.v * Math.floor(a.v / b.v));
          case "^": {
            if (!isScalar(b.d)) throw new CalcError("An exponent can't have a unit");
            if (isScalar(a.d)) {
              const r = Math.pow(a.v, b.v);
              if (Number.isNaN(r)) throw new CalcError("That is not a real number");
              return Q(r);
            }
            const d = a.d.map((e) => e * b.v);
            if (!d.every((e) => Math.abs(e - Math.round(e)) < 1e-9)) throw new CalcError("That power of a unit isn't supported");
            return Q(Math.pow(a.v, b.v), d.map(Math.round), labPow(a.lab, b.v));
          }
        }
      }
    }
    throw new CalcError("Can't work that out");
  }

  // ======================================================================== polynomials (for equations)
  const MAXDEG = 24;
  function makePoly(vars) {
    const nv = vars.length, zk = Array(nv).fill(0).join(",");
    const cst = (c) => (c === 0 ? new Map() : new Map([[zk, c]]));
    const isC = (m) => m.size === 0 || (m.size === 1 && m.has(zk));
    const cv = (m) => m.get(zk) || 0;
    const add = (a, b, s) => {
      const m = new Map(a);
      for (const [k, c] of b) {
        const cur = m.get(k) || 0, v = cur + s * c;
        if (Math.abs(v) <= 1e-12 * Math.max(Math.abs(cur), Math.abs(c))) m.delete(k); else m.set(k, v);
      }
      return m;
    };
    const scale = (a, s) => (s === 0 ? new Map() : new Map([...a].map(([k, c]) => [k, c * s])));
    const mul = (a, b) => {
      const m = new Map();
      for (const [ka, ca] of a) {
        const ea = ka.split(",").map(Number);
        for (const [kb, cb] of b) {
          const ex = kb.split(",").map((x, i) => +x + ea[i]);
          if (ex.reduce((x, y) => x + y, 0) > MAXDEG) throw new CalcError("That expression is too complicated to solve");
          const key = ex.join(",");
          m.set(key, (m.get(key) || 0) + ca * cb);
        }
      }
      for (const [k, c] of m) if (c === 0) m.delete(k);
      return m;
    };
    const go = (n) => {
      switch (n.k) {
        case "num": return cst(n.v);
        case "ans": case "var": {
          const i = n.k === "var" ? vars.indexOf(n.name) : -1;
          if (i >= 0) return new Map([[vars.map((_, j) => (j === i ? 1 : 0)).join(","), 1]]);
          const q = ev(n);
          if (!isScalar(q.d)) throw new CalcError("Equations with units aren't supported");
          return cst(q.v);
        }
        case "neg": return scale(go(n.a), -1);
        case "pct": return scale(go(n.a), 0.01);
        case "unit": case "to": throw new CalcError("Equations with units aren't supported");
        case "fn": {
          const a = n.args.map(go);
          if (!a.every(isC)) throw new NotPoly();
          const r = F[n.name](a.map((m) => Q(cv(m))));
          if (!isScalar(r.d)) throw new CalcError("Equations with units aren't supported");
          return cst(r.v);
        }
        case "bin": {
          if ((n.op === "+" || n.op === "-") && n.b.k === "pct") {
            const p = go(n.b.a);
            if (!isC(p)) throw new NotPoly();
            return scale(go(n.a), 1 + ((n.op === "+" ? 1 : -1) * cv(p)) / 100);
          }
          const a = go(n.a), b = go(n.b);
          switch (n.op) {
            case "+": return add(a, b, 1);
            case "-": return add(a, b, -1);
            case "*": return mul(a, b);
            case "/":
              if (!isC(b)) throw new NotPoly();
              if (cv(b) === 0) throw new CalcError("Division by zero");
              return scale(a, 1 / cv(b));
            case "mod":
              if (!isC(a) || !isC(b)) throw new NotPoly();
              if (cv(b) === 0) throw new CalcError("Division by zero");
              return cst(cv(a) - cv(b) * Math.floor(cv(a) / cv(b)));
            case "^": {
              if (!isC(b)) throw new NotPoly();
              const ex = cv(b);
              if (isC(a)) { const r = Math.pow(cv(a), ex); if (Number.isNaN(r)) throw new CalcError("That is not a real number"); return cst(r); }
              if (!Number.isInteger(ex) || ex < 0 || ex > MAXDEG) throw new NotPoly();
              let r = cst(1);
              for (let i = 0; i < ex; i++) r = mul(r, a);
              return r;
            }
          }
        }
      }
      throw new NotPoly();
    };
    return { go, add, isC, cv, zk };
  }
  const SUPDIGITS = (n) => (n > 1 ? sup(n) : "");
  function polyStr(m, vars) {
    const terms = [...m].map(([k, c]) => ({ ex: k.split(",").map(Number), c }));
    terms.sort((a, b) => b.ex.reduce((x, y) => x + y, 0) - a.ex.reduce((x, y) => x + y, 0) || b.ex.join().localeCompare(a.ex.join()));
    const sepr = vars.some((v) => v.length > 1) ? "·" : "";
    let out = "";
    terms.forEach((t, i) => {
      const v = vars.map((name, j) => (t.ex[j] ? name + SUPDIGITS(t.ex[j]) : "")).filter(Boolean).join(sepr);
      const a = Math.abs(t.c), coef = v && a === 1 ? "" : fmtDec(a);
      const body = v ? coef + (coef && sepr ? "·" : "") + v : coef;
      out += i === 0 ? (t.c < 0 ? "-" : "") + body : (t.c < 0 ? " - " : " + ") + body;
    });
    return out || "0";
  }

  // ---- roots of a polynomial in one unknown (coefficients ascending, last one not zero)
  function quad(a, b, c) {
    const disc = b * b - 4 * a * c;
    if (Math.abs(disc) <= 1e-12 * (b * b + Math.abs(4 * a * c))) return { re: [-b / (2 * a)], cx: [] };
    if (disc < 0) return { re: [], cx: [{ re: -b / (2 * a), im: Math.sqrt(-disc) / (2 * Math.abs(a)) }] };
    const s = Math.sqrt(disc), q = -(b + (b < 0 ? -s : s)) / 2;
    return { re: [q / a, c / q].sort((x, y) => x - y), cx: [] };
  }
  const gcdB = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
  function divisors(n) {
    n = n < 0n ? -n : n;
    if (n > 10n ** 12n) return null;
    const N = Number(n), out = [];
    for (let i = 1; i * i <= N; i++) if (N % i === 0) { out.push(BigInt(i)); if (i * i !== N) out.push(BigInt(N / i)); }
    return out;
  }
  function findRatRoot(a) {              // exact rational root of an integer polynomial, or null
    const P = divisors(a[0]), Qd = divisors(a[a.length - 1]), n = a.length - 1;
    if (!P || !Qd) return null;
    for (const q of Qd) for (const p0 of P) {
      if (gcdB(p0, q) !== 1n) continue;
      for (const p of [p0, -p0]) {
        let s = 0n;
        for (let i = 0; i <= n; i++) s += a[i] * p ** BigInt(i) * q ** BigInt(n - i);
        if (s === 0n) return [p, q];
      }
    }
    return null;
  }
  function deflate(a, [p, q]) {            // divide by (q x - p)
    const d = [...a].reverse(), out = [];
    for (let i = 0; i < d.length - 1; i++) out.push((d[i] + (i ? p * out[i - 1] : 0n)) / q);
    return out.reverse();
  }
  function rationalSplit(c) {              // take out the roots that are fractions, leave the rest as floats
    const fr = c.map((x) => toFrac(x));
    if (fr.some((f) => !f)) return { found: [], rest: c };
    let L = 1n;
    for (const [, q] of fr) L = (L / gcdB(L, BigInt(q))) * BigInt(q);
    let a = fr.map(([p, q]) => BigInt(p) * (L / BigInt(q)));
    const found = [];
    const zeros = () => { while (a.length > 3 && a[0] === 0n) { found.push(0); a = a.slice(1); } };
    zeros();
    while (a.length > 3) {
      const r = findRatRoot(a);
      if (!r) break;
      found.push(Number(r[0]) / Number(r[1]));
      a = deflate(a, r);
      zeros();
    }
    return { found, rest: a.map(Number) };
  }
  function durandKerner(c) {               // all complex roots of a polynomial of degree 3 or more
    const n = c.length - 1, a = c.map((x) => x / c[n]), r0 = Math.pow(Math.abs(a[0]) || 1, 1 / n);
    const zr = [], zi = [];
    for (let k = 0; k < n; k++) { const t = (2 * Math.PI * k) / n + 0.5; zr.push(r0 * Math.cos(t)); zi.push(r0 * Math.sin(t)); }
    for (let it = 0; it < 2000; it++) {
      let delta = 0;
      for (let k = 0; k < n; k++) {
        let pr = 1, pi = 0;
        for (let j = n - 1; j >= 0; j--) { const t = pr * zr[k] - pi * zi[k] + a[j]; pi = pr * zi[k] + pi * zr[k]; pr = t; }
        let dr = 1, di = 0;
        for (let j = 0; j < n; j++) if (j !== k) { const xr = zr[k] - zr[j], xi = zi[k] - zi[j], t = dr * xr - di * xi; di = dr * xi + di * xr; dr = t; }
        const den = dr * dr + di * di;
        if (!den) continue;
        const qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den;
        zr[k] -= qr; zi[k] -= qi;
        delta = Math.max(delta, Math.hypot(qr, qi) / (1 + Math.hypot(zr[k], zi[k])));
      }
      if (delta < 1e-15) break;
    }
    const re = [], cx = [], horner = (x) => { let v = 0, d = 0; for (let j = c.length - 1; j >= 0; j--) { d = d * x + v; v = v * x + c[j]; } return [v, d]; };
    for (let k = 0; k < n; k++) {
      if (Math.abs(zi[k]) < 1e-8 * (1 + Math.abs(zr[k]))) {
        let x = zr[k];
        for (let i = 0; i < 4; i++) { const [v, d] = horner(x); if (d) x -= v / d; }
        re.push(x);
      } else if (zi[k] > 0) cx.push({ re: zr[k], im: zi[k] });
    }
    return { re, cx };
  }
  function polyRoots(c) {
    const n = c.length - 1;
    if (n === 1) return { re: [-c[0] / c[1]], cx: [] };
    if (n === 2) return quad(c[2], c[1], c[0]);
    const { found, rest } = rationalSplit(c), m = rest.length - 1;
    const sub = m === 1 ? { re: [-rest[0] / rest[1]], cx: [] } : m === 2 ? quad(rest[2], rest[1], rest[0]) : m >= 3 ? durandKerner(rest) : { re: [], cx: [] };
    return { re: [...found, ...sub.re], cx: sub.cx };
  }
  function polySolution(c, name) {
    if (!c.length) return { lines: [{ text: `true for every value of ${name}`, plain: true }] };
    if (c.length === 1) throw new CalcError("There is no solution");
    const { re, cx } = polyRoots(c);
    const reals = [...re].map((x) => (Math.abs(x) < 1e-12 ? 0 : x)).sort((a, b) => a - b)
      .filter((x, i, arr) => !i || Math.abs(x - arr[i - 1]) > 1e-9 * (1 + Math.abs(x)));
    const lines = reals.map((x) => ({ lhs: name, ...numText(x) }));
    for (const z of cx) {
      const re0 = Math.abs(z.re) < 1e-10 * (1 + z.im) ? 0 : z.re;
      lines.push({ lhs: name, text: re0 === 0 ? `±${fmtDec(z.im)}i` : `${fmtDec(re0)} ± ${fmtDec(z.im)}i`, approx: isApprox(re0) || isApprox(z.im), copy: `${fmtDec(re0)} ± ${fmtDec(z.im)}i` });
    }
    return { lines, ans: reals.length ? Q(reals[0]) : null };
  }

  // ---- equations that are not polynomials: look for sign changes
  function scanRoots(f, lo, hi, n, roots) {
    const step = (hi - lo) / n;
    let px = lo, py = f(px);
    for (let i = 1; i <= n; i++) {
      const x = lo + step * i, y = f(x);
      if (py === 0) roots.push(px);
      else if (Number.isFinite(py) && Number.isFinite(y) && py * y < 0) {
        let a = px, b = x, fa = py;
        for (let k = 0; k < 200; k++) {
          const m = (a + b) / 2, fm = f(m);
          if (!Number.isFinite(fm)) break;
          if (fm === 0) { a = b = m; break; }
          if (fa * fm < 0) b = m; else { a = m; fa = fm; }
        }
        const r = (a + b) / 2;
        if (Math.abs(f(r)) <= 1e-6 * Math.max(1, Math.abs(py), Math.abs(y))) roots.push(r);   // not a jump or a pole
      }
      px = x; py = y;
    }
    if (py === 0) roots.push(px);
    return roots;
  }
  function numericSolution(node, name, deep) {
    const f = (x) => {
      try {
        const bind = new Map([[name, x]]), a = ev(node.a, bind), b = ev(node.b, bind);
        return isScalar(a.d) && isScalar(b.d) ? a.v - b.v : NaN;
      } catch (e) { if (e instanceof CalcError) return NaN; throw e; }
    };
    let range = 100, roots = scanRoots(f, -100, 100, 40000, []);
    if (!roots.length && deep) { range = 10000; roots = scanRoots(f, -10000, 10000, 200000, []); }
    roots = roots.sort((a, b) => a - b).filter((x, i, arr) => !i || Math.abs(x - arr[i - 1]) > 1e-9 * (1 + Math.abs(x)));
    const fmtRange = (r) => r.toLocaleString("en-US");
    if (!roots.length) {
      throw new CalcError(deep ? `No real solution found between -${fmtRange(range)} and ${fmtRange(range)}`
        : "No solution found between -100 and 100. Press Enter to search a wider range.");
    }
    const shown = roots.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b).slice(0, 12).sort((a, b) => a - b);
    return {
      lines: shown.map((x) => ({ lhs: name, ...numText(Math.abs(x) < 1e-12 ? 0 : x) })),
      note: `Found numerically between -${fmtRange(range)} and ${fmtRange(range)}${roots.length > 12 ? `; showing 12 of ${roots.length} solutions` : "; there may be others outside this range"}.`,
      ans: Q(shown[0]),
    };
  }

  // ---- linear systems
  function solveLinear(nodes, vars) {
    const ctx = makePoly(vars), n = vars.length, M = [];
    for (const nd of nodes) {
      let m;
      try { m = ctx.add(ctx.go(nd.a), ctx.go(nd.b), -1); }
      catch (e) { if (e instanceof NotPoly) throw new CalcError("Only systems of linear equations can be solved"); throw e; }
      const row = Array(n).fill(0);
      let c0 = 0;
      for (const [k, c] of m) {
        const ex = k.split(",").map(Number), total = ex.reduce((x, y) => x + y, 0);
        if (total === 0) c0 = c;
        else if (total === 1) row[ex.indexOf(1)] = c;
        else throw new CalcError("Only systems of linear equations can be solved");
      }
      M.push([...row, -c0]);
    }
    const eps = 1e-10 * Math.max(1, ...M.flat().map(Math.abs));
    let rank = 0;
    for (let col = 0; col < n && rank < n; col++) {
      let piv = rank;
      for (let r = rank + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) <= eps) continue;
      [M[rank], M[piv]] = [M[piv], M[rank]];
      for (let r = 0; r < n; r++) {
        if (r === rank) continue;
        const f = M[r][col] / M[rank][col];
        for (let c = col; c <= n; c++) M[r][c] -= f * M[rank][c];
      }
      rank++;
    }
    for (let r = rank; r < n; r++) if (Math.abs(M[r][n]) > eps) throw new CalcError("These equations contradict each other, so there is no solution");
    if (rank < n) throw new CalcError("These equations don't pin down every unknown (there are infinitely many solutions)");
    return vars.map((_, i) => M[i][n] / M[i][i]);
  }

  // ======================================================================== solving, comparing, evaluating
  function compare(n) {
    const a = ev(n.a), b = ev(n.b);
    if (!same(a.d, b.d)) return { text: "false", plain: true };
    const tol = 1e-9 * Math.max(1, Math.abs(a.v), Math.abs(b.v)), diff = a.v - b.v;
    const ok = { "=": Math.abs(diff) <= tol, "!=": Math.abs(diff) > tol, "<": diff < -tol, ">": diff > tol, "<=": diff <= tol, ">=": diff >= -tol }[n.op];
    return { text: ok ? "true" : isScalar(a.d) ? `false (${fmtDec(a.v)} ${n.op === "=" ? "≠" : "vs"} ${fmtDec(b.v)})` : "false", plain: true };
  }
  function solveEquations(nodes, opts) {
    const vars = freeVars(...nodes);
    if (!vars.length) return { lines: nodes.map(compare) };
    if (nodes.length !== vars.length) {
      throw new CalcError(nodes.length === 1
        ? `This has ${vars.length} unknowns (${vars.join(", ")}). Add ${vars.length - 1} more equation${vars.length > 2 ? "s" : ""}, separated by commas, for example: x + y = 10, x - y = 2`
        : `${nodes.length} equations for ${vars.length} unknown${vars.length === 1 ? "" : "s"} (${vars.join(", ")}): you need the same number of each`);
    }
    if (vars.length > 1) {
      const sol = solveLinear(nodes, vars);
      return { lines: vars.map((v, i) => ({ lhs: v, ...numText(Math.abs(sol[i]) < 1e-12 ? 0 : sol[i]) })), ans: Q(sol[0]) };
    }
    const ctx = makePoly(vars);
    let m = null;
    try { m = ctx.add(ctx.go(nodes[0].a), ctx.go(nodes[0].b), -1); }
    catch (e) { if (!(e instanceof NotPoly)) throw e; }
    if (!m) return numericSolution(nodes[0], vars[0], opts.deep);
    const c = [];
    for (const [k, v] of m) c[+k] = v;
    for (let i = 0; i < c.length; i++) if (c[i] === undefined) c[i] = 0;
    const top = Math.max(0, ...c.map(Math.abs));
    while (c.length && Math.abs(c[c.length - 1]) <= 1e-12 * top) c.pop();
    return polySolution(c, vars[0]);
  }
  function quantityResult(q) {
    if (Number.isNaN(q.v)) throw new CalcError("That is undefined");
    const view = unitView(q), t = numText(view.value, !view.unit);
    const unit = view.unit ? (view.unit === "°" ? "" : " ") + view.unit : "";
    return { lines: [{ text: t.text + unit, approx: t.approx, copy: t.copy + unit }], ans: q };
  }

  function parseEquation(tokens) {
    let node = parse(tokens, true);
    if (node.k !== "cmp" || node.op !== "=") throw new CalcError("Every part needs an = sign, for example: x + y = 10, x - y = 2");
    if (freeVars(node).length && hasUnit(node)) {            // "h + 5 = 10": h is an unknown here, not hours
      node = parse(tokens, false);
      if (hasUnit(node)) throw new CalcError("Equations with units aren't supported. Use plain numbers.");
    }
    return node;
  }

  // Returns {lines: [{lhs?, text, approx?, plain?, copy?}], note?, ans?, assign?} or throws a CalcError.
  function evaluate(src, opts) {
    let toks = tokenize(src);
    if (!toks.length) return null;
    if (toks[0].t === "id" && toks[0].v === "solve" && !(toks[1] && toks[1].v === "(")) toks = toks.slice(1);
    const parts = splitTop(toks);
    if (!parts.length) return null;
    if (parts.length > 1) return solveEquations(parts.map(parseEquation), opts);

    let node = parse(parts[0], true);
    if (node.k === "cmp" && node.op === "=") return solveEquations([parseEquation(parts[0])], opts);
    if (node.k === "cmp") {
      if (freeVars(node).length) throw new CalcError("Inequalities with unknowns can't be solved yet");
      return { lines: [compare(node)] };
    }
    if (node.k === "assign") {
      const q = ev(node.a);
      if (opts.commit) userVars.set(node.name, q);
      const r = quantityResult(q);
      r.lines[0].lhs = node.name;
      r.assign = node.name;
      return r;
    }
    try { return quantityResult(ev(node)); }
    catch (e) {
      if (!(e instanceof Unknown)) throw e;
      const vars = freeVars(node);                      // 2x + 3x is 5x
      try {
        const m = makePoly(vars).go(node);
        return { lines: [{ text: polyStr(m, vars), copy: polyStr(m, vars) }] };
      } catch { throw e; }
    }
  }

  // ======================================================================== page
  const input = $("#expr"), liveEl = $("#live"), histEl = $("#history"), varsEl = $("#vars");
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  const loadJson = (k, fallback) => { try { const v = JSON.parse(store.get(k)); return Array.isArray(v) ? v : fallback; } catch { return fallback; } };

  const lineStr = (l) => (l.plain ? l.text : `${l.lhs ? l.lhs + " " : ""}${l.approx ? "≈" : "="} ${l.text}`);
  function show(el, r) {
    el.className = "live";
    el.replaceChildren(...r.lines.map((l) => {
      const row = document.createElement("span");
      row.className = "line";
      if (l.plain) row.textContent = l.text;
      else {
        if (l.lhs) row.append(l.lhs + " ");
        const rel = document.createElement("span");
        rel.className = "rel"; rel.textContent = l.approx ? "≈" : "=";
        row.append(rel, " " + l.text);
      }
      return row;
    }));
    if (r.note) { const n = document.createElement("span"); n.className = "note"; n.textContent = r.note; el.append(n); }
  }
  function showError(e) {
    liveEl.className = "live err";
    liveEl.textContent = e instanceof CalcError ? e.message : "Something went wrong with that.";
    if (!(e instanceof CalcError)) console.error(e);
  }

  let timer = 0;
  function preview() {
    const src = input.value.trim();
    liveEl.className = "live"; liveEl.replaceChildren();
    if (!src) return;
    try { const r = evaluate(src, { commit: false, deep: false }); if (r) show(liveEl, r); }
    catch (e) { showError(e); }
  }
  input.addEventListener("input", () => { navIndex = -1; clearTimeout(timer); timer = setTimeout(preview, 120); });

  // ---------- history
  let history = loadJson("calc-history", []).filter((h) => h && typeof h.q === "string" && Array.isArray(h.lines));
  let navIndex = -1;
  function copyText(text, btn) {
    const done = () => { const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = old), 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
    else { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); done(); }
  }
  function renderHistory() {
    $("#empty").hidden = history.length > 0;
    histEl.replaceChildren(...history.map((h, i) => {
      const li = document.createElement("li");
      const q = document.createElement("button"), r = document.createElement("div"), c = document.createElement("button");
      q.type = c.type = "button";
      q.className = "q"; q.textContent = h.q; q.title = "Edit this";
      q.addEventListener("click", () => { input.value = h.q; input.focus(); preview(); });
      r.className = "r";
      r.append(...h.lines.map((t) => { const s = document.createElement("span"); s.textContent = t; return s; }));
      c.className = "btn small"; c.textContent = "Copy";
      c.addEventListener("click", () => copyText(h.copy, c));
      li.append(q, r, c);
      return li;
    }));
  }
  const saveHistory = () => store.set("calc-history", JSON.stringify(history.slice(0, 200)));

  // ---------- variables (remembered as the text that defined them)
  let savedVars = loadJson("calc-vars", []).filter((v) => v && typeof v.name === "string" && typeof v.src === "string");
  function renderVars() {
    varsEl.hidden = !savedVars.length;
    const label = document.createElement("span");
    label.className = "label"; label.textContent = "Variables:";
    varsEl.replaceChildren(label, ...savedVars.map((v) => {
      const chip = document.createElement("span"), x = document.createElement("button");
      chip.className = "var";
      const q = userVars.get(v.name), view = q ? unitView(q) : null;
      chip.textContent = v.name + " = " + (view ? fmtDec(view.value) + (view.unit ? " " + view.unit : "") : "?");
      x.type = "button"; x.textContent = "×"; x.title = "Forget " + v.name; x.setAttribute("aria-label", "Forget " + v.name);
      x.addEventListener("click", () => { userVars.delete(v.name); savedVars = savedVars.filter((s) => s.name !== v.name); store.set("calc-vars", JSON.stringify(savedVars)); renderVars(); preview(); });
      chip.append(x);
      return chip;
    }));
  }

  function commit() {
    const src = input.value.trim();
    if (!src) return;
    let r;
    try { r = evaluate(src, { commit: true, deep: true }); }
    catch (e) { showError(e); return; }
    if (!r) return;
    if (r.ans) lastAns = r.ans;
    if (r.assign) {
      savedVars = savedVars.filter((v) => v.name !== r.assign);
      savedVars.push({ name: r.assign, src });
      store.set("calc-vars", JSON.stringify(savedVars));
      renderVars();
    }
    const lines = r.lines.map(lineStr);
    if (r.note) lines.push(r.note);
    history.unshift({ q: src, lines, copy: r.lines.map((l) => (l.lhs ? `${l.lhs} = ${l.copy || l.text}` : l.copy || l.text)).join("\n") });
    history = history.slice(0, 200);
    saveHistory(); renderHistory();
    input.value = ""; navIndex = -1;
    liveEl.className = "live"; liveEl.replaceChildren();
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.length) {
      e.preventDefault();
      navIndex = e.key === "ArrowUp" ? Math.min(navIndex + 1, history.length - 1) : navIndex - 1;
      input.value = navIndex >= 0 ? history[navIndex].q : "";
      preview();
    }
  });
  $("#clear").addEventListener("click", () => { history = []; saveHistory(); renderHistory(); input.focus(); });

  // ---------- settings
  const angleSel = $("#angle"), digitsSel = $("#digits");
  angleMode = store.get("calc-angle") === "deg" ? "deg" : "rad";
  digits = [6, 8, 10, 12, 15].includes(+store.get("calc-digits")) ? +store.get("calc-digits") : 10;
  angleSel.value = angleMode; digitsSel.value = String(digits);
  angleSel.addEventListener("change", () => { angleMode = angleSel.value; store.set("calc-angle", angleMode); preview(); });
  digitsSel.addEventListener("change", () => { digits = +digitsSel.value; store.set("calc-digits", String(digits)); preview(); renderVars(); });

  // ---------- examples
  const EXAMPLES = ["x + 10 = 200", "3x - 7 = 11", "x^2 - 5x + 6 = 0", "x^3 = 8", "2^x = 64", "x + y = 10, x - y = 2", "15% of 80", "120 + 20%",
    "5 km to miles", "90 km/h to m/s", "72 °F to °C", "2 h + 30 min", "3 GB to MiB", "sin(30°)", "sqrt(2) * pi", "5! / (3! * 2!)", "a := 12"];
  $("#chips").replaceChildren(...EXAMPLES.map((ex) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = ex;
    b.addEventListener("click", () => { input.value = ex; input.focus(); preview(); });
    return b;
  }));

  for (const v of savedVars) { try { evaluate(v.src, { commit: true, deep: false }); } catch { /* ignore a bad saved variable */ } }
  savedVars = savedVars.filter((v) => userVars.has(v.name));
  renderVars();
  renderHistory();
})();
