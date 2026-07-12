/*
 * lib/scan-core.js — pure (DOM-free) logic for the Jobber page scanner.
 * Field classification, group assembly, placeholder detection and read-only
 * address-block parsing live here so plain `node` tests can exercise them.
 * Exposes globalThis.TaxExtScanCore in extension contexts, module.exports in node.
 */
(function (root, factory) {
  var N;
  if (typeof module === 'object' && module.exports) {
    N = require('./normalize.js');
    module.exports = factory(N);
  } else {
    N = root.TaxExtNormalize;
    root.TaxExtScanCore = factory(N);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (N) {
  'use strict';

  /**
   * Tokenize an attribute string on _ [ ] whitespace and -, then split
   * letter/digit boundaries so 'street1' -> ['street','1'] and
   * 'client[billing_address][street1]' -> ['client','billing','address','street','1'].
   */
  function tokenize(s) {
    if (!s) return [];
    return String(s).toLowerCase()
      .split(/[_\[\]\s\-]+/)
      .flatMap(function (t) {
        return t.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2').split(' ');
      })
      .filter(Boolean);
  }

  function hasTok(tokens, word) { return tokens.indexOf(word) !== -1; }

  /**
   * Classify a form field from its attributes + associated label text.
   * Matches on SEGMENTS (split by [_\[\]\s-]) — word-boundary regexes fail on
   * Rails/React names like client[billing_address][street1] or billing_address_state.
   * Returns 'street1'|'street2'|'city'|'state'|'zip'|null.
   */
  function classifyField(attrs) {
    attrs = attrs || {};
    // Structural attributes are most reliable; check them before free text.
    var sources = [attrs.name, attrs.id, attrs.ariaLabel, attrs.placeholder, attrs.labelText];
    for (var i = 0; i < sources.length; i++) {
      var t = tokenize(sources[i]);
      if (!t.length) continue;
      // hard exclusions for this source
      if (hasTok(t, 'email') || hasTok(t, 'phone') || hasTok(t, 'search') ||
          hasTok(t, 'country') || hasTok(t, 'tax')) continue;
      var type = classifyTokens(t);
      if (type) return type;
    }
    return null;
  }

  function classifyTokens(t) {
    // order matters: zip/state/city first so 'billing_address_state' -> state,
    // not street (it also contains 'address').
    if (hasTok(t, 'zip') || hasTok(t, 'zipcode') ||
        (hasTok(t, 'postal') || (hasTok(t, 'post') && hasTok(t, 'code')))) return 'zip';
    if (hasTok(t, 'state') || hasTok(t, 'province')) return 'state';
    if (hasTok(t, 'city') || hasTok(t, 'town')) return 'city';
    var streetish = hasTok(t, 'street') || hasTok(t, 'address') || hasTok(t, 'addr');
    if ((streetish || hasTok(t, 'line')) && hasTok(t, '2')) return 'street2';
    if (streetish) return 'street1'; // includes 'street 1', 'address1', bare 'address', 'property address'
    return null;
  }

  /**
   * Structural group prefix for a field name/id.
   * 'client[billing_address][street1]' -> 'client[billing_address]'
   * 'property_address_city'            -> 'property'
   * 'city'                             -> '' (no usable prefix)
   * React auto-generated names ('generatedName--_r_5f_', real Jobber modals)
   * -> '' — unique per field, so they carry NO grouping information.
   */
  function extractGroupPrefix(raw) {
    if (!raw) return '';
    var s = String(raw);
    if (/generatedname/i.test(s)) return '';
    var br = s.match(/^(.*)\[[^\]]*\]$/);
    if (br) return br[1];
    var KEY = /^(street|st|address|addr|line|city|town|state|province|zip|zipcode|postal|postalcode|code|\d+)$/i;
    var parts = s.split(/[_\-]+/).flatMap(function (t) {
      return t.replace(/([A-Za-z])(\d)/g, '$1 $2').split(' ');
    }).filter(Boolean);
    while (parts.length && KEY.test(parts[parts.length - 1])) parts.pop();
    return parts.join('_');
  }

  /**
   * Group classified fields into address candidates.
   * fields: [{ type, prefix }] in DOCUMENT ORDER.
   * Rules (fixes v1 "Frankenstein merge"):
   *   - fields sharing a non-empty prefix always group together;
   *   - a prefix that occurs on only ONE classified field is demoted to '' —
   *     unique prefixes (React ids like _r_5f_) carry no grouping information
   *     and would otherwise strand every field in its own group;
   *   - prefixless fields group sequentially, and a field whose type already
   *     exists in the current group NEVER overwrites it — it starts a new group.
   * Returns an array of groups, each an array of indices into `fields`.
   */
  function groupFields(fields) {
    // demote single-occurrence prefixes to '' (see rule above)
    var counts = {};
    fields.forEach(function (f) {
      if (f.prefix) counts[f.prefix] = (counts[f.prefix] || 0) + 1;
    });
    var eff = fields.map(function (f) {
      return { type: f.type, prefix: (f.prefix && counts[f.prefix] > 1) ? f.prefix : '' };
    });

    var byPrefix = {};       // prefix -> group index
    var groups = [];         // [{ indices:[], types:{} }]
    var currentSeq = null;   // current sequential (prefixless) group

    eff.forEach(function (f, i) {
      if (f.prefix) {
        var gi = byPrefix[f.prefix];
        if (gi === undefined) {
          gi = groups.length;
          byPrefix[f.prefix] = gi;
          groups.push({ indices: [], types: {} });
        }
        var g = groups[gi];
        if (g.types[f.type]) {
          // same prefix repeats a type (rare) — do not overwrite; start a fork
          var forked = { indices: [i], types: {} };
          forked.types[f.type] = true;
          byPrefix[f.prefix] = groups.length;
          groups.push(forked);
        } else {
          g.types[f.type] = true;
          g.indices.push(i);
        }
        currentSeq = null; // a prefixed field breaks any sequential run
      } else {
        if (!currentSeq || currentSeq.types[f.type]) {
          currentSeq = { indices: [], types: {} };
          groups.push(currentSeq);
        }
        currentSeq.types[f.type] = true;
        currentSeq.indices.push(i);
      }
    });

    return groups.map(function (g) { return g.indices; });
  }

  /**
   * Is a <select> option just a placeholder ("Select state", "--", "Choose…")?
   */
  function isPlaceholderOption(value, text) {
    var v = String(value == null ? '' : value).trim();
    var t = String(text == null ? '' : text).trim().toLowerCase();
    if (v === '' || v === '-' || v === '--') {
      // empty value + any text is a placeholder unless the text itself is a real value
      if (t === '' || /^(select|please|choose|--|—|-)/.test(t)) return true;
      return v === '' && t === '';
    }
    if (/^(select|please|choose)\b/.test(t)) return true;
    return false;
  }

  var HOUSE_NUMBER_RE = /^\d+[A-Za-z]?(?:[-\/]\d*[A-Za-z]?)?\s+\S/;

  /**
   * Parse a SINGLE comma-separated address line, the format real Jobber client
   * screens use: "4330 Marival Way, Mason, Ohio 45040" (full state name,
   * street may itself contain commas, e.g. ", Suite 200").
   * Last segment = "State ZIP"; the one before = city; the rest = street and
   * must start with a house number.
   */
  function parseSingleLineAddress(line) {
    if (!line || line.length > 140) return null;
    var segs = String(line).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (segs.length < 3) return null;
    var last = segs[segs.length - 1];
    var m = last.match(/^([A-Za-z][A-Za-z. ]*?)\s+(\d{5}(?:-\d{4})?)$/);
    if (!m) return null;
    var state = N.normalizeState(m[1]);
    if (!state) return null;
    var city = segs[segs.length - 2];
    if (!city || /\d{5}/.test(city)) return null;
    var street = segs.slice(0, segs.length - 2).join(', ');
    if (!HOUSE_NUMBER_RE.test(street)) return null;
    return { street: street, city: city, state: state, zip: m[2] };
  }

  /**
   * Parse a read-only text block (already split into trimmed lines) into an
   * address. Rules (fixes v1 name-prepending bug):
   *   - single-line blocks are parsed as comma-separated addresses
   *     ("4330 Marival Way, Mason, Ohio 45040" — real Jobber client screen);
   *   - multi-line: last line must be "City, ST 12345[-1234]" with a REAL
   *     2-letter state or a full state name (Ohio -> OH), street = only
   *     line(s) that LOOK like an address (leading house number); preceding
   *     name lines are never prepended; no house-number line -> reject;
   *   - multi-line fallback: any single line that parses as a complete
   *     comma-separated address on its own (heading + one-line-address rows).
   */
  function parseAddressBlock(lines) {
    if (!lines || !lines.length || lines.length > 6) return null;
    if (lines.length === 1) return parseSingleLineAddress(lines[0]);
    var last = lines[lines.length - 1];
    var m = last.match(/^([^,]+),\s*([A-Za-z][A-Za-z. ]*?)\s+(\d{5}(?:-\d{4})?)$/);
    if (m) {
      var state = N.normalizeState(m[2]);
      if (state) {
        var streetLines = [];
        for (var i = 0; i < lines.length - 1; i++) {
          if (HOUSE_NUMBER_RE.test(lines[i])) streetLines.push(lines[i]);
        }
        if (streetLines.length) {
          return {
            street: streetLines.join(' '),
            city: m[1].trim(),
            state: state,
            zip: m[3]
          };
        }
      }
    }
    // fallback: one of the lines is a complete single-line address
    for (var j = 0; j < lines.length; j++) {
      var single = parseSingleLineAddress(lines[j]);
      if (single) return single;
    }
    return null;
  }

  return {
    tokenize: tokenize,
    classifyField: classifyField,
    extractGroupPrefix: extractGroupPrefix,
    groupFields: groupFields,
    isPlaceholderOption: isPlaceholderOption,
    parseSingleLineAddress: parseSingleLineAddress,
    parseAddressBlock: parseAddressBlock
  };
});
